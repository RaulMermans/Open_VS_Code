/**
 * Recovery Artifact Store
 * Sprint 4C — Local preimage storage, strict size bounds, safe rollback support
 * Never leaks raw preimages into analytics, model context, or prompts.
 */

import { readFile, writeFile, readdir, mkdir, stat, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { type RecoveryArtifactMetadata } from "./contracts.ts"
import { assertSafeStoragePath } from "./storage-path-safety.ts"

export interface RecoveryArtifactStoreOptions {
  readonly storageRoot: string
  readonly maxArtifactBytesPerRun?: number // default 64 MiB
  readonly maxIndividualPreimageBytes?: number // default 8 MiB
}

export class RecoveryArtifactStore {
  readonly #storageRoot: string
  readonly #maxArtifactBytesPerRun: number
  readonly #maxIndividualPreimageBytes: number

  constructor(options: RecoveryArtifactStoreOptions) {
    this.#storageRoot = options.storageRoot
    this.#maxArtifactBytesPerRun = options.maxArtifactBytesPerRun ?? 64 * 1024 * 1024
    this.#maxIndividualPreimageBytes = options.maxIndividualPreimageBytes ?? 8 * 1024 * 1024
  }

  get storageRoot(): string {
    return this.#storageRoot
  }

  async #getArtifactsDir(runId: string): Promise<string> {
    const dir = join(this.#storageRoot, "runs", runId, "artifacts")
    await assertSafeStoragePath(this.#storageRoot, dir)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Store original preimage for safe rollback
   * Returns metadata if stored, or null if bounded limit exceeded
   */
  async storePreimage(
    runId: string,
    operationId: string,
    targetFilePath: string,
    content: Buffer | string
  ): Promise<RecoveryArtifactMetadata | null> {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content
    if (buffer.length > this.#maxIndividualPreimageBytes) {
      return null
    }

    const currentTotalBytes = await this.getTotalArtifactBytes(runId)
    if (currentTotalBytes + buffer.length > this.#maxArtifactBytesPerRun) {
      return null
    }

    const dir = await this.#getArtifactsDir(runId)
    const hash = createHash("sha256").update(buffer).digest("hex")
    const artifactId = `art_${operationId}_${hash.slice(0, 12)}`
    const artifactFile = `${artifactId}.bin`
    const targetPath = join(dir, artifactFile)
    const metaFile = `${artifactId}.meta.json`
    const metaPath = join(dir, metaFile)

    await assertSafeStoragePath(this.#storageRoot, targetPath)
    await assertSafeStoragePath(this.#storageRoot, metaPath)

    await writeFile(targetPath, buffer)

    const meta: RecoveryArtifactMetadata = {
      artifactId,
      runId,
      operationId,
      path: targetFilePath,
      originalHash: hash,
      sizeBytes: buffer.length,
      createdAt: new Date().toISOString(),
      artifactType: "PREIMAGE",
    }

    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8")
    return meta
  }

  async getPreimage(runId: string, artifactId: string): Promise<Buffer | null> {
    const dir = await this.#getArtifactsDir(runId)
    const artifactFile = `${artifactId}.bin`
    const filePath = join(dir, artifactFile)
    try {
      await assertSafeStoragePath(this.#storageRoot, filePath)
      return await readFile(filePath)
    } catch {
      return null
    }
  }

  async getMetadata(runId: string, artifactId: string): Promise<RecoveryArtifactMetadata | null> {
    const dir = await this.#getArtifactsDir(runId)
    const metaFile = `${artifactId}.meta.json`
    const filePath = join(dir, metaFile)
    try {
      await assertSafeStoragePath(this.#storageRoot, filePath)
      const raw = await readFile(filePath, "utf8")
      return JSON.parse(raw) as RecoveryArtifactMetadata
    } catch {
      return null
    }
  }

  async findArtifactForOperation(
    runId: string,
    operationId: string
  ): Promise<RecoveryArtifactMetadata | null> {
    const dir = await this.#getArtifactsDir(runId)
    try {
      const files = await readdir(dir)
      const metaFiles = files.filter((f) => f.startsWith(`art_${operationId}_`) && f.endsWith(".meta.json"))
      const firstMeta = metaFiles[0]
      if (!firstMeta) return null
      const raw = await readFile(join(dir, firstMeta), "utf8")
      return JSON.parse(raw) as RecoveryArtifactMetadata
    } catch {
      return null
    }
  }

  async getTotalArtifactBytes(runId: string): Promise<number> {
    const dir = await this.#getArtifactsDir(runId)
    try {
      const files = await readdir(dir)
      let total = 0
      for (const f of files) {
        if (f.endsWith(".bin")) {
          const s = await stat(join(dir, f))
          total += s.size
        }
      }
      return total
    } catch {
      return 0
    }
  }

  async clearRun(runId: string): Promise<void> {
    const dir = join(this.#storageRoot, "runs", runId, "artifacts")
    await assertSafeStoragePath(this.#storageRoot, dir)
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
