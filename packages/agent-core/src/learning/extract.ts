/**
 * Deterministic learning extraction (Sprint 5D, ADR-032). Inputs are the compact, already-sanitized
 * artifacts a task leaves behind — never the dialogue, prompts, reasoning or file contents.
 *
 * Workflow tasks: a lesson needs VERIFY READY (or, for negative evidence, a recorded blocker).
 * Direct tasks are more conservative: only bounded non-progress evidence is considered, and
 * read-only questions (ASK/PLAN/REVIEW) never produce learning.
 */
import type { AgentMode, AgentResult } from "../contracts/agent.ts"
import type { WorkflowState } from "../workflow/contracts.ts"
import type { LearningObservation } from "./contracts.ts"
import { REPAIR_AGAINST_FAILING_ASSERTION, RESOLVE_GROUNDED_REVIEW_FINDING, recoveryPattern, type PatternTemplate } from "./patterns.ts"

const MUTATING_MODES: ReadonlySet<AgentMode> = new Set(["BUILD", "DEBUG"])

function fromTemplate(template: PatternTemplate, taskId: string, outcome: LearningObservation["outcome"], evidenceRefs: readonly string[], mode: AgentMode): LearningObservation {
  return {
    kind: "REUSABLE_PATTERN",
    source: "OBSERVED_OUTCOME",
    patternKey: template.patternKey,
    title: template.title,
    summary: template.summary,
    evidenceRefs,
    taskId,
    outcome,
    tags: template.tags,
    modes: [mode],
  }
}

/** Learning extracted from a terminal workflow state. Pure; returns nothing for non-terminal states. */
export function extractFromWorkflow(state: WorkflowState): LearningObservation[] {
  const observations: LearningObservation[] = []
  const ref = (part: string) => `workflow:${state.workflowId}#${part}`
  const verified = state.status === "COMPLETE" && state.verification?.verdict === "READY"
  const blocked = state.status === "BLOCKED"
  if (!verified && !blocked) return observations

  // Repair against the failing assertion: TEST failed at least once, a repair followed.
  if (state.retryCounts.testRepairs > 0) {
    observations.push(fromTemplate(REPAIR_AGAINST_FAILING_ASSERTION, state.taskId, verified ? "SUCCESS" : "FAILURE", verified ? [ref("TEST"), ref("VERIFY")] : [ref("TEST"), ref(`BLOCKED:${state.blocker ?? "UNKNOWN"}`)], state.mode))
  }
  // A grounded blocking review finding resolved by a targeted repair.
  if (state.retryCounts.reviewRepairs > 0 && state.reviews.some((review) => review.blocking > 0)) {
    observations.push(fromTemplate(RESOLVE_GROUNDED_REVIEW_FINDING, state.taskId, verified ? "SUCCESS" : "FAILURE", verified ? [ref("REVIEW"), ref("VERIFY")] : [ref("REVIEW"), ref(`BLOCKED:${state.blocker ?? "UNKNOWN"}`)], state.mode))
  }
  // 5C recovery evidence: only a settled recovery counts, either way.
  const candidate = state.progress?.patternCandidate
  if (candidate && (state.progress?.recoveryOutcome === "RECOVERED" || state.progress?.recoveryOutcome === "NOT_RECOVERED")) {
    const recovered = state.progress.recoveryOutcome === "RECOVERED" && verified
    observations.push(fromTemplate(recoveryPattern(candidate.failureClass, candidate.check), state.taskId, recovered ? "SUCCESS" : "FAILURE", [ref("PROGRESS"), ref(recovered ? "VERIFY" : "BLOCKED")], state.mode))
  }
  // A recurring blocker: the non-progress report itself is a failure-pattern occurrence.
  const blocker = state.progress?.finalBlocker
  if (blocker) observations.push(failurePattern(blocker.failureClass, blocker.repeatedPattern, state.taskId, [ref("PROGRESS:BLOCKED_NON_PROGRESS")], state.mode))

  // Acceptance-critical environment fact: the verification commands that made this task READY.
  if (verified) {
    for (const outcome of state.verification?.outcomes ?? []) {
      if (outcome.status !== "PASS" || !outcome.command) continue
      observations.push({
        kind: "PROJECT_FACT",
        source: "OBSERVED_OUTCOME",
        patternKey: `project:verify-command:${outcome.command}`,
        title: `Verification command \`${outcome.command}\` passes for this project`,
        summary: `\`${outcome.command}\` (${outcome.action}) is the check that made a verified task READY.`,
        evidenceRefs: [ref("VERIFY")],
        taskId: state.taskId,
        outcome: "SUCCESS",
        tags: ["verification", "toolchain"],
        modes: [state.mode],
      })
    }
  }
  return observations
}

function failurePattern(failureClass: string, repeatedPattern: string, taskId: string, evidenceRefs: readonly string[], mode: AgentMode): LearningObservation {
  const label = failureClass.toLowerCase().replace(/_/g, " ")
  return {
    kind: "FAILURE_PATTERN",
    source: "OBSERVED_OUTCOME",
    patternKey: `failure:${failureClass}`,
    title: `Repeated attempts stalled with a ${label}`,
    summary: `Work stopped making progress (${label}): ${repeatedPattern}`,
    evidenceRefs,
    taskId,
    // For a failure pattern an "occurrence" is a confirmed instance of the failure.
    outcome: "SUCCESS",
    tags: ["non-progress", failureClass.toLowerCase()],
    modes: [mode],
  }
}

/** Direct (non-workflow) runs: only strong, bounded non-progress evidence from mutating modes. */
export function extractFromDirectRun(input: { readonly taskId: string; readonly mode: AgentMode; readonly result: Pick<AgentResult, "status" | "nonProgress"> }): LearningObservation[] {
  if (!MUTATING_MODES.has(input.mode)) return []
  const evidence = input.result.nonProgress
  if (!evidence) return []
  const observations: LearningObservation[] = []
  const ref = (part: string) => `direct:${input.taskId}#${part}`
  const plan = evidence.recoveryPlan
  if (plan && (evidence.recoveryOutcome === "RECOVERED" || evidence.recoveryOutcome === "NOT_RECOVERED")) {
    const recovered = evidence.recoveryOutcome === "RECOVERED" && input.result.status === "COMPLETED"
    observations.push(fromTemplate(recoveryPattern(plan.failureClass, plan.discriminatingCheck), input.taskId, recovered ? "SUCCESS" : "FAILURE", [ref("PROGRESS"), ref(input.result.status)], input.mode))
  }
  if (evidence.finalBlocker) observations.push(failurePattern(evidence.finalBlocker.failureClass, evidence.finalBlocker.repeatedPattern, input.taskId, [ref("BLOCKED_NON_PROGRESS")], input.mode))
  return observations
}

/** Toolchain facts from lockfiles. The lockfile path is the evidence; deleting it makes the fact STALE. */
const LOCKFILES: readonly { readonly file: string; readonly tool: string }[] = [
  { file: "pnpm-lock.yaml", tool: "pnpm" },
  { file: "yarn.lock", tool: "yarn" },
  { file: "package-lock.json", tool: "npm" },
  { file: "bun.lockb", tool: "bun" },
  { file: "Cargo.lock", tool: "cargo" },
  { file: "poetry.lock", tool: "poetry" },
]

export async function extractToolchainFacts(taskId: string, exists: (relativePath: string) => Promise<boolean>): Promise<LearningObservation[]> {
  const observations: LearningObservation[] = []
  for (const { file, tool } of LOCKFILES) {
    if (!(await exists(file))) continue
    observations.push({
      kind: "PROJECT_FACT",
      source: "OBSERVED_OUTCOME",
      patternKey: `project:toolchain:${tool}`,
      title: `This project uses ${tool}`,
      summary: `Install and run scripts with ${tool}; ${file} is present at the workspace root.`,
      evidenceRefs: [`file:${file}`],
      taskId,
      outcome: "SUCCESS",
      tags: ["toolchain", tool],
      relevantPaths: [file],
    })
  }
  return observations
}
