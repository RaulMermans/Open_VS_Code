import test from "node:test"
import assert from "node:assert/strict"
import { integrateRepairOutcome } from "../../src/agent/repair-integration.ts"
import type { AgentResult } from "../../src/contracts/agent.ts"
import type { RepairResult } from "../../src/agent/repair-contracts.ts"

function originalResult(): AgentResult {
  return {
    status: "FAILED",
    failureReason: "VERIFICATION_FAILED",
    finalAnswer: "Changed: src/add.ts. Approval was granted for the applied edit. Tests failed. The edit is not complete.",
    turns: 4,
    finalState: { status: "FAILED", task: { id: "task-1", mode: "BUILD", instruction: "fix add" }, events: [] },
    events: [{ id: "e1", type: "mutation.applied", taskId: "task-1", timestamp: "2026-11-06T00:00:00.000Z", payload: { path: "src/add.ts" } }],
    contextDiagnostics: [],
    toolCalls: [{ id: "c1", name: "apply_patch", outcome: "COMPLETED" }],
  }
}

test("repair completion keeps the original applied edit", () => {
  const repair: RepairResult = {
    status: "COMPLETED",
    task: "task-1",
    repairAttempts: 1,
    mutationsPrepared: 0,
    mutationsApplied: 0,
    verificationRuns: 2,
    totalAgentTurns: 2,
    changedFiles: ["src/add.ts"],
    events: [],
    finalVerification: { status: "PASS", exitCode: 0, stdout: "ok", stderr: "", durationMs: 8 },
  }
  const integrated = integrateRepairOutcome(originalResult(), repair)
  assert.equal(integrated.status, "COMPLETED")
  assert.equal(integrated.failureReason, undefined)
  assert.match(integrated.finalAnswer ?? "", /src\/add\.ts/)
  assert.match(integrated.finalAnswer ?? "", /Tests passed/)
  assert.equal(integrated.toolCalls[0]?.name, "apply_patch")
  assert.equal(integrated.events[0]?.type, "mutation.applied")
  assert.equal(integrated.finalState.task?.id, "task-1")
})

test("rejected repair does not claim success or forget the applied edit", () => {
  const repair: RepairResult = {
    status: "REJECTED_BY_USER",
    task: "task-1",
    repairAttempts: 1,
    mutationsPrepared: 1,
    mutationsApplied: 0,
    verificationRuns: 1,
    totalAgentTurns: 1,
    changedFiles: ["src/add.ts"],
    events: [],
    failureReason: "Mutation rejected",
  }
  const integrated = integrateRepairOutcome(originalResult(), repair)
  assert.equal(integrated.status, "FAILED")
  assert.equal(integrated.failureReason, "REJECTED")
  assert.match(integrated.finalAnswer ?? "", /src\/add\.ts/)
  assert.match(integrated.finalAnswer ?? "", /Earlier applied edits remain/)
  assert.doesNotMatch(integrated.finalAnswer ?? "", /The requested edit was applied/)
})

test("cancelled repair does not complete", () => {
  const repair: RepairResult = {
    status: "CANCELLED",
    task: "task-1",
    repairAttempts: 1,
    mutationsPrepared: 0,
    mutationsApplied: 0,
    verificationRuns: 1,
    totalAgentTurns: 0,
    changedFiles: ["src/add.ts"],
    events: [],
    finalVerification: { status: "CANCELLED", exitCode: null, stdout: "", stderr: "", durationMs: 1 },
  }
  const integrated = integrateRepairOutcome(originalResult(), repair)
  assert.equal(integrated.status, "CANCELLED")
  assert.match(integrated.finalAnswer ?? "", /cancelled/i)
  assert.equal(integrated.finalState.status, "CANCELLED")
})

test("a failed repair verification cannot report success", () => {
  const repair: RepairResult = {
    status: "FAILED",
    task: "task-1",
    repairAttempts: 1,
    mutationsPrepared: 1,
    mutationsApplied: 1,
    verificationRuns: 2,
    totalAgentTurns: 3,
    changedFiles: ["src/add.ts", "src/add.test.ts"],
    events: [],
    finalVerification: { status: "FAIL", exitCode: 1, stdout: "fail", stderr: "", durationMs: 4 },
  }
  const integrated = integrateRepairOutcome(originalResult(), repair)
  assert.equal(integrated.status, "FAILED")
  assert.equal(integrated.failureReason, "VERIFICATION_FAILED")
  assert.match(integrated.finalAnswer ?? "", /Tests failed/)
  assert.match(integrated.finalAnswer ?? "", /src\/add\.test\.ts/)
})
