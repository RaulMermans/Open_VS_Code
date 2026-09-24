/**
 * Operation Journal
 * Sprint 4C — Write-Ahead side-effect logging, deterministic idempotency, crash classification
 */

import { readFile, appendFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  type RecoveryOperation,
  type OperationKind,
  type OperationStatus,
} from "./contracts.ts"
import { assertSafeStoragePath } from "./storage-path-safety.ts"

export function computeOperationIdempotencyKey(
  runId: string,
  evidenceVersion: number,
  kind: OperationKind,
  authorityId: string,
  intentHash: string
): string {
  const raw = `${runId}:${evidenceVersion}:${kind}:${authorityId}:${intentHash}`
  return createHash("sha256").update(raw, "utf8").digest("hex")
}

import { canonicalSerialize } from "./canonical-serializer.ts"

export function computeIntentHash(payload: unknown): string {
  const serialized = canonicalSerialize(payload)
  return createHash("sha256").update(serialized, "utf8").digest("hex")
}

export interface OperationJournalOptions {
  readonly storageRoot: string
}

export class OperationJournal {
  readonly #storageRoot: string

  constructor(options: OperationJournalOptions) {
    this.#storageRoot = options.storageRoot
  }

  get storageRoot(): string {
    return this.#storageRoot
  }

  async #getJournalPath(runId: string): Promise<string> {
    const runDir = join(this.#storageRoot, "runs", runId)
    await assertSafeStoragePath(this.#storageRoot, runDir)
    await mkdir(runDir, { recursive: true })
    const journalPath = join(runDir, "operations.jsonl")
    await assertSafeStoragePath(this.#storageRoot, journalPath)
    return journalPath
  }

  /**
   * Write-Ahead persist operation PREPARED
   */
  async recordPrepared(
    op: Omit<RecoveryOperation, "status" | "preparedAt">
  ): Promise<RecoveryOperation> {
    const operation: RecoveryOperation = {
      ...op,
      status: "PREPARED",
      preparedAt: new Date().toISOString(),
    }
    await this.#append(operation)
    return operation
  }

  /**
   * Persist transition to STARTED
   */
  async recordStarted(operationId: string, runId: string): Promise<RecoveryOperation> {
    const existing = await this.getOperation(runId, operationId)
    if (!existing) {
      throw new Error(`Operation ${operationId} not found in run ${runId}`)
    }
    const updated: RecoveryOperation = {
      ...existing,
      status: "STARTED",
      startedAt: new Date().toISOString(),
    }
    await this.#append(updated)
    return updated
  }

  /**
   * Persist transition to COMPLETED
   */
  async recordCompleted(
    operationId: string,
    runId: string,
    resultRef?: string
  ): Promise<RecoveryOperation> {
    const existing = await this.getOperation(runId, operationId)
    if (!existing) {
      throw new Error(`Operation ${operationId} not found in run ${runId}`)
    }
    const updated: RecoveryOperation = {
      ...existing,
      status: "COMPLETED",
      completedAt: new Date().toISOString(),
      ...(resultRef ? { resultRef } : {}),
    }
    await this.#append(updated)
    return updated
  }

  /**
   * Persist transition to FAILED
   */
  async recordFailed(
    operationId: string,
    runId: string,
    failureCode: string,
    resultRef?: string
  ): Promise<RecoveryOperation> {
    const existing = await this.getOperation(runId, operationId)
    if (!existing) {
      throw new Error(`Operation ${operationId} not found in run ${runId}`)
    }
    const updated: RecoveryOperation = {
      ...existing,
      status: "FAILED",
      completedAt: new Date().toISOString(),
      failureCode,
      ...(resultRef ? { resultRef } : {}),
    }
    await this.#append(updated)
    return updated
  }

  /**
   * Explicit status update (e.g. RECONCILED_APPLIED, RECONCILED_NOT_APPLIED, ROLLED_BACK, SUPERSEDED, INTERRUPTED)
   */
  async recordStatusUpdate(
    operationId: string,
    runId: string,
    status: OperationStatus,
    extra?: Partial<RecoveryOperation>
  ): Promise<RecoveryOperation> {
    const existing = await this.getOperation(runId, operationId)
    if (!existing) {
      throw new Error(`Operation ${operationId} not found in run ${runId}`)
    }
    const updated: RecoveryOperation = {
      ...existing,
      ...extra,
      status,
    }
    await this.#append(updated)
    return updated
  }

  async #append(op: RecoveryOperation): Promise<void> {
    const journalPath = await this.#getJournalPath(op.runId)
    const line = JSON.stringify(op) + "\n"
    await appendFile(journalPath, line, "utf8")
  }

  async getAllOperations(runId: string): Promise<RecoveryOperation[]> {
    const journalPath = await this.#getJournalPath(runId)
    let raw: string
    try {
      raw = await readFile(journalPath, "utf8")
    } catch {
      return []
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    // Map latest state per operationId
    const opMap = new Map<string, RecoveryOperation>()

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RecoveryOperation
        opMap.set(parsed.operationId, parsed)
      } catch {
        // Skip malformed individual line in append log
      }
    }

    return Array.from(opMap.values())
  }

  async getOperation(runId: string, operationId: string): Promise<RecoveryOperation | undefined> {
    const ops = await this.getAllOperations(runId)
    return ops.find((o) => o.operationId === operationId)
  }

  async findCompletedByIdempotencyKey(
    runId: string,
    idempotencyKey: string
  ): Promise<RecoveryOperation | undefined> {
    const ops = await this.getAllOperations(runId)
    return ops.find(
      (o) =>
        o.idempotencyKey === idempotencyKey &&
        (o.status === "COMPLETED" || o.status === "RECONCILED_APPLIED")
    )
  }

  async clearRun(runId: string): Promise<void> {
    const runDir = join(this.#storageRoot, "runs", runId)
    await assertSafeStoragePath(this.#storageRoot, runDir)
    try {
      await rm(runDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
