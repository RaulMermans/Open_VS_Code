import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })
const sleepBeforeNextTurn = () => new Promise((done) => setTimeout(done, 15))

test("a work unit pauses with its state kept; a unit that changed nothing is not continued", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-unit-"))
  try {
    await writeFile(join(root, "add.ts"), "export const add = (a: number, b: number) => a - b\n")
    const provider = new ScriptedModelProvider([call("r1", "read_file", { path: "add.ts" }), call("r2", "list_directory", { path: "." }), call("r3", "list_directory", { path: "." })])
    const complete = provider.complete.bind(provider)
    provider.complete = async (request) => { await new Promise((done) => setTimeout(done, 20)); return complete(request) }
    const agent = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
    const first = await agent.run({ task: { id: "task", mode: "BUILD", instruction: "Fix add.ts so add returns the sum." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [], unitBudgetMs: 5 })
    assert.equal(first.failureReason, "MAX_TURNS_EXCEEDED")
    const next = await agent.continueFromLimit(8)
    assert.equal(next.failureReason, "NON_PROGRESS")
    assert.match(String(next.finalAnswer), /no edit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the done-but-incomplete nudge is bounded per stretch without an edit, not per run", async () => {
  const { MutationEngine } = await import("../../src/tools/mutation-engine.ts")
  const { createMutationToolRegistrations } = await import("../../src/tools/mutation-registry.ts")
  const { ToolRegistry } = await import("../../src/tools/registry.ts")
  const root = await mkdtemp(join(tmpdir(), "ovsc-gate-"))
  try {
    await writeFile(join(root, "add.ts"), "export const add = (a: number, b: number) => a - b\n")
    const done: ModelResponse = { model: "scripted", message: { role: "assistant", content: "Done." } }
    const patch = call("p1", "apply_patch", { path: "add.ts", search: "a - b", replace: "a + b" })
    const provider = new ScriptedModelProvider([done, patch, done, done, done, done, done])
    const registry = new ToolRegistry([...createMutationToolRegistrations({ engine: new MutationEngine(root) })])
    const agent = new AgentRunner({ provider, registry, eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
    let result = await agent.run({ task: { id: "task", mode: "BUILD", instruction: "Fix add.ts so add returns the sum, and add a unit test for it." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
    for (let guard = 0; result.status === "PAUSED" && guard < 20; guard += 1) result = await agent.resume("APPROVE")
    // done, (nudge 1) patch, done (nudge 1 again: the edit reset the count), done (nudge 2), done -> stop
    assert.equal(provider.requests.length, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
