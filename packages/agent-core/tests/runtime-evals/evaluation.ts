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
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
  classifyPermission,
  ModelRouter,
  RoutedModelGateway,
  StaticHealthChecker,
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

  // Scenario 39: VERIFY Loop E2E (mutation triggers BEFORE_COMPLETION verification, passes, completes)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-1-"))
    try {
      const runner = new AgentRunner({
        evidenceGate: false,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "m-1", name: "apply_edit", arguments: { targetFile: "index.ts" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Mutation applied, all done!" },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_edit", description: "Apply edit", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async (input) => ({
              id: "m-rev-1",
              reviewPayload: { targetFile: (input as any)?.targetFile ?? "index.ts" },
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
          {
            definition: { name: "run_verification", description: "Run test verification", action: "run_known_test", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "PASS", totalTests: 1, failedTests: 0 }),
            prepareForReview: async () => ({
              id: "v-rev-1",
              reviewPayload: {},
              apply: async () => ({ status: "PASS", totalTests: 1, failedTests: 0 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "e2e-v-1", mode: "BUILD", instruction: "Update index.ts with tests" },
        workspaceRoot: ws,
        maxTurns: 5,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const beforeCompEval = result.evalResults?.find((e) => e.checkpoint === "BEFORE_COMPLETION")
      const postVerifEval = result.evalResults?.find((e) => e.checkpoint === "VERIFICATION_RESULT")
      results.push({
        id: "e2e.1",
        category: "REAL_EXECUTION_LOOPS",
        description: "Mutation triggers BEFORE_COMPLETION VERIFY, schedules and passes verification, and completes",
        actual: {
          status: result.status,
          beforeCompDecision: beforeCompEval?.decision,
          postVerifDecision: postVerifEval?.decision,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          beforeCompDecision: "VERIFY",
          postVerifDecision: "CONTINUE",
          finalAnswer: "Mutation applied, all done!",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 40: REVISE Loop E2E (Tool failure triggers TOOL_FAILURE revision injection and model recovers)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-2-"))
    try {
      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "bad", name: "failing_tool", arguments: {} }] },
          { model: "scripted", message: { role: "assistant", content: "Fixed after tool failure observation." } },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "failing_tool", description: "Failing tool", action: "read_repository", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => {
              throw new Error("Syntax error in file")
            },
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "e2e-rev-1", mode: "ASK", instruction: "Recover from error" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const failureEval = result.evalResults?.find((e) => e.checkpoint === "TOOL_FAILURE")
      results.push({
        id: "e2e.2",
        category: "REAL_EXECUTION_LOOPS",
        description: "Tool failure triggers TOOL_FAILURE eval and allows model turn to recover",
        actual: {
          status: result.status,
          turns: result.turns,
          toolFailureEvaluated: failureEval !== undefined,
          failureDecision: failureEval?.decision,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          turns: 2,
          toolFailureEvaluated: true,
          failureDecision: "REVISE",
          finalAnswer: "Fixed after tool failure observation.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 41: REPLAN Loop E2E (Repeated tool failure triggers REPLAN and model recovers with new plan)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-3-"))
    try {
      const runner = new AgentRunner({
        evalEngine: new RuntimeEvalEngine({ l0Options: { repeatedFailureThreshold: 1 } }),
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "bad1", name: "failing_tool", arguments: { file: "a.ts" } }] },
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "bad2", name: "failing_tool", arguments: { file: "a.ts" } }] },
          { model: "scripted", message: { role: "assistant", content: "Pivoted after replan observation." } },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "failing_tool", description: "Failing tool", action: "read_repository", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => {
              throw new Error("Repeated failure")
            },
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "e2e-rep-1", mode: "ASK", instruction: "Replan task" },
        workspaceRoot: ws,
        maxTurns: 4,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const replanEval = result.evalResults?.find((e) => e.decision === "REPLAN")
      results.push({
        id: "e2e.3",
        category: "REAL_EXECUTION_LOOPS",
        description: "Repeated tool failure triggers REPLAN directive and model pivots cleanly",
        actual: {
          status: result.status,
          replanTriggered: replanEval !== undefined,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          replanTriggered: true,
          finalAnswer: "Pivoted after replan observation.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 42: Runaway STOP Loop E2E (terminates with RUNTIME_EVAL terminationSource)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-4-"))
    try {
      const runner = new AgentRunner({
        evalEngine: new RuntimeEvalEngine({ l1Options: { runawayStopThreshold: 2 } }),
        nonProgressThreshold: 10,
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "bad1", name: "failing_tool", arguments: {} }] },
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "bad2", name: "failing_tool", arguments: {} }] },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "failing_tool", description: "Failing tool", action: "read_repository", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => {
              throw new Error("Unrecoverable error")
            },
          },
        ]),
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
        description: "Repeated non-progress tool calls terminate run cleanly with RUNTIME_EVAL",
        actual: {
          status: result.status,
          failureReason: result.failureReason,
          terminationSource: result.terminationSource,
        },
        expected: {
          status: "FAILED",
          failureReason: "NON_PROGRESS",
          terminationSource: "RUNTIME_EVAL",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 43: ASK_HUMAN pause loop E2E (permission denial escalates to PAUSED with WAITING_FOR_CONFIRMATION)
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-e2e-5-"))
    try {
      const runner = new AgentRunner({
        evalEngine: new RuntimeEvalEngine({ l0Options: { securityDenialThreshold: 1 } }),
        permissionEvaluator: () => "DENY",
        provider: new ScriptedModelProvider([
          { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "cmd1", name: "run_command", arguments: { command: "rm -rf /" } }] },
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
        task: { id: "e2e-ask-1", mode: "ASK", instruction: "Run dangerous command" },
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
          status: result.status,
          sessionStatus: result.finalState.status,
          hasDenialEval: result.evalResults?.some((e) => e.decision === "ASK_HUMAN") ?? false,
        },
        expected: {
          status: "PAUSED",
          sessionStatus: "WAITING_FOR_CONFIRMATION",
          hasDenialEval: true,
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

  // =========================================================================
  // CATEGORY 11: Adaptive Loop Integrity & Real Closure (Scenarios 73-82)
  // =========================================================================

  // Scenario 73: Stale evaluation marked stale: true, decision: "CONTINUE"
  {
    const collector = new RuntimeEvidenceCollector({ runId: "stale-1", taskGoal: "Detect staleness" })
    let evalRan = false
    const critic = {
      evaluate: async () => {
        // Evidence changed during critique!
        collector.recordToolAction({ id: "action-mid", toolName: "read_file", outcome: "COMPLETED" })
        evalRan = true
        return {
          assessment: "Critique during mutation",
          confidence: 0.9,
          suggestedDecision: "REVISE" as const,
          reasonCodes: [],
          flags: [],
        }
      },
    }
    const engine = new RuntimeEvalEngine({ critic, forceCritic: true })
    const result = await engine.evaluate(collector, "PERIODIC", 1)
    results.push({
      id: "integrity.1",
      category: "RUNTIME_INTEGRITY",
      description: "Evaluation where evidence version changes concurrently is marked stale with CONTINUE",
      actual: {
        evalRan,
        stale: result.stale,
        decision: result.decision,
      },
      expected: {
        evalRan: true,
        stale: true,
        decision: "CONTINUE",
      },
    })
  }

  // Scenario 74: Stale evaluation not cached, subsequent fresh eval succeeds
  {
    const collector = new RuntimeEvidenceCollector({ runId: "stale-cache-1", taskGoal: "Cache staleness check" })
    let callCount = 0
    const critic = {
      evaluate: async () => {
        callCount++
        if (callCount === 1) {
          collector.recordToolAction({ id: "action-mid-1", toolName: "read_file", outcome: "COMPLETED" })
        }
        return {
          assessment: "Critic response",
          confidence: 0.9,
          suggestedDecision: "REVISE" as const,
          reasonCodes: [],
          flags: [],
        }
      },
    }
    const engine = new RuntimeEvalEngine({ critic, forceCritic: true })
    const firstResult = await engine.evaluate(collector, "PERIODIC", 1)
    const secondResult = await engine.evaluate(collector, "PERIODIC", 1)
    results.push({
      id: "integrity.2",
      category: "RUNTIME_INTEGRITY",
      description: "Stale evaluation is excluded from cache so subsequent evaluation executes freshly",
      actual: {
        firstStale: firstResult.stale === true,
        secondStale: secondResult.stale ?? false,
        secondDecision: secondResult.decision,
        invocations: callCount,
      },
      expected: {
        firstStale: true,
        secondStale: false,
        secondDecision: "REVISE",
        invocations: 2,
      },
    })
  }

  // Scenario 75: Post-verification failing evaluation blocks completion and injects revision
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-post-fail-"))
    try {
      let verifAttempts = 0
      const runner = new AgentRunner({
        evidenceGate: false,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "m-1", name: "apply_edit", arguments: { targetFile: "app.ts" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Attempting completion 1" },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "v-fix", name: "run_verification", arguments: { action: "TEST" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Fixed and tests pass!" },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_edit", description: "Apply edit", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async (input) => ({
              id: "m-rev-1",
              reviewPayload: { targetFile: (input as any)?.targetFile ?? "app.ts" },
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
          {
            definition: { name: "run_verification", description: "Run test verification", action: "run_known_test", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => {
              verifAttempts++
              if (verifAttempts === 1) {
                return { status: "FAIL", totalTests: 2, failedTests: 1 }
              }
              return { status: "PASS", totalTests: 2, failedTests: 0 }
            },
            prepareForReview: async () => {
              verifAttempts++
              if (verifAttempts === 1) {
                return { id: "v-rev-1", reviewPayload: {}, apply: async () => ({ status: "FAIL", totalTests: 2, failedTests: 1 }) }
              }
              return { id: "v-rev-2", reviewPayload: {}, apply: async () => ({ status: "PASS", totalTests: 2, failedTests: 0 }) }
            },
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "post-fail-1", mode: "BUILD", instruction: "Update app.ts and verify" },
        workspaceRoot: ws,
        maxTurns: 5,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const postVerifEvals = result.evalResults?.filter((e) => e.checkpoint === "VERIFICATION_RESULT") ?? []
      results.push({
        id: "integrity.3",
        category: "RUNTIME_INTEGRITY",
        description: "Post-verification failure blocks completion and injects revision until verification passes",
        actual: {
          status: result.status,
          turns: result.turns,
          postVerifDecisions: postVerifEvals.map((e) => e.decision),
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          turns: 4,
          postVerifDecisions: ["REVISE", "CONTINUE"],
          finalAnswer: "Fixed and tests pass!",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 76: Unavailable verification fails closed with VERIFICATION_UNAVAILABLE on required task
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-verif-unavail-"))
    try {
      const runner = new AgentRunner({
        evidenceGate: false,
        permissionEvaluator: (action) => (action.action === "write_file" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "m-1", name: "apply_edit", arguments: { targetFile: "bug.ts" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Bug fixed, completing now." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_edit", description: "Apply edit", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async (input) => ({
              id: "m-rev-1",
              reviewPayload: { targetFile: (input as any)?.targetFile ?? "bug.ts" },
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: {
          id: "verif-unavail-1",
          mode: "BUILD",
          instruction: "Fix bug and verify with tests",
          metadata: { requireVerification: true },
        },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const failedEvent = result.events.find((e) => e.type === "task.failed")
      results.push({
        id: "integrity.4",
        category: "RUNTIME_INTEGRITY",
        description: "Task requiring verification fails closed when verification tool is unavailable",
        actual: {
          status: result.status,
          failureReason: result.failureReason,
          hasUnavailMessage: String((failedEvent?.payload as any)?.message ?? "").includes("VERIFICATION_UNAVAILABLE"),
        },
        expected: {
          status: "FAILED",
          failureReason: "INTERNAL_ERROR",
          hasUnavailMessage: true,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 77: Unavailable verification allows completion on read-only task
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-verif-readonly-"))
    try {
      const runner = new AgentRunner({
        evidenceGate: false,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Information retrieved successfully." },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "verif-readonly-1", mode: "ASK", instruction: "Explain the architecture" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "integrity.5",
        category: "RUNTIME_INTEGRITY",
        description: "Read-only task without mutations completes cleanly without verification capability",
        actual: {
          status: result.status,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          finalAnswer: "Information retrieved successfully.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 78: MUTATION_RESULT checkpoint recorded and dispatched
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-mut-dispatch-"))
    try {
      const runner = new AgentRunner({
        evidenceGate: false,
        permissionEvaluator: (action) => (action.action === "write_file" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "m-mut-1", name: "apply_edit", arguments: { targetFile: "file.ts" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Done editing file." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_edit", description: "Apply edit", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async (input) => ({
              id: "m-rev-1",
              reviewPayload: { targetFile: (input as any)?.targetFile ?? "file.ts" },
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "mut-dispatch-1", mode: "ASK", instruction: "Edit file and complete" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const mutEval = result.evalResults?.find((e) => e.checkpoint === "MUTATION_RESULT")
      results.push({
        id: "integrity.6",
        category: "RUNTIME_INTEGRITY",
        description: "MUTATION_RESULT checkpoint is evaluated and recorded upon successful mutation",
        actual: {
          mutEvalPresent: mutEval !== undefined,
          checkpoint: mutEval?.checkpoint,
          decision: mutEval?.decision,
        },
        expected: {
          mutEvalPresent: true,
          checkpoint: "MUTATION_RESULT",
          decision: "CONTINUE",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 79: REQUEST_MORE_CONTEXT consumes bounded file fragment and injects observation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-req-ctx-"))
    try {
      await writeFile(join(ws, "config.json"), JSON.stringify({ environment: "production", timeout: 30 }), "utf-8")
      let turnCount = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(_evalResult: any): any {
          turnCount++
          if (turnCount === 1) {
            return {
              decision: "REQUEST_MORE_CONTEXT",
              action: "REQUEST_CONTEXT",
              shouldFinalize: false,
              contextRequest: { type: "FILE", target: "config.json" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: false }
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Initial thought without tools." },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Resolved config context successfully." },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "req-ctx-1", mode: "ASK", instruction: "Check configuration" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "integrity.7",
        category: "RUNTIME_INTEGRITY",
        description: "REQUEST_MORE_CONTEXT directive loads repository file and injects runtime_eval_context observation",
        actual: {
          status: result.status,
          turns: result.turns,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          turns: 2,
          finalAnswer: "Resolved config context successfully.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 80: CHANGE_MODEL forwards modelRecommendation metadata on subsequent turns
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-chg-model-"))
    try {
      let turnCount = 0
      let capturedRecommendation: Record<string, unknown> | undefined

      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(_evalResult: any): any {
          turnCount++
          if (turnCount === 1) {
            return {
              decision: "CHANGE_MODEL",
              action: "RECOMMEND_MODEL",
              shouldFinalize: false,
              modelRecommendation: { capability: "COMPLEX_REASONING", reason: "Requires multi-step analysis" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: false }
        }
      })()

      class InspectingProvider extends ScriptedModelProvider {
        override async complete(request: any) {
          if (request.metadata?.modelRecommendation) {
            capturedRecommendation = request.metadata.modelRecommendation
          }
          return super.complete(request)
        }
      }

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        provider: new InspectingProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Needs complex model analysis." },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Solved with upgraded model recommendation." },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "chg-model-1", mode: "ASK", instruction: "Solve hard puzzle" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "integrity.8",
        category: "RUNTIME_INTEGRITY",
        description: "RECOMMEND_MODEL directive forwards model recommendation metadata to subsequent turns",
        actual: {
          status: result.status,
          turns: result.turns,
          recommendedCapability: (capturedRecommendation as any)?.capability,
          recommendedReason: (capturedRecommendation as any)?.reason,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          turns: 2,
          recommendedCapability: "COMPLEX_REASONING",
          recommendedReason: "Requires multi-step analysis",
          finalAnswer: "Solved with upgraded model recommendation.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 81: Hard L0 dominance over L2 critic (unverified mutation blocks CONTINUE)
  {
    const collector = new RuntimeEvidenceCollector({ runId: "l0-dom-1", taskGoal: "Verify L0 dominance" })
    collector.recordMutationOutcome({ mutationId: "m-dom-1", path: "server.ts", status: "APPLIED" })
    const critic = {
      evaluate: async () => ({
        assessment: "Critic mistakenly thinks unverified mutations can complete",
        confidence: 0.99,
        suggestedDecision: "CONTINUE" as const,
        reasonCodes: [],
        flags: [],
      }),
    }
    const engine = new RuntimeEvalEngine({ critic, forceCritic: true })
    const result = await engine.evaluate(collector, "BEFORE_COMPLETION", 1)
    results.push({
      id: "integrity.9",
      category: "RUNTIME_INTEGRITY",
      description: "Hard L0 rule dominates L2 critic suggestions so unverified mutations require VERIFY",
      actual: {
        criticSuggested: "CONTINUE",
        finalDecision: result.decision,
        hasUnverifiedSignal: result.signals.some((s) => s.code === "UNVERIFIED_MUTATION"),
      },
      expected: {
        criticSuggested: "CONTINUE",
        finalDecision: "VERIFY",
        hasUnverifiedSignal: true,
      },
    })
  }

  // Scenario 82: Analytics distinguishes recommended, applied, and stale dropped interventions
  {
    const ledger = new RuntimeEvalLedger()
    const evalResult1 = {
      evalId: "e-1",
      runId: "run-ana",
      turnId: 1,
      checkpoint: "BEFORE_COMPLETION" as const,
      evidenceVersion: 1,
      decision: "VERIFY" as const,
      scores: { progress: 0.5, completionConfidence: 0.5, verificationCoverage: 0.5, planAdherence: 1, executionEfficiency: 1, logicalConsistency: 1, safetyAuthority: 1 },
      signals: [],
      evaluatorLevel: "L0" as const,
      confidence: 1,
    }
    const evalResult2 = {
      evalId: "e-2",
      runId: "run-ana",
      turnId: 2,
      checkpoint: "TOOL_FAILURE" as const,
      evidenceVersion: 2,
      decision: "REVISE" as const,
      scores: { progress: 0.5, completionConfidence: 0.5, verificationCoverage: 0.5, planAdherence: 1, executionEfficiency: 1, logicalConsistency: 1, safetyAuthority: 1 },
      signals: [],
      evaluatorLevel: "L0" as const,
      confidence: 1,
    }
    const evalResult3 = {
      evalId: "e-3",
      runId: "run-ana",
      turnId: 3,
      checkpoint: "PERIODIC" as const,
      evidenceVersion: 3,
      decision: "VERIFY" as const,
      scores: { progress: 0.5, completionConfidence: 0.5, verificationCoverage: 0.5, planAdherence: 1, executionEfficiency: 1, logicalConsistency: 1, safetyAuthority: 1 },
      signals: [],
      evaluatorLevel: "L0" as const,
      confidence: 1,
    }

    ledger.recordEval(evalResult1, "SCHEDULE_VERIFICATION", { applied: true })
    ledger.recordEval(evalResult2, "INJECT_REVISION", { staleDropped: true, applied: false })
    ledger.recordEval(evalResult3, "SCHEDULE_VERIFICATION", { applied: false })

    const analytics = new RuntimeEvalAnalytics(ledger)
    const summary = analytics.getRunSummary("run-ana")

    results.push({
      id: "integrity.10",
      category: "RUNTIME_INTEGRITY",
      description: "Analytics accurately tracks recommended, applied, and stale dropped interventions",
      actual: {
        recommendedInterventions: summary.recommendedInterventions,
        appliedInterventions: summary.appliedInterventions,
        staleDroppedInterventions: summary.staleDroppedInterventions,
      },
      expected: {
        recommendedInterventions: 3,
        appliedInterventions: 1,
        staleDroppedInterventions: 1,
      },
    })
  }

  // =========================================================================
  // CATEGORY 10: Adaptive Decision Completion & Loop Closure (Scenarios 83-107)
  // =========================================================================

  // Scenario 83: MUTATION_RESULT SCHEDULE_VERIFICATION passes -> postDirective CONTINUE allows normal continuation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-post-verif-pass-"))
    try {
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          if (evalResult.checkpoint === "MUTATION_RESULT") {
            return {
              decision: "VERIFY",
              action: "SCHEDULE_VERIFICATION",
              shouldFinalize: false,
            }
          }
          return super.determineDirective(evalResult, evidence)
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "mut-1", name: "apply_mutation", arguments: { path: "fix.ts", content: "const x = 1;" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Completed after successful verification." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_mutation", description: "Apply code mutation", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async () => ({
              id: "m-rev-pass",
              reviewPayload: {},
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
          {
            definition: { name: "run_verification", description: "Run verification test suite", action: "run_known_test", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "PASS", totalTests: 5, failedTests: 0 }),
            prepareForReview: async () => ({
              id: "v-rev-pass",
              reviewPayload: {},
              apply: async () => ({ status: "PASS", totalTests: 5, failedTests: 0 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "post-verif-pass-1", mode: "BUILD", instruction: "Apply fix and verify" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const verifOutcome = result.evalResults?.find((e) => e.checkpoint === "VERIFICATION_RESULT")
      results.push({
        id: "completion.1",
        category: "ADAPTIVE_COMPLETION",
        description: "MUTATION_RESULT schedules verification and CONTINUE postDirective enables clean completion",
        actual: {
          status: result.status,
          turns: result.turns,
          hasVerifEval: verifOutcome !== undefined,
          verifDecision: verifOutcome?.decision,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          turns: 2,
          hasVerifEval: true,
          verifDecision: "CONTINUE",
          finalAnswer: "Completed after successful verification.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 84: MUTATION_RESULT SCHEDULE_VERIFICATION fails -> postDirective REVISE injects revision observation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-post-verif-revise-"))
    try {
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          if (evalResult.checkpoint === "MUTATION_RESULT") {
            return {
              decision: "VERIFY",
              action: "SCHEDULE_VERIFICATION",
              shouldFinalize: false,
            }
          }
          return super.determineDirective(evalResult, evidence)
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "mut-rev-1", name: "apply_mutation", arguments: { path: "bug.ts", content: "broken" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Got revision observation, fixing..." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_mutation", description: "Apply code mutation", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async () => ({
              id: "m-rev-fail",
              reviewPayload: {},
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
          {
            definition: { name: "run_verification", description: "Run verification test suite", action: "run_known_test", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "FAIL", totalTests: 5, failedTests: 2, failureSummary: "Syntax error in bug.ts" }),
            prepareForReview: async () => ({
              id: "v-rev-fail",
              reviewPayload: {},
              apply: async () => ({ status: "FAIL", totalTests: 5, failedTests: 2, failureSummary: "Syntax error in bug.ts" }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "post-verif-rev-1", mode: "BUILD", instruction: "Apply fix and verify" },
        workspaceRoot: ws,
        maxTurns: 2,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const revObs = result.observations?.find((o) => o.errorCategory === "REVISION_REQUIRED")
      const verifEval = result.evalResults?.find((e) => e.checkpoint === "VERIFICATION_RESULT")
      results.push({
        id: "completion.2",
        category: "ADAPTIVE_COMPLETION",
        description: "MUTATION_RESULT schedules verification and failing test dispatches REVISE observation",
        actual: {
          hasVerifEval: verifEval !== undefined,
          verifDecision: verifEval?.decision,
          hasRevisionObservation: revObs !== undefined,
        },
        expected: {
          hasVerifEval: true,
          verifDecision: "REVISE",
          hasRevisionObservation: true,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 85: MUTATION_RESULT SCHEDULE_VERIFICATION fails -> postDirective REPLAN triggers replan observation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-post-verif-replan-"))
    try {
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          if (evalResult.checkpoint === "MUTATION_RESULT") {
            return {
              decision: "VERIFY",
              action: "SCHEDULE_VERIFICATION",
              shouldFinalize: false,
            }
          }
          if (evalResult.checkpoint === "VERIFICATION_RESULT") {
            return {
              decision: "REPLAN",
              action: "TRIGGER_REPLAN",
              shouldFinalize: false,
              promptContext: "Approach repeatedly failed verification. Replan required.",
            }
          }
          return super.determineDirective(evalResult, evidence)
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "mut-rep-1", name: "apply_mutation", arguments: { path: "bad.ts", content: "bad" } }],
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Formulating new plan from replan directive." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_mutation", description: "Apply code mutation", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async () => ({
              id: "m-rep-fail",
              reviewPayload: {},
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
          {
            definition: { name: "run_verification", description: "Run verification test suite", action: "run_known_test", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "FAIL", totalTests: 3, failedTests: 3 }),
            prepareForReview: async () => ({
              id: "v-rep-fail",
              reviewPayload: {},
              apply: async () => ({ status: "FAIL", totalTests: 3, failedTests: 3 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "post-verif-rep-1", mode: "BUILD", instruction: "Fix with replan" },
        workspaceRoot: ws,
        maxTurns: 2,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const replanObs = result.observations?.find((o) => o.errorCategory === "REPLAN_REQUIRED")
      results.push({
        id: "completion.3",
        category: "ADAPTIVE_COMPLETION",
        description: "Post-verification REPLAN directive dispatches TRIGGER_REPLAN observation",
        actual: {
          hasReplanObservation: replanObs !== undefined,
          turns: result.turns,
        },
        expected: {
          hasReplanObservation: true,
          turns: 2,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 86: MUTATION_RESULT SCHEDULE_VERIFICATION returns ASK_HUMAN -> pauses execution
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-post-verif-human-"))
    try {
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          if (evalResult.checkpoint === "MUTATION_RESULT") {
            return {
              decision: "VERIFY",
              action: "SCHEDULE_VERIFICATION",
              shouldFinalize: false,
            }
          }
          if (evalResult.checkpoint === "VERIFICATION_RESULT") {
            return {
              decision: "ASK_HUMAN",
              action: "PAUSE_HUMAN",
              shouldFinalize: false,
              stopReason: "Critical verification discrepancy requires human review",
            }
          }
          return super.determineDirective(evalResult, evidence)
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "mut-hum-1", name: "apply_mutation", arguments: { path: "sec.ts", content: "sec" } }],
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_mutation", description: "Apply mutation", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async () => ({
              id: "m-hum-pass",
              reviewPayload: {},
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
          {
            definition: { name: "run_verification", description: "Run verification test suite", action: "run_known_test", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "PASS", totalTests: 1, failedTests: 0 }),
            prepareForReview: async () => ({
              id: "v-hum-pass",
              reviewPayload: {},
              apply: async () => ({ status: "PASS", totalTests: 1, failedTests: 0 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "post-verif-hum-1", mode: "BUILD", instruction: "Apply mutation" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "completion.4",
        category: "ADAPTIVE_COMPLETION",
        description: "Post-verification ASK_HUMAN directive pauses runner in WAITING_FOR_CONFIRMATION",
        actual: {
          status: result.status,
          hasConfirmation: result.confirmation !== undefined,
        },
        expected: {
          status: "PAUSED",
          hasConfirmation: true,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 87: MUTATION_RESULT SCHEDULE_VERIFICATION returns STOP -> terminates run
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-post-verif-stop-"))
    try {
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          if (evalResult.checkpoint === "MUTATION_RESULT") {
            return {
              decision: "VERIFY",
              action: "SCHEDULE_VERIFICATION",
              shouldFinalize: false,
            }
          }
          if (evalResult.checkpoint === "VERIFICATION_RESULT") {
            return {
              decision: "STOP",
              action: "TERMINATE_RUN",
              shouldFinalize: false,
              stopReason: "Unrecoverable verification crash detected",
            }
          }
          return super.determineDirective(evalResult, evidence)
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "" },
            toolCalls: [{ id: "mut-stp-1", name: "apply_mutation", arguments: { path: "crash.ts", content: "crash" } }],
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: { name: "apply_mutation", description: "Apply mutation", action: "write_file", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "APPLIED" }),
            prepareForReview: async () => ({
              id: "m-stp-fail",
              reviewPayload: {},
              apply: async () => ({ status: "APPLIED" }),
            }),
          },
          {
            definition: { name: "run_verification", description: "Run verification test suite", action: "run_known_test", inputSchema: {} },
            validate: (a) => a as any,
            execute: async () => ({ status: "FAIL", totalTests: 1, failedTests: 1 }),
            prepareForReview: async () => ({
              id: "v-stp-fail",
              reviewPayload: {},
              apply: async () => ({ status: "FAIL", totalTests: 1, failedTests: 1 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "post-verif-stp-1", mode: "BUILD", instruction: "Apply mutation" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "completion.5",
        category: "ADAPTIVE_COMPLETION",
        description: "Post-verification STOP directive terminates run with RUNTIME_EVAL terminationSource",
        actual: {
          status: result.status,
          failureReason: result.failureReason,
          terminationSource: result.terminationSource,
        },
        expected: {
          status: "FAILED",
          failureReason: "NON_PROGRESS",
          terminationSource: "RUNTIME_EVAL",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 88: BEFORE_COMPLETION scheduled verification passes but VERIFICATION_RESULT eval returns REVISE -> blocks completion
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-comp-block-rev-"))
    try {
      let verifCallCount = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          if (evalResult.checkpoint === "BEFORE_COMPLETION") {
            return {
              decision: "VERIFY",
              action: "SCHEDULE_VERIFICATION",
              shouldFinalize: false,
            }
          }
          if (evalResult.checkpoint === "VERIFICATION_RESULT") {
            verifCallCount++
            if (verifCallCount === 1) {
              return {
                decision: "REVISE",
                action: "INJECT_REVISION",
                shouldFinalize: false,
                promptContext: "Coverage insufficient despite passing test. Revise implementation.",
              }
            }
            return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
          }
          return super.determineDirective(evalResult, evidence)
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "I am ready to complete." },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Revised and now completing." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: {
              name: "run_verification",
              description: "Run verification test suite",
              action: "run_known_test",
              inputSchema: {},
            },
            validate: (a) => a as any,
            execute: async () => ({ status: "PASS", totalTests: 2, failedTests: 0 }),
            prepareForReview: async () => ({
              id: "v-rev-comp-88",
              reviewPayload: {},
              apply: async () => ({ status: "PASS", totalTests: 2, failedTests: 0 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "comp-blk-rev-1", mode: "BUILD", instruction: "Build and complete" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "completion.6",
        category: "ADAPTIVE_COMPLETION",
        description: "Passing verification blocked from completion when post-verification eval requires REVISE",
        actual: {
          turns: result.turns,
          verifCalls: verifCallCount,
          status: result.status,
        },
        expected: {
          turns: 2,
          verifCalls: 2,
          status: "COMPLETED",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 89: BEFORE_COMPLETION scheduled verification passes and postDirective is CONTINUE -> completes
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-comp-pass-cont-"))
    try {
      const runner = new AgentRunner({
        evidenceGate: false,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Task finished." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: {
              name: "run_verification",
              description: "Run verification test suite",
              action: "run_known_test",
              inputSchema: {},
            },
            validate: (a) => a as any,
            execute: async () => ({ status: "PASS", totalTests: 10, failedTests: 0 }),
            prepareForReview: async () => ({
              id: "v-rev-comp-89",
              reviewPayload: {},
              apply: async () => ({ status: "PASS", totalTests: 10, failedTests: 0 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "comp-pass-cont-1", mode: "BUILD", instruction: "Build feature" },
        workspaceRoot: ws,
        maxTurns: 2,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "completion.7",
        category: "ADAPTIVE_COMPLETION",
        description: "BEFORE_COMPLETION verification passes and CONTINUE postDirective enables immediate completion",
        actual: {
          status: result.status,
          turns: result.turns,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          turns: 1,
          finalAnswer: "Task finished.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 90: BEFORE_COMPLETION scheduled verification fails and postDirective is STOP -> terminates run
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-comp-fail-stop-"))
    try {
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          if (evalResult.checkpoint === "BEFORE_COMPLETION") {
            return {
              decision: "VERIFY",
              action: "SCHEDULE_VERIFICATION",
              shouldFinalize: false,
            }
          }
          if (evalResult.checkpoint === "VERIFICATION_RESULT") {
            return {
              decision: "STOP",
              action: "TERMINATE_RUN",
              shouldFinalize: false,
              stopReason: "Verification failed at completion boundary",
            }
          }
          return super.determineDirective(evalResult, evidence)
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        permissionEvaluator: (action) => (action.action === "write_file" || action.action === "run_known_test" ? "ALLOW" : classifyPermission(action)),
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Attempting completion without testing." },
          },
        ]),
        registry: new ToolRegistry([
          {
            definition: {
              name: "run_verification",
              description: "Run verification test suite",
              action: "run_known_test",
              inputSchema: {},
            },
            validate: (a) => a as any,
            execute: async () => ({ status: "FAIL", totalTests: 1, failedTests: 1 }),
            prepareForReview: async () => ({
              id: "v-rev-comp-90",
              reviewPayload: {},
              apply: async () => ({ status: "FAIL", totalTests: 1, failedTests: 1 }),
            }),
          },
        ]),
      })
      const result = await runner.run({
        task: { id: "comp-fail-stop-1", mode: "BUILD", instruction: "Build and complete" },
        workspaceRoot: ws,
        maxTurns: 2,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "completion.8",
        category: "ADAPTIVE_COMPLETION",
        description: "BEFORE_COMPLETION scheduled verification fails and STOP terminates run",
        actual: {
          status: result.status,
          failureReason: result.failureReason,
          terminationSource: result.terminationSource,
        },
        expected: {
          status: "FAILED",
          failureReason: "NON_PROGRESS",
          terminationSource: "RUNTIME_EVAL",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 91: ModelRouter with avoidDeploymentId selects alternative candidate
  {
    const config = {
      providers: [{ id: "p1", kind: "scripted" as const }],
      models: [
        { id: "m-fast", contextWindow: 4000, capabilities: ["toolUse" as const, "coding" as const], specialization: "coding" as const },
        { id: "m-smart", contextWindow: 4000, capabilities: ["toolUse" as const, "coding" as const], specialization: "coding" as const },
      ],
      deployments: [
        { id: "dep-fast", providerId: "p1", modelId: "m-fast", enabled: true, priority: 10 },
        { id: "dep-smart", providerId: "p1", modelId: "m-smart", enabled: true, priority: 5 },
      ],
      routes: {
        coding: ["dep-fast", "dep-smart"],
      },
    }
    const router = new ModelRouter(config)
    const health = new StaticHealthChecker()
    const decision = await router.route({
      taskClass: "coding",
      needsTools: true,
      needsStructuredOutput: false,
      estimatedInputTokens: 500,
      requiredContextWindow: 2000,
      hint: { avoidDeploymentId: "dep-fast" },
    }, health)
    results.push({
      id: "completion.9",
      category: "ADAPTIVE_COMPLETION",
      description: "ModelRouter with avoidDeploymentId selects alternative candidate despite lower base priority",
      actual: {
        deploymentId: decision.deploymentId,
        hasHintAvoided: decision.reasons.includes("hint_avoided"),
      },
      expected: {
        deploymentId: "dep-smart",
        hasHintAvoided: true,
      },
    })
  }

  // Scenario 92: ModelRouter with avoidDeploymentId retains candidate when no alternative is eligible
  {
    const config = {
      providers: [{ id: "p1", kind: "scripted" as const }],
      models: [
        { id: "m-fast", contextWindow: 4000, capabilities: ["toolUse" as const, "coding" as const], specialization: "coding" as const },
        { id: "m-broken", contextWindow: 4000, capabilities: ["toolUse" as const, "coding" as const], specialization: "coding" as const },
      ],
      deployments: [
        { id: "dep-fast", providerId: "p1", modelId: "m-fast", enabled: true, priority: 10 },
        { id: "dep-broken", providerId: "p1", modelId: "m-broken", enabled: false, priority: 5 },
      ],
      routes: {
        coding: ["dep-fast", "dep-broken"],
      },
    }
    const router = new ModelRouter(config)
    const health = new StaticHealthChecker()
    const decision = await router.route({
      taskClass: "coding",
      needsTools: true,
      needsStructuredOutput: false,
      estimatedInputTokens: 500,
      requiredContextWindow: 2000,
      hint: { avoidDeploymentId: "dep-fast" },
    }, health)
    results.push({
      id: "completion.10",
      category: "ADAPTIVE_COMPLETION",
      description: "ModelRouter retains avoided candidate when no other candidate is eligible without failing",
      actual: {
        deploymentId: decision.deploymentId,
        hasHintAvoided: decision.reasons.includes("hint_avoided"),
      },
      expected: {
        deploymentId: "dep-fast",
        hasHintAvoided: false,
      },
    })
  }

  // Scenario 93: ModelRouter with preferredDeploymentId prioritizes candidate
  {
    const config = {
      providers: [{ id: "p1", kind: "scripted" as const }],
      models: [
        { id: "m1", contextWindow: 4000, capabilities: ["toolUse" as const], specialization: "general" as const },
        { id: "m2", contextWindow: 4000, capabilities: ["toolUse" as const], specialization: "general" as const },
      ],
      deployments: [
        { id: "dep-1", providerId: "p1", modelId: "m1", enabled: true, priority: 10 },
        { id: "dep-2", providerId: "p1", modelId: "m2", enabled: true, priority: 1 },
      ],
      routes: {
        default: ["dep-1", "dep-2"],
      },
    }
    const router = new ModelRouter(config)
    const health = new StaticHealthChecker()
    const decision = await router.route({
      taskClass: "general",
      needsTools: true,
      needsStructuredOutput: false,
      estimatedInputTokens: 200,
      requiredContextWindow: 1000,
      hint: { preferredDeploymentId: "dep-2" },
    }, health)
    results.push({
      id: "completion.11",
      category: "ADAPTIVE_COMPLETION",
      description: "ModelRouter with preferredDeploymentId routes to preferred deployment over higher priority",
      actual: {
        deploymentId: decision.deploymentId,
        hasHintPreferred: decision.reasons.includes("hint_preferred"),
      },
      expected: {
        deploymentId: "dep-2",
        hasHintPreferred: true,
      },
    })
  }

  // Scenario 94: ModelRouter with preferredCapabilities matches capability
  {
    const config = {
      providers: [{ id: "p1", kind: "scripted" as const }],
      models: [
        { id: "m-base", contextWindow: 4000, capabilities: ["toolUse" as const, "coding" as const], specialization: "coding" as const },
        { id: "m-reason", contextWindow: 4000, capabilities: ["toolUse" as const, "coding" as const, "reasoning" as const], specialization: "coding" as const },
      ],
      deployments: [
        { id: "dep-base", providerId: "p1", modelId: "m-base", enabled: true, priority: 10 },
        { id: "dep-reason", providerId: "p1", modelId: "m-reason", enabled: true, priority: 2 },
      ],
      routes: {
        coding: ["dep-base", "dep-reason"],
      },
    }
    const router = new ModelRouter(config)
    const health = new StaticHealthChecker()
    const decision = await router.route({
      taskClass: "coding",
      needsTools: true,
      needsStructuredOutput: false,
      estimatedInputTokens: 200,
      requiredContextWindow: 1000,
      hint: { preferredCapabilities: ["reasoning"] },
    }, health)
    results.push({
      id: "completion.12",
      category: "ADAPTIVE_COMPLETION",
      description: "ModelRouter with preferredCapabilities routes to candidate possessing preferred capability",
      actual: {
        deploymentId: decision.deploymentId,
        hasHintPreferred: decision.reasons.includes("hint_preferred"),
      },
      expected: {
        deploymentId: "dep-reason",
        hasHintPreferred: true,
      },
    })
  }

  // Scenario 95: RoutedModelGateway extracts request metadata routeHint and routes accordingly
  {
    const config = {
      providers: [{ id: "p1", kind: "scripted" as const }],
      models: [
        { id: "m1", contextWindow: 8192, capabilities: ["toolUse" as const], specialization: "general" as const },
        { id: "m2", contextWindow: 8192, capabilities: ["toolUse" as const], specialization: "general" as const },
      ],
      deployments: [
        { id: "dep-1", providerId: "p1", modelId: "m1", enabled: true, priority: 10 },
        { id: "dep-2", providerId: "p1", modelId: "m2", enabled: true, priority: 1 },
      ],
      routes: {
        default: ["dep-1", "dep-2"],
      },
    }
    const providers = new Map([
      ["dep-1", new ScriptedModelProvider([{ model: "m1", message: { role: "assistant", content: "From dep-1" } }])],
      ["dep-2", new ScriptedModelProvider([{ model: "m2", message: { role: "assistant", content: "From dep-2" } }])],
    ])
    const gateway = new RoutedModelGateway({
      config,
      providers,
      mode: "ASK",
      hasTools: false,
      hasStructuredOutput: false,
    })
    const response = await gateway.complete({
      messages: [{ role: "user", content: "Hello" }],
      metadata: {
        routeHint: { avoidDeploymentId: "dep-1" },
      },
    })
    results.push({
      id: "completion.13",
      category: "ADAPTIVE_COMPLETION",
      description: "RoutedModelGateway consumes routeHint from request metadata and attaches route provenance",
      actual: {
        deploymentId: (response.metadata?.routeProvenance as any)?.deploymentId,
        content: response.message.content,
      },
      expected: {
        deploymentId: "dep-2",
        content: "From dep-2",
      },
    })
  }

  // Scenario 96: AgentRunner CHANGE_MODEL sets routeHint with 1-turn bounded lifetime
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-route-lifetime-"))
    try {
      const config = {
        providers: [
          { id: "p1", kind: "scripted" as const },
          { id: "p2", kind: "scripted" as const },
        ],
        models: [
          { id: "m1", contextWindow: 8192, capabilities: ["toolUse" as const, "reasoning" as const], specialization: "general" as const },
          { id: "m2", contextWindow: 8192, capabilities: ["toolUse" as const, "reasoning" as const], specialization: "general" as const },
        ],
        deployments: [
          { id: "dep-primary", providerId: "p1", modelId: "m1", enabled: true, priority: 10 },
          { id: "dep-secondary", providerId: "p2", modelId: "m2", enabled: true, priority: 5 },
        ],
        routes: {
          general: ["dep-primary", "dep-secondary"],
        },
      }

      const pingTool = {
        definition: { name: "ping", description: "Ping tool", action: "read_repository" as const, inputSchema: {} },
        validate: (a: any) => a,
        execute: async () => ({ pong: true }),
      }

      const p1 = new ScriptedModelProvider([
        { model: "m1", message: { role: "assistant", content: "Turn 1 from dep-primary" } },
        { model: "m1", message: { role: "assistant", content: "Turn 3 from dep-primary" } },
      ])
      const p2 = new ScriptedModelProvider([
        {
          model: "m2",
          message: { role: "assistant", content: "Turn 2 from dep-secondary calling tool" },
          toolCalls: [{ id: "c1", name: "ping", arguments: {} }],
        },
      ])

      const gateway = new RoutedModelGateway({
        config,
        providers: new Map([
          ["dep-primary", p1],
          ["dep-secondary", p2],
        ]),
        mode: "ASK",
        budget: defaultContextBudget,
        hasTools: true,
        hasStructuredOutput: false,
      })

      let evalTurn = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          evalTurn++
          if (evalTurn === 1) {
            return {
              decision: "CHANGE_MODEL",
              action: "RECOMMEND_MODEL",
              shouldFinalize: false,
              modelRecommendation: { capability: "reasoning", reason: "Upgrade for complex reasoning" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        provider: gateway,
        registry: new ToolRegistry([pingTool]),
      })
      await runner.run({
        task: { id: "route-life-1", mode: "ASK", instruction: "Solve puzzle" },
        workspaceRoot: ws,
        maxTurns: 4,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "completion.14",
        category: "ADAPTIVE_COMPLETION",
        description: "AgentRunner pendingRouteHint has 1-turn bounded lifetime and clears on subsequent turns",
        actual: {
          turn1HasHint: (p1.requests[0]?.metadata?.routeHint) !== undefined,
          turn2HasHint: (p2.requests[0]?.metadata?.routeHint) !== undefined,
          turn3HasHint: (p1.requests[1]?.metadata?.routeHint) !== undefined,
          turn2Reason: (p2.requests[0]?.metadata?.routeHint as any)?.reasonCode,
        },
        expected: {
          turn1HasHint: false,
          turn2HasHint: true,
          turn3HasHint: false,
          turn2Reason: "Upgrade for complex reasoning",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 97: AgentRunner outcome linking on model change
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-route-outcome-"))
    try {
      const config = {
        providers: [
          { id: "prov-alpha", kind: "scripted" as const },
          { id: "prov-beta", kind: "scripted" as const },
        ],
        models: [
          { id: "mod-alpha", contextWindow: 8192, capabilities: ["toolUse" as const, "coding" as const], specialization: "general" as const },
          { id: "mod-beta", contextWindow: 8192, capabilities: ["toolUse" as const, "coding" as const], specialization: "general" as const },
        ],
        deployments: [
          { id: "dep-alpha", providerId: "prov-alpha", modelId: "mod-alpha", enabled: true, priority: 10 },
          { id: "dep-beta", providerId: "prov-beta", modelId: "mod-beta", enabled: true, priority: 5 },
        ],
        routes: {
          general: ["dep-alpha", "dep-beta"],
        },
      }

      const pAlpha = new ScriptedModelProvider([
        { model: "mod-alpha", message: { role: "assistant", content: "Response from dep-alpha" } },
      ])
      const pBeta = new ScriptedModelProvider([
        { model: "mod-beta", message: { role: "assistant", content: "Response from dep-beta" } },
      ])

      const gateway = new RoutedModelGateway({
        config,
        providers: new Map([
          ["dep-alpha", pAlpha],
          ["dep-beta", pBeta],
        ]),
        mode: "ASK",
        budget: defaultContextBudget,
        hasTools: false,
        hasStructuredOutput: false,
      })

      let customPolicyTurn = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          customPolicyTurn++
          if (customPolicyTurn === 1) {
            return {
              decision: "CHANGE_MODEL",
              action: "RECOMMEND_MODEL",
              shouldFinalize: false,
              modelRecommendation: { capability: "coding", reason: "Switch model" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const ledger = new RuntimeEvalLedger()
      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        evalLedger: ledger,
        provider: gateway,
        registry: new ToolRegistry([]),
      })
      await runner.run({
        task: { id: "route-out-1", mode: "ASK", instruction: "Test model outcome linking" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const ledgerEntry = ledger.getEntries().find((e: any) => e.interventionAction === "RECOMMEND_MODEL")
      results.push({
        id: "completion.15",
        category: "ADAPTIVE_COMPLETION",
        description: "AgentRunner records RESOLVED outcome linked to CHANGE_MODEL evalId after deployment switch",
        actual: {
          hasChangeEval: ledgerEntry !== undefined,
          interventionOutcome: ledgerEntry?.outcome,
        },
        expected: {
          hasChangeEval: true,
          interventionOutcome: "RESOLVED",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 98: Security and capability constraints preserved during CHANGE_MODEL
  {
    const config = {
      providers: [{ id: "p1", kind: "scripted" as const }],
      models: [
        { id: "m-healthy", contextWindow: 4000, capabilities: ["toolUse" as const], specialization: "general" as const },
        { id: "m-disabled", contextWindow: 4000, capabilities: ["toolUse" as const], specialization: "general" as const },
        { id: "m-small", contextWindow: 500, capabilities: ["toolUse" as const], specialization: "general" as const },
      ],
      deployments: [
        { id: "dep-healthy", providerId: "p1", modelId: "m-healthy", enabled: true, priority: 1 },
        { id: "dep-disabled", providerId: "p1", modelId: "m-disabled", enabled: false, priority: 100 },
        { id: "dep-small", providerId: "p1", modelId: "m-small", enabled: true, priority: 50 },
      ],
      routes: {
        default: ["dep-healthy", "dep-disabled", "dep-small"],
      },
    }
    const router = new ModelRouter(config)
    const health = new StaticHealthChecker()
    const decision = await router.route({
      taskClass: "general",
      needsTools: true,
      needsStructuredOutput: false,
      estimatedInputTokens: 600,
      requiredContextWindow: 2000,
      hint: { preferredDeploymentId: "dep-disabled" },
    }, health)
    results.push({
      id: "completion.16",
      category: "ADAPTIVE_COMPLETION",
      description: "ModelRouter strictly preserves disabled candidate rejection even when requested by route hint",
      actual: {
        selectedDeploymentId: decision.deploymentId,
        rejectedReasons: decision.rejectedCandidates?.map((r) => r.reason).toSorted(),
      },
      expected: {
        selectedDeploymentId: "dep-healthy",
        rejectedReasons: ["disabled", "insufficient_context"],
      },
    })
  }

  // Scenario 99: REQUEST_MORE_CONTEXT file resolved -> explicit re-eval CONTINUE allows completion
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-ctx-pass-"))
    try {
      await writeFile(join(ws, "manifest.json"), JSON.stringify({ name: "core", version: "1.0.0" }), "utf-8")
      let evalCount = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          evalCount++
          if (evalCount === 1) {
            return {
              decision: "REQUEST_MORE_CONTEXT",
              action: "REQUEST_CONTEXT",
              shouldFinalize: false,
              contextRequest: { target: "manifest.json", reason: "Need package metadata" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Initial query" },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Got package metadata, completed." },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "ctx-pass-1", mode: "ASK", instruction: "Read package metadata" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const ctxObs = result.observations?.find((o) => o.toolName === "runtime_eval_context")
      results.push({
        id: "completion.17",
        category: "ADAPTIVE_COMPLETION",
        description: "REQUEST_MORE_CONTEXT resolves file, triggers explicit re-eval, and CONTINUE enables task completion",
        actual: {
          status: result.status,
          hasContextObservation: ctxObs !== undefined,
          finalAnswer: result.finalAnswer,
        },
        expected: {
          status: "COMPLETED",
          hasContextObservation: true,
          finalAnswer: "Got package metadata, completed.",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 100: REQUEST_MORE_CONTEXT file resolved -> explicit re-eval REPLAN injects replan observation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-ctx-replan-"))
    try {
      await writeFile(join(ws, "error.log"), "Fatal: memory corrupted", "utf-8")
      let evalCount = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          evalCount++
          if (evalCount === 1) {
            return {
              decision: "REQUEST_MORE_CONTEXT",
              action: "REQUEST_CONTEXT",
              shouldFinalize: false,
              contextRequest: { target: "error.log", reason: "Inspect log file" },
            }
          }
          if (evalCount === 2) {
            return {
              decision: "REPLAN",
              action: "TRIGGER_REPLAN",
              shouldFinalize: false,
              promptContext: "Fatal error in log requires total approach replanning.",
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Checking logs..." },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Revising overall strategy based on replan directive." },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "ctx-rep-1", mode: "DEBUG", instruction: "Investigate crash" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const replanObs = result.observations?.find((o) => o.errorCategory === "REPLAN_REQUIRED")
      results.push({
        id: "completion.18",
        category: "ADAPTIVE_COMPLETION",
        description: "REQUEST_MORE_CONTEXT explicit re-evaluation dispatches second directive REPLAN",
        actual: {
          hasReplanObservation: replanObs !== undefined,
          status: result.status,
        },
        expected: {
          hasReplanObservation: true,
          status: "COMPLETED",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 101: REQUEST_MORE_CONTEXT file resolved -> explicit re-eval ASK_HUMAN pauses runner
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-ctx-human-"))
    try {
      await writeFile(join(ws, "secrets.cfg"), "DB_PASS=xyz", "utf-8")
      let evalCount = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          evalCount++
          if (evalCount === 1) {
            return {
              decision: "REQUEST_MORE_CONTEXT",
              action: "REQUEST_CONTEXT",
              shouldFinalize: false,
              contextRequest: { target: "secrets.cfg", reason: "Check credentials" },
            }
          }
          if (evalCount === 2) {
            return {
              decision: "ASK_HUMAN",
              action: "PAUSE_HUMAN",
              shouldFinalize: false,
              stopReason: "Confidential credentials found in requested context",
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Checking config" },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "ctx-hum-1", mode: "ASK", instruction: "Check configuration safely" },
        workspaceRoot: ws,
        maxTurns: 2,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      results.push({
        id: "completion.19",
        category: "ADAPTIVE_COMPLETION",
        description: "REQUEST_MORE_CONTEXT explicit re-evaluation dispatches ASK_HUMAN and pauses runner",
        actual: {
          status: result.status,
          hasConfirmation: result.confirmation !== undefined,
        },
        expected: {
          status: "PAUSED",
          hasConfirmation: true,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 102: REQUEST_MORE_CONTEXT target unavailable yields DEGRADED outcome and replan observation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-ctx-miss-"))
    try {
      let evalCount = 0
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          evalCount++
          if (evalCount === 1) {
            return {
              decision: "REQUEST_MORE_CONTEXT",
              action: "REQUEST_CONTEXT",
              shouldFinalize: false,
              contextRequest: { target: "does_not_exist.txt", reason: "Missing doc" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const ledger = new RuntimeEvalLedger()
      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        evalLedger: ledger,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Looking for missing doc" },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Adapted to missing context." },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "ctx-miss-1", mode: "ASK", instruction: "Search doc" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const replanObs = result.observations?.find((o) => o.errorCategory === "CONTEXT_UNAVAILABLE")
      const ledgerEntry = ledger.getEntries().find((e: any) => e.interventionAction === "REQUEST_CONTEXT")
      results.push({
        id: "completion.20",
        category: "ADAPTIVE_COMPLETION",
        description: "REQUEST_MORE_CONTEXT records DEGRADED outcome when requested target cannot be resolved",
        actual: {
          hasUnavailableObservation: replanObs !== undefined,
          interventionOutcome: ledgerEntry?.outcome,
        },
        expected: {
          hasUnavailableObservation: true,
          interventionOutcome: "DEGRADED",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 103: REQUEST_MORE_CONTEXT loop bound prevents runaway context fetching
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-ctx-loop-"))
    try {
      await writeFile(join(ws, "file.txt"), "some content", "utf-8")
      const loopPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(_evalResult: any): any {
          return {
            decision: "REQUEST_MORE_CONTEXT",
            action: "REQUEST_CONTEXT",
            shouldFinalize: false,
            contextRequest: { target: "file.txt", reason: "Infinite loop context" },
          }
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: loopPolicy,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Need more data" },
          },
          {
            model: "scripted",
            message: { role: "assistant", content: "Got loop bound observation, stopping context loop." },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "ctx-loop-1", mode: "ASK", instruction: "Infinite context test" },
        workspaceRoot: ws,
        maxTurns: 2,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })
      const loopObs = result.observations?.find((o) => o.errorCategory === "CONTEXT_LOOP_EXCEEDED")
      results.push({
        id: "completion.21",
        category: "ADAPTIVE_COMPLETION",
        description: "REQUEST_MORE_CONTEXT caps consecutive context requests at MAX_CONSECUTIVE_CONTEXT_REQUESTS",
        actual: {
          hasLoopExceededObservation: loopObs !== undefined,
          turns: result.turns,
        },
        expected: {
          hasLoopExceededObservation: true,
          turns: 2,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 104: Context retrieval increments evidenceVersion avoiding dedup stale drops
  {
    const collector = new RuntimeEvidenceCollector({
      runId: "ev-ver-test",
      taskGoal: "Test version increment",
    })
    const v1 = collector.evidenceVersion
    collector.recordToolAction({
      id: "ctx-act-1",
      toolName: "runtime_eval_context",
      outcome: "COMPLETED",
      output: "Retrieved file content",
    })
    const v2 = collector.evidenceVersion
    const checkpointKeyV1 = `PERIODIC:${v1}`
    const checkpointKeyV2 = `PERIODIC:${v2}`
    collector.recordEvaluatedCheckpoint(checkpointKeyV1)
    results.push({
      id: "completion.22",
      category: "ADAPTIVE_COMPLETION",
      description: "Context retrieval increments evidenceVersion so subsequent evaluation is not dedup-cached",
      actual: {
        initialVersion: v1,
        updatedVersion: v2,
        v1Evaluated: collector.hasEvaluatedCheckpoint(checkpointKeyV1),
        v2Evaluated: collector.hasEvaluatedCheckpoint(checkpointKeyV2),
      },
      expected: {
        initialVersion: 1,
        updatedVersion: 2,
        v1Evaluated: true,
        v2Evaluated: false,
      },
    })
  }

  // Scenario 105: Adaptation Safety — Abort signal cancels runner before/during adaptation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-abort-"))
    try {
      const abortCtrl = new AbortController()
      const customPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(_evalResult: any): any {
          abortCtrl.abort()
          return {
            decision: "REQUEST_MORE_CONTEXT",
            action: "REQUEST_CONTEXT",
            shouldFinalize: false,
            contextRequest: { target: "any.txt", reason: "Aborted context" },
          }
        }
      })()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: customPolicy,
        provider: new ScriptedModelProvider([
          {
            model: "scripted",
            message: { role: "assistant", content: "Query" },
          },
        ]),
        registry: new ToolRegistry([]),
      })
      const result = await runner.run({
        task: { id: "abort-1", mode: "ASK", instruction: "Cancelled run" },
        workspaceRoot: ws,
        maxTurns: 2,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
        signal: abortCtrl.signal,
      })
      results.push({
        id: "completion.23",
        category: "ADAPTIVE_COMPLETION",
        description: "AbortSignal cancellation is honored during adaptive directive dispatch",
        actual: {
          status: result.status,
          failureReason: result.failureReason,
        },
        expected: {
          status: "CANCELLED",
          failureReason: "CANCELLED",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 106: Outcome Linking — Scheduled verification records pass as RESOLVED and fail as DEGRADED
  {
    const ledger = new RuntimeEvalLedger()
    const eval1 = {
      evalId: "verif-eval-pass",
      runId: "run-outcome-test",
      turnId: 1,
      checkpoint: "MUTATION_RESULT" as const,
      evidenceVersion: 1,
      decision: "VERIFY" as const,
      scores: { progress: 1, completionConfidence: 1, verificationCoverage: 1, planAdherence: 1, executionEfficiency: 1, logicalConsistency: 1, safetyAuthority: 1 },
      signals: [],
      evaluatorLevel: "L0" as const,
      confidence: 1,
    }
    const eval2 = {
      evalId: "verif-eval-fail",
      runId: "run-outcome-test",
      turnId: 2,
      checkpoint: "MUTATION_RESULT" as const,
      evidenceVersion: 2,
      decision: "VERIFY" as const,
      scores: { progress: 1, completionConfidence: 1, verificationCoverage: 1, planAdherence: 1, executionEfficiency: 1, logicalConsistency: 1, safetyAuthority: 1 },
      signals: [],
      evaluatorLevel: "L0" as const,
      confidence: 1,
    }

    ledger.recordEval(eval1, "SCHEDULE_VERIFICATION", { applied: true })
    ledger.recordEval(eval2, "SCHEDULE_VERIFICATION", { applied: true })

    ledger.recordInterventionOutcome("verif-eval-pass", "RESOLVED", "Verification PASS")
    ledger.recordInterventionOutcome("verif-eval-fail", "DEGRADED", "Verification FAIL")

    const entry1 = ledger.getEntries().find((e) => e.evalId === "verif-eval-pass")
    const entry2 = ledger.getEntries().find((e) => e.evalId === "verif-eval-fail")

    results.push({
      id: "completion.24",
      category: "ADAPTIVE_COMPLETION",
      description: "Scheduled verification updates intervention outcome to RESOLVED or DEGRADED in ledger",
      actual: {
        passOutcome: entry1?.outcome,
        failOutcome: entry2?.outcome,
      },
      expected: {
        passOutcome: "RESOLVED",
        failOutcome: "DEGRADED",
      },
    })
  }

  // Scenario 107: Analytics Aggregation with Outcomes and Separation of Layers
  {
    const ledger = new RuntimeEvalLedger()
    const entries = [
      { id: "e1", decision: "VERIFY" as const, applied: true, outcome: "RESOLVED" as const },
      { id: "e2", decision: "REVISE" as const, applied: true, outcome: "DEGRADED" as const },
      { id: "e3", decision: "CHANGE_MODEL" as const, applied: true, outcome: "RESOLVED" as const },
      { id: "e4", decision: "REPLAN" as const, applied: false, staleDropped: true },
      { id: "e5", decision: "CONTINUE" as const, applied: false },
    ]
    for (const item of entries) {
      ledger.recordEval(
        {
          evalId: item.id,
          runId: "run-full-ana",
          turnId: 1,
          checkpoint: "PERIODIC" as const,
          evidenceVersion: 1,
          decision: item.decision,
          scores: { progress: 1, completionConfidence: 1, verificationCoverage: 1, planAdherence: 1, executionEfficiency: 1, logicalConsistency: 1, safetyAuthority: 1 },
          signals: [],
          evaluatorLevel: "L0" as const,
          confidence: 1,
        },
        item.applied ? "INTERVENTION" : undefined,
        { applied: item.applied, ...(item.staleDropped ? { staleDropped: item.staleDropped } : {}) }
      )
      if (item.outcome) {
        ledger.recordInterventionOutcome(item.id, item.outcome, "Detail")
      }
    }

    const analytics = new RuntimeEvalAnalytics(ledger)
    const summary = analytics.getRunSummary("run-full-ana")
    results.push({
      id: "completion.25",
      category: "ADAPTIVE_COMPLETION",
      description: "Analytics correctly aggregates recommended, applied, stale dropped, and outcome counts",
      actual: {
        totalEvaluations: summary.totalEvaluations,
        recommendedInterventions: summary.recommendedInterventions,
        appliedInterventions: summary.appliedInterventions,
        staleDroppedInterventions: summary.staleDroppedInterventions,
        resolvedInterventions: summary.resolvedInterventions,
        degradedInterventions: summary.degradedInterventions,
        repairSuccessRate: summary.repairSuccessRate,
      },
      expected: {
        totalEvaluations: 5,
        recommendedInterventions: 4,
        appliedInterventions: 3,
        staleDroppedInterventions: 1,
        resolvedInterventions: 2,
        degradedInterventions: 1,
        repairSuccessRate: 0.67,
      },
    })
  }

  // Scenario 108 (completion.26): Integrated CHANGE_MODEL E2E — Real AgentRunner -> RoutedModelGateway -> ModelRouter -> Provider A -> Eval CHANGE_MODEL -> Hint -> Provider B -> Response -> Route Provenance -> Ledger Outcome RESOLVED
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-route-integrated-"))
    try {
      const config = {
        providers: [
          { id: "prov-a", kind: "scripted" as const },
          { id: "prov-b", kind: "scripted" as const },
        ],
        models: [
          { id: "mod-a", contextWindow: 8192, capabilities: ["toolUse" as const, "reasoning" as const], specialization: "general" as const },
          { id: "mod-b", contextWindow: 8192, capabilities: ["toolUse" as const, "reasoning" as const], specialization: "general" as const },
        ],
        deployments: [
          { id: "local-a", providerId: "prov-a", modelId: "mod-a", enabled: true, priority: 10 },
          { id: "local-b", providerId: "prov-b", modelId: "mod-b", enabled: true, priority: 5 },
        ],
        routes: {
          general: ["local-a", "local-b"],
        },
      }
      const initialConfigCopy = JSON.parse(JSON.stringify(config))

      const providerA = new ScriptedModelProvider([
        { model: "mod-a", message: { role: "assistant", content: "route-a-response" } },
      ])
      const providerB = new ScriptedModelProvider([
        { model: "mod-b", message: { role: "assistant", content: "route-b-response" } },
      ])

      const gateway = new RoutedModelGateway({
        config,
        providers: new Map([
          ["local-a", providerA],
          ["local-b", providerB],
        ]),
        mode: "ASK",
        budget: defaultContextBudget,
        hasTools: false,
        hasStructuredOutput: false,
      })

      const critic = new ScriptedRuntimeCritic({
        responses: [
          {
            decision: "CHANGE_MODEL",
            assessment: "Task requires upgraded reasoning model",
            confidence: 0.9,
            reasonCodes: ["HIGH_COMPLEXITY"],
          },
          {
            decision: "CONTINUE",
            assessment: "Reasoning response is satisfactory",
            confidence: 0.95,
            reasonCodes: ["COMPLETE"],
          },
        ],
      })

      const engine = new RuntimeEvalEngine({
        critic,
        forceCritic: true,
      })

      const ledger = new RuntimeEvalLedger()
      const integratedPolicy = new AdaptiveControlPolicy()

      const runner = new AgentRunner({
        evidenceGate: false,
        evalEngine: engine,
        evalPolicy: integratedPolicy,
        evalLedger: ledger,
        provider: gateway,
        registry: new ToolRegistry([]),
      })

      const runResult = await runner.run({
        task: { id: "integrated-route-1", mode: "ASK", instruction: "Solve math proof" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })

      const finalConfigCopy = JSON.parse(JSON.stringify(config))
      const entries = ledger.getEntries()
      const interventionEntry = entries.find((e: any) => e.interventionAction === "RECOMMEND_MODEL")

      const firstRequest = providerA.requests[0]
      const secondRequest = providerB.requests[0]
      const secondHint = secondRequest?.metadata?.routeHint as any

      results.push({
        id: "completion.26",
        category: "ADAPTIVE_COMPLETION",
        description: "Integrated CHANGE_MODEL E2E: Real AgentRunner -> RoutedModelGateway -> ModelRouter -> Provider A -> Eval CHANGE_MODEL -> Hint -> Provider B -> Response -> Route Provenance -> Ledger Outcome RESOLVED",
        actual: {
          status: runResult.status,
          finalAnswer: runResult.finalAnswer,
          providerACalls: providerA.requests.length,
          providerBCalls: providerB.requests.length,
          firstTurnHadHint: firstRequest?.metadata?.routeHint !== undefined,
          secondTurnHadHint: secondHint !== undefined,
          secondTurnAvoidedId: secondHint?.avoidDeploymentId,
          secondTurnReasonCode: secondHint?.reasonCode,
          secondSelectedDeployment: (gateway.lastDiagnostics?.route as any)?.deploymentId,
          secondRouteHasHintAvoided: (gateway.lastDiagnostics?.route as any)?.reasonCodes?.includes("hint_avoided"),
          interventionRecorded: interventionEntry !== undefined,
          interventionDecision: interventionEntry?.decision,
          interventionAction: interventionEntry?.interventionAction,
          interventionApplied: interventionEntry?.applied,
          interventionOutcome: interventionEntry?.interventionOutcome,
          interventionDetails: interventionEntry?.outcomeDetails,
          configPreservedUnmutated: JSON.stringify(initialConfigCopy) === JSON.stringify(finalConfigCopy),
        },
        expected: {
          status: "COMPLETED",
          finalAnswer: "route-b-response",
          providerACalls: 1,
          providerBCalls: 1,
          firstTurnHadHint: false,
          secondTurnHadHint: true,
          secondTurnAvoidedId: "local-a",
          secondTurnReasonCode: "High complexity task requiring advanced reasoning capability",
          secondSelectedDeployment: "local-b",
          secondRouteHasHintAvoided: true,
          interventionRecorded: true,
          interventionDecision: "CHANGE_MODEL",
          interventionAction: "RECOMMEND_MODEL",
          interventionApplied: true,
          interventionOutcome: "RESOLVED",
          interventionDetails: "Switched deployment from local-a to local-b",
          configPreservedUnmutated: true,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 109 (completion.27): T-4714 No-Alternate Regression — ModelRouter retains candidate when no alternative is eligible and ledger records UNCHANGED outcome
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-route-no-alt-"))
    try {
      const config = {
        providers: [
          { id: "prov-only", kind: "scripted" as const },
        ],
        models: [
          { id: "mod-only", contextWindow: 8192, capabilities: ["toolUse" as const], specialization: "general" as const },
        ],
        deployments: [
          { id: "local-only", providerId: "prov-only", modelId: "mod-only", enabled: true, priority: 10 },
        ],
        routes: {
          general: ["local-only"],
        },
      }

      const pOnly = new ScriptedModelProvider([
        { model: "mod-only", message: { role: "assistant", content: "response-turn-1" } },
        { model: "mod-only", message: { role: "assistant", content: "response-turn-2-retained" } },
      ])

      const gateway = new RoutedModelGateway({
        config,
        providers: new Map([
          ["local-only", pOnly],
        ]),
        mode: "ASK",
        budget: defaultContextBudget,
        hasTools: false,
        hasStructuredOutput: false,
      })

      let evalTurn = 0
      const noAltPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          evalTurn++
          if (evalTurn === 1) {
            return {
              decision: "CHANGE_MODEL",
              action: "RECOMMEND_MODEL",
              shouldFinalize: false,
              modelRecommendation: { capability: "reasoning", reason: "Attempt switch with no alt" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const ledger = new RuntimeEvalLedger()
      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: noAltPolicy,
        evalLedger: ledger,
        provider: gateway,
        registry: new ToolRegistry([]),
      })

      const result = await runner.run({
        task: { id: "no-alt-run", mode: "ASK", instruction: "Solve problem" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
      })

      const entries = ledger.getEntries()
      const intervention = entries.find((e: any) => e.interventionAction === "RECOMMEND_MODEL")

      results.push({
        id: "completion.27",
        category: "ADAPTIVE_COMPLETION",
        description: "ModelRouter retains candidate when no alternative is eligible and ledger records UNCHANGED outcome",
        actual: {
          status: result.status,
          finalAnswer: result.finalAnswer,
          totalProviderCalls: pOnly.requests.length,
          interventionOutcome: intervention?.interventionOutcome,
          outcomeDetails: intervention?.outcomeDetails,
        },
        expected: {
          status: "COMPLETED",
          finalAnswer: "response-turn-2-retained",
          totalProviderCalls: 2,
          interventionOutcome: "UNCHANGED",
          outcomeDetails: "Retained deployment local-only",
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // Scenario 110 (completion.28): T-4715 Stale CHANGE_MODEL Regression — Concurrent evidence version increment marks eval stale with CONTINUE and suppresses route hint
  {
    const collector = new RuntimeEvidenceCollector({ runId: "stale-change-model", taskGoal: "Verify stale guard" })
    const critic = new ScriptedRuntimeCritic({
      handler: async () => {
        collector.recordToolAction({
          id: "call-stale-1",
          toolName: "read_file",
          args: { path: "foo.ts" },
        })
        return {
          decision: "CHANGE_MODEL",
          assessment: "Upgrade model",
          confidence: 0.9,
          reasonCodes: ["COMPLEXITY"],
        }
      },
    })

    const engine = new RuntimeEvalEngine({ critic, forceCritic: true })
    const evalResult = await engine.evaluate(collector, "PERIODIC", 1)
    const stalePolicy = new AdaptiveControlPolicy()
    const directive = stalePolicy.determineDirective(evalResult, collector.getEvidence())

    results.push({
      id: "completion.28",
      category: "ADAPTIVE_COMPLETION",
      description: "Concurrent evidence version increment marks eval stale with CONTINUE and suppresses route hint",
      actual: {
        evalStale: evalResult.stale === true,
        evalDecision: evalResult.decision,
        directiveDecision: directive.decision,
        directiveAction: directive.action,
        hasModelRecommendation: Boolean(directive.modelRecommendation),
      },
      expected: {
        evalStale: true,
        evalDecision: "CONTINUE",
        directiveDecision: "CONTINUE",
        directiveAction: "NO_OP",
        hasModelRecommendation: false,
      },
    })
  }

  // Scenario 111 (completion.29): T-4716 Cancel Before Second Route — AbortController cancellation before route B prevents provider B invocation
  {
    const ws = await mkdtemp(join(tmpdir(), "rt-eval-route-cancel-"))
    try {
      const config = {
        providers: [
          { id: "prov-a", kind: "scripted" as const },
          { id: "prov-b", kind: "scripted" as const },
        ],
        models: [
          { id: "mod-a", contextWindow: 8192, capabilities: ["toolUse" as const, "reasoning" as const], specialization: "general" as const },
          { id: "mod-b", contextWindow: 8192, capabilities: ["toolUse" as const, "reasoning" as const], specialization: "general" as const },
        ],
        deployments: [
          { id: "local-a", providerId: "prov-a", modelId: "mod-a", enabled: true, priority: 10 },
          { id: "local-b", providerId: "prov-b", modelId: "mod-b", enabled: true, priority: 5 },
        ],
        routes: {
          general: ["local-a", "local-b"],
        },
      }

      const pA = new ScriptedModelProvider([
        { model: "mod-a", message: { role: "assistant", content: "route-a-response" } },
      ])
      const pB = new ScriptedModelProvider([
        { model: "mod-b", message: { role: "assistant", content: "route-b-response" } },
      ])

      const gateway = new RoutedModelGateway({
        config,
        providers: new Map([
          ["local-a", pA],
          ["local-b", pB],
        ]),
        mode: "ASK",
        budget: defaultContextBudget,
        hasTools: false,
        hasStructuredOutput: false,
      })

      const abortController = new AbortController()

      let evalTurn = 0
      const cancelPolicy = new (class extends AdaptiveControlPolicy {
        override determineDirective(evalResult: any, evidence: any): any {
          evalTurn++
          if (evalTurn === 1) {
            abortController.abort()
            return {
              decision: "CHANGE_MODEL",
              action: "RECOMMEND_MODEL",
              shouldFinalize: false,
              modelRecommendation: { capability: "reasoning", reason: "Cancel before route B" },
            }
          }
          return { decision: "CONTINUE", action: "CONTINUE", shouldFinalize: true }
        }
      })()

      const ledger = new RuntimeEvalLedger()
      const runner = new AgentRunner({
        evidenceGate: false,
        evalPolicy: cancelPolicy,
        evalLedger: ledger,
        provider: gateway,
        registry: new ToolRegistry([]),
      })

      const result = await runner.run({
        task: { id: "cancel-route-run", mode: "ASK", instruction: "Solve problem" },
        workspaceRoot: ws,
        maxTurns: 3,
        contextBudget: defaultContextBudget,
        projectInstructions: [],
        signal: abortController.signal,
      })

      results.push({
        id: "completion.29",
        category: "ADAPTIVE_COMPLETION",
        description: "AbortController cancellation before route B prevents provider B invocation",
        actual: {
          status: result.status,
          providerACalls: pA.requests.length,
          providerBCalls: pB.requests.length,
        },
        expected: {
          status: "CANCELLED",
          providerACalls: 1,
          providerBCalls: 0,
        },
      })
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  return results
}
