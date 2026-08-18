import assert from "node:assert/strict"
import test from "node:test"

import { createAgentEvent } from "../../src/agent/events.ts"
import { AgentTransitionError, applyAgentEvent, initialAgentState } from "../../src/agent/state.ts"
import type { AgentTask } from "../../src/contracts/agent.ts"

const task: AgentTask = { id: "task-1", mode: "BUILD", instruction: "Build the core" }
let sequence = 0

function event<TType extends Parameters<typeof createAgentEvent>[0]>(type: TType, payload: unknown = {}) {
  sequence += 1
  return createAgentEvent(type, task.id, payload, {
    createId: () => `event-${sequence}`,
    now: () => "2026-08-18T12:00:00.000Z",
  })
}

test("runs a normal model, tool, and verification lifecycle immutably", () => {
  const initial = initialAgentState()
  let state = applyAgentEvent(initial, event("task.started", { task }))
  state = applyAgentEvent(state, event("context.compiled"))
  state = applyAgentEvent(state, event("model.requested"))
  state = applyAgentEvent(state, event("model.completed"))
  state = applyAgentEvent(state, event("tool.requested"))
  state = applyAgentEvent(state, event("tool.completed"))
  state = applyAgentEvent(state, event("verification.started"))
  state = applyAgentEvent(state, event("task.completed"))

  assert.equal(initial.status, "IDLE")
  assert.equal(initial.events.length, 0)
  assert.equal(state.status, "COMPLETED")
  assert.equal(state.events.length, 8)
  assert.equal(state.events[0]!.id.startsWith("event-"), true)
  assert.equal(state.events[0]!.timestamp, "2026-08-18T12:00:00.000Z")
})

test("model and tool failures terminate the task", () => {
  let modelState = applyAgentEvent(initialAgentState(), event("task.started", { task }))
  modelState = applyAgentEvent(modelState, event("model.requested"))
  modelState = applyAgentEvent(modelState, event("model.failed", { message: "model offline" }))
  assert.equal(modelState.status, "FAILED")
  assert.equal(modelState.error, "model offline")

  let toolState = applyAgentEvent(initialAgentState(), event("task.started", { task }))
  toolState = applyAgentEvent(toolState, event("model.requested"))
  toolState = applyAgentEvent(toolState, event("model.completed"))
  toolState = applyAgentEvent(toolState, event("tool.requested"))
  toolState = applyAgentEvent(toolState, event("tool.failed", { message: "read failed" }))
  assert.equal(toolState.status, "FAILED")
})

test("cancellation terminates an active task", () => {
  const started = applyAgentEvent(initialAgentState(), event("task.started", { task }))
  assert.equal(applyAgentEvent(started, event("task.cancelled")).status, "CANCELLED")
})

test("rejects invalid transitions and cannot resume a terminal task", () => {
  assert.throws(() => applyAgentEvent(initialAgentState(), event("model.requested")), AgentTransitionError)
  const started = applyAgentEvent(initialAgentState(), event("task.started", { task }))
  const failed = applyAgentEvent(started, event("task.failed", { message: "failed" }))
  assert.throws(() => applyAgentEvent(failed, event("model.requested")), AgentTransitionError)
  assert.throws(() => applyAgentEvent(failed, event("task.started", { task })), AgentTransitionError)
})
