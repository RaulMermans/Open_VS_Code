import {
  ADAPTIVE_DECISIONS,
  type AdaptiveDecision,
  type BoundedEvidenceSummary,
  type RuntimeCritic,
  type RuntimeCriticInput,
  type RuntimeCriticOutput,
} from "./contracts.ts"

export const MAX_CRITIC_INPUT_TOKENS = 1500
export const MAX_CRITIC_INPUT_CHARS = MAX_CRITIC_INPUT_TOKENS * 4 // ~6000 chars

export function enforceCriticContextBudget(input: RuntimeCriticInput): RuntimeCriticInput {
  const rawGoal = input?.taskGoal ?? ""
  const goal = rawGoal.length > 500 ? rawGoal.slice(0, 500) + " [TRUNCATED]" : rawGoal
  const plan = input?.boundedPlan
    ? input.boundedPlan.map((p) => (p.length > 200 ? p.slice(0, 200) + " [TRUNCATED]" : p))
    : undefined

  const evidence: any = input?.boundedEvidence ?? (input as any)?.evidence ?? {}
  const boundedEvidence: BoundedEvidenceSummary = {
    runId: evidence.runId ?? (input as any)?.runId ?? "unknown",
    turnId: evidence.turnId ?? (input as any)?.turnId ?? 0,
    taskGoal: (evidence.taskGoal ?? goal).length > 300 ? (evidence.taskGoal ?? goal).slice(0, 300) + "..." : (evidence.taskGoal ?? goal),
    planSummary: evidence.planSummary && evidence.planSummary.length > 200 ? evidence.planSummary.slice(0, 200) + "..." : evidence.planSummary,
    recentActionsSummary: (evidence.recentActionsSummary ?? "").length > 300 ? (evidence.recentActionsSummary ?? "").slice(0, 300) + "..." : (evidence.recentActionsSummary ?? ""),
    mutationSummary: (evidence.mutationSummary ?? "").length > 200 ? (evidence.mutationSummary ?? "").slice(0, 200) + "..." : (evidence.mutationSummary ?? ""),
    verificationSummary: (evidence.verificationSummary ?? "").length > 200 ? (evidence.verificationSummary ?? "").slice(0, 200) + "..." : (evidence.verificationSummary ?? ""),
    failuresSummary: (evidence.failuresSummary ?? "").length > 200 ? (evidence.failuresSummary ?? "").slice(0, 200) + "..." : (evidence.failuresSummary ?? ""),
    securitySummary: (evidence.securitySummary ?? "").length > 100 ? (evidence.securitySummary ?? "").slice(0, 100) + "..." : (evidence.securitySummary ?? ""),
  }

  const signals = Array.isArray(input?.deterministicSignals) ? input.deterministicSignals.slice(0, 5) : []

  return {
    taskGoal: goal,
    boundedPlan: plan,
    boundedEvidence,
    deterministicSignals: signals,
  }
}

export interface ScriptedRuntimeCriticOptions {
  readonly responses?: readonly (RuntimeCriticOutput | unknown)[]
  readonly handler?: (input: RuntimeCriticInput) => Promise<RuntimeCriticOutput | unknown> | (RuntimeCriticOutput | unknown)
  readonly delayMs?: number
  readonly shouldFail?: boolean
  readonly failureError?: Error
}

export class ScriptedRuntimeCritic implements RuntimeCritic {
  readonly #responses: (RuntimeCriticOutput | unknown)[]
  readonly #handler?: ScriptedRuntimeCriticOptions["handler"] | undefined
  readonly #delayMs: number
  readonly #shouldFail: boolean
  readonly #failureError?: Error | undefined
  #invocations = 0

  constructor(options?: ScriptedRuntimeCriticOptions) {
    this.#responses = options?.responses ? [...options.responses] : []
    this.#handler = options?.handler
    this.#delayMs = options?.delayMs ?? 0
    this.#shouldFail = options?.shouldFail ?? false
    this.#failureError = options?.failureError
  }

  get invocations(): number {
    return this.#invocations
  }

  async evaluate(rawInput: RuntimeCriticInput, signal?: AbortSignal): Promise<RuntimeCriticOutput> {
    if (signal?.aborted) {
      const err = new Error("Evaluation aborted")
      err.name = "AbortError"
      throw err
    }

    this.#invocations++

    if (this.#delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), this.#delayMs)
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            const err = new Error("Evaluation aborted")
            err.name = "AbortError"
            reject(err)
          },
          { once: true },
        )
      })
    }

    if (signal?.aborted) {
      const err = new Error("Evaluation aborted")
      err.name = "AbortError"
      throw err
    }

    if (this.#shouldFail) {
      throw this.#failureError ?? new Error("Critic execution failed (injected error)")
    }

    const budgetInput = enforceCriticContextBudget(rawInput)

    let rawOutput: unknown
    if (this.#handler) {
      rawOutput = await this.#handler(budgetInput)
    } else if (this.#responses.length > 0) {
      rawOutput = this.#responses.shift()
    } else {
      rawOutput = {
        assessment: "Scripted critic default assessment: implementation appears sound",
        suggestedDecision: "CONTINUE",
        reasonCodes: ["SCRIPTED_DEFAULT_OK"],
        confidence: 0.85,
      }
    }

    // Validate rawOutput structure and decision validity (T-4427, T-4437)
    if (!rawOutput || typeof rawOutput !== "object") {
      throw new Error("Malformed critic response: output must be an object")
    }

    const candidate = rawOutput as Record<string, unknown>
    const assessment = typeof candidate.assessment === "string"
      ? candidate.assessment
      : typeof candidate.critique === "string"
        ? candidate.critique
        : "Critic evaluated state"

    const sanitizedAssessment = assessment.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "[REDACTED_SCRIPT]")

    const reasonCodes = Array.isArray(candidate.reasonCodes)
      ? candidate.reasonCodes.map((r) => String(r))
      : ["CRITIC_ASSESSMENT"]

    const decisionCandidate = (candidate.suggestedDecision ?? candidate.decision) as AdaptiveDecision
    const decision = ADAPTIVE_DECISIONS.includes(decisionCandidate) ? decisionCandidate : "CONTINUE"

    const confidence = typeof candidate.confidence === "number" && !isNaN(candidate.confidence)
      ? Math.max(0, Math.min(1, candidate.confidence))
      : 0.5

    return {
      assessment: sanitizedAssessment,
      suggestedDecision: decision,
      reasonCodes,
      confidence,
      critique: sanitizedAssessment,
      decision,
      scores: candidate.scores && typeof candidate.scores === "object"
        ? {
            progress: typeof (candidate.scores as any).progress === "number" ? Math.max(0, Math.min(1, (candidate.scores as any).progress)) : 1,
            safetyAuthority: typeof (candidate.scores as any).safetyAuthority === "number" ? Math.max(0, Math.min(1, (candidate.scores as any).safetyAuthority)) : 1,
          }
        : undefined,
    } as any
  }
}
