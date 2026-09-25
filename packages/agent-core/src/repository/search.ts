/**
 * Bounded Targeted Repository Search
 * Sprint 4D — Large Repository Performance Hardening
 */

import { readFile } from "node:fs/promises"
import { resolveRepositoryPath } from "../tools/path-safety.ts"
import { isProbablyBinary } from "../tools/read-file.ts"
import type { FileMetadata, SearchMatch, SearchOptions, SearchResult } from "./contracts.ts"
import { AsyncSemaphore } from "./semaphore.ts"
import { BoundedLruCache } from "./cache.ts"

export class RepositorySearch {
  readonly #workspaceRoot: string
  readonly #fileCache: BoundedLruCache<string> | undefined

  constructor(workspaceRoot: string, options?: { fileCache?: BoundedLruCache<string> }) {
    this.#workspaceRoot = workspaceRoot
    this.#fileCache = options?.fileCache
  }

  /**
   * Search query over candidate files with explicit caps:
   * - maxResults (default 50)
   * - maxMatchesPerFile (default 5)
   * - maxSnippetChars (default 300)
   * - maxTotalPayloadBytes (default 32KB)
   * - skips binary and overly large files from whole scans
   */
  async search(
    files: readonly FileMetadata[],
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    const startTime = Date.now()
    const maxResults = options.maxResults ?? 50
    const maxMatchesPerFile = options.maxMatchesPerFile ?? 5
    const maxSnippetChars = options.maxSnippetChars ?? 300
    const maxTotalPayloadBytes = options.maxTotalPayloadBytes ?? 32 * 1024
    const maxConcurrency = options.maxConcurrency ?? 8
    const semaphore = new AsyncSemaphore(maxConcurrency)

    const needle = query.toLowerCase()
    const matches: SearchMatch[] = []

    let totalMatchesFound = 0
    let filesScanned = 0
    let filesSkipped = 0
    let bytesRead = 0
    let payloadBytes = 0
    let truncated = false

    // Filter files by rootPath if specified
    const targetFiles = options.rootPath
      ? files.filter((f) => f.path.startsWith(options.rootPath!))
      : files

    for (const file of targetFiles) {
      if (options.signal?.aborted || truncated) break

      // Skip binary files and giant files from broad search
      if (file.isBinary || file.isLarge) {
        filesSkipped++
        continue
      }

      await semaphore.run(async () => {
        if (options.signal?.aborted || truncated) return

        let content = this.#fileCache?.get(file.path)
        if (content === undefined) {
          try {
            const absPath = await resolveRepositoryPath(this.#workspaceRoot, file.path, "file")
            const rawBytes = await readFile(absPath)
            bytesRead += rawBytes.length

            if (isProbablyBinary(file.path, rawBytes)) {
              filesSkipped++
              return
            }

            content = rawBytes.toString("utf8")
            this.#fileCache?.set(file.path, content)
          } catch {
            filesSkipped++
            return
          }
        }

        filesScanned++
        const lines = content.split(/\r?\n/)
        let fileMatches = 0

        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx]!
          if (!line.toLowerCase().includes(needle)) continue

          totalMatchesFound++
          if (fileMatches >= maxMatchesPerFile) {
            // Per-file match diversity cap reached
            continue
          }

          const snippet = line.slice(0, maxSnippetChars)
          const matchBytes = Buffer.byteLength(file.path, "utf8") + Buffer.byteLength(snippet, "utf8")

          if (matches.length >= maxResults || payloadBytes + matchBytes > maxTotalPayloadBytes) {
            truncated = true
            return
          }

          matches.push({
            path: file.path,
            line: idx + 1,
            text: snippet,
          })
          payloadBytes += matchBytes
          fileMatches++
        }
      }, options.signal)
    }

    return {
      matches,
      truncated,
      totalMatchesFound,
      filesScanned,
      filesSkipped,
      bytesRead,
      durationMs: Date.now() - startTime,
    }
  }
}
