/**
 * Repository Contracts & Types
 * Sprint 4D.1 — Performance & Large-Repository Hardening
 */

export interface FileMetadata {
  readonly path: string // workspace-relative path (forward slashes)
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly extension: string
  readonly isBinary: boolean
  readonly isLarge: boolean
}

export interface DiscoveryOptions {
  readonly maxFiles?: number // default 100,000
  readonly maxConcurrency?: number // default 16
  readonly ignoredDirectories?: readonly string[]
  readonly largeFileThresholdBytes?: number // default 128KB
  readonly signal?: AbortSignal
}

export interface DiscoveryResult {
  readonly files: readonly FileMetadata[]
  readonly filesVisited: number
  readonly directoriesVisited: number
  readonly filesIndexed: number
  readonly filesSkipped: number
  readonly contentBytesRead: number
  readonly truncated: boolean
  readonly durationMs: number
}

export interface SearchOptions {
  readonly maxResults?: number // default 50
  readonly maxMatchesPerFile?: number // default 5
  readonly maxSnippetChars?: number // default 300
  readonly maxTotalPayloadBytes?: number // default 32KB
  readonly maxConcurrency?: number // default 8
  readonly maxQueued?: number // default 64
  readonly rootPath?: string
  readonly signal?: AbortSignal
}

export interface SearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface SearchResult {
  readonly matches: readonly SearchMatch[]
  readonly truncated: boolean
  readonly totalMatchesFound: number
  readonly filesScanned: number
  readonly filesSkipped: number
  readonly bytesRead: number
  readonly durationMs: number
  readonly peakActive?: number
  readonly peakQueued?: number
  readonly filesStarted?: number
  readonly filesCompleted?: number
  readonly filesCancelled?: number
}

export interface CacheStats {
  readonly entries: number
  readonly maxEntries: number
  readonly retainedBytes: number
  readonly maxBytes: number
  readonly hits: number
  readonly misses: number
  readonly evictions: number
}
