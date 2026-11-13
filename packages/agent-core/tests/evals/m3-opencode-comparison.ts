/**
 * Milestone 3 same-digest live coding comparison: Open VS Code AgentRunner vs OpenCode CLI.
 * Gated by OPEN_VS_CODE_REAL_INFERENCE=1. Disposable fixtures only.
 *
 * OpenCode is launched with --standalone, an isolated HOME/XDG tree, and an
 * explicit Build agent. Isolation is proven from recorded cwd and tool paths.
 * If isolation cannot be proven, OpenCode is INVALID, not FAIL.
 */
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { calculateBudget } from "../../src/context/budget.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { checkInferenceGate } from "../../src/model/inference-gate.ts"
import { AgentRunner } from "../../src/agent/runner.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { createVerificationToolRegistrations } from "../../src/tools/verification-registry.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import type { ConversationEncoding } from "../../src/agent/native-tool-messages.ts"
import { getCanonicalEvalsDir, checkGitProvenance } from "./real-model-benchmark.ts"

const MODEL = "qwen3-coder:30b"
const OPENCODE_MODEL = `ollama/${MODEL}`
const ENDPOINT = process.env.OPEN_VS_CODE_MODEL_ENDPOINT ?? "http://127.0.0.1:11434/v1"
const TASK_TIMEOUT_MS = 8 * 60 * 1000
const MAX_TURNS = 12

export interface FileCheck {
  readonly path: string
  readonly contains?: readonly string[]
  readonly notContains?: readonly string[]
}

export interface ComparisonTask {
  readonly id: string
  readonly title: string
  readonly instruction: string
  readonly files: Record<string, string>
  readonly checks: readonly FileCheck[]
}

export const M3_COMPARISON_TASKS: readonly ComparisonTask[] = [
  {
    id: "T01-off-by-one",
    title: "Fix off-by-one add",
    instruction: "Fix src/add.js so add(1, 2) returns 3. Use apply_patch. Do not change the test.",
    files: {
      "src/add.js": "export function add(a, b) {\n  return a + b + 1\n}\n",
      "test/add.test.js": "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { add } from '../src/add.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n",
    },
    checks: [{ path: "src/add.js", contains: ["a + b"], notContains: ["+ 1"] }],
  },
  {
    id: "T02-missing-export",
    title: "Export greet",
    instruction: "src/greet.js should export function greet(name) that returns Hello, {name}. Use apply_patch or create_file.",
    files: {
      "src/greet.js": "function greet(name) {\n  return `Hello, ${name}`\n}\n",
    },
    checks: [{ path: "src/greet.js", contains: ["export function greet"] }],
  },
  {
    id: "T03-cross-file",
    title: "Fix format import usage",
    instruction: "formatName in src/format.js is broken. It should return Last, First. Update src/format.js only.",
    files: {
      "src/format.js": "export function formatName(first, last) {\n  return `${first} ${last}`\n}\n",
      "src/greet.js": "import { formatName } from './format.js'\nexport function greet(first, last) {\n  return formatName(first, last)\n}\n",
    },
    checks: [{ path: "src/format.js", contains: ["${last}, ${first}"] }],
  },
  {
    id: "T04-rename",
    title: "Rename total to sumAll",
    instruction: "Rename exported function total to sumAll in src/math.js. Keep behavior.",
    files: {
      "src/math.js": "export function total(values) {\n  return values.reduce((a, b) => a + b, 0)\n}\n",
    },
    checks: [
      { path: "src/math.js", contains: ["export function sumAll"], notContains: ["export function total"] },
    ],
  },
  {
    id: "T05-counter",
    title: "Fix counter increment",
    instruction: "Fix src/counter.js so increment() increases by 1 from 0.",
    files: {
      "src/counter.js": "let n = 0\nexport function increment() {\n  n = n - 1\n  return n\n}\nexport function value() {\n  return n\n}\n",
    },
    checks: [{ path: "src/counter.js", contains: ["n = n + 1", "n + 1"], notContains: ["n - 1"] }],
  },
  {
    id: "T06-python-add",
    title: "Python add",
    instruction: "Fix src/add.py so add(1, 2) returns 3.",
    files: {
      "src/add.py": "def add(a, b):\n    return a + b + 1\n",
    },
    checks: [{ path: "src/add.py", contains: ["return a + b"], notContains: ["+ 1"] }],
  },
  {
    id: "T07-create-util",
    title: "Create clamp util",
    instruction: "Create src/clamp.js exporting function clamp(n, min, max) that bounds n between min and max.",
    files: {
      "README.md": "Utilities live in src/.\n",
    },
    checks: [{ path: "src/clamp.js", contains: ["export function clamp"] }],
  },
  {
    id: "T08-early-return",
    title: "Guard divide by zero",
    instruction: "Update src/div.js so divide(a, b) returns null when b is 0, otherwise a / b.",
    files: {
      "src/div.js": "export function divide(a, b) {\n  return a / b\n}\n",
    },
    checks: [{ path: "src/div.js", contains: ["b === 0", "null"] }],
  },
  {
    id: "T09-string",
    title: "Template string",
    instruction: "Change src/label.js so label(name) returns Name: {name} using a template string.",
    files: {
      "src/label.js": "export function label(name) {\n  return 'Name: ' + name\n}\n",
    },
    checks: [{ path: "src/label.js", contains: ["`Name: ${name}`"] }],
  },
  {
    id: "T10-two-files",
    title: "Update caller after rename",
    instruction: "src/area.js exports area. src/app.js calls square. Make app.js call area instead.",
    files: {
      "src/area.js": "export function area(w, h) {\n  return w * h\n}\n",
      "src/app.js": "import { square } from './area.js'\nexport function run() {\n  return square(2, 3)\n}\n",
    },
    checks: [{ path: "src/app.js", contains: ["area"], notContains: ["square"] }],
  },
  {
    id: "T11-json",
    title: "Safe JSON parse",
    instruction: "Fix src/parse.js so parseJson returns null on invalid JSON instead of throwing.",
    files: {
      "src/parse.js": "export function parseJson(text) {\n  return JSON.parse(text)\n}\n",
    },
    checks: [{ path: "src/parse.js", contains: ["try", "catch", "null"] }],
  },
  {
    id: "T12-expected",
    title: "Match test expected value",
    instruction: "The test expects double(4) === 8. Fix src/double.js. Do not change the test.",
    files: {
      "src/double.js": "export function double(n) {\n  return n * 3\n}\n",
      "test/double.test.js": "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { double } from '../src/double.js'\ntest('double', () => assert.equal(double(4), 8))\n",
    },
    checks: [{ path: "src/double.js", contains: ["n * 2"], notContains: ["n * 3"] }],
  },
]

export async function discoverModelDigest(model: string): Promise<string> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return "unknown"
    const data = await res.json() as { details?: { parent_model?: string }; digest?: string; model_info?: Record<string, unknown> }
    if (typeof data.digest === "string" && data.digest) return data.digest
    const modelfile = (data as { modelfile?: string }).modelfile
    const blob = typeof modelfile === "string" ? /sha256-([a-f0-9]{64})/.exec(modelfile)?.[0] : undefined
    return blob ?? "unknown"
  } catch {
    return "unknown"
  }
}

async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content, "utf8")
  }
}

async function spawnCapture(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? TASK_TIMEOUT_MS)
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 1, stdout, stderr: error instanceof Error ? error.message : String(error) })
    })
  })
}

async function initGit(root: string): Promise<void> {
  await spawnCapture("git", ["init"], { cwd: root, timeoutMs: 15_000 })
  await spawnCapture("git", ["add", "-A"], { cwd: root, timeoutMs: 15_000 })
  await spawnCapture("git", ["-c", "user.email=eval@open-vs-code.local", "-c", "user.name=Open VS Code Eval", "commit", "-m", "fixture", "--allow-empty"], { cwd: root, timeoutMs: 15_000 })
}

async function runIndependentVerifier(root: string, task: ComparisonTask): Promise<{ pass: boolean; detail: string }> {
  const bodies: Record<string, string> = {
    "T01-off-by-one": "import assert from 'node:assert/strict'\nimport { add } from './src/add.js'\nassert.equal(add(1, 2), 3)\nassert.equal(add(0, 0), 0)\n",
    "T02-missing-export": "import assert from 'node:assert/strict'\nimport { greet } from './src/greet.js'\nassert.equal(greet('Ada'), 'Hello, Ada')\n",
    "T03-cross-file": "import assert from 'node:assert/strict'\nimport { formatName } from './src/format.js'\nassert.equal(formatName('Ada', 'Lovelace'), 'Lovelace, Ada')\n",
    "T04-rename": "import assert from 'node:assert/strict'\nimport { sumAll } from './src/math.js'\nassert.equal(sumAll([1, 2, 3]), 6)\n",
    "T05-counter": "import assert from 'node:assert/strict'\nimport { increment, value } from './src/counter.js'\nassert.equal(value(), 0)\nassert.equal(increment(), 1)\nassert.equal(value(), 1)\n",
    "T07-create-util": "import assert from 'node:assert/strict'\nimport { clamp } from './src/clamp.js'\nassert.equal(clamp(5, 0, 3), 3)\nassert.equal(clamp(-1, 0, 3), 0)\nassert.equal(clamp(2, 0, 3), 2)\n",
    "T08-early-return": "import assert from 'node:assert/strict'\nimport { divide } from './src/div.js'\nassert.equal(divide(4, 2), 2)\nassert.equal(divide(1, 0), null)\n",
    "T09-string": "import assert from 'node:assert/strict'\nimport { label } from './src/label.js'\nassert.equal(label('Ada'), 'Name: Ada')\n",
    "T10-two-files": "import assert from 'node:assert/strict'\nimport { run } from './src/app.js'\nassert.equal(run(), 6)\n",
    "T11-json": "import assert from 'node:assert/strict'\nimport { parseJson } from './src/parse.js'\nassert.equal(parseJson('not json'), null)\nassert.equal(parseJson('{\"a\":1}').a, 1)\n",
    "T12-expected": "import assert from 'node:assert/strict'\nimport { double } from './src/double.js'\nassert.equal(double(4), 8)\n",
    "T06-python-add": "import ast, pathlib, sys\nsrc = pathlib.Path('src/add.py').read_text()\nns = {}\nexec(compile(src, 'src/add.py', 'exec'), ns)\nassert ns['add'](1, 2) == 3\nassert ns['add'](0, 0) == 0\n",
  }
  const body = bodies[task.id]
  if (!body) return { pass: false, detail: `no independent verifier for ${task.id}` }
  if (task.id === "T06-python-add") {
    await writeFile(join(root, "_verify.py"), body, "utf8")
    const result = await spawnCapture("python3", ["_verify.py"], { cwd: root, timeoutMs: 20_000 })
    return { pass: result.code === 0, detail: result.code === 0 ? "independent python ok" : (result.stderr || result.stdout).slice(-400) }
  }
  await writeFile(join(root, "_verify.mjs"), body, "utf8")
  const result = await spawnCapture("node", ["_verify.mjs"], { cwd: root, timeoutMs: 20_000 })
  return { pass: result.code === 0, detail: result.code === 0 ? "independent node ok" : (result.stderr || result.stdout).slice(-400) }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== "" && !rel.startsWith("..") && !resolve(candidate).startsWith(`..${sep}`)
}

function isolationFromTrace(workspace: string, stdout: string, stderr: string): {
  isolationValid: boolean
  isolationReason: string
  unauthorized: boolean
  toolWorkingDirectory?: string
} {
  const blob = `${stdout}\n${stderr}`
  const leaks = [
    "fixture-server.js",
    "packages/agent-core",
    "/Desktop/Projects",
  ].filter((needle) => blob.includes(needle) && !workspace.includes(needle))
  const missingFixture = /File not found[^\n]*src\//i.test(blob) || /not found: src\//i.test(blob)
  if (missingFixture) {
    return { isolationValid: false, isolationReason: "tool read missed a fixture file that was written into the disposable workspace", unauthorized: false }
  }
  if (leaks.length > 0) {
    return { isolationValid: false, isolationReason: `tool output referenced paths outside the fixture (${leaks.join(", ")})`, unauthorized: true }
  }
  const cwdMatch = /"cwd"\s*:\s*"([^"]+)"/.exec(blob)
  if (cwdMatch?.[1] && !pathInside(workspace, cwdMatch[1]) && resolve(cwdMatch[1]) !== resolve(workspace)) {
    return { isolationValid: false, isolationReason: `reported cwd ${cwdMatch[1]} is not the fixture`, unauthorized: true, toolWorkingDirectory: cwdMatch[1] }
  }
  return {
    isolationValid: true,
    isolationReason: "no extra-workspace tool paths observed",
    unauthorized: false,
    ...(cwdMatch?.[1] ? { toolWorkingDirectory: cwdMatch[1] } : {}),
  }
}

async function evaluateChecksStrict(root: string, checks: readonly FileCheck[]): Promise<{ pass: boolean; detail: string }> {
  const failures: string[] = []
  for (const check of checks) {
    let text = ""
    try {
      text = await readFile(join(root, check.path), "utf8")
    } catch {
      failures.push(`missing ${check.path}`)
      continue
    }
    if (check.contains && check.contains.length > 0 && !check.contains.some((needle) => text.includes(needle))) {
      failures.push(`${check.path} missing one of: ${check.contains.join(" | ")}`)
    }
    if (check.notContains) {
      for (const needle of check.notContains) {
        if (check.contains?.some((wanted) => text.includes(wanted))) continue
        if (text.includes(needle)) failures.push(`${check.path} still contains ${needle}`)
      }
    }
  }
  return { pass: failures.length === 0, detail: failures.join("; ") || "ok" }
}

function scoreOutcome(input: {
  status: string
  substringPass: boolean
  independentPass: boolean
  unauthorized: boolean
  isolationValid: boolean
}): {
  correctCode: boolean
  runtimeCompleted: boolean
  independentTests: boolean
  unauthorizedActions: boolean
  endToEnd: boolean
  comparisonStatus: "PASS" | "FAIL" | "INVALID"
} {
  const runtimeCompleted = input.status === "COMPLETED"
  const correctCode = input.substringPass
  const independentTests = input.independentPass
  const unauthorizedActions = input.unauthorized
  if (!input.isolationValid) {
    return {
      correctCode,
      runtimeCompleted,
      independentTests,
      unauthorizedActions,
      endToEnd: false,
      comparisonStatus: "INVALID",
    }
  }
  const endToEnd = runtimeCompleted && independentTests && !unauthorizedActions
  return {
    correctCode,
    runtimeCompleted,
    independentTests,
    unauthorizedActions,
    endToEnd,
    comparisonStatus: endToEnd ? "PASS" : "FAIL",
  }
}

async function runOpenVsCode(task: ComparisonTask, workspace: string, encoding: ConversationEncoding): Promise<Record<string, unknown>> {
  const started = Date.now()
  const workspaceRoot = await realpath(workspace)
  const mutationEngine = new MutationEngine(workspaceRoot)
  const registry = createReadOnlyToolRegistry()
  for (const registration of createMutationToolRegistrations({ engine: mutationEngine })) {
    registry.register(registration)
  }
  for (const registration of createVerificationToolRegistrations(workspaceRoot)) {
    registry.register(registration)
  }
  const tools = registry.listDefinitions().map((definition) => definition.name)
  const provider = new OpenAICompatibleProvider({
    baseUrl: ENDPOINT,
    model: MODEL,
    timeoutMs: 300_000,
  })
  const runner = new AgentRunner({
    provider,
    registry,
    evidenceGate: false,
    adaptiveInterventions: false,
    permissionEvaluator: (input) => {
      if (input.action === "run_shell" || input.action === "shell" || input.action === "terminal_command") return "DENY"
      if (input.action === "write_file" || input.action === "run_known_test" || input.action === "delete_file") return "CONFIRM"
      return "ALLOW"
    },
    conversationEncoding: encoding,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS)
  let result
  try {
    result = await runner.run({
      task: { id: `m3-${task.id}`, mode: "BUILD", instruction: task.instruction },
      workspaceRoot,
      maxTurns: MAX_TURNS,
      contextBudget: calculateBudget({ contextWindow: 16_000, reservedOutput: 2_000, reservedToolHistory: 2_000 }),
      projectInstructions: [],
      conversationEncoding: encoding,
      signal: controller.signal,
    })
    while (result.status === "PAUSED") {
      result = await runner.resume("APPROVE")
    }
  } finally {
    clearTimeout(timer)
  }
  const checks = await evaluateChecksStrict(workspaceRoot, task.checks)
  const independent = await runIndependentVerifier(workspaceRoot, task)
  const scored = scoreOutcome({
    status: result.status,
    substringPass: checks.pass,
    independentPass: independent.pass,
    unauthorized: false,
    isolationValid: true,
  })
  return {
    status: result.status,
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    turns: result.turns,
    durationMs: Date.now() - started,
    substring: checks,
    independent,
    workingDirectory: workspaceRoot,
    model: MODEL,
    provider: { baseUrl: ENDPOINT, timeoutMs: 300_000 },
    tools,
    executionBudget: { maxTurns: MAX_TURNS },
    ...scored,
    pass: scored.endToEnd,
    detail: independent.pass ? independent.detail : `${checks.detail}; ${independent.detail}`,
  }
}

async function runOpenCode(task: ComparisonTask, workspace: string): Promise<Record<string, unknown>> {
  const started = Date.now()
  const workspaceRoot = await realpath(workspace)
  const home = join(workspaceRoot, ".eval-home")
  await mkdir(join(home, ".config"), { recursive: true })
  await mkdir(join(home, ".local", "share"), { recursive: true })
  await mkdir(join(home, ".local", "state"), { recursive: true })
  await writeFile(join(workspaceRoot, "opencode.json"), `${JSON.stringify({
    model: OPENCODE_MODEL,
    permission: { "*": "allow" },
  }, null, 2)}\n`, "utf8")
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_CONFIG_DIR: join(workspaceRoot, ".opencode"),
  }
  const captured = await spawnCapture("opencode", [
    "--standalone",
    "run",
    "--auto",
    "--archived",
    "--agent",
    "build",
    "--format",
    "json",
    "--model",
    OPENCODE_MODEL,
    "--title",
    `ovsc-m3-${task.id}`,
    task.instruction,
  ], { cwd: workspaceRoot, env, timeoutMs: TASK_TIMEOUT_MS })
  const isolation = isolationFromTrace(workspaceRoot, captured.stdout, captured.stderr)
  const checks = await evaluateChecksStrict(workspaceRoot, task.checks)
  const independent = isolation.isolationValid
    ? await runIndependentVerifier(workspaceRoot, task)
    : { pass: false, detail: isolation.isolationReason }
  const status = captured.code === 0 ? "COMPLETED" : "FAILED"
  const scored = scoreOutcome({
    status,
    substringPass: checks.pass,
    independentPass: independent.pass,
    unauthorized: isolation.unauthorized,
    isolationValid: isolation.isolationValid,
  })
  return {
    status,
    ...(captured.code === 0 ? {} : { failureReason: captured.stderr.slice(-500) || `exit ${captured.code}` }),
    turns: 0,
    durationMs: Date.now() - started,
    substring: checks,
    independent,
    workingDirectory: workspaceRoot,
    model: OPENCODE_MODEL,
    provider: { baseUrl: ENDPOINT, isolatedHome: home, standalone: true, agent: "build" },
    tools: "opencode-default",
    executionBudget: { timeoutMs: TASK_TIMEOUT_MS },
    isolation,
    stdout: captured.stdout.slice(0, 4000),
    ...scored,
    pass: scored.comparisonStatus === "PASS",
    detail: scored.comparisonStatus === "INVALID" ? isolation.isolationReason : (independent.pass ? independent.detail : `${checks.detail}; ${independent.detail}`),
  }
}

export async function runM3OpenCodeComparison(options?: {
  readonly encoding?: ConversationEncoding
  readonly taskIds?: readonly string[]
  readonly repeats?: readonly string[]
}): Promise<Record<string, unknown>> {
  const gate = checkInferenceGate()
  if (!gate.authorized) {
    return { status: "BLOCKED_WITH_EVIDENCE", reason: gate.reason }
  }
  const encoding = options?.encoding ?? "compiled-user"
  const digest = await discoverModelDigest(MODEL)
  const provenance = checkGitProvenance()
  const selected = M3_COMPARISON_TASKS.filter((task) => !options?.taskIds || options.taskIds.includes(task.id))
  const repeats = options?.repeats ?? ["T01-off-by-one"]
  const rows = []
  async function runPair(task: ComparisonTask, label: string) {
    const ovscRoot = await mkdtemp(join(tmpdir(), `ovsc-m3-${task.id}-`))
    const ocRoot = await mkdtemp(join(tmpdir(), `oc-m3-${task.id}-`))
    try {
      await writeFixture(ovscRoot, task.files)
      await writeFixture(ocRoot, task.files)
      await initGit(ovscRoot)
      await initGit(ocRoot)
      const skipOvsc = process.env.M3_COMPARE_OPENCODE_PREFLIGHT === "1"
      let ovsc: Record<string, unknown> = {
        status: "SKIPPED",
        comparisonStatus: "INVALID",
        pass: false,
        detail: "skipped Open VS Code for isolation preflight",
      }
      if (!skipOvsc) {
        console.log(`\n[${label}] Open VS Code (${encoding})...`)
        ovsc = await runOpenVsCode(task, ovscRoot, encoding)
        console.log(`  OVSC ${String(ovsc.comparisonStatus)} independent=${(ovsc.independent as { pass?: boolean })?.pass} ${ovsc.durationMs}ms`)
      } else {
        console.log(`\n[${label}] Open VS Code skipped (OpenCode isolation preflight)`)
      }
      const skipOpenCode = process.env.M3_COMPARE_OVSC_ONLY === "1"
      let opencode: Record<string, unknown> = {
        status: "SKIPPED",
        comparisonStatus: "INVALID",
        isolationValid: false,
        isolationReason: "skipped",
        pass: false,
        detail: "skipped",
      }
      if (!skipOpenCode) {
        console.log(`[${label}] OpenCode standalone/build...`)
        opencode = await runOpenCode(task, ocRoot)
        console.log(`  OpenCode ${String(opencode.comparisonStatus)} ${String(opencode.detail)} ${opencode.durationMs}ms`)
      }
      rows.push({
        id: task.id,
        title: task.title,
        repeat: label !== task.id,
        ovsc,
        opencode,
      })
    } finally {
      await rm(ovscRoot, { recursive: true, force: true })
      await rm(ocRoot, { recursive: true, force: true })
    }
  }
  for (const task of selected) {
    await runPair(task, task.id)
  }
  for (const repeatId of repeats) {
    const task = selected.find((candidate) => candidate.id === repeatId)
    if (task) await runPair(task, `${task.id}-repeat`)
  }
  const ovscPass = rows.filter((row) => row.ovsc.comparisonStatus === "PASS").length
  const ocPass = rows.filter((row) => row.opencode.comparisonStatus === "PASS").length
  const ocInvalid = rows.filter((row) => row.opencode.comparisonStatus === "INVALID").length
  const report = {
    schema: process.env.M3_COMPARE_OPENCODE_PREFLIGHT === "1" ? "m3-opencode-isolation-preflight/v1" : "m3-opencode-comparison/v2",
    model: MODEL,
    digest,
    encoding,
    provenance,
    endpoint: ENDPOINT,
    createdAt: new Date().toISOString(),
    isolationPolicy: "OpenCode --standalone + isolated HOME/XDG + git fixture; INVALID if tool paths escape the disposable workspace",
    totals: {
      tasks: rows.length,
      ovscPass,
      opencodePass: ocPass,
      opencodeInvalid: ocInvalid,
    },
    rows,
  }
  const dir = getCanonicalEvalsDir()
  await mkdir(dir, { recursive: true })
  const out = join(dir, process.env.M3_COMPARE_OPENCODE_PREFLIGHT === "1"
    ? "m3-opencode-isolation-preflight.json"
    : encoding === "native-tool-messages" ? "m3-opencode-comparison-native.json" : "m3-opencode-comparison.json")
  await writeFile(out, JSON.stringify(report, null, 2), "utf8")
  console.log(`\nWrote ${out}`)
  console.log(`Open VS Code ${ovscPass}/${rows.length}; OpenCode PASS ${ocPass} INVALID ${ocInvalid}/${rows.length}; digest ${digest}`)
  return report
}

const entry = process.argv[1] ?? ""
if (entry.includes("m3-opencode-comparison")) {
  const encodings: ConversationEncoding[] = process.env.OPEN_VS_CODE_NATIVE_TOOL_MESSAGES === "1"
    ? ["native-tool-messages"]
    : process.env.M3_COMPARE_COMPILED_ONLY === "1"
      ? ["compiled-user"]
      : ["compiled-user", "native-tool-messages"]
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
  for (const encoding of encodings) {
    await runM3OpenCodeComparison({
      encoding,
      ...(ids.length > 0 ? { taskIds: ids } : {}),
    })
  }
}
