import assert from "node:assert/strict"
import test from "node:test"
import { assessCodingCompletion } from "../../src/agent/tool-contract.ts"

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
