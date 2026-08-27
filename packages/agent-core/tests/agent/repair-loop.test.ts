import test from "node:test"
import assert from "node:assert/strict"
import { classifyFailure } from "../../src/agent/failure-classification.ts"
import { mapFailureToInvestigation } from "../../src/agent/repair-mapping.ts"
import type { VerificationResult } from "../../src/tools/verification-contracts.ts"

test("Failure Classification - LINT_ERROR extraction", () => {
  const result: VerificationResult = {
    status: "FAIL",
    exitCode: 1,
    stdout: "src/tools/kill-process-tree.ts:12:14: error eslint(no-unused-vars)",
    stderr: "",
    durationMs: 100
  }
  const classification = classifyFailure("LINT", result)
  assert.equal(classification.category, "LINT_ERROR")
  assert.equal(classification.failedFiles.length, 1)
  assert.ok(classification.failedFiles.includes("src/tools/kill-process-tree.ts"))
})

test("Failure Classification - TEST_FAILURE extraction", () => {
  const result: VerificationResult = {
    status: "FAIL", exitCode: 1,
    stdout: "# Subtest: Verification Engine - Timeout\nnot ok 172 - Verification Engine - Timeout\n  location: '/Users/test/tests/tools/verification.test.ts:1:3600'\n  error: 'FAIL'",
    stderr: "", durationMs: 100
  }
  const classification = classifyFailure("TEST", result)
  assert.equal(classification.category, "TEST_FAILURE")
  assert.ok(classification.failedFiles[0]?.includes("verification.test.ts"))
})

test("Failure Mapping - Generates correct instructions for TYPE_ERROR", () => {
  const result: VerificationResult = {
    status: "FAIL", exitCode: 1,
    stdout: "src/agent/runner.ts:45:2 - error TS2322: Type 'string' is not assignable to type 'number'.",
    stderr: "", durationMs: 100
  }
  const classification = classifyFailure("TYPECHECK", result)
  const mapping = mapFailureToInvestigation(classification)
  assert.ok(mapping.systemPrompt.includes("compiler errors"))
  assert.ok(mapping.instruction.includes("src/agent/runner.ts"))
})

test("Failure Classification - BUILD_FAILURE extraction", () => {
  const result: VerificationResult = {
    status: "FAIL", exitCode: 1,
    stdout: "src/index.ts:10:1 - error TS1005: ';' expected.",
    stderr: "Build failed.", durationMs: 100
  }
  const classification = classifyFailure("BUILD", result)
  assert.equal(classification.category, "BUILD_FAILURE")
  assert.ok(classification.failedFiles.includes("src/index.ts"))
})

test("Failure Classification - RUNTIME_CRASH extraction", () => {
  const result: VerificationResult = {
    status: "EXECUTION_ERROR", exitCode: null,
    stdout: "",
    stderr: "Error: command failed to spawn", durationMs: 0
  }
  const classification = classifyFailure("TEST", result)
  assert.equal(classification.category, "RUNTIME_CRASH")
})

test("Failure Mapping - Generates correct instructions for LINT_ERROR", () => {
  const classification = classifyFailure("LINT", { status: "FAIL", exitCode: 1, stdout: "app.ts:1:1 error: missing semi", stderr: "", durationMs: 1 })
  const mapping = mapFailureToInvestigation(classification)
  assert.ok(mapping.systemPrompt.includes("linter warnings"))
  assert.ok(mapping.instruction.includes("app.ts"))
})

test("Failure Mapping - Generates correct instructions for TEST_FAILURE", () => {
  const classification = classifyFailure("TEST", { status: "FAIL", exitCode: 1, stdout: "test.js:10 failed", stderr: "", durationMs: 1 })
  const mapping = mapFailureToInvestigation(classification)
  assert.ok(mapping.systemPrompt.includes("failing tests"))
})

test("Failure Mapping - Generates correct instructions for BUILD_FAILURE", () => {
  const classification = classifyFailure("BUILD", { status: "FAIL", exitCode: 1, stdout: "tsc failed", stderr: "", durationMs: 1 })
  const mapping = mapFailureToInvestigation(classification)
  assert.ok(mapping.systemPrompt.includes("build and compilation errors"))
})

test("Failure Mapping - Generates correct instructions for RUNTIME_CRASH", () => {
  const classification = classifyFailure("TEST", { status: "EXECUTION_ERROR", exitCode: 1, stdout: "segfault", stderr: "", durationMs: 1 })
  const mapping = mapFailureToInvestigation(classification)
  assert.ok(mapping.systemPrompt.includes("runtime or unknown error"))
})

test("Failure Mapping - Fallback UNKNOWN", () => {
  const classification = classifyFailure("UNKNOWN", { status: "FAIL", exitCode: 1, stdout: "mystery", stderr: "", durationMs: 1 })
  const mapping = mapFailureToInvestigation(classification)
  assert.equal(classification.category, "UNKNOWN")
  assert.ok(mapping.systemPrompt.includes("runtime or unknown error"))
})
