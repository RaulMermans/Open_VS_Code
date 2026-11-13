/**
 * Milestone 3 same-digest live coding comparison: Open VS Code AgentRunner vs OpenCode CLI.
 * Gated by OPEN_VS_CODE_REAL_INFERENCE=1. Disposable fixtures only.
 */
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

async function runOpenVsCode(task: ComparisonTask, workspace: string, encoding: ConversationEncoding): Promise<{
  status: string
  failureReason?: string
  turns: number
  durationMs: number
  pass: boolean
  detail: string
}> {
  const started = Date.now()
  const mutationEngine = new MutationEngine(workspace)
  const registry = createReadOnlyToolRegistry()
  for (const registration of createMutationToolRegistrations({ engine: mutationEngine })) {
    registry.register(registration)
  }
  for (const registration of createVerificationToolRegistrations(workspace)) {
    registry.register(registration)
  }
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
      workspaceRoot: workspace,
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
  const checks = await evaluateChecksStrict(workspace, task.checks)
  return {
    status: result.status,
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    turns: result.turns,
    durationMs: Date.now() - started,
    pass: checks.pass,
    detail: checks.detail,
  }
}

function runOpenCode(task: ComparisonTask, workspace: string): Promise<{
  status: string
  failureReason?: string
  turns: number
  durationMs: number
  pass: boolean
  detail: string
  stdout: string
}> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn("opencode", [
      "run",
      "--auto",
      "--archived",
      "--format",
      "json",
      "--model",
      OPENCODE_MODEL,
      "--title",
      `ovsc-m3-${task.id}`,
      task.instruction,
    ], { cwd: workspace, env: { ...process.env } })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
    }, TASK_TIMEOUT_MS)
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("close", async (code) => {
      clearTimeout(timer)
      const checks = await evaluateChecksStrict(workspace, task.checks)
      resolve({
        status: code === 0 ? "COMPLETED" : "FAILED",
        ...(code === 0 ? {} : { failureReason: stderr.slice(-500) || `exit ${code}` }),
        turns: 0,
        durationMs: Date.now() - started,
        pass: checks.pass,
        detail: checks.detail,
        stdout: stdout.slice(0, 4000),
      })
    })
    child.on("error", async (error) => {
      clearTimeout(timer)
      const checks = await evaluateChecksStrict(workspace, task.checks)
      resolve({
        status: "FAILED",
        failureReason: error instanceof Error ? error.message : String(error),
        turns: 0,
        durationMs: Date.now() - started,
        pass: checks.pass,
        detail: checks.detail,
        stdout: "",
      })
    })
  })
}

export async function runM3OpenCodeComparison(options?: {
  readonly encoding?: ConversationEncoding
  readonly taskIds?: readonly string[]
}): Promise<Record<string, unknown>> {
  const gate = checkInferenceGate()
  if (!gate.authorized) {
    return { status: "BLOCKED_WITH_EVIDENCE", reason: gate.reason }
  }
  const encoding = options?.encoding ?? "compiled-user"
  const digest = await discoverModelDigest(MODEL)
  const provenance = checkGitProvenance()
  const selected = M3_COMPARISON_TASKS.filter((task) => !options?.taskIds || options.taskIds.includes(task.id))
  const rows = []
  for (const task of selected) {
    const ovscRoot = await mkdtemp(join(tmpdir(), `ovsc-m3-${task.id}-`))
    const ocRoot = await mkdtemp(join(tmpdir(), `oc-m3-${task.id}-`))
    try {
      await writeFixture(ovscRoot, task.files)
      await writeFixture(ocRoot, task.files)
      console.log(`\n[${task.id}] Open VS Code (${encoding})...`)
      const ovsc = await runOpenVsCode(task, ovscRoot, encoding)
      console.log(`  OVSC pass=${ovsc.pass} status=${ovsc.status} ${ovsc.detail} ${ovsc.durationMs}ms`)
      const skipOpenCode = process.env.M3_COMPARE_OVSC_ONLY === "1"
      let opencode = {
        status: "SKIPPED",
        turns: 0,
        durationMs: 0,
        pass: false,
        detail: "skipped",
        stdout: "",
      }
      if (!skipOpenCode) {
        console.log(`[${task.id}] OpenCode...`)
        opencode = await runOpenCode(task, ocRoot)
        console.log(`  OpenCode pass=${opencode.pass} status=${opencode.status} ${opencode.detail} ${opencode.durationMs}ms`)
      }
      rows.push({
        id: task.id,
        title: task.title,
        ovsc,
        opencode,
      })
    } finally {
      await rm(ovscRoot, { recursive: true, force: true })
      await rm(ocRoot, { recursive: true, force: true })
    }
  }
  const ovscPass = rows.filter((row) => row.ovsc.pass).length
  const ocPass = rows.filter((row) => row.opencode.pass).length
  const report = {
    schema: "m3-opencode-comparison/v1",
    model: MODEL,
    digest,
    encoding,
    provenance,
    endpoint: ENDPOINT,
    createdAt: new Date().toISOString(),
    totals: { tasks: rows.length, ovscPass, opencodePass: ocPass },
    rows,
  }
  const dir = getCanonicalEvalsDir()
  await mkdir(dir, { recursive: true })
  const out = join(dir, encoding === "native-tool-messages" ? "m3-opencode-comparison-native.json" : "m3-opencode-comparison.json")
  await writeFile(out, JSON.stringify(report, null, 2), "utf8")
  console.log(`\nWrote ${out}`)
  console.log(`Open VS Code ${ovscPass}/${rows.length}; OpenCode ${ocPass}/${rows.length}; digest ${digest}`)
  return report
}

const entry = process.argv[1] ?? ""
if (entry.includes("m3-opencode-comparison")) {
  const encoding = process.env.OPEN_VS_CODE_NATIVE_TOOL_MESSAGES === "1" ? "native-tool-messages" : "compiled-user"
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
  await runM3OpenCodeComparison({
    encoding,
    ...(ids.length > 0 ? { taskIds: ids } : {}),
  })
}
