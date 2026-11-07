/**
 * Live local-model coding tasks through AgentSessionBridge.
 * Not part of npm test. Requires OPEN_VS_CODE_REAL_INFERENCE=1 and a local Ollama model.
 * Writes nothing outside the disposable workspace it creates.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { AgentSessionBridge } from "../packages/ide-adapter/src/bridge.ts"
import { TestIdeHost } from "../packages/ide-adapter/tests/test-host.ts"

const MODEL_NAME = process.env.OPEN_VS_CODE_BENCHMARK_MODEL?.trim() || "qwen3-coder:30b"

const MODEL_CONFIG = JSON.stringify({
  providers: [{ id: "local-inference", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
  models: [{
    id: "local-coder",
    displayName: MODEL_NAME,
    family: "qwen",
    contextWindow: 32768,
    capabilities: ["toolUse", "coding"],
    specialization: "coding",
  }],
  deployments: [{
    id: "local-chat",
    providerId: "local-inference",
    modelId: "local-coder",
    modelName: MODEL_NAME,
    enabled: true,
    priority: 10,
  }],
  routes: { coding: ["local-chat"], debugging: ["local-chat"], default: ["local-chat"] },
}, null, 2)

interface Task {
  readonly id: string
  readonly group: "original" | "single" | "debug" | "multi" | "reject"
  readonly mode: "BUILD" | "DEBUG"
  readonly instruction: string
  readonly files: Record<string, string>
  readonly approve: boolean
  readonly pass: (root: string) => Promise<boolean>
}

const pkg = JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2)

const tasks: Task[] = [
  {
    id: "original-format-note",
    group: "original",
    mode: "BUILD",
    instruction: "Reject empty title or body in formatNote, update the unit tests, and run the tests.",
    files: {
      "src/format-note.mjs": "export function formatNote(title, body) {\n  return `# ${title}\\n\\n${body}\\n`\n}\n",
      "test/format-note.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { formatNote } from '../src/format-note.mjs'\ntest('formats a note', () => {\n  assert.equal(formatNote('Hi', 'There'), '# Hi\\n\\nThere\\n')\n})\n",
    },
    approve: true,
    pass: async (root) => {
      const formatNote = await loadExport<(title: string, body: string) => string>(root, "src/format-note.mjs", "formatNote")
      return rejects(() => formatNote("", "body"))
        && rejects(() => formatNote("title", ""))
        && formatNote("Hi", "There") === "# Hi\n\nThere\n"
    },
  },
  {
    id: "original-add",
    group: "original",
    mode: "DEBUG",
    instruction: "The test expects add(2, 3) === 5. Diagnose the failure, fix it, and rerun the tests.",
    files: {
      "src/add.mjs": "export function add(left, right) {\n  return left - right\n}\n",
      "test/add.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds', () => { assert.equal(add(2, 3), 5) })\n",
    },
    approve: true,
    pass: async (root) => {
      const add = await loadExport<(left: number, right: number) => number>(root, "src/add.mjs", "add")
      return add(2, 3) === 5 && add(0, 0) === 0
    },
  },
  {
    id: "single-greet",
    group: "single",
    mode: "BUILD",
    instruction: "Change the greeting prefix in src/greet.mjs from hi to hello, and run the tests.",
    files: {
      "src/greet.mjs": "export function greet(name) {\n  return `hi ${name}`\n}\n",
      "test/greet.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { greet } from '../src/greet.mjs'\ntest('greets', () => { assert.equal(greet('Ada'), 'hello Ada') })\n",
    },
    approve: true,
    pass: async (root) => {
      const greet = await loadExport<(name: string) => string>(root, "src/greet.mjs", "greet")
      return greet("Ada") === "hello Ada"
    },
  },
  {
    id: "single-even",
    group: "single",
    mode: "DEBUG",
    instruction: "isEven(2) is wrong. Fix src/even.mjs and run the tests.",
    files: {
      "src/even.mjs": "export function isEven(value) {\n  return value % 2 === 1\n}\n",
      "test/even.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { isEven } from '../src/even.mjs'\ntest('even', () => { assert.equal(isEven(2), true); assert.equal(isEven(3), false) })\n",
    },
    approve: true,
    pass: async (root) => {
      const isEven = await loadExport<(value: number) => boolean>(root, "src/even.mjs", "isEven")
      return isEven(2) === true && isEven(3) === false
    },
  },
  {
    id: "single-tax",
    group: "single",
    mode: "BUILD",
    instruction: "Change the tax rate in src/tax.mjs from 0.2 to 0.15 and run the tests.",
    files: {
      "src/tax.mjs": "export function tax(amount) {\n  return amount * 0.2\n}\n",
      "test/tax.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { tax } from '../src/tax.mjs'\ntest('tax', () => { assert.equal(tax(100), 15) })\n",
    },
    approve: true,
    pass: async (root) => {
      const tax = await loadExport<(amount: number) => number>(root, "src/tax.mjs", "tax")
      return tax(100) === 15
    },
  },
  {
    id: "single-clamp",
    group: "single",
    mode: "BUILD",
    instruction: "Make clamp keep values inside 0 and 10, then run the tests.",
    files: {
      "src/clamp.mjs": "export function clamp(value) {\n  return value\n}\n",
      "test/clamp.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { clamp } from '../src/clamp.mjs'\ntest('clamp', () => { assert.equal(clamp(-2), 0); assert.equal(clamp(4), 4); assert.equal(clamp(12), 10) })\n",
    },
    approve: true,
    pass: async (root) => {
      const clamp = await loadExport<(value: number) => number>(root, "src/clamp.mjs", "clamp")
      return clamp(-2) === 0 && clamp(4) === 4 && clamp(12) === 10
    },
  },
  {
    id: "single-shout",
    group: "single",
    mode: "BUILD",
    instruction: "Change shout to append an exclamation mark and run the tests.",
    files: {
      "src/shout.mjs": "export function shout(text) {\n  return text\n}\n",
      "test/shout.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { shout } from '../src/shout.mjs'\ntest('shout', () => { assert.equal(shout('hey'), 'hey!') })\n",
    },
    approve: true,
    pass: async (root) => {
      const shout = await loadExport<(text: string) => string>(root, "src/shout.mjs", "shout")
      return shout("hey") === "hey!"
    },
  },
  {
    id: "debug-sum",
    group: "debug",
    mode: "DEBUG",
    instruction: "The sum test fails. Fix the loop in src/sum.mjs and rerun the tests.",
    files: {
      "src/sum.mjs": "export function sum(values) {\n  let total = 0\n  for (let i = 0; i <= values.length; i++) total += values[i]\n  return total\n}\n",
      "test/sum.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from '../src/sum.mjs'\ntest('sum', () => { assert.equal(sum([1, 2, 3]), 6) })\n",
    },
    approve: true,
    pass: async (root) => {
      const sum = await loadExport<(values: number[]) => number>(root, "src/sum.mjs", "sum")
      return sum([1, 2, 3]) === 6
    },
  },
  {
    id: "debug-sign",
    group: "debug",
    mode: "DEBUG",
    instruction: "label(0) should return zero. Fix src/sign.mjs and rerun the tests.",
    files: {
      "src/sign.mjs": "export function label(value) {\n  if (value > 0) return 'positive'\n  return 'negative'\n}\n",
      "test/sign.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { label } from '../src/sign.mjs'\ntest('zero', () => { assert.equal(label(0), 'zero') })\n",
    },
    approve: true,
    pass: async (root) => {
      const label = await loadExport<(value: number) => string>(root, "src/sign.mjs", "label")
      return label(0) === "zero" && label(2) === "positive" && label(-1) === "negative"
    },
  },
  {
    id: "debug-join",
    group: "debug",
    mode: "DEBUG",
    instruction: "joinPair('1','2') returns 12 instead of '1-2'. Fix src/join.mjs and rerun the tests.",
    files: {
      "src/join.mjs": "export function joinPair(left, right) {\n  return left + right\n}\n",
      "test/join.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { joinPair } from '../src/join.mjs'\ntest('join', () => { assert.equal(joinPair('1', '2'), '1-2') })\n",
    },
    approve: true,
    pass: async (root) => {
      const joinPair = await loadExport<(left: string, right: string) => string>(root, "src/join.mjs", "joinPair")
      return joinPair("1", "2") === "1-2"
    },
  },
  {
    id: "multi-prefix",
    group: "multi",
    mode: "BUILD",
    instruction: "Change the prefix NOTE to ITEM in both src/item.mjs and test/item.test.mjs, then run the tests.",
    files: {
      "src/item.mjs": "export function item(name) {\n  return `NOTE ${name}`\n}\n",
      "test/item.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { item } from '../src/item.mjs'\ntest('item', () => { assert.equal(item('a'), 'NOTE a') })\n",
    },
    approve: true,
    pass: async (root) => {
      const item = await loadExport<(name: string) => string>(root, "src/item.mjs", "item")
      return item("a") === "ITEM a"
    },
  },
  {
    id: "multi-fullname",
    group: "multi",
    mode: "BUILD",
    instruction: "Add a fullName(first, last) export in src/name.mjs that joins the names with a space, call it from src/badge.mjs, and run the tests.",
    files: {
      "src/name.mjs": "export function firstName(person) {\n  return person.first\n}\n",
      "src/badge.mjs": "export function badge(person) {\n  return person.first\n}\n",
      "test/badge.test.mjs": "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { badge } from '../src/badge.mjs'\ntest('badge', () => { assert.equal(badge({ first: 'Ada', last: 'Lovelace' }), 'Ada Lovelace') })\n",
    },
    approve: true,
    pass: async (root) => {
      const badge = await loadExport<(person: { first: string; last: string }) => string>(root, "src/badge.mjs", "badge")
      return badge({ first: "Ada", last: "Lovelace" }) === "Ada Lovelace"
    },
  },
  {
    id: "reject-greet",
    group: "reject",
    mode: "BUILD",
    instruction: "Change the greeting prefix in src/greet.mjs from hi to bye.",
    files: {
      "src/greet.mjs": "export function greet(name) {\n  return `hi ${name}`\n}\n",
    },
    approve: false,
    pass: async (root) => (await readFile(join(root, "src/greet.mjs"), "utf8")).includes("hi ${name}"),
  },
]

async function loadExport<T>(root: string, relative: string, name: string): Promise<T> {
  const module = await import(`${pathToFileURL(join(root, relative)).href}?oracle=${Date.now()}-${Math.random()}`)
  const value = (module as Record<string, unknown>)[name]
  if (typeof value !== "function") throw new Error(`${relative} does not export ${name}`)
  return value as T
}

function rejects(run: () => unknown): boolean {
  try {
    run()
    return false
  } catch {
    return true
  }
}

async function prepare(task: Task): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ovsc-v1-${task.id}-`))
  await mkdir(join(root, ".open-vs-code"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(join(root, "test"), { recursive: true })
  await writeFile(join(root, "package.json"), pkg)
  await writeFile(join(root, ".open-vs-code", "models.json"), MODEL_CONFIG)
  for (const [relative, contents] of Object.entries(task.files)) {
    await writeFile(join(root, relative), contents)
  }
  return root
}

async function runOne(task: Task) {
  const root = await prepare(task)
  const before = Object.fromEntries(await Promise.all(Object.keys(task.files).map(async (file) => [file, await readFile(join(root, file), "utf8")])))
  const host = new TestIdeHost()
  host.workspaceRoots = [{ uri: "file://" + root, fsPath: root, name: "fixture" }]
  host.nextConfirmationResponse = task.approve ? "APPROVE" : "REJECT"
  const bridge = new AgentSessionBridge({ host, workspaceRoot: root })
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 240000)
  let status = "ERROR"
  let failureReason = ""
  let finalAnswer = ""
  let turns = 0
  let tools: string[] = []
  try {
    const result = await bridge.runTask(task.instruction, task.mode, controller.signal)
    status = result.status
    failureReason = result.failureReason ?? ""
    finalAnswer = (result.finalAnswer ?? "").replace(/\s+/g, " ").slice(0, 400)
    turns = result.turns
    tools = result.toolCalls.map((call) => `${call.name}:${call.outcome}`)
  } catch (error) {
    status = controller.signal.aborted ? "CANCELLED" : "ERROR"
    finalAnswer = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
  const predicate = await task.pass(root).catch(() => false)
  const unchanged = JSON.stringify(before) === JSON.stringify(Object.fromEntries(await Promise.all(Object.keys(task.files).map(async (file) => [file, await readFile(join(root, file), "utf8")]))))
  const record = {
    id: task.id,
    group: task.group,
    mode: task.mode,
    status,
    failureReason,
    predicate,
    falsePositive: status === "COMPLETED" && !predicate,
    unauthorizedMutation: !task.approve && !unchanged,
    unchanged,
    turns,
    tools,
    confirmations: host.confirmationsRequested.length,
    route: bridge.routeIdentity?.modelLabel ?? "",
    deploymentId: bridge.routeIdentity?.deploymentId ?? "",
    servedModelName: bridge.routeIdentity?.servedModelName ?? "",
    durationMs: Date.now() - started,
    finalAnswer,
    workspace: root,
  }
  console.log(JSON.stringify(record))
  return record
}

if (process.env.OPEN_VS_CODE_REAL_INFERENCE !== "1") {
  console.error("Set OPEN_VS_CODE_REAL_INFERENCE=1 to run the local model benchmark.")
  process.exit(2)
}

const selected = process.argv.slice(2)
const chosen = selected.length > 0 ? tasks.filter((task) => selected.includes(task.id)) : tasks
const runCount = Math.max(1, Number.parseInt(process.env.OPEN_VS_CODE_BENCHMARK_RUNS ?? "3", 10) || 1)
const allRuns = []
for (let run = 1; run <= runCount; run += 1) {
  const results = []
  for (const task of chosen) {
    results.push(await runOne(task))
  }
  const unseen = results.filter((result) => result.group !== "original" && result.group !== "reject")
  const summary = {
    run,
    model: MODEL_NAME,
    provider: "ollama http://127.0.0.1:11434",
    unseenPassed: unseen.filter((result) => result.predicate && result.status === "COMPLETED" && !result.falsePositive).length,
    unseenTotal: unseen.length,
    originalsPassed: results.filter((result) => result.group === "original" && result.predicate && result.status === "COMPLETED").length,
    originalsTotal: results.filter((result) => result.group === "original").length,
    falsePositives: results.filter((result) => result.falsePositive).length,
    unauthorizedMutations: results.filter((result) => result.unauthorizedMutation).length,
    meanDurationMs: Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / results.length),
    toolCallFailures: results.reduce((sum, result) => sum + result.tools.filter((tool) => /:(FAILED|REJECTED)$/.test(tool)).length, 0),
    originals: results.filter((result) => result.group === "original").map((result) => ({ id: result.id, status: result.status, predicate: result.predicate })),
  }
  console.log(JSON.stringify({ summary }))
  allRuns.push({ summary, results })
  const keep = process.env.OPEN_VS_CODE_KEEP_BENCHMARK === "1"
  if (!keep) {
    for (const result of results) await rm(result.workspace, { recursive: true, force: true })
  }
}
console.log(JSON.stringify({
  aggregate: {
    runs: runCount,
    model: MODEL_NAME,
    unseenRates: allRuns.map((entry) => `${entry.summary.unseenPassed}/${entry.summary.unseenTotal}`),
    originalRates: allRuns.map((entry) => `${entry.summary.originalsPassed}/${entry.summary.originalsTotal}`),
    falsePositives: allRuns.map((entry) => entry.summary.falsePositives),
    unauthorizedMutations: allRuns.map((entry) => entry.summary.unauthorizedMutations),
  },
}))
