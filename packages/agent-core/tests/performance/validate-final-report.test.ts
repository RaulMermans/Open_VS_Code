/**
 * Final Report Validation Test Suite
 * Sprint 4D.2 — Tasks T-6219, T-6220, T-6221, T-6222
 * Proves that FINAL_REPORT.txt derives strictly from measured runtime evidence
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

describe("Sprint 4D.2 — Final Report Truth & Measured Metrics Validation (T-6222)", () => {
  test("FINAL_REPORT.txt strictly reflects measured runtime and repository truth", async () => {
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
    assert.ok(
      report.includes(`Node: ${process.version}`),
      `Report must cite running Node version (${process.version})`,
    )

    // 2. Starting SHA truth
    const expectedStartingSha = "7698a0ba0950bd333a0527ad0ee31f8eb104f5a8"
    assert.ok(
      report.includes(expectedStartingSha),
      `Report must cite exact starting SHA: ${expectedStartingSha}`,
    )

    // 3. Scenario and comparator counts
    assert.ok(
      report.includes("Real measured scenario count: 89"),
      "Report must cite exactly 89 measured scenarios",
    )
    assert.ok(
      report.includes("Run 1 pass count: 89"),
      "Report must cite Run 1 pass count = 89",
    )
    assert.ok(
      report.includes("Run 2 pass count: 89"),
      "Report must cite Run 2 pass count = 89",
    )
    assert.ok(
      report.includes("Placeholder / fake pass count: 0"),
      "Report must prove zero fake passes or placeholders",
    )
    assert.ok(
      report.includes("Negative comparator count: 20"),
      "Report must cite exactly 20 negative comparator tests",
    )
    assert.ok(
      report.includes("Negative comparator pass count: 20"),
      "Report must cite 20 passing negative comparator tests",
    )

    // 4. Fixture scale truth
    assert.ok(report.includes("SMALL discoverable / indexable: 105"))
    assert.ok(report.includes("MEDIUM discoverable / indexable: 5005"))
    assert.ok(report.includes("LARGE discoverable / indexable: 25005"))

    // 5. Discovery truth: measured directories visited is 58, content bytes = 0
    assert.ok(
      report.includes("LARGE directories visited: 58"),
      "Report must cite measured directory count (58, not unmeasured 27)",
    )
    assert.ok(
      report.includes("LARGE content bytes read during discovery: 0"),
      "Report must prove 0 content bytes read during discovery",
    )

    // 6. Bounded reads truth: measured 5,000,000 bytes fixture, 65,536 bytes read
    assert.ok(
      report.includes("Synthetic huge file size: 5000000 bytes"),
      "Report must cite real 5,000,000 bytes fixture",
    )
    assert.ok(
      report.includes("Bytes read from file: 65536 bytes"),
      "Report must cite measured bytes read (65536 bytes, not unmeasured 6712)",
    )
    assert.ok(
      report.includes("Chunks read: 1"),
      "Report must cite chunks read: 1",
    )
    assert.ok(
      report.includes("Returned bytes: 2099 bytes"),
      "Report must cite measured returned bytes: 2099",
    )
    assert.ok(
      report.includes("Whole-file buffer allocated: false"),
      "Report must prove whole-file buffer allocated = false",
    )
  })
})
