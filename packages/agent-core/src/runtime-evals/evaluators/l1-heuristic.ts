import type {
  AdaptiveDecision,
  RuntimeEvalCheckpoint,
  RuntimeEvalResult,
  RuntimeEvalScores,
  RuntimeEvalSignal,
  RuntimeEvidence,
} from "../contracts.ts"
import { deterministicHash } from "../evidence.ts"

export interface L1EvaluatorOptions {
  readonly loopThreshold?: number
  readonly runawayStopThreshold?: number
  readonly maxUnproductiveActions?: number
}

function detectRepetitionPattern(actions: readonly { signatureHash: string }[], minRepeat = 3): boolean {
  if (actions.length < minRepeat) return false
  const lastAction = actions[actions.length - 1]
  if (!lastAction) return false
  const lastHash = lastAction.signatureHash
  let consecutive = 0
  for (let i = actions.length - 1; i >= 0; i--) {
    const act = actions[i]
    if (act && act.signatureHash === lastHash) {
      consecutive++
    } else {
      break
    }
  }
  return consecutive >= minRepeat
}

function detectCyclePattern(actions: readonly { signatureHash: string }[], cycleLength = 2, minCycles = 3): boolean {
  const needed = cycleLength * minCycles
  if (actions.length < needed) return false
  const tail = actions.slice(-needed)
  const pattern = tail.slice(0, cycleLength).map((a) => a.signatureHash).join(":")
  for (let c = 1; c < minCycles; c++) {
    const chunk = tail.slice(c * cycleLength, (c + 1) * cycleLength).map((a) => a.signatureHash).join(":")
    if (chunk !== pattern) return false
  }
  return true
}

export function evaluateL1(
  evidence: RuntimeEvidence,
  checkpoint: RuntimeEvalCheckpoint,
  baseResult: RuntimeEvalResult,
  options?: L1EvaluatorOptions,
): RuntimeEvalResult {
  const loopThreshold = options?.loopThreshold ?? 3
  const runawayStopThreshold = options?.runawayStopThreshold ?? 6
  const maxUnproductiveActions = options?.maxUnproductiveActions ?? 8

  const signals: RuntimeEvalSignal[] = [...baseResult.signals]
  let decision: AdaptiveDecision = baseResult.decision
  let confidence = baseResult.confidence
  let recommendedAction = baseResult.recommendedAction

  let progress = baseResult.scores.progress
  const completionConfidence = baseResult.scores.completionConfidence
  let verificationCoverage = baseResult.scores.verificationCoverage
  let planAdherence = baseResult.scores.planAdherence
  let executionEfficiency = baseResult.scores.executionEfficiency
  const logicalConsistency = baseResult.scores.logicalConsistency
  const safetyAuthority = baseResult.scores.safetyAuthority

  // T-4411: Verification coverage score
  const appliedMutations = evidence.mutationOutcomes.filter((m) => m.status === "APPLIED")
  const lastMutation = evidence.mutationOutcomes[evidence.mutationOutcomes.length - 1]
  const lastVerification = evidence.verificationOutcomes[evidence.verificationOutcomes.length - 1]

  if (appliedMutations.length > 0) {
    if (!lastVerification) {
      verificationCoverage = 0.0
    } else {
      const lastMutTime = lastMutation ? new Date(lastMutation.timestamp).getTime() : 0
      const lastVerifTime = new Date(lastVerification.timestamp).getTime()
      if (lastVerifTime < lastMutTime) {
        verificationCoverage = 0.0
      } else if (lastVerification.status === "PASS") {
        verificationCoverage = 1.0
      } else {
        verificationCoverage = 0.5
      }
    }
  } else {
    verificationCoverage = 1.0
  }

  // T-4409 / T-4420: Non-progress tool loop and runaway stop detection
  // Check if recent actions are looping without intervening mutations
  const actionsSinceLastMutation: import("../contracts.ts").BoundedActionRecord[] = []
  const lastMutTimestamp = lastMutation?.timestamp ? new Date(lastMutation.timestamp).getTime() : 0

  for (const act of evidence.recentActions) {
    if (new Date(act.timestamp).getTime() >= lastMutTimestamp) {
      actionsSinceLastMutation.push(act)
    }
  }

  // T-4410: Legitimate reread / rerun check: actions across mutation boundaries reset the loop counter
  const isDirectLoop = detectRepetitionPattern(actionsSinceLastMutation, loopThreshold)
  const isDirectRunaway = detectRepetitionPattern(actionsSinceLastMutation, runawayStopThreshold)
  const isCycle = detectCyclePattern(actionsSinceLastMutation, 2, 3)

  if (isDirectRunaway) {
    decision = "STOP"
    progress = 0.0
    executionEfficiency = 0.1
    confidence = 1.0
    signals.push({
      code: "RUNAWAY_LOOP_STOP",
      message: `Action repeated ${runawayStopThreshold} times without state mutation; terminating runaway loop`,
      severity: "CRITICAL",
    })
    recommendedAction = "Stop execution to prevent runaway loop"
  } else if (isDirectLoop || isCycle) {
    decision = "REPLAN"
    progress = 0.1
    executionEfficiency = 0.2
    confidence = 0.95
    signals.push({
      code: isCycle ? "ACTION_CYCLE_DETECTED" : "NON_PROGRESS_LOOP",
      message: isCycle ? "Cyclic action sequence detected without state progress" : "Identical action repeated without progress",
      severity: "CRITICAL",
      metadata: { cycle: isCycle },
    })
    recommendedAction = "Replan task: current action loop is unproductive"
  }

  // T-4412: Plan Adherence / Drift
  if (evidence.plan && evidence.plan.length > 0) {
    const planText = evidence.plan.join(" ").toLowerCase()
    const recentReadsOrEdits = evidence.recentActions.filter((a) => a.toolName === "read_file" || a.toolName === "search_text")
    if (recentReadsOrEdits.length >= 2) {
      let matchingCount = 0
      for (const a of recentReadsOrEdits) {
        const words = a.summary.toLowerCase().split(/[^a-z0-9_.]+/).filter((w) => w.length > 3)
        if (words.some((w) => planText.includes(w))) {
          matchingCount++
        }
      }
      if (matchingCount === 0) {
        planAdherence = 0.3
        signals.push({
          code: "PLAN_DRIFT",
          message: "Recent exploration actions do not match declared plan steps",
          severity: "WARNING",
        })
        if (decision === "CONTINUE") {
          decision = "REVISE"
          recommendedAction = "Refocus on declared plan steps or update plan"
        }
      } else {
        planAdherence = 0.95
      }
    }
  }

  // T-4413: Execution Efficiency
  if (evidence.counts.toolCalls > 0) {
    const failedRatio = evidence.counts.failures / evidence.counts.toolCalls
    const dupRatio = evidence.counts.duplicateReads / evidence.counts.toolCalls
    let efficiency = 1.0 - (failedRatio * 0.5 + dupRatio * 0.3)
    if (evidence.counts.toolCalls > maxUnproductiveActions && appliedMutations.length === 0 && evidence.counts.failures > 3) {
      efficiency = Math.min(efficiency, 0.25)
      signals.push({
        code: "EXCESSIVE_UNPRODUCTIVE_ACTIONS",
        message: `${evidence.counts.toolCalls} tool calls executed with no mutations and ${evidence.counts.failures} failures`,
        severity: "WARNING",
      })
      if (decision === "CONTINUE") {
        decision = "REPLAN"
        recommendedAction = "Replan task due to excessive unproductive actions"
      }
    }
    executionEfficiency = Math.min(executionEfficiency, Math.max(0, Math.min(1, efficiency)))
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

  return {
    ...baseResult,
    evalId: `eval-l1-${evidence.turnId}-v${evidence.evidenceVersion}-${deterministicHash(`${evidence.runId}:${evidence.turnId}:${evidence.evidenceVersion}:${checkpoint}`)}`,
    decision,
    scores,
    signals,
    recommendedAction,
    evaluatorLevel: "L1",
    confidence,
  }
}
