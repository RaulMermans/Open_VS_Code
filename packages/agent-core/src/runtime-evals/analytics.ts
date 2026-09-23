import type {
  AdaptiveDecision,
  InterventionOutcome,
} from "./contracts.ts"
import type { RuntimeEvalLedger } from "./runtime-eval-ledger.ts"

export interface AggregateEvalMetrics {
  readonly totalEvals: number
  readonly totalInterventions: number
  readonly decisions: Record<AdaptiveDecision, number>
  readonly nonProgressDetections: number
  readonly repeatedFailureDetections: number
  readonly unverifiedCompletionDetections: number
  readonly repairSuccessRate: number
  readonly verificationAfterInterventionRate: number
  readonly criticInvocations: number
}

export interface RoutePerformanceRecord {
  readonly providerId: string
  readonly modelId: string
  readonly totalRuns: number
  readonly successCount: number
  readonly failureCount: number
  readonly replanCount: number
  readonly avgLatencyMs: number
}

export interface AutocompleteTelemetrySignal {
  readonly event: "shown" | "accepted" | "cancelled" | "staleDiscarded" | "empty"
  readonly latencyMs: number
  readonly timestamp: string
}

export interface AutocompleteAnalyticsSummary {
  readonly totalRequests: number
  readonly shown: number
  readonly accepted: number
  readonly cancelled: number
  readonly staleDiscarded: number
  readonly empty: number
  readonly acceptanceRate: number
  readonly avgLatencyMs: number
}

export interface RuntimeCandidateFact {
  readonly key: string
  readonly value: string
  readonly confidence: number
  readonly evidence: string
}

export class RuntimeEvalAnalytics {
  readonly #ledger: RuntimeEvalLedger
  readonly #routeStats = new Map<string, { runs: number; success: number; fail: number; replans: number; totalLatency: number }>()
  readonly #autocompleteSignals: AutocompleteTelemetrySignal[] = []
  readonly #stagedMemoryFacts: RuntimeCandidateFact[] = []

  constructor(ledger: RuntimeEvalLedger) {
    this.#ledger = ledger
  }

  getAggregateMetrics(runId?: string): AggregateEvalMetrics {
    const entries = this.#ledger.getEntries(runId)
    const decisions: Record<AdaptiveDecision, number> = {
      CONTINUE: 0,
      REVISE: 0,
      REPLAN: 0,
      VERIFY: 0,
      CHANGE_MODEL: 0,
      REQUEST_MORE_CONTEXT: 0,
      STOP: 0,
      ASK_HUMAN: 0,
    }

    let interventions = 0
    let nonProgress = 0
    let repeatedFailures = 0
    let unverifiedCompletions = 0
    let criticCount = 0
    let resolvedInterventions = 0
    let verificationsFollowed = 0

    for (const e of entries) {
      decisions[e.decision] = (decisions[e.decision] ?? 0) + 1
      if (e.decision !== "CONTINUE") {
        interventions++
      }
      if (e.reasonCodes.includes("NON_PROGRESS_LOOP") || e.reasonCodes.includes("RUNAWAY_LOOP_STOP")) {
        nonProgress++
      }
      if (e.reasonCodes.includes("REPEATED_VERIFICATION_FAILURE") || e.reasonCodes.includes("REPEATED_TOOL_FAILURE")) {
        repeatedFailures++
      }
      if (e.reasonCodes.includes("UNVERIFIED_MUTATION")) {
        unverifiedCompletions++
      }
      if (e.level === "L2") {
        criticCount++
      }
      if (e.outcome === "IMPROVED" || e.outcome === "RESOLVED") {
        resolvedInterventions++
      }
      if (e.decision === "VERIFY" && e.outcome) {
        verificationsFollowed++
      }
    }

    const verifyInterventions = decisions.VERIFY
    const verifRate = verifyInterventions > 0 ? verificationsFollowed / verifyInterventions : 1.0
    const repairRate = interventions > 0 ? resolvedInterventions / interventions : 1.0

    return {
      totalEvals: entries.length,
      totalInterventions: interventions,
      decisions,
      nonProgressDetections: nonProgress,
      repeatedFailureDetections: repeatedFailures,
      unverifiedCompletionDetections: unverifiedCompletions,
      repairSuccessRate: Math.round(repairRate * 100) / 100,
      verificationAfterInterventionRate: Math.round(verifRate * 100) / 100,
      criticInvocations: criticCount,
    }
  }

  getDecisionBreakdown(runId?: string): Record<AdaptiveDecision, number> {
    return this.getAggregateMetrics(runId).decisions
  }

  getFailureCategories(runId?: string): Record<string, number> {
    const entries = this.#ledger.getEntries(runId)
    const counts: Record<string, number> = {}
    for (const e of entries) {
      for (const code of e.reasonCodes) {
        if (code.includes("FAIL") || code.includes("ERROR") || code.includes("DENI") || code.includes("LOOP")) {
          counts[code] = (counts[code] ?? 0) + 1
        }
      }
    }
    return counts
  }

  getInterventionOutcomes(runId?: string): Record<InterventionOutcome, number> {
    const entries = this.#ledger.getEntries(runId)
    const outcomes: Record<InterventionOutcome, number> = {
      IMPROVED: 0,
      DEGRADED: 0,
      UNCHANGED: 0,
      PENDING: 0,
      RESOLVED: 0,
    }
    for (const e of entries) {
      if (e.outcome) {
        outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1
      }
    }
    return outcomes
  }

  // T-4432: Route Performance Evidence
  recordRouteOutcome(providerId: string, modelId: string, success: boolean, latencyMs: number, replanCount = 0): void {
    const key = `${providerId}:${modelId}`
    const existing = this.#routeStats.get(key) ?? { runs: 0, success: 0, fail: 0, replans: 0, totalLatency: 0 }
    this.#routeStats.set(key, {
      runs: existing.runs + 1,
      success: existing.success + (success ? 1 : 0),
      fail: existing.fail + (success ? 0 : 1),
      replans: existing.replans + replanCount,
      totalLatency: existing.totalLatency + latencyMs,
    })
  }

  recordRoutePerformance(providerId: string, modelId: string, success: boolean, replanCount = 0, latencyMs = 0): void {
    this.recordRouteOutcome(providerId, modelId, success, latencyMs, replanCount)
  }

  getRouteStats(): readonly RoutePerformanceRecord[] {
    const records: RoutePerformanceRecord[] = []
    for (const [key, stat] of this.#routeStats.entries()) {
      const [providerId, modelId] = key.split(":")
      records.push({
        providerId: providerId ?? "unknown",
        modelId: modelId ?? "unknown",
        totalRuns: stat.runs,
        successCount: stat.success,
        failureCount: stat.fail,
        replanCount: stat.replans,
        avgLatencyMs: stat.runs > 0 ? Math.round(stat.totalLatency / stat.runs) : 0,
      })
    }
    return records
  }

  // T-4433: Autocomplete Evidence Adapter
  recordAutocompleteTelemetry(signal: AutocompleteTelemetrySignal): void {
    this.#autocompleteSignals.push(signal)
    if (this.#autocompleteSignals.length > 100) {
      this.#autocompleteSignals.shift()
    }
  }

  getAutocompleteMetrics(): AutocompleteAnalyticsSummary {
    let shown = 0
    let accepted = 0
    let cancelled = 0
    let staleDiscarded = 0
    let empty = 0
    let totalLatency = 0

    for (const s of this.#autocompleteSignals) {
      totalLatency += s.latencyMs
      switch (s.event) {
        case "shown":
          shown++
          break
        case "accepted":
          accepted++
          break
        case "cancelled":
          cancelled++
          break
        case "staleDiscarded":
          staleDiscarded++
          break
        case "empty":
          empty++
          break
      }
    }

    const total = this.#autocompleteSignals.length
    const acceptanceRate = shown > 0 ? Math.round((accepted / shown) * 100) / 100 : 0.0
    const avgLatencyMs = total > 0 ? Math.round(totalLatency / total) : 0

    return {
      totalRequests: total,
      shown,
      accepted,
      cancelled,
      staleDiscarded,
      empty,
      acceptanceRate,
      avgLatencyMs,
    }
  }

  // T-4431: Controlled Memory Promotion
  proposeCandidateFact(fact: RuntimeCandidateFact): boolean {
    if (fact.confidence >= 0.8 && fact.key.trim() && fact.value.trim()) {
      this.#stagedMemoryFacts.push(fact)
      return true
    }
    return false
  }

  getStagedMemoryFacts(): readonly RuntimeCandidateFact[] {
    return [...this.#stagedMemoryFacts]
  }

  getRunSummary(runId?: string) {
    const metrics = this.getAggregateMetrics(runId)
    const outcomes = this.getInterventionOutcomes(runId)
    return {
      totalEvaluations: metrics.totalEvals,
      totalInterventions: metrics.totalInterventions,
      resolvedInterventions: outcomes.RESOLVED,
      degradedInterventions: outcomes.DEGRADED,
      unchangedInterventions: outcomes.UNCHANGED,
      pendingInterventions: outcomes.PENDING,
      repairSuccessRate: metrics.repairSuccessRate,
      criticInvocations: metrics.criticInvocations,
      decisions: metrics.decisions,
      nonProgressLoopsDetected: metrics.nonProgressDetections,
      repeatedFailuresDetected: metrics.repeatedFailureDetections,
      unverifiedFinishesBlocked: metrics.unverifiedCompletionDetections,
    }
  }

  getTokenAttributionSummary() {
    return {
      criticBudgetTokens: 1500,
      estimatedOverheadPerEvalTokens: 150,
    }
  }

  // T-4430: Local Developer Summary Surface
  formatDeveloperSummary(runId?: string): string {
    return formatDeveloperSummary(this, runId)
  }
}

export function formatDeveloperSummary(
  summaryOrAnalytics: {
    readonly totalEvaluations?: number
    readonly totalEvals?: number
    readonly totalInterventions: number
    readonly repairSuccessRate: number
    readonly criticInvocations: number
    readonly decisions: Record<AdaptiveDecision, number>
    readonly resolvedInterventions?: number
    readonly degradedInterventions?: number
    readonly unchangedInterventions?: number
    readonly pendingInterventions?: number
    readonly nonProgressLoopsDetected?: number
    readonly nonProgressDetections?: number
    readonly repeatedFailuresDetected?: number
    readonly repeatedFailureDetections?: number
    readonly unverifiedFinishesBlocked?: number
    readonly unverifiedCompletionDetections?: number
  } | RuntimeEvalAnalytics,
  runId?: string,
): string {
  if (summaryOrAnalytics instanceof RuntimeEvalAnalytics) {
    const metrics = summaryOrAnalytics.getAggregateMetrics(runId)
    const outcomes = summaryOrAnalytics.getInterventionOutcomes(runId)
    const failures = summaryOrAnalytics.getFailureCategories(runId)
    const lines: string[] = [
      "==================================================",
      "             RUNTIME EVALUATION SUMMARY           ",
      "==================================================",
      `Total Evaluations:     ${metrics.totalEvals}`,
      `Total Interventions:   ${metrics.totalInterventions}`,
      `Repair Success Rate:   ${(metrics.repairSuccessRate * 100).toFixed(0)}%`,
      `Critic Invocations:    ${metrics.criticInvocations}`,
      "--------------------------------------------------",
      "ADAPTIVE DECISIONS:",
      `  CONTINUE:            ${metrics.decisions.CONTINUE}`,
      `  VERIFY:              ${metrics.decisions.VERIFY}`,
      `  REVISE:              ${metrics.decisions.REVISE}`,
      `  REPLAN:              ${metrics.decisions.REPLAN}`,
      `  STOP:                ${metrics.decisions.STOP}`,
      `  ASK_HUMAN:           ${metrics.decisions.ASK_HUMAN}`,
      `  CHANGE_MODEL:        ${metrics.decisions.CHANGE_MODEL}`,
      `  REQUEST_MORE_CONTEXT:${metrics.decisions.REQUEST_MORE_CONTEXT}`,
      "--------------------------------------------------",
      "INTERVENTION OUTCOMES:",
      `  RESOLVED/IMPROVED:   ${outcomes.RESOLVED + outcomes.IMPROVED}`,
      `  UNCHANGED:           ${outcomes.UNCHANGED}`,
      `  DEGRADED:            ${outcomes.DEGRADED}`,
      `  PENDING:             ${outcomes.PENDING}`,
      "--------------------------------------------------",
      "DETECTIONS:",
      `  Non-Progress Loops:  ${metrics.nonProgressDetections}`,
      `  Repeated Failures:   ${metrics.repeatedFailureDetections}`,
      `  Unverified Finishes: ${metrics.unverifiedCompletionDetections}`,
    ]
    const failureKeys = Object.keys(failures)
    if (failureKeys.length > 0) {
      lines.push("--------------------------------------------------")
      lines.push("TOP FAILURE CODES:")
      for (const k of failureKeys.slice(0, 5)) {
        lines.push(`  ${k}: ${failures[k]}`)
      }
    }
    lines.push("==================================================")
    return lines.join("\n")
  }

  const s: any = summaryOrAnalytics
  const totalEvals = s.totalEvaluations ?? s.totalEvals ?? 0
  const totalInterventions = s.totalInterventions ?? 0
  const repairRate = s.repairSuccessRate ?? 1.0
  const criticInvs = s.criticInvocations ?? 0
  const decisions = s.decisions ?? {}

  const lines: string[] = [
    "==================================================",
    "             RUNTIME EVALUATION SUMMARY           ",
    "==================================================",
    `Total Evaluations:     ${totalEvals}`,
    `Total Interventions:   ${totalInterventions}`,
    `Repair Success Rate:   ${(repairRate * 100).toFixed(0)}%`,
    `Critic Invocations:    ${criticInvs}`,
    "--------------------------------------------------",
    "ADAPTIVE DECISIONS:",
    `  CONTINUE:            ${decisions.CONTINUE ?? 0}`,
    `  VERIFY:              ${decisions.VERIFY ?? 0}`,
    `  REVISE:              ${decisions.REVISE ?? 0}`,
    `  REPLAN:              ${decisions.REPLAN ?? 0}`,
    `  STOP:                ${decisions.STOP ?? 0}`,
    `  ASK_HUMAN:           ${decisions.ASK_HUMAN ?? 0}`,
    `  CHANGE_MODEL:        ${decisions.CHANGE_MODEL ?? 0}`,
    `  REQUEST_MORE_CONTEXT:${decisions.REQUEST_MORE_CONTEXT ?? 0}`,
    "--------------------------------------------------",
    "INTERVENTION OUTCOMES:",
    `  RESOLVED/IMPROVED:   ${s.resolvedInterventions ?? 0}`,
    `  UNCHANGED:           ${s.unchangedInterventions ?? 0}`,
    `  DEGRADED:            ${s.degradedInterventions ?? 0}`,
    `  PENDING:             ${s.pendingInterventions ?? 0}`,
    "--------------------------------------------------",
    "DETECTIONS:",
    `  Non-Progress Loops:  ${s.nonProgressLoopsDetected ?? s.nonProgressDetections ?? 0}`,
    `  Repeated Failures:   ${s.repeatedFailuresDetected ?? s.repeatedFailureDetections ?? 0}`,
    `  Unverified Finishes: ${s.unverifiedFinishesBlocked ?? s.unverifiedCompletionDetections ?? 0}`,
    "==================================================",
  ]
  return lines.join("\n")
}

export function adaptToAutocompleteTelemetry(
  evalResult: {
    readonly confidence: number
    readonly scores: { readonly verificationCoverage: number }
  },
  completionId: string,
  accepted: boolean,
  latencyMs: number,
): {
  readonly completionId: string
  readonly accepted: boolean
  readonly latencyMs: number
  readonly runtimeEvalConfidence: number
  readonly verificationCoverage: number
} {
  return {
    completionId,
    accepted,
    latencyMs,
    runtimeEvalConfidence: evalResult.confidence,
    verificationCoverage: evalResult.scores.verificationCoverage,
  }
}
