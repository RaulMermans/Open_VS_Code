/**
 * Checkpoint Store
 * Sprint 4C — Atomic persistence, monotonic sequence, SHA-256 integrity, schema validation, retention
 */

import { readFile, writeFile, rename, readdir, unlink, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointRecord,
} from "./contracts.ts"
import { assertSafeStoragePath } from "./storage-path-safety.ts"

export class CheckpointStoreError extends Error {
  readonly code:
    | "CORRUPT_CHECKPOINT"
    | "UNSUPPORTED_CHECKPOINT_VERSION"
    | "CHECKPOINT_NOT_FOUND"
    | "INTEGRITY_CHECK_FAILED"
    | "STORAGE_ERROR"

  constructor(
    code:
      | "CORRUPT_CHECKPOINT"
      | "UNSUPPORTED_CHECKPOINT_VERSION"
      | "CHECKPOINT_NOT_FOUND"
      | "INTEGRITY_CHECK_FAILED"
      | "STORAGE_ERROR",
    message: string
  ) {
    super(message)
    this.name = "CheckpointStoreError"
    this.code = code
  }
}

import { canonicalSerialize } from "./canonical-serializer.ts"

export function computeCheckpointChecksum(recordWithoutChecksum: Omit<CheckpointRecord, "checksum">): string {
  const serialized = canonicalSerialize(recordWithoutChecksum)
  return createHash("sha256").update(serialized, "utf8").digest("hex")
}

export interface CheckpointStoreOptions {
  readonly storageRoot: string
  readonly maxCheckpoints?: number | undefined // default 50
}

export class CheckpointStore {
  readonly #storageRoot: string
  readonly #maxCheckpoints: number

  constructor(options: CheckpointStoreOptions) {
    this.#storageRoot = options.storageRoot
    this.#maxCheckpoints = options.maxCheckpoints ?? 50
  }

  get storageRoot(): string {
    return this.#storageRoot
  }

  async #getRunDir(runId: string): Promise<string> {
    const runDir = join(this.#storageRoot, "runs", runId, "checkpoints")
    await assertSafeStoragePath(this.#storageRoot, runDir)
    await mkdir(runDir, { recursive: true })
    return runDir
  }

  async saveCheckpoint(
    recordWithoutChecksum: Omit<CheckpointRecord, "checksum">
  ): Promise<CheckpointRecord> {
    if (recordWithoutChecksum.schemaVersion > CHECKPOINT_SCHEMA_VERSION) {
      throw new CheckpointStoreError(
        "UNSUPPORTED_CHECKPOINT_VERSION",
        `Unsupported checkpoint schema version: ${recordWithoutChecksum.schemaVersion} (supported <= ${CHECKPOINT_SCHEMA_VERSION})`
      )
    }

    const checksum = computeCheckpointChecksum(recordWithoutChecksum)
    const record: CheckpointRecord = {
      ...recordWithoutChecksum,
      checksum,
    }

    const runDir = await this.#getRunDir(record.runId)
    const seqStr = String(record.sequence).padStart(8, "0")
    const fileName = `cp_${seqStr}_${record.checkpointId}.json`
    const targetPath = join(runDir, fileName)
    const tempPath = `${targetPath}.tmp.${Date.now()}`
    const headPath = join(runDir, "HEAD.json")
    const headTempPath = `${headPath}.tmp.${Date.now()}`

    await assertSafeStoragePath(this.#storageRoot, targetPath)

    const content = JSON.stringify(record, null, 2)

    // 1. Atomic write to temp file
    await writeFile(tempPath, content, "utf8")
    // 2. Rename atomically
    await rename(tempPath, targetPath)

    // 3. Atomically update HEAD pointer
    const headPointer = {
      latestCheckpointId: record.checkpointId,
      sequence: record.sequence,
      fileName,
      checksum,
    }
    await writeFile(headTempPath, JSON.stringify(headPointer, null, 2), "utf8")
    await rename(headTempPath, headPath)

    // 4. Bounded retention enforcement
    await this.#prune(record.runId)

    return record
  }

  async getLatestCheckpoint(runId: string): Promise<CheckpointRecord | null> {
    const runDir = await this.#getRunDir(runId)
    const headPath = join(runDir, "HEAD.json")
    let headData: { fileName: string } | null = null
    try {
      const headRaw = await readFile(headPath, "utf8")
      headData = JSON.parse(headRaw)
    } catch {
      // No HEAD file or corrupt HEAD, try finding highest sequence file
      const files = await this.#listCheckpointFiles(runId)
      if (files.length === 0) return null
      const latestFile = files[files.length - 1]
      if (!latestFile) return null
      return this.#readCheckpointFile(runId, latestFile)
    }

    if (headData?.fileName) {
      try {
        return await this.#readCheckpointFile(runId, headData.fileName)
      } catch (err) {
        if (err instanceof CheckpointStoreError && err.code === "UNSUPPORTED_CHECKPOINT_VERSION") {
          throw err
        }
        // Fall back to safely scanning valid checkpoint history backwards
      }
    }

    const files = await this.#listCheckpointFiles(runId)
    if (files.length === 0) return null

    // Scan backwards from highest sequence file to find the latest valid checkpoint
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i]!
      try {
        return await this.#readCheckpointFile(runId, file)
      } catch {
        // If file is corrupt or checksum failed, keep looking backwards for latest valid checkpoint
        continue
      }
    }

    return null
  }

  async getCheckpointById(runId: string, checkpointId: string): Promise<CheckpointRecord | null> {
    const files = await this.#listCheckpointFiles(runId)
    const matched = files.find((f) => f.includes(`_${checkpointId}.json`))
    if (!matched) return null
    return this.#readCheckpointFile(runId, matched)
  }

  async listCheckpoints(runId: string): Promise<readonly CheckpointRecord[]> {
    const files = await this.#listCheckpointFiles(runId)
    const records: CheckpointRecord[] = []
    for (const f of files) {
      records.push(await this.#readCheckpointFile(runId, f))
    }
    return records
  }

  async #readCheckpointFile(runId: string, fileName: string): Promise<CheckpointRecord> {
    const runDir = await this.#getRunDir(runId)
    const filePath = join(runDir, fileName)
    await assertSafeStoragePath(this.#storageRoot, filePath)

    let raw: string
    try {
      raw = await readFile(filePath, "utf8")
    } catch {
      throw new CheckpointStoreError("CHECKPOINT_NOT_FOUND", `Checkpoint file not found: ${fileName}`)
    }

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new CheckpointStoreError("CORRUPT_CHECKPOINT", `Failed to parse checkpoint JSON in ${fileName}: ${(e as Error).message}`)
    }

    if (!parsed || typeof parsed !== "object" || !parsed.checksum || typeof parsed.schemaVersion !== "number") {
      throw new CheckpointStoreError("CORRUPT_CHECKPOINT", `Checkpoint missing required fields in ${fileName}`)
    }

    if (parsed.schemaVersion > CHECKPOINT_SCHEMA_VERSION) {
      throw new CheckpointStoreError(
        "UNSUPPORTED_CHECKPOINT_VERSION",
        `Unsupported schema version ${parsed.schemaVersion} in ${fileName}`
      )
    }

    const { checksum, ...rest } = parsed
    const expectedChecksum = computeCheckpointChecksum(rest)
    if (checksum !== expectedChecksum) {
      throw new CheckpointStoreError(
        "INTEGRITY_CHECK_FAILED",
        `Checksum mismatch for ${fileName}. Expected: ${expectedChecksum}, got: ${checksum}`
      )
    }

    return parsed as CheckpointRecord
  }

  async #listCheckpointFiles(runId: string): Promise<string[]> {
    const runDir = await this.#getRunDir(runId)
    try {
      const entries = await readdir(runDir)
      return entries
        .filter((e) => e.startsWith("cp_") && e.endsWith(".json"))
        .toSorted()
    } catch {
      return []
    }
  }

  async #prune(runId: string): Promise<void> {
    const files = await this.#listCheckpointFiles(runId)
    if (files.length <= this.#maxCheckpoints) return

    const excessCount = files.length - this.#maxCheckpoints
    const toDelete = files.slice(0, excessCount)
    const runDir = await this.#getRunDir(runId)

    for (const f of toDelete) {
      try {
        await unlink(join(runDir, f))
      } catch {
        // ignore deletion failure during prune
      }
    }
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
