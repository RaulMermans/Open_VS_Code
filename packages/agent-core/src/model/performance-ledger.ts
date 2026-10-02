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

export const LEDGER_SCHEMA_VERSION = 1

/** Agent task outcome record — metrics only, no source or prompt text. */
export interface AgentOutcomeRecord {
  readonly deploymentId: string
  readonly taskClass: TaskClass
  readonly success: boolean
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
  readonly latencyMs: number
}

/** Per-deployment, per-task-class aggregate profile. */
export interface ModelDeploymentProfile {
  readonly deploymentId: string
  readonly taskClass: TaskClass | "autocomplete"
  sampleCount: number
  successCount: number
  failureCount: number
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

/**
 * ModelPerformanceLedger: bounded, privacy-preserving model outcome store.
 */
export class ModelPerformanceLedger {
  readonly #profiles = new Map<string, ModelDeploymentProfile>()
  readonly #options: Required<LedgerOptions>
  readonly #readyPromise: Promise<void>

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
        verificationSuccessCount: 0,
        toolCallSuccessCount: 0,
        totalRepairCycles: 0,
        timeoutCount: 0,
        cancellationCount: 0,
        emaLatencyMs: 0,
      }
    }

    const updated: ModelDeploymentProfile = {
      ...profile,
      sampleCount: profile.sampleCount + 1,
      successCount: profile.successCount + (record.success ? 1 : 0),
      failureCount: profile.failureCount + (record.success ? 0 : 1),
      verificationSuccessCount: profile.verificationSuccessCount + (record.verificationSuccess ? 1 : 0),
      toolCallSuccessCount: profile.toolCallSuccessCount + (record.toolCallSuccess ? 1 : 0),
      totalRepairCycles: profile.totalRepairCycles + record.repairCycles,
      timeoutCount: profile.timeoutCount + (record.timeoutOccurred ? 1 : 0),
      cancellationCount: profile.cancellationCount + (record.cancellationOccurred ? 1 : 0),
      emaLatencyMs: updateEma(profile.emaLatencyMs, record.latencyMs),
    }
    this.#profiles.set(key, updated)
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
        autocomplete: { shown: 0, accepted: 0, staleDiscarded: 0, empty: 0, cancelled: 0, emaLatencyMs: 0 },
      }
    }

    const ac = profile.autocomplete ?? { shown: 0, accepted: 0, staleDiscarded: 0, empty: 0, cancelled: 0, emaLatencyMs: 0 }
    const updated: ModelDeploymentProfile = {
      ...profile,
      sampleCount: profile.sampleCount + 1,
      successCount: profile.successCount + (record.accepted ? 1 : 0),
      failureCount: profile.failureCount + (record.emptyCompletion || record.staleDiscarded ? 1 : 0),
      cancellationCount: profile.cancellationCount + (record.cancelled ? 1 : 0),
      emaLatencyMs: updateEma(profile.emaLatencyMs, record.latencyMs),
      autocomplete: {
        shown: ac.shown + (record.shown ? 1 : 0),
        accepted: ac.accepted + (record.accepted ? 1 : 0),
        staleDiscarded: ac.staleDiscarded + (record.staleDiscarded ? 1 : 0),
        empty: ac.empty + (record.emptyCompletion ? 1 : 0),
        cancelled: ac.cancelled + (record.cancelled ? 1 : 0),
        emaLatencyMs: updateEma(ac.emaLatencyMs, record.latencyMs),
      },
    }
    this.#profiles.set(key, updated)
  }

  /**
   * Compute bounded routing score adjustments for eligible deployments.
   *
   * Security and capability filters happen BEFORE this is called.
   * This function only adjusts the relative ordering of already-eligible candidates.
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

      const successRate = profile.successCount / profile.sampleCount
      const timeoutRate = profile.timeoutCount / profile.sampleCount

      // Score: success rate - penalty for timeouts - penalty for repairs
      const avgRepairs = profile.totalRepairCycles / profile.sampleCount
      const repairPenalty = Math.min(0.3, avgRepairs * 0.1)
      const timeoutPenalty = Math.min(0.3, timeoutRate * 0.5)
      const rawScore = successRate - repairPenalty - timeoutPenalty

      // Normalize to [-1, +1] range (0.5 success = 0 adjustment)
      const normalizedScore = (rawScore - 0.5) * 2
      const adjustment = Math.max(
        -this.#options.maxAdjustment,
        Math.min(this.#options.maxAdjustment, normalizedScore * this.#options.maxAdjustment),
      )

      // Hysteresis: only apply if adjustment magnitude exceeds threshold
      if (Math.abs(adjustment) < this.#options.hysteresisThreshold) continue

      adjustments.push({
        deploymentId,
        taskClass,
        adjustment,
        sampleCount: profile.sampleCount,
        reason: `successRate=${(successRate * 100).toFixed(1)}% timeoutRate=${(timeoutRate * 100).toFixed(1)}% avgRepairs=${avgRepairs.toFixed(2)}`,
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
  }

  /** Persist profiles to disk. Never stores raw source/prompt content. */
  async persist(): Promise<void> {
    if (!this.#options.persistPath) return

    // Merge with existing on-disk profiles so independent instances (e.g. Agent vs Autocomplete)
    // sharing the workspace ledger path do not erase each other's profiles.
    const mergedProfiles = new Map<string, ModelDeploymentProfile>()
    try {
      const raw = await readFile(this.#options.persistPath, "utf-8")
      const parsed = JSON.parse(raw) as LedgerStore
      if (parsed.schemaVersion === LEDGER_SCHEMA_VERSION && Array.isArray(parsed.profiles)) {
        for (const p of parsed.profiles) {
          if (p && typeof p.deploymentId === "string" && typeof p.taskClass === "string") {
            const key = profileKey(p.deploymentId, p.taskClass)
            mergedProfiles.set(key, p)
          }
        }
      }
    } catch {
      // Disk file absent or unreadable — proceed with current in-memory profiles
    }

    // In-memory profiles take precedence for keys tracked in this ledger instance
    for (const [key, profile] of this.#profiles.entries()) {
      mergedProfiles.set(key, profile)
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
  }

  /**
   * Load profiles from disk.
   * On corrupt/invalid store: resets to empty and continues safely.
   * Core routing remains usable even when profile load fails.
   */
  async load(): Promise<{ loaded: boolean; resetDueToCorruption: boolean }> {
    if (!this.#options.persistPath) return { loaded: false, resetDueToCorruption: false }
    let raw: string
    try {
      raw = await readFile(this.#options.persistPath, "utf-8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: false, resetDueToCorruption: false }
      // Unreadable — safe reset
      this.#profiles.clear()
      return { loaded: false, resetDueToCorruption: true }
    }

    try {
      const parsed = JSON.parse(raw) as LedgerStore
      if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) {
        // Schema mismatch — safe reset, do not block routing
        this.#profiles.clear()
        return { loaded: false, resetDueToCorruption: true }
      }
      if (!Array.isArray(parsed.profiles)) {
        this.#profiles.clear()
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
        this.#profiles.set(key, p)
        loaded++
      }
      return { loaded: true, resetDueToCorruption: false }
    } catch {
      // JSON parse failure — safe reset
      this.#profiles.clear()
      return { loaded: false, resetDueToCorruption: true }
    }
  }
}
