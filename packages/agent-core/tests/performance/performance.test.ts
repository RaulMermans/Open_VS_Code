/**
 * Performance & Large-Repository Test Suite
 * Sprint 4D — Tasks T-6000 through T-6040
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import { runPerformanceEvaluation } from "./performance-evaluation-harness.ts"

function normalizeMetrics(scenarios: readonly { id: string; category: string; description: string; expected: unknown; actual: unknown; passed: boolean }[]) {
  return scenarios.map((s) => ({
    id: s.id,
    category: s.category,
    description: s.description,
    expected: s.expected,
    actual: s.actual,
    passed: s.passed,
  }))
}

describe("Sprint 4D — Performance & Large-Repository Hardening", () => {
  test("Performance Evaluation Run 1 and Run 2 Determinism (80 Scenarios)", async () => {
    const run1 = await runPerformanceEvaluation()
    const run2 = await runPerformanceEvaluation()

    assert.strictEqual(run1.totalFailed, 0, `Run 1 failed ${run1.totalFailed} scenarios`)
    assert.strictEqual(run2.totalFailed, 0, `Run 2 failed ${run2.totalFailed} scenarios`)
    assert.ok(run1.scenarios.length >= 70, `Expected at least 70 scenarios, got ${run1.scenarios.length}`)

    const norm1 = normalizeMetrics(run1.scenarios)
    const norm2 = normalizeMetrics(run2.scenarios)

    assert.ok(
      isDeepStrictEqual(norm1, norm2),
      "Run 1 and Run 2 scenario results must be deeply equal",
    )
  })

  test("Negative Comparator Verification", () => {
    // Deliberate negative tests to prove comparator fails on invalid values
    assert.strictEqual(isDeepStrictEqual({ count: 10 }, { count: 20 }), false)
    assert.strictEqual(isDeepStrictEqual({ truncated: true }, { truncated: false }), false)
    assert.strictEqual(isDeepStrictEqual({ overflow: false }, { overflow: true }), false)
  })
})
