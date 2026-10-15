/**
 * Non-progress detection & bounded recovery contracts (Sprint 5C, ADR-031).
 *
 * Progress is defined over observable, deterministic state only: stage, check results, review
 * blockers, workspace hashes and tool/error fingerprints. Model text, token counts and reasoning are
 * never progress signals. Every persisted field is a hash, a count or a bounded redacted excerpt.
 */
import type { EngineeringStage } from "../workflow/contracts.ts"

/** Where in the run a snapshot was taken. */
export type ObservationPoint = "START" | "TOOL_RESULT" | "MUTATION" | "TEST" | "REVIEW" | "VERIFY" | "BEFORE_RETRY"

export type VerificationStateLabel = "NONE" | "NOT_READY" | "READY" | "BLOCKED"

/** Bounded, deterministic snapshot of observable task state. No prompts, reasoning, file contents or secrets. */
export interface ProgressSnapshot {
  readonly workflowId: string
  readonly stage: EngineeringStage
  readonly point: ObservationPoint
  readonly toolFingerprint?: string
  readonly errorFingerprint?: string
  /** Fingerprint of the set of failing tests/checks (order-independent). */
  readonly testFingerprint?: string
  /** Fingerprint of the set of BLOCKER/HIGH findings in the current review. */
  readonly reviewFingerprint?: string
  readonly failingCheckCount?: number
  readonly blockerCount?: number
  /** path → sha256 (16 hex) of the current workspace content of every file the run changed. */
  readonly changedFileHashes: Readonly<Record<string, string>>
  /** Fingerprint of the net diff (workflow start → current workspace). */
  readonly diffFingerprint?: string
  readonly verificationState?: VerificationStateLabel
  /** Number of failed checks in the latest VERIFY, when it ran. */
  readonly verificationFailedChecks?: number
  readonly evidenceFingerprint?: string
  readonly timestamp: string
}

export type ProgressStatus = "ADVANCED" | "CHANGED" | "STALLED" | "REGRESSED" | "UNKNOWN"

export type ProgressSignalKind =
  | "REPEATED_TOOL_ACTION"
  | "REPEATED_ERROR"
  | "TEST_STAGNATION"
  | "DIFF_STAGNATION"
  | "REPAIR_LOOP_STAGNATION"
  | "REVIEW_STAGNATION"
  | "CONTEXT_BURN"

export interface ProgressSignal {
  readonly kind: ProgressSignalKind
  /** Consecutive (or, for tool actions, total) observations of the same fingerprint. */
  readonly count: number
  readonly threshold: number
  /** Bounded, human-readable description of the repeated pattern. Never a fingerprint. */
  readonly pattern: string
}

export interface ProgressDelta {
  readonly status: ProgressStatus
  /** Bounded reasons, e.g. "failing checks 3 → 1". */
  readonly reasons: readonly string[]
}

export interface ProgressAssessment {
  readonly status: Exclude<ProgressStatus, "UNKNOWN"> | "UNKNOWN"
  readonly point: ObservationPoint
  readonly reasons: readonly string[]
  /** Signals whose threshold was crossed by this observation. */
  readonly signals: readonly ProgressSignal[]
  readonly confidence: "DETERMINISTIC"
  /** Highest repeat count among the dimensions this observation updated. */
  readonly repeatedCount: number
}

/** What the monitor asks the authoritative engine to do. It never acts itself. */
export type ProgressRequest = "CONTINUE" | "DIAGNOSE" | "BLOCK"

/** Thresholds are deliberately small; they are internal and configurable for tests and evals. */
export interface ProgressThresholds {
  readonly sameToolAction: number
  readonly sameErrorAfterRepair: number
  readonly sameTestAfterMutation: number
  readonly sameReviewBlocker: number
  readonly sameDiffAfterMutation: number
  readonly noProgressWindow: number
  /** Fraction of the context budget above which a no-evidence turn counts as context pressure. */
  readonly contextPressureRatio: number
}

export const DEFAULT_PROGRESS_THRESHOLDS: ProgressThresholds = {
  sameToolAction: 2,
  sameErrorAfterRepair: 2,
  sameTestAfterMutation: 2,
  sameReviewBlocker: 2,
  sameDiffAfterMutation: 2,
  noProgressWindow: 3,
  contextPressureRatio: 0.9,
}

/**
 * The single recovery bound (ADR-031): one diagnostic recovery per run. It draws from the existing
 * workflow repair budget instead of adding a new multiplier, so total IMPLEMENT passes stay
 * `1 + maxTestRepairs + maxReviewRepairs` exactly as in Sprint 5B.
 */
export const MAX_NON_PROGRESS_RECOVERIES = 1

export const FAILURE_CLASSES = [
  "LOGIC_FAILURE",
  "STATE_MISMATCH",
  "ENVIRONMENT_FAILURE",
  "TOOL_FAILURE",
  "MODEL_FAILURE",
  "PERMISSION_BLOCK",
  "VERIFICATION_FAILURE",
  "CONTEXT_DEGRADATION",
  "EXTERNAL_BLOCKER",
  "UNKNOWN",
] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

export type DiagnosticCheckKind =
  | "FAILING_ASSERTION"
  | "WORKSPACE_STATE"
  | "ENDPOINT_PROBE"
  | "PERMISSION_OUTCOME"
  | "TOOL_CONTRACT"
  | "REVIEW_EVIDENCE"
  | "CONTEXT_COMPACTION"

/** Bounded, inspectable recovery artifact. No hidden reasoning. */
export interface NonProgressRecoveryPlan {
  readonly detectedSignals: readonly ProgressSignal[]
  readonly failureClass: FailureClass
  readonly hypothesis: string
  readonly discriminatingCheck: DiagnosticCheckKind
  readonly checkDescription: string
  readonly observedResult?: string
  readonly correctiveAction?: string
  readonly retryAllowed: boolean
  /** Why a retry is not allowed, when it is not. */
  readonly escalationReason?: string
}

export type RecoveryOutcome = "PENDING" | "RECOVERED" | "NOT_RECOVERED" | "ESCALATED" | "CANCELLED"

/** Structured BLOCKED result. A stall that cannot be recovered is a valid, reported outcome. */
export interface NonProgressReport {
  readonly kind: "BLOCKED_NON_PROGRESS"
  readonly failureClass: FailureClass
  readonly repeatedPattern: string
  readonly lastEvidence: string
  readonly diagnosticCheck: string
  readonly result: string
  readonly recommendedHumanAction: string
}

/** A reusable failure pattern, emitted as evidence only. Nothing is learned or written automatically. */
export interface FailurePatternCandidate {
  readonly failureClass: FailureClass
  readonly signals: readonly ProgressSignalKind[]
  readonly check: DiagnosticCheckKind
  readonly recovered: boolean
}

/** Per-dimension repeat counters. Fingerprints only; safe to persist. */
export interface MonitorCounters {
  readonly test: { readonly fingerprint?: string; readonly count: number }
  readonly review: { readonly fingerprint?: string; readonly count: number }
  readonly diff: { readonly fingerprint?: string; readonly count: number }
  readonly error: { readonly fingerprint?: string; readonly count: number }
  /** Consecutive repair-loop observations (TEST/REVIEW) that did not ADVANCE. */
  readonly noAdvanceWindow: number
}

export interface MonitorState {
  /** Latest snapshot per observation point, so like is compared with like. */
  readonly lastByPoint: Readonly<Partial<Record<ObservationPoint, ProgressSnapshot>>>
  /** Furthest work stage reached; moving past it is a stage advance. */
  readonly furthestStage?: EngineeringStage
  readonly counters: MonitorCounters
  readonly observations: number
  /**
   * Progress epoch (Sprint 5D closure): advances on every ADVANCED observation and clears the
   * cross-point error counter, so an old error seen again after measurable progress starts at one.
   * Optional so states persisted before the field existed restore as epoch 1.
   */
  readonly epoch?: number
}

/** Persisted in WorkflowState.progress; restored after a restart so counters never reset. */
export interface WorkflowProgressState {
  readonly monitor: MonitorState
  /** Latest assessments (bounded) for evidence. */
  readonly assessments: readonly ProgressAssessment[]
  readonly stallSignals: readonly ProgressSignal[]
  readonly recoveryCount: number
  readonly recoveryAttempted: boolean
  readonly diagnosticRun: boolean
  readonly recoveryPlan?: NonProgressRecoveryPlan
  readonly recoveryOutcome?: RecoveryOutcome
  /** The IMPLEMENT pass that runs as the bounded recovery attempt (compact context + bug-triage). */
  readonly recoveryPass?: number
  readonly finalBlocker?: NonProgressReport
  readonly patternCandidate?: FailurePatternCandidate
}

export const PROGRESS_LIMITS = {
  assessments: 12,
  reasons: 6,
  reasonChars: 160,
  patternChars: 240,
  textChars: 400,
  recoveryContextChars: 4_000,
} as const
