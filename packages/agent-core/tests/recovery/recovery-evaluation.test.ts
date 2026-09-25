/**
 * Recovery Evaluation Test Suite
 * Sprint 4C — Strict Deep Equality, Two-Run Determinism, Negative Comparator
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { runRecoveryEvaluation } from "./recovery-evaluation-harness.ts"

describe("Sprint 4C — Recovery Evaluation & Strict Determinism", () => {
  test("Strict Comparator Negative Tests catch discrepancies", () => {
    // Negative comparator test 1: status mismatch caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { reconciledStatus: "RECONCILED_APPLIED", writeReplayCount: 0 },
          { reconciledStatus: "RECONCILED_NOT_APPLIED", writeReplayCount: 0 }
        )
      },
      { name: "AssertionError" }
    )

    // Negative comparator test 2: replay write count discrepancy caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { writeReplayCount: 0 },
          { writeReplayCount: 1 }
        )
      },
      { name: "AssertionError" }
    )

    // Negative comparator test 3: disposition divergence caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { disposition: "ASK_HUMAN" },
          { disposition: "RESUME" }
        )
      },
      { name: "AssertionError" }
    )

    // Negative comparator test 4: rollback outcome discrepancy caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { rollbackStatus: "ROLLED_BACK" },
          { rollbackStatus: "DIVERGED" }
        )
      },
      { name: "AssertionError" }
    )

    // Negative comparator test 5: durability gate failure reason discrepancy caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { runnerStatus: "FAILED", failureReason: "INTERNAL_ERROR" },
          { runnerStatus: "COMPLETED", failureReason: undefined }
        )
      },
      { name: "AssertionError" }
    )

    // Negative comparator test 6: checksum divergence discrepancy caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { stateAlters: true, footprintAlters: true, reorderIdentical: true },
          { stateAlters: false, footprintAlters: true, reorderIdentical: true }
        )
      },
      { name: "AssertionError" }
    )

    // Negative comparator test 7: sequence monotonicity mismatch caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { strictlyMonotonic: true },
          { strictlyMonotonic: false }
        )
      },
      { name: "AssertionError" }
    )

    // Negative comparator test 8: repair runner coordinator presence discrepancy caught
    assert.throws(
      () => {
        assert.deepStrictEqual(
          { hasCoordinator: true, coordinatorMatchesRuntime: true },
          { hasCoordinator: false, coordinatorMatchesRuntime: false }
        )
      },
      { name: "AssertionError" }
    )
  })

  test("Run 1: Evaluate all recovery scenarios", async () => {
    const res1 = await runRecoveryEvaluation()
    assert.strictEqual(res1.totalFailed, 0, `Expected 0 failed scenarios in Run 1, got ${res1.totalFailed}`)
    assert.ok(res1.scenarios.length >= 90, `Expected >= 90 scenarios, got ${res1.scenarios.length}`)
    for (const s of res1.scenarios) {
      assert.deepStrictEqual(s.actual, s.expected, `Scenario ${s.id} failed strict deep equality`)
    }
  })

  test("Run 2: Evaluate all recovery scenarios and prove determinism", async () => {
    const res1 = await runRecoveryEvaluation()
    const res2 = await runRecoveryEvaluation()

    assert.strictEqual(res2.totalFailed, 0, `Expected 0 failed scenarios in Run 2, got ${res2.totalFailed}`)
    assert.strictEqual(res1.scenarios.length, res2.scenarios.length, "Scenario counts must match between runs")

    // Deep equality comparison across all scenarios
    for (let i = 0; i < res1.scenarios.length; i++) {
      const s1 = res1.scenarios[i]!
      const s2 = res2.scenarios[i]!

      assert.strictEqual(s1.id, s2.id, `Scenario ID mismatch at ${i}`)
      assert.strictEqual(s1.category, s2.category, `Category mismatch at ${i}`)
      assert.strictEqual(s1.passed, s2.passed, `Pass boolean mismatch at ${i}`)
      assert.deepStrictEqual(s1.expected, s2.expected, `Expected mismatch at ${i}`)
      assert.deepStrictEqual(s1.actual, s2.actual, `Actual mismatch at ${i}`)
      assert.deepStrictEqual(s2.actual, s2.expected, `Scenario ${s2.id} in Run 2 failed strict deep equality`)
    }
  })
})
