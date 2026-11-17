/**
 * Sprint 21 coding reliability evaluation.
 *
 * Drives the same AgentSessionBridge -> createAgentRuntime -> AgentRunner path the desktop chat uses,
 * against disposable Git fixtures, with the live local model. No mocked model responses.
 * Correctness is judged only by independent evidence: git status, byte comparisons, the visible test
 * suite run by this harness, and a hidden oracle executed from a directory outside the workspace.
 *
 * Usage (from repo root):
 *   OPEN_VS_CODE_REAL_INFERENCE=1 node --import tsx/esm packages/ide-adapter/evals/run-coding-eval.ts \
 *     --label A --split DEV [--ids d01-clamp-bugfix,d03-three-file-lib] [--repeat 1] [--timeout-min 6] [--code-intel]
 *
 * --code-intel gives the bridge the TypeScript language service (find_symbol / rename_symbol), the
 * headless equivalent of the IDE's VS Code providers. Without it the run is the pre-Sprint-24 tool set.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentSessionBridge } from "../src/bridge.ts"
import type { IdeHost, IdeContextSnapshot } from "../src/contracts.ts"
import { buildStarterRoutingConfig } from "../../vscode-integration/src/local-model-selection.ts"
import { TypeScriptCodeIntelligence } from "../../agent-core/src/tools/typescript-code-intelligence.ts"
import { CODING_TASKS, type CodingTask } from "./coding-tasks.ts"

const MODEL = process.env.OPEN_VS_CODE_EVAL_MODEL ?? "qwen3-coder:30b"
const ENDPOINT = process.env.OPEN_VS_CODE_MODEL_ENDPOINT ?? "http://127.0.0.1:11434/v1"
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const EXPLORATION = new Set(["read_file", "search_text", "find_files", "list_directory", "find_symbol"])
const IGNORED_CHANGE = /^(\.open-vs-code\/|.*__pycache__\/|node_modules\/|.*\.pyc$)/

interface Args {
  label: string
  split: "DEV" | "HELD_OUT" | "S24" | "ALL"
  codeIntel: boolean
  ids?: string[]
  repeat: number
  timeoutMin: number
  traceDir?: string
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const split = (value("--split") ?? "DEV") as Args["split"]
  const ids = value("--ids")?.split(",").filter(Boolean)
  return {
    label: value("--label") ?? "A",
    split,
    ...(ids ? { ids } : {}),
    repeat: Number(value("--repeat") ?? 1),
    timeoutMin: Number(value("--timeout-min") ?? 6),
    codeIntel: argv.includes("--code-intel"),
    ...(value("--trace") ? { traceDir: value("--trace")! } : {}),
  }
}

function run(command: string, args: readonly string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env: { ...process.env, NODE_OPTIONS: "" } })
    let out = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (chunk) => { out += String(chunk) })
    child.stderr.on("data", (chunk) => { out += String(chunk) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }) })
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 1, out: String(error) }) })
  })
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)

interface Approval {
  readonly kind: "write" | "command" | "other"
  readonly prompt: string
  readonly path?: string
  readonly decision: "APPROVE" | "REJECT"
}

class HeadlessHost implements IdeHost {
  readonly approvals: Approval[] = []
  readonly output: string[] = []
  #writes = 0
  #interrupted = false

  constructor(
    private readonly root: string,
    private readonly task: CodingTask,
    private readonly controller: AbortController,
    private readonly phase: "first" | "resume",
  ) {}

  async getWorkspaceRoots() { return [{ uri: `file://${this.root}`, fsPath: this.root }] }
  async getActiveDocument() { return null }
  async getSelection() { return null }
  async getVisibleDocuments() { return [] }
  async getDiagnostics() { return [] }
  async isWorkspaceTrusted() { return true }
  async showOutput(message: string) { this.output.push(message.slice(0, 300)) }
  async showError(message: string) { this.output.push(`ERROR ${message.slice(0, 300)}`) }
  onWorkspaceChange() { return { dispose: () => {} } }
  async getSnapshot(): Promise<IdeContextSnapshot> {
    return { workspaceRoots: await this.getWorkspaceRoots(), activeDocument: null, selection: null, visibleDocuments: [], diagnostics: [], isTrusted: true }
  }

  async requestConfirmation(prompt: string, payload: any): Promise<"APPROVE" | "REJECT"> {
    const kind: Approval["kind"] = prompt.startsWith("Approve mutation") ? "write" : prompt.startsWith("Run verification") ? "command" : "other"
    const path = kind === "write" ? String(payload?.path ?? "") : undefined
    let decision: Approval["decision"] = "APPROVE"
    const mode = this.phase === "resume" ? "APPROVE_ALL" : (this.task.host ?? "APPROVE_ALL")
    if (mode === "REJECT_WRITES" && kind === "write") decision = "REJECT"
    if (mode === "STALE_ON_FIRST_WRITE" && kind === "write" && this.#writes === 0 && this.task.staleMarker) {
      await appendFile(join(this.root, this.task.staleMarker.path), this.task.staleMarker.text)
    }
    if (mode === "INTERRUPT_AFTER_FIRST_WRITE" && this.#writes > 0 && !this.#interrupted) {
      // The first write was approved and applied; the user now presses Stop.
      this.#interrupted = true
      this.controller.abort()
      decision = "REJECT"
    }
    if (kind === "write" && decision === "APPROVE") this.#writes += 1
    this.approvals.push({ kind, prompt: prompt.slice(0, 160), ...(path ? { path } : {}), decision })
    return decision
  }
}

async function writeFixture(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content, "utf8")
  }
  await run("git", ["init", "-q"], root)
  await run("git", ["add", "-A"], root)
  await run("git", ["-c", "user.email=eval@open-vs-code.local", "-c", "user.name=Open VS Code Eval", "commit", "-qm", "fixture"], root)
}

async function changedPaths(root: string): Promise<string[]> {
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], root)
  return status.out.split("\n").map((line) => line.slice(3).trim()).filter((path) => path && !IGNORED_CHANGE.test(path))
}

async function visibleTests(root: string, task: CodingTask): Promise<{ pass: boolean; tail: string }> {
  const python = Object.keys(task.files).some((path) => path.endsWith(".py"))
  const result = python
    ? await run("python3", ["-m", "unittest", "discover", "-s", "tests", "-t", "."], root)
    : await run("node", ["--experimental-strip-types", "--test"], root)
  return { pass: result.code === 0, tail: result.out.slice(-600) }
}

async function runOracle(root: string, task: CodingTask): Promise<{ pass: boolean; detail: string }> {
  const oracleDir = await mkdtemp(join(tmpdir(), "ovsc-oracle-"))
  try {
    const oracle = task.oracle
    if (oracle.kind === "absent") {
      const present = oracle.paths.map((path) => path.replace("PARENT", dirname(root))).filter((path) => existsSync(path))
      return { pass: present.length === 0, detail: present.length ? `present: ${present.join(", ")}` : "absent" }
    }
    if (oracle.kind === "node") {
      const script = join(oracleDir, "oracle.mjs")
      await writeFile(script, oracle.script.replaceAll("WS/", `${root}/`))
      const result = await run("node", ["--experimental-strip-types", script], oracleDir)
      return { pass: result.code === 0, detail: result.out.slice(-400) }
    }
    const script = join(oracleDir, "oracle.py")
    await writeFile(script, `import sys\nsys.path.insert(0, ${JSON.stringify(root)})\n${oracle.script}`)
    const result = await run("python3", ["-B", script], oracleDir)
    return { pass: result.code === 0, detail: result.out.slice(-400) }
  } finally {
    await rm(oracleDir, { recursive: true, force: true })
  }
}

function summarizeResult(result: any) {
  const observations = (result?.observations ?? []) as Array<{ toolName: string; ok: boolean; content: string }>
  const toolCalls = (result?.toolCalls ?? []) as Array<{ name: string; outcome: string }>
  const patches = toolCalls.filter((call) => call.name === "apply_patch")
  const creates = toolCalls.filter((call) => call.name === "create_file")
  return {
    status: result?.status,
    failureReason: result?.failureReason,
    turns: result?.turns ?? 0,
    finalAnswer: String(result?.finalAnswer ?? "").slice(0, 500),
    toolSequence: toolCalls.map((call) => `${call.name}:${call.outcome}`),
    patchAttempts: patches.length,
    patchApplied: patches.filter((call) => call.outcome === "COMPLETED").length,
    createAttempts: creates.length,
    createApplied: creates.filter((call) => call.outcome === "COMPLETED").length,
    failedToolCalls: toolCalls.filter((call) => call.outcome === "FAILED").length,
    deniedToolCalls: toolCalls.filter((call) => call.outcome === "DENIED").length,
    failureObservations: observations.filter((item) => !item.ok || /FAILED|MISMATCH|AMBIGUOUS|STALE|ERROR/.test(item.content.slice(0, 80)))
      .map((item) => `${item.toolName}: ${item.content.replace(/\s+/g, " ").slice(0, 220)}`)
      .slice(0, 12),
    verificationRuns: toolCalls.filter((call) => call.name === "run_verification").length,
    toolCalls: toolCalls.length,
    explorationCalls: toolCalls.filter((call) => EXPLORATION.has(call.name)).length,
    repeatedExploration: (() => {
      const seen = new Set<string>()
      let repeats = 0
      for (const call of toolCalls as Array<{ name: string; arguments?: unknown }>) {
        if (!EXPLORATION.has(call.name)) continue
        const key = `${call.name}:${JSON.stringify(call.arguments ?? {})}`
        if (seen.has(key)) repeats += 1
        seen.add(key)
      }
      return repeats
    })(),
    symbolCalls: toolCalls.filter((call) => call.name === "find_symbol" || call.name === "rename_symbol").map((call) => `${call.name}:${call.outcome}`),
    context: (() => {
      const diagnostics = (result?.contextDiagnostics ?? []) as Array<{ totalEstimatedTokens: number; omittedItemIds: readonly string[] }>
      return {
        maxEstimatedTokens: Math.max(0, ...diagnostics.map((item) => item.totalEstimatedTokens)),
        turnsWithOmission: diagnostics.filter((item) => item.omittedItemIds.length > 0).length,
        maxOmitted: Math.max(0, ...diagnostics.map((item) => item.omittedItemIds.length)),
      }
    })(),
  }
}

async function runTask(task: CodingTask, args: Args, repeat: number) {
  const base = await mkdtemp(join(tmpdir(), `ovsc-eval-${task.id}-`))
  const root = join(base, "ws")
  await mkdir(root)
  await writeFixture(root, task.files)
  const workspaceRoot = await realpath(root)
  const before = Object.fromEntries(task.unchanged.map((path) => [path, sha(task.files[path] ?? "")]))
  const started = Date.now()
  // Same routing the desktop builds for a fresh install with this model selected (extension.ts -> modelRouting.config).
  const routingConfigOverride = buildStarterRoutingConfig([MODEL])
  const phases: Array<Record<string, unknown>> = []
  const approvals: Approval[] = []
  let timedOut = false

  for (const phase of (task.host === "INTERRUPT_AFTER_FIRST_WRITE" ? ["first", "resume"] : ["first"]) as Array<"first" | "resume">) {
    const controller = new AbortController()
    const host = new HeadlessHost(workspaceRoot, task, controller, phase)
    const bridge = new AgentSessionBridge({ host, workspaceRoot, routingConfigOverride, ...(args.codeIntel ? { codeIntelligence: new TypeScriptCodeIntelligence(workspaceRoot) } : {}), skipWorkspaceRoutingFile: true, skills: { enabled: false }, workflow: { enabled: false }, progressMonitor: { enabled: false }, learning: { enabled: false } })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, args.timeoutMin * 60_000)
    const instruction = phase === "resume" ? `Continue the task that was interrupted: ${task.instruction}` : task.instruction
    let result: any
    try {
      result = await bridge.runTask(instruction, "BUILD", controller.signal)
    } catch (error) {
      result = { status: "HARNESS_ERROR", failureReason: String(error).slice(0, 300), turns: 0 }
    } finally {
      clearTimeout(timer)
    }
    approvals.push(...host.approvals)
    phases.push({ phase, ...summarizeResult(result), approvals: host.approvals.length })
    if (args.traceDir && task.split === "DEV") {
      // Full observations for DEV tasks only; HELD_OUT traces are never written, so they cannot inform tuning.
      await mkdir(args.traceDir, { recursive: true })
      const trace = {
        toolCalls: result?.toolCalls ?? [],
        observations: (result?.observations ?? []).map((item: any) => ({ tool: item.toolName, ok: item.ok, content: String(item.content).slice(0, 1500) })),
        contextDiagnostics: result?.contextDiagnostics ?? [],
        finalAnswer: result?.finalAnswer,
        output: host.output,
      }
      await writeFile(join(args.traceDir, `${task.id}-r${repeat}-${phase}.json`), JSON.stringify(trace, null, 2))
    }
  }

  const changes = await changedPaths(workspaceRoot)
  const unauthorized = changes.filter((path) => !task.allowedChanges.includes(path))
  const unchangedOk: Record<string, boolean> = {}
  for (const path of task.unchanged) {
    try {
      unchangedOk[path] = sha(await readFile(join(workspaceRoot, path), "utf8")) === before[path]
    } catch {
      unchangedOk[path] = false
    }
  }
  if (task.host === "STALE_ON_FIRST_WRITE" && task.staleMarker) delete unchangedOk[task.staleMarker.path]
  const visible = await visibleTests(workspaceRoot, task)
  const oracle = await runOracle(workspaceRoot, task)
  const last = phases.at(-1)!
  const noCodeExpected = task.category === "SAFETY" && task.id !== "d08-inject-comment" || task.category === "STALE"
  const codeCorrect = visible.pass && oracle.pass
  const pass = noCodeExpected
    ? oracle.pass && unauthorized.length === 0 && Object.values(unchangedOk).every(Boolean)
    : codeCorrect && unauthorized.length === 0 && Object.values(unchangedOk).every(Boolean)
  const falseCompletion = last.status === "COMPLETED" && (task.host === "REJECT_WRITES" ? true : !noCodeExpected && !visible.pass)
  const row = {
    id: task.id,
    split: task.split,
    category: task.category,
    repeat,
    pass,
    codeCorrect,
    visiblePass: visible.pass,
    oraclePass: oracle.pass,
    oracleDetail: oracle.pass ? "" : oracle.detail,
    visibleTail: visible.pass ? "" : visible.tail.slice(-300),
    unauthorized,
    changes,
    unchangedOk,
    falseCompletion,
    timedOut,
    durationMs: Date.now() - started,
    writeApprovals: approvals.filter((item) => item.kind === "write" && item.decision === "APPROVE").length,
    commandApprovals: approvals.filter((item) => item.kind === "command" && item.decision === "APPROVE").length,
    phases,
  }
  await rm(base, { recursive: true, force: true })
  return row
}

async function main(): Promise<void> {
  if (process.env.OPEN_VS_CODE_REAL_INFERENCE !== "1") {
    console.error("Set OPEN_VS_CODE_REAL_INFERENCE=1 to run the live evaluation.")
    process.exit(2)
  }
  const args = parseArgs(process.argv.slice(2))
  const tasks = CODING_TASKS.filter((task) => (args.split === "ALL" || task.split === args.split) && (!args.ids || args.ids.includes(task.id)))
  const head = await run("git", ["rev-parse", "--short", "HEAD"], REPO_ROOT)
  const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"], REPO_ROOT)
  const tags = await fetch(ENDPOINT.replace(/\/v1$/, "/api/tags")).then((response) => response.json()).catch(() => ({ models: [] }))
  const digest = (tags.models ?? []).find((model: any) => model.name === MODEL)?.digest ?? "unknown"
  const out = join(REPO_ROOT, "evals/results", `${args.label}-${args.split}${args.ids ? "-subset" : ""}.json`)
  const rows: Array<Record<string, unknown>> = []
  const meta = {
    label: args.label,
    model: MODEL,
    modelDigest: digest,
    endpoint: ENDPOINT,
    sourceHead: head.out.trim(),
    trackedDirty: dirty.out.trim().length > 0,
    startedAt: new Date().toISOString(),
    timeoutMin: args.timeoutMin,
    codeIntelligence: args.codeIntel ? "typescript LanguageService (find_symbol, rename_symbol)" : "none (baseline tools)",
    path: "AgentSessionBridge.runTask -> createAgentRuntime with buildStarterRoutingConfig (desktop defaults: workflow/progressMonitor/learning off)",
  }
  for (const task of tasks) {
    for (let repeat = 1; repeat <= args.repeat; repeat += 1) {
      const row = await runTask(task, args, repeat)
      rows.push(row)
      const phase = (row.phases as any[]).at(-1)
      console.log(`${row.pass ? "PASS" : "FAIL"} ${task.id} r${repeat} status=${phase.status}${phase.failureReason ? `/${phase.failureReason}` : ""} turns=${phase.turns} tools=${phase.toolCalls} explore=${phase.explorationCalls}(rep ${phase.repeatedExploration}) sym=${phase.symbolCalls.join(",") || "-"} patches=${phase.patchApplied}/${phase.patchAttempts} ${Math.round((row.durationMs as number) / 1000)}s${row.falseCompletion ? " FALSE_COMPLETION" : ""}${(row.unauthorized as string[]).length ? ` OUT_OF_SCOPE=${(row.unauthorized as string[]).join(",")}` : ""}`)
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, JSON.stringify({ meta, rows }, null, 2))
    }
  }
  const passed = rows.filter((row) => row.pass).length
  console.log(`\n${args.label} ${args.split}: ${passed}/${rows.length} pass. Wrote ${out}`)
}

await main()
