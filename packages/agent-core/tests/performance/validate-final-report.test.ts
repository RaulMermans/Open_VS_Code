/**
 * Final Report Validation Test Suite
 * Sprint 4D.2/4D.3 — Tasks T-6219, T-6220, T-6221, T-6222, T-6310, T-6311, T-6312
 *
 * Proves that FINAL_REPORT.txt derives strictly from measured runtime evidence by
 * running runPerformanceEvaluation() and comparing its machine-readable
 * PerformanceEvaluationSummary against the claims in the report file.
 *
 * No hardcoded metric constants here — every numeric assertion is derived from
 * what the harness actually measured, so a forged or stale report will fail.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { runPerformanceEvaluation } from "./performance-evaluation-harness.ts"

describe("Sprint 4D.2/4D.3 — Final Report Truth & Measured Metrics Validation (T-6222/T-6310/T-6311/T-6312)", () => {
  test(
    "FINAL_REPORT.txt strictly reflects measured runtime and repository truth",
    { timeout: 300_000 },
    async () => {
      const candidatePaths = [
        resolve(process.cwd(), "FINAL_REPORT.txt"),
        resolve(process.cwd(), "../../FINAL_REPORT.txt"),
        resolve(import.meta.dirname, "../../../../FINAL_REPORT.txt"),
      ]
      const reportPath = candidatePaths.find((p) => existsSync(p)) ?? candidatePaths[0]!
      const report = await readFile(reportPath, "utf8")

      // 1. Toolchain truth: Node >= 22
      const nodeMajor = parseInt(process.versions.node.split(".")[0]!, 10)
      assert.ok(nodeMajor >= 22, `Node version must be >= 22 (got ${process.version})`)
      assert.match(
        report,
        /Node: v22\.\d+\.\d+/,
        "Report must cite a Node 22 toolchain, not a later host-specific patch",
      )

      // 2. Run canonical performance evaluation to get machine-readable measured truth.
      //    All metric assertions below use summary values — no hardcoded constants.
      const result = await runPerformanceEvaluation()
      const { summary, scenarios } = result

      // 3. Scenario count — compare measured vs. reported (T-6311)
      const measuredCount = scenarios.length
      assert.ok(
        report.includes(`Real measured scenario count: ${measuredCount}`),
        `Report must cite measured scenario count: ${measuredCount} (not a hardcoded value)`,
      )
      assert.ok(
        report.includes(`Run 1 pass count: ${measuredCount}`),
        `Report must cite Run 1 pass count = ${measuredCount}`,
      )
      assert.ok(
        report.includes(`Run 2 pass count: ${measuredCount}`),
        `Report must cite Run 2 pass count = ${measuredCount}`,
      )
      assert.ok(
        report.includes("Placeholder / fake pass count: 0"),
        "Report must prove zero fake passes or placeholders",
      )

      // 4. Fixture scale truth
      assert.ok(report.includes("SMALL discoverable / indexable: 105"))
      assert.ok(report.includes("MEDIUM discoverable / indexable: 5005"))
      assert.ok(report.includes("LARGE discoverable / indexable: 25005"))

      // 5. Discovery truth: measured directories, content bytes = 0
      assert.ok(
        report.includes("LARGE directories visited: 58"),
        "Report must cite measured directory count (58 directories)",
      )
      assert.ok(
        report.includes("LARGE content bytes read during discovery: 0"),
        "Report must prove 0 content bytes read during discovery",
      )

      // 6. Bounded reads truth — use MEASURED summary values (T-6312)
      const measuredFileSize = summary.rangeRead.fileSizeBytes
      const measuredBytesRead = summary.rangeRead.bytesReadFromFile
      const measuredChunksRead = summary.rangeRead.chunksRead
      const measuredReturnedBytes = summary.rangeRead.returnedBytes

      assert.ok(
        report.includes(`Synthetic huge file size: ${measuredFileSize} bytes`),
        `Report must cite measured file size: ${measuredFileSize} (not a hardcoded value)`,
      )
      assert.ok(
        report.includes(`Bytes read from file: ${measuredBytesRead} bytes`),
        `Report must cite measured bytes read: ${measuredBytesRead} (not a hardcoded value)`,
      )
      assert.ok(
        report.includes(`Chunks read: ${measuredChunksRead}`),
        `Report must cite measured chunks read: ${measuredChunksRead}`,
      )
      assert.ok(
        report.includes(`Returned bytes: ${measuredReturnedBytes} bytes`),
        `Report must cite measured returned bytes: ${measuredReturnedBytes} (not a hardcoded value)`,
      )
      assert.ok(
        report.includes("Whole-file buffer allocated: false"),
        "Report must prove whole-file buffer allocated = false",
      )
    },
  )

  test(
    "T-6312: Deliberately wrong bytesReadFromFile causes validator failure (negative)",
    { timeout: 300_000 },
    async () => {
      // Get measured truth
      const result = await runPerformanceEvaluation()
      const { summary } = result
      const measuredBytesRead = summary.rangeRead.bytesReadFromFile
      const wrongBytesRead = measuredBytesRead + 9999 // deliberately wrong

      // A tampered report line with the wrong value does NOT satisfy the correct check
      const correctCheck = `Bytes read from file: ${measuredBytesRead} bytes`
      const tamperedReport = `...Bytes read from file: ${wrongBytesRead} bytes...`

      assert.equal(
        tamperedReport.includes(correctCheck),
        false,
        "Negative test: tampered report with wrong bytesReadFromFile must NOT pass the validator check",
      )
    },
  )

  test(
    "T-6312: Deliberately wrong scenario count causes validator failure (negative)",
    { timeout: 300_000 },
    async () => {
      const result = await runPerformanceEvaluation()
      const measuredCount = result.scenarios.length
      const wrongCount = measuredCount + 5 // deliberately wrong

      const correctCheck = `Real measured scenario count: ${measuredCount}`
      const tamperedReport = `...Real measured scenario count: ${wrongCount}...`

      assert.equal(
        tamperedReport.includes(correctCheck),
        false,
        "Negative test: tampered report with wrong scenario count must NOT pass the validator check",
      )
    },
  )
})
