import type {
  AdaptiveDecision,
  RuntimeEvalCheckpoint,
  RuntimeEvalResult,
  RuntimeEvalScores,
  RuntimeEvalSignal,
  RuntimeEvidence,
} from "../contracts.ts"
import { deterministicHash } from "../evidence.ts"

export interface L0EvaluatorOptions {
  readonly repeatedFailureThreshold?: number
  readonly securityDenialThreshold?: number
}

export function evaluateL0(
  evidence: RuntimeEvidence,
  checkpoint: RuntimeEvalCheckpoint,
  options?: L0EvaluatorOptions,
): RuntimeEvalResult {
  const repeatedFailureThreshold = options?.repeatedFailureThreshold ?? 2
  const securityDenialThreshold = options?.securityDenialThreshold ?? 2

  const signals: RuntimeEvalSignal[] = []
  let decision: AdaptiveDecision = "CONTINUE"
  let confidence = 1.0
  let recommendedAction: string | undefined

  let progress = 0.5
  let completionConfidence = 0.5
  let verificationCoverage = 0.0
  const planAdherence = 1.0
  const executionEfficiency = 1.0
  let logicalConsistency = 1.0
  let safetyAuthority = 1.0

  const appliedMutations = evidence.mutationOutcomes.filter((m) => m.status === "APPLIED")
  const lastVerification = evidence.verificationOutcomes[evidence.verificationOutcomes.length - 1]

  // 1. Security Denials Check (T-4414, T-4415)
  const denials = evidence.securitySignals.filter((s) => s.denied)
  if (denials.length > 0) {
    safetyAuthority = 0.0
    const lastDenial = denials[denials.length - 1]
    if (denials.length >= securityDenialThreshold) {
      decision = "ASK_HUMAN"
      signals.push({
        code: "REPEATED_SECURITY_DENIAL",
        message: `Security boundary denied ${denials.length} actions; escalating to human`,
        severity: "CRITICAL",
        metadata: { denialCount: denials.length },
      })
      recommendedAction = "Pause and ask user for authority"
    } else {
      signals.push({
        code: "SECURITY_DENIED",
        message: `Security boundary denied action: ${lastDenial?.action ?? "unknown"}`,
        severity: "WARNING",
      })
    }
  }

  // 2. Stale Operation Check (T-4403)
  const hasStale = evidence.mutationOutcomes.some((m) => m.status === "STALE") ||
    evidence.verificationOutcomes.some((v) => v.status === "STALE_VERIFICATION")
  if (hasStale) {
    logicalConsistency = 0.0
    decision = "REVISE"
    signals.push({
      code: "STALE_OPERATION",
      message: "Stale base detected during mutation or verification",
      severity: "WARNING",
    })
    recommendedAction = "Re-read current state before modifying"
  }

  // 3. Checkpoint-specific deterministic evaluations
  if (checkpoint === "BEFORE_COMPLETION") {
    if (appliedMutations.length > 0) {
      // Mutations were applied: verification is required
      const lastAppliedMutation = appliedMutations[appliedMutations.length - 1]
      const lastMutationTime = lastAppliedMutation ? new Date(lastAppliedMutation.timestamp).getTime() : 0
      const lastVerifTime = lastVerification ? new Date(lastVerification.timestamp).getTime() : 0

      if (!lastVerification || lastVerifTime < lastMutationTime) {
        // T-4404: Completion attempted without verification after mutation
        decision = "VERIFY"
        completionConfidence = 0.0
        verificationCoverage = 0.0
        progress = 0.6
        signals.push({
          code: "UNVERIFIED_MUTATION",
          message: "Code mutations were applied but no verification was executed afterward",
          severity: "CRITICAL",
          metadata: { appliedMutationsCount: appliedMutations.length },
        })
        recommendedAction = "Run verification suite before completing"
      } else if (lastVerification.status !== "PASS") {
        // T-4406: Verification failed
        decision = "REVISE"
        completionConfidence = 0.0
        verificationCoverage = 0.5
        progress = 0.3
        signals.push({
          code: "COMPLETION_BLOCKED_BY_TEST_FAILURE",
          message: `Cannot complete task while verification is failing (${lastVerification.status})`,
          severity: "CRITICAL",
          metadata: { failedTestCount: lastVerification.failedTestCount },
        })
        recommendedAction = "Revise code to resolve failing verification"
      } else {
        // T-4405: Verified completion
        if (evidence.unresolvedFailures.length > 0) {
          decision = "REVISE"
          completionConfidence = 0.4
          verificationCoverage = 0.8
          signals.push({
            code: "UNRESOLVED_ERRORS",
            message: `${evidence.unresolvedFailures.length} unresolved failures remain`,
            severity: "WARNING",
          })
          recommendedAction = "Resolve remaining errors before completing"
        } else {
          decision = "CONTINUE"
          completionConfidence = 1.0
          verificationCoverage = 1.0
          progress = 1.0
          signals.push({
            code: "VERIFIED_COMPLETION",
            message: "All mutations verified successfully with no unresolved failures",
            severity: "INFO",
          })
          recommendedAction = "Allow completion"
        }
      }
    } else {
      // Read-only or plan task without code mutations
      verificationCoverage = 1.0
      completionConfidence = 1.0
      progress = 1.0
      decision = "CONTINUE"
      signals.push({
        code: "READ_ONLY_COMPLETION",
        message: "No code mutations required; task completion allowed",
        severity: "INFO",
      })
      recommendedAction = "Allow completion"
    }
  } else if (checkpoint === "VERIFICATION_RESULT" && lastVerification) {
    if (lastVerification.status === "PASS") {
      verificationCoverage = 1.0
      progress = 1.0
      decision = "CONTINUE"
      signals.push({
        code: "VERIFICATION_PASSED",
        message: "Verification passed successfully",
        severity: "INFO",
      })
      recommendedAction = "Proceed to next step or complete"
    } else {
      verificationCoverage = 0.5
      completionConfidence = 0.0

      // Check for repeated identical failure (T-4407) vs improvement (T-4408)
      const identicalFailures = evidence.verificationOutcomes.filter(
        (v) => v.failureHash && v.failureHash === lastVerification.failureHash,
      )

      const latestProgress = evidence.progressSignals[evidence.progressSignals.length - 1]
      const hasImproved = latestProgress && latestProgress.positive

      if (hasImproved) {
        // T-4408: Failure improved (e.g. failing tests 7 -> 2)
        progress = 0.8
        decision = "REVISE"
        signals.push({
          code: "IMPROVING_FAILURE",
          message: latestProgress.reason,
          severity: "INFO",
          metadata: { delta: latestProgress.delta },
        })
        recommendedAction = "Continue revising; failure count is decreasing"
      } else if (identicalFailures.length >= repeatedFailureThreshold) {
        // T-4407: Repeated failure with no progress
        progress = 0.1
        decision = "REPLAN"
        signals.push({
          code: "REPEATED_VERIFICATION_FAILURE",
          message: `Identical verification failure repeated ${identicalFailures.length} times without progress`,
          severity: "CRITICAL",
          metadata: { count: identicalFailures.length, failureHash: lastVerification.failureHash },
        })
        recommendedAction = "Replan approach: repair attempt repeated without progress"
      } else {
        progress = 0.3
        decision = "REVISE"
        signals.push({
          code: "VERIFICATION_FAILED",
          message: `Verification ${lastVerification.action} failed`,
          severity: "WARNING",
          metadata: { failedTestCount: lastVerification.failedTestCount },
        })
        recommendedAction = "Revise code to address failing tests"
      }
    }
  } else if (checkpoint === "TOOL_FAILURE") {
    const recentFailure = evidence.recentActions[evidence.recentActions.length - 1]
    if (recentFailure && (recentFailure.outcome === "FAILED" || recentFailure.outcome === "REJECTED")) {
      const matching = evidence.recentActions.filter(
        (a) => a.signatureHash === recentFailure.signatureHash && a.outcome === recentFailure.outcome,
      )
      if (matching.length >= repeatedFailureThreshold + 1) {
        decision = "REPLAN"
        progress = 0.1
        signals.push({
          code: "REPEATED_TOOL_FAILURE",
          message: `Tool ${recentFailure.toolName} failed repeatedly (${matching.length} times)`,
          severity: "CRITICAL",
        })
        recommendedAction = "Replan strategy due to repeated tool failure"
      } else {
        decision = "REVISE"
        signals.push({
          code: "TOOL_FAILED",
          message: `Tool ${recentFailure.toolName} failed: ${recentFailure.summary}`,
          severity: "WARNING",
        })
        recommendedAction = "Revise tool arguments or select alternative tool"
      }
    }
  }

  const scores: RuntimeEvalScores = {
    progress: Math.max(0, Math.min(1, progress)),
    completionConfidence: Math.max(0, Math.min(1, completionConfidence)),
    verificationCoverage: Math.max(0, Math.min(1, verificationCoverage)),
    planAdherence: Math.max(0, Math.min(1, planAdherence)),
    executionEfficiency: Math.max(0, Math.min(1, executionEfficiency)),
    logicalConsistency: Math.max(0, Math.min(1, logicalConsistency)),
    safetyAuthority: Math.max(0, Math.min(1, safetyAuthority)),
  }

  const evidenceRefs = [
    ...evidence.recentActions.slice(-3).map((a) => `action:${a.id}`),
    ...evidence.mutationOutcomes.slice(-2).map((m) => `mutation:${m.mutationId}`),
    ...evidence.verificationOutcomes.slice(-2).map((v) => `verification:${v.executionId}`),
  ]

  return {
    evalId: `eval-l0-${evidence.turnId}-v${evidence.evidenceVersion}-${deterministicHash(`${evidence.runId}:${evidence.turnId}:${evidence.evidenceVersion}:${checkpoint}`)}`,
    runId: evidence.runId,
    turnId: evidence.turnId,
    checkpoint,
    evidenceVersion: evidence.evidenceVersion,
    decision,
    scores,
    signals,
    recommendedAction,
    evaluatorLevel: "L0",
    confidence,
    evidenceRefs,
  }
}
