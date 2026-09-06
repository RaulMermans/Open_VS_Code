import type { TaskClass, ModelRouteRequirements, ModelSpecialization } from "../contracts/routing.ts"
import type { AgentMode } from "../contracts/agent.ts"
import type { ContextBudget } from "../contracts/context.ts"

/**
 * Deterministic mapping from agent mode to routing task class.
 * No LLM classifier — pure lookup.
 */
export function deriveTaskClass(mode: AgentMode): TaskClass {
  switch (mode) {
    case "ASK": return "general"
    case "PLAN": return "planning"
    case "BUILD": return "coding"
    case "DEBUG": return "debugging"
    case "REVIEW": return "review"
    default: return "general"
  }
}

/**
 * Derive specialization preference from task class.
 */
export function deriveSpecialization(taskClass: TaskClass): ModelSpecialization {
  switch (taskClass) {
    case "coding":
    case "debugging":
      return "coding"
    case "planning":
    case "review":
    case "general":
    default:
      return "general"
  }
}

/**
 * Default output token reserve. Consistent with ContextBudget.reservedOutput.
 * This is the minimum space reserved for model output in the context window.
 */
export const DEFAULT_OUTPUT_RESERVE = 4096

/**
 * Deterministic output reserve policy.
 * Uses the existing ContextBudget.reservedOutput if available,
 * otherwise falls back to DEFAULT_OUTPUT_RESERVE.
 * Never fills 100% of context with input.
 */
export function deriveOutputReserve(budget?: ContextBudget): number {
  return budget?.reservedOutput ?? DEFAULT_OUTPUT_RESERVE
}

export interface RouteRequirementsInput {
  readonly mode: AgentMode
  readonly estimatedInputTokens: number
  readonly hasTools: boolean
  readonly hasStructuredOutput: boolean
  readonly budget?: ContextBudget
}

/**
 * Build ModelRouteRequirements from actual runtime facts.
 * This is the single canonical requirements builder.
 * Inputs are actual runtime values, not fabricated stubs.
 */
export function buildModelRouteRequirements(input: RouteRequirementsInput): ModelRouteRequirements {
  const taskClass = deriveTaskClass(input.mode)
  const outputReserve = deriveOutputReserve(input.budget)
  const requiredContextWindow = input.estimatedInputTokens + outputReserve

  return {
    mode: input.mode,
    taskClass,
    needsTools: input.hasTools,
    needsStructuredOutput: input.hasStructuredOutput,
    estimatedInputTokens: input.estimatedInputTokens,
    requiredContextWindow,
    specialization: deriveSpecialization(taskClass),
  }
}
