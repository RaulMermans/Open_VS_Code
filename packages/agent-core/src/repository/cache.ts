/**
 * Bounded LRU Cache
 * Sprint 4D — Large Repository Performance Hardening
 */

import type { CacheStats } from "./contracts.ts"

export interface BoundedLruCacheOptions<V> {
  readonly maxEntries?: number // default 500
  readonly maxBytes?: number // default 10MB
  readonly sizeCalculator?: (value: V) => number
}

export class BoundedLruCache<V> {
  readonly #entries = new Map<string, { value: V; bytes: number }>()
  readonly #maxEntries: number
  readonly #maxBytes: number
  readonly #sizeCalculator: (value: V) => number

  #retainedBytes = 0
  #hits = 0
  #misses = 0
  #evictions = 0

  constructor(options: BoundedLruCacheOptions<V> = {}) {
    this.#maxEntries = options.maxEntries ?? 500
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024
    this.#sizeCalculator =
      options.sizeCalculator ??
      ((v: V) => {
        if (typeof v === "string") return Buffer.byteLength(v, "utf8")
        if (Buffer.isBuffer(v)) return v.length
        return JSON.stringify(v).length
      })
  }

  get stats(): CacheStats {
    return {
      entries: this.#entries.size,
      maxEntries: this.#maxEntries,
      retainedBytes: this.#retainedBytes,
      maxBytes: this.#maxBytes,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
    }
  }

  get(key: string): V | undefined {
    const existing = this.#entries.get(key)
    if (!existing) {
      this.#misses++
      return undefined
    }
    this.#hits++
    // Refresh LRU order: delete and re-insert
    this.#entries.delete(key)
    this.#entries.set(key, existing)
    return existing.value
  }

  has(key: string): boolean {
    return this.#entries.has(key)
  }

  set(key: string, value: V): void {
    const bytes = this.#sizeCalculator(value)
    if (bytes > this.#maxBytes) {
      // Single value exceeds total cache budget; do not cache
      return
    }

    if (this.#entries.has(key)) {
      const prev = this.#entries.get(key)!
      this.#retainedBytes -= prev.bytes
      this.#entries.delete(key)
    }

    // Evict oldest entries until within constraints
    while (
      (this.#entries.size >= this.#maxEntries || this.#retainedBytes + bytes > this.#maxBytes) &&
      this.#entries.size > 0
    ) {
      const oldestKey = this.#entries.keys().next().value
      if (!oldestKey) break
      const oldestEntry = this.#entries.get(oldestKey)!
      this.#retainedBytes -= oldestEntry.bytes
      this.#entries.delete(oldestKey)
      this.#evictions++
    }

    this.#entries.set(key, { value, bytes })
    this.#retainedBytes += bytes
  }

  delete(key: string): boolean {
    const existing = this.#entries.get(key)
    if (!existing) return false
    this.#retainedBytes -= existing.bytes
    this.#entries.delete(key)
    return true
  }

  clear(): void {
    this.#entries.clear()
    this.#retainedBytes = 0
  }
}
