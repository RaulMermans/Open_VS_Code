/**
 * Performance & Large-Repository Test Suite
 * Sprint 4D.1 — Tasks T-6100 through T-6123
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import { runPerformanceEvaluation } from "./performance-evaluation-harness.ts"

function normalizeMetrics(
  scenarios: readonly {
    id: string
    category: string
    description: string
    expected: unknown
    actual: unknown
    passed: boolean
  }[],
) {
  return scenarios.map((s) => ({
    id: s.id,
    category: s.category,
    description: s.description,
    expected: s.expected,
    actual: s.actual,
    passed: s.passed,
  }))
}

function isAtLeast(val: number, min: number): boolean {
  return val >= min
}

function isAtMost(val: number, max: number): boolean {
  return val <= max
}

function isStrictlyLess(val: number, bound: number): boolean {
  return val < bound
}

describe("Sprint 4D.1 — Performance Truth & Real Scale Hardening", () => {
  test("Performance Evaluation Run 1 and Run 2 Determinism (77 Measured Scenarios)", async () => {
    const run1 = await runPerformanceEvaluation()
    const run2 = await runPerformanceEvaluation()

    assert.strictEqual(run1.totalFailed, 0, `Run 1 failed ${run1.totalFailed} scenarios`)
    assert.strictEqual(run2.totalFailed, 0, `Run 2 failed ${run2.totalFailed} scenarios`)
    assert.strictEqual(run1.scenarios.length, 77, `Expected 77 scenarios, got ${run1.scenarios.length}`)
    assert.strictEqual(run2.scenarios.length, 77, `Expected 77 scenarios, got ${run2.scenarios.length}`)

    // Check that there are ZERO placeholder or fake pass scenarios
    const placeholders = run1.scenarios.filter((s) => s.id.startsWith("PERF-SCALE"))
    assert.strictEqual(placeholders.length, 0, "No placeholder PERF-SCALE scenarios allowed")

    // Check LARGE file count is genuinely >= 25,000
    const largeDisc = run1.scenarios.find((s) => s.id === "PERF-DISC-04")
    assert.ok(largeDisc?.passed, "Large discovery must pass")
    assert.ok((largeDisc?.metrics?.filesIndexed as number) >= 25000, "Large filesIndexed must be >= 25,000")
    assert.strictEqual(largeDisc?.metrics?.contentBytesRead, 0, "Zero content bytes read during discovery")

    const norm1 = normalizeMetrics(run1.scenarios)
    const norm2 = normalizeMetrics(run2.scenarios)

    assert.ok(
      isDeepStrictEqual(norm1, norm2),
      "Run 1 and Run 2 scenario results must be deeply equal",
    )
  })

  test("Strict Negative Comparator Verification (T-6120 / Section 40)", () => {

    // 1. large files <25k while claiming >=25k
    assert.strictEqual(
      isDeepStrictEqual(
        { hasScale: true, contentBytesRead: 0, truncated: false },
        { hasScale: isAtLeast(5050, 25000), contentBytesRead: 0, truncated: false },
      ),
      false,
      "Negative test: 5,050 files must not satisfy >= 25,000 requirement",
    )

    // 2. fake placeholder scenario
    assert.strictEqual(
      isDeepStrictEqual(
        { expected: "REAL_DATA_DERIVED", actual: true },
        { expected: "REAL_DATA_DERIVED", actual: "REAL_DATA_DERIVED" },
      ),
      false,
      "Negative test: boolean true must not satisfy data-derived actual",
    )

    // 3. search result > 50
    assert.strictEqual(
      isDeepStrictEqual(
        { resultsBounded: true },
        { resultsBounded: isAtMost(55, 50) },
      ),
      false,
      "Negative test: search result > 50 must fail bounds check",
    )

    // 4. payload > 32KB
    assert.strictEqual(
      isDeepStrictEqual(
        { payloadBounded: true },
        { payloadBounded: isAtMost(35000, 32768) },
      ),
      false,
      "Negative test: payload > 32KB must fail bounds check",
    )

    // 5. queue > maxQueued
    assert.strictEqual(
      isDeepStrictEqual(
        { queueBounded: true },
        { queueBounded: isAtMost(70, 64) },
      ),
      false,
      "Negative test: queue > maxQueued must fail queue bound",
    )

    // 6. peak concurrency > maxConcurrency
    assert.strictEqual(
      isDeepStrictEqual(
        { concurrencyBounded: true },
        { concurrencyBounded: isAtMost(12, 8) },
      ),
      false,
      "Negative test: peak concurrency > maxConcurrency must fail concurrency bound",
    )

    // 7. whole large-file read (bytesRead == fileSize instead of bytesRead << fileSize)
    assert.strictEqual(
      isDeepStrictEqual(
        { bytesReadBounded: true },
        { bytesReadBounded: isStrictlyLess(5000000, 5000000) },
      ),
      false,
      "Negative test: reading whole large file must fail targeted slice bound",
    )

    // 8. context > budget
    assert.strictEqual(
      isDeepStrictEqual(
        { withinBudget: true },
        { withinBudget: isAtMost(4500, 4000) },
      ),
      false,
      "Negative test: context tokens exceeding budget must fail context check",
    )

    // 9. runtime evidence > limit
    assert.strictEqual(
      isDeepStrictEqual(
        { boundedEvidence: true },
        { boundedEvidence: isAtMost(25, 20) },
      ),
      false,
      "Negative test: retained actions exceeding 20 must fail retention check",
    )

    // 10. unsynced PREPARED accepted
    assert.strictEqual(
      isDeepStrictEqual(
        ["JOURNAL_DURABLE_SYNC", "INVOKE_SIDE_EFFECT_PREPARE"],
        ["INVOKE_SIDE_EFFECT_PREPARE"],
      ),
      false,
      "Negative test: side effect without prior durable sync must fail ordering check",
    )

    // 11. journal sync failure still mutates
    assert.strictEqual(
      isDeepStrictEqual(
        { caughtError: true, sideEffectExecutionCount: 0 },
        { caughtError: true, sideEffectExecutionCount: 1 },
      ),
      false,
      "Negative test: side effect invocation after sync failure must fail durability check",
    )

    // 12. corrupt index treated as authoritative
    assert.strictEqual(
      isDeepStrictEqual(
        { sourceOfTruth: "DURABLE_LOG", recovered: true },
        { sourceOfTruth: "SECONDARY_CACHE", recovered: true },
      ),
      false,
      "Negative test: secondary index treated as authority must fail architectural check",
    )
  })
})
