import type {
  EvalLedgerEntry,
  InterventionOutcome,
  RuntimeEvalResult,
} from "./contracts.ts"
import { redactRuntimeEvalSecrets } from "./evidence.ts"

export const MAX_LEDGER_ENTRIES_PER_RUN = 50
export const MAX_TOTAL_LEDGER_BYTES = 512 * 1024 // 512 KB

export class RuntimeEvalLedger {
  readonly #entries: EvalLedgerEntry[] = []
  readonly #entriesByEvalId = new Map<string, EvalLedgerEntry>()
  readonly #maxEntries: number

  constructor(maxEntries = MAX_LEDGER_ENTRIES_PER_RUN) {
    this.#maxEntries = maxEntries
  }

  get entryCount(): number {
    return this.#entries.length
  }

  get totalRetainedBytes(): number {
    return JSON.stringify(this.#entries).length
  }

  recordEval(
    result: RuntimeEvalResult,
    intervention?: string,
    options?: { readonly staleDropped?: boolean; readonly applied?: boolean },
  ): EvalLedgerEntry {
    const isStale = Boolean(result.stale || options?.staleDropped)
    const sanitizedIntervention = !isStale && intervention ? redactRuntimeEvalSecrets(intervention) : undefined
    const hasIntervention = !isStale && Boolean(intervention)
    const applied = !isStale && (options?.applied ?? hasIntervention)

    const entry: EvalLedgerEntry = {
      evalId: result.evalId,
      runId: result.runId,
      turnId: result.turnId,
      timestamp: new Date().toISOString(),
      level: result.evaluatorLevel,
      decision: result.decision,
      scores: result.scores,
      reasonCodes: result.signals.map((s) => s.code),
      evidenceRefs: result.evidenceRefs ? [...result.evidenceRefs] : [],
      intervention: sanitizedIntervention,
      outcome: hasIntervention ? "PENDING" : undefined,
      hasIntervention,
      interventionAction: sanitizedIntervention,
      interventionOutcome: hasIntervention ? "PENDING" : undefined,
      staleDropped: isStale ? true : undefined,
      applied,
    }

    if (this.#entries.length >= this.#maxEntries) {
      const removed = this.#entries.shift()
      if (removed) {
        this.#entriesByEvalId.delete(removed.evalId)
      }
    }

    this.#entries.push(entry)
    this.#entriesByEvalId.set(entry.evalId, entry)
    return entry
  }

  recordInterventionOutcome(evalId: string, outcome: InterventionOutcome, details?: string): boolean {
    const existing = this.#entriesByEvalId.get(evalId)
    if (!existing) return false

    const sanitizedDetails = details ? redactRuntimeEvalSecrets(details) : undefined
    const updated: EvalLedgerEntry = {
      ...existing,
      outcome,
      outcomeDetails: sanitizedDetails,
      interventionOutcome: outcome,
      interventionDetails: sanitizedDetails,
    }

    const idx = this.#entries.findIndex((e) => e.evalId === evalId)
    if (idx !== -1) {
      this.#entries[idx] = updated
    }
    this.#entriesByEvalId.set(evalId, updated)
    return true
  }

  getEntries(runId?: string): readonly EvalLedgerEntry[] {
    if (!runId) return [...this.#entries]
    return this.#entries.filter((e) => e.runId === runId)
  }

  getEntriesForRun(runId: string): readonly EvalLedgerEntry[] {
    return this.getEntries(runId)
  }

  getInterventions(): readonly EvalLedgerEntry[] {
    return this.#entries.filter((e) => e.intervention !== undefined)
  }

  getUnresolvedInterventions(): readonly EvalLedgerEntry[] {
    return this.#entries.filter((e) => e.intervention !== undefined && e.outcome === "PENDING")
  }

  getEntry(evalId: string): EvalLedgerEntry | undefined {
    return this.#entriesByEvalId.get(evalId)
  }

  clear(): void {
    this.#entries.length = 0
    this.#entriesByEvalId.clear()
  }
}
