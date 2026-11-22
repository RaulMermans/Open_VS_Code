/**
 * Sprint 25 (P1): a rename applied in this task is recognized when the model asks for it again
 * (ALREADY_SATISFIED, no new mutation or approval), but only while the code still shows it, and never for a
 * different symbol that shares the old name.
 */
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createCodeIntelligenceToolRegistrations } from "../../src/tools/code-intelligence.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { TypeScriptCodeIntelligence } from "../../src/tools/typescript-code-intelligence.ts"

const LIB = {
  "src/totals.ts": "export function calcTotal(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0)\n}\n",
  "src/report.ts": "import { calcTotal } from \"./totals.ts\"\n\nexport const report = (values: number[]) => `total=${calcTotal(values)}`\n",
  // Same name, unrelated: never part of the rename.
  "src/legacy.ts": "function calcTotal(items: string[]): string {\n  return items.join(\"+\")\n}\nexport const legacy = calcTotal([\"a\"])\n",
}
const RENAME = { path: "src/totals.ts", symbol: "calcTotal", newName: "computeTotal" }
const INSTRUCTION = "Rename calcTotal in src/totals.ts to computeTotal everywhere, and add a test for computeTotal."

const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })
const answer = (text: string): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: text } })

async function run(steps: Array<ModelResponse | ((request: ModelRequest) => ModelResponse)>, prepare?: (root: string) => void) {
  const root = join(await realpath(await mkdtemp(join(tmpdir(), "ovsc-s25-rn-"))), "ws")
  for (const [path, content] of Object.entries(LIB)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  prepare?.(root)
  const engine = new MutationEngine(root)
  const registry = new ToolRegistry([...createMutationToolRegistrations({ engine }), ...createCodeIntelligenceToolRegistrations(new TypeScriptCodeIntelligence(root), engine)])
  const agent = new AgentRunner({ provider: new ScriptedModelProvider(steps.map((step) => typeof step === "function" ? (request: ModelRequest) => step(request) : step)), registry, eventFactory: { createId: () => "e", now: () => "2026-11-17T12:00:00.000Z" } })
  let result = await agent.run({ task: { id: "t", mode: "BUILD", instruction: INSTRUCTION }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: calculateBudget({ contextWindow: 16_000, reservedOutput: 400, reservedToolHistory: 400 }), projectInstructions: [] })
  let approvals = 0
  for (let guard = 0; result.status === "PAUSED" && guard < 10; guard += 1) {
    approvals += 1
    result = await agent.resume("APPROVE")
  }
  const prepared = result.events.filter((event) => event.type === "mutation.prepared").length
  return { root, result, approvals, prepared, cleanup: () => rm(dirname(root), { recursive: true, force: true }) }
}

test("a repeated rename_symbol after a successful rename is ALREADY_SATISFIED: no second mutation, no second approval", async () => {
  const { root, result, approvals, prepared, cleanup } = await run([
    call("r1", "rename_symbol", RENAME),
    call("r2", "rename_symbol", RENAME),
    answer("Renamed; the test is still missing."),
  ])
  try {
    assert.equal(approvals, 1)
    assert.equal(prepared, 1, "the repeat prepared no mutation")
    const repeat = result.toolCalls.find((item) => item.id === "r2")!
    assert.equal(repeat.outcome, "COMPLETED")
    assert.match(String(result.observations?.find((item) => item.callId === "r2")?.content), /^ALREADY_SATISFIED: calcTotal was already renamed to computeTotal in this task \(src\/report\.ts, src\/totals\.ts\)/)
    assert.match(await readFile(join(root, "src/report.ts"), "utf8"), /computeTotal/)
    assert.equal(await readFile(join(root, "src/legacy.ts"), "utf8"), LIB["src/legacy.ts"])
  } finally { await cleanup() }
})

test("find_symbol on the old name in a renamed file says it was renamed, instead of 'does not appear'", async () => {
  const { result, cleanup } = await run([
    call("r1", "rename_symbol", RENAME),
    call("f1", "find_symbol", { path: "src/report.ts", symbol: "calcTotal" }),
    answer("Renamed."),
  ])
  try {
    const content = String(result.observations?.find((item) => item.callId === "f1")?.content)
    assert.match(content, /^ALREADY_SATISFIED: calcTotal was already renamed to computeTotal/)
    assert.doesNotMatch(content, /does not appear/)
  } finally { await cleanup() }
})

test("a same-named but different symbol in a file outside the rename is looked up normally", async () => {
  const { result, cleanup } = await run([
    call("r1", "rename_symbol", RENAME),
    call("f1", "find_symbol", { path: "src/legacy.ts", symbol: "calcTotal" }),
    answer("legacy.ts keeps its own calcTotal."),
  ])
  try {
    const content = String(result.observations?.find((item) => item.callId === "f1")?.content)
    assert.doesNotMatch(content, /ALREADY_SATISFIED/)
    assert.match(content, /src\/legacy\.ts/)
  } finally { await cleanup() }
})

test("when the workspace no longer shows the rename, a repeated request is reassessed (new review), not answered from memory", async () => {
  let rootRef = ""
  const { result, prepared, approvals, cleanup } = await run([
    call("r1", "rename_symbol", RENAME),
    () => {
      // Someone restored the old name in the file after the rename.
      writeFileSync(join(rootRef, "src/totals.ts"), LIB["src/totals.ts"])
      writeFileSync(join(rootRef, "src/report.ts"), LIB["src/report.ts"])
      return call("r2", "rename_symbol", RENAME)
    },
    answer("Renamed again."),
  ], (root) => { rootRef = root })
  try {
    assert.notEqual(result.toolCalls.find((item) => item.id === "r2")?.alreadyObserved, true)
    assert.equal(prepared, 2, "the rename was prepared again")
    assert.equal(approvals, 2)
  } finally { await cleanup() }
})

test("repeating an already-satisfied rename is bounded and ends truthfully", async () => {
  const { result, prepared, cleanup } = await run([
    call("r1", "rename_symbol", RENAME),
    ...Array.from({ length: 10 }, (_, index) => call(`r${index + 2}`, "rename_symbol", RENAME)),
  ])
  try {
    assert.equal(prepared, 1)
    assert.equal(result.failureReason, "NON_PROGRESS")
    assert.ok(result.toolCalls.length <= 7, `stopped after ${result.toolCalls.length} calls`)
  } finally { await cleanup() }
})
