import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { runModelIntegrationEvaluation } from "./model-integration-eval.ts"

describe("Sprint 4E — Model Integration Evaluation", () => {
  test("Run 1: all scenarios pass with no fake passes", async () => {
    const summary = await runModelIntegrationEvaluation()

    // Report failures for diagnostics
    const failures = summary.results.filter(r => !r.passed)
    if (failures.length > 0) {
      const details = failures.map(f => `  FAIL ${f.id}: ${f.description}\n    actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}${f.error ? ` error=${f.error}` : ""}`).join("\n")
      assert.fail(`${failures.length} scenario(s) failed:\n${details}`)
    }

    assert.ok(summary.totalScenarios >= 50, `Expected >= 50 meaningful scenarios, got ${summary.totalScenarios}`)
    assert.equal(summary.failed, 0, "Zero failures expected")
    assert.equal(summary.passed, summary.totalScenarios, "All scenarios must pass")

    // Verify categories
    const requiredCategories = [
      "fim_formatting",
      "fim_stop_tokens",
      "fim_provider",
      "fim_http",
      "fim_cancellation",
      "ledger",
      "ledger_persistence",
      "ledger_privacy",
      "inference_gate",
      "health",
      "no_cloud_fallback",
      "autocomplete_context",
      "provider_safety",
      "adaptive_routing",
    ]
    for (const cat of requiredCategories) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(summary.categories, cat),
        `Missing required category: ${cat}`,
      )
      assert.equal(
        summary.categories[cat]?.passed,
        summary.categories[cat]?.total,
        `Category ${cat} has failures`,
      )
    }
  })

  test("Run 2: deterministic — results identical to Run 1", async () => {
    const run1 = await runModelIntegrationEvaluation()
    const run2 = await runModelIntegrationEvaluation()

    assert.equal(run2.totalScenarios, run1.totalScenarios, "Scenario count must be identical")
    assert.equal(run2.passed, run1.passed, "Pass count must be identical")
    assert.equal(run2.failed, run1.failed, "Fail count must be identical")

    // Deep equality on all scenario IDs and pass/fail
    for (let i = 0; i < run1.results.length; i++) {
      const r1 = run1.results[i]!
      const r2 = run2.results[i]!
      assert.equal(r2.id, r1.id, `Scenario ${i} ID mismatch`)
      assert.equal(r2.passed, r1.passed, `Scenario ${r1.id} pass/fail changed between runs`)
    }
  })
})
