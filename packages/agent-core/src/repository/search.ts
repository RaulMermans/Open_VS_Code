/**
 * Bounded Targeted Repository Search with Bounded Concurrency & Backpressure
 * Sprint 4D.1 — Tasks T-6111 through T-6114
 */

import { readFile } from "node:fs/promises"
import { resolveRepositoryPath } from "../tools/path-safety.ts"
import { isProbablyBinary } from "../tools/read-file.ts"
import type { FileMetadata, SearchMatch, SearchOptions, SearchResult } from "./contracts.ts"
import { AsyncSemaphore } from "./semaphore.ts"
import { BoundedLruCache } from "./cache.ts"

interface FileScanOutcome {
  readonly matches: SearchMatch[]
  readonly bytesRead: number
  readonly matchesFound: number
  readonly wasSkipped: boolean
  readonly wasScanned: boolean
}

export class RepositorySearch {
  readonly #workspaceRoot: string
  readonly #fileCache: BoundedLruCache<string> | undefined
  readonly #inFlight = new Map<string, Promise<SearchResult>>()

  constructor(workspaceRoot: string, options?: { fileCache?: BoundedLruCache<string> }) {
    this.#workspaceRoot = workspaceRoot
    this.#fileCache = options?.fileCache
  }

  /**
   * Search query over candidate files with explicit caps and bounded concurrency:
   * - maxResults (default 50)
   * - maxMatchesPerFile (default 5)
   * - maxSnippetChars (default 300)
   * - maxTotalPayloadBytes (default 32KB)
   * - maxConcurrency (default 8)
   * - maxQueued (default 64)
   * - skips binary and overly large files from whole scans
   * - deterministic match ordering by candidate file order
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
    const maxQueued = options.maxQueued ?? 64

    const semaphore = new AsyncSemaphore(maxConcurrency, { maxQueued })
    const internalAbort = new AbortController()

    const onExternalAbort = () => {
      internalAbort.abort()
    }
    if (options.signal) {
      if (options.signal.aborted) {
        internalAbort.abort()
      } else {
        options.signal.addEventListener("abort", onExternalAbort, { once: true })
      }
    }

    const needle = query.toLowerCase()
    const matches: SearchMatch[] = []

    let totalMatchesFound = 0
    let filesScanned = 0
    let filesSkipped = 0
    let bytesRead = 0
    let payloadBytes = 0
    let truncated = false

    let filesStarted = 0
    let filesCompleted = 0
    let filesCancelled = 0

    // Filter files by rootPath if specified
    const targetFiles = options.rootPath
      ? files.filter((f) => f.path.startsWith(options.rootPath!))
      : files

    const eligibleFiles: Array<{ file: FileMetadata; originalIndex: number }> = []
    for (let i = 0; i < targetFiles.length; i++) {
      const file = targetFiles[i]!
      if (file.isBinary || file.isLarge) {
        filesSkipped++
      } else {
        eligibleFiles.push({ file, originalIndex: i })
      }
    }

    // Map to hold results per candidate file index for deterministic in-order committing
    const resultsByIndex = new Map<number, FileScanOutcome>()
    let commitIndex = 0

    const tryCommitResults = () => {
      while (commitIndex < eligibleFiles.length && resultsByIndex.has(commitIndex)) {
        const outcome = resultsByIndex.get(commitIndex)!
        resultsByIndex.delete(commitIndex)

        if (outcome.wasScanned) {
          filesScanned++
          bytesRead += outcome.bytesRead
          totalMatchesFound += outcome.matchesFound

          for (const m of outcome.matches) {
            const matchBytes = Buffer.byteLength(m.path, "utf8") + Buffer.byteLength(m.text, "utf8")
            if (matches.length >= maxResults || payloadBytes + matchBytes > maxTotalPayloadBytes) {
              truncated = true
              internalAbort.abort()
              break
            }
            matches.push(m)
            payloadBytes += matchBytes
          }
        } else if (outcome.wasSkipped) {
          filesSkipped++
          bytesRead += outcome.bytesRead
        }

        commitIndex++
        if (truncated) break
      }
    }

    // Worker feeder with bounded in-flight work: at most (maxConcurrency + queueBuffer) tasks in flight
    const queueBuffer = Math.min(maxQueued, 16)
    const inFlightPromises = new Set<Promise<void>>()
    let nextIndex = 0

    try {
      while (
        nextIndex < eligibleFiles.length &&
        !internalAbort.signal.aborted
      ) {
        tryCommitResults()
        if (truncated) break

        if (inFlightPromises.size >= maxConcurrency + queueBuffer) {
          await Promise.race(inFlightPromises)
          tryCommitResults()
          if (truncated || internalAbort.signal.aborted) break
        }

        const candidate = eligibleFiles[nextIndex]!
        const fileIdx = nextIndex++
        const file = candidate.file
        filesStarted++

        const taskPromise = (async () => {
          try {
            await semaphore.run(async () => {
              if (internalAbort.signal.aborted || truncated) {
                filesCancelled++
                return
              }

              let content = this.#fileCache?.get(file.path)
              let fileBytesRead = 0

              if (content === undefined) {
                try {
                  const absPath = await resolveRepositoryPath(this.#workspaceRoot, file.path, "file")
                  const rawBytes = await readFile(absPath)
                  fileBytesRead = rawBytes.length

                  if (isProbablyBinary(file.path, rawBytes)) {
                    resultsByIndex.set(fileIdx, {
                      matches: [],
                      bytesRead: fileBytesRead,
                      matchesFound: 0,
                      wasSkipped: true,
                      wasScanned: false,
                    })
                    filesCompleted++
                    return
                  }

                  content = rawBytes.toString("utf8")
                  this.#fileCache?.set(file.path, content)
                } catch {
                  resultsByIndex.set(fileIdx, {
                    matches: [],
                    bytesRead: fileBytesRead,
                    matchesFound: 0,
                    wasSkipped: true,
                    wasScanned: false,
                  })
                  filesCompleted++
                  return
                }
              }

              const lines = content.split(/\r?\n/)
              const fileMatches: SearchMatch[] = []
              let matchesFoundInFile = 0

              for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const line = lines[lineIdx]!
                if (!line.toLowerCase().includes(needle)) continue

                matchesFoundInFile++
                if (fileMatches.length >= maxMatchesPerFile) continue

                const snippet = line.slice(0, maxSnippetChars)
                fileMatches.push({
                  path: file.path,
                  line: lineIdx + 1,
                  text: snippet,
                })
              }

              resultsByIndex.set(fileIdx, {
                matches: fileMatches,
                bytesRead: fileBytesRead,
                matchesFound: matchesFoundInFile,
                wasSkipped: false,
                wasScanned: true,
              })
              filesCompleted++
            }, internalAbort.signal)
          } catch (err: unknown) {
            filesCancelled++
            if (err instanceof Error && err.message.includes("aborted")) {
              // Aborted task cleanly handled
            }
          }
        })()

        const tracked = taskPromise.finally(() => {
          inFlightPromises.delete(tracked)
        })
        inFlightPromises.add(tracked)
      }

      // Wait for all active tasks to settle
      if (inFlightPromises.size > 0) {
        await Promise.allSettled(Array.from(inFlightPromises))
      }

      // Final commit of remaining in-order results
      tryCommitResults()
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onExternalAbort)
      }
    }

    return {
      matches,
      truncated,
      totalMatchesFound,
      filesScanned,
      filesSkipped,
      bytesRead,
      durationMs: Date.now() - startTime,
      peakActive: semaphore.peakRunning,
      peakQueued: semaphore.peakQueued,
      filesStarted,
      filesCompleted,
      filesCancelled,
    }
  }

  /**
   * Coalesced search: multiple rapid identical search calls share one in-flight execution.
   */
  async searchCoalesced(
    files: readonly FileMetadata[],
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    const key = `${query}::${options.rootPath ?? ""}::${options.maxResults ?? 50}`
    const existing = this.#inFlight.get(key)
    if (existing) {
      return existing
    }

    const promise = this.search(files, query, options).finally(() => {
      this.#inFlight.delete(key)
    })
    this.#inFlight.set(key, promise)
    return promise
  }
}

/**
 * SearchCoordinator manages search sessions under rapid request storms,
 * ensuring stale searches are cancelled and newer searches succeed.
 */
export class SearchCoordinator {
  readonly #searchEngine: RepositorySearch
  #activeController: AbortController | undefined

  constructor(searchEngine: RepositorySearch) {
    this.#searchEngine = searchEngine
  }

  get searchEngine(): RepositorySearch {
    return this.#searchEngine
  }

  async searchLatest(
    files: readonly FileMetadata[],
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    if (this.#activeController) {
      this.#activeController.abort()
    }
    const ac = new AbortController()
    this.#activeController = ac

    const signal = options.signal
      ? AbortSignal.any([options.signal, ac.signal])
      : ac.signal

    try {
      return await this.#searchEngine.search(files, query, { ...options, signal })
    } finally {
      if (this.#activeController === ac) {
        this.#activeController = undefined
      }
    }
  }
}
