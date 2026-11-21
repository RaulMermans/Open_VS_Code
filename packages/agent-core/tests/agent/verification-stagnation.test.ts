import assert from "node:assert/strict"
import test from "node:test"
import { createToolObservation } from "../../src/agent/observations.ts"
import { failureFingerprint, unchangedFailures } from "../../src/agent/verification-stagnation.ts"

const verification = (id: string, failing: string[]) => createToolObservation({ toolName: "run_verification", callId: id, output: `Verification Status: FAIL\n${failing.map((name) => ` \u001b[31m×\u001b[39m ${name} 5ms`).join("\n")}\n Tests  1 failed` })
const edit = (id: string) => createToolObservation({ toolName: "apply_patch", callId: id, output: "applied" })

test("a failure that already failed before the first edit, and still fails the same way, is pre-existing", () => {
  const sqlite = "better-sqlite3 native binding > loads and executes an in-memory statement"
  assert.deepEqual(failureFingerprint(`\u001b[31m ×\u001b[39m ${sqlite} 14ms\n Test Files  1 failed`), [sqlite])
  assert.deepEqual(unchangedFailures([verification("v1", [sqlite]), edit("e1"), verification("v2", [sqlite])]), [sqlite])
})

test("no edit between runs, a new failure, or a cleared failure is not reported as unchanged", () => {
  const a = "suite A > does the first thing"
  const b = "suite B > does the second thing"
  assert.deepEqual(unchangedFailures([verification("v1", [a]), verification("v2", [a])]), [], "no edit in between")
  assert.deepEqual(unchangedFailures([verification("v1", [a]), edit("e1"), verification("v2", [a, b])]), [], "an edit introduced a new failure")
  assert.deepEqual(unchangedFailures([verification("v1", [a, b]), edit("e1"), verification("v2", [a])]), [a], "one pre-existing failure cleared, one persists")
})

const pass = (id: string) => createToolObservation({ toolName: "run_verification", callId: id, output: "Verification Status: PASS\n Tests  1 passed" })
const failedWith = (id: string, name: string, assertion: string) => createToolObservation({
  toolName: "run_verification",
  callId: id,
  output: `Verification Status: FAIL\n × ${name}\n${assertion}`,
})

test("a passing baseline followed by a new failure is a regression, not pre-existing", () => {
  const name = "suite A > does the first thing"
  assert.deepEqual(unchangedFailures([pass("v0"), edit("e1"), verification("v1", [name])]), [])
})

test("two identical failures after editing started are an unsuccessful repair", () => {
  const name = "suite A > does the first thing"
  assert.deepEqual(unchangedFailures([edit("e0"), verification("v1", [name]), edit("e1"), verification("v2", [name])]), [])
})

test("the same test name with a different assertion is not the same failure", () => {
  const name = "suite A > does the first thing"
  assert.deepEqual(unchangedFailures([
    failedWith("v1", name, "AssertionError: expected 1"),
    edit("e1"),
    failedWith("v2", name, "AssertionError: expected 2"),
  ]), [])
})

import { deriveOutcomes, evaluateOutcomes, outcomeGaps } from "../../src/agent/outcome-ledger.ts"

test("an unchanged failure does not mark an outcome FAILED, but a failure caused by the edits does", () => {
  const outcomes = deriveOutcomes("## Phase 1 — Adder\nImplement the `sumTotals` helper in the billing module.\n\n## Phase 2 — Rounding\nFix the `roundTax` helper.\n")
  const edited = { path: "src/billing.ts", content: "export function sumTotals() {} export function roundTax() {}" }
  assert.equal(evaluateOutcomes(outcomes, [edited], { status: "FAIL", afterLastEdit: true })[0]!.status, "FAILED")
  assert.equal(evaluateOutcomes(outcomes, [edited], { status: "UNCHANGED_FAILURE", afterLastEdit: true })[0]!.status, "UNVERIFIED")
  assert.equal(outcomeGaps(evaluateOutcomes(outcomes, [edited], { status: "UNCHANGED_FAILURE", afterLastEdit: true })).length, 0)
})
