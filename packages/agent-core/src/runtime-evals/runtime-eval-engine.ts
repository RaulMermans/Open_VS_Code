import type {
  AdaptiveDecision,
  RuntimeCritic,
  RuntimeEvalCheckpoint,
  RuntimeEvalResult,
  RuntimeEvalScores,
  RuntimeEvalSignal,
} from "./contracts.ts"
import { evaluateL0, type L0EvaluatorOptions } from "./evaluators/l0-deterministic.ts"
import { evaluateL1, type L1EvaluatorOptions } from "./evaluators/l1-heuristic.ts"
import { type RuntimeEvidenceCollector, deterministicHash } from "./evidence.ts"

export interface RuntimeEvalEngineOptions {
  readonly l0Options?: L0EvaluatorOptions
  readonly l1Options?: L1EvaluatorOptions
  readonly critic?: RuntimeCritic
  readonly forceCritic?: boolean
  readonly criticEnabled?: boolean
  readonly criticTimeoutMs?: number
}

export class RuntimeEvalEngine {
  readonly #options: RuntimeEvalEngineOptions
  readonly #cachedResults = new Map<string, RuntimeEvalResult>()
  #evalCount = 0
  #criticEligibleCount = 0
  #criticInvokedCount = 0

  constructor(options?: RuntimeEvalEngineOptions) {
    this.#options = options ?? {}
  }

  get evalCount(): number {
    return this.#evalCount
  }

  get criticEligibleCount(): number {
    return this.#criticEligibleCount
  }

  get criticInvokedCount(): number {
    return this.#criticInvokedCount
  }

  clearCache(): void {
    this.#cachedResults.clear()
  }

  async evaluate(
    collector: RuntimeEvidenceCollector,
    checkpoint: RuntimeEvalCheckpoint,
    turnId: number,
    signal?: AbortSignal,
  ): Promise<RuntimeEvalResult> {
    if (signal?.aborted) {
      const err = new Error("Runtime evaluation aborted")
      err.name = "AbortError"
      throw err
    }

    const initialVersion = collector.evidenceVersion
    const runId = collector.runId
    const checkpointKey = `${runId}:${turnId}:${checkpoint}:${initialVersion}`

    // T-4435: Exactly-once evaluation per checkpoint identity
    if (collector.hasEvaluatedCheckpoint(checkpointKey)) {
      const cached = this.#cachedResults.get(checkpointKey)
      if (cached) return cached
    }

    collector.recordEvaluatedCheckpoint(checkpointKey)
    this.#evalCount++

    let result: RuntimeEvalResult
    try {
      const evidence = collector.getEvidence()

      // 1. L0 Deterministic Evaluation
      const l0Result = evaluateL0(evidence, checkpoint, this.#options.l0Options)

      // 2. L1 Heuristic Evaluation
      const l1Result = evaluateL1(evidence, checkpoint, l0Result, this.#options.l1Options)
      result = l1Result

      // 3. Selective L2 Critic Escalation (T-4424, T-4425, T-4426)
      const recentFails = evidence.verificationOutcomes.filter((v) => v.status === "FAIL")
      const hasRepeatedFailure = recentFails.length >= 2
      const isAmbiguous = l1Result.confidence < 0.6 ||
        (checkpoint === "BEFORE_COMPLETION" && evidence.mutationOutcomes.length === 0 && evidence.counts.actions > 5)

      const isEligible = Boolean(
        this.#options.critic &&
        (this.#options.criticEnabled || this.#options.forceCritic) &&
        (this.#options.forceCritic || isAmbiguous || hasRepeatedFailure)
      )

      if (isEligible) {
        this.#criticEligibleCount++
        this.#criticInvokedCount++

        try {
          const criticInput = {
            taskGoal: evidence.taskGoal,
            boundedPlan: evidence.plan,
            boundedEvidence: collector.getBoundedSummary(),
            deterministicSignals: l1Result.signals,
          }

          let criticOutput: import("./contracts.ts").RuntimeCriticOutput
          if (this.#options.criticTimeoutMs && this.#options.criticTimeoutMs > 0) {
            const timeoutMs = this.#options.criticTimeoutMs
            criticOutput = await Promise.race([
              this.#options.critic!.evaluate(criticInput, signal),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Critic evaluation timed out after ${timeoutMs}ms`)), timeoutMs)
              ),
            ])
          } else {
            criticOutput = await this.#options.critic!.evaluate(criticInput, signal)
          }

          // Check cancellation after critic
          if (signal?.aborted) {
            const err = new Error("Runtime evaluation aborted")
            err.name = "AbortError"
            throw err
          }

          // Validate critic output schema (T-4427)
          if (!criticOutput || typeof criticOutput !== "object" || (typeof (criticOutput as any).decision === "undefined" && typeof (criticOutput as any).suggestedDecision === "undefined")) {
            throw new Error("Invalid critic schema: missing decision")
          }

          // Merge critic assessment as advisory recommendation (T-4426, T-4437)
          const mergedSignals: RuntimeEvalSignal[] = [
            ...l1Result.signals,
            {
              code: "CRITIC_ASSESSMENT",
              message: criticOutput.assessment,
              severity: "INFO",
              metadata: { reasonCodes: criticOutput.reasonCodes },
            },
          ]

          // Critic may influence decision if confident, but cannot override verification failure, unverified mutation, or security denial (T-4437)
          let finalDecision: AdaptiveDecision = l1Result.decision
          const suggested = ((criticOutput as any).suggestedDecision ?? (criticOutput as any).decision) as AdaptiveDecision
          const denials = evidence.securitySignals.filter((s) => s.denied)
          const hardL0Block =
            denials.length > 0 ||
            l0Result.scores.safetyAuthority === 0 ||
            l0Result.decision === "ASK_HUMAN" ||
            l0Result.decision === "VERIFY" ||
            recentFails.length > 0 ||
            l0Result.decision === "REVISE" ||
            l0Result.decision === "STOP" ||
            l1Result.decision === "STOP"

          if (hardL0Block && suggested === "CONTINUE") {
            finalDecision = l1Result.decision
          } else if (l1Result.scores.safetyAuthority > 0) {
            finalDecision = suggested
          }

          result = {
            ...l1Result,
            evalId: `eval-l2-${turnId}-v${collector.evidenceVersion}-${deterministicHash(`${runId}:${turnId}:${collector.evidenceVersion}:${checkpoint}`)}`,
            decision: finalDecision,
            evaluatorLevel: "L2",
            criticAssessment: criticOutput.assessment,
            criticFeedback: {
              critique: criticOutput.assessment,
              assessment: criticOutput.assessment,
            },
            confidence: criticOutput.confidence,
            signals: mergedSignals,
          }
        } catch (criticError) {
          // T-4427: Critic failure degrades safely to deterministic policy without crashing
          if (signal?.aborted || (criticError instanceof Error && criticError.name === "AbortError" && !criticError.message.includes("timed out"))) {
            throw criticError
          }
          const errorMessage = criticError instanceof Error ? criticError.message : "Critic evaluation failed"
          const fallbackSignals: RuntimeEvalSignal[] = [
            ...l1Result.signals,
            {
              code: "CRITIC_FALLBACK",
              message: `Critic evaluation failed; fell back to deterministic L1 policy: ${errorMessage}`,
              severity: "WARNING",
            },
          ]
          result = {
            ...l1Result,
            evaluatorLevel: "L1",
            signals: fallbackSignals,
          }
        }
      }

      // T-4441: Stale evaluation guard
      if (collector.evidenceVersion !== initialVersion) {
        // Evidence changed while evaluating; result is stale
        result = {
          ...result,
          stale: true,
          decision: "CONTINUE",
          signals: [
            ...result.signals,
            {
              code: "STALE_EVALUATION",
              message: `Evaluation started at evidence version ${initialVersion} but current version is ${collector.evidenceVersion}`,
              severity: "WARNING",
            },
          ],
        }
      }
    } catch (evalError) {
      if (signal?.aborted || (evalError instanceof Error && evalError.name === "AbortError")) {
        throw evalError
      }
      // T-4442: Evaluator error handling — fails safe without escalating authority
      const msg = evalError instanceof Error ? evalError.message : "Evaluator error"
      const failScores: RuntimeEvalScores = {
        progress: 0.0,
        completionConfidence: 0.0,
        verificationCoverage: 0.0,
        planAdherence: 0.0,
        executionEfficiency: 0.0,
        logicalConsistency: 0.0,
        safetyAuthority: 0.0,
      }
      result = {
        evalId: `eval-err-${turnId}-${Date.now().toString(36)}`,
        runId,
        turnId,
        checkpoint,
        evidenceVersion: initialVersion,
        decision: "STOP",
        scores: failScores,
        signals: [
          {
            code: "EVALUATOR_INTERNAL_ERROR",
            message: `Evaluator threw error: ${msg}`,
            severity: "CRITICAL",
          },
        ],
        recommendedAction: "Stop execution due to evaluator error",
        evaluatorLevel: "L0",
        confidence: 1.0,
        evidenceRefs: [],
      }
    }

    result = {
      ...result,
      turnId,
    }

    if (!result.stale) {
      this.#cachedResults.set(checkpointKey, result)
    }
    return result
  }
}
