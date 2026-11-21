import { spawn } from "node:child_process"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import * as path from "node:path"
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
          const rebuilt = action === "TEST" ? await rebuildStaleWorkspacePackages(applyContext.workspaceRoot, prepared.cwd, applyContext.signal) : undefined
          if (rebuilt?.error) {
            return { status: "EXECUTION_ERROR" as const, exitCode: rebuilt.exitCode, stdout: "", stderr: rebuilt.error, durationMs: rebuilt.durationMs, diagnosis: rebuilt.error }
          }
          const result = await engine.execute(prepared, applyContext.signal, applyContext.onOutput)
          const noted = (diagnosis?: string) => rebuilt?.note ? (diagnosis ? `${rebuilt.note}\n\n${diagnosis}` : rebuilt.note) : diagnosis
          const setup = result.status === "EXECUTION_ERROR" && result.stderr.startsWith("ENVIRONMENT_SETUP_REQUIRED:") ? result.stderr.slice("ENVIRONMENT_SETUP_REQUIRED: ".length).trim() : undefined
          if (setup) return { ...result, diagnosis: noted(`ENVIRONMENT_SETUP_REQUIRED: ${setup} This is not a failure of the code and editing code will not fix it. Do not run it again. Continue with the requested change, and report verification as blocked with this reason.`) }
          if (result.status !== "FAIL") return rebuilt?.note ? { ...result, diagnosis: noted() } : result
          const blocked = environmentBlocker(`${result.stdout}\n${result.stderr}`)
          if (blocked) {
            // The command could not run here; that says nothing about the code, so it is not a test failure.
            return { ...result, status: "EXECUTION_ERROR", diagnosis: `ENVIRONMENT_SETUP_REQUIRED: verification could not run in this workspace (${blocked}). This is not a failure of the code and editing code will not fix it. Do not run it again. Continue with the requested change, and report verification as blocked with this reason.` }
          }
          // Read-only. The summary is the reporter's own failures; symbol diagnosis is added when a name is unresolved.
          const output = `${result.stdout}\n${result.stderr}`
          const summary = summarizeVerification(output)
          const symbol = await diagnoseUnresolvedSymbols(workspaceRoot, output).catch(() => undefined)
          const diagnosis = [rebuilt?.note, summary.text, symbol].filter((part) => part && part.trim().length > 0).join("\n\n")
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
/**
 * A workspace dependency whose published `dist` is older than `src` is invisible to the test runner.
 * shortcut: only a `tsc` build script, when a dependency needs a different compiler.
 */
export async function rebuildStaleWorkspacePackages(
  workspaceRoot: string,
  packageDir: string,
  signal?: AbortSignal,
): Promise<{ note?: string; error?: string; exitCode: number | null; durationMs: number } | undefined> {
  const started = Date.now()
  let rootReal: string
  try {
    rootReal = await realpath(workspaceRoot)
  } catch {
    return undefined
  }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  } catch {
    return undefined
  }
  const notes: string[] = []
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue
    let depDir: string
    try {
      depDir = await realpath(path.join(packageDir, "node_modules", name))
    } catch {
      continue
    }
    if (depDir !== rootReal && !depDir.startsWith(`${rootReal}${path.sep}`)) continue
    const outcome = await rebuildOne(rootReal, depDir, name, signal)
    if (outcome === "fresh" || outcome === undefined) continue
    if (outcome.startsWith("ERROR:")) return { error: outcome.slice("ERROR:".length), exitCode: 1, durationMs: Date.now() - started }
    notes.push(outcome)
  }
  return notes.length > 0 ? { note: notes.join(" "), exitCode: 0, durationMs: Date.now() - started } : undefined
}

async function rebuildOne(workspaceRoot: string, depDir: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
  let depPkg: { scripts?: Record<string, string>; exports?: unknown; main?: string }
  try {
    depPkg = JSON.parse(await readFile(path.join(depDir, "package.json"), "utf8")) as { scripts?: Record<string, string>; exports?: unknown; main?: string }
  } catch {
    return undefined
  }
  const script = depPkg.scripts?.build?.trim()
  if (!script?.startsWith("tsc ")) return undefined
  const target = publishedEntry(depPkg)
  if (!target?.startsWith("dist/")) return undefined
  const distFile = path.join(depDir, target)
  const srcDir = path.join(depDir, "src")
  let distTime = 0
  try {
    distTime = (await stat(distFile)).mtimeMs
  } catch {
    distTime = 0
  }
  const srcTime = await newestMtime(srcDir, 0)
  if (srcTime <= distTime) return "fresh"
  const tsc = path.join(workspaceRoot, "node_modules", ".bin", "tsc")
  try {
    await stat(tsc)
  } catch {
    return `ERROR:${name} needs a rebuild and tsc is not in the workspace.`
  }
  const args = script.split(/\s+/).slice(1)
  const { code, stderr } = await runBuild(tsc, args, depDir, signal)
  if (code !== 0) return `ERROR:${name} build failed: ${stderr.slice(0, 400)}`
  return `Rebuilt ${name} because ${target} was older than src.`
}

function publishedEntry(pkg: { exports?: unknown; main?: string }): string | undefined {
  const exp = pkg.exports
  let target: string | undefined
  if (typeof exp === "string") target = exp
  else if (exp && typeof exp === "object" && "." in exp) {
    const dot = (exp as { ".": unknown })["."]
    if (typeof dot === "string") target = dot
    else if (dot && typeof dot === "object") {
      const chosen = (dot as { import?: unknown }).import
      if (typeof chosen === "string") target = chosen
    }
  }
  target ??= pkg.main
  return target?.replace(/^\.\//, "")
}

async function newestMtime(dir: string, depth: number): Promise<number> {
  if (depth > 5) return 0
  let max = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) max = Math.max(max, await newestMtime(full, depth + 1))
    else max = Math.max(max, (await stat(full)).mtimeMs)
  }
  return max
}

function runBuild(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } })
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000) })
    const timer = setTimeout(() => child.kill(), 60_000)
    const onAbort = () => child.kill()
    signal?.addEventListener("abort", onAbort, { once: true })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve({ code, stderr })
    })
  })
}

export function environmentBlocker(output: string): string | undefined {
  if (/Corepack is about to download|corepack[^\n]*(?:fetch failed|ENOTFOUND|EAI_AGAIN)/i.test(output)) return "the package manager is not installed and the sandbox has no network to download it"
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b[^\n]*registry|getaddrinfo[^\n]*registry|ERR_PNPM_(?:FETCH|META_FETCH)|npm ERR! network/i.test(output)) return "it needs network access to a package registry, which the sandbox does not have"
  const missing = /(?:^|\n)(?:sh: \d+: |\/bin\/sh: \d+: |)(tsc|vitest|jest|mocha|eslint|vite|tsx|pnpm|yarn|pytest|ruff): (?:command )?not found/.exec(output)
  if (missing) return `${missing[1]} is not installed in the workspace; its dependencies have not been installed`
  if (/No module named '?pytest'?/.test(output)) return "pytest is not installed in the workspace's Python environment"
  if (/node_modules missing, did you mean to install|Local package\.json exists, but node_modules missing/i.test(output)) return "the workspace's node_modules are not installed"
  return undefined
}
