/**
 * Repository Discovery Service with Bounded Concurrency & Incremental Updates
 * Sprint 4D.1 — Tasks T-6102, T-6104, T-6115
 */

import { readdir, stat, realpath } from "node:fs/promises"
import { join, relative, extname } from "node:path"
import type { DiscoveryOptions, DiscoveryResult, FileMetadata } from "./contracts.ts"
import {
  CANONICAL_IGNORED_DIRECTORIES,
  isBinaryExtension,
  LARGE_FILE_THRESHOLD_BYTES,
} from "./ignore-policy.ts"
import { AsyncSemaphore } from "./semaphore.ts"
import { resolveRepositoryPath } from "../tools/path-safety.ts"

export class RepositoryDiscovery {
  readonly #workspaceRoot: string
  readonly #files = new Map<string, FileMetadata>()
  #lastDiscoveryResult?: DiscoveryResult

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot
  }

  get lastDiscoveryResult(): DiscoveryResult | undefined {
    return this.#lastDiscoveryResult
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot
  }

  get indexedCount(): number {
    return this.#files.size
  }

  get allFiles(): readonly FileMetadata[] {
    return Array.from(this.#files.values())
  }

  getFile(relativePath: string): FileMetadata | undefined {
    return this.#files.get(relativePath.replaceAll("\\", "/"))
  }

  hasFile(relativePath: string): boolean {
    return this.#files.has(relativePath.replaceAll("\\", "/"))
  }

  /**
   * Full discovery walk with bounded concurrency, ignore policies, and explicit metadata indexing.
   * Does NOT read file contents during discovery.
   */
  async discover(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
    const startTime = Date.now()
    const maxFiles = options.maxFiles ?? 100_000
    const maxConcurrency = options.maxConcurrency ?? 16
    const largeThreshold = options.largeFileThresholdBytes ?? LARGE_FILE_THRESHOLD_BYTES
    const ignoredDirs = new Set(options.ignoredDirectories ?? CANONICAL_IGNORED_DIRECTORIES)
    const semaphore = new AsyncSemaphore(maxConcurrency, { maxQueued: 2048 })

    const root = await realpath(this.#workspaceRoot)
    const discovered: FileMetadata[] = []

    let filesVisited = 0
    let directoriesVisited = 0
    let filesSkipped = 0
    let truncated = false

    const dirQueue: string[] = [root]

    while (dirQueue.length > 0) {
      if (options.signal?.aborted || truncated) break
      const dirPath = dirQueue.shift()!
      directoriesVisited++

      let entries
      try {
        entries = await readdir(dirPath, { withFileTypes: true })
      } catch {
        continue
      }

      entries.sort((a, b) => a.name.localeCompare(b.name))

      const filePaths: string[] = []
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue
        }
        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name)) {
            dirQueue.push(join(dirPath, entry.name))
          } else {
            filesSkipped++
          }
        } else if (entry.isFile()) {
          filePaths.push(join(dirPath, entry.name))
        }
      }

      // Process files in this directory with semaphore in bounded chunks
      const fileBatchSize = maxConcurrency * 4
      for (let i = 0; i < filePaths.length; i += fileBatchSize) {
        if (options.signal?.aborted || truncated) break
        const batch = filePaths.slice(i, i + fileBatchSize)
        await Promise.all(
          batch.map((fp) =>
            semaphore.run(async () => {
              if (options.signal?.aborted || truncated) return
              filesVisited++
              if (discovered.length >= maxFiles) {
                truncated = true
                return
              }

              try {
                const fileStat = await stat(fp)
                const rel = relative(root, fp).replaceAll("\\", "/")
                const ext = extname(rel)
                const isBinary = isBinaryExtension(ext)
                const isLarge = fileStat.size > largeThreshold

                const meta: FileMetadata = {
                  path: rel,
                  sizeBytes: fileStat.size,
                  mtimeMs: fileStat.mtimeMs,
                  extension: ext,
                  isBinary,
                  isLarge,
                }
                discovered.push(meta)
              } catch {
                filesSkipped++
              }
            }, options.signal),
          ),
        )
      }
    }

    // Sort discovered files for strictly deterministic ordering across runs and filesystems
    discovered.sort((a, b) => a.path.localeCompare(b.path))

    // Update in-memory index
    this.#files.clear()
    for (const f of discovered) {
      this.#files.set(f.path, f)
    }

    const result: DiscoveryResult = {
      files: discovered,
      filesVisited,
      directoriesVisited,
      filesIndexed: discovered.length,
      filesSkipped,
      contentBytesRead: 0, // Invariant: basic discovery reads 0 content bytes
      truncated,
      durationMs: Date.now() - startTime,
    }

    this.#lastDiscoveryResult = result
    return result
  }

  /**
   * Incremental addition or modification of a file without full repository rebuild.
   */
  async recordFileChange(relPath: string): Promise<FileMetadata | null> {
    const normalized = relPath.replaceAll("\\", "/")
    let absPath: string
    try {
      absPath = await resolveRepositoryPath(this.#workspaceRoot, normalized, "file")
    } catch {
      return null
    }

    const fileStat = await stat(absPath)
    const ext = extname(normalized)
    const isBinary = isBinaryExtension(ext)
    const isLarge = fileStat.size > LARGE_FILE_THRESHOLD_BYTES

    const meta: FileMetadata = {
      path: normalized,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      extension: ext,
      isBinary,
      isLarge,
    }

    this.#files.set(normalized, meta)
    return meta
  }

  /**
   * Incremental deletion of a file from index.
   */
  recordFileDelete(relPath: string): boolean {
    const normalized = relPath.replaceAll("\\", "/")
    return this.#files.delete(normalized)
  }

  /**
   * Process a storm of file system events with deduplication / coalescing.
   * If multiple events target the same path, only the final state is resolved.
   * Ensures repository index converges without full rescan.
   */
  async processEventStorm(
    events: ReadonlyArray<{ type: "add" | "modify" | "delete"; path: string }>,
  ): Promise<{
    readonly processedCount: number
    readonly coalescedCount: number
    readonly appliedChanges: number
    readonly appliedDeletions: number
  }> {
    const latestEventsByPath = new Map<string, "add" | "modify" | "delete">()
    for (const ev of events) {
      const norm = ev.path.replaceAll("\\", "/")
      latestEventsByPath.set(norm, ev.type)
    }

    let appliedChanges = 0
    let appliedDeletions = 0

    for (const [normPath, finalType] of latestEventsByPath.entries()) {
      if (finalType === "delete") {
        const deleted = this.recordFileDelete(normPath)
        if (deleted) appliedDeletions++
      } else {
        const meta = await this.recordFileChange(normPath)
        if (meta) appliedChanges++
      }
    }

    return {
      processedCount: events.length,
      coalescedCount: latestEventsByPath.size,
      appliedChanges,
      appliedDeletions,
    }
  }
}
