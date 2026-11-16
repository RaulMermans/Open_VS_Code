import assert from "node:assert/strict"
import test from "node:test"
import { assessCodingCompletion, requestsExistingFileEdit } from "../../src/agent/tool-contract.ts"

const named = ["src/index.ts", "src/strings.ts"]
const edit = [{ path: "src/index.ts", status: "APPLIED", at: "2026-11-16T00:00:01.000Z", operation: "patch" as const }]

function verdict(verifications: Array<{ status: string; at: string }>) {
  return assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: named,
    mutations: edit,
    verifications,
    verificationRequired: true,
    userRejectedMutation: false,
  })
}

test("a named file left unchanged does not block completion once tests pass after the applied edit", () => {
  const result = verdict([{ status: "PASS", at: "2026-11-16T00:00:02.000Z" }])
  assert.equal(result.accept, true)
  assert.match(result.summary, /Not changed \(tests pass without it\): src\/strings\.ts/)
})

test("a named file left unchanged still blocks completion when tests failed, ran before the edit, or did not run", () => {
  for (const verifications of [
    [{ status: "FAIL", at: "2026-11-16T00:00:02.000Z" }],
    [{ status: "PASS", at: "2026-11-16T00:00:00.500Z" }],
    [],
  ]) {
    const result = verdict(verifications)
    assert.equal(result.accept, false, JSON.stringify(verifications))
    assert.match(result.summary, /did not include src\/strings\.ts/)
  }
})

test("a passing run never excuses a test-only edit", () => {
  const result = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: ["src/add.ts", "test/add.test.ts"],
    mutations: [{ path: "test/add.test.ts", status: "APPLIED", at: "2026-11-16T00:00:01.000Z", operation: "patch" }],
    verifications: [{ status: "PASS", at: "2026-11-16T00:00:02.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
  })
  assert.equal(result.accept, false)
})

test("an explicit create request is satisfied by creating the named file", () => {
  assert.equal(requestsExistingFileEdit("Create src/slug.ts exporting slugify(text)."), false)
  assert.equal(requestsExistingFileEdit("Create a new Stack class in src/stack.js"), false)
  assert.equal(requestsExistingFileEdit("Fix src/add.ts so add returns the sum."), true)
  const result = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: ["src/slug.ts"],
    requireExistingFileEdit: requestsExistingFileEdit("Create src/slug.ts exporting slugify(text)."),
    mutations: [{ path: "src/slug.ts", status: "APPLIED", at: "2026-11-16T00:00:01.000Z", operation: "create" }],
    verifications: [{ status: "PASS", at: "2026-11-16T00:00:02.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
  })
  assert.equal(result.accept, true, result.summary)
})

test("a required typecheck must pass after the edit, not just the tests", () => {
  const base = {
    requiresCodeChange: true,
    explicitPaths: ["lib/format.ts"],
    mutations: [{ path: "lib/format.ts", status: "APPLIED", at: "2026-11-16T00:00:01.000Z", operation: "patch" as const }],
    verificationRequired: true,
    userRejectedMutation: false,
    additionalVerification: ["TYPECHECK"],
  }
  const testsOnly = assessCodingCompletion({ ...base, verifications: [{ status: "PASS", at: "2026-11-16T00:00:02.000Z", action: "TEST" }] })
  assert.equal(testsOnly.accept, false)
  assert.match(testsOnly.summary, /Typecheck has not run since the last edit/)
  const typeFails = assessCodingCompletion({ ...base, verifications: [{ status: "PASS", at: "2026-11-16T00:00:02.000Z", action: "TEST" }, { status: "FAIL", at: "2026-11-16T00:00:03.000Z", action: "TYPECHECK" }] })
  assert.equal(typeFails.accept, false)
  assert.equal(typeFails.failureReason, "VERIFICATION_FAILED")
  const both = assessCodingCompletion({ ...base, verifications: [{ status: "PASS", at: "2026-11-16T00:00:02.000Z", action: "TEST" }, { status: "PASS", at: "2026-11-16T00:00:03.000Z", action: "TYPECHECK" }] })
  assert.equal(both.accept, true)
})
