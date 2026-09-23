/**
 * Runtime Evaluation & Adaptive Control Contracts
 * Sprint 4B — Continuous Runtime Evaluation during Coding Agent Execution
 */

export const ADAPTIVE_DECISIONS = [
  "CONTINUE",
  "REVISE",
  "REPLAN",
  "VERIFY",
  "CHANGE_MODEL",
  "REQUEST_MORE_CONTEXT",
  "STOP",
  "ASK_HUMAN",
] as const

export type AdaptiveDecision = (typeof ADAPTIVE_DECISIONS)[number]

export const EVALUATOR_LEVELS = ["L0", "L1", "L2"] as const
export type EvaluatorLevel = (typeof EVALUATOR_LEVELS)[number]

export const RUNTIME_EVAL_CHECKPOINTS = [
  "TOOL_FAILURE",
  "MUTATION_RESULT",
  "VERIFICATION_RESULT",
  "BEFORE_COMPLETION",
  "AFTER_REPAIR",
  "THRESHOLD_EXCEEDED",
  "PERIODIC",
] as const

export type RuntimeEvalCheckpoint = (typeof RUNTIME_EVAL_CHECKPOINTS)[number]

export interface CheckpointIdentity {
  readonly runId: string
  readonly turnId: number
  readonly checkpoint: RuntimeEvalCheckpoint
  readonly evidenceVersion: number
}

export interface RuntimeEvalSignal {
  readonly code: string
  readonly message: string
  readonly severity: "INFO" | "WARNING" | "CRITICAL"
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

export interface RuntimeEvalScores {
  readonly progress: number // 0.0 to 1.0
  readonly completionConfidence: number // 0.0 to 1.0
  readonly verificationCoverage: number // 0.0 to 1.0
  readonly planAdherence: number // 0.0 to 1.0
  readonly executionEfficiency: number // 0.0 to 1.0
  readonly logicalConsistency: number // 0.0 to 1.0
  readonly safetyAuthority: number // 0.0 to 1.0
}

export interface RuntimeEvalResult {
  readonly evalId: string
  readonly runId: string
  readonly turnId: number
  readonly checkpoint: RuntimeEvalCheckpoint
  readonly evidenceVersion: number
  readonly decision: AdaptiveDecision
  readonly scores: RuntimeEvalScores
  readonly signals: readonly RuntimeEvalSignal[]
  readonly recommendedAction?: string | undefined
  readonly evaluatorLevel: EvaluatorLevel
  readonly confidence: number // 0.0 to 1.0
  readonly evidenceRefs?: readonly string[] | undefined
  readonly criticAssessment?: string | undefined
  readonly criticFeedback?: { readonly critique?: string; readonly assessment?: string } | undefined
  readonly suggestedModel?: { readonly capability: string; readonly reason: string } | undefined
  readonly modelRecommendation?: { readonly capability: string; readonly reason: string } | undefined
  readonly contextRequest?: { readonly target: string; readonly reason: string } | undefined
}

export type InterventionOutcome = "IMPROVED" | "DEGRADED" | "UNCHANGED" | "PENDING" | "RESOLVED"

export interface BoundedActionRecord {
  readonly id: string
  readonly toolName: string
  readonly outcome: "COMPLETED" | "FAILED" | "REJECTED" | "DENIED"
  readonly signatureHash: string
  readonly summary: string
  readonly timestamp: string
}

export interface BoundedFailureRecord {
  readonly id: string
  readonly category: string
  readonly failureHash: string
  readonly summary: string
  readonly count: number
  readonly timestamp: string
}

export interface BoundedMutationOutcome {
  readonly mutationId: string
  readonly path: string
  readonly status: "PREPARED" | "APPLIED" | "FAILED" | "STALE"
  readonly diffSummary: string
  readonly timestamp: string
}

export interface BoundedVerificationOutcome {
  readonly executionId: string
  readonly action: string
  readonly status: "PASS" | "FAIL" | "TIMEOUT" | "EXECUTION_ERROR" | "STALE_VERIFICATION" | "CANCELLED"
  readonly failedTestCount?: number | undefined
  readonly totalTestCount?: number | undefined
  readonly failureSummary?: string | undefined
  readonly failureHash?: string | undefined
  readonly timestamp: string
}

export interface BoundedSecuritySignal {
  readonly id: string
  readonly toolName?: string | undefined
  readonly action: string
  readonly reason: string
  readonly denied: boolean
  readonly timestamp: string
}

export interface BoundedRouteSignal {
  readonly routeId: string
  readonly providerId: string
  readonly modelId: string
  readonly taskMode: string
  readonly success: boolean
  readonly latencyMs: number
  readonly timestamp: string
}

export interface BoundedProgressSignal {
  readonly turnId: number
  readonly delta: number
  readonly positive: boolean
  readonly reason: string
  readonly timestamp: string
}

export interface RuntimeEvidenceCounts {
  readonly actions: number
  readonly failures: number
  readonly mutations: number
  readonly verifications: number
  readonly securityDenials: number
  readonly toolCalls: number
  readonly duplicateReads: number
}

export interface RuntimeEvidence {
  readonly runId: string
  readonly turnId: number
  readonly taskGoal: string
  readonly evidenceVersion: number
  readonly plan?: readonly string[] | undefined
  readonly currentStep?: string | undefined
  readonly recentActions: readonly BoundedActionRecord[]
  readonly toolOutcomes: readonly BoundedActionRecord[]
  readonly mutationOutcomes: readonly BoundedMutationOutcome[]
  readonly verificationOutcomes: readonly BoundedVerificationOutcome[]
  readonly securitySignals: readonly BoundedSecuritySignal[]
  readonly unresolvedFailures: readonly BoundedFailureRecord[]
  readonly routeSignals: readonly BoundedRouteSignal[]
  readonly progressSignals: readonly BoundedProgressSignal[]
  readonly counts: RuntimeEvidenceCounts
  readonly timestamps: {
    readonly startedAt: string
    readonly updatedAt: string
  }
}

export interface BoundedEvidenceSummary {
  readonly runId: string
  readonly turnId: number
  readonly taskGoal: string
  readonly planSummary?: string | undefined
  readonly recentActionsSummary: string
  readonly mutationSummary: string
  readonly verificationSummary: string
  readonly failuresSummary: string
  readonly securitySummary: string
}

export interface RuntimeCriticInput {
  readonly taskGoal: string
  readonly runId?: string | undefined
  readonly turnId?: number | undefined
  readonly checkpoint?: RuntimeEvalCheckpoint | undefined
  readonly boundedPlan?: readonly string[] | undefined
  readonly boundedEvidence?: BoundedEvidenceSummary | undefined
  readonly evidence?: RuntimeEvidence | undefined
  readonly deterministicSignals?: readonly RuntimeEvalSignal[] | undefined
}

export interface RuntimeCriticOutput {
  readonly assessment: string
  readonly suggestedDecision: AdaptiveDecision
  readonly reasonCodes: readonly string[]
  readonly confidence: number
  readonly critique?: string | undefined
  readonly decision?: AdaptiveDecision | undefined
  readonly scores?: {
    readonly progress?: number | undefined
    readonly safetyAuthority?: number | undefined
  } | undefined
}

export interface RuntimeCritic {
  evaluate(input: RuntimeCriticInput, signal?: AbortSignal): Promise<RuntimeCriticOutput>
}

export interface EvalLedgerEntry {
  readonly evalId: string
  readonly runId: string
  readonly turnId: number
  readonly timestamp: string
  readonly level: EvaluatorLevel
  readonly decision: AdaptiveDecision
  readonly scores: RuntimeEvalScores
  readonly reasonCodes: readonly string[]
  readonly evidenceRefs: readonly string[]
  readonly intervention?: string | undefined
  readonly outcome?: InterventionOutcome | undefined
  readonly outcomeDetails?: string | undefined
  readonly hasIntervention?: boolean | undefined
  readonly interventionAction?: string | undefined
  readonly interventionOutcome?: InterventionOutcome | undefined
  readonly interventionDetails?: string | undefined
}
