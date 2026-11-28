import { createHash } from "node:crypto"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import * as path from "node:path"
import { ToolRegistry, ToolRegistration, ToolExecutionContext, ReviewableExecution } from "./registry.ts"
import { discoverVerificationCommand, resolveNodeBinary, verificationWorkspace } from "./verification-discovery.ts"
import { RepositoryPathError, resolveRepositoryPath } from "./path-safety.ts"
import { VerificationEngine } from "./verification-engine.ts"
import { type CommandSandboxMode, describeSandbox, predictSandbox } from "./command-sandbox.ts"
import { diagnoseUnresolvedSymbols } from "./symbol-diagnosis.ts"
import { classifyVerificationFailure, summarizeVerification } from "./verification-summary.ts"
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
      
      const plan = action === "TEST" ? await planStaleDependencyBuilds(context.workspaceRoot, root) : { builds: [] as PreparedVerification[] }
      if (plan.error) throw new Error(plan.error)
      const testPreview = `${command.env ? Object.entries(command.env).map(([key, value]) => `${key}=${value} `).join("") : ""}${command.executable} ${command.args.join(" ")}`
      const prepared: PreparedVerification = {
        verificationId,
        action,
        executable: command.executable,
        args: command.args,
        cwd: root,
        timeoutMs: ACTION_TIMEOUTS[action],
        commandPreview: plan.builds.length > 0 ? `${plan.builds.map((build) => build.commandPreview).join(" && ")} && ${testPreview}` : testPreview,
        ...(plan.builds.length > 0 ? { dependencyBuilds: plan.builds } : {}),
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
          const notes: string[] = []
          for (const build of prepared.dependencyBuilds ?? []) {
            const built = await engine.execute(build, applyContext.signal, applyContext.onOutput)
            if (built.status !== "PASS") return { ...built, diagnosis: [build.reviewNote, built.stderr || built.stdout].filter((part) => part && part.trim().length > 0).join("\n") }
            if (build.reviewNote) notes.push(build.reviewNote)
          }
          const rebuiltNote = notes.length > 0 ? notes.join(" ") : undefined
          const result = await engine.execute(prepared, applyContext.signal, applyContext.onOutput)
          const noted = (diagnosis?: string): string => [rebuiltNote, diagnosis].filter(Boolean).join("\n\n")
          const setup = result.status === "EXECUTION_ERROR" && result.stderr.startsWith("ENVIRONMENT_SETUP_REQUIRED:") ? result.stderr.slice("ENVIRONMENT_SETUP_REQUIRED: ".length).trim() : undefined
          if (setup) {
            return {
              ...result,
              failureClass: "ENVIRONMENT_SETUP_REQUIRED",
              diagnosis: noted(`ENVIRONMENT_SETUP_REQUIRED: ${setup} This is not a failure of the code and editing code will not fix it. Do not run it again. Continue with the requested change, and report verification as blocked with this reason.`),
            } satisfies VerificationResult
          }
          if (result.status !== "FAIL") {
            const failureClass = result.status === "PASS"
              ? undefined
              : classifyVerificationFailure({ action, status: result.status, stdout: result.stdout, stderr: result.stderr })
            const classified = {
              ...result,
              ...(failureClass ? { failureClass } : {}),
              ...(rebuiltNote ? { diagnosis: noted() } : {}),
            } satisfies VerificationResult
            return classified
          }
          const blocked = environmentBlocker(`${result.stdout}\n${result.stderr}`)
          if (blocked) {
            // The command could not run here; that says nothing about the code, so it is not a test failure.
            return { ...result, status: "EXECUTION_ERROR", failureClass: "ENVIRONMENT_SETUP_REQUIRED", diagnosis: `ENVIRONMENT_SETUP_REQUIRED: verification could not run in this workspace (${blocked}). This is not a failure of the code and editing code will not fix it. Do not run it again. Continue with the requested change, and report verification as blocked with this reason.` }
          }
          // Read-only. The summary is the reporter's own failures; symbol diagnosis is added when a name is unresolved.
          const output = `${result.stdout}\n${result.stderr}`
          const summary = summarizeVerification(output)
          const symbol = await diagnoseUnresolvedSymbols(workspaceRoot, output).catch(() => undefined)
          const diagnosis = [rebuiltNote, summary.text, symbol].filter((part) => part && part.trim().length > 0).join("\n\n")
          const total = summary.failed !== undefined ? summary.failed + (summary.passed ?? 0) + (summary.skipped ?? 0) : undefined
          return {
            ...result,
            failureClass: classifyVerificationFailure({ action, status: result.status, stdout: result.stdout, stderr: result.stderr }),
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
 * The build is part of the reviewed test command and runs through VerificationEngine.
 * shortcut: only a `tsc` build script, when a dependency needs a different compiler.
 */
export async function planStaleDependencyBuilds(workspaceRoot: string, packageDir: string): Promise<{ builds: PreparedVerification[]; error?: string }> {
  let rootReal: string
  try {
    rootReal = await realpath(workspaceRoot)
  } catch {
    return { builds: [] }
  }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  } catch {
    return { builds: [] }
  }
  const node = resolveNodeBinary({ workspaceRoot: rootReal })
  const nodeReal = await realpath(node).catch(() => node)
  if (inside(rootReal, nodeReal)) return { builds: [], error: "Node resolves inside the workspace, so a dependency build cannot be sandboxed." }
  const tscReal = await realpath(path.join(rootReal, "node_modules", "typescript", "lib", "tsc.js")).catch(() => undefined)
  const builds: PreparedVerification[] = []
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue
    let depDir: string
    try {
      depDir = await realpath(path.join(packageDir, "node_modules", name))
    } catch {
      continue
    }
    if (!inside(rootReal, depDir)) continue
    const planned = await planOne(rootReal, depDir, name, node, tscReal)
    if (planned === "fresh" || planned === undefined) continue
    if (typeof planned === "string") return { builds: [], error: planned }
    builds.push(planned)
  }
  return { builds }
}

async function planOne(rootReal: string, depDir: string, name: string, node: string, tscReal: string | undefined): Promise<PreparedVerification | "fresh" | string | undefined> {
  let text: string
  let depPkg: { scripts?: Record<string, string>; exports?: unknown; main?: string }
  try {
    text = await readFile(path.join(depDir, "package.json"), "utf8")
    depPkg = JSON.parse(text) as { scripts?: Record<string, string>; exports?: unknown; main?: string }
  } catch {
    return undefined
  }
  const script = depPkg.scripts?.build?.trim()
  if (!script?.startsWith("tsc ")) return undefined
  const target = publishedEntry(depPkg)
  if (!target?.startsWith("dist/")) return undefined
  const distFile = path.join(depDir, target)
  let distTime = 0
  try {
    distTime = (await stat(distFile)).mtimeMs
  } catch {
    distTime = 0
  }
  if (await newestMtime(path.join(depDir, "src"), 0) <= distTime) return "fresh"
  if (!tscReal || !inside(rootReal, tscReal)) return `${name} needs a rebuild and typescript/lib/tsc.js does not resolve inside the workspace.`
  const args = script.split(/\s+/).slice(1)
  for (const arg of args) {
    if (!pathLike(arg)) continue
    if (!await argStaysInside(rootReal, depDir, arg)) return `${name} build argument resolves outside the workspace: ${arg}`
  }
  const compilerArgs = [tscReal, ...args]
  return {
    verificationId: `dependency-build-${name.replace(/[^a-z0-9]+/gi, "-")}-${Math.random().toString(36).slice(2)}`,
    action: "BUILD",
    executable: node,
    args: compilerArgs,
    cwd: depDir,
    timeoutMs: ACTION_TIMEOUTS.BUILD,
    commandPreview: `${node} ${compilerArgs.join(" ")}`,
    packageJsonPath: path.join(depDir, "package.json"),
    packageJsonHash: createHash("sha256").update(text).digest("hex"),
    scriptName: "build",
    scriptBody: script,
    reviewNote: `Rebuilt ${name} because ${target} was older than src.`,
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function pathLike(arg: string): boolean {
  if (arg.startsWith("-") && !arg.includes("..") && !arg.includes("/") && !arg.includes("\\")) return false
  return arg.includes("/") || arg.includes("\\") || arg.startsWith(".") || path.isAbsolute(arg)
}

async function argStaysInside(root: string, cwd: string, arg: string): Promise<boolean> {
  const abs = path.resolve(cwd, arg)
  try {
    await resolveRepositoryPath(root, abs)
    return true
  } catch (error) {
    if (!(error instanceof RepositoryPathError) || error.code !== "NOT_FOUND") return false
    const parent = path.dirname(abs)
    return parent !== abs && argStaysInside(root, cwd, parent)
  }
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

export function environmentBlocker(output: string): string | undefined {
  if (/This project is configured to use (?:pnpm|yarn)|ERR_PNPM_UNSUPPORTED|This is not a yarn project/i.test(output)) {
    return "the command used a different package manager than the project declares"
  }
  if (/Corepack is about to download|corepack[^\n]*(?:fetch failed|ENOTFOUND|EAI_AGAIN)/i.test(output)) return "the package manager is not installed and the sandbox has no network to download it"
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b[^\n]*registry|getaddrinfo[^\n]*registry|ERR_PNPM_(?:FETCH|META_FETCH)|npm ERR! network/i.test(output)) return "it needs network access to a package registry, which the sandbox does not have"
  const missing = /(?:^|\n)(?:sh: \d+: |\/bin\/sh: \d+: |)(tsc|vitest|jest|mocha|eslint|vite|tsx|pnpm|yarn|pytest|ruff): (?:command )?not found/.exec(output)
  if (missing) return `${missing[1]} is not installed in the workspace; its dependencies have not been installed`
  if (/No module named '?pytest'?/.test(output)) return "pytest is not installed in the workspace's Python environment"
  if (/node_modules missing, did you mean to install|Local package\.json exists, but node_modules missing/i.test(output)) return "the workspace's node_modules are not installed"
  return undefined
}
