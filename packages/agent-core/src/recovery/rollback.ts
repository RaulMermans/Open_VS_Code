/**
 * Rollback Handler
 * Sprint 4C — Reversible mutation rollback via canonical MutationEngine authority
 * RecoveryController proposes reverse mutation -> MutationEngine applies -> normal authority & verification
 */

import {
  type RollbackCandidate,
  type RecoveryOperation,
} from "./contracts.ts"
import { observeFilePath } from "./reconciliation.ts"
import { RecoveryArtifactStore } from "./recovery-artifacts.ts"
import { MutationEngine } from "../tools/mutation-engine.ts"

export interface RollbackExecutionResult {
  readonly success: boolean
  readonly path: string
  readonly status: "ROLLED_BACK" | "FAILED" | "DIVERGED"
  readonly error?: string
}

export class RollbackManager {
  readonly #mutationEngine: MutationEngine
  readonly #artifactStore: RecoveryArtifactStore

  constructor(mutationEngine: MutationEngine, artifactStore: RecoveryArtifactStore) {
    this.#mutationEngine = mutationEngine
    this.#artifactStore = artifactStore
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

    // 1. Rollback CREATE (file exists, delete it via MutationEngine)
    if (candidate.beforeHash === "") {
      if (obs.hash !== candidate.afterHash) {
        return {
          success: false,
          path: candidate.path,
          status: "DIVERGED",
          error: "Current file content has diverged from expected post-creation state",
        }
      }

      try {
        let snapshot = this.#mutationEngine.getSnapshot(candidate.mutationId)
        if (!snapshot) {
          // Reconstitute snapshot for canonical rollback across restart
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
        const res = await this.#mutationEngine.rollback(candidate.mutationId)
        const isSuccess = res.status === "APPLIED"
        return {
          success: isSuccess,
          path: candidate.path,
          status: isSuccess ? "ROLLED_BACK" : "FAILED",
          ...(res.error?.message ? { error: res.error.message } : {}),
        }
      } catch (err: any) {
        return {
          success: false,
          path: candidate.path,
          status: "FAILED",
          error: err.message,
        }
      }
    }

    // 2. Rollback MODIFY / DELETE (requires preimage from RecoveryArtifactStore)
    const artifactMeta = await this.#artifactStore.findArtifactForOperation(runId, candidate.operationId)
    if (!artifactMeta) {
      return {
        success: false,
        path: candidate.path,
        status: "FAILED",
        error: "Recovery artifact preimage not found in storage",
      }
    }

    const preimage = await this.#artifactStore.getPreimage(runId, artifactMeta.artifactId)
    if (!preimage) {
      return {
        success: false,
        path: candidate.path,
        status: "FAILED",
        error: "Could not read recovery preimage bytes",
      }
    }

    // If candidate was a modify, verify current hash matches afterHash
    if (candidate.afterHash !== "" && obs.hash !== candidate.afterHash) {
      return {
        success: false,
        path: candidate.path,
        status: "DIVERGED",
        error: `File diverged before rollback: expected ${candidate.afterHash.slice(0, 8)}, got ${obs.hash.slice(0, 8)}`,
      }
    }

    // If candidate was a delete, verify path doesn't already exist
    if (candidate.afterHash === "" && obs.exists) {
      return {
        success: false,
        path: candidate.path,
        status: "DIVERGED",
        error: "Cannot restore deleted file: path already exists on disk",
      }
    }

    try {
      if (candidate.afterHash === "") {
        // DELETE rollback: recreate deleted file from preimage through MutationEngine prepareCreate & applyPreparedMutation
        const prep = await this.#mutationEngine.prepareCreate({
          operation: "create",
          path: candidate.path,
          content: preimage.toString("utf8"),
        })
        const res = await this.#mutationEngine.applyPreparedMutation(prep)
        const isSuccess = res.status === "APPLIED"
        return {
          success: isSuccess,
          path: candidate.path,
          status: isSuccess ? "ROLLED_BACK" : "FAILED",
          ...(res.error?.message ? { error: res.error.message } : {}),
        }
      }

      // MODIFY rollback: restore via MutationEngine.rollback with in-memory or reconstituted snapshot
      let snapshot = this.#mutationEngine.getSnapshot(candidate.mutationId)
      if (!snapshot) {
        snapshot = {
          id: candidate.mutationId,
          path: candidate.path,
          resolvedPath: candidate.path,
          operation: "patch",
          beforeContent: preimage.toString("utf8"),
          beforeHash: candidate.beforeHash,
          afterHash: candidate.afterHash,
          timestamp: new Date().toISOString(),
        }
        this.#mutationEngine.registerSnapshot(snapshot)
      }
      const res = await this.#mutationEngine.rollback(candidate.mutationId)
      const isSuccess = res.status === "APPLIED"
      return {
        success: isSuccess,
        path: candidate.path,
        status: isSuccess ? "ROLLED_BACK" : "FAILED",
        ...(res.error?.message ? { error: res.error.message } : {}),
      }
    } catch (err: any) {
      return {
        success: false,
        path: candidate.path,
        status: "FAILED",
        error: err.message,
      }
    }
  }
}

