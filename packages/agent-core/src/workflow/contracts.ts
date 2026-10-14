/**
 * Structured Engineering Loop contracts (Sprint 5B, ADR-030).
 *
 * The workflow persists bounded operational facts only: decisions, artifacts, evidence and stage
 * results. It never stores prompts, model transcripts, reasoning, full source files or secrets.
 */
import type { AgentMode, AgentConfirmationRequest } from "../contracts/agent.ts"
import type { SkillInjectionStatus } from "../skills/contracts.ts"
import type { VerificationAction, VerificationStatus } from "../tools/verification-contracts.ts"

export const ENGINEERING_STAGES = ["PLAN", "IMPLEMENT", "TEST", "REVIEW", "VERIFY", "COMPLETE", "BLOCKED", "CANCELLED"] as const
export type EngineeringStage = (typeof ENGINEERING_STAGES)[number]

/** Stages that do work. COMPLETE, BLOCKED and CANCELLED are terminal. */
export type WorkStage = Exclude<EngineeringStage, "COMPLETE" | "BLOCKED" | "CANCELLED">
export const TERMINAL_STAGES: ReadonlySet<EngineeringStage> = new Set(["COMPLETE", "BLOCKED", "CANCELLED"])

export type WorkflowStatus = "RUNNING" | "WAITING_FOR_CONFIRMATION" | "COMPLETE" | "BLOCKED" | "CANCELLED"

export type WorkflowBlocker =
  | "PLAN_INVALID"
  | "STAGE_FAILED"
  | "NO_CHANGES"
  | "REPAIR_PRODUCED_NO_CHANGES"
  | "NO_TEST_COMMAND"
  | "VERIFICATION_DENIED"
  | "VERIFICATION_REJECTED"
  | "TEST_REPAIR_LIMIT"
  | "REVIEW_UNPARSEABLE"
  | "BLOCKED_REVIEW"
  | "VERIFY_NOT_READY"
  | "VERIFY_UNAVAILABLE"
  | "RESTORE_FAILED"

export type WorkflowIneligibleReason = "DISABLED" | "MODE_NOT_MUTATING" | "UNTRUSTED_WORKSPACE" | "READ_ONLY_REQUEST"

export interface WorkflowEligibility {
  readonly eligible: boolean
  readonly reason: "ELIGIBLE" | WorkflowIneligibleReason
}

/** Retry and repair limits. Defaults are documented in docs/workflows/ENGINEERING_LOOP.md. */
export interface WorkflowPolicy {
  /** IMPLEMENT repair passes triggered by failing tests. */
  readonly maxTestRepairs: number
  /** IMPLEMENT → TEST → fresh REVIEW cycles triggered by BLOCKER/HIGH findings. */
  readonly maxReviewRepairs: number
  /** Re-runs of a model stage after an invalid artifact or a model/provider failure. */
  readonly maxStageRetries: number
  /** Turn cap for each model stage. */
  readonly maxStageTurns: number
  /** Checks VERIFY runs when the repository defines them. */
  readonly verifyActions: readonly VerificationAction[]
}

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  maxTestRepairs: 2,
  maxReviewRepairs: 2,
  maxStageRetries: 1,
  maxStageTurns: 10,
  verifyActions: ["TYPECHECK", "LINT", "BUILD", "TEST"],
}

// ---- Artifact size bounds -------------------------------------------------------------------------

export const ARTIFACT_LIMITS = {
  textChars: 400,
  listItems: 12,
  summaryChars: 600,
  diffChars: 12_000,
  diffPerFileChars: 4_000,
  outputExcerptChars: 1_200,
  findings: 12,
  findingTextChars: 400,
  groundingFileBytes: 65_536,
} as const

// ---- Stage artifacts ------------------------------------------------------------------------------

export interface PlanArtifact {
  readonly goal: string
  readonly files: readonly string[]
  readonly steps: readonly string[]
  readonly tests: readonly string[]
  readonly risks: readonly string[]
  readonly acceptanceCriteria: readonly string[]
}

export interface ChangedFile {
  /** Implementation pass (1 = initial, 2+ = repairs) that applied this change. */
  readonly pass: number
  readonly path: string
  readonly operation: string
  readonly beforeHash: string
  readonly afterHash: string
  readonly linesAdded: number
  readonly linesRemoved: number
  /** Bounded unified diff of this change. */
  readonly diff: string
  readonly diffTruncated: boolean
}

export interface ImplementationArtifact {
  /** Every applied mutation, in order, across the initial pass and repairs. */
  readonly changedFiles: readonly ChangedFile[]
  readonly passes: number
  /** Bounded final summary of the latest pass. Never forwarded to REVIEW. */
  readonly summary: string
}

export interface CheckOutcome {
  readonly action: VerificationAction
  readonly command: string
  readonly status: VerificationStatus
  readonly exitCode: number | null
  readonly durationMs: number
  /** sha256 (16 hex) of normalized output; stable across timing noise. */
  readonly fingerprint: string
  /** Bounded tail of the combined output. */
  readonly excerpt: string
}

export interface TestEvidence {
  readonly attempted: boolean
  readonly commands: readonly string[]
  readonly passed: boolean
  readonly outcomes: readonly CheckOutcome[]
  readonly failureFingerprints: readonly string[]
}

export const REVIEW_SEVERITIES = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "NOTE"] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]
export const BLOCKING_SEVERITIES: ReadonlySet<ReviewSeverity> = new Set(["BLOCKER", "HIGH"])

export interface ReviewFinding {
  readonly id: string
  readonly severity: ReviewSeverity
  readonly file: string
  readonly location?: string
  readonly claim: string
  /** Exact text from the diff or a changed file that supports the claim. */
  readonly evidence: string
  readonly recommendedAction: string
}

export interface ReviewEvidence {
  readonly attempt: number
  readonly verdict: "NO_FINDINGS" | "FINDINGS"
  readonly findings: readonly ReviewFinding[]
  readonly blocking: number
  /** Findings dropped because their evidence was missing or not found in the diff/changed files. */
  readonly rejectedUngrounded: number
  /** Findings dropped for an unknown severity or missing fields. */
  readonly rejectedMalformed: number
  readonly counts: Readonly<Record<ReviewSeverity, number>>
}

export type VerificationVerdict = "READY" | "NOT_READY" | "BLOCKED"

export interface VerificationEvidence {
  readonly verdict: VerificationVerdict
  readonly outcomes: readonly CheckOutcome[]
  readonly diffIntegrity: "INTACT" | "DIVERGED" | "NO_CHANGES"
  readonly divergedFiles: readonly string[]
  readonly reason?: string
}

// ---- Evidence -------------------------------------------------------------------------------------

export interface StageRecord {
  readonly stage: WorkStage
  readonly attempt: number
  readonly startedAt: string
  readonly endedAt?: string
  readonly status: "RUNNING" | "WAITING_FOR_CONFIRMATION" | "PASSED" | "FAILED" | "BLOCKED" | "CANCELLED"
  readonly mode?: AgentMode
  readonly modelCalls: number
  /** Peak estimated tokens of any compiled model request in this stage (0 for deterministic stages). */
  readonly contextTokens: number
  readonly toolsUsed: readonly string[]
  readonly selectedSkill?: string
  readonly skillInjection: SkillInjectionStatus
  readonly skillInjected: boolean
  readonly outcome?: string
}

export interface WorkflowRetryCounts {
  readonly plan: number
  readonly implement: number
  readonly review: number
  readonly testRepairs: number
  readonly reviewRepairs: number
}

export type WorkflowPending =
  | { readonly kind: "RUNNER"; readonly stage: WorkStage; readonly callId: string; readonly toolName: string; readonly action: string }
  | { readonly kind: "VERIFICATION"; readonly stage: "TEST" | "VERIFY"; readonly actions: readonly VerificationAction[]; readonly commands: readonly string[] }

export interface WorkflowState {
  readonly schemaVersion: 1
  readonly workflowId: string
  readonly taskId: string
  readonly mode: AgentMode
  /** The original task text. Needed to rebuild every stage envelope after a restart. */
  readonly task: string
  readonly status: WorkflowStatus
  readonly currentStage: EngineeringStage
  readonly completedStages: readonly WorkStage[]
  readonly selectedSkillIds: readonly string[]
  readonly plan?: PlanArtifact
  readonly implementation?: ImplementationArtifact
  readonly test?: TestEvidence
  readonly reviews: readonly ReviewEvidence[]
  readonly verification?: VerificationEvidence
  readonly retryCounts: WorkflowRetryCounts
  readonly blocker?: WorkflowBlocker
  readonly blockerDetail?: string
  readonly pending?: WorkflowPending
  /** Repair reason handed to the next IMPLEMENT pass, if any. */
  readonly repairReason?: string
  readonly stages: readonly StageRecord[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkflowConfirmation {
  readonly stage: WorkStage
  /** A runner tool confirmation (mutation etc.), passed through unchanged from the PermissionGate flow. */
  readonly runner?: AgentConfirmationRequest
  /** A batch of discovered verification checks awaiting approval. */
  readonly verification?: { readonly actions: readonly VerificationAction[]; readonly commands: readonly string[] }
}

export interface WorkflowResult {
  readonly status: WorkflowStatus
  readonly state: WorkflowState
  readonly confirmation?: WorkflowConfirmation
}

export interface WorkflowStageEvent {
  readonly workflowId: string
  readonly stage: EngineeringStage
  readonly status: WorkflowStatus
  readonly attempt?: number
  readonly skill?: string
}

export class WorkflowTransitionError extends Error {
  readonly from: EngineeringStage
  readonly to: EngineeringStage

  constructor(from: EngineeringStage, to: EngineeringStage, reason: string) {
    super(`Illegal workflow transition ${from} → ${to}: ${reason}`)
    this.name = "WorkflowTransitionError"
    this.from = from
    this.to = to
  }
}
