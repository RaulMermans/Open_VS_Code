import assert from "node:assert/strict"
import test from "node:test"
import { environmentBlocker } from "../../src/tools/verification-registry.ts"
import { summarizeVerification } from "../../src/tools/verification-summary.ts"

const qualification = `
Test Files  1 failed (1)
Tests  5 failed | 3 passed (8)
FAIL  packages/inference/test/modelQualification.test.ts > Model Qualification > rejects the wrong alias
AssertionError: The instanceof assertion needs a constructor but undefined was given.
 ❯ packages/inference/test/modelQualification.test.ts:179:25
FAIL  packages/inference/test/modelQualification.test.ts > Model Qualification > does not call provider.chat when qualification fails
AssertionError: promise resolved "{ modelId: 'coder' }" instead of rejecting
 ❯ packages/inference/test/modelQualification.test.ts:202:7
`

test("a vitest report becomes failure groups and does not treat the binding noise as the failure", () => {
  const summary = summarizeVerification(`better-sqlite3 binding path\n${qualification}`)
  assert.equal(summary.failed, 5)
  assert.equal(summary.passed, 3)
  assert.equal(summary.groups.length, 2)
  assert.equal(summary.groups[0]?.kind, "missing_import_or_export")
  assert.match(summary.text, /Do not edit the test/)
  assert.match(summary.text, /ModelQualificationError|instanceof assertion/)
  assert.match(summary.text, /does not call provider.chat/)
  assert.deepEqual(summary.implicatedFiles, ["packages/inference/test/modelQualification.test.ts"])
  assert.equal(summary.text.includes("better-sqlite3"), false)
})

test("a missing toolchain is an environment blocker, not a code failure", () => {
  assert.match(environmentBlocker("sh: 1: vitest: not found") ?? "", /vitest is not installed/)
  const summary = summarizeVerification("No test files found")
  assert.equal(summary.groups[0]?.kind, "test_discovery")
})
