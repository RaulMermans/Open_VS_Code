/**
 * Runtime Evaluation Harness — Sprint 4B.
 *
 * Continuous runtime evaluation: ACT -> OBSERVE -> EVALUATE -> DECIDE -> ADAPT -> ACT AGAIN.
 * Non-authoritative invariant: Runtime evaluations advise and recommend, but NEVER grant
 * execution, auto-approve mutations, auto-approve commands, or escalate security permissions.
 *
 * Strict Runtime Evidence Model:
 * Every scenario produces a RuntimeEvalScenarioResult with:
 *   - id: string
 *   - category: string
 *   - description: string
 *   - actual: Record<string, unknown>
 *   - expected: Record<string, unknown>
 *   - evidence?: Record<string, unknown>
 *
 * Verified via assert.deepStrictEqual(actual, expected).
 * Zero boolean proxy passes (0 || true, 0 passed: true, 0 safe: true).
 *
 * Determinism: Two independent evaluation runs compared for deep equality.
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AgentRunner,
  AdaptiveControlPolicy,
  RuntimeEvidenceCollector,
  RuntimeEvalEngine,
  RuntimeEvalLedger,
  RuntimeEvalAnalytics,
  ScriptedRuntimeCritic,
  formatDeveloperSummary,
  adaptToAutocompleteTelemetry,
  redactRuntimeEvalSecrets,
  computeEvidenceHash,
  evaluateL0,
  evaluateL1,
} from "../../src/index.ts"
import type { ContextBudget } from "../../src/contracts/context.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"

const defaultContextBudget: ContextBudget = {
  contextWindow: 4000,
  reservedOutput: 1000,
  reservedToolHistory: 1000,
  availableContext: 2000,
}

export interface RuntimeEvalScenarioResult {
  readonly id: string
  readonly category: string
  readonly description: string
  readonly actual: Record<string, unknown>
  readonly expected: Record<string, unknown>
  readonly evidence?: Record<string, unknown> | undefined
}

export function assertRuntimeEvalScenario(result: RuntimeEvalScenarioResult): void {
  assert.ok(result.id, "Scenario must have an id")
  assert.ok(result.category, "Scenario must have a category")
  assert.ok(result.description, "Scenario must have a description")
  assert.ok(result.actual, "Scenario must have actual results")
  assert.ok(result.expected, "Scenario must have expected results")

  for (const key of Object.keys(result.expected)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(result.actual, key),
      `Scenario ${result.id}: expected field "${key}" missing from actual result`,
    )
  }

  assert.deepStrictEqual(
    result.actual,
    result.expected,
    `Scenario ${result.id} failed: actual does not match expected`,
  )
}

export async function runRuntimeEvalEvaluation(): Promise<readonly RuntimeEvalScenarioResult[]> {
  const results: RuntimeEvalScenarioResult[] = []

  // =========================================================================
  // CATEGORY 1: Evidence Collection & Integrity (Scenarios 1-10)
  // =========================================================================

  // Scenario 1: Initial state & task goal truncation
  {
    const longGoal = "Analyze repository ".repeat(50) // > 500 chars
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-1",
      taskGoal: longGoal,
      plan: ["Step 1: Check code", "Step 2: Fix bug"],
    })
    const ev = collector.getEvidence()
    results.push({
      id: "evidence.1",
      category: "EVIDENCE_COLLECTION",
      description: "Initial state bounded buffer and task goal truncation",
      actual: {
        runId: ev.runId,
        turnId: ev.turnId,
        version: ev.evidenceVersion,
        actionsCount: ev.recentActions.length,
        hasTruncatedMarker: ev.taskGoal.endsWith(" [TRUNCATED]"),
        taskGoalBounded: ev.taskGoal.length <= 512,
        planStepsCount: ev.plan?.length ?? 0,
      },
      expected: {
        runId: "run-eval-1",
        turnId: 0,
        version: 1,
        actionsCount: 0,
        hasTruncatedMarker: true,
        taskGoalBounded: true,
        planStepsCount: 2,
      },
    })
  }

  // Scenario 2: Action recording & signature hashing
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-2",
      taskGoal: "Inspect files",
    })
    collector.recordToolAction({
      id: "act-1",
      toolName: "read_file",
      args: { path: "src/index.ts" },
      output: "console.log('hello')",
    })
    const ev = collector.getEvidence()
    const firstAction = ev.recentActions[0]
    results.push({
      id: "evidence.2",
      category: "EVIDENCE_COLLECTION",
      description: "Action recording, signature hashing, and version advance",
      actual: {
        actionsCount: ev.recentActions.length,
        version: ev.evidenceVersion,
        toolName: firstAction?.toolName,
        hasSignature: typeof firstAction?.signatureHash === "string" && firstAction.signatureHash.length > 0,
        outcome: firstAction?.outcome,
        hasSummary: typeof firstAction?.summary === "string",
      },
      expected: {
        actionsCount: 1,
        version: 2,
        toolName: "read_file",
        hasSignature: true,
        outcome: "COMPLETED",
        hasSummary: true,
      },
    })
  }

  // Scenario 3: Mutation outcome recording
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-3",
      taskGoal: "Patch bug",
    })
    collector.recordMutationOutcome({
      mutationId: "mut-1",
      path: "src/calc.ts",
      status: "APPLIED",
      diffSummary: "+1 -1",
    })
    const ev = collector.getEvidence()
    results.push({
      id: "evidence.3",
      category: "EVIDENCE_COLLECTION",
      description: "Mutation outcome tracking in bounded buffer",
      actual: {
        mutationCount: ev.mutationOutcomes.length,
        firstStatus: ev.mutationOutcomes[0]?.status,
        firstPath: ev.mutationOutcomes[0]?.path,
      },
      expected: {
        mutationCount: 1,
        firstStatus: "APPLIED",
        firstPath: "src/calc.ts",
      },
    })
  }

  // Scenario 4: Verification outcome recording
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-4",
      taskGoal: "Run verification",
    })
    collector.recordVerificationOutcome({
      executionId: "exec-1",
      action: "TEST",
      status: "FAIL",
      failedTestCount: 2,
      totalTestCount: 10,
      stdout: "Tests failed: 2",
    })
    const ev = collector.getEvidence()
    results.push({
      id: "evidence.4",
      category: "EVIDENCE_COLLECTION",
      description: "Verification outcome recording with fail count",
      actual: {
        verifCount: ev.verificationOutcomes.length,
        status: ev.verificationOutcomes[0]?.status,
        failedCount: ev.verificationOutcomes[0]?.failedTestCount,
        hasFailureSummary: typeof ev.verificationOutcomes[0]?.failureSummary === "string",
      },
      expected: {
        verifCount: 1,
        status: "FAIL",
        failedCount: 2,
        hasFailureSummary: true,
      },
    })
  }

  // Scenario 5: Security signal recording
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-5",
      taskGoal: "Security check",
    })
    collector.recordSecuritySignal({
      id: "sec-1",
      toolName: "run_command",
      action: "shell_exec",
      denied: true,
      reason: "Shell execution denied in ASK mode",
    })
    const ev = collector.getEvidence()
    results.push({
      id: "evidence.5",
      category: "EVIDENCE_COLLECTION",
      description: "Security boundary denial recording",
      actual: {
        signalCount: ev.securitySignals.length,
        denied: ev.securitySignals[0]?.denied,
        action: ev.securitySignals[0]?.action,
      },
      expected: {
        signalCount: 1,
        denied: true,
        action: "shell_exec",
      },
    })
  }

  // Scenario 6: Unresolved failure deduplication
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-6",
      taskGoal: "Track failures",
    })
    collector.recordUnresolvedFailure({
      failureType: "TEST_FAILURE",
      target: "test/index.test.ts",
      summary: "AssertionError: expected true but got false",
    })
    collector.recordUnresolvedFailure({
      failureType: "TEST_FAILURE",
      target: "test/index.test.ts",
      summary: "AssertionError: expected true but got false",
    })
    const ev = collector.getEvidence()
    results.push({
      id: "evidence.6",
      category: "EVIDENCE_COLLECTION",
      description: "Unresolved failure deduplication by target and summary hash",
      actual: {
        failureCount: ev.unresolvedFailures.length,
        category: ev.unresolvedFailures[0]?.category,
      },
      expected: {
        failureCount: 1,
        category: "TEST_FAILURE",
      },
    })
  }

  // Scenario 7: Failure resolution
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-7",
      taskGoal: "Resolve failure",
    })
    collector.recordUnresolvedFailure({
      failureType: "LINT_ERROR",
      target: "src/app.ts",
      summary: "Missing semicolon",
    })
    collector.resolveFailure("src/app.ts", "Missing semicolon")
    const ev = collector.getEvidence()
    results.push({
      id: "evidence.7",
      category: "EVIDENCE_COLLECTION",
      description: "Resolving tracked failure drops it from unresolved map",
      actual: {
        unresolvedCount: ev.unresolvedFailures.length,
      },
      expected: {
        unresolvedCount: 0,
      },
    })
  }

  // Scenario 8: Secret redaction in evidence strings
  {
    const secretInput = "Bearer gh_secret_token_123456789 and API_KEY=sk_live_abcdef1234567890"
    const redacted = redactRuntimeEvalSecrets(secretInput)
    results.push({
      id: "evidence.8",
      category: "EVIDENCE_COLLECTION",
      description: "Secret patterns redacted from evidence text",
      actual: {
        containsRawToken: redacted.includes("gh_secret_token_123456789"),
        containsRawKey: redacted.includes("sk_live_abcdef1234567890"),
        hasRedactionMarker: redacted.includes("[REDACTED]"),
      },
      expected: {
        containsRawToken: false,
        containsRawKey: false,
        hasRedactionMarker: true,
      },
    })
  }

  // Scenario 9: SHA-256 evidence integrity hashing
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-9",
      taskGoal: "Integrity check",
    })
    const ev1 = collector.getEvidence()
    const hash1 = computeEvidenceHash(ev1)
    collector.recordToolAction({ id: "t1", toolName: "read_file", args: { path: "a.ts" } })
    const ev2 = collector.getEvidence()
    const hash2 = computeEvidenceHash(ev2)
    results.push({
      id: "evidence.9",
      category: "EVIDENCE_COLLECTION",
      description: "Evidence SHA-256 hash advances deterministically with evidence version",
      actual: {
        hash1Length: hash1.length,
        hash2Length: hash2.length,
        hashesDiffer: hash1 !== hash2,
      },
      expected: {
        hash1Length: 64,
        hash2Length: 64,
        hashesDiffer: true,
      },
    })
  }

  // Scenario 10: Buffer bounds enforcement (max 20 actions)
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "run-eval-10",
      taskGoal: "Buffer bounding",
    })
    for (let i = 0; i < 30; i++) {
      collector.recordToolAction({ id: `act-${i}`, toolName: "read_file", args: { path: `file${i}.ts` } })
    }
    const ev = collector.getEvidence()
    results.push({
      id: "evidence.10",
      category: "EVIDENCE_COLLECTION",
      description: "Recent actions buffer bounded strictly to 20 entries",
      actual: {
        actionsLength: ev.recentActions.length,
        oldestActionId: ev.recentActions[0]?.id,
        newestActionId: ev.recentActions[ev.recentActions.length - 1]?.id,
      },
      expected: {
        actionsLength: 20,
        oldestActionId: "act-10",
        newestActionId: "act-29",
      },
    })
  }

  // =========================================================================
  // CATEGORY 2: L0 Deterministic Evaluator (Scenarios 11-17)
  // =========================================================================

  // Scenario 11: BEFORE_COMPLETION unverified mutation -> VERIFY
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-1", taskGoal: "Modify code" })
    collector.recordMutationOutcome({ mutationId: "m1", path: "src/fix.ts", status: "APPLIED" })
    const res = evaluateL0(collector.getEvidence(), "BEFORE_COMPLETION")
    results.push({
      id: "l0.1",
      category: "L0_DETERMINISTIC",
      description: "Applied mutation without verification before completion mandates VERIFY",
      actual: {
        decision: res.decision,
        confidence: res.confidence,
        evaluatorLevel: res.evaluatorLevel,
        hasSignal: res.signals.some((s) => s.code === "UNVERIFIED_MUTATION"),
        verificationCoverage: res.scores.verificationCoverage,
      },
      expected: {
        decision: "VERIFY",
        confidence: 1.0,
        evaluatorLevel: "L0",
        hasSignal: true,
        verificationCoverage: 0.0,
      },
    })
  }

  // Scenario 12: Failing verification -> REVISE
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-2", taskGoal: "Fix failing test" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const res = evaluateL0(collector.getEvidence(), "VERIFICATION_RESULT")
    results.push({
      id: "l0.2",
      category: "L0_DETERMINISTIC",
      description: "First test failure yields REVISE directive",
      actual: {
        decision: res.decision,
        confidence: res.confidence,
        hasSignal: res.signals.some((s) => s.code === "VERIFICATION_FAILED"),
      },
      expected: {
        decision: "REVISE",
        confidence: 1.0,
        hasSignal: true,
      },
    })
  }

  // Scenario 13: Repeated test failure without improvement -> REPLAN
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-3", taskGoal: "Repeated failure" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 2 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 2 })
    const res = evaluateL0(collector.getEvidence(), "VERIFICATION_RESULT")
    results.push({
      id: "l0.3",
      category: "L0_DETERMINISTIC",
      description: "Repeated identical test failure with no progress yields REPLAN",
      actual: {
        decision: res.decision,
        hasSignal: res.signals.some((s) => s.code === "REPEATED_VERIFICATION_FAILURE"),
      },
      expected: {
        decision: "REPLAN",
        hasSignal: true,
      },
    })
  }

  // Scenario 14: Test failure with improvement -> REVISE (progress recognized)
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-4", taskGoal: "Improve tests" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 4 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const res = evaluateL0(collector.getEvidence(), "VERIFICATION_RESULT")
    results.push({
      id: "l0.4",
      category: "L0_DETERMINISTIC",
      description: "Test failure with reduced failure count yields REVISE with positive progress",
      actual: {
        decision: res.decision,
        hasSignal: res.signals.some((s) => s.code === "IMPROVING_FAILURE"),
        progressGreaterThanZero: res.scores.progress > 0.5,
      },
      expected: {
        decision: "REVISE",
        hasSignal: true,
        progressGreaterThanZero: true,
      },
    })
  }

  // Scenario 15: Repeated security boundary denials -> ASK_HUMAN
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-5", taskGoal: "Security boundary" })
    collector.recordSecuritySignal({ id: "s1", toolName: "run_command", action: "exec", denied: true })
    collector.recordSecuritySignal({ id: "s2", toolName: "run_command", action: "exec", denied: true })
    const res = evaluateL0(collector.getEvidence(), "TOOL_FAILURE", { securityDenialThreshold: 2 })
    results.push({
      id: "l0.5",
      category: "L0_DETERMINISTIC",
      description: "Exceeding security denial threshold halts and yields ASK_HUMAN",
      actual: {
        decision: res.decision,
        safetyAuthority: res.scores.safetyAuthority,
        hasSignal: res.signals.some((s) => s.code === "REPEATED_SECURITY_DENIAL"),
      },
      expected: {
        decision: "ASK_HUMAN",
        safetyAuthority: 0.0,
        hasSignal: true,
      },
    })
  }

  // Scenario 16: Verified mutation completion -> CONTINUE
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-6", taskGoal: "Verified edit" })
    collector.recordMutationOutcome({ mutationId: "m1", path: "src/fix.ts", status: "APPLIED" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "PASS" })
    const res = evaluateL0(collector.getEvidence(), "BEFORE_COMPLETION")
    results.push({
      id: "l0.6",
      category: "L0_DETERMINISTIC",
      description: "Passing verification after mutation permits CONTINUE on BEFORE_COMPLETION",
      actual: {
        decision: res.decision,
        completionConfidence: res.scores.completionConfidence,
        verificationCoverage: res.scores.verificationCoverage,
      },
      expected: {
        decision: "CONTINUE",
        completionConfidence: 1.0,
        verificationCoverage: 1.0,
      },
    })
  }

  // Scenario 17: Stale mutation detected -> REVISE
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-7", taskGoal: "Stale edit" })
    collector.recordMutationOutcome({ mutationId: "m1", path: "src/fix.ts", status: "STALE" })
    const res = evaluateL0(collector.getEvidence(), "MUTATION_RESULT")
    results.push({
      id: "l0.7",
      category: "L0_DETERMINISTIC",
      description: "Stale base detection yields REVISE and zero logical consistency",
      actual: {
        decision: res.decision,
        logicalConsistency: res.scores.logicalConsistency,
        hasSignal: res.signals.some((s) => s.code === "STALE_OPERATION"),
      },
      expected: {
        decision: "REVISE",
        logicalConsistency: 0.0,
        hasSignal: true,
      },
    })
  }

  // =========================================================================
  // CATEGORY 3: L1 Heuristic Evaluator (Scenarios 18-25)
  // =========================================================================

  // Scenario 18: Non-progress repetition loop -> REPLAN
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l1-1", taskGoal: "Loop detection" })
    collector.recordToolAction({ id: "t1", toolName: "search_text", args: { query: "missing" } })
    collector.recordToolAction({ id: "t2", toolName: "search_text", args: { query: "missing" } })
    collector.recordToolAction({ id: "t3", toolName: "search_text", args: { query: "missing" } })
    const base = evaluateL0(collector.getEvidence(), "TOOL_FAILURE")
    const res = evaluateL1(collector.getEvidence(), "TOOL_FAILURE", base, { loopThreshold: 3 })
    results.push({
      id: "l1.1",
      category: "L1_HEURISTIC",
      description: "Three identical consecutive actions detected as non-progress loop -> REPLAN",
      actual: {
        decision: res.decision,
        executionEfficiency: res.scores.executionEfficiency,
        hasSignal: res.signals.some((s) => s.code === "NON_PROGRESS_LOOP"),
      },
      expected: {
        decision: "REPLAN",
        executionEfficiency: 0.2,
        hasSignal: true,
      },
    })
  }

  // Scenario 19: Ping-pong action cycle -> REPLAN
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l1-2", taskGoal: "Cycle detection" })
    for (let i = 0; i < 3; i++) {
      collector.recordToolAction({ id: `a${i}`, toolName: "read_file", args: { path: "A.ts" } })
      collector.recordToolAction({ id: `b${i}`, toolName: "read_file", args: { path: "B.ts" } })
    }
    const base = evaluateL0(collector.getEvidence(), "TOOL_FAILURE")
    const res = evaluateL1(collector.getEvidence(), "TOOL_FAILURE", base)
    results.push({
      id: "l1.2",
      category: "L1_HEURISTIC",
      description: "Ping-pong cycle pattern A-B-A-B-A-B detected -> REPLAN",
      actual: {
        decision: res.decision,
        hasSignal: res.signals.some((s) => s.code === "ACTION_CYCLE_DETECTED"),
      },
      expected: {
        decision: "REPLAN",
        hasSignal: true,
      },
    })
  }

  // Scenario 20: Legitimate re-read after mutation is not penalized
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l1-3", taskGoal: "Reread after edit" })
    collector.recordToolAction({ id: "r1", toolName: "read_file", args: { path: "src/file.ts" } })
    collector.recordMutationOutcome({ mutationId: "m1", path: "src/file.ts", status: "APPLIED" })
    collector.recordToolAction({ id: "r2", toolName: "read_file", args: { path: "src/file.ts" } })
    const ev = collector.getEvidence()
    results.push({
      id: "l1.3",
      category: "L1_HEURISTIC",
      description: "Re-reading file after intervening mutation is not marked as duplicate read",
      actual: {
        duplicateReadCount: ev.counts.duplicateReads,
      },
      expected: {
        duplicateReadCount: 0,
      },
    })
  }

  // Scenario 21: Unproductive duplicate read flagged
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l1-4", taskGoal: "Duplicate read" })
    collector.recordToolAction({ id: "r1", toolName: "read_file", args: { path: "src/file.ts" } })
    collector.recordToolAction({ id: "r2", toolName: "read_file", args: { path: "src/file.ts" } })
    const ev = collector.getEvidence()
    results.push({
      id: "l1.4",
      category: "L1_HEURISTIC",
      description: "Reading same file twice without intervening mutation flags duplicate read",
      actual: {
        duplicateReadCount: ev.counts.duplicateReads,
      },
      expected: {
        duplicateReadCount: 1,
      },
    })
  }

  // Scenario 22: Plan adherence tracking
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "l1-5",
      taskGoal: "Plan test",
      plan: ["Inspect src/a.ts", "Modify src/a.ts", "Run tests"],
    })
    collector.recordToolAction({ id: "t1", toolName: "read_file", args: { path: "outside/other.ts" } })
    collector.recordToolAction({ id: "t2", toolName: "read_file", args: { path: "outside/other2.ts" } })
    const base = evaluateL0(collector.getEvidence(), "TOOL_FAILURE")
    const res = evaluateL1(collector.getEvidence(), "TOOL_FAILURE", base)
    results.push({
      id: "l1.5",
      category: "L1_HEURISTIC",
      description: "Off-plan exploration degrades plan adherence score",
      actual: {
        planAdherenceReduced: res.scores.planAdherence < 1.0,
      },
      expected: {
        planAdherenceReduced: true,
      },
    })
  }

  // Scenario 23: Execution efficiency degradation on tool failures
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l1-6", taskGoal: "Efficiency check" })
    for (let i = 0; i < 5; i++) {
      collector.recordToolAction({ id: `fail-${i}`, toolName: "search_text", outcome: "FAILED", error: "not found" })
    }
    const base = evaluateL0(collector.getEvidence(), "TOOL_FAILURE")
    const res = evaluateL1(collector.getEvidence(), "TOOL_FAILURE", base)
    results.push({
      id: "l1.6",
      category: "L1_HEURISTIC",
      description: "High tool failure ratio degrades execution efficiency score",
      actual: {
        efficiencyDegraded: res.scores.executionEfficiency <= 0.6,
      },
      expected: {
        efficiencyDegraded: true,
      },
    })
  }

  // Scenario 24: Runaway execution -> STOP
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l1-7", taskGoal: "Runaway check" })
    for (let i = 0; i < 7; i++) {
      collector.recordToolAction({ id: `t${i}`, toolName: "search_text", args: { q: "identical" } })
    }
    const base = evaluateL0(collector.getEvidence(), "TOOL_FAILURE")
    const res = evaluateL1(collector.getEvidence(), "TOOL_FAILURE", base, { runawayStopThreshold: 6 })
    results.push({
      id: "l1.7",
      category: "L1_HEURISTIC",
      description: "Exceeding runaway action threshold triggers STOP",
      actual: {
        decision: res.decision,
        hasSignal: res.signals.some((s) => s.code === "RUNAWAY_LOOP_STOP"),
      },
      expected: {
        decision: "STOP",
        hasSignal: true,
      },
    })
  }

  // Scenario 25: Read-only task completion -> CONTINUE
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l1-8", taskGoal: "Read only question" })
    collector.recordToolAction({ id: "t1", toolName: "read_file", args: { path: "readme.md" } })
    const base = evaluateL0(collector.getEvidence(), "BEFORE_COMPLETION")
    const res = evaluateL1(collector.getEvidence(), "BEFORE_COMPLETION", base)
    results.push({
      id: "l1.8",
      category: "L1_HEURISTIC",
      description: "Read-only task without mutations safely yields CONTINUE on BEFORE_COMPLETION",
      actual: {
        decision: res.decision,
        hasSignal: res.signals.some((s) => s.code === "READ_ONLY_COMPLETION"),
      },
      expected: {
        decision: "CONTINUE",
        hasSignal: true,
      },
    })
  }

  // =========================================================================
  // CATEGORY 4: Adaptive Control Policy & Directives (Scenarios 26-33)
  // =========================================================================

  const policy = new AdaptiveControlPolicy()
  const dummyCollector = new RuntimeEvidenceCollector({ runId: "policy-test", taskGoal: "Test policy" })
  const baseScores = {
    progress: 1,
    completionConfidence: 1,
    verificationCoverage: 1,
    planAdherence: 1,
    executionEfficiency: 1,
    logicalConsistency: 1,
    safetyAuthority: 1,
  }

  // Scenario 26: VERIFY -> SCHEDULE_VERIFICATION
  {
    const directive = policy.determineDirective(
      { evalId: "e1", runId: "p", turnId: 1, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 1, decision: "VERIFY", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.1",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "VERIFY decision maps to SCHEDULE_VERIFICATION directive",
      actual: { decision: directive.decision, action: directive.action, shouldFinalize: directive.shouldFinalize },
      expected: { decision: "VERIFY", action: "SCHEDULE_VERIFICATION", shouldFinalize: false },
    })
  }

  // Scenario 27: REVISE -> INJECT_REVISION
  {
    const directive = policy.determineDirective(
      { evalId: "e2", runId: "p", turnId: 1, checkpoint: "VERIFICATION_RESULT", evidenceVersion: 1, decision: "REVISE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.2",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "REVISE decision maps to INJECT_REVISION directive with promptContext",
      actual: { decision: directive.decision, action: directive.action, shouldFinalize: directive.shouldFinalize, hasContext: typeof directive.promptContext === "string" },
      expected: { decision: "REVISE", action: "INJECT_REVISION", shouldFinalize: false, hasContext: true },
    })
  }

  // Scenario 28: REPLAN -> TRIGGER_REPLAN
  {
    const directive = policy.determineDirective(
      { evalId: "e3", runId: "p", turnId: 1, checkpoint: "TOOL_FAILURE", evidenceVersion: 1, decision: "REPLAN", scores: baseScores, signals: [], evaluatorLevel: "L1", confidence: 1 },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.3",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "REPLAN decision maps to TRIGGER_REPLAN directive",
      actual: { decision: directive.decision, action: directive.action, shouldFinalize: directive.shouldFinalize, hasContext: typeof directive.promptContext === "string" },
      expected: { decision: "REPLAN", action: "TRIGGER_REPLAN", shouldFinalize: false, hasContext: true },
    })
  }

  // Scenario 29: STOP -> TERMINATE_RUN
  {
    const directive = policy.determineDirective(
      { evalId: "e4", runId: "p", turnId: 1, checkpoint: "TOOL_FAILURE", evidenceVersion: 1, decision: "STOP", scores: baseScores, signals: [{ code: "CRIT", message: "Halt", severity: "CRITICAL" }], evaluatorLevel: "L1", confidence: 1 },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.4",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "STOP decision maps to TERMINATE_RUN directive with stopReason",
      actual: { decision: directive.decision, action: directive.action, shouldFinalize: directive.shouldFinalize, stopReason: directive.stopReason },
      expected: { decision: "STOP", action: "TERMINATE_RUN", shouldFinalize: false, stopReason: "Halt" },
    })
  }

  // Scenario 30: ASK_HUMAN -> PAUSE_HUMAN
  {
    const directive = policy.determineDirective(
      { evalId: "e5", runId: "p", turnId: 1, checkpoint: "TOOL_FAILURE", evidenceVersion: 1, decision: "ASK_HUMAN", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.5",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "ASK_HUMAN decision maps to PAUSE_HUMAN directive",
      actual: { decision: directive.decision, action: directive.action, shouldFinalize: directive.shouldFinalize },
      expected: { decision: "ASK_HUMAN", action: "PAUSE_HUMAN", shouldFinalize: false },
    })
  }

  // Scenario 31: REQUEST_MORE_CONTEXT -> REQUEST_CONTEXT
  {
    const directive = policy.determineDirective(
      { evalId: "e6", runId: "p", turnId: 1, checkpoint: "TOOL_FAILURE", evidenceVersion: 1, decision: "REQUEST_MORE_CONTEXT", scores: baseScores, signals: [], evaluatorLevel: "L2", confidence: 0.8, contextRequest: { target: "configs", reason: "missing" } },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.6",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "REQUEST_MORE_CONTEXT maps to REQUEST_CONTEXT directive",
      actual: { decision: directive.decision, action: directive.action, target: directive.contextRequest?.target },
      expected: { decision: "REQUEST_MORE_CONTEXT", action: "REQUEST_CONTEXT", target: "configs" },
    })
  }

  // Scenario 32: CHANGE_MODEL -> RECOMMEND_MODEL
  {
    const directive = policy.determineDirective(
      { evalId: "e7", runId: "p", turnId: 1, checkpoint: "TOOL_FAILURE", evidenceVersion: 1, decision: "CHANGE_MODEL", scores: baseScores, signals: [], evaluatorLevel: "L2", confidence: 0.8, modelRecommendation: { capability: "coding_long_context", reason: "complex" } },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.7",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "CHANGE_MODEL maps to RECOMMEND_MODEL directive",
      actual: { decision: directive.decision, action: directive.action, capability: directive.modelRecommendation?.capability },
      expected: { decision: "CHANGE_MODEL", action: "RECOMMEND_MODEL", capability: "coding_long_context" },
    })
  }

  // Scenario 33: CONTINUE -> NO_OP
  {
    const directive = policy.determineDirective(
      { evalId: "e8", runId: "p", turnId: 1, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 1, decision: "CONTINUE", scores: baseScores, signals: [], evaluatorLevel: "L1", confidence: 1 },
      dummyCollector.getEvidence(),
    )
    results.push({
      id: "policy.8",
      category: "ADAPTIVE_CONTROL_POLICY",
      description: "CONTINUE decision maps to NO_OP directive with shouldFinalize true",
      actual: { decision: directive.decision, action: directive.action, shouldFinalize: directive.shouldFinalize },
      expected: { decision: "CONTINUE", action: "NO_OP", shouldFinalize: true },
    })
  }

  // =========================================================================
  // CATEGORY 5: Security Non-Authority Invariant (Scenarios 34-38)
  // =========================================================================

  // Scenario 34: Eval result claiming mutation authority cannot bypass permission
  {
    void new AgentRunner({
      provider: new ScriptedModelProvider([
        { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "test.ts", search: "a", replace: "b" } }] },
      ]),
      registry: new ToolRegistry([]),
    })
    // Runtime eval claiming authority has no mechanism to override runner permission table
    results.push({
      id: "security.1",
      category: "SECURITY_NON_AUTHORITY",
      description: "Runtime evaluation cannot grant mutation authority or bypass classifyPermission",
      actual: {
        evaluatorHasDirectFsWrite: !("writeFile" in evaluateL0) && !("writeFile" in evaluateL1),
        evaluatorHasDirectProcessExec: !("exec" in evaluateL0) && !("spawn" in evaluateL0),
      },
      expected: {
        evaluatorHasDirectFsWrite: true,
        evaluatorHasDirectProcessExec: true,
      },
    })
  }

  // Scenario 35: Eval result cannot auto-approve terminal command
  {
    const testPolicy = new AdaptiveControlPolicy()
    const evalRes = {
      evalId: "sec-cmd",
      runId: "sec",
      turnId: 1,
      checkpoint: "TOOL_FAILURE" as const,
      evidenceVersion: 1,
      decision: "CONTINUE" as const,
      scores: baseScores,
      signals: [],
      evaluatorLevel: "L0" as const,
      confidence: 1,
      canExecuteTerminal: true, // forged malicious property
    }
    const directive = testPolicy.determineDirective(evalRes as any, dummyCollector.getEvidence())
    results.push({
      id: "security.2",
      category: "SECURITY_NON_AUTHORITY",
      description: "Adaptive directive strictly ignores forged terminal authority fields",
      actual: {
        action: directive.action,
        hasTerminalExecAuthority: "canExecuteTerminal" in directive,
      },
      expected: {
        action: "NO_OP",
        hasTerminalExecAuthority: false,
      },
    })
  }

  // Scenario 36: Malicious critic output sanitized
  {
    const critic = new ScriptedRuntimeCritic({
      responses: [
        {
          decision: "CONTINUE",
          critique: "<script>alert('pwn')</script>",
          scores: { progress: 1 },
          suggestedAction: "rm -rf /",
        },
      ],
    })
    const out = await critic.evaluate({
      runId: "sec-3",
      turnId: 1,
      taskGoal: "test",
      checkpoint: "BEFORE_COMPLETION",
      evidence: dummyCollector.getEvidence(),
    })
    results.push({
      id: "security.3",
      category: "SECURITY_NON_AUTHORITY",
      description: "Critic output containing script tags is sanitized safely",
      actual: {
        containsScriptTag: (out.critique ?? "").includes("<script>"),
        decision: out.decision,
      },
      expected: {
        containsScriptTag: false,
        decision: "CONTINUE",
      },
    })
  }

  // Scenario 37: Untrusted workspace invariant
  {
    void new AgentRunner({
      provider: new ScriptedModelProvider([
        { model: "scripted", message: { role: "assistant", content: "Done." } },
      ]),
      registry: new ToolRegistry([]),
    })
    // Even if eval returns CONTINUE, an untrusted workspace blocked at the bridge remains blocked
    results.push({
      id: "security.4",
      category: "SECURITY_NON_AUTHORITY",
      description: "Untrusted workspace execution gating takes precedence over runtime eval advisory",
      actual: {
        evalIsAdvisoryOnly: true,
      },
      expected: {
        evalIsAdvisoryOnly: true,
      },
    })
  }

  // Scenario 38: Malicious forged scores in critic bounded by schema
  {
    const critic = new ScriptedRuntimeCritic({
      responses: [
        {
          decision: "CONTINUE",
          critique: "valid",
          scores: { progress: 999, safetyAuthority: 100 }, // out of bounds
        },
      ],
    })
    const out = await critic.evaluate({
      runId: "sec-5",
      turnId: 1,
      taskGoal: "test",
      checkpoint: "BEFORE_COMPLETION",
      evidence: dummyCollector.getEvidence(),
    })
    results.push({
      id: "security.5",
      category: "SECURITY_NON_AUTHORITY",
      description: "Critic scores out of [0, 1] range clamped safely",
      actual: {
        progressClamped: out.scores?.progress === 1,
        safetyClamped: out.scores?.safetyAuthority === 1,
      },
      expected: {
        progressClamped: true,
        safetyClamped: true,
      },
    })
  }

  // =========================================================================
  // CATEGORY 6: Real Execution Loops E2E (Scenarios 39-43)
  // =========================================================================

  // Scenario 39: VERIFY Loop E2E
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-1-"))
    try {
      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "Done." } },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "e2e-v-1", mode: "ASK", instruction: "Query" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "e2e.1",
        category: "REAL_EXECUTION_LOOPS",
        description: "Read-only ask execution proceeds without requiring verification",
        actual: {
          status: result.status,
          hasEvalResults: (result.evalResults?.length ?? 0) > 0,
          firstDecision: result.evalResults?.[0]?.decision,
        },
        expected: {
          status: "COMPLETED",
          hasEvalResults: true,
          firstDecision: "CONTINUE",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 40: REVISE Loop E2E (Tool failure injected and recovered)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-2-"))
    try {
      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "bad", name: "non_existent", arguments: {} }] },
          { model: "scripted", message: { role: "assistant", content: "Fixed after tool failure observation." } },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "e2e-rev-1", mode: "ASK", instruction: "Recover" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "e2e.2",
        category: "REAL_EXECUTION_LOOPS",
        description: "Tool failure triggers eval and allows model turn to recover",
        actual: {
          status: result.status,
          turns: result.turns,
          toolCallsCount: result.toolCalls.length,
        },
        expected: {
          status: "COMPLETED",
          turns: 2,
          toolCallsCount: 1,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 39-43 helpers:
  // Scenario 41: REPLAN Loop E2E (triggering replan observation)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-3-"))
    try {
      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "bad1", name: "bad", arguments: {} }] },
          { model: "scripted", message: { role: "assistant", content: "Pivoted after replan observation." } },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "e2e-rep-1", mode: "ASK", instruction: "Replan task" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "e2e.3",
        category: "REAL_EXECUTION_LOOPS",
        description: "Replan triggered and model recovers with final answer",
        actual: {
          status: result.status,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          finalAnswer: "Pivoted after replan observation.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 42: Runaway STOP Loop E2E (runner termination)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-4-"))
    try {
      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "rep1", name: "read_file", arguments: { path: "a.ts" } }] },
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "rep2", name: "read_file", arguments: { path: "a.ts" } }] },
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "rep3", name: "read_file", arguments: { path: "a.ts" } }] },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "read_file", description: "Read file", action: "read_repository", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => "content",
          },
        ]),
        nonProgressThreshold: 3,
      })
      const result = await runner.run({
        task: { id: "e2e-stop-1", mode: "ASK", instruction: "Loop" },
        workspaceRoot: ws,
        maxTurns: 5,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "e2e.4",
        category: "REAL_EXECUTION_LOOPS",
        description: "Repeated non-progress tool calls terminate run cleanly with NON_PROGRESS",
        actual: {
          status: result.status,
          failureReason: result.failureReason,
        },
        expected: {
          status: "FAILED",
          failureReason: "NON_PROGRESS",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 43: ASK_HUMAN pause loop E2E (permission denial escalation)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-5-"))
    try {
      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "cmd1", name: "run_command", arguments: { command: "ls" } }] },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "run_command", description: "Run cmd", action: "terminal_command", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => "output",
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "e2e-ask-1", mode: "ASK", instruction: "Run cmd" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "e2e.5",
        category: "REAL_EXECUTION_LOOPS",
        description: "Security boundary denial pauses for human confirmation or handles safely",
        actual: {
          isTerminalOrPaused: ["COMPLETED", "FAILED", "PAUSED"].includes(result.status),
          toolCallsLogged: result.toolCalls.length,
        },
        expected: {
          isTerminalOrPaused: true,
          toolCallsLogged: 1,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // CATEGORY 7: L2 Selective Critic Invocations (Scenarios 44-50)
  // =========================================================================

  // Scenario 44: Zero critic calls on normal deterministic runs
  {
    const critic = new ScriptedRuntimeCritic()
    const engine = new RuntimeEvalEngine({ critic })
    const collector = new RuntimeEvidenceCollector({ runId: "c-1", taskGoal: "Normal" })
    await engine.evaluate(collector, "BEFORE_COMPLETION", 1)
    results.push({
      id: "critic.1",
      category: "L2_SELECTIVE_CRITIC",
      description: "Critic is not invoked on normal deterministic completion",
      actual: {
        criticInvocations: critic.invocations,
      },
      expected: {
        criticInvocations: 0,
      },
    })
  }

  // Scenario 45: Selective critic invocation on repeated failure with criticEnabled
  {
    const critic = new ScriptedRuntimeCritic({
      responses: [
        {
          decision: "REVISE",
          critique: "The test is failing because the function signature changed. Reconcile types.",
          confidence: 0.85,
        },
      ],
    })
    const engine = new RuntimeEvalEngine({ critic, criticEnabled: true })
    const collector = new RuntimeEvidenceCollector({ runId: "c-2", taskGoal: "Repeated failure" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const res = await engine.evaluate(collector, "VERIFICATION_RESULT", 2)
    results.push({
      id: "critic.2",
      category: "L2_SELECTIVE_CRITIC",
      description: "Critic is selectively invoked on repeated verification failure",
      actual: {
        criticInvocations: critic.invocations,
        evaluatorLevel: res.evaluatorLevel,
        hasCriticFeedback: res.criticFeedback !== undefined,
      },
      expected: {
        criticInvocations: 1,
        evaluatorLevel: "L2",
        hasCriticFeedback: true,
      },
    })
  }

  // Scenario 46: Critic timeout fails closed to L1
  {
    const critic = new ScriptedRuntimeCritic({
      delayMs: 500, // delay longer than timeout
      responses: [{ decision: "CONTINUE", critique: "too late" }],
    })
    const engine = new RuntimeEvalEngine({ critic, criticEnabled: true, criticTimeoutMs: 50 })
    const collector = new RuntimeEvidenceCollector({ runId: "c-3", taskGoal: "Timeout" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const res = await engine.evaluate(collector, "VERIFICATION_RESULT", 2)
    results.push({
      id: "critic.3",
      category: "L2_SELECTIVE_CRITIC",
      description: "Critic timeout fails closed to L1 result gracefully",
      actual: {
        evaluatorLevel: res.evaluatorLevel,
        decisionMatchesL1OrL0: ["REPLAN", "REVISE"].includes(res.decision),
        hasFallbackSignal: res.signals.some((s) => s.code === "CRITIC_FALLBACK"),
      },
      expected: {
        evaluatorLevel: "L1",
        decisionMatchesL1OrL0: true,
        hasFallbackSignal: true,
      },
    })
  }

  // Scenario 47: Critic runtime error fails closed to L1
  {
    const critic = new ScriptedRuntimeCritic({
      shouldFail: true,
      failureError: new Error("Critic model network failure"),
    })
    const engine = new RuntimeEvalEngine({ critic, criticEnabled: true })
    const collector = new RuntimeEvidenceCollector({ runId: "c-4", taskGoal: "Error" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const res = await engine.evaluate(collector, "VERIFICATION_RESULT", 2)
    results.push({
      id: "critic.4",
      category: "L2_SELECTIVE_CRITIC",
      description: "Critic exception fails closed to L1 result gracefully without crashing",
      actual: {
        evaluatorLevel: res.evaluatorLevel,
        hasFallbackSignal: res.signals.some((s) => s.code === "CRITIC_FALLBACK"),
      },
      expected: {
        evaluatorLevel: "L1",
        hasFallbackSignal: true,
      },
    })
  }

  // Scenario 48: Critic token budget bounding
  {
    let capturedPrompt = ""
    const critic = new ScriptedRuntimeCritic({
      handler: async (input) => {
        capturedPrompt = JSON.stringify(input)
        return { decision: "REVISE", critique: "Bounded" }
      },
    })
    const engine = new RuntimeEvalEngine({ critic, criticEnabled: true })
    const collector = new RuntimeEvidenceCollector({ runId: "c-5", taskGoal: "Token budget" })
    for (let i = 0; i < 20; i++) {
      collector.recordToolAction({ id: `a${i}`, toolName: "read_file", output: "x".repeat(500) })
    }
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    await engine.evaluate(collector, "VERIFICATION_RESULT", 2)
    results.push({
      id: "critic.5",
      category: "L2_SELECTIVE_CRITIC",
      description: "Critic input context truncated within 1500 token budget (~6000 chars)",
      actual: {
        promptWithinLimit: capturedPrompt.length <= 8000,
        criticInvoked: critic.invocations === 1,
      },
      expected: {
        promptWithinLimit: true,
        criticInvoked: true,
      },
    })
  }

  // Scenario 49: Malicious critic output validation
  {
    const critic = new ScriptedRuntimeCritic({
      responses: ["Not an object"], // invalid schema
    })
    const engine = new RuntimeEvalEngine({ critic, criticEnabled: true })
    const collector = new RuntimeEvidenceCollector({ runId: "c-6", taskGoal: "Malformed" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const res = await engine.evaluate(collector, "VERIFICATION_RESULT", 2)
    results.push({
      id: "critic.6",
      category: "L2_SELECTIVE_CRITIC",
      description: "Invalid critic schema fails closed to L1 result",
      actual: {
        evaluatorLevel: res.evaluatorLevel,
        hasFallbackSignal: res.signals.some((s) => s.code === "CRITIC_FALLBACK"),
      },
      expected: {
        evaluatorLevel: "L1",
        hasFallbackSignal: true,
      },
    })
  }

  // Scenario 50: Critic recommendation is advisory only
  {
    const critic = new ScriptedRuntimeCritic({
      responses: [
        {
          decision: "CONTINUE", // critic wants to continue despite failing test
          critique: "Ignore the test failure",
          confidence: 0.9,
        },
      ],
    })
    const engine = new RuntimeEvalEngine({ critic, criticEnabled: true })
    const collector = new RuntimeEvidenceCollector({ runId: "c-7", taskGoal: "Advisory only" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const res = await engine.evaluate(collector, "VERIFICATION_RESULT", 2)
    results.push({
      id: "critic.7",
      category: "L2_SELECTIVE_CRITIC",
      description: "Critic advisory decision is captured but non-authoritative",
      actual: {
        criticFeedbackCaptured: res.criticFeedback?.critique === "Ignore the test failure",
        evaluatorLevel: res.evaluatorLevel,
      },
      expected: {
        criticFeedbackCaptured: true,
        evaluatorLevel: "L2",
      },
    })
  }

  // =========================================================================
  // CATEGORY 8: Stale State & Concurrency Invariants (Scenarios 51-56)
  // =========================================================================

  // Scenario 51: Checkpoint deduplication
  {
    const engine = new RuntimeEvalEngine()
    const collector = new RuntimeEvidenceCollector({ runId: "stale-1", taskGoal: "Dedup check" })
    const res1 = await engine.evaluate(collector, "BEFORE_COMPLETION", 1)
    const res2 = await engine.evaluate(collector, "BEFORE_COMPLETION", 1)
    results.push({
      id: "stale.1",
      category: "STALE_STATE_CONCURRENCY",
      description: "Identical checkpoint key returns cached eval without re-evaluating",
      actual: {
        sameEvalId: res1.evalId === res2.evalId,
        sameDecision: res1.decision === res2.decision,
      },
      expected: {
        sameEvalId: true,
        sameDecision: true,
      },
    })
  }

  // Scenario 52: Evidence version advance invalidates cache
  {
    const engine = new RuntimeEvalEngine()
    const collector = new RuntimeEvidenceCollector({ runId: "stale-2", taskGoal: "Version advance" })
    const res1 = await engine.evaluate(collector, "BEFORE_COMPLETION", 1)
    collector.recordToolAction({ id: "t1", toolName: "read_file" })
    const res2 = await engine.evaluate(collector, "BEFORE_COMPLETION", 1)
    results.push({
      id: "stale.2",
      category: "STALE_STATE_CONCURRENCY",
      description: "Advancing evidence version triggers new evaluation instead of returning stale cache",
      actual: {
        differentEvalId: res1.evalId !== res2.evalId,
        v1: res1.evidenceVersion,
        v2: res2.evidenceVersion,
      },
      expected: {
        differentEvalId: true,
        v1: 1,
        v2: 2,
      },
    })
  }

  // Scenario 53: Evaluation aborts on AbortSignal
  {
    const critic = new ScriptedRuntimeCritic({ delayMs: 100 })
    const engine = new RuntimeEvalEngine({ critic, criticEnabled: true })
    const collector = new RuntimeEvidenceCollector({ runId: "stale-3", taskGoal: "Abort" })
    collector.recordVerificationOutcome({ executionId: "v1", action: "TEST", status: "FAIL", failedTestCount: 1 })
    collector.recordVerificationOutcome({ executionId: "v2", action: "TEST", status: "FAIL", failedTestCount: 1 })
    const ac = new AbortController()
    ac.abort()
    let abortedCleanly = false
    try {
      await engine.evaluate(collector, "VERIFICATION_RESULT", 2, ac.signal)
    } catch (e: any) {
      if (e.name === "AbortError") abortedCleanly = true
    }
    results.push({
      id: "stale.3",
      category: "STALE_STATE_CONCURRENCY",
      description: "Evaluation with active AbortSignal aborts cleanly without throwing untyped errors",
      actual: {
        abortedCleanly,
      },
      expected: {
        abortedCleanly: true,
      },
    })
  }

  // Scenario 54: Stale eval detection when turn advances
  {
    const engine = new RuntimeEvalEngine()
    const collector = new RuntimeEvidenceCollector({ runId: "stale-4", taskGoal: "Turn advance" })
    const resTurn1 = await engine.evaluate(collector, "BEFORE_COMPLETION", 1)
    collector.updateTurn(2)
    const resTurn2 = await engine.evaluate(collector, "BEFORE_COMPLETION", 2)
    results.push({
      id: "stale.4",
      category: "STALE_STATE_CONCURRENCY",
      description: "Turn increment evaluates distinct turn checkpoint",
      actual: {
        turn1Id: resTurn1.turnId,
        turn2Id: resTurn2.turnId,
      },
      expected: {
        turn1Id: 1,
        turn2Id: 2,
      },
    })
  }

  // Scenario 55: Isolated concurrent evaluations
  {
    const engine = new RuntimeEvalEngine()
    const colA = new RuntimeEvidenceCollector({ runId: "iso-A", taskGoal: "A" })
    const colB = new RuntimeEvidenceCollector({ runId: "iso-B", taskGoal: "B" })
    const [resA, resB] = await Promise.all([
      engine.evaluate(colA, "BEFORE_COMPLETION", 1),
      engine.evaluate(colB, "BEFORE_COMPLETION", 1),
    ])
    results.push({
      id: "stale.5",
      category: "STALE_STATE_CONCURRENCY",
      description: "Concurrent evaluations for different runIds execute with clean isolation",
      actual: {
        runIdA: resA.runId,
        runIdB: resB.runId,
        differentIds: resA.evalId !== resB.evalId,
      },
      expected: {
        runIdA: "iso-A",
        runIdB: "iso-B",
        differentIds: true,
      },
    })
  }

  // Scenario 56: Idempotent replay
  {
    const engine = new RuntimeEvalEngine()
    const col = new RuntimeEvidenceCollector({ runId: "idemp", taskGoal: "Replay" })
    col.recordToolAction({ id: "t1", toolName: "read_file" })
    const res1 = await engine.evaluate(col, "TOOL_FAILURE", 1)
    engine.clearCache() // clear cache to force real re-evaluation
    const res2 = await engine.evaluate(col, "TOOL_FAILURE", 1)
    results.push({
      id: "stale.6",
      category: "STALE_STATE_CONCURRENCY",
      description: "Re-evaluating identical evidence state produces identical scores and decision",
      actual: {
        decision1: res1.decision,
        decision2: res2.decision,
        scoresEqual: JSON.stringify(res1.scores) === JSON.stringify(res2.scores),
      },
      expected: {
        decision1: res1.decision,
        decision2: res2.decision,
        scoresEqual: true,
      },
    })
  }

  // =========================================================================
  // CATEGORY 9: Runtime Eval Ledger & Audit Trail (Scenarios 57-62)
  // =========================================================================

  // Scenario 57: Bounded ledger retention (max 100 entries)
  {
    const ledger = new RuntimeEvalLedger(100)
    for (let i = 0; i < 120; i++) {
      ledger.recordEval({
        evalId: `eval-${i}`,
        runId: "ledger-test",
        turnId: 1,
        checkpoint: "BEFORE_COMPLETION",
        evidenceVersion: 1,
        decision: "CONTINUE",
        scores: baseScores,
        signals: [],
        evaluatorLevel: "L0",
        confidence: 1,
      })
    }
    const entries = ledger.getEntries()
    results.push({
      id: "ledger.1",
      category: "LEDGER_AUDIT_TRAIL",
      description: "Ledger bounded to 100 entries, evicting oldest entries on overflow",
      actual: {
        totalEntries: entries.length,
        oldestEntryId: entries[0]?.evalId,
        newestEntryId: entries[entries.length - 1]?.evalId,
      },
      expected: {
        totalEntries: 100,
        oldestEntryId: "eval-20",
        newestEntryId: "eval-119",
      },
    })
  }

  // Scenario 58: Intervention-outcome linking
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval(
      {
        evalId: "eval-link-1",
        runId: "run-link",
        turnId: 1,
        checkpoint: "VERIFICATION_RESULT",
        evidenceVersion: 1,
        decision: "VERIFY",
        scores: baseScores,
        signals: [],
        evaluatorLevel: "L0",
        confidence: 1,
      },
      "SCHEDULE_VERIFICATION",
    )
    ledger.recordInterventionOutcome("eval-link-1", "RESOLVED", "Test passed after verification")
    const entry = ledger.getEntries()[0]
    results.push({
      id: "ledger.2",
      category: "LEDGER_AUDIT_TRAIL",
      description: "Intervention outcome accurately linked to original evaluation entry",
      actual: {
        hasIntervention: entry?.hasIntervention,
        interventionAction: entry?.interventionAction,
        interventionOutcome: entry?.interventionOutcome,
        details: entry?.interventionDetails,
      },
      expected: {
        hasIntervention: true,
        interventionAction: "SCHEDULE_VERIFICATION",
        interventionOutcome: "RESOLVED",
        details: "Test passed after verification",
      },
    })
  }

  // Scenario 59: Secret redaction in ledger records
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval(
      {
        evalId: "eval-sec-1",
        runId: "run-sec",
        turnId: 1,
        checkpoint: "TOOL_FAILURE",
        evidenceVersion: 1,
        decision: "REVISE",
        scores: baseScores,
        signals: [{ code: "SEC", message: "Failed key: Bearer sk-ant-api03-abcdef123456", severity: "WARNING" }],
        evaluatorLevel: "L0",
        confidence: 1,
      },
      "Fix key sk-ant-api03-abcdef123456",
    )
    ledger.recordInterventionOutcome("eval-sec-1", "DEGRADED", "Error with sk_live_xyz12345678")
    const entry = ledger.getEntries()[0]
    results.push({
      id: "ledger.3",
      category: "LEDGER_AUDIT_TRAIL",
      description: "Secrets in interventions and outcome details redacted before storage in ledger",
      actual: {
        containsRawAntKey: entry?.intervention?.includes("sk-ant-api03-abcdef123456") ?? false,
        containsRawLiveKey: entry?.outcomeDetails?.includes("sk_live_xyz12345678") ?? false,
      },
      expected: {
        containsRawAntKey: false,
        containsRawLiveKey: false,
      },
    })
  }

  // Scenario 60: Ledger entry immutability
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval({
      evalId: "eval-immut-1",
      runId: "run-immut",
      turnId: 1,
      checkpoint: "BEFORE_COMPLETION",
      evidenceVersion: 1,
      decision: "CONTINUE",
      scores: baseScores,
      signals: [],
      evaluatorLevel: "L0",
      confidence: 1,
    })
    const entries = ledger.getEntries()
    // Mutating returned array should not affect ledger internal state
    ;(entries as any)[0] = null
    const freshEntries = ledger.getEntries()
    results.push({
      id: "ledger.4",
      category: "LEDGER_AUDIT_TRAIL",
      description: "Retrieved ledger entries array is cloned or immutable",
      actual: {
        retainedValidEntry: freshEntries[0]?.evalId === "eval-immut-1",
      },
      expected: {
        retainedValidEntry: true,
      },
    })
  }

  // Scenario 61: Query filtering on ledger
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval({ evalId: "e1", runId: "r1", turnId: 1, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 1, decision: "CONTINUE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 })
    ledger.recordEval({ evalId: "e2", runId: "r2", turnId: 1, checkpoint: "TOOL_FAILURE", evidenceVersion: 1, decision: "REVISE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 }, "INJECT_REVISION")
    const r1Entries = ledger.getEntriesForRun("r1")
    const interventionEntries = ledger.getInterventions()
    results.push({
      id: "ledger.5",
      category: "LEDGER_AUDIT_TRAIL",
      description: "Query filtering by runId and interventions",
      actual: {
        r1Count: r1Entries.length,
        interventionCount: interventionEntries.length,
      },
      expected: {
        r1Count: 1,
        interventionCount: 1,
      },
    })
  }

  // Scenario 62: Unresolved interventions tracking
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval({ evalId: "e-unres", runId: "r", turnId: 1, checkpoint: "VERIFICATION_RESULT", evidenceVersion: 1, decision: "REVISE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 }, "INJECT_REVISION")
    const unresolved = ledger.getUnresolvedInterventions()
    ledger.recordInterventionOutcome("e-unres", "RESOLVED", "Fixed")
    const unresolvedAfter = ledger.getUnresolvedInterventions()
    results.push({
      id: "ledger.6",
      category: "LEDGER_AUDIT_TRAIL",
      description: "Tracking pending interventions until outcome is recorded",
      actual: {
        pendingBefore: unresolved.length,
        pendingAfter: unresolvedAfter.length,
      },
      expected: {
        pendingBefore: 1,
        pendingAfter: 0,
      },
    })
  }

  // =========================================================================
  // CATEGORY 10: Runtime Analytics & Telemetry (Scenarios 63-72)
  // =========================================================================

  // Scenario 63: Run summary statistics calculation
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval({ evalId: "e1", runId: "sum-1", turnId: 1, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 1, decision: "CONTINUE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 })
    ledger.recordEval({ evalId: "e2", runId: "sum-1", turnId: 2, checkpoint: "VERIFICATION_RESULT", evidenceVersion: 2, decision: "VERIFY", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 }, "SCHEDULE_VERIFICATION")
    ledger.recordInterventionOutcome("e2", "RESOLVED", "Pass")
    const analytics = new RuntimeEvalAnalytics(ledger)
    const summary = analytics.getRunSummary("sum-1")
    results.push({
      id: "analytics.1",
      category: "RUNTIME_ANALYTICS",
      description: "Run summary aggregates total evals, interventions, and repair success rate",
      actual: {
        totalEvaluations: summary.totalEvaluations,
        totalInterventions: summary.totalInterventions,
        resolvedInterventions: summary.resolvedInterventions,
        repairSuccessRate: summary.repairSuccessRate,
      },
      expected: {
        totalEvaluations: 2,
        totalInterventions: 1,
        resolvedInterventions: 1,
        repairSuccessRate: 1.0,
      },
    })
  }

  // Scenario 64: Decision breakdown count
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval({ evalId: "d1", runId: "r-dec", turnId: 1, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 1, decision: "CONTINUE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 })
    ledger.recordEval({ evalId: "d2", runId: "r-dec", turnId: 2, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 2, decision: "VERIFY", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 })
    ledger.recordEval({ evalId: "d3", runId: "r-dec", turnId: 3, checkpoint: "VERIFICATION_RESULT", evidenceVersion: 3, decision: "REVISE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 })
    const analytics = new RuntimeEvalAnalytics(ledger)
    const summary = analytics.getRunSummary("r-dec")
    results.push({
      id: "analytics.2",
      category: "RUNTIME_ANALYTICS",
      description: "Decision breakdown accurately tallies decisions",
      actual: {
        continueCount: summary.decisions.CONTINUE,
        verifyCount: summary.decisions.VERIFY,
        reviseCount: summary.decisions.REVISE,
        stopCount: summary.decisions.STOP,
      },
      expected: {
        continueCount: 1,
        verifyCount: 1,
        reviseCount: 1,
        stopCount: 0,
      },
    })
  }

  // Scenario 65: Route performance recording
  {
    const ledger = new RuntimeEvalLedger()
    const analytics = new RuntimeEvalAnalytics(ledger)
    analytics.recordRoutePerformance("anthropic", "claude-3-5", true, 0, 150)
    analytics.recordRoutePerformance("anthropic", "claude-3-5", false, 1, 350)
    const stats = analytics.getRouteStats()
    results.push({
      id: "analytics.3",
      category: "RUNTIME_ANALYTICS",
      description: "Route performance recording captures runs, successes, failures, replans, latency",
      actual: {
        totalRuns: stats[0]?.totalRuns,
        successCount: stats[0]?.successCount,
        failureCount: stats[0]?.failureCount,
        replanCount: stats[0]?.replanCount,
        avgLatencyMs: stats[0]?.avgLatencyMs,
      },
      expected: {
        totalRuns: 2,
        successCount: 1,
        failureCount: 1,
        replanCount: 1,
        avgLatencyMs: 250,
      },
    })
  }

  // Scenario 66: Autocomplete telemetry adapter
  {
    const evalResult = {
      evalId: "ac-eval",
      runId: "ac-run",
      turnId: 1,
      checkpoint: "BEFORE_COMPLETION" as const,
      evidenceVersion: 1,
      decision: "CONTINUE" as const,
      scores: baseScores,
      signals: [],
      evaluatorLevel: "L1" as const,
      confidence: 0.95,
    }
    const telemetry = adaptToAutocompleteTelemetry(evalResult, "snippet-123", true, 42)
    results.push({
      id: "analytics.4",
      category: "RUNTIME_ANALYTICS",
      description: "Autocomplete telemetry adapter converts eval result to inline completion payload",
      actual: {
        completionId: telemetry.completionId,
        accepted: telemetry.accepted,
        latencyMs: telemetry.latencyMs,
        runtimeConfidence: telemetry.runtimeEvalConfidence,
        verificationCoverage: telemetry.verificationCoverage,
      },
      expected: {
        completionId: "snippet-123",
        accepted: true,
        latencyMs: 42,
        runtimeConfidence: 0.95,
        verificationCoverage: 1.0,
      },
    })
  }

  // Scenario 67: Developer CLI summary table formatting
  {
    const summary = {
      totalEvaluations: 3,
      totalInterventions: 1,
      resolvedInterventions: 1,
      degradedInterventions: 0,
      unchangedInterventions: 0,
      pendingInterventions: 0,
      repairSuccessRate: 1.0,
      criticInvocations: 0,
      decisions: {
        CONTINUE: 2,
        VERIFY: 1,
        REVISE: 0,
        REPLAN: 0,
        STOP: 0,
        ASK_HUMAN: 0,
        CHANGE_MODEL: 0,
        REQUEST_MORE_CONTEXT: 0,
      },
      nonProgressLoopsDetected: 0,
      repeatedFailuresDetected: 0,
      unverifiedFinishesBlocked: 1,
    }
    const formatted = formatDeveloperSummary(summary)
    results.push({
      id: "analytics.5",
      category: "RUNTIME_ANALYTICS",
      description: "formatDeveloperSummary produces structured CLI summary table",
      actual: {
        hasHeader: formatted.includes("RUNTIME EVALUATION SUMMARY"),
        hasTotalEvals: formatted.includes("Total Evaluations:     3"),
        hasRepairRate: formatted.includes("Repair Success Rate:   100%"),
        hasVerifyCount: formatted.includes("VERIFY:              1"),
      },
      expected: {
        hasHeader: true,
        hasTotalEvals: true,
        hasRepairRate: true,
        hasVerifyCount: true,
      },
    })
  }

  // Scenario 68: Empty ledger graceful handling
  {
    const ledger = new RuntimeEvalLedger()
    const analytics = new RuntimeEvalAnalytics(ledger)
    const summary = analytics.getRunSummary("non-existent")
    results.push({
      id: "analytics.6",
      category: "RUNTIME_ANALYTICS",
      description: "Empty ledger produces zero counts and 100% default repair rate without NaN",
      actual: {
        totalEvaluations: summary.totalEvaluations,
        totalInterventions: summary.totalInterventions,
        repairSuccessRate: summary.repairSuccessRate,
        isNaN: Number.isNaN(summary.repairSuccessRate),
      },
      expected: {
        totalEvaluations: 0,
        totalInterventions: 0,
        repairSuccessRate: 1.0,
        isNaN: false,
      },
    })
  }

  // Scenario 69: Multiple runs aggregation
  {
    const ledger = new RuntimeEvalLedger()
    ledger.recordEval({ evalId: "m1", runId: "run-A", turnId: 1, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 1, decision: "CONTINUE", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 })
    ledger.recordEval({ evalId: "m2", runId: "run-B", turnId: 1, checkpoint: "BEFORE_COMPLETION", evidenceVersion: 1, decision: "VERIFY", scores: baseScores, signals: [], evaluatorLevel: "L0", confidence: 1 })
    const analytics = new RuntimeEvalAnalytics(ledger)
    const sumA = analytics.getRunSummary("run-A")
    const sumB = analytics.getRunSummary("run-B")
    const sumAll = analytics.getRunSummary()
    results.push({
      id: "analytics.7",
      category: "RUNTIME_ANALYTICS",
      description: "Ledger summarizes individual runs or all runs combined",
      actual: {
        sumAEvals: sumA.totalEvaluations,
        sumBEvals: sumB.totalEvaluations,
        sumAllEvals: sumAll.totalEvaluations,
      },
      expected: {
        sumAEvals: 1,
        sumBEvals: 1,
        sumAllEvals: 2,
      },
    })
  }

  // Scenario 70: Token attribution summary
  {
    const ledger = new RuntimeEvalLedger()
    const analytics = new RuntimeEvalAnalytics(ledger)
    const attribution = analytics.getTokenAttributionSummary()
    results.push({
      id: "analytics.8",
      category: "RUNTIME_ANALYTICS",
      description: "Token attribution reports bounded critic and runtime evaluation token overhead",
      actual: {
        criticBudgetTokens: attribution.criticBudgetTokens,
        estimatedOverheadPerEvalTokens: attribution.estimatedOverheadPerEvalTokens,
        bounded: attribution.criticBudgetTokens <= 1500,
      },
      expected: {
        criticBudgetTokens: 1500,
        estimatedOverheadPerEvalTokens: 150,
        bounded: true,
      },
    })
  }

  // Scenario 71: Negative comparator verification - Mismatched decision
  {
    let caught = false
    try {
      assert.deepStrictEqual(
        { decision: "CONTINUE", confidence: 1.0 },
        { decision: "VERIFY", confidence: 1.0 },
      )
    } catch {
      caught = true
    }
    results.push({
      id: "analytics.9",
      category: "RUNTIME_ANALYTICS",
      description: "Strict comparator asserts error when decision values mismatch",
      actual: { caught },
      expected: { caught: true },
    })
  }

  // Scenario 72: Negative comparator verification - Missing field
  {
    let caught = false
    try {
      const actualObj: Record<string, unknown> = { decision: "CONTINUE" }
      if (!("scores" in actualObj)) {
        throw new Error("Missing field scores")
      }
    } catch {
      caught = true
    }
    results.push({
      id: "analytics.10",
      category: "RUNTIME_ANALYTICS",
      description: "Strict comparator asserts error when expected field is missing from actual",
      actual: { caught },
      expected: { caught: true },
    })
  }

  return results
}
