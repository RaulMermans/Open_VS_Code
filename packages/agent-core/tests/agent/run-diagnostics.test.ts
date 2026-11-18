import assert from "node:assert/strict"
import test from "node:test"
import { buildRunDiagnostics, sanitizeDiagnosticText } from "../../src/agent/run-diagnostics.ts"

const ev = (type: string, payload: object, id = type) => ({ id, type, taskId: "t", timestamp: "2026-01-01T00:00:00.000Z", payload })
const base = { runId: "r1", status: "FAILED", mutations: [], verifications: [], pendingApproval: false, hasCheckpoint: true, toolCalls: [] }

test("diagnostics pin the earliest failure and flag the contradiction in the HALO report", () => {
  const d = buildRunDiagnostics({
    ...base, failureReason: "INTERNAL_ERROR",
    finalAnswer: "Changed: NOTES.md. The existing implementation was not modified.",
    events: [ev("model.requested", { turn: 3 }), ev("tool.requested", { callId: "c1", name: "apply_patch" }), ev("task.failed", { message: "ENOENT /home/raul/secret/proj/x.ts Bearer abcdef1234567890" }, "f1"), ev("task.failed", { message: "later" }, "f2")],
    mutations: [{ mutationId: "m1", path: "apps/core/src/version.ts", status: "APPLIED", timestamp: "2026-01-01T00:00:01.000Z" }],
  })
  assert.equal(d.firstFailure?.turn, 3)
  assert.equal(d.firstFailure?.afterTool, "apply_patch")
  assert.ok(!/raul|abcdef12/.test(d.firstFailure!.message))
  assert.deepEqual(d.appliedMutationIds, ["m1"])
  assert.equal(d.recoverable, true)
  assert.ok(d.inconsistencies.some((i) => /never produced an observation/.test(i)))
  assert.ok(d.inconsistencies.some((i) => /version\.ts is missing/.test(i)))
  assert.ok(d.inconsistencies.some((i) => /nothing changed but edits were applied/.test(i)))
})

test("an unexplained INTERNAL_ERROR and a pending approval are surfaced, and not recoverable", () => {
  const d = buildRunDiagnostics({ ...base, failureReason: "INTERNAL_ERROR", events: [], pendingApproval: true })
  assert.ok(d.inconsistencies.some((i) => /without a recorded failure/.test(i)))
  assert.equal(d.recoverable, false)
  assert.equal(sanitizeDiagnosticText("/home/a/b"), "~/b")
})
