/**
 * Sprint 20 live Qwen3-Coder file-editing evaluation.
 * Gated by OPEN_VS_CODE_REAL_INFERENCE=1. Disposable Git fixtures only.
 */
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { calculateBudget } from "../../src/context/budget.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { checkInferenceGate } from "../../src/model/inference-gate.ts"
import { AgentRunner } from "../../src/agent/runner.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { createVerificationToolRegistrations } from "../../src/tools/verification-registry.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { getCanonicalEvalsDir } from "./real-model-benchmark.ts"

const MODEL = "qwen3-coder:30b"
const ENDPOINT = process.env.OPEN_VS_CODE_MODEL_ENDPOINT ?? "http://127.0.0.1:11434/v1"
const TASK_TIMEOUT_MS = 10 * 60 * 1000
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..")

interface LiveCase {
  readonly id: string
  readonly instruction: string
  readonly files: Record<string, string>
  readonly maxTurns: number
  readonly continueOnce?: boolean
  readonly verify: (root: string) => Promise<{ pass: boolean; detail: string }>
  readonly unchanged?: readonly string[]
}

async function spawnCapture(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { cwd: options.cwd })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 20_000)
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

async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content, "utf8")
  }
}

async function initGit(root: string): Promise<void> {
  await spawnCapture("git", ["init"], { cwd: root })
  await spawnCapture("git", ["add", "-A"], { cwd: root })
  await spawnCapture("git", ["-c", "user.email=eval@open-vs-code.local", "-c", "user.name=Open VS Code Eval", "commit", "-m", "fixture", "--allow-empty"], { cwd: root })
}

async function nodeVerify(root: string, body: string): Promise<{ pass: boolean; detail: string }> {
  await writeFile(join(root, "_verify.mjs"), body, "utf8")
  const result = await spawnCapture("node", ["--experimental-strip-types", "_verify.mjs"], { cwd: root })
  return { pass: result.code === 0, detail: result.code === 0 ? "independent node ok" : (result.stderr || result.stdout).slice(-500) }
}

const CASES: readonly LiveCase[] = [
  {
    id: "A-existing-file-edit",
    instruction: "Fix src/add.ts so add(left, right) returns the sum. Use apply_patch. Do not change the test. Run the tests.",
    files: {
      "src/add.ts": "export function add(left: number, right: number) {\n  return left - right\n}\n",
      "test/add.test.mjs": "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { add } from '../src/add.ts'\ntest('add', () => assert.equal(add(1, 2), 3))\n",
    },
    maxTurns: 12,
    verify: (root) => nodeVerify(root, "import assert from 'node:assert/strict'\nimport { add } from './src/add.ts'\nassert.equal(add(1, 2), 3)\nassert.equal(add(0, 0), 0)\n"),
    unchanged: ["test/add.test.mjs"],
  },
  {
    id: "B-wrong-tool-create",
    instruction: "src/add.ts is the implementation file. Create src/add.ts so add(left, right) returns left + right. Do not change the test.",
    files: {
      "src/add.ts": "export function add(left: number, right: number) {\n  return left - right\n}\n",
      "test/add.test.mjs": "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { add } from '../src/add.ts'\ntest('add', () => assert.equal(add(2, 2), 4))\n",
    },
    maxTurns: 12,
    verify: (root) => nodeVerify(root, "import assert from 'node:assert/strict'\nimport { add } from './src/add.ts'\nassert.equal(add(2, 2), 4)\n"),
    unchanged: ["test/add.test.mjs"],
  },
  {
    id: "D-held-ts",
    instruction: "Fix src/score.ts and src/bonus.ts so the tests pass. totalScore is base plus bonusPoints. bonusPoints is 5 when flagged otherwise 0. Do not change the test.",
    files: {
      "src/score.ts": "import { bonusPoints } from './bonus.ts'\nexport function totalScore(base: number, flagged: boolean): number {\n  return base\n}\n",
      "src/bonus.ts": "export function bonusPoints(flagged: boolean): number {\n  return flagged ? 1 : 1\n}\n",
      "test/score.test.ts": "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { totalScore } from '../src/score.ts'\nimport { bonusPoints } from '../src/bonus.ts'\ntest('bonus', () => assert.equal(bonusPoints(true), 5))\ntest('total', () => assert.equal(totalScore(10, true), 15))\n",
    },
    maxTurns: 12,
    verify: async (root) => {
      const result = await spawnCapture("node", ["--experimental-strip-types", "--test"], { cwd: root, timeoutMs: 20_000 })
      return { pass: result.code === 0, detail: result.code === 0 ? "independent ts tests ok" : (result.stderr || result.stdout).slice(-500) }
    },
    unchanged: ["test/score.test.ts"],
  },
  {
    id: "D-held-py",
    instruction: "Fix src/median.py so median of a numeric list returns the middle value for odd length and the average of the two middle values for even length. Do not change the test.",
    files: {
      "src/median.py": "def median(values):\n    return values[0]\n",
      "test/test_median.py": "import unittest\nfrom src.median import median\nclass MedianTest(unittest.TestCase):\n    def test_odd(self):\n        self.assertEqual(median([1, 3, 2]), 2)\n    def test_even(self):\n        self.assertEqual(median([1, 2, 3, 4]), 2.5)\n",
      "src/__init__.py": "",
      "test/__init__.py": "",
    },
    maxTurns: 12,
    verify: async (root) => {
      const result = await spawnCapture("python3", ["-m", "unittest", "test.test_median"], { cwd: root, timeoutMs: 20_000 })
      return { pass: result.code === 0, detail: result.code === 0 ? "independent python ok" : (result.stderr || result.stdout).slice(-500) }
    },
    unchanged: ["test/test_median.py"],
  },
]

async function continueLibCase(): Promise<LiveCase> {
  const fixture = join(REPO_ROOT, "apps/desktop/acceptance/fixtures/continue-lib")
  const format = await readFile(join(fixture, "src/format.ts"), "utf8")
  const greet = await readFile(join(fixture, "src/greet.ts"), "utf8")
  const parse = await readFile(join(fixture, "src/parse.ts"), "utf8")
  const testFile = await readFile(join(fixture, "test/lib.test.ts"), "utf8")
  return {
    id: "C-three-file",
    instruction: "Implement formatName, greet, and parseName so test/lib.test.ts passes. formatName must return Last, First. greet must return Hello, plus formatName. parseName must split Last, First. Use apply_patch. Do not change the test. Run node --experimental-strip-types --test after the last edit.",
    files: {
      "src/format.ts": format,
      "src/greet.ts": greet,
      "src/parse.ts": parse,
      "test/lib.test.ts": testFile,
    },
    maxTurns: 15,
    continueOnce: true,
    verify: async (root) => {
      const result = await spawnCapture("node", ["--experimental-strip-types", "--test"], { cwd: root, timeoutMs: 20_000 })
      return { pass: result.code === 0, detail: result.code === 0 ? "independent three-file tests ok" : (result.stderr || result.stdout).slice(-800) }
    },
    unchanged: ["test/lib.test.ts"],
  }
}

async function runCase(task: LiveCase): Promise<Record<string, unknown>> {
  const started = Date.now()
  const workspace = await mkdtemp(join(tmpdir(), `ovsc-s20-${task.id}-`))
  await writeFixture(workspace, task.files)
  await initGit(workspace)
  const workspaceRoot = await realpath(workspace)
  const before = Object.fromEntries(await Promise.all((task.unchanged ?? []).map(async (path) => [path, await readFile(join(workspaceRoot, path), "utf8")])))
  const mutationEngine = new MutationEngine(workspaceRoot)
  const registry = createReadOnlyToolRegistry()
  for (const registration of createMutationToolRegistrations({ engine: mutationEngine })) registry.register(registration)
  for (const registration of createVerificationToolRegistrations(workspaceRoot)) registry.register(registration)
  const provider = new OpenAICompatibleProvider({ baseUrl: ENDPOINT, model: MODEL, timeoutMs: 300_000 })
  const runner = new AgentRunner({
    provider,
    registry,
    evidenceGate: false,
    adaptiveInterventions: false,
    permissionEvaluator: (input) => {
      if (input.action === "write_file" || input.action === "run_known_test" || input.action === "delete_file") return "CONFIRM"
      return "ALLOW"
    },
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS)
  let result
  const createAttempts: string[] = []
  try {
    result = await runner.run({
      task: { id: `s20-${task.id}`, mode: "BUILD", instruction: task.instruction },
      workspaceRoot,
      maxTurns: task.maxTurns,
      contextBudget: calculateBudget({ contextWindow: 16_000, reservedOutput: 2_000, reservedToolHistory: 2_000 }),
      projectInstructions: [],
      signal: controller.signal,
    })
    let continues = 0
    while (true) {
      if (result.status === "PAUSED") {
        result = await runner.resume("APPROVE")
        continue
      }
      if (task.continueOnce && result.failureReason === "MAX_TURNS_EXCEEDED" && continues === 0) {
        continues += 1
        result = await runner.continueFromLimit(8)
        continue
      }
      break
    }
  } finally {
    clearTimeout(timer)
  }
  for (const call of result.toolCalls) {
    if (call.name === "create_file") createAttempts.push(`${call.outcome}`)
  }
  const independent = await task.verify(workspaceRoot)
  const unchangedOk = await Promise.all((task.unchanged ?? []).map(async (path) => (await readFile(join(workspaceRoot, path), "utf8")) === before[path]))
  const files = Object.fromEntries(await Promise.all(Object.keys(task.files).map(async (path) => {
    try {
      return [path, await readFile(join(workspaceRoot, path), "utf8")]
    } catch {
      return [path, null]
    }
  })))
  const pass = independent.pass && unchangedOk.every(Boolean)
  await rm(workspace, { recursive: true, force: true })
  return {
    id: task.id,
    status: result.status,
    failureReason: result.failureReason,
    turns: result.turns,
    durationMs: Date.now() - started,
    independent,
    unchangedPreserved: unchangedOk.every(Boolean),
    createAttempts,
    toolCalls: result.toolCalls.map((call) => ({ name: call.name, outcome: call.outcome })),
    files,
    pass,
    truthfulCompletion: result.status !== "COMPLETED" || independent.pass,
  }
}

export async function runSprint20LiveEditing(options?: { ids?: readonly string[]; threeFileRepeats?: number }): Promise<Record<string, unknown>> {
  const gate = checkInferenceGate()
  if (!gate.authorized) return { status: "BLOCKED_WITH_EVIDENCE", reason: gate.reason }
  const threeFile = await continueLibCase()
  const selected = [...CASES, threeFile].filter((task) => !options?.ids || options.ids.includes(task.id) || (task.id === "C-three-file" && options.ids.includes("C-three-file")))
  const rows: Record<string, unknown>[] = []
  for (const task of selected) {
    const repeats = task.id === "C-three-file" ? (options?.threeFileRepeats ?? 3) : 1
    for (let i = 0; i < repeats; i += 1) {
      console.log(`Running ${task.id} (${i + 1}/${repeats})`)
      const row = await runCase(task)
      rows.push({ ...row, repeat: i + 1 })
      console.log(`${task.id} repeat ${i + 1}: ${row.pass ? "PASS" : "FAIL"} status=${row.status} independent=${(row.independent as { pass: boolean }).pass}`)
    }
  }
  const three = rows.filter((row) => row.id === "C-three-file")
  const report = {
    model: MODEL,
    endpoint: ENDPOINT,
    generatedAt: new Date().toISOString(),
    threeFile: { total: three.length, pass: three.filter((row) => row.pass === true).length },
    rows,
  }
  const out = join(getCanonicalEvalsDir(), "sprint-20-live-editing.json")
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify(report, null, 2), "utf8")
  console.log(`Wrote ${out}`)
  return report
}

const entry = process.argv[1] ?? ""
if (entry.includes("sprint-20-live-editing")) {
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
  await runSprint20LiveEditing(ids.length > 0 ? { ids } : undefined)
}
