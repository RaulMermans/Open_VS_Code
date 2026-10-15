/**
 * The bounded learning step that runs after a task has already finished (Sprint 5D, ADR-032).
 * The task's outcome is final before this runs, and a learning failure is reported, never thrown:
 * learning can neither block nor fail a completed task.
 */
import type { AgentMode, AgentResult } from "../contracts/agent.ts"
import type { WorkflowState } from "../workflow/contracts.ts"
import { extractFromDirectRun, extractFromWorkflow, extractToolchainFacts } from "./extract.ts"
import type { LearningService, ObserveReport } from "./service.ts"

export type LearningTaskInput =
  | { readonly kind: "workflow"; readonly state: WorkflowState }
  | { readonly kind: "direct"; readonly taskId: string; readonly mode: AgentMode; readonly result: Pick<AgentResult, "status" | "nonProgress"> }

export interface LearningStepResult {
  readonly ran: boolean
  readonly observations: number
  readonly report?: ObserveReport
  readonly proposedCandidates: number
  readonly staleMarked: number
  readonly error?: string
}

export async function runLearningStep(service: LearningService | undefined, input: LearningTaskInput, exists: (relativePath: string) => Promise<boolean>): Promise<LearningStepResult> {
  if (!service?.enabled) return { ran: false, observations: 0, proposedCandidates: 0, staleMarked: 0 }
  try {
    const staleMarked = await service.refreshStaleness()
    const observations = input.kind === "workflow" ? extractFromWorkflow(input.state) : extractFromDirectRun(input)
    // Toolchain facts only accompany a verified workflow task; a question never teaches anything.
    if (input.kind === "workflow" && input.state.status === "COMPLETE" && input.state.verification?.verdict === "READY") {
      observations.push(...(await extractToolchainFacts(input.state.taskId, exists)))
    }
    const report = await service.observe(observations)
    const { proposed } = await service.proposeSkills()
    return { ran: true, observations: observations.length, report, proposedCandidates: proposed.length, staleMarked }
  } catch (error) {
    return { ran: true, observations: 0, proposedCandidates: 0, staleMarked: 0, error: error instanceof Error ? error.message.slice(0, 200) : "learning step failed" }
  }
}
