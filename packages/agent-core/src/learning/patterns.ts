/**
 * Recognised reusable patterns (Sprint 5D, ADR-032). Extraction is deterministic: a completed task
 * either shows the observable sequence of a known pattern or it does not. What is *learned* is the
 * counted, independent evidence that the pattern holds in practice. The guidance text is curated
 * here, reviewed like any other code, and only becomes a skill after explicit human approval.
 */
import type { DiagnosticCheckKind, FailureClass } from "../progress/contracts.ts"
import type { SkillCategory } from "../skills/contracts.ts"

export interface PatternTemplate {
  readonly patternKey: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly skill: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly category: SkillCategory
    readonly intent: string
    readonly whenToUse: string
    readonly inputs: string
    readonly workflow: readonly string[]
    readonly verification: readonly string[]
    readonly failureModes: readonly string[]
    readonly exitCriteria: readonly string[]
    readonly triggers: readonly string[]
    readonly capabilities: readonly string[]
    readonly tools: readonly string[]
    readonly modes: readonly string[]
  }
}

export const REPAIR_AGAINST_FAILING_ASSERTION: PatternTemplate = {
  patternKey: "reusable:repair-against-failing-assertion",
  title: "Repair against the exact failing assertion before re-running checks",
  summary: "After a failing check, isolate the failing assertion, change only the code it exercises, then re-run the same check; verified tasks reached READY this way.",
  tags: ["test", "repair", "debugging"],
  skill: {
    id: "failing-assertion-repair",
    name: "Failing Assertion Repair",
    description: "Repair a failing check by isolating the exact failing assertion first, then re-running the same check.",
    category: "debugging",
    intent: "Turn a failing check into a passing one with the smallest change that the failing assertion justifies.",
    whenToUse: "A test or check fails after an implementation change and the failure output names a specific assertion.",
    inputs: "The failing check command, its bounded failure output, and the files the failing assertion exercises.",
    workflow: [
      "Read the failure output and name the single failing assertion and its expected versus actual value.",
      "Open only the code that the failing assertion exercises.",
      "State one hypothesis that explains the difference between expected and actual.",
      "Make the smallest change that tests the hypothesis.",
      "Re-run the same check, not a broader one, and compare the failure count.",
    ],
    verification: ["The same check passes, or its failure count drops.", "No previously passing check now fails."],
    failureModes: ["Changing code the failing assertion does not exercise.", "Editing the test to match wrong behaviour.", "Re-running without a change and expecting a different result."],
    exitCriteria: ["The originally failing check passes and the full verification is READY, or the remaining failure is reported with its evidence."],
    triggers: ["failing test", "assertion", "test failure", "red test"],
    capabilities: ["read", "search", "write", "verify"],
    tools: ["read_file", "search_text"],
    modes: ["BUILD", "DEBUG"],
  },
}

export const RESOLVE_GROUNDED_REVIEW_FINDING: PatternTemplate = {
  patternKey: "reusable:resolve-grounded-review-finding",
  title: "Resolve a grounded review finding with a targeted repair, then re-review",
  summary: "A fresh-context review raised a grounded blocking finding; a repair limited to that finding cleared it and verification reached READY.",
  tags: ["review", "repair", "verification"],
  skill: {
    id: "review-finding-repair",
    name: "Review Finding Repair",
    description: "Repair exactly the blocking finding a grounded review raised, then re-run review and verification.",
    category: "verification",
    intent: "Clear a blocking review finding without widening the change.",
    whenToUse: "A review produced a BLOCKER or HIGH finding that cites a file, a location and evidence.",
    inputs: "The finding (file, location, claim, evidence, recommended action) and the current net diff.",
    workflow: [
      "Re-read the cited location and confirm the evidence still holds in the current content.",
      "Change only what the finding's recommended action requires.",
      "Re-run the checks that cover the changed lines.",
      "Request a fresh review of the net diff.",
    ],
    verification: ["The finding no longer reproduces against the current content.", "Verification is READY."],
    failureModes: ["Rewriting unrelated code while fixing the finding.", "Arguing with a grounded finding instead of checking its evidence."],
    exitCriteria: ["No blocking finding remains and verification is READY."],
    triggers: ["review finding", "blocking finding", "code review"],
    capabilities: ["read", "search", "write"],
    tools: ["read_file", "search_text"],
    modes: ["BUILD", "DEBUG"],
  },
}

const CHECK_LABEL: Readonly<Record<DiagnosticCheckKind, string>> = {
  FAILING_ASSERTION: "isolate the failing assertion",
  WORKSPACE_STATE: "re-read the workspace state the plan assumes",
  ENDPOINT_PROBE: "probe the local endpoint once",
  PERMISSION_OUTCOME: "inspect the permission outcome",
  TOOL_CONTRACT: "check the tool's required arguments",
  REVIEW_EVIDENCE: "re-check the review evidence against current content",
  CONTEXT_COMPACTION: "compact the context to distinct evidence",
}

/** A 5C recovery that demonstrably worked: "on a <class> stall, run <check> once before retrying". */
export function recoveryPattern(failureClass: FailureClass, check: DiagnosticCheckKind): PatternTemplate {
  const slug = failureClass.toLowerCase().replace(/_/g, "-")
  const label = CHECK_LABEL[check]
  return {
    patternKey: `reusable:recovery:${failureClass}:${check}`,
    title: `On a ${failureClass.toLowerCase().replace(/_/g, " ")} stall, ${label} before retrying`,
    summary: `When repeated attempts stopped making progress (${failureClass}), one discriminating check (${label}) preceded a recovery that produced new evidence.`,
    tags: ["recovery", "non-progress", slug],
    skill: {
      id: `${slug}-recovery`,
      name: `${failureClass.charAt(0)}${failureClass.slice(1).toLowerCase().replace(/_/g, " ")} Recovery`.slice(0, 60),
      description: `When work stalls with a ${failureClass.toLowerCase().replace(/_/g, " ")}, ${label} once before retrying.`.slice(0, 200),
      category: "debugging",
      intent: "Break a non-progress loop with one discriminating check instead of another identical attempt.",
      whenToUse: `The same action or failure has repeated and the evidence points to a ${failureClass.toLowerCase().replace(/_/g, " ")}.`,
      inputs: "The repeated action or failure, its bounded output, and the last state that changed.",
      workflow: [
        "Stop repeating the previous action.",
        `Run one discriminating check: ${label}.`,
        "State what the check showed and the single corrective action it justifies.",
        "Take that action once and compare observable state with the previous attempt.",
      ],
      verification: ["Observable state changed after the corrective action (a new result, fewer failures, or a changed file)."],
      failureModes: ["Retrying the identical action after the check.", "Running several speculative checks instead of one."],
      exitCriteria: ["Progress resumed, or the stall is reported with the check's result and a recommended human action."],
      triggers: ["stuck", "loop", "no progress", "same error"],
      capabilities: ["read", "search", "verify"],
      tools: ["read_file", "search_text"],
      modes: ["BUILD", "DEBUG"],
    },
  }
}

export function templateFor(patternKey: string | undefined): PatternTemplate | undefined {
  if (!patternKey) return undefined
  if (patternKey === REPAIR_AGAINST_FAILING_ASSERTION.patternKey) return REPAIR_AGAINST_FAILING_ASSERTION
  if (patternKey === RESOLVE_GROUNDED_REVIEW_FINDING.patternKey) return RESOLVE_GROUNDED_REVIEW_FINDING
  const recovery = /^reusable:recovery:([A-Z_]+):([A-Z_]+)$/.exec(patternKey)
  if (recovery) return recoveryPattern(recovery[1] as FailureClass, recovery[2] as DiagnosticCheckKind)
  return undefined
}
