import type {
  AdaptiveDecision,
  RuntimeEvalResult,
  RuntimeEvidence,
} from "./contracts.ts"

export type AdaptiveActionKind =
  | "CONTINUE"
  | "NO_OP"
  | "SCHEDULE_VERIFICATION"
  | "INJECT_REVISION"
  | "TRIGGER_REPLAN"
  | "PAUSE_HUMAN"
  | "TERMINATE_RUN"
  | "REQUEST_CONTEXT"
  | "RECOMMEND_ROUTE"
  | "RECOMMEND_MODEL"

export interface AdaptiveDirective {
  readonly decision: AdaptiveDecision
  readonly action: AdaptiveActionKind
  readonly shouldFinalize: boolean
  readonly promptContext?: string | undefined
  readonly modelRecommendation?: { readonly capability: string; readonly reason: string } | undefined
  readonly contextRequest?: { readonly target: string; readonly reason: string } | undefined
  readonly stopReason?: string | undefined
}

export class AdaptiveControlPolicy {
  determineDirective(evalResult: RuntimeEvalResult, evidence: RuntimeEvidence): AdaptiveDirective {
    switch (evalResult.decision) {
      case "VERIFY": {
        return {
          decision: "VERIFY",
          action: "SCHEDULE_VERIFICATION",
          shouldFinalize: false,
          promptContext: "Verification required: a code mutation was applied but test verification has not passed. Execute verification now.",
        }
      }

      case "REVISE": {
        const lastVerif = evidence.verificationOutcomes[evidence.verificationOutcomes.length - 1]
        const lastFailure = evidence.unresolvedFailures[evidence.unresolvedFailures.length - 1]
        const failureDetails = lastVerif?.failureSummary || lastFailure?.summary || "Inspect failing test output and fix defect."
        return {
          decision: "REVISE",
          action: "INJECT_REVISION",
          shouldFinalize: false,
          promptContext: `[RUNTIME EVALUATION - REVISE REQUIRED]\nYour previous action resulted in an unresolved failure:\n${failureDetails}\nPlease analyze the root cause and propose a corrective mutation.`,
        }
      }

      case "REPLAN": {
        const failureSummary = evidence.unresolvedFailures.slice(-2).map((f) => f.summary).join("; ")
        return {
          decision: "REPLAN",
          action: "TRIGGER_REPLAN",
          shouldFinalize: false,
          promptContext: `[RUNTIME EVALUATION - REPLAN REQUIRED]\nCurrent approach has repeated failures or non-progress loops (${failureSummary || "repeated identical actions"}).\nPlease step back, reassess the repository structure and problem statement, and formulate a new plan.`,
        }
      }

      case "STOP": {
        return {
          decision: "STOP",
          action: "TERMINATE_RUN",
          shouldFinalize: false,
          stopReason: evalResult.signals.find((s) => s.severity === "CRITICAL")?.message ?? "Run terminated by adaptive control policy",
        }
      }

      case "ASK_HUMAN": {
        return {
          decision: "ASK_HUMAN",
          action: "PAUSE_HUMAN",
          shouldFinalize: false,
          stopReason: "Paused for human confirmation or security authorization",
        }
      }

      case "REQUEST_MORE_CONTEXT": {
        return {
          decision: "REQUEST_MORE_CONTEXT",
          action: "REQUEST_CONTEXT",
          shouldFinalize: false,
          contextRequest: evalResult.contextRequest ?? {
            target: "project_structure",
            reason: "Insufficient evidence to proceed with execution",
          },
        }
      }

      case "CHANGE_MODEL": {
        const modelRec = evalResult.modelRecommendation ?? evalResult.suggestedModel ?? {
          capability: "reasoning",
          reason: "High complexity task requiring advanced reasoning capability",
        }
        return {
          decision: "CHANGE_MODEL",
          action: "RECOMMEND_MODEL",
          shouldFinalize: false,
          modelRecommendation: modelRec,
        }
      }

      case "CONTINUE":
      default: {
        const allowCompletion = evalResult.checkpoint === "BEFORE_COMPLETION" && evalResult.scores.completionConfidence >= 0.8
        return {
          decision: "CONTINUE",
          action: "NO_OP",
          shouldFinalize: allowCompletion,
        }
      }
    }
  }
}
