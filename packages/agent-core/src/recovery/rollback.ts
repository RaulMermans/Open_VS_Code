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

export interface RollbackExecutionResult {
  readonly success: boolean
  readonly path: string
  readonly status: "ROLLED_BACK" | "FAILED" | "DIVERGED"
  readonly rollbackOperationId?: string | undefined
  readonly error?: string | undefined
}

export interface RollbackManagerOptions {
  readonly mutationEngine: MutationEngine
  readonly artifactStore: RecoveryArtifactStore
  readonly operationJournal?: OperationJournal
  readonly checkpointStore?: CheckpointStore
}

export class RollbackManager {
  readonly #mutationEngine: MutationEngine
  readonly #artifactStore: RecoveryArtifactStore
  readonly #operationJournal: OperationJournal | undefined
  readonly #checkpointStore: CheckpointStore | undefined

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
   * Proposes reverse mutation to MutationEngine.
   */
  async executeRollback(
    runId: string,
    candidate: RollbackCandidate
  ): Promise<RollbackExecutionResult> {
    if (!candidate.safeToRollback) {
      return {
        success: false,
        path: candidate.path,
        status: "DIVERGED",
        error: candidate.reason ?? "File is not safe to roll back",
      }
    }

    // Double check current observation to avoid race / TOCTOU
    const obs = await observeFilePath(candidate.path)

    // Determine type: CREATE, DELETE, or MODIFY rollback
    const isCreateRollback = candidate.beforeHash === ""
    const isDeleteRollback = candidate.afterHash === ""
    const isModifyRollback = !isCreateRollback && !isDeleteRollback

    // Check duplicate suppression if operationJournal is available and disk is already restored:
    if (this.#operationJournal) {
      const existingOps: RecoveryOperation[] = await this.#operationJournal.getAllOperations(runId).catch(() => [])
      const alreadyCompleted = existingOps.find(
        (op: RecoveryOperation) =>
          op.kind === "ROLLBACK_MUTATION" &&
          (op.payload as any)?.originatingOperationId === candidate.operationId &&
          (op.status === "COMPLETED" || op.status === "RECONCILED_APPLIED")
      )
      if (alreadyCompleted) {
        const isAlreadyRestored = isCreateRollback
          ? !obs.exists
          : isDeleteRollback
          ? obs.exists && obs.hash === candidate.beforeHash
          : obs.exists && obs.hash === candidate.beforeHash

        if (isAlreadyRestored) {
          return {
            success: true,
            path: candidate.path,
            status: "ROLLED_BACK",
            rollbackOperationId: alreadyCompleted.operationId,
          }
        }
      }
    }

    // Validate current disk state before rollback
    if (isCreateRollback) {
      if (obs.hash !== candidate.afterHash) {
        return {
          success: false,
          path: candidate.path,
          status: "DIVERGED",
          error: "Current file content has diverged from expected post-creation state",
        }
      }
    } else if (isDeleteRollback) {
      if (obs.exists) {
        return {
          success: false,
          path: candidate.path,
          status: "DIVERGED",
          error: "Cannot restore deleted file: path already exists on disk",
        }
      }
    } else {
      // isModifyRollback
      if (obs.hash !== candidate.afterHash) {
        return {
          success: false,
          path: candidate.path,
          status: "DIVERGED",
          error: `File diverged before rollback: expected ${candidate.afterHash.slice(0, 8)}, got ${obs.hash.slice(0, 8)}`,
        }
      }
    }

    // Preimage check for DELETE or MODIFY rollback
    let preimage: Buffer | null = null
    let artifactMeta: any = null
    if (isDeleteRollback || isModifyRollback) {
      artifactMeta = await this.#artifactStore.findArtifactForOperation(runId, candidate.operationId)
      if (!artifactMeta) {
        return {
          success: false,
          path: candidate.path,
          status: "FAILED",
          error: "Recovery artifact preimage not found in storage",
        }
      }
      preimage = await this.#artifactStore.getPreimage(runId, artifactMeta.artifactId)
      if (!preimage) {
        return {
          success: false,
          path: candidate.path,
          status: "FAILED",
          error: "Could not read recovery preimage bytes",
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
    let rollbackOpId: string | undefined
    if (this.#operationJournal) {
      const latestCp = this.#checkpointStore
        ? await this.#checkpointStore.getLatestCheckpoint(runId).catch(() => null)
        : null
      const evidenceVersion = (latestCp?.evidenceVersion ?? 0) + 1
      rollbackOpId = `op_rb_${candidate.operationId.replace(/^op_/, "").slice(0, 8)}_${randomUUID().slice(0, 6)}`

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
      } catch (err) {
        return {
          success: false,
          path: candidate.path,
          status: "FAILED",
          error: `DURABILITY_UNAVAILABLE: Failed to prepare rollback operation: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      try {
        await this.#operationJournal.recordStarted(rollbackOpId, runId)
      } catch (err) {
        return {
          success: false,
          path: candidate.path,
          status: "FAILED",
          error: `DURABILITY_UNAVAILABLE: Failed to record rollback operation started: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    // Now execute reverse mutation through canonical MutationEngine
    try {
      let res: any
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

      const isSuccess = res.status === "APPLIED"

      if (this.#operationJournal && rollbackOpId) {
        if (isSuccess) {
          await this.#operationJournal.recordCompleted(rollbackOpId, runId, res.id ?? candidate.mutationId)
          if (this.#checkpointStore) {
            const latestCp = await this.#checkpointStore.getLatestCheckpoint(runId).catch(() => null)
            await this.#checkpointStore.saveCheckpoint({
              schemaVersion: CHECKPOINT_SCHEMA_VERSION,
              checkpointId: `cp_rb_${randomUUID().slice(0, 8)}`,
              runId,
              sequence: (latestCp?.sequence ?? 0) + 1,
              createdAt: new Date().toISOString(),
              reason: "ROLLBACK_COMPLETED",
              phase: "MUTATION",
              turnId: latestCp?.turnId ?? 0,
              evidenceVersion: (latestCp?.evidenceVersion ?? 0) + 1,
              runtimeState: { status: "OBSERVING" },
              processEpochId: getProcessEpochId(),
              recoveryFootprint: {
                files: [
                  {
                    path: candidate.path,
                    exists: obs.exists,
                    hash: obs.hash,
                  },
                ],
              },
              pendingOperations: [],
              completedOperationRefs: [rollbackOpId],
              workspaceState: {
                divergenceClass: "EXACT_MATCH",
              },
            }).catch(() => {})
          }
        } else {
          await this.#operationJournal.recordFailed(rollbackOpId, runId, res.error?.message ?? "Rollback failed")
        }
      }

      return {
        success: isSuccess,
        path: candidate.path,
        status: isSuccess ? "ROLLED_BACK" : "FAILED",
        rollbackOperationId: rollbackOpId,
        ...(res.error?.message ? { error: res.error.message } : {}),
      }
    } catch (err: any) {
      if (this.#operationJournal && rollbackOpId) {
        await this.#operationJournal.recordFailed(rollbackOpId, runId, err.message).catch(() => {})
      }
      return {
        success: false,
        path: candidate.path,
        status: "FAILED",
        rollbackOperationId: rollbackOpId,
        error: err.message,
      }
    }
  }
}
