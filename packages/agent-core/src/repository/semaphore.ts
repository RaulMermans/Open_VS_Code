/**
 * Bounded Concurrency Semaphore with Bounded Waiting Queue
 * Sprint 4D.1 — Tasks T-6109 & T-6110
 */

export class SemaphoreQueueFullError extends Error {
  constructor(message = "Semaphore queue limit exceeded") {
    super(message)
    this.name = "SemaphoreQueueFullError"
  }
}

export type SemaphoreQueuePolicy = "reject" | "cancel_oldest"

export interface SemaphoreOptions {
  readonly maxQueued?: number
  readonly queuePolicy?: SemaphoreQueuePolicy
}

interface QueuedWaiter {
  resolve: () => void
  reject: (err: Error) => void
  onAbort?: () => void
  signal?: AbortSignal | undefined
}

export class AsyncSemaphore {
  readonly #maxConcurrency: number
  readonly #maxQueued: number
  readonly #queuePolicy: SemaphoreQueuePolicy
  #running = 0
  #peakRunning = 0
  #peakQueued = 0
  readonly #queue: QueuedWaiter[] = []

  constructor(
    maxConcurrency: number,
    options?: number | SemaphoreOptions,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new TypeError("maxConcurrency must be a positive integer")
    }
    this.#maxConcurrency = maxConcurrency

    if (typeof options === "number") {
      if (!Number.isInteger(options) || options <= 0) {
        throw new TypeError("maxQueued must be a positive integer")
      }
      this.#maxQueued = options
      this.#queuePolicy = "reject"
    } else {
      const q = options?.maxQueued ?? 1024
      if (!Number.isInteger(q) || q <= 0) {
        throw new TypeError("maxQueued must be a positive integer")
      }
      this.#maxQueued = q
      this.#queuePolicy = options?.queuePolicy ?? "reject"
    }
  }

  get maxConcurrency(): number {
    return this.#maxConcurrency
  }

  get maxQueued(): number {
    return this.#maxQueued
  }

  get queuePolicy(): SemaphoreQueuePolicy {
    return this.#queuePolicy
  }

  get running(): number {
    return this.#running
  }

  get queued(): number {
    return this.#queue.length
  }

  get peakRunning(): number {
    return this.#peakRunning
  }

  get peakQueued(): number {
    return this.#peakQueued
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Operation aborted")
    }
    if (this.#running < this.#maxConcurrency) {
      this.#running++
      if (this.#running > this.#peakRunning) {
        this.#peakRunning = this.#running
      }
      return
    }

    if (this.#queue.length >= this.#maxQueued) {
      if (this.#queuePolicy === "reject") {
        throw new SemaphoreQueueFullError(
          `QUEUE_OVERFLOW: Semaphore waiting queue limit (${this.#maxQueued}) exceeded`,
        )
      } else if (this.#queuePolicy === "cancel_oldest") {
        const oldest = this.#queue.shift()
        if (oldest) {
          if (oldest.signal && oldest.onAbort) {
            oldest.signal.removeEventListener("abort", oldest.onAbort)
          }
          oldest.reject(new Error("Superseded by newer queued task"))
        }
      }
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const waiter: QueuedWaiter = {
        resolve: () => {},
        reject: () => {},
      }

      const onAbort = () => {
        if (settled) return
        settled = true
        const idx = this.#queue.indexOf(waiter)
        if (idx !== -1) {
          this.#queue.splice(idx, 1)
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort)
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

      waiter.resolve = releaseWait
      waiter.reject = (err: Error) => {
        if (settled) return
        settled = true
        if (signal) {
          signal.removeEventListener("abort", onAbort)
        }
        reject(err)
      }
      waiter.onAbort = onAbort
      waiter.signal = signal

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true })
      }

      this.#queue.push(waiter)
      if (this.#queue.length > this.#peakQueued) {
        this.#peakQueued = this.#queue.length
      }
    })
  }

  release(): void {
    if (this.#queue.length > 0) {
      const next = this.#queue.shift()!
      next.resolve()
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
