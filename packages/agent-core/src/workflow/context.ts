/**
 * Stage context envelopes. Each stage instruction is rebuilt from the persisted workflow artifacts;
 * no stage receives another stage's conversation. The REVIEW envelope is the fresh-context boundary:
 * its inputs are an explicit allow-list, so implementation dialogue, reasoning, tool observations and
 * self-justifications cannot reach it by construction.
 */
import { boundText, renderDiff, renderPlan, uniquePaths } from "./artifacts.ts"
import { ARTIFACT_LIMITS, type PlanArtifact, type TestEvidence, type WorkflowState } from "./contracts.ts"

const list = (items: readonly string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)")

function header(stage: string): string {
  return `[Engineering workflow · ${stage} stage]`
}

export interface StageContextInputs {
  readonly task: string
  /** Bounded essential project memory (facts/decisions); never a transcript. */
  readonly memoryDigest?: string
  /** Bounded architecture/security constraints for REVIEW. */
  readonly constraints?: string
}

export function planInstruction(inputs: StageContextInputs): string {
  return [
    header("PLAN"),
    "Read the repository as needed, then produce a compact implementation plan. Do not change any file.",
    `## Task\n${inputs.task}`,
    ...(inputs.memoryDigest ? [`## Project memory\n${inputs.memoryDigest}`] : []),
    [
      "## Output",
      "Reply with one JSON object and nothing else:",
      '```json\n{"goal": "...", "files": ["path"], "steps": ["..."], "tests": ["..."], "risks": ["..."], "acceptanceCriteria": ["..."]}\n```',
      "Keep every entry to one short line. steps and acceptanceCriteria must not be empty.",
    ].join("\n"),
  ].join("\n\n")
}

function criteria(plan: PlanArtifact): string {
  return `## Acceptance criteria\n${list(plan.acceptanceCriteria)}`
}

export function implementInstruction(inputs: StageContextInputs, state: WorkflowState): string {
  const plan = state.plan!
  const changed = state.implementation ? uniquePaths(state.implementation.changedFiles) : []
  return [
    header(state.repairReason ? "IMPLEMENT (repair)" : "IMPLEMENT"),
    "Implement the approved plan with the editing tools. Every change goes through the normal approval flow. Do not run tests; the workflow runs them next. When done, reply with a one-paragraph summary of what you changed.",
    `## Task\n${inputs.task}`,
    criteria(plan),
    `## Approved plan\n${renderPlan(plan)}`,
    ...(inputs.memoryDigest ? [`## Project memory\n${inputs.memoryDigest}`] : []),
    ...(changed.length > 0 ? [`## Files already changed in this workflow\n${list(changed)}`] : []),
    ...(state.repairReason ? [`## Repair required\n${state.repairReason}`] : []),
  ].join("\n\n")
}

function testSummary(test: TestEvidence | undefined): string {
  if (!test?.attempted) return "No test run recorded."
  return test.outcomes.map((outcome) => `- ${outcome.action} \`${outcome.command}\`: ${outcome.status}`).join("\n")
}

/**
 * The fresh REVIEW envelope. Allowed inputs only: original task, acceptance criteria, approved plan,
 * final diff, changed-file list, test evidence and constraints.
 */
export function reviewInstruction(inputs: Pick<StageContextInputs, "task" | "constraints">, state: WorkflowState): string {
  const plan = state.plan!
  const changes = state.implementation?.changedFiles ?? []
  const diff = renderDiff(changes)
  return [
    header("REVIEW"),
    [
      "You are reviewing a patch another engineer wrote. You did not write it and have no stake in it.",
      "Use the read-only tools to inspect changed files and their callers if needed. You cannot change files.",
      "Check: acceptance criteria, correctness, regressions, security and permission boundaries, untested behaviour, unrelated or stale changes, unnecessary complexity, architecture drift. Ignore style preferences.",
      "Report a finding only if you can quote the exact text that proves it. Each finding needs: file (a changed file), evidence (a verbatim quote from the diff or that file), the concrete failure it causes, and a recommended action. Findings without a verbatim quote are discarded.",
      "Severity: BLOCKER (breaks the task or a security boundary), HIGH (likely bug or regression), MEDIUM, LOW, NOTE. Cosmetic issues are never BLOCKER or HIGH.",
      "A clean patch has no findings. NO_FINDINGS is a correct, expected answer; do not invent criticism.",
    ].join("\n"),
    `## Original task\n${inputs.task}`,
    criteria(plan),
    `## Approved plan\n${renderPlan(plan)}`,
    `## Changed files\n${list(uniquePaths(changes))}`,
    `## Diff${diff.truncated ? " (truncated; read the files for the rest)" : ""}\n${diff.text}`,
    `## Test evidence\n${testSummary(state.test)}`,
    ...(inputs.constraints ? [`## Constraints\n${inputs.constraints}`] : []),
    [
      "## Output",
      "Reply with one JSON object and nothing else:",
      '```json\n{"verdict": "NO_FINDINGS", "findings": []}\n```',
      "or",
      '```json\n{"verdict": "FINDINGS", "findings": [{"id": "F1", "severity": "HIGH", "file": "path", "location": "line or symbol", "claim": "...", "evidence": "verbatim quote", "recommendedAction": "..."}]}\n```',
    ].join("\n"),
  ].join("\n\n")
}

/** Bounded repair reason for a failed TEST. */
export function testRepairReason(test: TestEvidence): string {
  const failed = test.outcomes.filter((outcome) => outcome.status !== "PASS")
  return boundText(
    failed.map((outcome) => `${outcome.action} \`${outcome.command}\` → ${outcome.status}\n${outcome.excerpt}`).join("\n\n"),
    ARTIFACT_LIMITS.outputExcerptChars + 200,
  )
}

/** Bounded repair reason for blocking review findings. */
export function reviewRepairReason(state: WorkflowState): string {
  const review = state.reviews.at(-1)!
  return review.findings
    .filter((finding) => finding.severity === "BLOCKER" || finding.severity === "HIGH")
    .map((finding) => `[${finding.severity}] ${finding.file}${finding.location ? `:${finding.location}` : ""} — ${finding.claim}\nEvidence: ${finding.evidence}\nAction: ${finding.recommendedAction}`)
    .join("\n\n")
}
