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
  OPERATION_STATUSES,
  OPERATION_KINDS,
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
  readonly durableSync?: boolean | undefined
  readonly syncFn?: ((handle: FileHandle) => Promise<void>) | undefined
  readonly readFileFn?: ((path: string, encoding: "utf8") => Promise<string>) | undefined
}

export function assertValidOperationRecord(record: unknown, runId: string): asserts record is RecoveryOperation {
  if (!record || typeof record !== "object") {
    throw new Error(`JOURNAL_CORRUPT: Operation record must be a non-null object`)
  }
  const r = record as Record<string, unknown>
  if (typeof r.operationId !== "string" || r.operationId.trim().length === 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid operationId`)
  }
  if (typeof r.runId !== "string" || r.runId !== runId) {
    throw new Error(`JOURNAL_CORRUPT: Mismatched or invalid runId: expected ${runId}, got ${String(r.runId)}`)
  }
  if (typeof r.schemaVersion !== "number" || r.schemaVersion <= 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid schemaVersion`)
  }
  if (typeof r.status !== "string" || !(OPERATION_STATUSES as readonly string[]).includes(r.status)) {
    throw new Error(`JOURNAL_CORRUPT: Invalid operation status: ${String(r.status)}`)
  }
  if (typeof r.kind !== "string" || !(OPERATION_KINDS as readonly string[]).includes(r.kind)) {
    throw new Error(`JOURNAL_CORRUPT: Invalid operation kind: ${String(r.kind)}`)
  }
  if (typeof r.processEpochId !== "string" || r.processEpochId.trim().length === 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid processEpochId`)
  }
  if (typeof r.checkpointId !== "string" || r.checkpointId.trim().length === 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid checkpointId`)
  }
  if (typeof r.authorityId !== "string" || r.authorityId.trim().length === 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid authorityId`)
  }
  if (typeof r.intentHash !== "string" || r.intentHash.trim().length === 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid intentHash`)
  }
  if (typeof r.idempotencyKey !== "string" || r.idempotencyKey.trim().length === 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid idempotencyKey`)
  }
  if (typeof r.preparedAt !== "string" || r.preparedAt.trim().length === 0) {
    throw new Error(`JOURNAL_CORRUPT: Missing or invalid preparedAt`)
  }
}

export class OperationJournal {
  readonly #storageRoot: string
  readonly #durableSync: boolean
  readonly #syncFn: ((handle: FileHandle) => Promise<void>) | undefined
  #readFileFn: ((path: string, encoding: "utf8") => Promise<string>) | undefined

  constructor(options: OperationJournalOptions) {
    this.#storageRoot = options.storageRoot
    this.#durableSync = options.durableSync ?? true
    this.#syncFn = options.syncFn
    this.#readFileFn = options.readFileFn
  }

  setReadFileFnForTesting(fn?: (path: string, encoding: "utf8") => Promise<string>): void {
    this.#readFileFn = fn
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
    const journalPath = await this.#getJournalPath(runId)
    let raw: string
    try {
      const readFn = this.#readFileFn ?? readFile
      raw = await readFn(journalPath, "utf8")
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        this.#indexCache.delete(runId)
        return []
      }
      throw new Error(
        `JOURNAL_READ_FAILURE: Failed to read operation journal for run ${runId}: ${err?.message ?? String(err)}`,
        { cause: err }
      )
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    // Map latest state per operationId
    const opMap = new Map<string, RecoveryOperation>()

    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (parseErr: any) {
        throw new Error(
          `JOURNAL_CORRUPT: Malformed JSON line in journal for run ${runId}: ${parseErr?.message ?? String(parseErr)}`,
          { cause: parseErr }
        )
      }
      assertValidOperationRecord(parsed, runId)
      opMap.set(parsed.operationId, parsed)
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
