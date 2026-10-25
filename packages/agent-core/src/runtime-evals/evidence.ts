import { createHash } from "node:crypto"
import type {
  BoundedActionRecord,
  BoundedEvidenceSummary,
  BoundedFailureRecord,
  BoundedMutationOutcome,
  BoundedProgressSignal,
  BoundedRouteSignal,
  BoundedSecuritySignal,
  BoundedVerificationOutcome,
  BoundedRecoveryEvidence,
  RuntimeEvidence,
  RuntimeEvidenceCounts,
} from "./contracts.ts"
import type { RecoveryPlan } from "../recovery/contracts.ts"

export const MAX_RECENT_ACTIONS = 20
export const MAX_TOOL_OUTCOMES = 20
export const MAX_MUTATION_OUTCOMES = 10
export const MAX_VERIFICATION_OUTCOMES = 10
export const MAX_SECURITY_SIGNALS = 10
export const MAX_UNRESOLVED_FAILURES = 10
export const MAX_ROUTE_SIGNALS = 20
export const MAX_PROGRESS_SIGNALS = 20
export const MAX_SUMMARY_SNIPPET_LENGTH = 300

export function redactRuntimeEvalSecrets(text: string): string {
  if (!text) return ""
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|secret|token|password|auth(?:orization)?)\s*[:=]\s*["']?)[^"'\s\n\r]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]+?-----END[A-Z\s]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/sk[-_][a-zA-Z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
    // Well-known provider token formats and upper-case .env style assignments (Sprint 5C).
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*[:=]\s*["']?)(?!\[REDACTED)[^"'\s]+/g, "$1[REDACTED]")
    // Formats found missing in Sprint 7D: quoted JSON keys, URL credentials, more
    // provider token prefixes, labelled access keys and cookie headers.
    .replace(/(["'][A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|auth(?:orization)?|credentials?|access[_-]?key)["']\s*:\s*["'])(?!\[REDACTED)[^"']+/gi, "$1[REDACTED]")
    // Bounded repetitions keep this linear on long runs such as "a.a.a.…".
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}@/gi, "$1[REDACTED]@")
    .replace(/\b(?:hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|rk_(?:live|test)_[A-Za-z0-9]{16,})/g, "[REDACTED_TOKEN]")
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "[REDACTED_WEBHOOK]")
    .replace(/(access[_-]?key(?:[_-]?id)?\s*[:=]\s*["']?)(?!\[REDACTED)[^"'\s]+/gi, "$1[REDACTED]")
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
}

export const redactEvalSecrets = redactRuntimeEvalSecrets

export function deterministicHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

export function computeEvidenceHash(evidence: RuntimeEvidence): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex")
}

function truncateBounded(text: string, maxLength = MAX_SUMMARY_SNIPPET_LENGTH): string {
  const sanitized = redactRuntimeEvalSecrets(text)
  if (sanitized.length <= maxLength) return sanitized
  return sanitized.slice(0, maxLength) + " [TRUNCATED]"
}

export interface RuntimeEvidenceCollectorOptions {
  readonly runId: string
  readonly taskGoal: string
  readonly plan?: readonly string[]
}

export class RuntimeEvidenceCollector {
  readonly #runId: string
  readonly #taskGoal: string
  #turnId = 0
  #evidenceVersion = 1
  #plan?: readonly string[] | undefined
  #currentStep?: string | undefined
  readonly #startedAt = new Date().toISOString()
  #updatedAt = new Date().toISOString()

  readonly #recentActions: BoundedActionRecord[] = []
  readonly #toolOutcomes: BoundedActionRecord[] = []
  readonly #mutationOutcomes: BoundedMutationOutcome[] = []
  readonly #verificationOutcomes: BoundedVerificationOutcome[] = []
  readonly #securitySignals: BoundedSecuritySignal[] = []
  readonly #unresolvedFailures = new Map<string, BoundedFailureRecord>()
  readonly #routeSignals: BoundedRouteSignal[] = []
  readonly #progressSignals: BoundedProgressSignal[] = []
  #recoveryEvidence?: BoundedRecoveryEvidence | undefined

  #actionCount = 0
  #failureCount = 0
  #mutationCount = 0
  #verificationCount = 0
  #securityDenialCount = 0
  #toolCallCount = 0
  #duplicateReadCount = 0

  readonly #readFilesSinceLastMutation = new Set<string>()
  readonly #evaluatedCheckpoints = new Set<string>()

  constructor(options: RuntimeEvidenceCollectorOptions) {
    this.#runId = options.runId
    this.#taskGoal = truncateBounded(options.taskGoal, 500)
    this.#plan = options.plan ? options.plan.map((s) => truncateBounded(s, 200)) : undefined
  }

  get runId(): string {
    return this.#runId
  }

  get turnId(): number {
    return this.#turnId
  }

  get evidenceVersion(): number {
    return this.#evidenceVersion
  }

  hasEvaluatedCheckpoint(checkpointKey: string): boolean {
    return this.#evaluatedCheckpoints.has(checkpointKey)
  }

  recordEvaluatedCheckpoint(checkpointKey: string): void {
    this.#evaluatedCheckpoints.add(checkpointKey)
  }

  updateTurn(turnId: number): void {
    if (turnId !== this.#turnId) {
      this.#turnId = turnId
      this.#markUpdated()
    }
  }

  recordPlan(plan: readonly string[], currentStep?: string): void {
    this.#plan = plan.map((s) => truncateBounded(s, 200))
    if (currentStep) {
      this.#currentStep = truncateBounded(currentStep, 200)
    }
    this.#markUpdated()
  }

  recordToolAction(action: {
    id: string
    toolName: string
    outcome?: "COMPLETED" | "FAILED" | "REJECTED" | "DENIED" | undefined
    args?: Record<string, unknown>
    output?: unknown
    error?: unknown
  }): void {
    this.#actionCount++
    this.#toolCallCount++

    const argsSummary = action.args ? JSON.stringify(action.args) : "{}"
    const signatureHash = deterministicHash(`${action.toolName}:${argsSummary}`)

    // Check for duplicate reads
    if (action.toolName === "read_file" && action.args?.path && typeof action.args.path === "string") {
      const p = action.args.path
      if (this.#readFilesSinceLastMutation.has(p)) {
        this.#duplicateReadCount++
      } else {
        this.#readFilesSinceLastMutation.add(p)
      }
    }

    const outputSummary = action.error
      ? typeof action.error === "object" && action.error !== null && "message" in action.error
        ? String((action.error as { message: unknown }).message)
        : String(action.error)
      : action.output
        ? typeof action.output === "string"
          ? action.output
          : JSON.stringify(action.output)
        : ""

    const boundedSummary = truncateBounded(`${action.toolName} ${argsSummary}: ${outputSummary}`)
    const record: BoundedActionRecord = {
      id: action.id,
      toolName: action.toolName,
      outcome: action.outcome ?? (action.error ? "FAILED" : "COMPLETED"),
      signatureHash,
      summary: boundedSummary,
      timestamp: new Date().toISOString(),
    }

    this.#appendBounded(this.#recentActions, record, MAX_RECENT_ACTIONS)
    this.#appendBounded(this.#toolOutcomes, record, MAX_TOOL_OUTCOMES)

    if (action.outcome === "FAILED" || action.outcome === "REJECTED" || action.outcome === "DENIED") {
      this.#failureCount++
      const failureHash = deterministicHash(`${action.toolName}:${action.outcome}:${outputSummary}`)
      const existing = this.#unresolvedFailures.get(failureHash)
      const count = existing ? existing.count + 1 : 1
      this.#unresolvedFailures.set(failureHash, {
        id: action.id,
        category: action.outcome,
        failureHash,
        summary: boundedSummary,
        count,
        timestamp: new Date().toISOString(),
      })
      if (this.#unresolvedFailures.size > MAX_UNRESOLVED_FAILURES) {
        const oldestKey = this.#unresolvedFailures.keys().next().value
        if (oldestKey) this.#unresolvedFailures.delete(oldestKey)
      }
    } else if (action.outcome === "COMPLETED") {
      // If a successful action addresses a tool name, remove matching unresolved failure
      for (const [key, val] of this.#unresolvedFailures.entries()) {
        if (val.summary.startsWith(action.toolName)) {
          this.#unresolvedFailures.delete(key)
        }
      }
    }

    this.#markUpdated()
  }

  recordMutationOutcome(mutation: {
    mutationId: string
    path: string
    status: "PREPARED" | "APPLIED" | "FAILED" | "STALE"
    diffSummary?: string
  }): void {
    this.#mutationCount++
    if (mutation.status === "APPLIED") {
      // State mutation resets the read-files set for duplicate detection
      this.#readFilesSinceLastMutation.clear()
    }
    const record: BoundedMutationOutcome = {
      mutationId: mutation.mutationId,
      path: truncateBounded(mutation.path, 150),
      status: mutation.status,
      diffSummary: truncateBounded(mutation.diffSummary ?? "", 300),
      timestamp: new Date().toISOString(),
    }

    this.#appendBounded(this.#mutationOutcomes, record, MAX_MUTATION_OUTCOMES)
    this.#markUpdated()
  }

  recordVerificationOutcome(verification: {
    executionId: string
    action: string
    status: "PASS" | "FAIL" | "TIMEOUT" | "EXECUTION_ERROR" | "STALE_VERIFICATION" | "CANCELLED"
    failedTestCount?: number
    totalTestCount?: number
    stdout?: string
    stderr?: string
  }): void {
    this.#verificationCount++
    const combinedOutput = `${verification.stdout ?? ""}\n${verification.stderr ?? ""}`
    const failureSummary = verification.status !== "PASS" ? truncateBounded(combinedOutput, 300) : undefined
    const failureHash = failureSummary ? deterministicHash(`${verification.action}:${verification.status}:${failureSummary}`) : undefined

    const record: BoundedVerificationOutcome = {
      executionId: verification.executionId,
      action: verification.action,
      status: verification.status,
      failedTestCount: verification.failedTestCount,
      totalTestCount: verification.totalTestCount,
      failureSummary,
      failureHash,
      timestamp: new Date().toISOString(),
    }

    // Progress signal comparison with previous verification
    const previous = this.#verificationOutcomes[this.#verificationOutcomes.length - 1]
    if (previous && typeof previous.failedTestCount === "number" && typeof verification.failedTestCount === "number") {
      const delta = previous.failedTestCount - verification.failedTestCount
      if (delta > 0) {
        this.#appendBounded(
          this.#progressSignals,
          {
            turnId: this.#turnId,
            delta,
            positive: true,
            reason: `Failing tests decreased from ${previous.failedTestCount} to ${verification.failedTestCount}`,
            timestamp: new Date().toISOString(),
          },
          MAX_PROGRESS_SIGNALS,
        )
      } else if (delta < 0) {
        this.#appendBounded(
          this.#progressSignals,
          {
            turnId: this.#turnId,
            delta,
            positive: false,
            reason: `Failing tests increased from ${previous.failedTestCount} to ${verification.failedTestCount}`,
            timestamp: new Date().toISOString(),
          },
          MAX_PROGRESS_SIGNALS,
        )
      }
    }

    if (verification.status === "PASS") {
      // Clear verification-related unresolved failures
      for (const [key, val] of this.#unresolvedFailures.entries()) {
        if (val.category.includes("VERIFICATION") || val.summary.includes(verification.action)) {
          this.#unresolvedFailures.delete(key)
        }
      }
    }

    this.#appendBounded(this.#verificationOutcomes, record, MAX_VERIFICATION_OUTCOMES)
    this.#markUpdated()
  }

  recordSecuritySignal(signal: {
    id: string
    action?: string
    toolName?: string
    reason?: string
    denied: boolean
  }): void {
    if (signal.denied) {
      this.#securityDenialCount++
    }
    const record: BoundedSecuritySignal = {
      id: signal.id,
      toolName: signal.toolName,
      action: truncateBounded(signal.action ?? signal.toolName ?? "unknown", 100),
      reason: truncateBounded(signal.reason ?? "Security policy boundary triggered", 200),
      denied: signal.denied,
      timestamp: new Date().toISOString(),
    }
    this.#appendBounded(this.#securitySignals, record, MAX_SECURITY_SIGNALS)
    this.#markUpdated()
  }

  recordRouteSignal(signal: {
    routeId: string
    providerId: string
    modelId: string
    taskMode: string
    success: boolean
    latencyMs: number
  }): void {
    const record: BoundedRouteSignal = {
      routeId: signal.routeId,
      providerId: signal.providerId,
      modelId: signal.modelId,
      taskMode: signal.taskMode,
      success: signal.success,
      latencyMs: signal.latencyMs,
      timestamp: new Date().toISOString(),
    }
    this.#appendBounded(this.#routeSignals, record, MAX_ROUTE_SIGNALS)
    this.#markUpdated()
  }

  recordUnresolvedFailure(failure: {
    failureType?: string
    id?: string
    category?: string
    target?: string
    summary: string
  }): void {
    const category = failure.category ?? failure.failureType ?? "UNRESOLVED_FAILURE"
    const failureHash = deterministicHash(`${category}:${failure.target ?? ""}:${failure.summary}`)
    const existing = this.#unresolvedFailures.get(failureHash)
    const count = existing ? existing.count + 1 : 1
    this.#unresolvedFailures.set(failureHash, {
      id: failure.id ?? `fail-${this.#unresolvedFailures.size + 1}`,
      category,
      failureHash,
      summary: truncateBounded(failure.summary, 200),
      count,
      timestamp: new Date().toISOString(),
    })
    if (this.#unresolvedFailures.size > MAX_UNRESOLVED_FAILURES) {
      const oldestKey = this.#unresolvedFailures.keys().next().value
      if (oldestKey) this.#unresolvedFailures.delete(oldestKey)
    }
    this.#failureCount++
    this.#markUpdated()
  }

  resolveFailure(targetOrPattern: string, summaryPattern?: string): void {
    for (const [key, val] of this.#unresolvedFailures.entries()) {
      if (val.summary.includes(targetOrPattern) || (summaryPattern && val.summary.includes(summaryPattern))) {
        this.#unresolvedFailures.delete(key)
      }
    }
    this.#markUpdated()
  }

  recordRecoveryPlan(plan: RecoveryPlan | {
    disposition: string
    reconciledOperations?: readonly { reconciledStatus: string }[]
    blockedOperations?: readonly unknown[]
    requiredApprovals?: readonly string[]
    rollbackCandidates?: readonly { safeToRollback: boolean }[]
    divergenceClass?: string
    reasons?: readonly string[]
    [key: string]: unknown
  }): void {
    let applied = 0
    let notApplied = 0
    let interrupted = 0
    let ambiguous = 0
    let hasInterruptedVerif = false

    for (const op of plan.reconciledOperations ?? []) {
      if (op.reconciledStatus === "RECONCILED_APPLIED") applied++
      else if (op.reconciledStatus === "RECONCILED_NOT_APPLIED") notApplied++
      else if (op.reconciledStatus === "INTERRUPTED") {
        interrupted++
        hasInterruptedVerif = true
      } else if (op.reconciledStatus === "AMBIGUOUS") ambiguous++
    }

    const blockedDivergence =
      plan.divergenceClass === "BLOCKED_DIVERGENCE" ||
      (plan.blockedOperations && plan.blockedOperations.length > 0) ||
      false

    const approvalInvalidated =
      (plan.requiredApprovals && plan.requiredApprovals.includes("NEW_EPOCH_AUTHORITY_REQUIRED")) || false

    const rollbackAvailable =
      (plan.rollbackCandidates && plan.rollbackCandidates.some((c) => c.safeToRollback)) || false

    this.#recoveryEvidence = {
      recoveryDisposition: plan.disposition,
      reconciledOperationCounts: {
        applied,
        notApplied,
        interrupted,
        ambiguous,
      },
      interruptedVerification: hasInterruptedVerif,
      blockedDivergence: !!blockedDivergence,
      approvalInvalidated,
      rollbackAvailable,
      recoveryReasonCodes: (plan.reasons ?? []).map((r) => truncateBounded(r, 100)),
    }
    this.#markUpdated()
  }

  getEvidence(): RuntimeEvidence {
    const counts: RuntimeEvidenceCounts = {
      actions: this.#actionCount,
      failures: this.#failureCount,
      mutations: this.#mutationCount,
      verifications: this.#verificationCount,
      securityDenials: this.#securityDenialCount,
      toolCalls: this.#toolCallCount,
      duplicateReads: this.#duplicateReadCount,
    }

    return {
      runId: this.#runId,
      turnId: this.#turnId,
      taskGoal: this.#taskGoal,
      evidenceVersion: this.#evidenceVersion,
      plan: this.#plan,
      currentStep: this.#currentStep,
      recentActions: [...this.#recentActions],
      toolOutcomes: [...this.#toolOutcomes],
      mutationOutcomes: [...this.#mutationOutcomes],
      verificationOutcomes: [...this.#verificationOutcomes],
      securitySignals: [...this.#securitySignals],
      unresolvedFailures: Array.from(this.#unresolvedFailures.values()),
      routeSignals: [...this.#routeSignals],
      progressSignals: [...this.#progressSignals],
      recoveryEvidence: this.#recoveryEvidence,
      counts,
      timestamps: {
        startedAt: this.#startedAt,
        updatedAt: this.#updatedAt,
      },
    }
  }

  getBoundedSummary(): BoundedEvidenceSummary {
    const recentSummary = this.#recentActions.slice(-5).map((a) => `${a.toolName}(${a.outcome})`).join("; ") || "none"
    const appliedMutations = this.#mutationOutcomes.filter((m) => m.status === "APPLIED")
    const mutationSummary = `mutations_applied: ${appliedMutations.length}, total_mutations: ${this.#mutationOutcomes.length}`
    const lastVerif = this.#verificationOutcomes[this.#verificationOutcomes.length - 1]
    const verifSummary = lastVerif
      ? `last_action: ${lastVerif.action}, status: ${lastVerif.status}, failures: ${lastVerif.failedTestCount ?? 0}`
      : "no_verification_recorded"
    const failuresSummary = `unresolved: ${this.#unresolvedFailures.size}, total_failures: ${this.#failureCount}`
    const secSummary = `denials: ${this.#securityDenialCount}`

    return {
      runId: this.#runId,
      turnId: this.#turnId,
      taskGoal: this.#taskGoal,
      planSummary: this.#plan ? this.#plan.join(" -> ") : undefined,
      recentActionsSummary: recentSummary,
      mutationSummary,
      verificationSummary: verifSummary,
      failuresSummary,
      securitySummary: secSummary,
    }
  }

  #appendBounded<T>(target: T[], item: T, limit: number): void {
    target.push(item)
    if (target.length > limit) {
      target.shift()
    }
  }

  #markUpdated(): void {
    this.#evidenceVersion++
    this.#updatedAt = new Date().toISOString()
  }
}
