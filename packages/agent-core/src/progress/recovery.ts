/**
 * Diagnostic recovery (Sprint 5C, ADR-031). Pattern after ECC's agent-introspection-debugging
 * (REFERENCE_ONLY, MIT): capture → classify → run one discriminating check → only then retry.
 *
 * Everything here is deterministic and works on bounded evidence. Classification never claims more
 * certainty than the evidence supports: ambiguous evidence is UNKNOWN and escalates.
 */
import { connect } from "node:net"

import { redactRuntimeEvalSecrets } from "../runtime-evals/evidence.ts"
import type { VerificationStatus } from "../tools/verification-contracts.ts"
import type { EngineeringStage } from "../workflow/contracts.ts"
import {
  PROGRESS_LIMITS,
  type DiagnosticCheckKind,
  type FailureClass,
  type FailurePatternCandidate,
  type NonProgressRecoveryPlan,
  type NonProgressReport,
  type ProgressSignal,
} from "./contracts.ts"
import { normalizeFailureOutput } from "./fingerprint.ts"

export function boundRecoveryText(text: string | undefined, max: number = PROGRESS_LIMITS.textChars): string {
  if (!text) return ""
  const clean = redactRuntimeEvalSecrets(text.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, "")).trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

// ---- Failure capture ------------------------------------------------------------------------------

/** Bounded, observed facts about a stall. Built by the engine from its own state, never from the model. */
export interface FailureCapture {
  readonly stage: EngineeringStage | "DIRECT"
  readonly signals: readonly ProgressSignal[]
  /** Bounded, redacted excerpt of the latest failure output or blocking finding. */
  readonly failureText?: string
  readonly checkStatuses?: readonly VerificationStatus[]
  readonly permissionOutcome?: "DENIED" | "REJECTED"
  readonly toolErrorCategories?: readonly string[]
  readonly modelFailure?: boolean
  readonly contextPressure?: boolean
}

const PERMISSION_TEXT = /\b(permission (policy )?denied|not approved|EACCES|EPERM|operation not permitted)\b/i
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\])$/i
const CONNECTION = /\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|connect(ion)? refused|socket hang up)\b/i
const EXTERNAL = /\b(429|too many requests|rate[- ]limit(ed)?|quota exceeded|ENOTFOUND|getaddrinfo|EAI_AGAIN|503 service unavailable|502 bad gateway)\b/i
const MISSING_DEP = /\b(command not found|spawn \S+ ENOENT|MODULE_NOT_FOUND|Cannot find (module|package) '[^./][^']*'|No module named|ERR_MODULE_NOT_FOUND|EADDRINUSE)\b/i

export interface Endpoint {
  readonly host: string
  readonly port: number
}

/** First host:port mentioned in the failure text, if any (e.g. "connect ECONNREFUSED 127.0.0.1:5432"). */
export function extractEndpoint(text: string | undefined): Endpoint | undefined {
  if (!text) return undefined
  const match = text.match(/\b(?:https?:\/\/)?(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+):(\d{2,5})\b/i)
  if (!match) return undefined
  return { host: match[1]!, port: Number(match[2]) }
}

export interface PreliminaryClassification {
  readonly failureClass: FailureClass
  readonly hypothesis: string
  readonly check: DiagnosticCheckKind
  readonly checkDescription: string
}

/**
 * Ordered, deterministic rules. The first matching rule wins; the discriminating check is chosen to
 * confirm or refute exactly that hypothesis.
 */
export function classifyStall(capture: FailureCapture): PreliminaryClassification {
  const text = capture.failureText ?? ""
  const kinds = new Set(capture.signals.map((signal) => signal.kind))
  const categories = new Set(capture.toolErrorCategories ?? [])
  if (capture.permissionOutcome || categories.has("PERMISSION_DENIED") || categories.has("PERMISSION_REJECTED") || PERMISSION_TEXT.test(text)) {
    return { failureClass: "PERMISSION_BLOCK", hypothesis: "the next step needs an action the permission policy or the user did not allow", check: "PERMISSION_OUTCOME", checkDescription: "inspect the recorded permission outcome" }
  }
  const endpoint = extractEndpoint(text)
  if (EXTERNAL.test(text) || (CONNECTION.test(text) && endpoint && !LOOPBACK.test(endpoint.host))) {
    return { failureClass: "EXTERNAL_BLOCKER", hypothesis: "an external service is unavailable or rate-limiting", check: "ENDPOINT_PROBE", checkDescription: endpoint ? `classify endpoint ${endpoint.host}:${endpoint.port} (external hosts are never probed)` : "classify the external dependency" }
  }
  if (CONNECTION.test(text) || MISSING_DEP.test(text) || capture.checkStatuses?.some((status) => status === "EXECUTION_ERROR" || status === "TIMEOUT")) {
    return {
      failureClass: "ENVIRONMENT_FAILURE",
      hypothesis: CONNECTION.test(text) ? "a local service the task depends on is not running" : "a dependency, command or port the checks need is unavailable",
      check: CONNECTION.test(text) && endpoint ? "ENDPOINT_PROBE" : "WORKSPACE_STATE",
      checkDescription: CONNECTION.test(text) && endpoint ? `probe ${endpoint.host}:${endpoint.port} once` : "check that the referenced files and dependencies exist",
    }
  }
  if (categories.has("INVALID_ARGUMENTS") || categories.has("UNKNOWN_TOOL") || categories.has("TOOL_PREPARATION_ERROR") || categories.has("TOOL_RUNTIME_ERROR")) {
    return { failureClass: "TOOL_FAILURE", hypothesis: "the tool call does not match the tool's input contract or the tool is unavailable", check: "TOOL_CONTRACT", checkDescription: "validate tool availability and its input contract" }
  }
  if (capture.modelFailure) {
    return { failureClass: "MODEL_FAILURE", hypothesis: "the model repeatedly produced output the stage cannot use", check: "CONTEXT_COMPACTION", checkDescription: "rebuild a compact context from allow-listed state" }
  }
  if (kinds.has("REPEATED_TOOL_ACTION") || kinds.has("CONTEXT_BURN") || capture.contextPressure) {
    return { failureClass: "CONTEXT_DEGRADATION", hypothesis: "the run is repeating actions without gaining evidence", check: "CONTEXT_COMPACTION", checkDescription: "rebuild a compact context from allow-listed state and drop repeated observations" }
  }
  if (kinds.has("DIFF_STAGNATION")) {
    return { failureClass: "STATE_MISMATCH", hypothesis: "edits are not changing the workspace (no-op or wrong target)", check: "WORKSPACE_STATE", checkDescription: "re-hash the changed files and compare with the recorded state" }
  }
  if (kinds.has("REVIEW_STAGNATION")) {
    return { failureClass: "LOGIC_FAILURE", hypothesis: "the repair did not change the code the blocking finding quotes", check: "REVIEW_EVIDENCE", checkDescription: "check whether the quoted evidence is still present in the current file" }
  }
  if (kinds.has("TEST_STAGNATION") || kinds.has("REPAIR_LOOP_STAGNATION") || kinds.has("REPEATED_ERROR")) {
    return { failureClass: "LOGIC_FAILURE", hypothesis: "the repair targeted the wrong code: the failing assertion is unchanged", check: "FAILING_ASSERTION", checkDescription: "inspect the exact failing assertion and whether the last repair touched the code it exercises" }
  }
  return { failureClass: "UNKNOWN", hypothesis: "insufficient evidence to choose a hypothesis", check: "WORKSPACE_STATE", checkDescription: "check that the workspace matches the recorded state" }
}

// ---- The one discriminating check -----------------------------------------------------------------

export interface DiagnosticContext {
  readonly capture: FailureCapture
  /** path → hash the engine last recorded for it. */
  readonly expectedHashes?: Readonly<Record<string, string>>
  /** Reads the current hash of a workspace file (undefined when missing). Read-only. */
  readonly currentHash?: (path: string) => Promise<string | undefined>
  /** Paths the last implementation pass changed. */
  readonly lastPassPaths?: readonly string[]
  /** For REVIEW_EVIDENCE: quoted evidence and the current content of its file. */
  readonly reviewEvidence?: { readonly file: string; readonly quote: string; readonly currentContent?: string }
  /** Tool names in the stage registry and the failing tool, for TOOL_CONTRACT. */
  readonly tools?: { readonly available: readonly string[]; readonly failing?: string; readonly required?: readonly string[] }
  /** Loopback-only probe; injectable for tests. */
  readonly probe?: (endpoint: Endpoint) => Promise<boolean>
}

export interface DiagnosticResult {
  readonly observed: string
  /** A class the check proved, replacing the preliminary one. */
  readonly refinedClass?: FailureClass
  /** True when the check could not discriminate, so the diagnosis stays ambiguous. */
  readonly inconclusive?: boolean
}

/** Default probe: one TCP connect to a loopback host, 1s timeout. Never contacts a non-local host. */
export function probeLoopback(endpoint: Endpoint, timeoutMs = 1_000): Promise<boolean> {
  if (!LOOPBACK.test(endpoint.host)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.host.replace(/^\[|\]$/g, ""), port: endpoint.port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

function assertionLines(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split("\n")
    .filter((line) => /\b(assert|expected|actual|received|toBe|toEqual|AssertionError|Error:|FAIL|not ok|✖)\b/i.test(line))
    .map((line) => line.trim())
    .slice(0, 4)
}

export async function runDiagnosticCheck(kind: DiagnosticCheckKind, context: DiagnosticContext): Promise<DiagnosticResult> {
  const capture = context.capture
  switch (kind) {
    case "PERMISSION_OUTCOME":
      return {
        observed: capture.permissionOutcome
          ? `permission outcome recorded: ${capture.permissionOutcome}`
          : "the failure output reports a denied operation",
        refinedClass: "PERMISSION_BLOCK",
      }
    case "ENDPOINT_PROBE": {
      const endpoint = extractEndpoint(capture.failureText)
      if (!endpoint) return { observed: "no endpoint found in the failure output", inconclusive: true }
      if (!LOOPBACK.test(endpoint.host)) return { observed: `external host ${endpoint.host} is outside the workspace; not probed`, refinedClass: "EXTERNAL_BLOCKER" }
      const up = await (context.probe ?? probeLoopback)(endpoint)
      return up
        ? { observed: `${endpoint.host}:${endpoint.port} accepts connections now`, inconclusive: true }
        : { observed: `${endpoint.host}:${endpoint.port} refused the connection`, refinedClass: "ENVIRONMENT_FAILURE" }
    }
    case "WORKSPACE_STATE": {
      const expected = Object.entries(context.expectedHashes ?? {})
      if (!context.currentHash || expected.length === 0) return { observed: "no recorded workspace state to compare", inconclusive: true }
      const missing: string[] = []
      const diverged: string[] = []
      for (const [path, hash] of expected) {
        const current = await context.currentHash(path)
        if (current === undefined) missing.push(path)
        else if (current !== hash) diverged.push(path)
      }
      if (missing.length > 0 || diverged.length > 0) {
        return { observed: boundRecoveryText(`${missing.length ? `missing: ${missing.join(", ")}` : ""}${missing.length && diverged.length ? "; " : ""}${diverged.length ? `changed outside the run: ${diverged.join(", ")}` : ""}`), refinedClass: "STATE_MISMATCH" }
      }
      return capture.signals.some((signal) => signal.kind === "DIFF_STAGNATION")
        ? { observed: `all ${expected.length} changed file(s) match the recorded state; the last pass did not change them`, refinedClass: "STATE_MISMATCH" }
        : { observed: `all ${expected.length} changed file(s) match the recorded state`, inconclusive: capture.signals.length === 0 }
    }
    case "FAILING_ASSERTION": {
      const lines = assertionLines(capture.failureText)
      const touched = context.lastPassPaths ?? []
      const mentioned = touched.filter((path) => (capture.failureText ?? "").includes(path.split("/").pop()!.replace(/\.[^.]+$/, "")))
      if (lines.length === 0) return { observed: "no assertion text in the bounded failure output", inconclusive: true }
      return {
        observed: boundRecoveryText(`unchanged failing assertion: ${normalizeFailureOutput(lines.join(" | "))}; last repair touched ${touched.length ? touched.join(", ") : "no files"}${mentioned.length ? ` (failure names ${mentioned.join(", ")})` : ""}`),
        refinedClass: "LOGIC_FAILURE",
      }
    }
    case "REVIEW_EVIDENCE": {
      const evidence = context.reviewEvidence
      if (!evidence) return { observed: "no blocking finding to inspect", inconclusive: true }
      const present = evidence.currentContent !== undefined && evidence.currentContent.replace(/\s+/g, " ").includes(evidence.quote.replace(/\s+/g, " ").trim())
      return present
        ? { observed: boundRecoveryText(`the quoted code is still present in ${evidence.file}: "${evidence.quote}"`), refinedClass: "LOGIC_FAILURE" }
        : { observed: `the quoted code is no longer in ${evidence.file}; the finding does not match the current state`, refinedClass: "STATE_MISMATCH" }
    }
    case "TOOL_CONTRACT": {
      const tools = context.tools
      if (!tools) return { observed: "no tool registry available", inconclusive: true }
      if (tools.failing && !tools.available.includes(tools.failing)) return { observed: `tool "${tools.failing}" is not available in this stage; available: ${tools.available.slice(0, 12).join(", ")}`, refinedClass: "TOOL_FAILURE" }
      return { observed: boundRecoveryText(`tool "${tools.failing ?? "?"}" is available${tools.required?.length ? `; required arguments: ${tools.required.join(", ")}` : ""}`), refinedClass: "TOOL_FAILURE" }
    }
    case "CONTEXT_COMPACTION":
      return { observed: "context rebuilt from allow-listed state; repeated observations dropped", refinedClass: capture.modelFailure ? "MODEL_FAILURE" : "CONTEXT_DEGRADATION" }
  }
}

// ---- Plan -----------------------------------------------------------------------------------------

const NO_RETRY: ReadonlySet<FailureClass> = new Set(["PERMISSION_BLOCK", "ENVIRONMENT_FAILURE", "EXTERNAL_BLOCKER", "STATE_MISMATCH", "UNKNOWN"])

const CORRECTIVE: Readonly<Record<FailureClass, string>> = {
  LOGIC_FAILURE: "re-derive the bug from the failing assertion and change the code it exercises; do not repeat the previous edit",
  VERIFICATION_FAILURE: "fix the specific failed check named in the evidence",
  CONTEXT_DEGRADATION: "continue from the compact context; take one new action that gathers missing evidence",
  TOOL_FAILURE: "call the tool with arguments that match its input contract",
  MODEL_FAILURE: "answer in the required output format from the compact context",
  STATE_MISMATCH: "reconcile the workspace with the recorded state before any further edit",
  ENVIRONMENT_FAILURE: "start or install the missing service or dependency",
  PERMISSION_BLOCK: "grant the required permission or choose an allowed approach",
  EXTERNAL_BLOCKER: "wait for or restore the external service",
  UNKNOWN: "inspect the evidence and decide how to proceed",
}

const HUMAN_ACTION: Readonly<Record<FailureClass, string>> = {
  LOGIC_FAILURE: "Inspect the failing assertion and the changed code; the automated repairs did not change the outcome.",
  VERIFICATION_FAILURE: "Inspect the failing verification check and fix it manually.",
  CONTEXT_DEGRADATION: "Narrow the task (one file or one failing test) and run it again.",
  TOOL_FAILURE: "Check that the required tool is available and configured for this workspace.",
  MODEL_FAILURE: "Retry with a more capable local model or a smaller task.",
  STATE_MISMATCH: "Check the workspace (git status, files changed outside the run) and restart the task.",
  ENVIRONMENT_FAILURE: "Start or install the missing local service or dependency, then run the task again.",
  PERMISSION_BLOCK: "Approve the required action or adjust the permission policy, then run the task again.",
  EXTERNAL_BLOCKER: "Restore access to the external service, then run the task again.",
  UNKNOWN: "Review the evidence below and decide how to proceed; the bounded check was inconclusive.",
}

export function buildRecoveryPlan(input: {
  readonly capture: FailureCapture
  readonly preliminary: PreliminaryClassification
  readonly result?: DiagnosticResult
  /** False when the run's repair budget or the recovery bound is already spent. */
  readonly budgetAvailable: boolean
}): NonProgressRecoveryPlan {
  const failureClass = input.result?.inconclusive && NO_RETRY.has(input.preliminary.failureClass)
    ? "UNKNOWN"
    : (input.result?.refinedClass ?? input.preliminary.failureClass)
  const ambiguous = failureClass === "UNKNOWN"
  const retryAllowed = input.budgetAvailable && !NO_RETRY.has(failureClass)
  const escalationReason = retryAllowed
    ? undefined
    : !input.budgetAvailable
      ? "the bounded recovery attempt or repair budget is already used"
      : ambiguous
        ? "the diagnosis is still ambiguous after the bounded check"
        : `${failureClass} cannot be fixed by retrying inside this task`
  return {
    detectedSignals: input.capture.signals,
    failureClass,
    hypothesis: boundRecoveryText(input.preliminary.hypothesis),
    discriminatingCheck: input.preliminary.check,
    checkDescription: boundRecoveryText(input.preliminary.checkDescription),
    ...(input.result ? { observedResult: boundRecoveryText(input.result.observed) } : {}),
    ...(retryAllowed ? { correctiveAction: CORRECTIVE[failureClass] } : {}),
    retryAllowed,
    ...(escalationReason ? { escalationReason } : {}),
  }
}

export function describeSignals(signals: readonly ProgressSignal[]): string {
  return boundRecoveryText(signals.map((signal) => `${signal.pattern} (${signal.count}×)`).join("; ") || "no progress", PROGRESS_LIMITS.patternChars)
}

export function buildNonProgressReport(plan: NonProgressRecoveryPlan, lastEvidence: string, result: string): NonProgressReport {
  return {
    kind: "BLOCKED_NON_PROGRESS",
    failureClass: plan.failureClass,
    repeatedPattern: describeSignals(plan.detectedSignals),
    lastEvidence: boundRecoveryText(lastEvidence) || "(none recorded)",
    diagnosticCheck: plan.checkDescription,
    result: boundRecoveryText(result),
    recommendedHumanAction: HUMAN_ACTION[plan.failureClass],
  }
}

export function patternCandidate(plan: NonProgressRecoveryPlan, recovered: boolean): FailurePatternCandidate {
  return { failureClass: plan.failureClass, signals: [...new Set(plan.detectedSignals.map((signal) => signal.kind))], check: plan.discriminatingCheck, recovered }
}

/** User-facing lines. No fingerprints, internal reasoning or telemetry. */
export function formatNonProgressReport(report: NonProgressReport): string {
  return [
    "Blocked after bounded recovery",
    "",
    `Reason: ${report.repeatedPattern}`,
    `Failure class: ${report.failureClass}`,
    `Last evidence: ${report.lastEvidence}`,
    `Diagnostic: ${report.diagnosticCheck} → ${report.result}`,
    `Recommended next action: ${report.recommendedHumanAction}`,
  ].join("\n")
}

export function stallNotice(signals: readonly ProgressSignal[]): string {
  const kind = signals[0]?.kind
  const what = kind === "TEST_STAGNATION" ? "repeated test failure"
    : kind === "REVIEW_STAGNATION" ? "repeated review blocker"
      : kind === "DIFF_STAGNATION" ? "edits that do not change the workspace"
        : kind === "REPEATED_TOOL_ACTION" ? "repeated identical tool calls"
          : kind === "REPEATED_ERROR" ? "a repeated error"
            : kind === "CONTEXT_BURN" ? "turns without new evidence"
              : "repair cycles without improvement"
  return `No progress detected\nDiagnosing ${what}…`
}

// ---- Compact recovery context ---------------------------------------------------------------------

/** Allow-listed recovery inputs. Nothing else (history, prior hypotheses, transcripts) can reach it. */
export interface RecoveryContextInput {
  readonly task: string
  readonly stage: string
  readonly acceptanceCriteria: readonly string[]
  /** The single latest relevant artifact: the current failing check excerpt or the surviving finding. */
  readonly latestArtifact: string
  readonly failureFingerprint?: string
  readonly lastMeaningfulAction: string
  readonly workspaceHashes: Readonly<Record<string, string>>
  readonly plan: NonProgressRecoveryPlan
}

export function buildRecoveryContext(input: RecoveryContextInput): string {
  const hashes = Object.entries(input.workspaceHashes).toSorted(([a], [b]) => a.localeCompare(b)).slice(0, 12)
  const criteria = input.acceptanceCriteria.slice(0, 12).map((item) => `- ${boundRecoveryText(item)}`)
  const text = [
    `## Task\n${boundRecoveryText(input.task, 1_000)}`,
    ...(criteria.length ? [`## Acceptance criteria\n${criteria.join("\n")}`] : []),
    `## Recovery (one bounded attempt)`,
    `Signal: ${describeSignals(input.plan.detectedSignals)}`,
    `Failure class: ${input.plan.failureClass}`,
    `Hypothesis: ${input.plan.hypothesis}`,
    `Diagnostic check: ${input.plan.checkDescription}`,
    `Observed: ${input.plan.observedResult ?? "(not run)"}`,
    `Corrective action: ${input.plan.correctiveAction ?? "(none)"}`,
    ``,
    `## Current stage\n${input.stage}`,
    `## Last meaningful action\n${boundRecoveryText(input.lastMeaningfulAction)}`,
    `## Latest evidence${input.failureFingerprint ? ` (fingerprint ${input.failureFingerprint})` : ""}\n${boundRecoveryText(input.latestArtifact, 1_200)}`,
    `## Current workspace\n${hashes.length ? hashes.map(([path, hash]) => `- ${path} @ ${hash.slice(0, 12)}`).join("\n") : "- (no changed files)"}`,
  ].join("\n")
  return text.length <= PROGRESS_LIMITS.recoveryContextChars ? text : `${text.slice(0, PROGRESS_LIMITS.recoveryContextChars - 1)}…`
}
