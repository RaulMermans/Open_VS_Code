/**
 * Recovery Controller
 * Sprint 4C — Inspection, classification, and planning for recovery
 * Proposes RecoveryPlan without executing workspace writes directly.
 */

import { randomUUID } from "node:crypto"
import {
  type RecoveryPlan,
  type RecoveryDisposition,
  type ReconciledOperationSummary,
  type WorkspaceDivergenceClass,
} from "./contracts.ts"
import { CheckpointStore } from "./checkpoint-store.ts"
import { OperationJournal } from "./operation-journal.ts"
import { RecoveryArtifactStore } from "./recovery-artifacts.ts"
import { getProcessEpochId } from "./process-epoch.ts"
import {
  reconcileOperation,
  reconcileFootprint,
} from "./reconciliation.ts"
import { RollbackManager } from "./rollback.ts"
import { MutationEngine } from "../tools/mutation-engine.ts"

export interface RecoveryControllerOptions {
  readonly checkpointStore: CheckpointStore
  readonly operationJournal: OperationJournal
  readonly artifactStore: RecoveryArtifactStore
  readonly mutationEngine: MutationEngine
}

export class RecoveryController {
  readonly #checkpointStore: CheckpointStore
  readonly #operationJournal: OperationJournal
  readonly #artifactStore: RecoveryArtifactStore
  readonly #rollbackManager: RollbackManager

  constructor(options: RecoveryControllerOptions) {
    this.#checkpointStore = options.checkpointStore
    this.#operationJournal = options.operationJournal
    this.#artifactStore = options.artifactStore
    this.#rollbackManager = new RollbackManager({
      mutationEngine: options.mutationEngine,
      artifactStore: options.artifactStore,
      operationJournal: options.operationJournal,
      checkpointStore: options.checkpointStore,
    })
  }

  get rollbackManager(): RollbackManager {
    return this.#rollbackManager
  }

  get artifactStore(): RecoveryArtifactStore {
    return this.#artifactStore
  }

  /**
   * Produce a structured, truthful RecoveryPlan for a run
   */
  async buildRecoveryPlan(
    runId: string,
    options?: { readonly persistReconciliation?: boolean }
  ): Promise<RecoveryPlan> {
    const recoveryId = `rec_${randomUUID().slice(0, 8)}`
    const latestCheckpoint = await this.#checkpointStore.getLatestCheckpoint(runId)
    const allOps = await this.#operationJournal.getAllOperations(runId)

    if (!latestCheckpoint && allOps.length === 0) {
      return {
        recoveryId,
        runId,
        checkpointId: "none",
        disposition: "STOP",
        reconciledOperations: [],
        blockedOperations: [],
        reasons: ["No checkpoints found for run"],
        rollbackCandidates: [],
        requiredApprovals: [],
        divergenceClass: "EXACT_MATCH",
      }
    }

    const currentEpoch = getProcessEpochId()
    const isNewEpoch = latestCheckpoint ? latestCheckpoint.processEpochId !== currentEpoch : false

    // Inspect operations from journal
    const reconciledList: ReconciledOperationSummary[] = []
    const blockedList: ReconciledOperationSummary[] = []
    let hasInterruptedVerification = false
    let hasReconciledApplied = false
    let hasBlockedOperation = false

    for (const op of allOps) {
      const rec = await reconcileOperation(op, currentEpoch)
      if (rec.isBlocked) {
        hasBlockedOperation = true
        blockedList.push(rec.summary)
      } else {
        reconciledList.push(rec.summary)
      }

      if (rec.summary.kind === "VERIFICATION" && rec.summary.reconciledStatus === "INTERRUPTED") {
        hasInterruptedVerification = true
      }
      if (
        (rec.summary.kind === "MUTATION" || rec.summary.kind === "ROLLBACK_MUTATION") &&
        rec.summary.reconciledStatus === "RECONCILED_APPLIED"
      ) {
        hasReconciledApplied = true
      }

      // Update journal with reconciled status if changed (skipped for read-only inspection)
      if (options?.persistReconciliation !== false && rec.summary.reconciledStatus !== op.status) {
        await this.#operationJournal.recordStatusUpdate(
          op.operationId,
          runId,
          rec.summary.reconciledStatus
        )
      }
    }

    // If run was already COMPLETED
    if (latestCheckpoint && (latestCheckpoint.runtimeState.status === "COMPLETED" || latestCheckpoint.reason === "COMPLETED")) {
      return {
        recoveryId,
        runId,
        checkpointId: latestCheckpoint.checkpointId,
        disposition: "STOP",
        reconciledOperations: reconciledList,
        blockedOperations: blockedList,
        reasons: ["Task was already completed durably before restart"],
        rollbackCandidates: [],
        requiredApprovals: [],
        divergenceClass: "EXACT_MATCH",
      }
    }

    // If run failed due to security denial, do not auto-retry
    if (latestCheckpoint && (latestCheckpoint.runtimeState.pauseReason?.includes("SECURITY") || latestCheckpoint.runtimeState.status === "FAILED")) {
      return {
        recoveryId,
        runId,
        checkpointId: latestCheckpoint.checkpointId,
        disposition: "STOP",
        reconciledOperations: reconciledList,
        blockedOperations: blockedList,
        reasons: ["Run previously stopped or failed; automatic retry forbidden"],
        rollbackCandidates: [],
        requiredApprovals: [],
        divergenceClass: "EXACT_MATCH",
      }
    }

    // Reconcile footprint
    const footprintCheck = latestCheckpoint
      ? await reconcileFootprint(latestCheckpoint.recoveryFootprint)
      : { diverged: false, divergenceClass: "EXACT_MATCH" as WorkspaceDivergenceClass, details: [] }
    let divergenceClass: WorkspaceDivergenceClass = footprintCheck.divergenceClass

    if (hasBlockedOperation) {
      divergenceClass = "BLOCKED_DIVERGENCE"
    }

    // Determine rollback candidates (forward mutations only)
    const appliedOps = allOps.filter((o) => {
      if (o.kind !== "MUTATION") return false
      const rec = reconciledList.find((r) => r.operationId === o.operationId)
      return rec?.reconciledStatus === "RECONCILED_APPLIED" || o.status === "COMPLETED"
    })
    const rollbackCandidates = await this.#rollbackManager.assessRollbackCandidates(runId, appliedOps)

    // Approvals handling: any pending approval from a prior epoch is invalidated!
    const requiredApprovals: string[] = []
    if (latestCheckpoint && (latestCheckpoint.runtimeState.status === "WAITING_FOR_CONFIRMATION" || latestCheckpoint.runtimeState.pendingConfirmation)) {
      if (isNewEpoch) {
        requiredApprovals.push("NEW_EPOCH_AUTHORITY_REQUIRED")
      } else {
        requiredApprovals.push("PENDING_CONFIRMATION_REQUIRED")
      }
    }

    // Calculate final disposition
    let disposition: RecoveryDisposition = "RESUME"
    const reasons: string[] = []

    if (divergenceClass === "BLOCKED_DIVERGENCE") {
      disposition = "ASK_HUMAN"
      reasons.push("Workspace files diverged from expected checkpoint/operation state; manual resolution required")
    } else if (latestCheckpoint?.runtimeState.status === "PAUSED") {
      disposition = "ASK_HUMAN"
      reasons.push(`Run was paused prior to restart: ${latestCheckpoint.runtimeState.pauseReason ?? "Human pause"}`)
    } else if (requiredApprovals.length > 0) {
      disposition = "RECONFIRM"
      reasons.push("Stale approval across process restart requires re-authorization")
    } else if (hasInterruptedVerification) {
      disposition = "REVERIFY"
      reasons.push("Verification process was interrupted; reverification required")
    } else if (hasReconciledApplied) {
      disposition = "REVERIFY"
      reasons.push("Interrupted mutation was reconciled as APPLIED; reverification recommended")
    } else if (rollbackCandidates.some((c) => c.safeToRollback)) {
      // If there are safe rollback candidates and nothing blocked, normal resume is available
      disposition = "RESUME"
      reasons.push("Safe to resume execution from last checkpoint")
    } else {
      disposition = "RESUME"
      reasons.push("All preconditions satisfied for safe continuation")
    }

    return {
      recoveryId,
      runId,
      checkpointId: latestCheckpoint?.checkpointId ?? "none",
      disposition,
      reconciledOperations: reconciledList,
      blockedOperations: blockedList,
      reasons,
      rollbackCandidates,
      requiredApprovals,
      divergenceClass,
    }
  }
}
