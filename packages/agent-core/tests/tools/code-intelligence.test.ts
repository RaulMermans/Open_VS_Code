/**
 * Sprint 24: language-aware tools against the real TypeScript LanguageService (no mocked symbol
 * resolution). Fakes are used only where TypeScript cannot produce the condition (resource operations,
 * an unavailable provider).
 */
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { AgentRunner } from "../../src/agent/runner.ts"
import { handRenamedBinding, mutationToolGuidance } from "../../src/agent/tool-contract.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { applyTextEdits, createCodeIntelligenceToolRegistrations, type CodeIntelligenceProvider } from "../../src/tools/code-intelligence.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry, type ReviewableExecution, type ToolExecutionContext } from "../../src/tools/registry.ts"
import { TypeScriptCodeIntelligence } from "../../src/tools/typescript-code-intelligence.ts"

const LIB = {
  "src/totals.ts": "export function calcTotal(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0)\n}\n",
  "src/report.ts": "import { calcTotal } from \"./totals.ts\"\n\nexport function report(values: number[]): string {\n  return `total=${calcTotal(values)}`\n}\n",
  "src/average.ts": "import { calcTotal } from \"./totals.ts\"\n\nexport const average = (values: number[]) => (values.length ? calcTotal(values) / values.length : 0)\n",
  // Same name, unrelated: must never change.
  "src/legacy.ts": "function calcTotal(items: string[]): string {\n  return items.join(\"+\")\n}\nexport const legacy = calcTotal([\"a\"])\n",
  "src/index.ts": "export { calcTotal } from \"./totals.ts\"\n",
  "src/aliased.ts": "import { calcTotal as total } from \"./index.ts\"\n\nexport const twice = (values: number[]) => total(values) * 2\n",
}

async function workspace(files: Record<string, string>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ovsc-ci-")))
  const root = join(base, "ws")
  for (const [path, content] of Object.entries(files)) {
    const target = path.startsWith("../") ? join(base, path.slice(3)) : join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

function tools(root: string, provider: CodeIntelligenceProvider = new TypeScriptCodeIntelligence(root)) {
  const engine = new MutationEngine(root)
  const registry = new ToolRegistry(createCodeIntelligenceToolRegistrations(provider, engine))
  const context: ToolExecutionContext = { workspaceRoot: root, signal: new AbortController().signal }
  return {
    find: (args: Record<string, unknown>) => registry.prepare({ id: "f", name: "find_symbol", arguments: args }).invoke(context) as Promise<any>,
    rename: (args: Record<string, unknown>) => registry.prepare({ id: "r", name: "rename_symbol", arguments: args }).prepareForReview!(context) as Promise<ReviewableExecution>,
    context,
  }
}

const range = (a: number, b: number) => ({ start: { line: 0, character: a }, end: { line: 0, character: b } })
const response = (content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse => ({ model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) })
const read = (root: string, path: string) => readFile(join(root, path), "utf8")
const snapshot = async (root: string) => Object.fromEntries(await Promise.all(Object.keys(LIB).map(async (path) => [path, await read(root, path)])))

test("find_symbol resolves the definition from a consumer file and lists references across modules", async () => {
  const ws = await workspace(LIB)
  try {
    const result = await tools(ws.root).find({ path: "src/report.ts", symbol: "calcTotal" })
    assert.equal(result.definition, "src/totals.ts:1:17")
    assert.equal(result.kind, "function")
    assert.deepEqual(result.files, ["src/aliased.ts", "src/average.ts", "src/index.ts", "src/report.ts", "src/totals.ts"])
    assert.match(result.references[0], /^src\/totals\.ts:1:17 \[definition\]/)
    assert.ok(result.references.every((line: string) => !line.startsWith("src/legacy.ts")), "unrelated same-named function is not a reference")
  } finally { await ws.cleanup() }
})

test("find_symbol pages large reference sets", async () => {
  const calls = Array.from({ length: 40 }, (_, i) => `export const v${i} = calcTotal([${i}])`).join("\n")
  const ws = await workspace({ ...LIB, "src/many.ts": `import { calcTotal } from "./totals.ts"\n${calls}\n` })
  try {
    const first = await tools(ws.root).find({ path: "src/totals.ts", symbol: "calcTotal" })
    assert.equal(first.references.length, 25)
    assert.ok(first.totalReferences > 40)
    assert.match(first.next, /offset 25/)
    const second = await tools(ws.root).find({ path: "src/totals.ts", symbol: "calcTotal", offset: 25 })
    assert.equal(second.shown.split(" ")[0], "26-" + (25 + second.references.length))
  } finally { await ws.cleanup() }
})

test("rename_symbol renames an exported function, its imports, re-export and call sites; leaves unrelated symbols and aliases' local names", async () => {
  const ws = await workspace(LIB)
  try {
    const before = await snapshot(ws.root)
    const reviewable = await tools(ws.root).rename({ path: "src/average.ts", symbol: "calcTotal", newName: "computeTotal" })
    assert.deepEqual(await snapshot(ws.root), before, "preparing a rename writes nothing")
    const files = (reviewable.reviewPayload.files as Array<{ path: string }>).map((file) => file.path)
    assert.deepEqual(files, ["src/aliased.ts", "src/average.ts", "src/index.ts", "src/report.ts", "src/totals.ts"])
    const result = await reviewable.apply({ workspaceRoot: ws.root, signal: new AbortController().signal }) as any
    assert.equal(result.status, "APPLIED", result.observation)
    assert.match(await read(ws.root, "src/totals.ts"), /export function computeTotal\(/)
    assert.equal(await read(ws.root, "src/report.ts"), LIB["src/report.ts"].replaceAll("calcTotal", "computeTotal"))
    assert.equal(await read(ws.root, "src/average.ts"), LIB["src/average.ts"].replaceAll("calcTotal", "computeTotal"))
    assert.equal(await read(ws.root, "src/index.ts"), "export { computeTotal } from \"./totals.ts\"\n")
    assert.equal(await read(ws.root, "src/aliased.ts"), LIB["src/aliased.ts"].replace("calcTotal as total", "computeTotal as total"))
    assert.equal(await read(ws.root, "src/legacy.ts"), LIB["src/legacy.ts"], "unrelated same-named local function untouched")
    assert.match(result.observation, /src\/legacy\.ts/, "the remaining textual occurrence is reported, not hidden")
  } finally { await ws.cleanup() }
})

test("renaming an alias renames only the local binding, never the original export", async () => {
  const ws = await workspace(LIB)
  try {
    const reviewable = await tools(ws.root).rename({ path: "src/aliased.ts", symbol: "total", newName: "sumAll" })
    assert.deepEqual((reviewable.reviewPayload.files as Array<{ path: string }>).map((file) => file.path), ["src/aliased.ts"])
    await reviewable.apply({ workspaceRoot: ws.root, signal: new AbortController().signal })
    assert.equal(await read(ws.root, "src/aliased.ts"), "import { calcTotal as sumAll } from \"./index.ts\"\n\nexport const twice = (values: number[]) => sumAll(values) * 2\n")
    assert.equal(await read(ws.root, "src/totals.ts"), LIB["src/totals.ts"])
  } finally { await ws.cleanup() }
})

test("two different symbols with one name in a file are reported as ambiguous until a line is given", async () => {
  const ws = await workspace({ "src/a.ts": "export function size(x: string) { return x.length }\nexport function outer() {\n  const size = 3\n  return size\n}\n" })
  try {
    await assert.rejects(tools(ws.root).rename({ path: "src/a.ts", symbol: "size", newName: "len" }), /2 different symbols named size .*line/)
    const reviewable = await tools(ws.root).rename({ path: "src/a.ts", symbol: "size", newName: "count", line: 3 })
    await reviewable.apply({ workspaceRoot: ws.root, signal: new AbortController().signal })
    assert.equal(await read(ws.root, "src/a.ts"), "export function size(x: string) { return x.length }\nexport function outer() {\n  const count = 3\n  return count\n}\n")
  } finally { await ws.cleanup() }
})

test("cross-package rename in a monorepo with a root tsconfig; an unresolved import elsewhere does not block it", async () => {
  const ws = await workspace({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022" }, include: ["packages"] }),
    "packages/core/src/money.ts": "export interface Money { cents: number }\nexport function formatMoney(m: Money): string {\n  return (m.cents / 100).toFixed(2)\n}\n",
    "packages/web/src/price.ts": "import { formatMoney, type Money } from \"../../core/src/money.ts\"\nimport { missing } from \"./does-not-exist.ts\"\n\nexport const price = (m: Money) => formatMoney(m) + String(missing)\n",
  })
  try {
    const t = tools(ws.root)
    // An unresolved import resolves to its own binding; no target is invented.
    assert.equal((await t.find({ path: "packages/web/src/price.ts", symbol: "missing" })).definition, "packages/web/src/price.ts:2:10")
    const reviewable = await t.rename({ path: "packages/core/src/money.ts", symbol: "formatMoney", newName: "renderMoney" })
    await reviewable.apply({ workspaceRoot: ws.root, signal: new AbortController().signal })
    assert.match(await read(ws.root, "packages/web/src/price.ts"), /import \{ renderMoney, type Money \}[\s\S]*renderMoney\(m\)/)
    const iface = await t.rename({ path: "packages/core/src/money.ts", symbol: "Money", newName: "Amount" })
    assert.deepEqual((iface.reviewPayload.files as Array<{ path: string }>).map((file) => file.path), ["packages/core/src/money.ts", "packages/web/src/price.ts"])
  } finally { await ws.cleanup() }
})

test("a rename that would edit a file outside the workspace is refused and nothing is written", async () => {
  const ws = await workspace({
    "../shared/lib.ts": "export function helper() { return 1 }\n",
    "src/use.ts": "import { helper } from \"../../shared/lib.ts\"\nexport const x = helper()\n",
  })
  try {
    await assert.rejects(tools(ws.root).rename({ path: "src/use.ts", symbol: "helper", newName: "assist" }), /outside the workspace\. Nothing was changed/)
    assert.equal(await read(ws.root, "src/use.ts"), "import { helper } from \"../../shared/lib.ts\"\nexport const x = helper()\n")
    assert.equal(await readFile(join(ws.base, "shared/lib.ts"), "utf8"), "export function helper() { return 1 }\n")
  } finally { await ws.cleanup() }
})

test("a file changed after preparation makes the whole group stale; nothing is written", async () => {
  const ws = await workspace(LIB)
  try {
    const reviewable = await tools(ws.root).rename({ path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" })
    await writeFile(join(ws.root, "src/report.ts"), LIB["src/report.ts"] + "// edited by the user\n")
    const result = await reviewable.apply({ workspaceRoot: ws.root, signal: new AbortController().signal }) as any
    assert.equal(result.status, "STALE_BASE")
    assert.equal(await read(ws.root, "src/totals.ts"), LIB["src/totals.ts"], "no file of the group was written")
    assert.equal(await read(ws.root, "src/report.ts"), LIB["src/report.ts"] + "// edited by the user\n")
  } finally { await ws.cleanup() }
})

test("an editor buffer that differs from disk is refused at preparation (stale base)", async () => {
  const ws = await workspace(LIB)
  try {
    const ts = new TypeScriptCodeIntelligence(ws.root)
    const dirty: CodeIntelligenceProvider = {
      ...ts, name: "dirty-editor", definitions: ts.definitions.bind(ts), references: ts.references.bind(ts), readText: ts.readText.bind(ts),
      rename: async (file, position, newName) => {
        const outcome = await ts.rename(file, position, newName)
        return outcome.ok ? { ...outcome, files: outcome.files.map((entry) => ({ ...entry, baseText: entry.baseText + "\n// unsaved" })) } : outcome
      },
    }
    await assert.rejects(tools(ws.root, dirty).rename({ path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" }), (error: any) => error.code === "STALE_BASE")
  } finally { await ws.cleanup() }
})

test("a write failure mid-group (interrupted grouped edit) rolls back the files already written", async () => {
  const consumer = "import { calcTotal } from \"../src/totals.ts\"\nexport const z = calcTotal([1])\n"
  const ws = await workspace({ ...LIB, "zz/consumer.ts": consumer })
  try {
    const reviewable = await tools(ws.root).rename({ path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" })
    assert.equal((reviewable.reviewPayload.files as Array<{ path: string }>).at(-1)!.path, "zz/consumer.ts", "the locked file is written last")
    // The atomic write needs a temp file beside the target: a read-only directory fails only that write.
    await chmod(join(ws.root, "zz"), 0o555)
    const result = await reviewable.apply({ workspaceRoot: ws.root, signal: new AbortController().signal }) as any
    await chmod(join(ws.root, "zz"), 0o755)
    assert.notEqual(result.status, "APPLIED")
    assert.match(result.observation, /failed while writing zz\/consumer\.ts .*Restored src\/totals\.ts, .*no file is changed/)
    assert.deepEqual(await snapshot(ws.root), Object.fromEntries(Object.entries(LIB)))
    assert.equal(await read(ws.root, "zz/consumer.ts"), consumer)
  } finally {
    await chmod(join(ws.root, "zz"), 0o755).catch(() => {})
    await ws.cleanup()
  }
})

test("resource operations in a proposal are refused, never dropped", async () => {
  const ws = await workspace(LIB)
  try {
    const ts = new TypeScriptCodeIntelligence(ws.root)
    const withMove: CodeIntelligenceProvider = {
      name: "fake", readText: ts.readText.bind(ts), definitions: ts.definitions.bind(ts), references: ts.references.bind(ts),
      rename: async (file, position, newName) => {
        const outcome = await ts.rename(file, position, newName)
        return outcome.ok ? { ...outcome, resourceOperations: ["rename src/totals.ts -> src/computeTotal.ts"] } : outcome
      },
    }
    await assert.rejects(tools(ws.root, withMove).rename({ path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" }), /file operations .*not supported\. Nothing was changed/)
    assert.deepEqual(await snapshot(ws.root), Object.fromEntries(Object.entries(LIB)))
  } finally { await ws.cleanup() }
})

test("an unavailable language service is reported truthfully", async () => {
  const ws = await workspace({ "app.py": "def total(x):\n    return sum(x)\n" })
  try {
    await assert.rejects(tools(ws.root).find({ path: "app.py", symbol: "total" }), /found no definition for total .*Use search_text and apply_patch instead/)
    const down: CodeIntelligenceProvider = {
      name: "vscode", readText: async () => "def total(x): pass\n", definitions: async () => [], references: async () => [],
      rename: async () => ({ ok: false, error: "No rename provider" }),
    }
    await assert.rejects(tools(ws.root, down).rename({ path: "app.py", symbol: "total", newName: "summed" }), /vscode language service found no definition/)
  } finally { await ws.cleanup() }
})

test("overlapping edits are a conflict, never merged", () => {
  assert.equal(applyTextEdits("abcdef", [{ range: range(4, 6), newText: "Z" }, { range: range(0, 1), newText: "Y" }]), "YbcdZ")
  assert.throws(() => applyTextEdits("abcdef", [{ range: range(0, 3), newText: "x" }, { range: range(2, 4), newText: "y" }]), /overlapping/)
})

test("through the runner: one approval, every file recorded, and a rejection writes nothing", async () => {
  for (const decision of ["APPROVE", "REJECT"] as const) {
    const ws = await workspace(LIB)
    try {
      const engine = new MutationEngine(ws.root)
      const registry = new ToolRegistry([...createMutationToolRegistrations({ engine }), ...createCodeIntelligenceToolRegistrations(new TypeScriptCodeIntelligence(ws.root), engine)])
      const provider = new ScriptedModelProvider([
        response("", [{ id: "r1", name: "rename_symbol", arguments: { path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" } }]),
        response("Renamed."),
        response("Done."),
      ])
      const runner = new AgentRunner({ provider, registry, eventFactory: { createId: () => "e", now: () => "2026-11-16T12:00:00.000Z" } })
      let result = await runner.run({ task: { id: "t", mode: "BUILD", instruction: "Rename calcTotal to computeTotal everywhere." }, workspaceRoot: ws.root, maxTurns: 4, contextBudget: calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 }), projectInstructions: [] })
      let approvals = 0
      for (let i = 0; result.status === "PAUSED" && i < 5; i += 1) {
        approvals += 1
        result = await runner.resume(decision)
      }
      assert.equal(approvals, 1, "one approval for the whole group")
      if (decision === "APPROVE") {
        assert.deepEqual(result.appliedMutations?.filter((m) => m.status === "APPLIED").map((m) => m.path).toSorted(), ["src/aliased.ts", "src/average.ts", "src/index.ts", "src/report.ts", "src/totals.ts"])
        assert.match(await read(ws.root, "src/report.ts"), /computeTotal/)
      } else {
        assert.deepEqual(await snapshot(ws.root), Object.fromEntries(Object.entries(LIB)))
      }
    } finally { await ws.cleanup() }
  }
})

test("edit guidance names rename_symbol only when it is available", () => {
  assert.match(mutationToolGuidance(["apply_patch", "rename_symbol"]), /rename_symbol\(path, symbol, newName\)/)
  assert.doesNotMatch(mutationToolGuidance(["apply_patch", "create_file"]), /rename_symbol/)
})

test("hand renames of an exported or imported binding are recognized only when the request names both", () => {
  const ask = "Rename calcTotal to computeTotal everywhere."
  assert.deepEqual(handRenamedBinding("export function calcTotal() {}\n", "export function computeTotal() {}\n", ask), { from: "calcTotal", to: "computeTotal" })
  assert.deepEqual(handRenamedBinding("import { calcTotal as t } from \"./a.ts\"\n", "import { computeTotal as t } from \"./a.ts\"\n", ask), { from: "calcTotal", to: "computeTotal" })
  assert.deepEqual(handRenamedBinding("export { calcTotal } from \"./a.ts\"\n", "export { computeTotal } from \"./a.ts\"\n", ask), { from: "calcTotal", to: "computeTotal" })
  assert.equal(handRenamedBinding("export function calcTotal() {}\n", "export function computeTotal() {}\n", "Replace the summing helper."), undefined)
  assert.equal(handRenamedBinding("function calcTotal() {}\n", "function computeTotal() {}\n", ask), undefined, "a private helper is a single-file change")
  assert.equal(handRenamedBinding("export const a = 1\n", "export const a = 1\nexport const SCORE = 2\n", "Add SCORE next to a"), undefined)
  const r1 = "Extract them into an exported SCORE_THRESHOLDS constant and rename statusTone to scoreTone, updating every importer."
  assert.deepEqual(handRenamedBinding("export function statusTone() {}\n", "export const SCORE_THRESHOLDS = {}\nexport function scoreTone() {}\n", r1), { from: "statusTone", to: "scoreTone" }, "the stated target, not the extracted constant")
  assert.equal(handRenamedBinding("export function statusTone() {}\n", "export const SCORE_THRESHOLDS = {}\n", r1), undefined, "the stated target is not what the patch adds: no redirect")
  // Reeprov R1's instruction verbatim: an earlier "into an exported" must not be read as the target.
  const r1Verbatim = "In lib/utils/format.ts, statusForScore and statusTone both hard-code the 80/60 score thresholds. Extract them into an exported SCORE_THRESHOLDS constant ({ healthy: 80, warning: 60 }) that both functions use, and rename statusTone to scoreTone, updating every place that imports it from lib/utils/format. Some other files define their own local statusTone helpers for unrelated status strings; leave those alone. Run the tests when you are done."
  assert.deepEqual(handRenamedBinding("export function statusForScore() {}\nexport function statusTone() {}\n", "export const SCORE_THRESHOLDS = {}\nexport function statusForScore() {}\nexport function scoreTone() {}\n", r1Verbatim), { from: "statusTone", to: "scoreTone" })
})

test("through the runner: a hand rename of an export is refused unwritten and redirected to rename_symbol", async () => {
  const ws = await workspace(LIB)
  try {
    const engine = new MutationEngine(ws.root)
    const registry = new ToolRegistry([...createMutationToolRegistrations({ engine }), ...createCodeIntelligenceToolRegistrations(new TypeScriptCodeIntelligence(ws.root), engine)])
    const provider = new ScriptedModelProvider([
      response("", [{ id: "p1", name: "apply_patch", arguments: { path: "src/totals.ts", search: "export function calcTotal(", replace: "export function computeTotal(" } }]),
      response("", [{ id: "r1", name: "rename_symbol", arguments: { path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" } }]),
      response("Renamed."),
      response("Done."),
    ])
    const runner = new AgentRunner({ provider, registry, eventFactory: { createId: () => "e", now: () => "2026-11-17T12:00:00.000Z" } })
    let result = await runner.run({ task: { id: "t", mode: "BUILD", instruction: "Rename calcTotal to computeTotal everywhere." }, workspaceRoot: ws.root, maxTurns: 5, contextBudget: calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 }), projectInstructions: [] })
    const firstPause = result.status
    for (let i = 0; result.status === "PAUSED" && i < 5; i += 1) result = await runner.resume("APPROVE")
    assert.equal(firstPause, "PAUSED", "the redirected rename_symbol reaches approval")
    assert.ok(result.observations?.some((item) => /RENAME_BY_PATCH/.test(item.content)))
    assert.equal(await read(ws.root, "src/report.ts"), LIB["src/report.ts"].replaceAll("calcTotal", "computeTotal"))
  } finally { await ws.cleanup() }
})

test("a partial rename proposal (language server still loading) is retried once, then refused with nothing written", async () => {
  for (const partialCalls of [1, Number.POSITIVE_INFINITY]) {
    const ws = await workspace(LIB)
    try {
      const ts = new TypeScriptCodeIntelligence(ws.root)
      let calls = 0
      // Like tsserver before the project is loaded: only the file being renamed is covered.
      const loading: CodeIntelligenceProvider = {
        name: "vscode", readText: ts.readText.bind(ts), definitions: ts.definitions.bind(ts), references: ts.references.bind(ts),
        rename: async (file, position, newName) => {
          const outcome = await ts.rename(file, position, newName)
          calls += 1
          return outcome.ok && calls <= partialCalls ? { ...outcome, files: outcome.files.filter((entry) => entry.file === file) } : outcome
        },
      }
      const attempt = tools(ws.root, loading).rename({ path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" })
      if (partialCalls === 1) {
        const reviewable = await attempt
        assert.equal((reviewable.reviewPayload.files as unknown[]).length, 5, "the retry covers every file")
        assert.equal(calls, 2)
      } else {
        await assert.rejects(attempt, /does not cover .*src\/report\.ts.*Nothing was changed/)
        assert.deepEqual(await snapshot(ws.root), Object.fromEntries(Object.entries(LIB)))
      }
    } finally { await ws.cleanup() }
  }
})
