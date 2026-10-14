/**
 * Sprint 5C deterministic unit tests: fingerprints, progress deltas, monitor signals and
 * failure classification (ADR-031).
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import type { ProgressSnapshot } from "../../src/progress/contracts.ts"
import { DirectProgressGuard } from "../../src/progress/direct-guard.ts"
import { errorFingerprint, normalizeFailureOutput, parseTestCounts, setFingerprint, toolFingerprint } from "../../src/progress/fingerprint.ts"
import { ProgressMonitor, compareSnapshots, isProgress } from "../../src/progress/monitor.ts"
import { buildRecoveryPlan, classifyStall, runDiagnosticCheck } from "../../src/progress/recovery.ts"

function snap(point: ProgressSnapshot["point"], patch: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return { workflowId: "wf", stage: point === "MUTATION" ? "IMPLEMENT" : point === "START" ? "PLAN" : (point as ProgressSnapshot["stage"]), point, changedFileHashes: {}, timestamp: "t", ...patch }
}

const failing = (fingerprint: string, count = 1) => snap("TEST", { testFingerprint: setFingerprint([fingerprint])!, failingCheckCount: count })

// ---- 1, 2: tool fingerprints --------------------------------------------------------------------

test("P-01: an identical tool action (same tool, normalized args, same result) is detected", () => {
  assert.equal(toolFingerprint("run_test", { name: "A", flags: { watch: false } }), toolFingerprint("run_test", { flags: { watch: false }, name: "A" }), "argument order is normalized")
  const guard = new DirectProgressGuard()
  assert.deepEqual(guard.observeTool({ name: "search_text", args: { query: "x" }, ok: true, content: "no matches" }), [])
  const signals = guard.observeTool({ name: "search_text", args: { query: "x" }, ok: true, content: "no matches" })
  assert.equal(signals[0]?.kind, "REPEATED_TOOL_ACTION")
  assert.equal(signals[0]?.count, 2)
})

test("P-02: different tool arguments do not false-trigger", () => {
  assert.notEqual(toolFingerprint("run_test", { name: "A" }), toolFingerprint("run_test", { name: "B" }))
  const guard = new DirectProgressGuard()
  for (const name of ["A", "B", "C", "D"]) assert.deepEqual(guard.observeTool({ name: "read_file", args: { path: `${name}.ts` }, ok: true, content: `content of ${name}` }), [])
})

test("P-02b: secret arguments are redacted before fingerprinting", () => {
  assert.equal(toolFingerprint("t", { auth: "token=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" }), toolFingerprint("t", { auth: "token=ghp_ZZZZC3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" }))
})

// ---- 3, 4, 5: error fingerprints ----------------------------------------------------------------

test("P-03: a repeated identical error after a different attempt is detected", () => {
  const guard = new DirectProgressGuard()
  assert.deepEqual(guard.observeTool({ name: "apply_patch", args: { search: "a" }, ok: false, content: "search text not found", errorCategory: "MUTATION_ERROR" }), [])
  const signals = guard.observeTool({ name: "apply_patch", args: { search: "b" }, ok: false, content: "search text not found", errorCategory: "MUTATION_ERROR" })
  assert.equal(signals[0]?.kind, "REPEATED_ERROR")
})

test("P-04: the same failure with different timestamps, durations, temp paths, ports, ids and ANSI codes fingerprints the same", () => {
  const a = "\u001b[31m✖ subtract (12ms)\u001b[0m\n2026-01-01T10:00:00.123Z AssertionError: expected 2, got -2\n at /tmp/ovsc-abc/src/math.test.ts:12:5 port 54321 request-id: 7f3a9c pid 4242"
  const b = "✖ subtract (98ms)\n2026-03-05T22:14:59.999Z AssertionError: expected 2, got -2\n at /tmp/ovsc-xyz/src/math.test.ts:40:9 port 61000 request-id: 0b1c2d pid 99"
  assert.equal(errorFingerprint(a), errorFingerprint(b))
  assert.ok(!normalizeFailureOutput(a).includes("\u001b"))
})

test("P-04b: node:test TAP duration footers do not split identical failures", () => {
  assert.equal(errorFingerprint("not ok 1 - subtract\n# fail 1\n# duration_ms 12.345"), errorFingerprint("not ok 1 - subtract\n# fail 1\n# duration_ms 98.1"))
  assert.notEqual(errorFingerprint("not ok 1 - subtract\n# fail 1"), errorFingerprint("not ok 1 - subtract\n# fail 2"), "counts still distinguish")
})

test("P-05: a different assertion keeps a different fingerprint", () => {
  assert.notEqual(errorFingerprint("AssertionError: expected 2, got -2"), errorFingerprint("AssertionError: expected 2, got 8"))
  assert.notEqual(errorFingerprint("✖ subtract fails"), errorFingerprint("✖ multiply fails"))
})

test("P-05b: common test summaries are parsed; unknown formats yield no guess", () => {
  assert.deepEqual(parseTestCounts("# tests 5\n# pass 2\n# fail 3\nnot ok 1 - a\nnot ok 2 - b").failed, 3)
  assert.equal(parseTestCounts("Tests:       2 failed, 3 passed, 5 total").failed, 2)
  assert.equal(parseTestCounts("  3 passing\n  1 failing").failed, 1)
  assert.equal(parseTestCounts("everything exploded").failed, undefined)
  assert.equal(parseTestCounts("not ok 1 - a\nnot ok 2 - b").failures.length, 2)
})

// ---- 6, 7, 8: test progress ---------------------------------------------------------------------

test("P-06: unchanged test failures after a repair trigger TEST_STAGNATION", () => {
  const monitor = new ProgressMonitor()
  assert.deepEqual(monitor.observe(failing("x")).signals, [])
  monitor.observe(snap("MUTATION", { diffFingerprint: "d2" }))
  const assessment = monitor.observe(failing("x"))
  assert.equal(assessment.status, "STALLED")
  assert.equal(assessment.signals[0]?.kind, "TEST_STAGNATION")
  assert.equal(assessment.confidence, "DETERMINISTIC")
  assert.equal(ProgressMonitor.request(assessment, true), "DIAGNOSE")
  assert.equal(ProgressMonitor.request(assessment, false), "BLOCK")
})

test("P-07: fewer failures counts as progress (ADVANCED), not stall", () => {
  const monitor = new ProgressMonitor()
  monitor.observe(snap("TEST", { testFingerprint: "f5", failingCheckCount: 5 }))
  const next = monitor.observe(snap("TEST", { testFingerprint: "f3", failingCheckCount: 3 }))
  assert.equal(next.status, "ADVANCED")
  assert.deepEqual(next.signals, [])
  assert.ok(next.reasons.includes("failing checks 5 → 3"))
})

test("P-08: more failures counts as regression", () => {
  assert.equal(compareSnapshots(snap("TEST", { failingCheckCount: 3, testFingerprint: "a" }), snap("TEST", { failingCheckCount: 4, testFingerprint: "b" }), "TEST").status, "REGRESSED")
  assert.equal(compareSnapshots(snap("TEST", { failingCheckCount: 0 }), snap("TEST", { failingCheckCount: 1, testFingerprint: "b" }), "TEST").status, "REGRESSED", "previously passing check now fails")
})

// ---- 9, 10: diff progress -----------------------------------------------------------------------

test("P-09: a no-op write does not count as progress", () => {
  const monitor = new ProgressMonitor()
  monitor.observe(snap("START", { diffFingerprint: "empty" }))
  const assessment = monitor.observe(snap("MUTATION", { diffFingerprint: "empty" }))
  assert.equal(assessment.status, "STALLED")
  assert.equal(assessment.signals[0]?.kind, "DIFF_STAGNATION")
  const guard = new DirectProgressGuard()
  guard.observeTool({ name: "write_file", args: { path: "a.ts" }, ok: true, content: "ok", mutation: { path: "a.ts", beforeHash: "h1", afterHash: "h1" } })
  assert.equal(guard.observeTool({ name: "write_file", args: { path: "a.ts", n: 2 }, ok: true, content: "ok", mutation: { path: "a.ts", beforeHash: "h1", afterHash: "h1" } })[0]?.kind, "DIFF_STAGNATION")
})

test("P-10: a meaningful one-line diff counts as progress", () => {
  const monitor = new ProgressMonitor()
  monitor.observe(snap("START", { diffFingerprint: "empty" }))
  const assessment = monitor.observe(snap("MUTATION", { diffFingerprint: "one-char-fix" }))
  assert.ok(isProgress(assessment.status), assessment.status)
  assert.deepEqual(assessment.signals, [])
})

// ---- 11, 12, 13, 14: review, verification, stage advance ----------------------------------------

test("P-11: the same review blocker after a repair triggers REVIEW_STAGNATION", () => {
  const monitor = new ProgressMonitor()
  monitor.observe(snap("REVIEW", { blockerCount: 1, reviewFingerprint: "b1" }))
  const assessment = monitor.observe(snap("REVIEW", { blockerCount: 1, reviewFingerprint: "b1" }))
  assert.equal(assessment.signals[0]?.kind, "REVIEW_STAGNATION")
})

test("P-12: a resolved blocker counts as progress", () => {
  const monitor = new ProgressMonitor()
  monitor.observe(snap("REVIEW", { blockerCount: 2, reviewFingerprint: "b12" }))
  const assessment = monitor.observe(snap("REVIEW", { blockerCount: 0 }))
  assert.equal(assessment.status, "ADVANCED")
  assert.deepEqual(assessment.signals, [])
})

test("P-13: verification improvement counts as progress; READY → NOT_READY is a regression", () => {
  assert.equal(compareSnapshots(snap("VERIFY", { verificationState: "NOT_READY", verificationFailedChecks: 2 }), snap("VERIFY", { verificationState: "NOT_READY", verificationFailedChecks: 1 }), "VERIFY").status, "ADVANCED")
  assert.equal(compareSnapshots(snap("VERIFY", { verificationState: "NOT_READY" }), snap("VERIFY", { verificationState: "READY" }), "VERIFY").status, "ADVANCED")
  assert.equal(compareSnapshots(snap("VERIFY", { verificationState: "READY" }), snap("VERIFY", { verificationState: "NOT_READY" }), "VERIFY").status, "REGRESSED")
})

test("P-14: a stage advance resets the stall counters it leaves behind", () => {
  const monitor = new ProgressMonitor()
  monitor.observe(failing("x"))
  assert.equal(monitor.state.counters.test.count, 1)
  monitor.observe(snap("TEST", { failingCheckCount: 0 }))
  const review = monitor.observe(snap("REVIEW", { blockerCount: 0 }))
  assert.ok(review.reasons.includes("stage advanced to REVIEW"))
  assert.equal(monitor.state.counters.test.count, 0)
  assert.equal(monitor.state.counters.noAdvanceWindow, 0)
  // A later identical failure starts a fresh count instead of stalling immediately.
  assert.deepEqual(monitor.observe(failing("x")).signals, [])
})

test("P-14b: slow progress (one failure fixed per repair) never stalls; changing-but-not-improving failures do", () => {
  const slow = new ProgressMonitor()
  for (const [count, fp] of [[3, "a"], [2, "b"], [1, "c"]] as const) assert.deepEqual(slow.observe(failing(fp, count)).signals, [])
  const churn = new ProgressMonitor()
  churn.observe(failing("a"))
  churn.observe(failing("b"))
  assert.equal(churn.observe(failing("c")).signals[0]?.kind, "REPAIR_LOOP_STAGNATION")
})

test("P-14c: thresholds are internal and validated", () => {
  assert.throws(() => new ProgressMonitor({ thresholds: { sameTestAfterMutation: 1 } }), /at least 2/)
  const lenient = new ProgressMonitor({ thresholds: { sameTestAfterMutation: 3 } })
  lenient.observe(failing("x"))
  assert.deepEqual(lenient.observe(failing("x")).signals, [])
  assert.equal(lenient.observe(failing("x")).signals[0]?.kind, "TEST_STAGNATION")
})

test("P-14d: context burn needs several tool turns without new evidence", () => {
  const guard = new DirectProgressGuard()
  guard.observeTool({ name: "read_file", args: { path: "a" }, ok: true, content: "A" })
  assert.deepEqual(guard.endTurn(), [], "a turn with new evidence")
  guard.observeTool({ name: "read_file", args: { path: "b" }, ok: true, content: "A" })
  assert.deepEqual(guard.endTurn(), [])
  guard.observeTool({ name: "read_file", args: { path: "c" }, ok: true, content: "A" })
  assert.deepEqual(guard.endTurn(), [])
  guard.observeTool({ name: "read_file", args: { path: "d" }, ok: true, content: "A" })
  assert.equal(guard.endTurn()[0]?.kind, "CONTEXT_BURN")
})

// ---- 19, 20: classification ---------------------------------------------------------------------

const testStall = [{ kind: "TEST_STAGNATION" as const, count: 2, threshold: 2, pattern: "same failing check" }]

test("P-19: a permission block is classified PERMISSION_BLOCK and never retried", async () => {
  const capture = { stage: "TEST" as const, signals: testStall, permissionOutcome: "DENIED" as const }
  const pre = classifyStall(capture)
  assert.equal(pre.failureClass, "PERMISSION_BLOCK")
  assert.equal(pre.check, "PERMISSION_OUTCOME")
  const plan = buildRecoveryPlan({ capture, preliminary: pre, result: await runDiagnosticCheck(pre.check, { capture }), budgetAvailable: true })
  assert.equal(plan.retryAllowed, false)
  assert.match(plan.escalationReason!, /cannot be fixed by retrying/)
})

test("P-20: an unavailable service is ENVIRONMENT_FAILURE (local) or EXTERNAL_BLOCKER (remote, never probed)", async () => {
  const local = { stage: "TEST" as const, signals: testStall, failureText: "Error: connect ECONNREFUSED 127.0.0.1:5432" }
  const pre = classifyStall(local)
  assert.equal(pre.failureClass, "ENVIRONMENT_FAILURE")
  assert.equal(pre.check, "ENDPOINT_PROBE")
  const probed: string[] = []
  const down = await runDiagnosticCheck(pre.check, { capture: local, probe: async (endpoint) => (probed.push(`${endpoint.host}:${endpoint.port}`), false) })
  assert.equal(down.refinedClass, "ENVIRONMENT_FAILURE")
  assert.deepEqual(probed, ["127.0.0.1:5432"], "probed exactly once")
  assert.equal(buildRecoveryPlan({ capture: local, preliminary: pre, result: down, budgetAvailable: true }).retryAllowed, false)

  const remote = { stage: "TEST" as const, signals: testStall, failureText: "FetchError: request to https://api.example.com:443/v1 failed, reason: getaddrinfo ENOTFOUND api.example.com" }
  const remotePre = classifyStall(remote)
  assert.equal(remotePre.failureClass, "EXTERNAL_BLOCKER")
  const result = await runDiagnosticCheck(remotePre.check, { capture: remote, probe: async () => assert.fail("external hosts are never probed") })
  assert.equal(result.refinedClass, "EXTERNAL_BLOCKER")
})

test("P-20b: logic, state, tool and context failures classify from bounded evidence; ambiguity escalates", async () => {
  assert.equal(classifyStall({ stage: "TEST", signals: testStall, failureText: "AssertionError: expected 2, got -2" }).failureClass, "LOGIC_FAILURE")
  assert.equal(classifyStall({ stage: "IMPLEMENT", signals: [{ kind: "DIFF_STAGNATION", count: 2, threshold: 2, pattern: "" }] }).failureClass, "STATE_MISMATCH")
  assert.equal(classifyStall({ stage: "DIRECT", signals: [{ kind: "REPEATED_ERROR", count: 2, threshold: 2, pattern: "" }], toolErrorCategories: ["INVALID_ARGUMENTS"] }).failureClass, "TOOL_FAILURE")
  assert.equal(classifyStall({ stage: "DIRECT", signals: [{ kind: "REPEATED_TOOL_ACTION", count: 2, threshold: 2, pattern: "" }] }).failureClass, "CONTEXT_DEGRADATION")
  // Ambiguous: the local probe finds the service up, so the ECONNREFUSED hypothesis is not confirmed.
  const capture = { stage: "TEST" as const, signals: testStall, failureText: "connect ECONNREFUSED localhost:8080" }
  const pre = classifyStall(capture)
  const plan = buildRecoveryPlan({ capture, preliminary: pre, result: await runDiagnosticCheck(pre.check, { capture, probe: async () => true }), budgetAvailable: true })
  assert.equal(plan.failureClass, "UNKNOWN")
  assert.equal(plan.retryAllowed, false)
  assert.match(plan.escalationReason!, /ambiguous/)
})
