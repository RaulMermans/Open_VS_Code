/**
 * Direct-path non-progress guard (Sprint 5C, ADR-031): the lighter detector the AgentRunner uses
 * outside the structured workflow (and inside each workflow stage session). It observes tool
 * results, workspace hashes and evidence novelty; it never runs tools or decides anything itself.
 */
import {
  DEFAULT_PROGRESS_THRESHOLDS,
  type NonProgressRecoveryPlan,
  type NonProgressReport,
  type ProgressSignal,
  type ProgressThresholds,
  type RecoveryOutcome,
} from "./contracts.ts"
import { errorFingerprint, shortHash, toolFingerprint } from "./fingerprint.ts"

export interface DirectToolObservation {
  readonly name: string
  readonly args: unknown
  readonly ok: boolean
  readonly content: string
  readonly errorCategory?: string
  /** For applied mutations: the file and its content hash after the write. */
  readonly mutation?: { readonly path: string; readonly beforeHash?: string; readonly afterHash?: string }
}

/** Bounded evidence the runner attaches to its result. Hashes, counts and bounded text only. */
export interface DirectNonProgressEvidence {
  readonly signals: readonly ProgressSignal[]
  readonly recoveryAttempted: boolean
  readonly recoveryCount: number
  readonly recoveryPlan?: NonProgressRecoveryPlan
  readonly recoveryOutcome?: RecoveryOutcome
  readonly finalBlocker?: NonProgressReport
  /** Repeated observations dropped when the recovery turn's context was rebuilt. */
  readonly observationsDropped: number
}

export class DirectProgressGuard {
  readonly #thresholds: ProgressThresholds
  readonly #actions = new Map<string, number>()
  readonly #errors = new Map<string, number>()
  readonly #evidence = new Set<string>()
  readonly #workspace = new Map<string, string>()
  #noEvidenceTurns = 0
  #turnHadEvidence = false
  #noopMutations = 0
  #evidenceSinceRecovery = 0
  recoveryCount = 0
  readonly signalsSeen: ProgressSignal[] = []

  constructor(thresholds: Partial<ProgressThresholds> = {}) {
    this.#thresholds = { ...DEFAULT_PROGRESS_THRESHOLDS, ...thresholds }
  }

  get evidenceSinceRecovery(): number {
    return this.#evidenceSinceRecovery
  }

  /** Records one tool result and returns any signals whose threshold it crossed. */
  observeTool(observation: DirectToolObservation): ProgressSignal[] {
    const signals: ProgressSignal[] = []
    const t = this.#thresholds
    const resultKey = observation.ok ? shortHash(observation.content) : errorFingerprint(observation.content)
    const action = `${toolFingerprint(observation.name, observation.args)}:${observation.ok}:${resultKey}`
    const actionCount = (this.#actions.get(action) ?? 0) + 1
    this.#actions.set(action, actionCount)
    if (actionCount >= t.sameToolAction) signals.push({ kind: "REPEATED_TOOL_ACTION", count: actionCount, threshold: t.sameToolAction, pattern: `the same ${observation.name} call returned the same result` })

    if (!observation.ok) {
      const error = `${observation.name}:${observation.errorCategory ?? ""}:${resultKey}`
      const errorCount = (this.#errors.get(error) ?? 0) + 1
      this.#errors.set(error, errorCount)
      if (errorCount >= t.sameErrorAfterRepair && actionCount < t.sameToolAction) signals.push({ kind: "REPEATED_ERROR", count: errorCount, threshold: t.sameErrorAfterRepair, pattern: `${observation.name} failed with the same error after a different attempt` })
    }

    let novel = false
    if (observation.mutation) {
      const { path, beforeHash, afterHash } = observation.mutation
      const previous = this.#workspace.get(path) ?? beforeHash
      if (afterHash !== undefined && afterHash !== previous) {
        this.#workspace.set(path, afterHash)
        this.#noopMutations = 0
        novel = true
      } else if (observation.ok) {
        this.#noopMutations += 1
        if (this.#noopMutations >= t.sameDiffAfterMutation) signals.push({ kind: "DIFF_STAGNATION", count: this.#noopMutations, threshold: t.sameDiffAfterMutation, pattern: `writes to ${path} did not change the workspace` })
      }
    } else if (observation.ok && !this.#evidence.has(resultKey)) {
      this.#evidence.add(resultKey)
      novel = true
    }
    if (novel) {
      this.#turnHadEvidence = true
      if (this.recoveryCount > 0) this.#evidenceSinceRecovery += 1
    }
    this.signalsSeen.push(...signals)
    return signals
  }

  /** Called once per completed model turn. Context burn = several turns without new durable evidence. */
  endTurn(): ProgressSignal[] {
    this.#noEvidenceTurns = this.#turnHadEvidence ? 0 : this.#noEvidenceTurns + 1
    this.#turnHadEvidence = false
    if (this.#noEvidenceTurns < this.#thresholds.noProgressWindow) return []
    const signal: ProgressSignal = { kind: "CONTEXT_BURN", count: this.#noEvidenceTurns, threshold: this.#thresholds.noProgressWindow, pattern: `${this.#noEvidenceTurns} model turns produced no new evidence` }
    this.signalsSeen.push(signal)
    return [signal]
  }

  get noEvidenceTurns(): number {
    return this.#noEvidenceTurns
  }

  get workspaceHashes(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#workspace)
  }
}

/**
 * Keeps the latest occurrence of each distinct observation and drops exact repeats, so a recovery
 * turn sees the evidence once instead of the accumulated retry history.
 */
export function dedupeObservations<T extends { readonly toolName: string; readonly ok: boolean; readonly content: string }>(observations: readonly T[]): { kept: T[]; dropped: number } {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const observation of observations.toReversed()) {
    const key = `${observation.toolName}\0${observation.ok}\0${shortHash(observation.content)}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(observation)
  }
  kept.reverse()
  return { kept, dropped: observations.length - kept.length }
}
