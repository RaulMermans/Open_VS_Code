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

test("the not-done-yet nudge says so when the model claims an edit the workspace does not show", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-claim-"))
  try {
    await writeFile(join(root, "add.ts"), "export const add = (a: number, b: number) => a - b\n")
    const claim: ModelResponse = { model: "scripted", message: { role: "assistant", content: "I have applied the fix and added the test." } }
    const provider = new ScriptedModelProvider([claim, claim])
    const agent = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
    await agent.run({ task: { id: "task", mode: "BUILD", instruction: "Fix add.ts so add returns the sum, and add a unit test for it." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
    assert.match(JSON.stringify(provider.requests.at(-1)), /says changes were applied, but the workspace does not show them/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("two identical path faults in one turn are one mistake; the same fault in a later turn stops the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-fault-"))
  try {
    await writeFile(join(root, "a.ts"), "export const a = 1\n")
    const bad = { id: "x", name: "list_directory", arguments: { path: "/etc" } }
    const twice: ModelResponse = { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ ...bad, id: "b1" }, { ...bad, id: "b2" }] }
    const again: ModelResponse = { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ ...bad, id: "b3" }] }
    const provider = new ScriptedModelProvider([twice, again, again])
    const agent = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
    const result = await agent.run({ task: { id: "task", mode: "BUILD", instruction: "Fix a.ts." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
    assert.equal(provider.requests.length, 2, "turn 1 (two faults) did not stop the run; the repeat on turn 2 did")
    assert.match(String(result.finalAnswer), /repeated tool-contract error/)
    assert.match(JSON.stringify(provider.requests.at(-1)), new RegExp(root.replace(/[/.]/g, "\\$&")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("declining one edit of a multi-outcome brief keeps the run going; a single-edit task still stops", async () => {
  const { MutationEngine } = await import("../../src/tools/mutation-engine.ts")
  const { createMutationToolRegistrations } = await import("../../src/tools/mutation-registry.ts")
  const { ToolRegistry } = await import("../../src/tools/registry.ts")
  for (const [instruction, wantStopped] of [
    ["# Brief\n\n## Phase 1 — Adder\nImplement the sum in add.ts.\n\n## Phase 2 — Multiplier\nImplement the product in mul.ts.\n", false],
    ["Fix add.ts so add returns the sum.", true],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "ovsc-decline-"))
    try {
      await writeFile(join(root, "add.ts"), "export const add = (a: number, b: number) => a - b\n")
      await writeFile(join(root, "mul.ts"), "export const mul = (a: number, b: number) => a + b\n")
      const provider = new ScriptedModelProvider([
        call("p1", "apply_patch", { path: "add.ts", search: "a - b", replace: "a + b" }),
        call("p2", "apply_patch", { path: "mul.ts", search: "a + b", replace: "a * b" }),
        { model: "scripted", message: { role: "assistant", content: "Left mul.ts undone." } },
      ])
      const registry = new ToolRegistry([...createMutationToolRegistrations({ engine: new MutationEngine(root) })])
      const agent = new AgentRunner({ provider, registry, eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
      let result = await agent.run({ task: { id: "task", mode: "BUILD", instruction }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
      // multi-outcome: approve the first edit, decline the second; single edit: decline it
      let seen = 0
      for (let guard = 0; result.status === "PAUSED" && guard < 10; guard += 1) { result = await agent.resume(wantStopped || seen > 0 ? "REJECT" : "APPROVE"); seen += 1 }
      if (wantStopped) assert.equal(result.failureReason, "REJECTED")
      else {
        assert.notEqual(result.failureReason, "REJECTED")
        assert.ok(provider.requests.length >= 3, "the model got another turn after the declined edit")
        assert.match(JSON.stringify(provider.requests.at(-1)), /The user declined this edit to mul\.ts/)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("writing a test file triggers a test run in the same turn, without the model asking for it", async () => {
  const { MutationEngine } = await import("../../src/tools/mutation-engine.ts")
  const { createMutationToolRegistrations } = await import("../../src/tools/mutation-registry.ts")
  const { createVerificationToolRegistrations } = await import("../../src/tools/verification-registry.ts")
  const { ToolRegistry } = await import("../../src/tools/registry.ts")
  const root = await mkdtemp(join(tmpdir(), "ovsc-autotest-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }))
    await writeFile(join(root, "check.js"), "console.log('ran')\n")
    await writeFile(join(root, "add.ts"), "export const add = (a: number, b: number) => a + b\n")
    const registry = new ToolRegistry([...createMutationToolRegistrations({ engine: new MutationEngine(root) }), ...createVerificationToolRegistrations(root)])
    const provider = new ScriptedModelProvider([
      call("t1", "create_file", { path: "add.test.ts", content: "import { add } from './add.ts'\nimport { it } from 'node:test'\nimport assert from 'node:assert'\nit('adds', () => assert.equal(add(1, 2), 3))\n" }),
      { model: "scripted", message: { role: "assistant", content: "Done." } },
    ])
    const agent = new AgentRunner({ provider, registry, eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
    let result = await agent.run({ task: { id: "task", mode: "BUILD", instruction: "# Brief\n\n## Phase 1 — Adder\nImplement add in add.ts and add a unit test for it.\n\n## Phase 2 — Multiplier\nImplement mul in mul.ts and test it.\n" }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
    for (let guard = 0; result.status === "PAUSED" && guard < 10; guard += 1) result = await agent.resume("APPROVE")
    assert.ok(result.toolCalls.some((record) => record.name === "run_verification"))
    // a second outcome is still open, so the end-of-task check has not happened yet: the run came from the test file itself
    assert.match(JSON.stringify(provider.requests[1]), /Verification Status/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
