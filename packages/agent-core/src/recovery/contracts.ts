/**
 * Recovery & Checkpoint Contracts
 * Sprint 4C — Durable Checkpoints, Recovery & Safe Rollback
 */

export const CHECKPOINT_SCHEMA_VERSION = 1

export const CHECKPOINT_REASONS = [
  "RUN_STARTED",
  "PLAN_UPDATED",
  "BEFORE_MUTATION",
  "AFTER_MUTATION",
  "BEFORE_VERIFICATION",
  "AFTER_VERIFICATION",
  "AFTER_INTERVENTION",
  "BEFORE_PAUSE",
  "PAUSED",
  "BEFORE_COMPLETION",
  "COMPLETED",
  "RECOVERY_RECONCILED",
  "ROLLBACK_COMPLETED",
  "WORKFLOW_STAGE",
] as const

export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number]

export const OPERATION_KINDS = [
  "MUTATION",
  "ROLLBACK_MUTATION",
  "VERIFICATION",
  "MCP_READ",
  "MCP_SIDE_EFFECT",
  "MODEL_CALL",
  "CONTEXT_READ",
] as const

export type OperationKind = (typeof OPERATION_KINDS)[number]

export const OPERATION_STATUSES = [
  "PREPARED",
  "STARTED",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "RECONCILED_APPLIED",
  "RECONCILED_NOT_APPLIED",
  "AMBIGUOUS",
  "ROLLED_BACK",
  "SUPERSEDED",
] as const

export type OperationStatus = (typeof OPERATION_STATUSES)[number]

export const RECOVERY_DISPOSITIONS = [
  "RESUME",
  "REVERIFY",
  "REPLAN",
  "RECONFIRM",
  "ROLLBACK_AVAILABLE",
  "ASK_HUMAN",
  "STOP",
] as const

export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number]

export const WORKSPACE_DIVERGENCE_CLASSES = [
  "EXACT_MATCH",
  "EXPECTED_APPLIED_STATE",
  "SAFE_EXTERNAL_CHANGE",
  "REPLAN_REQUIRED",
  "BLOCKED_DIVERGENCE",
] as const

export type WorkspaceDivergenceClass = (typeof WORKSPACE_DIVERGENCE_CLASSES)[number]

export interface FileStateFootprint {
  readonly path: string
  readonly hash: string
  readonly exists: boolean
  readonly sizeBytes?: number
}

export interface WorkspaceRecoveryFootprint {
  readonly files: readonly FileStateFootprint[]
  readonly baseCommit?: string
}

export interface RecoveryPrecondition {
  readonly path: string
  readonly expectedHash: string
  readonly exists: boolean
}

export interface RecoveryPostcondition {
  readonly path: string
  readonly expectedHash: string
  readonly exists: boolean
}

export interface RecoveryOperation {
  readonly schemaVersion: number
  readonly operationId: string
  readonly idempotencyKey: string
  readonly runId: string
  readonly processEpochId: string
  readonly checkpointId: string
  readonly evidenceVersion: number

  readonly kind: OperationKind
  readonly authorityId: string
  readonly intentHash: string

  readonly status: OperationStatus

  readonly preparedAt: string
  readonly startedAt?: string | undefined
  readonly completedAt?: string | undefined

  readonly preconditions: readonly RecoveryPrecondition[]
  readonly expectedPostconditions: readonly RecoveryPostcondition[]

  readonly payload?: Readonly<Record<string, unknown>> | undefined
  readonly resultRef?: string | undefined
  readonly failureCode?: string | undefined
  readonly replacesOperationId?: string | undefined
}

export interface CheckpointRecord {
  readonly schemaVersion: number
  readonly checkpointId: string
  readonly sequence: number
  readonly runId: string
  readonly processEpochId: string
  readonly turnId?: number | undefined
  readonly parentCheckpointId?: string | undefined
  readonly evidenceVersion: number

  readonly phase: string
  readonly reason: CheckpointReason
  readonly createdAt: string

  readonly planRef?: string | undefined
  readonly currentStepRef?: string | undefined

  readonly runtimeState: {
    readonly status: string
    readonly activeTask?: {
      readonly id: string
      readonly mode: string
      readonly instruction: string
    } | undefined
    readonly pauseReason?: string | undefined
    readonly pendingConfirmation?: {
      readonly callId: string
      readonly toolName: string
      readonly action: string
      readonly arguments?: unknown
      readonly requiresNewEpochApproval?: boolean | undefined
    } | undefined
    /** Bounded resume facts. Never a full transcript dump. */
    readonly workingContext?: {
      readonly observations?: readonly {
        readonly toolName: string
        readonly callId: string
        readonly ok: boolean
        readonly content: string
        readonly truncated: boolean
        readonly provenance: { readonly kind: "tool"; readonly paths: readonly string[] }
        readonly errorCategory?: string
        readonly arguments?: Readonly<Record<string, unknown>>
      }[]
      readonly toolCalls?: readonly {
        readonly id: string
        readonly name: string
        readonly outcome: string
        readonly truncated?: boolean
        readonly arguments?: Readonly<Record<string, unknown>>
      }[]
      readonly completedPaths?: readonly string[]
      /** Paths whose bytes already matched; no write occurred this run. */
      readonly alreadyPresentPaths?: readonly string[]
    } | undefined
  }

  readonly recoveryFootprint: WorkspaceRecoveryFootprint

  /** Structured engineering workflow state (Sprint 5B, ADR-030). Bounded operational facts only. */
  readonly workflow?: Readonly<Record<string, unknown>> | undefined

  readonly pendingOperations: readonly RecoveryOperation[]
  readonly completedOperationRefs: readonly string[]

  readonly runtimeEvalRef?: string | undefined
  readonly workspaceState: {
    readonly divergenceClass?: WorkspaceDivergenceClass | undefined
    readonly summary?: string | undefined
  }

  readonly checksum: string
}

export interface RecoveryArtifactMetadata {
  readonly artifactId: string
  readonly runId: string
  readonly operationId: string
  readonly path: string
  readonly originalHash: string
  readonly sizeBytes: number
  readonly createdAt: string
  readonly artifactType: "PREIMAGE" | "REVERSE_PATCH"
}

export interface RollbackCandidate {
  readonly mutationId: string
  readonly operationId: string
  readonly path: string
  readonly beforeHash: string
  readonly afterHash: string
  readonly artifactAvailable: boolean
  readonly safeToRollback: boolean
  readonly reason?: string
}

export interface ReconciledOperationSummary {
  readonly operationId: string
  readonly kind: OperationKind
  readonly originalStatus: OperationStatus
  readonly reconciledStatus: OperationStatus
  readonly reason: string
  readonly writeReplayCount: number
}

export interface RecoveryPlan {
  readonly recoveryId: string
  readonly runId: string
  readonly checkpointId: string
  readonly disposition: RecoveryDisposition
  readonly reconciledOperations: readonly ReconciledOperationSummary[]
  readonly blockedOperations: readonly ReconciledOperationSummary[]
  readonly reasons: readonly string[]
  readonly rollbackCandidates: readonly RollbackCandidate[]
  readonly requiredApprovals: readonly string[]
  readonly divergenceClass: WorkspaceDivergenceClass
}

export interface RecoveryAnalyticsMetrics {
  recoveryAttempts: number
  successfulResumes: number
  reconciledApplied: number
  reconciledNotApplied: number
  blockedDivergence: number
  interruptedVerifications: number
  rollbacksProposed: number
  rollbackAttempts?: number
  rollbackSuccesses: number
  rollbackFailures: number
  rollbackDurabilityFailures?: number
  rollbackReconciledApplied?: number
  rollbackReconciledNotApplied?: number
  rollbackOperationsRecovered: number
  rollbackDuplicateWritesPrevented: number
  recoveryPersistenceFailures: number
  duplicateSideEffectsPrevented: number
  humanEscalations: number
}
