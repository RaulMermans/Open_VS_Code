/**
 * ModelPerformanceLedger — Sprint 4E.
 *
 * Stores BOUNDED AGGREGATE runtime outcome evidence keyed by:
 *   - deploymentId (the deployment that served the task)
 *   - taskClass (general, coding, debugging, autocomplete, ...)
 *
 * Privacy guarantees:
 *   - Raw source code is NEVER stored.
 *   - Prompt bodies are NEVER stored.
 *   - Terminal contents are NEVER stored.
 *   - Secrets are NEVER stored.
 *   - Only metrics (counts, rates, timing) are stored.
 *
 * Boundedness:
 *   - Profile storage is bounded: max profiles = maxDeployments × maxTaskClasses.
 *   - Each profile uses rolling EMA for latency (no unbounded list).
 *   - No per-task-instance records are retained.
 *
 * Adaptive routing:
 *   - Profiles influence routing ONLY after minimumSamples are collected.
 *   - Evidence adjustment is bounded: ±maxAdjustment.
 *   - Hysteresis: routing changes require scoreDelta > hysteresisThreshold.
 *   - Static routing remains the fallback when evidence is insufficient.
 *
 * Non-self-modifying:
 *   - Profiles may modify routing preferences only.
 *   - They CANNOT modify permissions, source code, or model weights.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { dirname } from "node:path"
import type { TaskClass } from "../contracts/routing.ts"

export const LEDGER_SCHEMA_VERSION = 2

/** Agent task outcome record — metrics only, no source or prompt text. */
export interface AgentOutcomeRecord {
  readonly deploymentId: string
  readonly taskClass: TaskClass
  /** Quality success: runtimeCompleted AND verificationSuccess AND toolCallSuccess. */
  readonly success: boolean
  /** Did the agent reach normal terminal completion? */
  readonly runtimeCompleted?: boolean
  /** Explicit quality success indicator. */
  readonly qualitySuccess?: boolean
  readonly verificationSuccess: boolean
  readonly toolCallSuccess: boolean
  readonly repairCycles: number
  readonly timeoutOccurred: boolean
  readonly cancellationOccurred: boolean
  /** Latency in milliseconds for the complete task. */
  readonly latencyMs: number
}

/** FIM/autocomplete outcome record — metrics only. */
export interface AutocompleteOutcomeRecord {
  readonly deploymentId: string
  readonly shown: boolean
  readonly accepted: boolean
  readonly staleDiscarded: boolean
  readonly emptyCompletion: boolean
  readonly cancelled: boolean
  readonly failed?: boolean
  readonly latencyMs: number
}

/** Per-deployment, per-task-class aggregate profile. */
export interface ModelDeploymentProfile {
  readonly deploymentId: string
  readonly taskClass: TaskClass | "autocomplete"
  sampleCount: number
  successCount: number
  failureCount: number
  runtimeCompletedCount?: number
  verificationSuccessCount: number
  toolCallSuccessCount: number
  totalRepairCycles: number
  timeoutCount: number
  cancellationCount: number
  /** Exponential moving average latency (ms). Alpha = 0.2. */
  emaLatencyMs: number
  /** Autocomplete-specific metrics. */
  autocomplete?: {
    shown: number
    accepted: number
    staleDiscarded: number
    empty: number
    cancelled: number
    failed?: number
    emaLatencyMs: number
  }
}

/** Serialized form stored to disk. */
export interface LedgerStore {
  readonly schemaVersion: number
  readonly profiles: readonly ModelDeploymentProfile[]
  readonly lastUpdated: string
}

/** Routing score adjustment — bounded, inspectable, resettable. */
export interface RoutingScoreAdjustment {
  readonly deploymentId: string
  readonly taskClass: TaskClass | "autocomplete"
  /** Score delta relative to static priority. Bounded to [-1.0, +1.0]. */
  readonly adjustment: number
  readonly sampleCount: number
  readonly reason: string
}

export interface LedgerOptions {
  /**
   * Path to the JSON file where profiles are persisted.
   * If undefined, the ledger operates in-memory only.
   */
  readonly persistPath?: string
  /**
   * Minimum samples before evidence influences routing.
   * Default: 5.
   */
  readonly minimumSamples?: number
  /**
   * Maximum magnitude of routing score adjustment.
   * Default: 0.5.
   */
  readonly maxAdjustment?: number
  /**
   * Minimum score delta before routing preference changes.
   * Prevents flapping between close candidates.
   * Default: 0.1.
   */
  readonly hysteresisThreshold?: number
  /**
   * When true, adaptive routing adjustments are disabled.
   * Routing falls back to static priority.
   * Default: false.
   */
  readonly adaptiveRoutingDisabled?: boolean
  /**
   * Maximum number of deployment profiles to retain.
   * Prevents unbounded growth.
   * Default: 50.
   */
  readonly maxProfiles?: number
}

const EMA_ALPHA = 0.2

function updateEma(current: number, sample: number): number {
  return current === 0 ? sample : current * (1 - EMA_ALPHA) + sample * EMA_ALPHA
}

function profileKey(deploymentId: string, taskClass: string): string {
  return `${deploymentId}::${taskClass}`
}

/** Process-local write serialization queue per ledger persistence path. */
const persistQueuesByPath = new Map<string, Promise<void>>()

interface ProfileDelta {
  sampleCount: number
  successCount: number
  failureCount: number
  runtimeCompletedCount: number
  verificationSuccessCount: number
  toolCallSuccessCount: number
  totalRepairCycles: number
  timeoutCount: number
  cancellationCount: number
  latencies: number[]
  autocomplete?: {
    shown: number
    accepted: number
    staleDiscarded: number
    empty: number
    cancelled: number
    failed: number
    latencies: number[]
  }
}

/**
 * ModelPerformanceLedger: bounded, privacy-preserving model outcome store.
 */
export class ModelPerformanceLedger {
  readonly #profiles = new Map<string, ModelDeploymentProfile>()
  readonly #deltas = new Map<string, ProfileDelta>()
  readonly #options: Required<LedgerOptions>
  readonly #readyPromise: Promise<void>
  #initialLoadPromise: Promise<{ loaded: boolean; resetDueToCorruption: boolean }> | null = null
  #loadCount = 0

  constructor(options: LedgerOptions = {}) {
    this.#options = {
      persistPath: options.persistPath ?? "",
      minimumSamples: options.minimumSamples ?? 5,
      maxAdjustment: options.maxAdjustment ?? 0.5,
      hysteresisThreshold: options.hysteresisThreshold ?? 0.1,
      adaptiveRoutingDisabled: options.adaptiveRoutingDisabled ?? false,
      maxProfiles: options.maxProfiles ?? 50,
    }
    if (this.#options.persistPath) {
      this.#readyPromise = this.load().then(() => {}, () => {})
    } else {
      this.#readyPromise = Promise.resolve()
    }
  }

  /** Resolves when initial load from disk (if configured) has finished. */
  get ready(): Promise<void> {
    return this.#readyPromise
  }

  /** Total load invocations executed by this ledger instance (for testing). */
  get loadCount(): number {
    return this.#loadCount
  }

  /** Record an agent task outcome. Never stores source code or prompt text. */
  recordAgentOutcome(record: AgentOutcomeRecord): void {
    const key = profileKey(record.deploymentId, record.taskClass)
    let profile = this.#profiles.get(key)
    if (!profile) {
      if (this.#profiles.size >= this.#options.maxProfiles) {
        // Bounded: evict oldest (first inserted) profile
        const firstKey = this.#profiles.keys().next().value
        if (firstKey) this.#profiles.delete(firstKey)
      }
      profile = {
        deploymentId: record.deploymentId,
        taskClass: record.taskClass,
        sampleCount: 0,
        successCount: 0,
        failureCount: 0,
        runtimeCompletedCount: 0,
        verificationSuccessCount: 0,
        toolCallSuccessCount: 0,
        totalRepairCycles: 0,
        timeoutCount: 0,
        cancellationCount: 0,
        emaLatencyMs: 0,
      }
    }

    const qualitySuccess = record.qualitySuccess !== undefined ? record.qualitySuccess : record.success
    const runtimeCompleted = record.runtimeCompleted !== undefined ? record.runtimeCompleted : record.success

    const updated: ModelDeploymentProfile = {
      ...profile,
      sampleCount: profile.sampleCount + 1,
      successCount: profile.successCount + (qualitySuccess ? 1 : 0),
      failureCount: profile.failureCount + (qualitySuccess ? 0 : 1),
      runtimeCompletedCount: (profile.runtimeCompletedCount ?? 0) + (runtimeCompleted ? 1 : 0),
      verificationSuccessCount: profile.verificationSuccessCount + (record.verificationSuccess ? 1 : 0),
      toolCallSuccessCount: profile.toolCallSuccessCount + (record.toolCallSuccess ? 1 : 0),
      totalRepairCycles: profile.totalRepairCycles + record.repairCycles,
      timeoutCount: profile.timeoutCount + (record.timeoutOccurred ? 1 : 0),
      cancellationCount: profile.cancellationCount + (record.cancellationOccurred ? 1 : 0),
      emaLatencyMs: updateEma(profile.emaLatencyMs, record.latencyMs),
    }
    this.#profiles.set(key, updated)

    // Accumulate delta for safe concurrent persistence merging
    let delta = this.#deltas.get(key)
    if (!delta) {
      delta = {
        sampleCount: 0,
        successCount: 0,
        failureCount: 0,
        runtimeCompletedCount: 0,
        verificationSuccessCount: 0,
        toolCallSuccessCount: 0,
        totalRepairCycles: 0,
        timeoutCount: 0,
        cancellationCount: 0,
        latencies: [],
      }
      this.#deltas.set(key, delta)
    }
    delta.sampleCount += 1
    delta.successCount += qualitySuccess ? 1 : 0
    delta.failureCount += qualitySuccess ? 0 : 1
    delta.runtimeCompletedCount += runtimeCompleted ? 1 : 0
    delta.verificationSuccessCount += record.verificationSuccess ? 1 : 0
    delta.toolCallSuccessCount += record.toolCallSuccess ? 1 : 0
    delta.totalRepairCycles += record.repairCycles
    delta.timeoutCount += record.timeoutOccurred ? 1 : 0
    delta.cancellationCount += record.cancellationOccurred ? 1 : 0
    delta.latencies.push(record.latencyMs)
  }

  /** Record an autocomplete/FIM outcome. Never stores completion text. */
  recordAutocompleteOutcome(record: AutocompleteOutcomeRecord): void {
    const key = profileKey(record.deploymentId, "autocomplete")
    let profile = this.#profiles.get(key)
    if (!profile) {
      if (this.#profiles.size >= this.#options.maxProfiles) {
        const firstKey = this.#profiles.keys().next().value
        if (firstKey) this.#profiles.delete(firstKey)
      }
      profile = {
        deploymentId: record.deploymentId,
        taskClass: "autocomplete",
        sampleCount: 0,
        successCount: 0,
        failureCount: 0,
        verificationSuccessCount: 0,
        toolCallSuccessCount: 0,
        totalRepairCycles: 0,
        timeoutCount: 0,
        cancellationCount: 0,
        emaLatencyMs: 0,
        autocomplete: { shown: 0, accepted: 0, staleDiscarded: 0, empty: 0, cancelled: 0, failed: 0, emaLatencyMs: 0 },
      }
    }

    const isSuccess = record.accepted
    const isFailure = record.emptyCompletion || record.staleDiscarded || Boolean(record.failed)

    const ac = profile.autocomplete ?? { shown: 0, accepted: 0, staleDiscarded: 0, empty: 0, cancelled: 0, failed: 0, emaLatencyMs: 0 }
    const updated: ModelDeploymentProfile = {
      ...profile,
      sampleCount: profile.sampleCount + 1,
      successCount: profile.successCount + (isSuccess ? 1 : 0),
      failureCount: profile.failureCount + (isFailure ? 1 : 0),
      cancellationCount: profile.cancellationCount + (record.cancelled ? 1 : 0),
      emaLatencyMs: updateEma(profile.emaLatencyMs, record.latencyMs),
      autocomplete: {
        shown: ac.shown + (record.shown ? 1 : 0),
        accepted: ac.accepted + (record.accepted ? 1 : 0),
        staleDiscarded: ac.staleDiscarded + (record.staleDiscarded ? 1 : 0),
        empty: ac.empty + (record.emptyCompletion ? 1 : 0),
        cancelled: ac.cancelled + (record.cancelled ? 1 : 0),
        failed: (ac.failed ?? 0) + (record.failed ? 1 : 0),
        emaLatencyMs: updateEma(ac.emaLatencyMs, record.latencyMs),
      },
    }
    this.#profiles.set(key, updated)

    // Accumulate delta for persistence
    let delta = this.#deltas.get(key)
    if (!delta) {
      delta = {
        sampleCount: 0,
        successCount: 0,
        failureCount: 0,
        runtimeCompletedCount: 0,
        verificationSuccessCount: 0,
        toolCallSuccessCount: 0,
        totalRepairCycles: 0,
        timeoutCount: 0,
        cancellationCount: 0,
        latencies: [],
        autocomplete: { shown: 0, accepted: 0, staleDiscarded: 0, empty: 0, cancelled: 0, failed: 0, latencies: [] },
      }
      this.#deltas.set(key, delta)
    }
    delta.sampleCount += 1
    delta.successCount += isSuccess ? 1 : 0
    delta.failureCount += isFailure ? 1 : 0
    delta.cancellationCount += record.cancelled ? 1 : 0
    delta.latencies.push(record.latencyMs)
    if (!delta.autocomplete) {
      delta.autocomplete = { shown: 0, accepted: 0, staleDiscarded: 0, empty: 0, cancelled: 0, failed: 0, latencies: [] }
    }
    delta.autocomplete.shown += record.shown ? 1 : 0
    delta.autocomplete.accepted += record.accepted ? 1 : 0
    delta.autocomplete.staleDiscarded += record.staleDiscarded ? 1 : 0
    delta.autocomplete.empty += record.emptyCompletion ? 1 : 0
    delta.autocomplete.cancelled += record.cancelled ? 1 : 0
    delta.autocomplete.failed += record.failed ? 1 : 0
    delta.autocomplete.latencies.push(record.latencyMs)
  }

  /**
   * Compute bounded routing score adjustments for eligible deployments.
   *
   * Security and capability filters happen BEFORE this is called.
   * This function only adjusts the relative ordering of already-eligible candidates.
   *
   * Formula:
   *   For Agent tasks:
   *     rawScore = (0.50 * qualitySuccessRate + 0.30 * verificationSuccessRate + 0.20 * toolSuccessRate)
   *                - repairPenalty - timeoutPenalty
   *   For Autocomplete tasks:
   *     rawScore = acceptanceRate - timeoutPenalty
   *
   * Returns empty array if adaptiveRoutingDisabled or insufficient samples.
   */
  getRoutingAdjustments(
    deploymentIds: readonly string[],
    taskClass: TaskClass | "autocomplete",
  ): readonly RoutingScoreAdjustment[] {
    if (this.#options.adaptiveRoutingDisabled) return []

    const adjustments: RoutingScoreAdjustment[] = []

    for (const deploymentId of deploymentIds) {
      const key = profileKey(deploymentId, taskClass)
      const profile = this.#profiles.get(key)
      if (!profile || profile.sampleCount < this.#options.minimumSamples) {
        // Insufficient evidence — no adjustment (static priority preserved)
        continue
      }

      const timeoutRate = profile.timeoutCount / profile.sampleCount

      let rawScore: number
      if (taskClass === "autocomplete") {
        const acceptanceRate = profile.successCount / profile.sampleCount
        const timeoutPenalty = Math.min(0.25, timeoutRate * 0.5)
        rawScore = acceptanceRate - timeoutPenalty
      } else {
        const successRate = profile.successCount / profile.sampleCount
        const verificationRate = profile.verificationSuccessCount / profile.sampleCount
        const toolRate = profile.toolCallSuccessCount / profile.sampleCount
        const avgRepairs = profile.totalRepairCycles / profile.sampleCount
        const repairPenalty = Math.min(0.25, avgRepairs * 0.05)
        const timeoutPenalty = Math.min(0.25, timeoutRate * 0.5)
        rawScore = (0.50 * successRate + 0.30 * verificationRate + 0.20 * toolRate) - repairPenalty - timeoutPenalty
      }

      // Normalize to [-1, +1] range (0.5 success baseline = 0 adjustment)
      const normalizedScore = (rawScore - 0.5) * 2
      const adjustment = Math.max(
        -this.#options.maxAdjustment,
        Math.min(this.#options.maxAdjustment, normalizedScore * this.#options.maxAdjustment),
      )

      // Hysteresis: only apply if adjustment magnitude exceeds threshold
      if (Math.abs(adjustment) < this.#options.hysteresisThreshold) continue

      const reason = taskClass === "autocomplete"
        ? `acceptanceRate=${((profile.successCount / profile.sampleCount) * 100).toFixed(1)}% timeoutRate=${(timeoutRate * 100).toFixed(1)}%`
        : `qualitySuccess=${((profile.successCount / profile.sampleCount) * 100).toFixed(1)}% verificationRate=${((profile.verificationSuccessCount / profile.sampleCount) * 100).toFixed(1)}% toolRate=${((profile.toolCallSuccessCount / profile.sampleCount) * 100).toFixed(1)}% avgRepairs=${(profile.totalRepairCycles / profile.sampleCount).toFixed(2)}`

      adjustments.push({
        deploymentId,
        taskClass,
        adjustment,
        sampleCount: profile.sampleCount,
        reason,
      })
    }

    return adjustments
  }

  /** Get the profile for a specific deployment+taskClass. Returns undefined if not yet sampled. */
  getProfile(deploymentId: string, taskClass: TaskClass | "autocomplete"): ModelDeploymentProfile | undefined {
    return this.#profiles.get(profileKey(deploymentId, taskClass))
  }

  /** Get all profiles. Never includes raw source. */
  getAllProfiles(): readonly ModelDeploymentProfile[] {
    return [...this.#profiles.values()]
  }

  /** Current profile count (bounded). */
  get profileCount(): number {
    return this.#profiles.size
  }

  /** Whether adaptive routing is active (sufficient samples + not disabled). */
  get adaptiveRoutingActive(): boolean {
    return !this.#options.adaptiveRoutingDisabled
  }

  /** Disable adaptive routing adjustments. Static priority is used. */
  disableAdaptiveRouting(): void {
    (this.#options as { adaptiveRoutingDisabled: boolean }).adaptiveRoutingDisabled = true
  }

  /** Enable adaptive routing adjustments. */
  enableAdaptiveRouting(): void {
    (this.#options as { adaptiveRoutingDisabled: boolean }).adaptiveRoutingDisabled = false
  }

  /**
   * Reset all learned performance data.
   * Does NOT affect model configuration, permissions, or source code.
   */
  reset(): void {
    this.#profiles.clear()
    this.#deltas.clear()
  }

  /**
   * Persist profiles to disk with per-path serialization.
   * Concurrent writes to the same path serialize safely without losing updates.
   * Different workspace paths never block each other.
   */
  async persist(): Promise<void> {
    if (!this.#options.persistPath) return
    const pathKey = this.#options.persistPath
    const prev = persistQueuesByPath.get(pathKey) ?? Promise.resolve()

    const current = prev
      .catch(() => {}) // Failed write does not permanently poison the queue
      .then(async () => {
        await this.#executePersist()
      })

    persistQueuesByPath.set(pathKey, current)
    try {
      await current
    } finally {
      if (persistQueuesByPath.get(pathKey) === current) {
        persistQueuesByPath.delete(pathKey)
      }
    }
  }

  async #executePersist(): Promise<void> {
    if (!this.#options.persistPath) return

    const mergedProfiles = new Map<string, ModelDeploymentProfile>()
    try {
      const raw = await readFile(this.#options.persistPath, "utf-8")
      const parsed = JSON.parse(raw) as LedgerStore
      if (parsed.schemaVersion === LEDGER_SCHEMA_VERSION && Array.isArray(parsed.profiles)) {
        for (const p of parsed.profiles) {
          if (p && typeof p.deploymentId === "string" && typeof p.taskClass === "string") {
            const key = profileKey(p.deploymentId, p.taskClass)
            mergedProfiles.set(key, { ...p })
          }
        }
      }
    } catch {
      // Disk file absent, unreadable, or schema mismatch — proceed with empty base
    }

    // Snapshot pending deltas for atomic commit
    const pendingDeltas = new Map(this.#deltas)

    for (const [key, profile] of this.#profiles.entries()) {
      const existing = mergedProfiles.get(key)
      const delta = pendingDeltas.get(key)
      if (existing && delta) {
        // Merge delta into existing on-disk profile to prevent lost updates across instances
        existing.sampleCount += delta.sampleCount
        existing.successCount += delta.successCount
        existing.failureCount += delta.failureCount
        existing.runtimeCompletedCount = (existing.runtimeCompletedCount ?? 0) + delta.runtimeCompletedCount
        existing.verificationSuccessCount += delta.verificationSuccessCount
        existing.toolCallSuccessCount += delta.toolCallSuccessCount
        existing.totalRepairCycles += delta.totalRepairCycles
        existing.timeoutCount += delta.timeoutCount
        existing.cancellationCount += delta.cancellationCount
        for (const lat of delta.latencies) {
          existing.emaLatencyMs = updateEma(existing.emaLatencyMs, lat)
        }
        if (delta.autocomplete) {
          const ac = existing.autocomplete ?? { shown: 0, accepted: 0, staleDiscarded: 0, empty: 0, cancelled: 0, failed: 0, emaLatencyMs: 0 }
          ac.shown += delta.autocomplete.shown
          ac.accepted += delta.autocomplete.accepted
          ac.staleDiscarded += delta.autocomplete.staleDiscarded
          ac.empty += delta.autocomplete.empty
          ac.cancelled += delta.autocomplete.cancelled
          ac.failed = (ac.failed ?? 0) + delta.autocomplete.failed
          for (const lat of delta.autocomplete.latencies) {
            ac.emaLatencyMs = updateEma(ac.emaLatencyMs, lat)
          }
          existing.autocomplete = ac
        }
        // Sync local in-memory profile with merged state
        this.#profiles.set(key, { ...existing })
      } else if (!existing) {
        // New profile from this instance
        mergedProfiles.set(key, { ...profile })
      }
    }

    let profilesToSave = [...mergedProfiles.values()]
    if (profilesToSave.length > this.#options.maxProfiles) {
      profilesToSave = profilesToSave.slice(profilesToSave.length - this.#options.maxProfiles)
    }

    const store: LedgerStore = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      profiles: profilesToSave,
      lastUpdated: new Date().toISOString(),
    }
    const dir = dirname(this.#options.persistPath)
    await mkdir(dir, { recursive: true })
    const tmpPath = `${this.#options.persistPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8")
    await rename(tmpPath, this.#options.persistPath)

    // Clear successfully persisted deltas
    for (const key of pendingDeltas.keys()) {
      this.#deltas.delete(key)
    }
  }

  /**
   * Load profiles from disk.
   * Initial load is initiated on construction; callers awaiting .ready or .load()
   * share the same in-flight load promise.
   * On corrupt/invalid store: resets safely without throwing.
   */
  async load(): Promise<{ loaded: boolean; resetDueToCorruption: boolean }> {
    if (!this.#options.persistPath) return { loaded: false, resetDueToCorruption: false }
    if (this.#initialLoadPromise) return this.#initialLoadPromise

    this.#initialLoadPromise = this.#executeLoad()
    return this.#initialLoadPromise
  }

  async #executeLoad(): Promise<{ loaded: boolean; resetDueToCorruption: boolean }> {
    this.#loadCount++
    if (!this.#options.persistPath) return { loaded: false, resetDueToCorruption: false }
    let raw: string
    try {
      raw = await readFile(this.#options.persistPath, "utf-8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: false, resetDueToCorruption: false }
      // Unreadable — safe reset
      this.#profiles.clear()
      this.#deltas.clear()
      return { loaded: false, resetDueToCorruption: true }
    }

    try {
      const parsed = JSON.parse(raw) as LedgerStore
      if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) {
        // Schema mismatch — safe reset, do not block routing
        this.#profiles.clear()
        this.#deltas.clear()
        return { loaded: false, resetDueToCorruption: true }
      }
      if (!Array.isArray(parsed.profiles)) {
        this.#profiles.clear()
        this.#deltas.clear()
        return { loaded: false, resetDueToCorruption: true }
      }
      // Validate and load profiles — bounded by maxProfiles
      let loaded = 0
      for (const p of parsed.profiles) {
        if (loaded >= this.#options.maxProfiles) break
        if (!p || typeof p.deploymentId !== "string" || typeof p.taskClass !== "string" || typeof p.sampleCount !== "number") {
          continue // Skip malformed entries
        }
        const key = profileKey(p.deploymentId, p.taskClass)
        // Newly recorded in-memory entries take precedence over stale disk data
        if (!this.#profiles.has(key)) {
          this.#profiles.set(key, p)
        }
        loaded++
      }
      return { loaded: true, resetDueToCorruption: false }
    } catch {
      // JSON parse failure — safe reset
      this.#profiles.clear()
      this.#deltas.clear()
      return { loaded: false, resetDueToCorruption: true }
    }
  }
}
