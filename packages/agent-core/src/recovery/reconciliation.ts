/**
 * Reconciliation Logic
 * Sprint 4C — Reconcile actual workspace state against persisted intent and checkpoint
 */

import { readFile, access } from "node:fs/promises"
import { createHash } from "node:crypto"
import {
  type RecoveryOperation,
  type ReconciledOperationSummary,
  type WorkspaceDivergenceClass,
  type WorkspaceRecoveryFootprint,
} from "./contracts.ts"

export function sha256Bytes(content: Buffer | string): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content
  return createHash("sha256").update(buf).digest("hex")
}

export interface FileObservation {
  readonly path: string
  readonly exists: boolean
  readonly hash: string
}

export async function observeFilePath(path: string): Promise<FileObservation> {
  try {
    await access(path)
    const content = await readFile(path)
    return {
      path,
      exists: true,
      hash: sha256Bytes(content),
    }
  } catch {
    return {
      path,
      exists: false,
      hash: "",
    }
  }
}

export interface OperationReconciliationResult {
  readonly summary: ReconciledOperationSummary
  readonly isBlocked: boolean
  readonly isApplied: boolean
  readonly divergenceClass?: WorkspaceDivergenceClass
}

export async function reconcileOperation(
  op: RecoveryOperation,
  _currentEpoch: string
): Promise<OperationReconciliationResult> {
  // If operation failed before restart
  if (op.status === "FAILED") {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "FAILED",
        reason: `Operation previously failed: ${op.failureCode ?? "unknown"}`,
        writeReplayCount: 0,
      },
      isBlocked: false,
      isApplied: false,
    }
  }

  // Handle MUTATION reconciliation based on authoritative filesystem observation
  if (op.kind === "MUTATION") {
    return reconcileMutation(op)
  }

  // Handle VERIFICATION reconciliation
  if (op.kind === "VERIFICATION") {
    return reconcileVerification(op)
  }

  // If other non-mutation operation was already durably COMPLETED before crash
  if (op.status === "COMPLETED") {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "COMPLETED",
        reason: "Operation was durably completed before restart",
        writeReplayCount: 0,
      },
      isBlocked: false,
      isApplied: true,
    }
  }

  // Handle MCP operations
  if (op.kind === "MCP_READ") {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "INTERRUPTED",
        reason: "MCP read was interrupted; safe to retry with new execution identity",
        writeReplayCount: 0,
      },
      isBlocked: false,
      isApplied: false,
    }
  }

  if (op.kind === "MCP_SIDE_EFFECT") {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "AMBIGUOUS",
        reason: "Interrupted MCP side-effect has uncertain outcome on remote server; manual human confirmation required",
        writeReplayCount: 0,
      },
      isBlocked: true,
      isApplied: false,
    }
  }

  // Default fallback for model / context calls
  return {
    summary: {
      operationId: op.operationId,
      kind: op.kind,
      originalStatus: op.status,
      reconciledStatus: "INTERRUPTED",
      reason: `Interrupted ${op.kind} discarded across process epoch`,
      writeReplayCount: 0,
    },
    isBlocked: false,
    isApplied: false,
  }
}

async function reconcileMutation(op: RecoveryOperation): Promise<OperationReconciliationResult> {
  const post = op.expectedPostconditions[0]
  const pre = op.preconditions[0]

  if (!post) {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "AMBIGUOUS",
        reason: "Mutation operation missing postcondition definition",
        writeReplayCount: 0,
      },
      isBlocked: true,
      isApplied: false,
      divergenceClass: "BLOCKED_DIVERGENCE",
    }
  }

  const observation = await observeFilePath(post.path)

  // 1. CREATE mutation (expected exists = true, pre exists = false)
  if (!pre || !pre.exists) {
    if (!observation.exists) {
      return {
        summary: {
          operationId: op.operationId,
          kind: op.kind,
          originalStatus: op.status,
          reconciledStatus: "RECONCILED_NOT_APPLIED",
          reason: "Created file was not present on disk",
          writeReplayCount: 0,
        },
        isBlocked: false,
        isApplied: false,
        divergenceClass: "EXACT_MATCH",
      }
    }
    if (observation.hash === post.expectedHash) {
      return {
        summary: {
          operationId: op.operationId,
          kind: op.kind,
          originalStatus: op.status,
          reconciledStatus: "RECONCILED_APPLIED",
          reason: "Created file exists with exact expected content",
          writeReplayCount: 0,
        },
        isBlocked: false,
        isApplied: true,
        divergenceClass: "EXPECTED_APPLIED_STATE",
      }
    }
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "AMBIGUOUS",
        reason: `Created file exists with unexpected hash: ${observation.hash.slice(0, 8)} != expected ${post.expectedHash.slice(0, 8)}`,
        writeReplayCount: 0,
      },
      isBlocked: true,
      isApplied: false,
      divergenceClass: "BLOCKED_DIVERGENCE",
    }
  }

  // 2. DELETE mutation (expected exists = false, pre exists = true)
  if (!post.exists) {
    if (!observation.exists) {
      return {
        summary: {
          operationId: op.operationId,
          kind: op.kind,
          originalStatus: op.status,
          reconciledStatus: "RECONCILED_APPLIED",
          reason: "Target file was deleted as expected",
          writeReplayCount: 0,
        },
        isBlocked: false,
        isApplied: true,
        divergenceClass: "EXPECTED_APPLIED_STATE",
      }
    }
    if (observation.hash === pre.expectedHash) {
      return {
        summary: {
          operationId: op.operationId,
          kind: op.kind,
          originalStatus: op.status,
          reconciledStatus: "RECONCILED_NOT_APPLIED",
          reason: "Target file still exists with original beforeHash",
          writeReplayCount: 0,
        },
        isBlocked: false,
        isApplied: false,
        divergenceClass: "EXACT_MATCH",
      }
    }
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "AMBIGUOUS",
        reason: "Target file exists with modified hash instead of being deleted",
        writeReplayCount: 0,
      },
      isBlocked: true,
      isApplied: false,
      divergenceClass: "BLOCKED_DIVERGENCE",
    }
  }

  // 3. MODIFY mutation (pre.exists = true, post.exists = true)
  if (!observation.exists) {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "AMBIGUOUS",
        reason: "Target file unexpectedly missing from disk",
        writeReplayCount: 0,
      },
      isBlocked: true,
      isApplied: false,
      divergenceClass: "BLOCKED_DIVERGENCE",
    }
  }

  if (observation.hash === post.expectedHash) {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "RECONCILED_APPLIED",
        reason: "File matches expected post-mutation hash exactly",
        writeReplayCount: 0,
      },
      isBlocked: false,
      isApplied: true,
      divergenceClass: "EXPECTED_APPLIED_STATE",
    }
  }

  if (observation.hash === pre.expectedHash) {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "RECONCILED_NOT_APPLIED",
        reason: "File matches original before-mutation hash; write never executed",
        writeReplayCount: 0,
      },
      isBlocked: false,
      isApplied: false,
      divergenceClass: "EXACT_MATCH",
    }
  }

  // File hash differs from BOTH before and after hash -> DIVERGENCE
  return {
    summary: {
      operationId: op.operationId,
      kind: op.kind,
      originalStatus: op.status,
      reconciledStatus: "AMBIGUOUS",
      reason: `File hash ${observation.hash.slice(0, 8)} diverges from before (${pre.expectedHash.slice(0, 8)}) and after (${post.expectedHash.slice(0, 8)})`,
      writeReplayCount: 0,
    },
    isBlocked: true,
    isApplied: false,
    divergenceClass: "BLOCKED_DIVERGENCE",
  }
}

function reconcileVerification(op: RecoveryOperation): OperationReconciliationResult {
  if (op.status === "COMPLETED") {
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "COMPLETED",
        reason: "Verification completed durably before restart",
        writeReplayCount: 0,
      },
      isBlocked: false,
      isApplied: true,
    }
  }

  if (op.status === "STARTED") {
    // Interrupted verification cannot be assumed successful
    return {
      summary: {
        operationId: op.operationId,
        kind: op.kind,
        originalStatus: op.status,
        reconciledStatus: "INTERRUPTED",
        reason: "Verification process was interrupted mid-flight; result unknown",
        writeReplayCount: 0,
      },
      isBlocked: false,
      isApplied: false,
    }
  }

  // Prepared but not started
  return {
    summary: {
      operationId: op.operationId,
      kind: op.kind,
      originalStatus: op.status,
      reconciledStatus: "RECONCILED_NOT_APPLIED",
      reason: "Verification was prepared but never spawned",
      writeReplayCount: 0,
    },
    isBlocked: false,
    isApplied: false,
  }
}

/**
 * Reconcile recovery footprint against disk
 */
export async function reconcileFootprint(
  footprint: WorkspaceRecoveryFootprint
): Promise<{ divergenceClass: WorkspaceDivergenceClass; divergedFiles: string[] }> {
  const divergedFiles: string[] = []

  for (const file of footprint.files) {
    const obs = await observeFilePath(file.path)
    if (file.exists && !obs.exists) {
      divergedFiles.push(file.path)
    } else if (!file.exists && obs.exists) {
      divergedFiles.push(file.path)
    } else if (file.exists && obs.exists && file.hash !== obs.hash) {
      divergedFiles.push(file.path)
    }
  }

  if (divergedFiles.length > 0) {
    return { divergenceClass: "BLOCKED_DIVERGENCE", divergedFiles }
  }

  return { divergenceClass: "EXACT_MATCH", divergedFiles: [] }
}
