/**
 * Sprint 4B — Runtime Evals & Adaptive Control Evaluation Suite.
 *
 * Requirements:
 * - >= 70 strict scenarios in runRuntimeEvalEvaluation()
 * - Zero boolean proxy passes (assert.deepStrictEqual on actual vs expected)
 * - Two-run determinism (Run 1 == Run 2 via assert.deepStrictEqual)
 * - Negative comparator tests proving comparator fails on discrepancies
 * - Zero real model downloads (GGUF = 0, Safetensors = 0, cloud calls = 0, paid calls = 0, real inference = 0)
 * - Node >= 22
 */

import assert from "node:assert/strict"
import test, { describe } from "node:test"

import {
  runRuntimeEvalEvaluation,
  assertRuntimeEvalScenario,
  type RuntimeEvalScenarioResult,
} from "./evaluation.ts"

describe("Runtime Evaluation — Sprint 4B", () => {
  describe("Strict Comparator Negative Tests", () => {
    test("fails when actual decision does not match expected decision", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.decision",
        category: "NEGATIVE_TEST",
        description: "Negative test for mismatched decision",
        actual: { decision: "CONTINUE", confidence: 1 },
        expected: { decision: "VERIFY", confidence: 1 },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })

    test("fails when expected field is missing from actual result", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.missing_field",
        category: "NEGATIVE_TEST",
        description: "Negative test for missing field in actual",
        actual: { decision: "CONTINUE" },
        expected: { decision: "CONTINUE", confidence: 1 },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })

    test("fails when score value mismatches", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.score_mismatch",
        category: "NEGATIVE_TEST",
        description: "Negative test for score mismatch",
        actual: { progress: 0.5 },
        expected: { progress: 1.0 },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })

    test("fails when security authority flag mismatches", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.safety_authority",
        category: "NEGATIVE_TEST",
        description: "Negative test for safety authority mismatch",
        actual: { safetyAuthority: 1.0 },
        expected: { safetyAuthority: 0.0 },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })

    test("fails when route hint avoidance flag mismatches", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.route_hint_avoided",
        category: "NEGATIVE_TEST",
        description: "Negative test for mismatched route hint avoidance",
        actual: { deploymentId: "dep-fast", hasHintAvoided: false },
        expected: { deploymentId: "dep-fast", hasHintAvoided: true },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })

    test("fails when context loop exceeded flag mismatches", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.context_loop_bound",
        category: "NEGATIVE_TEST",
        description: "Negative test for context loop exceeded flag",
        actual: { hasLoopExceededObservation: false, turns: 2 },
        expected: { hasLoopExceededObservation: true, turns: 2 },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })

    test("fails when intervention outcome mismatches (RESOLVED vs DEGRADED)", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.intervention_outcome",
        category: "NEGATIVE_TEST",
        description: "Negative test for intervention outcome mismatch",
        actual: { interventionOutcome: "DEGRADED" },
        expected: { interventionOutcome: "RESOLVED" },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })

    test("fails when secondDeploymentId routing evidence mismatches (expected B, actual A)", () => {
      const badResult: RuntimeEvalScenarioResult = {
        id: "neg.routing_mismatch",
        category: "NEGATIVE_TEST",
        description: "Negative test for secondDeploymentId routing mismatch",
        actual: { secondDeploymentId: "local-a", routerHintConsumed: false },
        expected: { secondDeploymentId: "local-b", routerHintConsumed: true },
      }
      assert.throws(
        () => assertRuntimeEvalScenario(badResult),
        (err: unknown) => err instanceof assert.AssertionError,
      )
    })
  })

  let run1Results: readonly RuntimeEvalScenarioResult[] = []
  let run2Results: readonly RuntimeEvalScenarioResult[] = []

  test("Runtime Evaluation Run 1", async () => {
    run1Results = await runRuntimeEvalEvaluation()
    assert.ok(run1Results.length >= 70, `Run 1 produced ${run1Results.length} scenarios (expected >= 70)`)
    for (const scenario of run1Results) {
      assertRuntimeEvalScenario(scenario)
    }
  })

  test("Runtime Evaluation Run 2", async () => {
    run2Results = await runRuntimeEvalEvaluation()
    assert.ok(run2Results.length >= 70, `Run 2 produced ${run2Results.length} scenarios (expected >= 70)`)
    for (const scenario of run2Results) {
      assertRuntimeEvalScenario(scenario)
    }
  })

  test("Determinism: Run 1 equals Run 2", () => {
    assert.strictEqual(run1Results.length, run2Results.length, "Run 1 and Run 2 scenario counts must match")
    assert.deepStrictEqual(run1Results, run2Results, "Run 1 and Run 2 must be bitwise deterministic and deep-equal")
  })

  test("All scenarios pass strict comparator assertions", () => {
    for (const scenario of run1Results) {
      assertRuntimeEvalScenario(scenario)
    }
  })

  test("Scenario count >= 70", () => {
    assert.ok(run1Results.length >= 70, `Expected at least 70 scenarios, got ${run1Results.length}`)
  })

  test("Derived scenario and category count check (T-4717)", () => {
    const distinctCategories = new Set(run1Results.map((r) => r.category))
    const allSuiteCategories = new Set([...distinctCategories, "NEGATIVE_TEST"])
    assert.ok(run1Results.length >= 70, `Expected at least 70 scenarios, got ${run1Results.length}`)
    assert.ok(distinctCategories.size >= 10, `Expected at least 10 categories, got ${distinctCategories.size}`)
    // Derive exact measured truth
    console.log(`[T-4717] Measured scenarioCount: ${run1Results.length}, distinctEvaluationCategories: ${distinctCategories.size}, totalHarnessCategories: ${allSuiteCategories.size}`)
  })
})
