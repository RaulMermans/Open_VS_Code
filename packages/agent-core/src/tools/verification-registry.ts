import { ToolRegistry, ToolRegistration, ToolExecutionContext, ReviewableExecution } from "./registry.ts"
import { discoverVerificationCommand, verificationWorkspace } from "./verification-discovery.ts"
import { VerificationEngine } from "./verification-engine.ts"
import { type CommandSandboxMode, describeSandbox, predictSandbox } from "./command-sandbox.ts"
import { diagnoseUnresolvedSymbols } from "./symbol-diagnosis.ts"
import { summarizeVerification } from "./verification-summary.ts"
import { VerificationAction, PreparedVerification, VerificationResult } from "./verification-contracts.ts"

export const ACTION_TIMEOUTS: Record<VerificationAction, number> = {
  TEST: 60_000,
  TYPECHECK: 60_000,
  LINT: 60_000,
  BUILD: 120_000,
}

export function createVerificationToolRegistrations(workspaceRoot: string, options: { readonly sandbox?: CommandSandboxMode } = {}): ToolRegistration[] {
  const sandbox = options.sandbox ?? "off"
  const engine = new VerificationEngine({ workspaceRoot, sandbox })

  const runVerificationRegistration: ToolRegistration = {
    definition: {
      name: "run_verification",
      action: "run_known_test",
      description: "Run narrowly scoped verification actions: TEST, TYPECHECK, LINT, or BUILD.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["TEST", "TYPECHECK", "LINT", "BUILD"],
            description: "The verification action to run",
          },
        },
        required: ["action"],
      },
    },
    validate: (input: unknown) => {
      if (!input || typeof input !== "object") throw new Error("Input must be an object")
      const action = (input as any).action ?? "TEST"
      if (!["TEST", "TYPECHECK", "LINT", "BUILD"].includes(action)) {
        throw new Error("action must be one of TEST, TYPECHECK, LINT, BUILD")
      }
      return { action }
    },
    prepareForReview: async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ReviewableExecution> => {
      const action = input.action as VerificationAction
      const root = action === "TEST" ? await verificationWorkspace(context.workspaceRoot, context.instruction) : context.workspaceRoot
      const command = await discoverVerificationCommand(root, action)
      const verificationId = `verification-${Date.now()}-${Math.random().toString(36).slice(2)}`
      
      const prepared: PreparedVerification = {
        verificationId,
        action,
        executable: command.executable,
        args: command.args,
        cwd: root,
        timeoutMs: ACTION_TIMEOUTS[action],
        commandPreview: `${command.env ? Object.entries(command.env).map(([key, value]) => `${key}=${value} `).join("") : ""}${command.executable} ${command.args.join(" ")}`,
        ...(command.env ? { env: command.env } : {}),
        packageJsonPath: command.packageJsonPath,
        packageJsonHash: command.packageJsonHash,
        scriptName: command.scriptName,
        scriptBody: command.scriptBody,
        sandboxPreview: `${describeSandbox(predictSandbox(command.requiresSandbox ? "required" : sandbox))}${command.requiresSandbox ? " Sandbox required: this uses the project's virtualenv and never runs outside the sandbox." : ""}`,
        ...(command.requiresSandbox ? { requiresSandbox: true } : {}),
        ...(command.readOnlyBinds ? { readOnlyBinds: command.readOnlyBinds } : {}),
      }

      return {
        id: verificationId,
        reviewPayload: prepared as any,
        apply: async (applyContext: ToolExecutionContext): Promise<VerificationResult> => {
          const result = await engine.execute(prepared, applyContext.signal, applyContext.onOutput)
          const setup = result.status === "EXECUTION_ERROR" && result.stderr.startsWith("ENVIRONMENT_SETUP_REQUIRED:") ? result.stderr.slice("ENVIRONMENT_SETUP_REQUIRED: ".length).trim() : undefined
          if (setup) return { ...result, diagnosis: `ENVIRONMENT_SETUP_REQUIRED: ${setup} This is not a failure of the code and editing code will not fix it. Do not run it again. Continue with the requested change, and report verification as blocked with this reason.` }
          if (result.status !== "FAIL") return result
          const blocked = environmentBlocker(`${result.stdout}\n${result.stderr}`)
          if (blocked) {
            // The command could not run here; that says nothing about the code, so it is not a test failure.
            return { ...result, status: "EXECUTION_ERROR", diagnosis: `ENVIRONMENT_SETUP_REQUIRED: verification could not run in this workspace (${blocked}). This is not a failure of the code and editing code will not fix it. Do not run it again. Continue with the requested change, and report verification as blocked with this reason.` }
          }
          // Read-only. The summary is the reporter's own failures; symbol diagnosis is added when a name is unresolved.
          const output = `${result.stdout}\n${result.stderr}`
          const summary = summarizeVerification(output)
          const symbol = await diagnoseUnresolvedSymbols(workspaceRoot, output).catch(() => undefined)
          const diagnosis = [summary.text, symbol].filter((part) => part && part.trim().length > 0).join("\n\n")
          const total = summary.failed !== undefined ? summary.failed + (summary.passed ?? 0) + (summary.skipped ?? 0) : undefined
          return {
            ...result,
            ...(summary.failed !== undefined ? { failedTests: summary.failed } : {}),
            ...(total !== undefined ? { totalTests: total } : {}),
            ...(diagnosis ? { diagnosis } : {}),
          }
        },
      }
    },
    execute: async () => {
      throw new Error("run_verification requires a two-phase review process")
    },
  }

  return [runVerificationRegistration]
}

export function createVerificationToolRegistry(workspaceRoot: string): ToolRegistry {
  return new ToolRegistry(createVerificationToolRegistrations(workspaceRoot))
}

/**
 * A verification command that failed before testing anything: the toolchain or dependencies are missing, or
 * it tried to reach the network (the sandbox has none). Only unambiguous signals; anything else stays FAIL.
 */
export function environmentBlocker(output: string): string | undefined {
  if (/Corepack is about to download|corepack[^\n]*(?:fetch failed|ENOTFOUND|EAI_AGAIN)/i.test(output)) return "the package manager is not installed and the sandbox has no network to download it"
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b[^\n]*registry|getaddrinfo[^\n]*registry|ERR_PNPM_(?:FETCH|META_FETCH)|npm ERR! network/i.test(output)) return "it needs network access to a package registry, which the sandbox does not have"
  const missing = /(?:^|\n)(?:sh: \d+: |\/bin\/sh: \d+: |)(tsc|vitest|jest|mocha|eslint|vite|tsx|pnpm|yarn|pytest|ruff): (?:command )?not found/.exec(output)
  if (missing) return `${missing[1]} is not installed in the workspace; its dependencies have not been installed`
  if (/No module named '?pytest'?/.test(output)) return "pytest is not installed in the workspace's Python environment"
  if (/node_modules missing, did you mean to install|Local package\.json exists, but node_modules missing/i.test(output)) return "the workspace's node_modules are not installed"
  return undefined
}
