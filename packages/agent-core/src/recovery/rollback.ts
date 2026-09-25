/**
 * Rollback Handler
 * Sprint 4C — Reversible mutation rollback via canonical MutationEngine authority
 * RecoveryController proposes reverse mutation -> MutationEngine applies -> normal authority & verification
 */

import { randomUUID } from "node:crypto"
import {
  type RollbackCandidate,
  type RecoveryOperation,
  CHECKPOINT_SCHEMA_VERSION,
} from "./contracts.ts"
import { observeFilePath } from "./reconciliation.ts"
import { RecoveryArtifactStore } from "./recovery-artifacts.ts"
import { MutationEngine } from "../tools/mutation-engine.ts"
import { OperationJournal, computeOperationIdempotencyKey, computeIntentHash } from "./operation-journal.ts"
import { CheckpointStore } from "./checkpoint-store.ts"
import { getProcessEpochId } from "./process-epoch.ts"

export type RollbackExecutionStatus = "ROLLED_BACK" | "FAILED" | "DIVERGED" | "RECOVERY_REQUIRED"

export interface RollbackExecutionResult {
  readonly success: boolean
  readonly durableSuccess: boolean
  readonly path: string
  readonly status: RollbackExecutionStatus
  readonly rollbackOperationId?: string | undefined
  readonly error?: string | undefined
  readonly durabilityFailure?: boolean
  readonly recoveryRequired?: boolean
}

export interface RollbackMetrics {
  rollbackAttempts: number
  rollbackSuccesses: number
  rollbackFailures: number
  rollbackDurabilityFailures: number
  rollbackReconciledApplied: number
  rollbackReconciledNotApplied: number
  rollbackDuplicateWritesPrevented: number
}

export interface RollbackManagerOptions {
  readonly mutationEngine: MutationEngine
  readonly artifactStore: RecoveryArtifactStore
  readonly operationJournal: OperationJournal
  readonly checkpointStore: CheckpointStore
}

export class RollbackManager {
  readonly #mutationEngine: MutationEngine
  readonly #artifactStore: RecoveryArtifactStore
  readonly #operationJournal: OperationJournal | undefined
  readonly #checkpointStore: CheckpointStore | undefined
  readonly #metrics: RollbackMetrics = {
    rollbackAttempts: 0,
    rollbackSuccesses: 0,
    rollbackFailures: 0,
    rollbackDurabilityFailures: 0,
    rollbackReconciledApplied: 0,
    rollbackReconciledNotApplied: 0,
    rollbackDuplicateWritesPrevented: 0,
  }

  constructor(
    mutationEngineOrOptions: MutationEngine | RollbackManagerOptions,
    artifactStore?: RecoveryArtifactStore,
    operationJournal?: OperationJournal,
    checkpointStore?: CheckpointStore
  ) {
    if ("mutationEngine" in mutationEngineOrOptions) {
      this.#mutationEngine = mutationEngineOrOptions.mutationEngine
      this.#artifactStore = mutationEngineOrOptions.artifactStore
      this.#operationJournal = mutationEngineOrOptions.operationJournal
      this.#checkpointStore = mutationEngineOrOptions.checkpointStore
    } else {
      this.#mutationEngine = mutationEngineOrOptions
      this.#artifactStore = artifactStore!
      this.#operationJournal = operationJournal
      this.#checkpointStore = checkpointStore
    }
  }

  get metrics(): Readonly<RollbackMetrics> {
    return { ...this.#metrics }
  }

  /**
   * Evaluate which applied operations in a run are valid candidates for rollback
   */
  async assessRollbackCandidates(
    runId: string,
    appliedOperations: readonly RecoveryOperation[]
  ): Promise<RollbackCandidate[]> {
    const candidates: RollbackCandidate[] = []

    for (const op of appliedOperations) {
      if (op.kind !== "MUTATION") continue

      const pre = op.preconditions[0]
      const post = op.expectedPostconditions[0]
      if (!post) continue

      const filePath = post.path
      const obs = await observeFilePath(filePath)
      const artifactMeta = await this.#artifactStore.findArtifactForOperation(runId, op.operationId)

      // CREATE mutation rollback candidate
      if (!pre || !pre.exists) {
        if (obs.exists && obs.hash === post.expectedHash) {
          candidates.push({
            mutationId: (op.payload as any)?.mutationId ?? op.operationId,
            operationId: op.operationId,
            path: filePath,
            beforeHash: "",
            afterHash: post.expectedHash,
            artifactAvailable: true, // unlinking requires no preimage
            safeToRollback: true,
          })
        } else {
          candidates.push({
            mutationId: (op.payload as any)?.mutationId ?? op.operationId,
            operationId: op.operationId,
            path: filePath,
            beforeHash: "",
            afterHash: post.expectedHash,
            artifactAvailable: true,
            safeToRollback: false,
            reason: obs.exists ? "File was modified after creation" : "File is absent",
          })
        }
        continue
      }

      // DELETE mutation rollback candidate
      if (!post.exists) {
        if (!obs.exists && artifactMeta) {
          candidates.push({
            mutationId: (op.payload as any)?.mutationId ?? op.operationId,
            operationId: op.operationId,
            path: filePath,
            beforeHash: pre.expectedHash,
            afterHash: "",
            artifactAvailable: true,
            safeToRollback: true,
          })
        } else {
          candidates.push({
            mutationId: (op.payload as any)?.mutationId ?? op.operationId,
            operationId: op.operationId,
            path: filePath,
            beforeHash: pre.expectedHash,
            afterHash: "",
            artifactAvailable: !!artifactMeta,
            safeToRollback: false,
            reason: obs.exists ? "File was recreated" : "Artifact preimage missing",
          })
        }
        continue
      }

      // MODIFY mutation rollback candidate
      if (obs.exists && obs.hash === post.expectedHash && artifactMeta) {
        candidates.push({
          mutationId: (op.payload as any)?.mutationId ?? op.operationId,
          operationId: op.operationId,
          path: filePath,
          beforeHash: pre.expectedHash,
          afterHash: post.expectedHash,
          artifactAvailable: true,
          safeToRollback: true,
        })
      } else {
        const reason = !obs.exists
          ? "Target file is missing"
          : obs.hash !== post.expectedHash
          ? "File was modified since mutation (diverged)"
          : "Rollback preimage artifact unavailable"
        candidates.push({
          mutationId: (op.payload as any)?.mutationId ?? op.operationId,
          operationId: op.operationId,
          path: filePath,
          beforeHash: pre.expectedHash,
          afterHash: post.expectedHash,
          artifactAvailable: !!artifactMeta,
          safeToRollback: false,
          reason,
        })
      }
    }

    return candidates
  }

  /**
   * Execute rollback through canonical MutationEngine authority
   * Proposes reverse mutation to MutationEngine with fail-closed write-ahead durability.
   */
  async executeRollback(
    runId: string,
    candidate: RollbackCandidate
  ): Promise<RollbackExecutionResult> {
    this.#metrics.rollbackAttempts++

    // Fail closed if durability infrastructure is missing
    if (!this.#operationJournal || !this.#checkpointStore) {
      this.#metrics.rollbackFailures++
      this.#metrics.rollbackDurabilityFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "FAILED",
        error: "DURABILITY_UNAVAILABLE: Rollback requires active OperationJournal and CheckpointStore",
        durabilityFailure: true,
        recoveryRequired: false,
      }
    }

    if (!candidate.safeToRollback) {
      this.#metrics.rollbackFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "DIVERGED",
        error: candidate.reason ?? "File is not safe to roll back",
        durabilityFailure: false,
        recoveryRequired: false,
      }
    }

    // Fail closed if journal history lookup fails
    let existingOps: RecoveryOperation[]
    try {
      existingOps = await this.#operationJournal.getAllOperations(runId)
    } catch (err: any) {
      this.#metrics.rollbackFailures++
      this.#metrics.rollbackDurabilityFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "FAILED",
        error: `DURABILITY_UNAVAILABLE: Failed to read operation journal history: ${err instanceof Error ? err.message : String(err)}`,
        durabilityFailure: true,
        recoveryRequired: false,
      }
    }

    // Double check current observation to avoid race / TOCTOU
    const obs = await observeFilePath(candidate.path)

    // Determine type: CREATE, DELETE, or MODIFY rollback
    const isCreateRollback = candidate.beforeHash === ""
    const isDeleteRollback = candidate.afterHash === ""
    const isModifyRollback = !isCreateRollback && !isDeleteRollback
    const isAlreadyRestored = isCreateRollback
      ? !obs.exists
      : isDeleteRollback
      ? obs.exists && obs.hash === candidate.beforeHash
      : obs.exists && obs.hash === candidate.beforeHash

    // Duplicate suppression & prior operation status check
    const priorRollbackOp = existingOps.find(
      (op: RecoveryOperation) =>
        op.kind === "ROLLBACK_MUTATION" &&
        (op.payload as any)?.originatingOperationId === candidate.operationId
    )

    if (priorRollbackOp) {
      if (priorRollbackOp.status === "COMPLETED" || priorRollbackOp.status === "RECONCILED_APPLIED") {
        if (isAlreadyRestored) {
          this.#metrics.rollbackDuplicateWritesPrevented++
          this.#metrics.rollbackReconciledApplied++
          this.#metrics.rollbackSuccesses++
          return {
            success: true,
            durableSuccess: true,
            path: candidate.path,
            status: "ROLLED_BACK",
            rollbackOperationId: priorRollbackOp.operationId,
            durabilityFailure: false,
            recoveryRequired: false,
          }
        } else {
          this.#metrics.rollbackFailures++
          return {
            success: false,
            durableSuccess: false,
            path: candidate.path,
            status: "DIVERGED",
            error: "Rollback was previously completed but disk has diverged from restored state",
            durabilityFailure: false,
            recoveryRequired: false,
          }
        }
      }

      if (priorRollbackOp.status === "STARTED") {
        if (isAlreadyRestored) {
          this.#metrics.rollbackDuplicateWritesPrevented++
          this.#metrics.rollbackReconciledApplied++
          this.#metrics.rollbackSuccesses++
          return {
            success: true,
            durableSuccess: true,
            path: candidate.path,
            status: "ROLLED_BACK",
            rollbackOperationId: priorRollbackOp.operationId,
            durabilityFailure: false,
            recoveryRequired: false,
          }
        } else {
          this.#metrics.rollbackFailures++
          this.#metrics.rollbackReconciledNotApplied++
          return {
            success: false,
            durableSuccess: false,
            path: candidate.path,
            status: "FAILED",
            error: "RECOVERY_REQUIRED: Prior rollback operation is in STARTED state and disk is not restored. Canonical recovery required.",
            durabilityFailure: false,
            recoveryRequired: true,
          }
        }
      }
    }

    // Validate current disk state before rollback
    if (isCreateRollback) {
      if (obs.hash !== candidate.afterHash) {
        this.#metrics.rollbackFailures++
        return {
          success: false,
          durableSuccess: false,
          path: candidate.path,
          status: "DIVERGED",
          error: "Current file content has diverged from expected post-creation state",
          durabilityFailure: false,
          recoveryRequired: false,
        }
      }
    } else if (isDeleteRollback) {
      if (obs.exists) {
        this.#metrics.rollbackFailures++
        return {
          success: false,
          durableSuccess: false,
          path: candidate.path,
          status: "DIVERGED",
          error: "Cannot restore deleted file: path already exists on disk",
          durabilityFailure: false,
          recoveryRequired: false,
        }
      }
    } else {
      // isModifyRollback
      if (obs.hash !== candidate.afterHash) {
        this.#metrics.rollbackFailures++
        return {
          success: false,
          durableSuccess: false,
          path: candidate.path,
          status: "DIVERGED",
          error: `File diverged before rollback: expected ${candidate.afterHash.slice(0, 8)}, got ${obs.hash.slice(0, 8)}`,
          durabilityFailure: false,
          recoveryRequired: false,
        }
      }
    }

    // Preimage check for DELETE or MODIFY rollback
    let preimage: Buffer | null = null
    let artifactMeta: any = null
    if (isDeleteRollback || isModifyRollback) {
      artifactMeta = await this.#artifactStore.findArtifactForOperation(runId, candidate.operationId)
      if (!artifactMeta) {
        this.#metrics.rollbackFailures++
        return {
          success: false,
          durableSuccess: false,
          path: candidate.path,
          status: "FAILED",
          error: "Recovery artifact preimage not found in storage",
          durabilityFailure: false,
          recoveryRequired: false,
        }
      }
      preimage = await this.#artifactStore.getPreimage(runId, artifactMeta.artifactId)
      if (!preimage) {
        this.#metrics.rollbackFailures++
        return {
          success: false,
          durableSuccess: false,
          path: candidate.path,
          status: "FAILED",
          error: "Could not read recovery preimage bytes",
          durabilityFailure: false,
          recoveryRequired: false,
        }
      }
    }

    // Define preconditions and expected postconditions
    let preconditions: RecoveryOperation["preconditions"]
    let expectedPostconditions: RecoveryOperation["expectedPostconditions"]

    if (isCreateRollback) {
      preconditions = [{ path: candidate.path, expectedHash: candidate.afterHash, exists: true }]
      expectedPostconditions = [{ path: candidate.path, expectedHash: "", exists: false }]
    } else if (isDeleteRollback) {
      preconditions = [{ path: candidate.path, expectedHash: "", exists: false }]
      expectedPostconditions = [{ path: candidate.path, expectedHash: candidate.beforeHash, exists: true }]
    } else {
      // isModifyRollback
      preconditions = [{ path: candidate.path, expectedHash: candidate.afterHash, exists: true }]
      expectedPostconditions = [{ path: candidate.path, expectedHash: candidate.beforeHash, exists: true }]
    }

    // Write-Ahead Journaling: PREPARED & STARTED
    let latestCp: any = null
    try {
      latestCp = await this.#checkpointStore.getLatestCheckpoint(runId)
    } catch (err: any) {
      this.#metrics.rollbackFailures++
      this.#metrics.rollbackDurabilityFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "FAILED",
        error: `DURABILITY_UNAVAILABLE: Failed to read latest checkpoint: ${err instanceof Error ? err.message : String(err)}`,
        durabilityFailure: true,
        recoveryRequired: false,
      }
    }

    const evidenceVersion = (latestCp?.evidenceVersion ?? 0) + 1
    const rollbackOpId = `op_rb_${candidate.operationId.replace(/^op_/, "").slice(0, 8)}_${randomUUID().slice(0, 6)}`

    const payload: Record<string, unknown> = {
      originatingOperationId: candidate.operationId,
      originatingMutationId: candidate.mutationId,
      targetPath: candidate.path,
      expectedCurrentHash: candidate.afterHash,
      expectedRestoredHash: candidate.beforeHash,
      isRollback: true,
      ...(artifactMeta ? { artifactId: artifactMeta.artifactId } : {}),
    }

    const intentHash = computeIntentHash({
      kind: "ROLLBACK_MUTATION",
      preconditions,
      expectedPostconditions,
      payload,
    })

    const idempotencyKey = computeOperationIdempotencyKey(
      runId,
      evidenceVersion,
      "ROLLBACK_MUTATION",
      "mutation-engine",
      intentHash
    )

    try {
      await this.#operationJournal.recordPrepared({
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        operationId: rollbackOpId,
        idempotencyKey,
        runId,
        processEpochId: getProcessEpochId(),
        checkpointId: latestCp?.checkpointId ?? "init",
        evidenceVersion,
        kind: "ROLLBACK_MUTATION",
        authorityId: "mutation-engine",
        intentHash,
        preconditions,
        expectedPostconditions,
        payload,
      })
    } catch (err: any) {
      this.#metrics.rollbackFailures++
      this.#metrics.rollbackDurabilityFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "FAILED",
        error: `DURABILITY_UNAVAILABLE: Failed to prepare rollback operation: ${err instanceof Error ? err.message : String(err)}`,
        durabilityFailure: true,
        recoveryRequired: false,
      }
    }

    try {
      await this.#operationJournal.recordStarted(rollbackOpId, runId)
    } catch (err: any) {
      this.#metrics.rollbackFailures++
      this.#metrics.rollbackDurabilityFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "FAILED",
        error: `DURABILITY_UNAVAILABLE: Failed to record rollback operation started: ${err instanceof Error ? err.message : String(err)}`,
        durabilityFailure: true,
        recoveryRequired: false,
      }
    }

    // Now execute reverse mutation through canonical MutationEngine
    let res: any
    let mutationThrew = false
    let mutationErr: any = null

    try {
      if (isCreateRollback) {
        let snapshot = this.#mutationEngine.getSnapshot(candidate.mutationId)
        if (!snapshot) {
          snapshot = {
            id: candidate.mutationId,
            path: candidate.path,
            resolvedPath: candidate.path,
            operation: "create",
            beforeContent: null,
            beforeHash: "",
            afterHash: candidate.afterHash,
            timestamp: new Date().toISOString(),
          }
          this.#mutationEngine.registerSnapshot(snapshot)
        }
        res = await this.#mutationEngine.rollback(candidate.mutationId)
      } else if (isDeleteRollback) {
        const prep = await this.#mutationEngine.prepareCreate({
          operation: "create",
          path: candidate.path,
          content: preimage!.toString("utf8"),
        })
        res = await this.#mutationEngine.applyPreparedMutation(prep)
      } else {
        // isModifyRollback
        let snapshot = this.#mutationEngine.getSnapshot(candidate.mutationId)
        if (!snapshot) {
          snapshot = {
            id: candidate.mutationId,
            path: candidate.path,
            resolvedPath: candidate.path,
            operation: "patch",
            beforeContent: preimage!.toString("utf8"),
            beforeHash: candidate.beforeHash,
            afterHash: candidate.afterHash,
            timestamp: new Date().toISOString(),
          }
          this.#mutationEngine.registerSnapshot(snapshot)
        }
        res = await this.#mutationEngine.rollback(candidate.mutationId)
      }
    } catch (err: any) {
      mutationThrew = true
      mutationErr = err
    }

    const isMutationSuccess = !mutationThrew && res?.status === "APPLIED"

    // If reverse mutation failed
    if (!isMutationSuccess) {
      const failureReason = mutationErr?.message ?? res?.error?.message ?? "Rollback mutation failed"
      this.#metrics.rollbackFailures++
      try {
        await this.#operationJournal.recordFailed(rollbackOpId, runId, failureReason)
        return {
          success: false,
          durableSuccess: false,
          path: candidate.path,
          status: "FAILED",
          rollbackOperationId: rollbackOpId,
          error: failureReason,
          durabilityFailure: false,
          recoveryRequired: false,
        }
      } catch (recFailedErr: any) {
        // T-5212: recordFailed also fails!
        this.#metrics.rollbackDurabilityFailures++
        return {
          success: false,
          durableSuccess: false,
          path: candidate.path,
          status: "RECOVERY_REQUIRED",
          rollbackOperationId: rollbackOpId,
          error: `RECOVERY_PERSISTENCE_FAILED: MutationEngine rollback failed and recording failure to journal also failed: ${recFailedErr instanceof Error ? recFailedErr.message : String(recFailedErr)}`,
          durabilityFailure: true,
          recoveryRequired: true,
        }
      }
    }

    // Post-Write Durability Step 1: recordCompleted in journal (T-5207)
    try {
      await this.#operationJournal.recordCompleted(rollbackOpId, runId, res.id ?? candidate.mutationId)
    } catch (err: any) {
      this.#metrics.rollbackFailures++
      this.#metrics.rollbackDurabilityFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "RECOVERY_REQUIRED",
        rollbackOperationId: rollbackOpId,
        error: `DURABILITY_UNAVAILABLE: Reverse mutation applied but recording COMPLETED to journal failed: ${err instanceof Error ? err.message : String(err)}`,
        durabilityFailure: true,
        recoveryRequired: true,
      }
    }

    // Post-Write Durability Step 2: save ROLLBACK_COMPLETED checkpoint (T-5209)
    try {
      const latestCpAfterWrite = await this.#checkpointStore.getLatestCheckpoint(runId)
      const postObs = await observeFilePath(candidate.path)
      await this.#checkpointStore.saveCheckpoint({
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        checkpointId: `cp_rb_${randomUUID().slice(0, 8)}`,
        runId,
        sequence: (latestCpAfterWrite?.sequence ?? 0) + 1,
        createdAt: new Date().toISOString(),
        reason: "ROLLBACK_COMPLETED",
        phase: "MUTATION",
        turnId: latestCpAfterWrite?.turnId ?? 0,
        evidenceVersion: (latestCpAfterWrite?.evidenceVersion ?? 0) + 1,
        runtimeState: { status: "OBSERVING" },
        processEpochId: getProcessEpochId(),
        recoveryFootprint: {
          files: [
            {
              path: candidate.path,
              exists: postObs.exists,
              hash: postObs.hash,
            },
          ],
        },
        pendingOperations: [],
        completedOperationRefs: [rollbackOpId],
        workspaceState: {
          divergenceClass: "EXACT_MATCH",
        },
      })
    } catch (err: any) {
      this.#metrics.rollbackFailures++
      this.#metrics.rollbackDurabilityFailures++
      return {
        success: false,
        durableSuccess: false,
        path: candidate.path,
        status: "RECOVERY_REQUIRED",
        rollbackOperationId: rollbackOpId,
        error: `DURABILITY_UNAVAILABLE: Rollback completed mutation and journaled COMPLETED but failed to save ROLLBACK_COMPLETED checkpoint: ${err instanceof Error ? err.message : String(err)}`,
        durabilityFailure: true,
        recoveryRequired: true,
      }
    }

    // Final Durable Success: All durability and write stages succeeded
    this.#metrics.rollbackSuccesses++
    return {
      success: true,
      durableSuccess: true,
      path: candidate.path,
      status: "ROLLED_BACK",
      rollbackOperationId: rollbackOpId,
      durabilityFailure: false,
      recoveryRequired: false,
    }
  }
}
