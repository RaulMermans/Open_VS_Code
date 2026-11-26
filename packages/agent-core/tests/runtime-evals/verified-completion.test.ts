import assert from "node:assert/strict"
import test from "node:test"
import { RuntimeEvidenceCollector } from "../../src/runtime-evals/evidence.ts"
import { evaluateL0 } from "../../src/runtime-evals/evaluators/l0-deterministic.ts"

function verifiedWorkspace() {
  const collector = new RuntimeEvidenceCollector({ runId: "run", taskGoal: "fix", plan: [] })
  collector.recordMutationOutcome({ mutationId: "m1", path: "src/a.ts", status: "APPLIED" })
  collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "PASS" })
  return collector
}

test("a failed edit after a passing verification does not keep a verified workspace in REVISE", () => {
  const collector = verifiedWorkspace()
  collector.recordToolAction({ id: "c1", toolName: "apply_patch", outcome: "FAILED", error: "PATCH_MISMATCH: the replace text already appears" })
  assert.equal(evaluateL0(collector.getEvidence(), "BEFORE_COMPLETION").decision, "CONTINUE")
})

test("a failed check still blocks completion after a passing test run", () => {
  const collector = verifiedWorkspace()
  collector.recordToolAction({ id: "c2", toolName: "run_verification", outcome: "FAILED", error: "TYPECHECK failed" })
  assert.equal(evaluateL0(collector.getEvidence(), "BEFORE_COMPLETION").decision, "REVISE")
})
