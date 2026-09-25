/**
 * Operation Journal with Durable Synchronization & Secondary Index
 * Sprint 4C / Sprint 4D.1 — Tasks T-6116 through T-6121
 */

import { readFile, open, mkdir, rm, type FileHandle } from "node:fs/promises"
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
  readonly durableSync?: boolean
  readonly syncFn?: (handle: FileHandle) => Promise<void>
}

export class OperationJournal {
  readonly #storageRoot: string
  readonly #durableSync: boolean
  readonly #syncFn: ((handle: FileHandle) => Promise<void>) | undefined

  constructor(options: OperationJournalOptions) {
    this.#storageRoot = options.storageRoot
    this.#durableSync = options.durableSync ?? true
    this.#syncFn = options.syncFn
  }

  get storageRoot(): string {
    return this.#storageRoot
  }

  get durableSync(): boolean {
    return this.#durableSync
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

  // Secondary in-memory lookup index: runId -> (operationId -> RecoveryOperation)
  readonly #indexCache = new Map<string, Map<string, RecoveryOperation>>()

  async #append(op: RecoveryOperation): Promise<void> {
    const journalPath = await this.#getJournalPath(op.runId)
    const line = JSON.stringify(op) + "\n"

    // Physical durable append: open handle, write line, sync (fsync/fdatasync), close
    const handle = await open(journalPath, "a")
    let initialSize = 0
    try {
      const stats = await handle.stat()
      initialSize = stats.size
      await handle.appendFile(line, "utf8")
      if (this.#durableSync) {
        if (this.#syncFn) {
          await this.#syncFn(handle)
        } else {
          await handle.sync()
        }
      }
    } catch (err) {
      try {
        await handle.truncate(initialSize)
      } catch {
        // ignore secondary truncate error
      }
      throw err
    } finally {
      await handle.close()
    }

    // Update secondary index ONLY AFTER durable write and synchronization succeed
    const runIndex = this.#indexCache.get(op.runId)
    if (runIndex) {
      runIndex.set(op.operationId, op)
    }
  }

  async getAllOperations(runId: string): Promise<RecoveryOperation[]> {
    const cached = this.#indexCache.get(runId)
    if (cached) {
      return Array.from(cached.values())
    }

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

    this.#indexCache.set(runId, opMap)
    return Array.from(opMap.values())
  }

  rebuildIndex(runId?: string): void {
    if (runId) {
      this.#indexCache.delete(runId)
    } else {
      this.#indexCache.clear()
    }
  }

  async getOperation(runId: string, operationId: string): Promise<RecoveryOperation | undefined> {
    const runIndex = this.#indexCache.get(runId)
    if (runIndex) {
      return runIndex.get(operationId)
    }
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
    this.#indexCache.delete(runId)
    const runDir = join(this.#storageRoot, "runs", runId)
    await assertSafeStoragePath(this.#storageRoot, runDir)
    try {
      await rm(runDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
