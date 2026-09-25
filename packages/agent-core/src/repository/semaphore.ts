/**
 * Bounded Concurrency Semaphore
 * Sprint 4D — Large Repository Performance Hardening
 */

export class AsyncSemaphore {
  readonly #maxConcurrency: number
  #running = 0
  readonly #queue: Array<() => void> = []

  constructor(maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new TypeError("maxConcurrency must be a positive integer")
    }
    this.#maxConcurrency = maxConcurrency
  }

  get maxConcurrency(): number {
    return this.#maxConcurrency
  }

  get running(): number {
    return this.#running
  }

  get queued(): number {
    return this.#queue.length
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Operation aborted")
    }
    if (this.#running < this.#maxConcurrency) {
      this.#running++
      return
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const onAbort = () => {
        if (settled) return
        settled = true
        const idx = this.#queue.indexOf(releaseWait)
        if (idx !== -1) {
          this.#queue.splice(idx, 1)
        }
        reject(new Error("Operation aborted"))
      }

      const releaseWait = () => {
        if (settled) return
        settled = true
        if (signal) {
          signal.removeEventListener("abort", onAbort)
        }
        resolve()
      }

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true })
      }
      this.#queue.push(releaseWait)
    })
  }

  release(): void {
    if (this.#queue.length > 0) {
      const next = this.#queue.shift()!
      next()
    } else {
      this.#running = Math.max(0, this.#running - 1)
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      if (signal?.aborted) {
        throw new Error("Operation aborted")
      }
      return await fn()
    } finally {
      this.release()
    }
  }
}
