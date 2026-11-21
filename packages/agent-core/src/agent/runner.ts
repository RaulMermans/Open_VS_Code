import { createToolObservation, type ToolObservation } from "./observations.ts"
import { buildNativeToolMessages, resolveConversationEncoding, type ConversationEncoding } from "./native-tool-messages.ts"
export type { ConversationEncoding }
import { createAgentEvent, type AgentEventFactory, type AgentEventType } from "./events.ts"
import { applyAgentEvent, initialAgentState } from "./state.ts"
import { compileContext, type ContextCompilerInput } from "../context/compiler.ts"
import { ContextBudgetError } from "../context/budget.ts"
import type {
  AgentConfirmationRequest,
  AgentContextDiagnostic,
  AgentFailureReason,
  AgentResult,
  AgentState,
  AgentTask,
  AgentToolCallRecord,
} from "../contracts/agent.ts"
import type { CompiledContext, ContextBudget, ContextItem, ConversationTurn } from "../contracts/context.ts"
import type { ModelProvider, ModelRequest } from "../contracts/model.ts"
import type { ModelRouteHint } from "../contracts/routing.ts"
import { deriveTaskClass } from "../model/route-requirements.ts"
import type { ModelPerformanceLedger } from "../model/performance-ledger.ts"
import type { ToolCall, ToolPermission } from "../contracts/tools.ts"
import { classifyPermission } from "../tools/permissions.ts"
import { type PreparedToolCall, ToolRegistry, ToolRegistryError } from "../tools/registry.ts"
import type { LoadedSkill } from "../context/skills.ts"
import type { SkillGuidance } from "../skills/contracts.ts"
import type { ProjectInstruction } from "../context/compiler.ts"
import { classifyTaskProfile, forbidsAllEdits, isSocialTurn, type TaskProfile } from "./task-profile.ts"
import { CONVERSATIONAL_RESPONSE_GUIDANCE } from "./response-guidance.ts"
import { danglingReferences } from "../tools/json-references.ts"
import { exportedTypeShapeChanged, proposedContentProblems, testExercisesNoProjectCode, unresolvedTestReads } from "../tools/pre-write-check.ts"
import { buildRunDiagnostics } from "./run-diagnostics.ts"
import { currentWorkUnit, formatWorkUnit, deriveOutcomes, evaluateOutcomes, formatOutcomeReport, isSubstantial, outcomeGaps, type Outcome } from "./outcome-ledger.ts"
import { unchangedFailures } from "./verification-stagnation.ts"
import { actionAfterMutation, assessCodingCompletion, describeToolContractFault, excludedEditPaths, handRenamedBinding, implementationChangeRequired, isTestArtifactPath, mutationToolGuidance, pathsReferToSameFile, requestsExistingFileEdit, requestsNewTest, requiredEditPaths, type CodingCompletion } from "./tool-contract.ts"
import { EvidenceLedger } from "./evidence.ts"
import { RuntimeEvalEngine } from "../runtime-evals/runtime-eval-engine.ts"
import { AdaptiveControlPolicy, type AdaptiveDirective } from "../runtime-evals/adaptive-control-policy.ts"
import { RuntimeEvalLedger } from "../runtime-evals/runtime-eval-ledger.ts"
import { RuntimeEvalAnalytics } from "../runtime-evals/analytics.ts"
import { RuntimeEvidenceCollector } from "../runtime-evals/evidence.ts"
import type { RuntimeEvalCheckpoint, RuntimeEvalResult } from "../runtime-evals/contracts.ts"
import type { VerificationEngine } from "../tools/verification-engine.ts"
import { recordedVerificationStatus } from "../tools/verification-contracts.ts"
import { discoverVerificationCommand } from "../tools/verification-discovery.ts"
import { readRepositoryFile } from "../tools/read-file.ts"
import { searchText } from "../tools/search-text.ts"
import type { CheckpointCoordinator } from "../recovery/checkpoint-coordinator.ts"
import { evaluateL0 } from "../runtime-evals/evaluators/l0-deterministic.ts"
import { join, dirname, normalize, relative, isAbsolute, basename, extname } from "node:path"
import { access, readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { requirementGaps } from "./requirement-checks.ts"
import { MAX_NON_PROGRESS_RECOVERIES, type ProgressSignal, type ProgressThresholds } from "../progress/contracts.ts"
import { DirectProgressGuard, dedupeObservations, type DirectNonProgressEvidence } from "../progress/direct-guard.ts"
import { boundRecoveryText, buildNonProgressReport, buildRecoveryPlan, classifyStall, describeSignals, formatNonProgressReport, runDiagnosticCheck, stallNotice, type FailureCapture } from "../progress/recovery.ts"
import { resolveRepositoryPath } from "../tools/path-safety.ts"
import { sha256 } from "../tools/mutation-engine.ts"
import { candidateOwnerPaths, classifyNamedEditTargets, inspectMutationTarget, misplacedExportPath, editingStrategyGuidance } from "../tools/mutation-recovery.ts"
import { UNLIMITED_MAX_TURNS, isUnlimitedTurnBudget } from "./acceptance-budget.ts"

export type ConfirmationDecision = "APPROVE" | "REJECT"

export interface AgentRunnerInput {
  readonly task: AgentTask
  readonly workspaceRoot: string
  readonly maxTurns: number
  readonly contextBudget: ContextBudget
  readonly projectInstructions: readonly ProjectInstruction[]
  readonly selectedSkills?: readonly LoadedSkill[]
  readonly skillGuidance?: readonly SkillGuidance[]
  /** Approved learned memory (ADR-032), already budget-selected. Candidates never reach this field. */
  readonly learnedMemory?: readonly { readonly id: string; readonly content: string; readonly estimatedTokens: number }[]
  readonly codeContext?: readonly ContextItem[]
  readonly recentTurns?: readonly ConversationTurn[]
  readonly signal?: AbortSignal
  readonly taskProfile?: TaskProfile
  readonly repairCycles?: number
  /**
   * Supervised long tasks: the run pauses at a turn boundary after this much wall-clock time (a work unit) with
   * everything kept, and can be continued up to MAX_WORK_UNITS times while each unit makes progress.
   */
  readonly unitBudgetMs?: number
  /** Isolated A/B switch. Default remains a single compiled user message. */
  readonly conversationEncoding?: ConversationEncoding
}

export interface AgentRunnerDependencies {
  readonly provider: ModelProvider
  readonly registry: ToolRegistry
  readonly eventFactory?: AgentEventFactory
  readonly eventSink?: (event: AgentState["events"][number]) => void
  readonly permissionEvaluator?: typeof classifyPermission
  readonly contextCompiler?: (input: ContextCompilerInput) => CompiledContext
  readonly nonProgressThreshold?: number
  /**
   * ADR-011 mutation budgets are per step. A step is one model response, so the runner resets the
   * engine's per-step counter before handling each response's tool calls.
   */
  readonly mutationStep?: { resetStepCounter(): void }
  readonly observationMaxBytes?: number
  readonly evidenceGate?: boolean
  readonly maxContinuations?: number
  readonly evalEngine?: RuntimeEvalEngine
  readonly evalPolicy?: AdaptiveControlPolicy
  readonly evalLedger?: RuntimeEvalLedger
  readonly verificationEngine?: VerificationEngine
  readonly runtimeEvals?: boolean
  readonly adaptiveInterventions?: boolean
  readonly checkpointCoordinator?: CheckpointCoordinator
  readonly performanceLedger?: ModelPerformanceLedger
  /**
   * Sprint 5C non-progress guard (ADR-031). Off by default: the existing 3-repeat NON_PROGRESS_GUARD
   * is then the only stall protection, exactly as before.
   */
  readonly progressMonitor?: { readonly enabled: boolean; readonly thresholds?: Partial<ProgressThresholds> }
  readonly conversationEncoding?: ConversationEncoding
}

interface PendingConfirmation {
  readonly prepared: PreparedToolCall
  readonly signature: string
  readonly reviewable?: import("../tools/registry.ts").ReviewableExecution
}

interface Session {
  input: AgentRunnerInput
  readonly taskProfile: TaskProfile
  readonly evidenceLedger: EvidenceLedger
  readonly evidenceCollector: RuntimeEvidenceCollector
  readonly evalEngine: RuntimeEvalEngine
  readonly evalPolicy: AdaptiveControlPolicy
  readonly evalLedger: RuntimeEvalLedger
  readonly evalAnalytics: RuntimeEvalAnalytics
  readonly evalResults: RuntimeEvalResult[]
  state: AgentState
  turns: number
  continuationAttempts: number
  observations: ToolObservation[]
  diagnostics: AgentContextDiagnostic[]
  toolCalls: AgentToolCallRecord[]
  pending?: PendingConfirmation
  recoveredConfirmation?: AgentConfirmationRequest | undefined
  finalAnswer?: string
  failureReason?: AgentFailureReason
  lastProgressKey?: string
  repeatedProgress: number
  terminationSource?: "RUNTIME_EVAL" | "NON_PROGRESS_GUARD" | undefined
  pendingModelRecommendation?: { readonly capability: string; readonly reason: string } | undefined
  pendingRouteHint?: ModelRouteHint | undefined
  pendingModelEvalId?: string | undefined
  consecutiveContextRequests?: number | undefined
  lastDeploymentId?: string | undefined
  startTime?: number | undefined
  performanceOutcomeRecorded?: boolean | undefined
  progressGuard?: DirectProgressGuard | undefined
  nonProgress?: DirectNonProgressEvidence | undefined
  timeoutOccurred?: boolean | undefined
  /** Contract-fault signature → the turn it first happened on. */
  contractFaults?: Map<string, number>
  /** Identical refusals (tool + category + message) per workspace state; see #recordRefusal. */
  refusals?: Map<string, number>
  /** Whether the workspace package.json defines a typecheck script (cached). */
  typecheckScript?: boolean
  /** Unfinished explicit parts of the request, refreshed after each applied edit. */
  requirementGaps?: string[]
  refusalStop?: boolean
  /** Engineering Outcome Ledger for a multi-part brief; recomputed from durable evidence, never stored. */
  outcomes?: Outcome[]
  mutationRejectedByUser?: boolean
  autoVerifyPending?: boolean
  /** Files whose proposed edit changed an exported type; checked by an early typecheck after the turn's edits. */
  typeShapePaths?: Set<string>
  /** `path|value` pairs already warned about as dangling references; a repeated edit goes through. */
  danglingWarned?: Set<string>
  /** Applied-edit count when the completion gate last nudged; the nudge limit resets when it grows. */
  gateAppliedMark?: number
  /** Context items the latest model request actually contained (older observations are reduced to an index line). */
  shownItemIds?: Set<string>
  /** The current work unit (only when unitBudgetMs is set): its number, deadline and progress at its start. */
  unit?: { index: number; deadline: number; appliedAtStart: number; metAtStart: number }
  /**
   * Task-scoped registry of successful read-only lookups (signature -> result). A repeat is answered from
   * here as ALREADY_OBSERVED instead of being refused. Cleared whenever the workspace changes.
   */
  observedLookups?: Map<string, ObservedLookup>
  /** Renames applied in this task, so a repeated request is recognized as already done (not cross-task memory). */
  completedRenames?: CompletedRename[]
  /** Verification actions that could not run in this workspace (ENVIRONMENT), with the reason. */
  environmentBlocked?: Map<string, string>
  lastAssistantText?: string
  /** One "answer now" nudge has already been sent for a non-editing task. */
  conversationAnswerNudged?: boolean
}

interface ObservedLookup {
  readonly callId: string
  readonly content: string
  readonly truncated: boolean
  replays: number
}

/**
 * Read-only lookups whose result depends only on workspace content. read_file is re-read and compared, so an
 * outside change is always seen. shortcut: listings and searches are invalidated by the agent's own writes and
 * commands, not by edits made outside the agent mid-task; add a directory mtime check if that shows up.
 */
const REPLAYABLE_LOOKUPS = new Set(["list_directory", "find_files", "search_text", "find_symbol", "read_file"])
/** Distinct directory listings on an edit task. Further listings delay the requested mutation without new structure. */
const MAX_EDIT_TASK_DIRECTORY_LISTINGS = 6
/** After this many turns with no applied edit, hide search/list so the model must read or mutate. */
const MAX_EXPLORATION_TURNS_WITHOUT_EDIT = 6
const MAX_READ_TURNS_WITHOUT_EDIT = 10
const EXPLORATION_TOOLS = new Set(["list_directory", "find_files", "search_text", "find_symbol"])
const READ_TOOLS = new Set(["read_file", "list_directory", "find_files", "search_text", "find_symbol"])
const MISSING_SEARCH_HINT = "This string is not in the workspace. If the task requires this behavior, implement it with create_file or apply_patch; do not search for the same query again."
const MISSING_FILES_HINT = "No file matched. If the task requires a new file, create it; do not keep searching for a path that is not there."
interface CompletedRename {
  readonly path: string
  readonly symbol: string
  readonly newName: string
  readonly mutationId: string
  readonly files: readonly string[]
  repeats: number
}

const scriptNames = (text: string) => Object.keys((JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {})

/** Script names a package.json edit would add (apply_patch search/replace, or full content). Unparseable: none. */
async function addedScriptNames(workspaceRoot: string, target: string, args: Record<string, unknown>): Promise<string[]> {
  let before: string
  try {
    before = await readFile(isAbsolute(target) ? target : join(workspaceRoot, target), "utf8")
  } catch {
    return []
  }
  const after = typeof args.content === "string"
    ? args.content
    : typeof args.search === "string" && typeof args.replace === "string" ? before.replace(args.search, () => String(args.replace)) : undefined
  if (after === undefined) return []
  try {
    const existing = new Set(scriptNames(before))
    return scriptNames(after).filter((name) => !existing.has(name))
  } catch {
    return []
  }
}

/** The request is about the manifest itself: package.json, its scripts or its dependencies. */
function mentionsPackageManifest(instruction: string): boolean {
  return /\bpackage\.json\b|\bscripts?\b|\b(?:dev)?dependenc(?:y|ies)\b|\bpackageManager\b/i.test(instruction.split("[Attached context]")[0] ?? instruction)
}

/** A whole identifier (not part of a longer name). */
const identifierPattern = (name: string) => new RegExp(String.raw`(?<![\w$])${name.replace(/\$/g, "\\$")}(?![\w$])`)

/** A lookup repeated this many times with no workspace change is answered once in full, then only briefly. */
const FULL_REPLAYS = 1
/** A supervised long task may use at most this many work units (the first plus two continuations). */
const MAX_WORK_UNITS = 3

export const MAX_CONSECUTIVE_CONTEXT_REQUESTS = 2

export type AgentRunnerErrorCode = "ACTIVE_SESSION" | "NO_PENDING_CONFIRMATION" | "TERMINAL_STATE" | "INVALID_INPUT"

function isProductSource(path: string): boolean {
  return /\.(?:ts|tsx|js|mjs|cjs)$/.test(path) && !isTestArtifactPath(path)
}

export class AgentRunnerError extends Error {
  readonly code: AgentRunnerErrorCode

  constructor(code: AgentRunnerErrorCode, message: string) {
    super(message)
    this.name = "AgentRunnerError"
    this.code = code
  }
}

function toolArguments(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function recordCall(
  prepared: { id: string; name: string; arguments?: unknown },
  outcome: AgentToolCallRecord["outcome"],
  truncated?: boolean,
): AgentToolCallRecord {
  const argumentsValue = toolArguments(prepared.arguments)
  return {
    id: prepared.id,
    name: prepared.name,
    outcome,
    ...(truncated !== undefined ? { truncated } : {}),
    ...(argumentsValue ? { arguments: argumentsValue } : {}),
  }
}

function defaultEventFactory(): AgentEventFactory {
  let sequence = 0
  return { createId: () => `event-${++sequence}`, now: () => new Date().toISOString() }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError")
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${stableValue(nested)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code: unknown }).code
  return typeof code === "string" ? code : undefined
}

function argumentPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const path = (value as Record<string, unknown>).path
  return typeof path === "string" ? path : undefined
}

function renderContext(context: CompiledContext): string {
  return context.items.map((item) => {
    const metadata = item.metadata ? ` ${JSON.stringify(item.metadata)}` : ""
    return `## ${item.source.kind}${metadata}\n${item.content}`
  }).join("\n\n")
}

export class AgentRunner {
  readonly #provider: ModelProvider
  readonly #registry: ToolRegistry
  readonly #factory: AgentEventFactory
  readonly #eventSink?: AgentRunnerDependencies["eventSink"] | undefined
  readonly #permissionEvaluator: typeof classifyPermission
  readonly #contextCompiler: (input: ContextCompilerInput) => CompiledContext
  readonly #nonProgressThreshold: number
  readonly #mutationStep: { resetStepCounter(): void } | undefined
  readonly #observationMaxBytes: number
  readonly #evidenceGate: boolean
  readonly #maxContinuations: number
  readonly #evalEngine?: RuntimeEvalEngine | undefined
  readonly #evalPolicy?: AdaptiveControlPolicy | undefined
  readonly #evalLedger?: RuntimeEvalLedger | undefined
  readonly #verificationEngine?: VerificationEngine | undefined
  readonly #runtimeEvals: boolean
  readonly #adaptiveInterventions: boolean
  readonly #checkpointCoordinator?: CheckpointCoordinator | undefined
  readonly #performanceLedger?: ModelPerformanceLedger | undefined
  readonly #progressMonitor?: AgentRunnerDependencies["progressMonitor"] | undefined
  readonly #conversationEncoding?: ConversationEncoding | undefined
  #session?: Session | undefined

  constructor(dependencies: AgentRunnerDependencies) {
    this.#provider = dependencies.provider
    this.#registry = dependencies.registry
    this.#factory = dependencies.eventFactory ?? defaultEventFactory()
    this.#eventSink = dependencies.eventSink
    this.#permissionEvaluator = dependencies.permissionEvaluator ?? classifyPermission
    this.#contextCompiler = dependencies.contextCompiler ?? compileContext
    this.#nonProgressThreshold = dependencies.nonProgressThreshold ?? 3
    this.#mutationStep = dependencies.mutationStep
    this.#observationMaxBytes = dependencies.observationMaxBytes ?? 16 * 1024
    this.#evidenceGate = dependencies.evidenceGate ?? true
    this.#maxContinuations = dependencies.maxContinuations ?? 2
    this.#evalEngine = dependencies.evalEngine
    this.#evalPolicy = dependencies.evalPolicy
    this.#evalLedger = dependencies.evalLedger
    this.#verificationEngine = dependencies.verificationEngine
    this.#runtimeEvals = dependencies.runtimeEvals ?? true
    this.#adaptiveInterventions = dependencies.adaptiveInterventions ?? true
    this.#checkpointCoordinator = dependencies.checkpointCoordinator
    this.#performanceLedger = dependencies.performanceLedger
    this.#progressMonitor = dependencies.progressMonitor
    this.#conversationEncoding = dependencies.conversationEncoding
    if (!Number.isInteger(this.#nonProgressThreshold) || this.#nonProgressThreshold < 2) {
      throw new AgentRunnerError("INVALID_INPUT", "nonProgressThreshold must be an integer of at least 2")
    }
  }

  get checkpointCoordinator(): CheckpointCoordinator | undefined {
    return this.#checkpointCoordinator
  }

  async run(input: AgentRunnerInput): Promise<AgentResult> {
    if (this.#session && !["COMPLETED", "FAILED", "CANCELLED"].includes(this.#session.state.status)) {
      throw new AgentRunnerError("ACTIVE_SESSION", "Runner already has an active task")
    }
    if (!Number.isInteger(input.maxTurns) || input.maxTurns <= 0) throw new AgentRunnerError("INVALID_INPUT", "maxTurns must be a positive integer")
    if (!input.workspaceRoot.trim()) throw new AgentRunnerError("INVALID_INPUT", "workspaceRoot must not be empty")
    const taskProfile = input.taskProfile ?? classifyTaskProfile(input.task.instruction, input.task.mode)
    const evalEngine = this.#evalEngine ?? new RuntimeEvalEngine()
    const evalPolicy = this.#evalPolicy ?? new AdaptiveControlPolicy()
    const evalLedger = this.#evalLedger ?? new RuntimeEvalLedger()
    const evalAnalytics = new RuntimeEvalAnalytics(evalLedger)
    const evidenceCollector = new RuntimeEvidenceCollector({
      runId: input.task.id,
      taskGoal: input.task.instruction,
    })
    this.#session = {
      input,
      taskProfile,
      evidenceLedger: new EvidenceLedger(),
      evidenceCollector,
      evalEngine,
      evalPolicy,
      evalLedger,
      evalAnalytics,
      evalResults: [],
      state: initialAgentState(),
      turns: 0,
      continuationAttempts: 0,
      observations: [],
      diagnostics: [],
      toolCalls: [],
      repeatedProgress: 0,
      startTime: Date.now(),
      ...(this.#progressMonitor?.enabled ? { progressGuard: new DirectProgressGuard(this.#progressMonitor.thresholds) } : {}),
    }
    this.#emit("task.started", { task: input.task })
    if (this.#checkpointCoordinator) {
      try {
        await this.#checkpointCoordinator.checkpoint({
          runId: input.task.id,
          reason: "RUN_STARTED",
          phase: "PLANNING",
          turnId: 0,
          evidenceVersion: 1,
          runtimeState: { status: "PLANNING" },
          touchedFilePaths: [],
        })
      } catch (err) {
        this.#session.failureReason = "INTERNAL_ERROR"
        const message = `RECOVERY_PERSISTENCE_FAILED: Failed to record initial RUN_STARTED checkpoint: ${err instanceof Error ? err.message : String(err)}`
        this.#emit("task.failed", { message })
        return this.#result()
      }
    }
    return this.#continue()
  }

  /**
   * User-authorized continuation after MAX_TURNS_EXCEEDED.
   * Keeps observations, tool records, and applied mutations. Does not replay them.
   */
  async continueFromLimit(additionalTurns: number): Promise<AgentResult> {
    const session = this.#session
    if (!session) throw new AgentRunnerError("NO_PENDING_CONFIRMATION", "No task has been started")
    if (session.failureReason !== "MAX_TURNS_EXCEEDED") {
      throw new AgentRunnerError("INVALID_INPUT", "continueFromLimit requires a turn-budget pause")
    }
    if (!Number.isInteger(additionalTurns) || additionalTurns <= 0) {
      throw new AgentRunnerError("INVALID_INPUT", "additionalTurns must be a positive integer")
    }
    if (session.unit) {
      const now = this.#progressCount()
      if (now.applied <= session.unit.appliedAtStart && now.met <= session.unit.metAtStart) {
        session.failureReason = "NON_PROGRESS"
        session.finalAnswer = `Stopped after work unit ${session.unit.index}: it made no edit and met no new requirement, so another unit would repeat it. ${this.#assessCoding("NOT_RUN").summary}`
        return this.#result()
      }
      if (session.unit.index >= MAX_WORK_UNITS) {
        session.failureReason = "INCOMPLETE"
        session.finalAnswer = `Stopped after ${MAX_WORK_UNITS} work units. ${this.#assessCoding("NOT_RUN").summary}`
        return this.#result()
      }
      session.unit = { index: session.unit.index + 1, deadline: Date.now() + (session.input.unitBudgetMs ?? 0), appliedAtStart: now.applied, metAtStart: now.met }
    }
    const nextBudget = session.input.maxTurns + additionalTurns
    session.input = { ...session.input, maxTurns: nextBudget }
    delete session.failureReason
    delete session.finalAnswer
    session.state = {
      ...session.state,
      status: "OBSERVING",
    }
    const completed = this.#completedWorkNotice()
    session.observations.push(createToolObservation({
      toolName: "continuation",
      callId: `continue-${session.turns}`,
      output: completed,
      maxContentBytes: this.#observationMaxBytes,
    }))
    return this.#continue()
  }

  async resume(decision: ConfirmationDecision): Promise<AgentResult> {
    const session = this.#session
    if (!session) throw new AgentRunnerError("NO_PENDING_CONFIRMATION", "No task has been started")
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(session.state.status)) {
      throw new AgentRunnerError("TERMINAL_STATE", `Terminal state ${session.state.status} cannot resume`)
    }
    if (session.state.status !== "WAITING_FOR_CONFIRMATION" || !session.pending) {
      throw new AgentRunnerError("NO_PENDING_CONFIRMATION", "Task is not waiting for confirmation")
    }
    const pending = session.pending
    delete session.pending
    if (decision === "REJECT") {
      if (pending.reviewable) {
        try {
          await pending.reviewable.reject?.("USER_REJECTED")
        } catch {
          // Safe rejection observer cleanup
        }
        const isVerification = pending.prepared.definition.action === "run_known_test"
        this.#emit(isVerification ? "verification.rejected" : "mutation.rejected", {
          callId: pending.prepared.id,
          name: pending.prepared.name,
          mutationId: pending.reviewable.id,
          ...(isVerification ? { executionId: pending.reviewable.id } : {}),
        })
      } else {
        this.#emit("permission.rejected", { callId: pending.prepared.id, name: pending.prepared.name })
      }
      // A brief with several outcomes survives one declined edit: the decline is recorded and the rest continues.
      const multiOutcome = isSubstantial(deriveOutcomes(session.input.task.instruction))
      const declinedPath = String((pending.prepared.arguments as { path?: unknown }).path ?? "")
      this.#addErrorObservation(
        pending.prepared,
        "PERMISSION_REJECTED",
        multiOutcome && pending.prepared.definition.action === "write_file"
          ? `The user declined this edit${declinedPath ? ` to ${declinedPath}` : ""}. Do not propose it again. Continue with the remaining outcomes and say in your final answer what was left undone.`
          : "Caller rejected this tool request",
        "REJECTED",
      )
      if (pending.prepared.definition.action === "write_file") {
        session.mutationRejectedByUser = true
        if (session.taskProfile.requiresCodeChange && !multiOutcome) {
          const verdict = this.#codingGoalVerdict()
          if (verdict?.accept) {
            await this.#completeTask(verdict.summary)
          } else {
            session.failureReason = "REJECTED"
            session.finalAnswer = verdict?.summary ?? "The proposed edit was rejected."
            this.#emit("task.failed", { message: session.finalAnswer })
          }
          return this.#result()
        }
      }
    } else {
      if (pending.reviewable) {
        const reviewable = pending.reviewable
        const isVerification = pending.prepared.definition.action === "run_known_test"
        const isBrowserReview = pending.prepared.name.startsWith("browser_")
        this.#emit(isVerification ? "verification.approved" : "mutation.approved", {
          callId: pending.prepared.id,
          name: pending.prepared.name,
          mutationId: reviewable.id,
          ...(isVerification ? { executionId: reviewable.id } : {}),
        })
        let observation: ToolObservation
        let opId: string | undefined
        try {
          if (isVerification) {
            this.#emit("verification.started", {
              callId: pending.prepared.id,
              name: pending.prepared.name,
              mutationId: reviewable.id,
              executionId: reviewable.id,
            })
          }
          const reviewableId = reviewable.id
          let targetFilePath = ""
          let groupTouched: string[] | undefined
          let groupConditions: { preconditions: { path: string; expectedHash: string; exists: boolean }[]; expectedPostconditions: { path: string; expectedHash: string; exists: boolean }[] } | undefined
          if (this.#checkpointCoordinator && !isVerification && !isBrowserReview) {
            const payload = reviewable.reviewPayload as any
            targetFilePath = payload?.path ?? (pending.prepared.arguments as any)?.targetFile ?? (pending.prepared.arguments as any)?.path ?? ""
            if (!targetFilePath.startsWith("/") && session.input.workspaceRoot) {
              targetFilePath = join(session.input.workspaceRoot, targetFilePath)
            }
            // A grouped edit stores one preimage per file (never the combined review text) and checks every base hash.
            const group = groupedFiles(payload)?.map((file) => ({ ...file, absolute: file.path.startsWith("/") ? file.path : join(session.input.workspaceRoot, file.path) }))
            if (group) {
              for (const [index, file] of group.entries()) {
                try {
                  await this.#checkpointCoordinator.artifactStore.storePreimage(session.input.task.id, `${reviewable.id}-${index}`, file.absolute, Buffer.from(file.beforeContent, "utf8"))
                } catch (err) {
                  throw new Error(`DURABILITY_UNAVAILABLE: Failed to store preimage before mutation: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
                }
              }
              groupTouched = group.map((file) => file.absolute)
              groupConditions = {
                preconditions: group.map((file) => ({ path: file.absolute, expectedHash: file.beforeHash, exists: true })),
                expectedPostconditions: group.map((file) => ({ path: file.absolute, expectedHash: file.afterHash, exists: true })),
              }
            } else if (payload?.beforeContent !== undefined && payload?.beforeContent !== null && payload.beforeContent !== "") {
              try {
                await this.#checkpointCoordinator.artifactStore.storePreimage(
                  session.input.task.id,
                  reviewable.id,
                  targetFilePath,
                  Buffer.from(payload.beforeContent, "utf8"),
                )
              } catch (err) {
                throw new Error(`DURABILITY_UNAVAILABLE: Failed to store preimage before mutation: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
              }
            }
            let op
            try {
              op = await this.#checkpointCoordinator.prepareOperation({
                runId: session.input.task.id,
                evidenceVersion: session.turns + 1,
                kind: "MUTATION",
                authorityId: "mutation-engine",
                ...(groupConditions ?? {
                  preconditions: payload?.beforeHash ? [{ path: targetFilePath, expectedHash: payload.beforeHash, exists: true }] : [],
                  expectedPostconditions: payload?.afterHash ? [{ path: targetFilePath, expectedHash: payload.afterHash, exists: true }] : [],
                }),
                payload: { mutationId: reviewable.id },
              })
            } catch (err) {
              throw new Error(`DURABILITY_UNAVAILABLE: Failed to prepare operation before mutation: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
            }
            opId = op.operationId
            try {
              await this.#checkpointCoordinator.operationJournal.recordStarted(opId, session.input.task.id)
            } catch (err) {
              throw new Error(`DURABILITY_UNAVAILABLE: Failed to record operation started before mutation: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
            }
            try {
              await this.#checkpointCoordinator.checkpoint({
                runId: session.input.task.id,
                reason: "BEFORE_MUTATION",
                phase: "MUTATION",
                turnId: session.turns,
                evidenceVersion: session.turns + 1,
                runtimeState: { status: "WAITING_FOR_TOOL" },
                touchedFilePaths: groupTouched ?? (targetFilePath ? [targetFilePath] : []),
              })
            } catch (err) {
              throw new Error(`DURABILITY_UNAVAILABLE: Failed to record BEFORE_MUTATION checkpoint: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
            }
          } else if (this.#checkpointCoordinator && isVerification) {
            let op
            try {
              op = await this.#checkpointCoordinator.prepareOperation({
                runId: session.input.task.id,
                evidenceVersion: session.turns + 1,
                kind: "VERIFICATION",
                authorityId: "verification-engine",
                preconditions: [],
                expectedPostconditions: [],
                payload: { executionId: reviewable.id },
              })
            } catch (err) {
              throw new Error(`DURABILITY_UNAVAILABLE: Failed to prepare operation before verification: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
            }
            opId = op.operationId
            try {
              await this.#checkpointCoordinator.operationJournal.recordStarted(opId, session.input.task.id)
            } catch (err) {
              throw new Error(`DURABILITY_UNAVAILABLE: Failed to record operation started before verification: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
            }
            try {
              await this.#checkpointCoordinator.checkpoint({
                runId: session.input.task.id,
                reason: "BEFORE_VERIFICATION",
                phase: "VERIFYING",
                turnId: session.turns,
                evidenceVersion: session.turns + 1,
                runtimeState: { status: "VERIFYING" },
              })
            } catch (err) {
              throw new Error(`DURABILITY_UNAVAILABLE: Failed to record BEFORE_VERIFICATION checkpoint: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
            }
          }

          const onOutput = isVerification
            ? (chunk: { stream: "stdout" | "stderr"; chunk: string }) => {
                this.#emit("verification.output", {
                  callId: pending.prepared.id,
                  name: pending.prepared.name,
                  mutationId: reviewableId,
                  executionId: reviewableId,
                  stream: chunk.stream,
                  chunk: chunk.chunk,
                })
              }
            : undefined
          const result = await reviewable.apply({
            workspaceRoot: session.input.workspaceRoot,
            signal: session.input.signal ?? new AbortController().signal,
            onOutput,
            taskId: session.input.task.id,
            callId: pending.prepared.id,
            origin: "agent",
          }) as any

          let postDurabilityError: Error | undefined
          if (this.#checkpointCoordinator && opId) {
            try {
              if (isVerification) {
                if (result.status === "PASS") {
                  await this.#checkpointCoordinator.operationJournal.recordCompleted(opId, session.input.task.id, reviewable.id)
                } else {
                  await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, result.stderr ?? "Verification failed")
                }
                await this.#checkpointCoordinator.checkpoint({
                  runId: session.input.task.id,
                  reason: "AFTER_VERIFICATION",
                  phase: "VERIFYING",
                  turnId: session.turns,
                  evidenceVersion: session.turns + 1,
                  runtimeState: { status: "OBSERVING" },
                })
              } else {
                if (result.status === "APPLIED") {
                  await this.#checkpointCoordinator.operationJournal.recordCompleted(opId, session.input.task.id, reviewable.id)
                } else {
                  await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, result.error?.message ?? "Mutation failed")
                }
                await this.#checkpointCoordinator.checkpoint({
                  runId: session.input.task.id,
                  reason: "AFTER_MUTATION",
                  phase: "MUTATION",
                  turnId: session.turns,
                  evidenceVersion: session.turns + 1,
                  runtimeState: { status: "OBSERVING" },
                  touchedFilePaths: groupTouched ?? (targetFilePath ? [targetFilePath] : []),
                })
              }
            } catch (err) {
              postDurabilityError = err instanceof Error ? err : new Error(String(err))
            }
          }
          let reviewSucceeded = false
          if (isVerification) {
            reviewSucceeded = true
            this.#emit("verification.completed", {
              callId: pending.prepared.id,
              name: pending.prepared.name,
              mutationId: reviewable.id,
              executionId: reviewable.id,
              result,
            })
            const verificationStatus = recordedVerificationStatus(result.status)
            session.evidenceCollector.recordVerificationOutcome({
              executionId: reviewable.id,
              action: (pending.prepared.arguments as any)?.action || "TEST",
              status: verificationStatus,
              failedTestCount: typeof (result as any).failedTests === "number" ? (result as any).failedTests : verificationStatus === "PASS" ? 0 : 1,
              totalTestCount: (result as any).totalTests,
              stdout: result.stdout,
              stderr: result.stderr,
              diagnosis: result.diagnosis,
            })
          } else if (isBrowserReview) {
            reviewSucceeded = Boolean(result && typeof result === "object" && result.ok === true)
            if (reviewSucceeded) {
              this.#emit("mutation.applied", {
                callId: pending.prepared.id,
                name: pending.prepared.name,
                mutationId: reviewable.id,
                ...mutationPathPayload(pending.prepared.arguments, reviewable.reviewPayload),
              })
            } else {
              this.#emit("mutation.failed", { callId: pending.prepared.id, name: pending.prepared.name, mutationId: reviewable.id, error: result?.error })
            }
            session.evidenceCollector.recordToolAction({
              id: pending.prepared.id,
              toolName: pending.prepared.name,
              outcome: reviewSucceeded ? "COMPLETED" : "FAILED",
              args: pending.prepared.arguments as Record<string, unknown>,
              output: result,
            })
          } else {
            reviewSucceeded = result.status === "APPLIED" || result.status === "ALREADY_SATISFIED"
            if (result.status === "APPLIED") {
              this.#emit("mutation.applied", {
                callId: pending.prepared.id,
                name: pending.prepared.name,
                mutationId: reviewable.id,
                ...mutationPathPayload(pending.prepared.arguments, reviewable.reviewPayload),
              })
            } else if (result.status === "ALREADY_SATISFIED") {
              this.#emit("mutation.already_satisfied", {
                callId: pending.prepared.id,
                name: pending.prepared.name,
                mutationId: reviewable.id,
                ...mutationPathPayload(pending.prepared.arguments, reviewable.reviewPayload),
              })
            } else {
              this.#emit("mutation.failed", { callId: pending.prepared.id, name: pending.prepared.name, mutationId: reviewable.id, error: result.error })
            }
            // A grouped edit records every file it touched, so completion checks and verification selection see all of them.
            for (const outcomePath of groupedFilePaths(reviewable.reviewPayload) ?? [(pending.prepared.arguments as any)?.targetFile || (pending.prepared.arguments as any)?.path || ""]) {
              session.evidenceCollector.recordMutationOutcome({
                mutationId: reviewable.id,
                path: outcomePath,
                status: result.status === "APPLIED" ? "APPLIED" : result.status === "ALREADY_SATISFIED" ? "ALREADY_SATISFIED" : (result.error?.code === "STALE_BASE" ? "STALE" : "FAILED"),
                diffSummary: result.status === "ALREADY_SATISFIED" ? "already satisfied; no write" : ((reviewable.reviewPayload as any)?.summary || ""),
                operation: result.operation ?? mutationOperation(pending.prepared.name),
              })
            }
            if (result.status === "APPLIED") {
              session.evidenceCollector.resolveRecoveredToolContractFailures()
              if (!isVerification) session.observedLookups?.clear()
              if (pending.prepared.name === "rename_symbol") {
                const args = pending.prepared.arguments as { path?: unknown; symbol?: unknown; newName?: unknown }
                const renames = session.completedRenames ?? (session.completedRenames = [])
                renames.push({ path: String(args.path), symbol: String(args.symbol), newName: String(args.newName), mutationId: reviewable.id, files: groupedFilePaths(reviewable.reviewPayload) ?? [String(args.path)], repeats: 0 })
              }
            }
            if (result.status === "APPLIED" || result.status === "ALREADY_SATISFIED") await this.#refreshRequirementGaps()
          }
          observation = createToolObservation({
            toolName: pending.prepared.name,
            callId: pending.prepared.id,
            output: result,
            maxContentBytes: this.#observationMaxBytes,
            ...(toolArguments(pending.prepared.arguments) ? { arguments: toolArguments(pending.prepared.arguments) } : {}),
          })
          const diagnosis = String((result as { diagnosis?: unknown }).diagnosis ?? "")
          if (isVerification && result.status === "EXECUTION_ERROR" && diagnosis.startsWith("ENVIRONMENT_SETUP_REQUIRED:")) {
            const blocked = session.environmentBlocked ?? (session.environmentBlocked = new Map())
            blocked.set(String((pending.prepared.arguments as { action?: unknown }).action ?? ""), diagnosis.split(" This is not")[0]!)
          }
          session.observations.push(observation)
          session.toolCalls.push(recordCall(pending.prepared, reviewSucceeded ? "COMPLETED" : "FAILED", observation.truncated))
          session.evidenceLedger.recordObservation(
            pending.prepared.name,
            pending.prepared.id,
            pending.prepared.arguments as Record<string, unknown>,
            true,
            result,
          )

          if (postDurabilityError) {
            session.failureReason = "INTERNAL_ERROR"
            const message = `RECOVERY_PERSISTENCE_FAILED: Side effect succeeded but post-persistence failed: ${postDurabilityError.message}`
            this.#emit("task.failed", { message })
            return this.#result()
          }

          if (isVerification) {
            if (pending.prepared.id.startsWith("scheduled-verify-")) {
              const originatingEvalId = pending.prepared.id.replace("scheduled-verify-", "")
              const pass = (result as any)?.status === "PASS"
              session.evalLedger.recordInterventionOutcome(originatingEvalId, pass ? "RESOLVED" : "DEGRADED", `Verification ${(result as any)?.status}`)
              this.#emit("runtime_eval.outcome", {
                evalId: originatingEvalId,
                outcome: pass ? "RESOLVED" : "DEGRADED",
                details: `Verification result: ${(result as any)?.status}`,
              })
            }
            const { evalResult: verifEval, directive: verifDirective } = await this.#runEval("VERIFICATION_RESULT")
            if (this.#adaptiveInterventions && verifDirective.decision !== "CONTINUE") {
              const handled = await this.#dispatchDirective(verifEval, verifDirective, "VERIFICATION_RESULT")
              if (handled) return this.#result()
            }
          } else {
            const { evalResult: mutEval, directive: mutDirective } = await this.#runEval("MUTATION_RESULT")
            if (this.#adaptiveInterventions && mutDirective.decision !== "CONTINUE") {
              const handled = await this.#dispatchDirective(mutEval, mutDirective, "MUTATION_RESULT")
              if (handled) return this.#result()
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Mutation apply failed"
          session.failureReason = "INTERNAL_ERROR"

          if (this.#checkpointCoordinator && opId && !message.includes("DURABILITY_UNAVAILABLE")) {
            try {
              await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, message)
            } catch (failDurabilityErr) {
              const failDurabilityMsg = `RECOVERY_PERSISTENCE_FAILED: Operation failed and recordFailed persistence failed: ${failDurabilityErr instanceof Error ? failDurabilityErr.message : String(failDurabilityErr)}`
              this.#emit("task.failed", { message: failDurabilityMsg })
              return this.#result()
            }
          }

          observation = createToolObservation({ toolName: pending.prepared.name, callId: pending.prepared.id, error: { category: isVerification ? "VERIFICATION_ERROR" : "MUTATION_ERROR", message }, maxContentBytes: this.#observationMaxBytes })
          session.observations.push(observation)
          session.toolCalls.push({ id: pending.prepared.id, name: pending.prepared.name, outcome: "FAILED", truncated: observation.truncated })
          this.#emit(isVerification ? "verification.failed" : "mutation.failed", {
            callId: pending.prepared.id,
            name: pending.prepared.name,
            mutationId: pending.reviewable.id,
            ...(isVerification ? { executionId: pending.reviewable.id } : {}),
            message,
            error: error instanceof Error ? error : new Error(message),
          })
          session.evidenceCollector.recordToolAction({
            id: pending.prepared.id,
            toolName: pending.prepared.name,
            outcome: "FAILED",
            error: message,
          })
          if (message.includes("DURABILITY_UNAVAILABLE") || message.includes("RECOVERY_PERSISTENCE_FAILED")) {
            this.#emit("task.failed", { message })
            return this.#result()
          }
          const { evalResult: failEval, directive: failDirective } = await this.#runEval("TOOL_FAILURE")
          if (this.#adaptiveInterventions && failDirective.decision !== "CONTINUE") {
            const handled = await this.#dispatchDirective(failEval, failDirective, "TOOL_FAILURE")
            if (handled) return this.#result()
          }
        }

        const review = pending.reviewable?.reviewPayload as { path?: string; beforeHash?: string; afterHash?: string } | undefined
        const isMutation = pending.prepared.definition.action === "write_file" || pending.prepared.definition.action === "delete_file"
        if (await this.#observeProgress(pending.prepared, observation, isMutation && review?.path ? { path: review.path, ...(review.beforeHash ? { beforeHash: review.beforeHash } : {}), ...(review.afterHash ? { afterHash: review.afterHash } : {}) } : undefined)) return this.#result()
        const progressKey = `${pending.signature}\0${observation.ok}\0${observation.content}`
        session.repeatedProgress = session.lastProgressKey === progressKey ? session.repeatedProgress + 1 : 1
        session.lastProgressKey = progressKey
        if (session.repeatedProgress >= this.#nonProgressThreshold) {
          session.failureReason = "NON_PROGRESS"
          session.terminationSource = "NON_PROGRESS_GUARD"
          this.#emit("task.non_progress", { message: `Repeated ${pending.prepared.name} call made no progress`, threshold: this.#nonProgressThreshold, terminationSource: "NON_PROGRESS_GUARD" })
          return this.#result()
        }
      } else {
        this.#emit("permission.approved", { callId: pending.prepared.id, name: pending.prepared.name })
        if (await this.#execute(pending.prepared, pending.signature)) return this.#result()
      }
    }
    if (await this.#earlyChecks()) return this.#result()
    const afterApproval = this.#codingGoalVerdict()
    if (afterApproval?.accept && session.autoVerifyPending) {
      session.autoVerifyPending = false
      await this.#completeTask(afterApproval.summary)
      return this.#result()
    }
    if (
      afterApproval
      && afterApproval.editsSatisfied
      && !afterApproval.verificationSatisfied
      && this.#verificationRequired()
    ) {
      const verifyName = this.#registry.listDefinitions().find((definition) => definition.name === "run_verification" || definition.name === "run_known_test")?.name
      if (verifyName) {
        session.autoVerifyPending = true
        if (await this.#handleCall({ id: `auto-verify-${session.turns}`, name: verifyName, arguments: { action: this.#nextVerificationAction() } }) || session.refusalStop) {
          this.#finishRefusalStop()
          return this.#result()
        }
        const verified = this.#codingGoalVerdict()
        if (verified?.accept) {
          session.autoVerifyPending = false
          await this.#completeTask(verified.summary)
          return this.#result()
        }
      }
    }
    return this.#continue()
  }

  async resumeFromRecovery(runId: string, options?: {
    instruction?: string
    workspaceRoot?: string
    mode?: import("../contracts/agent.ts").AgentMode
    signal?: AbortSignal
  }): Promise<AgentResult> {
    if (!this.#checkpointCoordinator) {
      throw new AgentRunnerError("TERMINAL_STATE", "Recovery requires a configured CheckpointCoordinator")
    }

    const latestCp = await this.#checkpointCoordinator.checkpointStore.getLatestCheckpoint(runId)
    if (!latestCp) {
      throw new AgentRunnerError("TERMINAL_STATE", `No checkpoint found for runId: ${runId}`)
    }

    const plan = await this.#checkpointCoordinator.recoveryController.buildRecoveryPlan(runId)
    const wsRoot = options?.workspaceRoot ?? this.#checkpointCoordinator.workspaceRoot
    const instruction = options?.instruction ?? `Resume task ${runId}`
    const mode = options?.mode ?? "BUILD"
    const taskProfile = classifyTaskProfile(instruction, mode)

    const evalEngine = this.#evalEngine ?? new RuntimeEvalEngine()
    const evalPolicy = this.#evalPolicy ?? new AdaptiveControlPolicy()
    const evalLedger = this.#evalLedger ?? new RuntimeEvalLedger()
    const evalAnalytics = new RuntimeEvalAnalytics(evalLedger)
    const evidenceCollector = new RuntimeEvidenceCollector({
      runId,
      taskGoal: instruction,
    })

    evidenceCollector.recordRecoveryPlan(plan)
    const evalOutput = evaluateL0(evidenceCollector.getEvidence(), "RECOVERY_RESULT")
    const evalResult: RuntimeEvalResult = {
      evalId: `eval-rec-${runId}`,
      runId,
      turnId: latestCp.turnId ?? 0,
      checkpoint: "RECOVERY_RESULT",
      evidenceVersion: latestCp.evidenceVersion,
      decision: evalOutput.decision,
      scores: evalOutput.scores,
      signals: evalOutput.signals,
      recommendedAction: evalOutput.recommendedAction,
      evaluatorLevel: "L0",
      confidence: 1.0,
      evidenceRefs: [],
    }
    const directive = evalPolicy.determineDirective(evalResult, evidenceCollector.getEvidence())

    // Checkpoint recovery restored
    try {
      await this.#checkpointCoordinator.checkpoint({
        runId,
        reason: "RECOVERY_RECONCILED",
        phase: plan.disposition === "ASK_HUMAN" || plan.disposition === "RECONFIRM" ? "PLANNING" : latestCp.phase,
        turnId: latestCp.turnId ?? 0,
        evidenceVersion: latestCp.evidenceVersion + 1,
        runtimeState: {
          status: (directive.decision === "ASK_HUMAN" || plan.disposition === "ASK_HUMAN" || plan.disposition === "RECONFIRM" || plan.divergenceClass === "BLOCKED_DIVERGENCE")
            ? "WAITING_FOR_CONFIRMATION"
            : (plan.disposition === "STOP" || directive.decision === "STOP" ? "COMPLETED" : "PLANNING"),
        },
      })
    } catch (err) {
      this.#session = {
        input: {
          workspaceRoot: wsRoot,
          task: { id: runId, instruction, mode },
          maxTurns: 10,
          contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
          projectInstructions: [],
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        taskProfile,
        evidenceLedger: new EvidenceLedger(),
        evidenceCollector,
        evalEngine,
        evalPolicy,
        evalLedger,
        evalAnalytics,
        evalResults: [],
        state: {
          status: "PLANNING",
          task: { id: runId, instruction, mode },
          events: [],
        },
        turns: latestCp.turnId ?? 0,
        continuationAttempts: 0,
        observations: [],
        diagnostics: [],
        toolCalls: [],
        repeatedProgress: 0,
        failureReason: "INTERNAL_ERROR",
      }
      const message = `RECOVERY_PERSISTENCE_FAILED: Failed to record RECOVERY_RECONCILED checkpoint: ${err instanceof Error ? err.message : String(err)}`
      this.#emit("task.failed", { message })
      const res = this.#result()
      return { ...res, recoveryPlan: plan }
    }

    if (plan.divergenceClass === "BLOCKED_DIVERGENCE") {
      this.#session = {
        input: {
          workspaceRoot: wsRoot,
          task: { id: runId, instruction, mode },
          maxTurns: 10,
          contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
          projectInstructions: [],
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        taskProfile,
        evidenceLedger: new EvidenceLedger(),
        evidenceCollector,
        evalEngine,
        evalPolicy,
        evalLedger,
        evalAnalytics,
        evalResults: [],
        state: {
          status: "FAILED",
          events: [],
        },
        turns: latestCp.turnId ?? 0,
        continuationAttempts: 0,
        observations: [],
        diagnostics: [],
        toolCalls: [],
        repeatedProgress: 0,
        failureReason: "INCOMPLETE",
        finalAnswer: "Workspace files changed since the last checkpoint. Resolve the stale files before continuing. No writes were replayed.",
      }
      this.#emit("task.failed", { message: "BLOCKED_DIVERGENCE: workspace diverged from the turn-budget checkpoint" })
      const diverged = this.#result()
      return { ...diverged, recoveryPlan: plan }
    }

    // Check if recovery requires human escalation or reconfirmation
    if (directive.decision === "ASK_HUMAN" || plan.disposition === "ASK_HUMAN" || plan.disposition === "RECONFIRM") {
      const pendingConf = latestCp.runtimeState.pendingConfirmation
      const recoveredConfirmation: AgentConfirmationRequest | undefined = pendingConf ? {
        callId: pendingConf.callId,
        toolName: pendingConf.toolName,
        action: pendingConf.action as any,
        arguments: (pendingConf.arguments as Record<string, unknown>) ?? {},
      } : undefined

      this.#session = {
        input: {
          workspaceRoot: wsRoot,
          task: { id: runId, instruction, mode },
          maxTurns: 10,
          contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
          projectInstructions: [],
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        taskProfile,
        evidenceLedger: new EvidenceLedger(),
        evidenceCollector,
        evalEngine,
        evalPolicy,
        evalLedger,
        evalAnalytics,
        evalResults: [
          {
            evalId: `eval-rec-${runId}`,
            runId,
            turnId: latestCp.turnId ?? 0,
            checkpoint: "RECOVERY_RESULT",
            evidenceVersion: latestCp.evidenceVersion,
            decision: directive.decision,
            scores: evalOutput.scores,
            signals: evalOutput.signals,
            recommendedAction: evalOutput.recommendedAction,
            evaluatorLevel: "L0",
            confidence: 1.0,
            evidenceRefs: [],
          }
        ],
        state: {
          status: "WAITING_FOR_CONFIRMATION",
          events: [],
        },
        turns: latestCp.turnId ?? 0,
        continuationAttempts: 0,
        observations: [],
        diagnostics: [],
        toolCalls: [],
        repeatedProgress: 0,
        recoveredConfirmation,
      }
      const res = this.#result()
      return { ...res, recoveryPlan: plan }
    }

    if (plan.disposition === "STOP" || directive.decision === "STOP") {
      this.#session = {
        input: {
          workspaceRoot: wsRoot,
          task: { id: runId, instruction, mode },
          maxTurns: 10,
          contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
          projectInstructions: [],
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        taskProfile,
        evidenceLedger: new EvidenceLedger(),
        evidenceCollector,
        evalEngine,
        evalPolicy,
        evalLedger,
        evalAnalytics,
        evalResults: [],
        state: {
          status: "COMPLETED",
          events: [],
        },
        turns: latestCp.turnId ?? 0,
        continuationAttempts: 0,
        observations: [],
        diagnostics: [],
        toolCalls: [],
        repeatedProgress: 0,
      }
      return this.#result()
    }

    const working = latestCp.runtimeState.workingContext
    for (const path of working?.completedPaths ?? []) {
      evidenceCollector.recordMutationOutcome({
        mutationId: `recovered:${path}`,
        path,
        status: "APPLIED",
        diffSummary: "already applied before recovery",
        operation: "patch",
      })
    }
    for (const path of working?.alreadyPresentPaths ?? []) {
      evidenceCollector.recordMutationOutcome({
        mutationId: `recovered-present:${path}`,
        path,
        status: "ALREADY_SATISFIED",
        diffSummary: "already satisfied; no write",
        operation: "patch",
      })
    }
    const recoveredTask = latestCp.runtimeState.activeTask
    const recoveredInstruction = recoveredTask?.instruction ?? instruction
    const recoveredMode = (recoveredTask?.mode as AgentRunnerInput["task"]["mode"] | undefined) ?? mode
    this.#session = {
      input: {
        workspaceRoot: wsRoot,
        task: { id: runId, instruction: recoveredInstruction, mode: recoveredMode },
        maxTurns: UNLIMITED_MAX_TURNS,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      taskProfile: classifyTaskProfile(recoveredInstruction, recoveredMode),
      evidenceLedger: new EvidenceLedger(),
      evidenceCollector,
      evalEngine,
      evalPolicy,
      evalLedger,
      evalAnalytics,
      evalResults: [],
      state: {
        status: "OBSERVING",
        task: { id: runId, instruction: recoveredInstruction, mode: recoveredMode },
        events: [],
      },
      turns: latestCp.turnId ?? 0,
      continuationAttempts: 0,
      observations: [...(working?.observations ?? [])] as ToolObservation[],
      diagnostics: [],
      toolCalls: [...(working?.toolCalls ?? [])] as AgentToolCallRecord[],
      repeatedProgress: 0,
    }
    if (working?.lastVerification) {
      this.#session.observations.push(createToolObservation({
        toolName: "run_verification",
        callId: `recover-verify-${runId}`,
        output: `Last verification ${working.lastVerification.status}${working.lastVerification.failureSummary ? `: ${working.lastVerification.failureSummary}` : ""}. Change remaining code before repeating an identical failing test run.`,
        maxContentBytes: this.#observationMaxBytes,
      }))
    }
    this.#session.observations.push(createToolObservation({
      toolName: "continuation",
      callId: `recover-${runId}`,
      output: this.#completedWorkNotice(),
      maxContentBytes: this.#observationMaxBytes,
    }))
    return this.#continue()
  }

  async #continue(): Promise<AgentResult> {
    const session = this.#requiredSession()
    while (!["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_CONFIRMATION"].includes(session.state.status)) {
      if (session.input.signal?.aborted) {
        this.#cancel()
        break
      }
      if (session.refusalStop) {
        this.#finishRefusalStop()
        break
      }
      if (session.input.unitBudgetMs !== undefined) {
        session.unit ??= { index: 1, deadline: Date.now() + session.input.unitBudgetMs, appliedAtStart: this.#progressCount().applied, metAtStart: this.#progressCount().met }
        if (Date.now() >= session.unit.deadline && !this.#codingGoalVerdict()?.accept) {
          // A work-unit boundary, not a failure: state, edits and the outcome report are kept for continueFromLimit.
          session.failureReason = "MAX_TURNS_EXCEEDED"
          this.#recordTurnExhaustion()
          this.#emit("task.max_turns", { message: `Work unit ${session.unit.index} of ${MAX_WORK_UNITS} reached its ${Math.round(session.input.unitBudgetMs / 60_000)}-minute budget` })
          await this.#persistTurnLimitCheckpoint()
          break
        }
      }
      if (!isUnlimitedTurnBudget(session.input.maxTurns) && session.turns >= session.input.maxTurns) {
        const met = this.#codingGoalVerdict()
        if (met?.accept) {
          await this.#completeTask(met.summary)
          break
        }
        session.failureReason = "MAX_TURNS_EXCEEDED"
        this.#recordTurnExhaustion()
        this.#emit("task.max_turns", { message: `Maximum of ${session.input.maxTurns} model turns reached` })
        await this.#persistTurnLimitCheckpoint()
        break
      }

      const hasRealEvidence = session.evidenceLedger.totalObservations > 0
      const evidenceEvaluation = session.evidenceLedger.evaluate(
        session.taskProfile.evidenceRequirements,
        session.taskProfile.explicitFilePaths,
      )
      const directReply = session.taskProfile.directReply === true || isSocialTurn(session.input.task.instruction)
      const answerableWithoutEdit = !session.taskProfile.requiresCodeChange
      const isEvidenceSatisfied = directReply || (hasRealEvidence && evidenceEvaluation.satisfied)

      const isTurnBudgetTight = !isUnlimitedTurnBudget(session.input.maxTurns) && session.turns >= session.input.maxTurns - 1
      const allowedToolNames = new Set(session.taskProfile.allowedTools)
      const isStandardToolsOnly = this.#registry
        .listDefinitions()
        .every((definition) => ["read_file", "list_directory", "find_files", "search_text"].includes(definition.name))
      const directoryListings = session.toolCalls.filter((item) => item.name === "list_directory" && item.outcome === "COMPLETED" && item.alreadyObserved !== true).length
      const mutationFacts = session.evidenceCollector.getEvidence().mutationOutcomes
      const hasAppliedEdit = mutationFacts.some((mutation) => mutation.status === "APPLIED" || mutation.status === "ALREADY_SATISFIED")
      const productSourceApplied = mutationFacts.some((mutation) => (mutation.status === "APPLIED" || mutation.status === "ALREADY_SATISFIED") && isProductSource(mutation.path))
      const testFileApplied = mutationFacts.some((mutation) => (mutation.status === "APPLIED" || mutation.status === "ALREADY_SATISFIED") && isTestArtifactPath(mutation.path))
      const testsStillOwed = session.taskProfile.requiresCodeChange && requestsNewTest(session.input.task.instruction) && !testFileApplied && productSourceApplied
      const stopExploring = session.taskProfile.requiresCodeChange && (
        (!hasAppliedEdit && session.turns >= MAX_EXPLORATION_TURNS_WITHOUT_EDIT)
        || (testsStillOwed && hasAppliedEdit)
      )
      const forceMutation = session.taskProfile.requiresCodeChange && (
        (!hasAppliedEdit && session.turns >= MAX_READ_TURNS_WITHOUT_EDIT)
        || (testsStillOwed && hasAppliedEdit && session.turns >= MAX_READ_TURNS_WITHOUT_EDIT + 4)
      )
      const tools = this.#registry
        .listDefinitions()
        .filter((definition) => !isStandardToolsOnly || allowedToolNames.has(definition.name))
        .filter((definition) => this.#permission(definition.action) !== "DENY")
        // Repair stage: after a failed run, the only useful next step is a code change. The test tool is not
        // offered again until something in the workspace changes (it would be refused anyway).
        .filter((definition) => definition.action !== "run_known_test" || !this.#verificationWaitingOnEdit(session))
        .filter((definition) => definition.name !== "list_directory" || !session.taskProfile.requiresCodeChange || directoryListings < MAX_EDIT_TASK_DIRECTORY_LISTINGS)
        .filter((definition) => !stopExploring || !EXPLORATION_TOOLS.has(definition.name))
        .filter((definition) => !forceMutation || !READ_TOOLS.has(definition.name))
      const codingAssessment = session.taskProfile.requiresCodeChange ? this.#assessCoding("NOT_RUN") : undefined
      const editOutstanding = Boolean(codingAssessment && !codingAssessment.editsSatisfied)
      const verificationOutstanding = Boolean(codingAssessment?.editsSatisfied && !codingAssessment.verificationSatisfied)
      const fileChangeGuidance = mutationToolGuidance(tools.map((tool) => tool.name))

      const requestedPaths = requiredEditPaths(session.input.task.instruction, session.taskProfile.explicitFilePaths)
      const testOnlyRequest = requestedPaths.length > 0 && requestedPaths.every((path) => isTestArtifactPath(path))
      const namedTargets = await classifyNamedEditTargets(session.input.workspaceRoot, requestedPaths)
      const observedExisting = session.evidenceLedger.filesRead
      const mutationOutcomes = session.evidenceCollector.getEvidence().mutationOutcomes
      const completedPaths = [...new Set(mutationOutcomes.filter((mutation) => mutation.status === "APPLIED" || mutation.status === "ALREADY_SATISFIED").map((mutation) => mutation.path).filter((path) => path.trim().length > 0))]
      const pendingPaths = requestedPaths.filter((path) => !completedPaths.some((done) => pathsReferToSameFile(done, path)))
      const strategyNote = editingStrategyGuidance({
        existingNamed: namedTargets.existing,
        missingNamed: namedTargets.missing,
        observedExisting,
        completed: completedPaths,
        pending: pendingPaths,
      })
      const existingOnly = namedTargets.existing.length > 0 && namedTargets.missing.length === 0
      const briefOutcomes = session.outcomes ?? (() => { const d = deriveOutcomes(session.input.task.instruction); return isSubstantial(d) ? d : undefined })()
      const workUnit = briefOutcomes && session.taskProfile.requiresCodeChange && currentWorkUnit(briefOutcomes) ? formatWorkUnit(briefOutcomes) : ""
      const dynamicBanner = workUnit + (editOutstanding
        ? testOnlyRequest
          ? `\n\n[EDIT REQUIRED]\nCreate or update only ${requestedPaths.join(", ")}. Do not modify other files. ${existingOnly ? "Those files already exist. Use apply_patch only." : "Use create_file only when that file does not exist yet."}${strategyNote ? ` ${strategyNote}` : ""}${isTurnBudgetTight ? " The turn budget is almost exhausted." : ""}`
          : `\n\n[EDIT REQUIRED]\nApply the requested code change before answering. A test-only edit does not finish a behavior change. Use apply_patch for an existing file and create_file only for a new file.${strategyNote ? ` ${strategyNote}` : ""}${isTurnBudgetTight ? " The turn budget is almost exhausted." : ""}`
        : verificationOutstanding
          ? "\n\n[VERIFICATION REQUIRED]\nThe requested edit is applied. Run the tests before answering. Do not finish while verification is outstanding."
          : directReply
            ? "\n\n[CONVERSATION]\nAnswer the user directly. Do not call tools. Do not edit files. A greeting or question is complete without a source change."
          : isEvidenceSatisfied
            ? ""
            : answerableWithoutEdit
              ? "\n\n[NO EDIT REQUIRED]\nThis request does not ask for a source change. Answer it. Use a tool only when the answer depends on a repository fact."
            : isTurnBudgetTight
              ? "\n\n[TURN BUDGET WARNING]\nYou are approaching your turn limit. Provide your grounded answer now without calling any further tools."
              : "")

      const phaseInstruction = editOutstanding
        ? testOnlyRequest
          ? `Create or update only ${requestedPaths.join(", ")}. ${existingOnly ? "Use apply_patch; do not call create_file." : "Use create_file only when that file does not exist, and apply_patch when it already exists."} Do not modify other files. Strategy: ${session.taskProfile.toolGuidance}${strategyNote ? ` ${strategyNote}` : ""}`
          : `Apply the requested edit. Inspect the repository when needed, then call apply_patch for existing files and create_file only for a genuinely new file. Strategy: ${session.taskProfile.toolGuidance}${strategyNote ? ` ${strategyNote}` : ""}`
        : verificationOutstanding
          ? "Run the project tests now. Inspection alone is not completion, and the edit is not complete until verification has run."
          : directReply
            ? "Answer the user's message in plain language. Do not call tools and do not edit files."
          : isEvidenceSatisfied
            ? "Phase 2 - Answer: Answer from the observations now. Do not call more tools."
            : answerableWithoutEdit
              ? `Answer the user. Do not edit files. Inspect the repository only if a fact is required. Strategy: ${session.taskProfile.toolGuidance}`
            : `Phase 1 - Investigation: Use tools to inspect the repository. Strategy: ${session.taskProfile.toolGuidance}`

      const completionLine = editOutstanding
        ? testOnlyRequest
          ? `Completion: Do not finish until ${requestedPaths.join(", ")} is prepared for approval. That file is the requested change.`
          : "Completion: Do not finish until the requested implementation edit is prepared for approval. A test run or a test-file edit alone does not apply the requested behavior change."
        : verificationOutstanding
          ? "Completion: Do not finish until the tests have run after the edit."
          : "Completion: When you have sufficient evidence from the observations to answer, output your answer directly without calling more tools."

      const guidanceInstruction: ProjectInstruction = {
        id: "investigation-guidance",
        path: "GUIDELINES.md",
        content: `Operating Guidelines:
- ${phaseInstruction}
- Grounding: Always include the exact function names, literals, values, ports, and file paths found in the observations.
- ${CONVERSATIONAL_RESPONSE_GUIDANCE}
- ${completionLine}${fileChangeGuidance ? `\n${fileChangeGuidance}` : ""}${dynamicBanner}`,
      }

      let compiled: CompiledContext
      try {
        compiled = this.#contextCompiler({
          task: session.input.task.instruction,
          projectInstructions: [guidanceInstruction, ...session.input.projectInstructions],
          ...(session.input.selectedSkills ? { selectedSkills: session.input.selectedSkills } : {}),
          ...(session.input.skillGuidance ? { skillGuidance: session.input.skillGuidance } : {}),
          ...(session.input.learnedMemory && session.input.learnedMemory.length > 0 ? { learnedMemory: session.input.learnedMemory } : {}),
          ...(session.input.codeContext ? { codeContext: session.input.codeContext } : {}),
          ...(session.input.recentTurns ? { recentTurns: session.input.recentTurns } : {}),
          observations: this.#encodingFor(session) === "native-tool-messages" ? [] : session.observations,
          budget: session.input.contextBudget,
        })
      } catch (error) {
        session.failureReason = error instanceof ContextBudgetError && error.code === "REQUIRED_CONTEXT_OVERFLOW"
          ? "CONTEXT_OVERFLOW"
          : "INTERNAL_ERROR"
        this.#emit("task.failed", { message: error instanceof Error ? error.message : "Context compilation failed" })
        break
      }
      const turn = session.turns + 1
      session.diagnostics.push({ turn, totalEstimatedTokens: compiled.totalEstimatedTokens, omittedItemIds: compiled.omittedItemIds })
      session.shownItemIds = new Set(compiled.items.map((item) => item.id))
      this.#emit("context.compiled", { turn, estimatedTokens: compiled.totalEstimatedTokens, omittedCount: compiled.omittedItemIds.length })

      let promptContent = renderContext(compiled)
      if (!editOutstanding && !verificationOutstanding && isStandardToolsOnly && (isEvidenceSatisfied || isTurnBudgetTight)) {
        promptContent += "\n\n---\n**Instruction**: Repository evidence has been collected above. DO NOT emit any tool calls. Provide your final grounded answer directly now."
      }

      session.consecutiveContextRequests = 0

      const request: ModelRequest = {
        messages: this.#encodingFor(session) === "native-tool-messages"
          ? buildNativeToolMessages({ promptContent, observations: session.observations, toolCalls: session.toolCalls })
          : [{ role: "user", content: promptContent }],
        ...(session.input.signal ? { signal: session.input.signal } : {}),
        tools,
        metadata: {
          turn,
          tools,
          ...(session.pendingRouteHint ? { routeHint: session.pendingRouteHint } : {}),
          ...(session.pendingModelRecommendation ? { modelRecommendation: session.pendingModelRecommendation } : {}),
        },
      }
      session.pendingRouteHint = undefined
      session.pendingModelRecommendation = undefined
      this.#emit("model.requested", { turn })
      session.turns = turn
      let response
      try {
        response = await this.#provider.complete(request)
      } catch (error) {
        if (session.pendingModelEvalId) {
          session.evalLedger.recordInterventionOutcome(session.pendingModelEvalId, "DEGRADED", "Model request failed after model change")
          this.#emit("runtime_eval.outcome", {
            evalId: session.pendingModelEvalId,
            outcome: "DEGRADED",
            details: "Model request failed after model change",
          })
          session.pendingModelEvalId = undefined
        }
        const isTimeout = (error instanceof Error && (error.name === "TimeoutError" || error.message.toLowerCase().includes("timeout") || (error as any).code === "ETIMEDOUT")) ||
          Boolean(session.input.signal?.aborted && session.input.signal.reason?.name === "TimeoutError")
        if (isTimeout) {
          session.timeoutOccurred = true
        }
        if (isAbortError(error, session.input.signal)) this.#cancel()
        else {
          session.failureReason = "MODEL_ERROR"
          this.#emit("model.failed", { turn, message: error instanceof Error ? error.message : "Model request failed" })
        }
        break
      }

      const newDeploymentId = (response.metadata?.routeProvenance as any)?.deploymentId as string | undefined
      if (session.pendingModelEvalId) {
        const changed = Boolean(newDeploymentId && session.lastDeploymentId && newDeploymentId !== session.lastDeploymentId)
        const outcome = changed ? "RESOLVED" : "UNCHANGED"
        const details = changed
          ? `Switched deployment from ${session.lastDeploymentId} to ${newDeploymentId}`
          : (newDeploymentId ? `Retained deployment ${newDeploymentId}` : "Model request completed")
        session.evalLedger.recordInterventionOutcome(session.pendingModelEvalId, outcome, details)
        this.#emit("runtime_eval.outcome", {
          evalId: session.pendingModelEvalId,
          outcome,
          details,
        })
        session.pendingModelEvalId = undefined
      }
      if (newDeploymentId || response.model) {
        session.lastDeploymentId = newDeploymentId ?? response.model
      }
      let calls = [...(response.toolCalls ?? [])]
      const assistantText = response.message.content.trim()
      if (assistantText) session.lastAssistantText = assistantText
      this.#emit("model.completed", { turn, toolCallCount: calls.length, hasAnswer: response.message.content.length > 0 })
      if (calls.length > 0) {
        const verdict = this.#codingGoalVerdict()
        if (verdict?.accept) {
          await this.#completeTask(response.message.content.trim() || verdict.summary)
          break
        }
      }
      if (calls.length === 0) {
        const codingVerdict = this.#codingGoalVerdict()
        if (codingVerdict?.accept) {
          await this.#completeTask(response.message.content.trim() || codingVerdict.summary)
          break
        }
        // The bound is on nudges with no new edit between them: a long task may be nudged again after real progress.
        const appliedNow = this.#progressCount().applied
        if (appliedNow > (session.gateAppliedMark ?? 0)) session.continuationAttempts = 0
        session.gateAppliedMark = appliedNow
        if (codingVerdict && !codingVerdict.editsSatisfied && session.continuationAttempts < this.#maxContinuations) {
          session.continuationAttempts += 1
          const gatePaths = requiredEditPaths(session.input.task.instruction, session.taskProfile.explicitFilePaths)
          const gateTestOnly = gatePaths.length > 0 && gatePaths.every((path) => isTestArtifactPath(path))
          const gateTargets = await classifyNamedEditTargets(session.input.workspaceRoot, gatePaths)
          const gateExisting = gateTargets.existing.length > 0 && gateTargets.missing.length === 0
          const claimNote = /\b(?:I(?:'ve| have)?|we(?:'ve| have)?)\s+(?:applied|created|written|wrote|added|implemented|updated)\b/i.test(response.message.content) ? "Your last message says changes were applied, but the workspace does not show them. " : ""
          session.observations.push(createToolObservation({
            toolName: "coding_gate",
            callId: `edit-gate-${session.continuationAttempts}`,
            error: {
              category: "EDIT_REQUIRED",
              message: gateTestOnly
                ? `[EDIT REQUIRED]\n${claimNote}Create or update only ${gatePaths.join(", ")}. ${gateExisting ? "Those files already exist. Use apply_patch only." : "Use create_file only when that file does not exist."} A prose answer is not enough.`
                : codingVerdict.gaps && codingVerdict.gaps.length > 0
                  ? `[NOT DONE YET]\n${claimNote}Parts of the request are still missing:\n${codingVerdict.gaps.map((gap) => `- ${gap}`).join("\n")}\nCall apply_patch or create_file for them now; a message describing the change is not the change.`
                  : `[EDIT REQUIRED]\n${claimNote}The requested implementation change is not applied. Call apply_patch on the existing source file, or create_file only for a new file. A test-only edit or a prose answer is not enough.`,
            },
            maxContentBytes: this.#observationMaxBytes,
          }))
          continue
        }
        if (calls.length === 0 && this.#evidenceGate && !codingVerdict) {
          const evalResult = session.evidenceLedger.evaluate(
            session.taskProfile.evidenceRequirements,
            session.taskProfile.explicitFilePaths,
          )
          if (!evalResult.satisfied && session.continuationAttempts < this.#maxContinuations) {
            session.continuationAttempts += 1
            const gateMessage = `[EVIDENCE REQUIRED]\nYour response was provided before mandatory repository evidence was gathered. Do not guess.\nPlease continue your investigation by calling the appropriate tool(s):\n${evalResult.missing.map((m) => `- ${m.description}`).join("\n")}`
            const gateObservation = createToolObservation({
              toolName: "evidence_gate",
              callId: `gate-${session.continuationAttempts}`,
              error: { category: "EVIDENCE_INSUFFICIENT", message: gateMessage },
              maxContentBytes: this.#observationMaxBytes,
            })
            session.observations.push(gateObservation)
            continue
          }
        }

        if (calls.length > 0) {
          // Fall through to execute tool calls from this model turn.
        } else {
        // T-4404 / T-4417: BEFORE_COMPLETION evaluation checkpoint
        const { evalResult: beforeCompEval, directive } = await this.#runEval("BEFORE_COMPLETION")

        if (this.#adaptiveInterventions) {
          if (directive.action === "SCHEDULE_VERIFICATION") {
            const { outcome: verifOutcome, evalResult: postVerifEval, directive: postVerifDirective } = await this.#executeScheduledVerification(beforeCompEval.evalId)
            if (verifOutcome === "WAITING_CONFIRMATION" || session.state.status === "WAITING_FOR_CONFIRMATION" || ["FAILED", "CANCELLED"].includes(session.state.status)) {
              return this.#result()
            }

            const hasMutations = session.evidenceCollector.getEvidence().mutationOutcomes.some((m) => m.status === "APPLIED")
            const isVerificationRequired = this.#verificationRequired()

            if (verifOutcome === "UNAVAILABLE") {
              if (hasMutations && isVerificationRequired) {
                session.failureReason = "VERIFICATION_UNAVAILABLE"
                session.finalAnswer ??= this.#assessCoding("UNAVAILABLE").summary
                this.#emit("task.failed", { message: "VERIFICATION_UNAVAILABLE: Verification was required following code mutation but verification capability is unavailable" })
                break
              }
              await this.#acceptCompletion(response.message.content, "UNAVAILABLE")
              break
            }

            if (verifOutcome === "PASSED") {
              // Post-verification evaluation MUST control whether completion is allowed!
              if (postVerifDirective && postVerifDirective.decision !== "CONTINUE") {
                const handled = await this.#dispatchDirective(postVerifEval!, postVerifDirective, "VERIFICATION_RESULT")
                if (handled) return this.#result()
                continue
              }
              await this.#acceptCompletion(response.message.content, "PASSED")
              break
            }

            // verifOutcome === "FAILED"
            if (postVerifDirective) {
              const handled = await this.#dispatchDirective(postVerifEval!, postVerifDirective, "VERIFICATION_RESULT")
              if (handled) return this.#result()
            } else {
              session.observations.push(
                createToolObservation({
                  toolName: "runtime_eval_revision",
                  callId: beforeCompEval.evalId,
                  error: {
                    category: "VERIFICATION_FAILED",
                    message: "Verification failed following code mutation. Review test output and fix defect before completing.",
                  },
                  maxContentBytes: this.#observationMaxBytes,
                })
              )
            }
            continue
          } else if (directive.decision !== "CONTINUE") {
            const handled = await this.#dispatchDirective(beforeCompEval, directive, "BEFORE_COMPLETION")
            if (handled) return this.#result()
            continue
          }
        }

        if (
          calls.length === 0
          && codingVerdict?.editsSatisfied
          && !codingVerdict.verificationSatisfied
          && this.#verificationRequired()
        ) {
          const verifyName = this.#registry.listDefinitions().find((definition) => definition.name === "run_verification" || definition.name === "run_known_test")?.name
          const blocked = session.environmentBlocked?.get(this.#nextVerificationAction())
          if (verifyName && blocked) {
            // The only thing left is a verification this workspace cannot run: end truthfully as unverified.
            await this.#acceptCompletion(response.message.content, "UNAVAILABLE", blocked)
            if (session.failureReason === "VERIFICATION_UNAVAILABLE") session.failureReason = "ENVIRONMENT_SETUP_REQUIRED"
            break
          }
          if (verifyName) {
            session.autoVerifyPending = true
            calls = [{ id: `auto-verify-${session.turns}`, name: verifyName, arguments: { action: this.#nextVerificationAction() } }]
          }
        }

        if (calls.length === 0) {
          await this.#acceptCompletion(response.message.content, "NOT_RUN")
          break
        }
        }
      }

      let stopped = false
      this.#mutationStep?.resetStepCounter()
      for (const call of calls) {
        if (await this.#handleCall(call) || session.refusalStop) {
          this.#finishRefusalStop()
          stopped = true
          break
        }
      }
      if (!stopped && (await this.#earlyChecks())) stopped = true
      if (!stopped) {
        const afterTools = this.#codingGoalVerdict()
        if (afterTools?.accept && (session.autoVerifyPending || response.message.content.trim())) {
          session.autoVerifyPending = false
          await this.#completeTask(response.message.content.trim() || afterTools.summary)
          break
        }
      }
      // Context burn: several tool-using turns in a row that produced no new durable evidence.
      if (!stopped && session.progressGuard && session.state.status === "OBSERVING") {
        const burn = session.progressGuard.endTurn()
        if (burn.length > 0 && (await this.#handleDirectStall(burn, { name: calls.at(-1)?.name ?? "unknown", ...(session.observations.at(-1) ? { observation: session.observations.at(-1)! } : {}) }))) break
      }
    }
    return this.#result()
  }

  /**
   * Checks that should not wait for the end of the task: the tests once a test file was written or changed, and a
   * typecheck once an exported type changed. Each runs at most once per batch of edits. True when the run must stop.
   */
  async #earlyChecks(): Promise<boolean> {
    const session = this.#requiredSession()
    const verifyName = this.#registry.listDefinitions().find((definition) => definition.name === "run_verification")?.name
    if (!verifyName) return false
    if (this.#testFileEditedSinceVerification() && !session.environmentBlocked?.get("TEST")) {
      if (await this.#handleCall({ id: `auto-verify-${session.turns}`, name: verifyName, arguments: { action: "TEST" } }) || session.refusalStop) { this.#finishRefusalStop(); return true }
      if (session.state.status === "WAITING_FOR_CONFIRMATION") return true // the run is waiting for the user to approve the test run
    }
    if (session.typeShapePaths?.size && this.#additionalVerification().includes("TYPECHECK")) {
      const changed = [...session.typeShapePaths]
      session.typeShapePaths.clear()
      const applied = session.evidenceCollector.getEvidence().mutationOutcomes.some((mutation) => mutation.status === "APPLIED" && changed.some((path) => pathsReferToSameFile(mutation.path, path)))
      if (applied) {
        if (await this.#handleCall({ id: `auto-verify-${session.turns}-types`, name: verifyName, arguments: { action: "TYPECHECK" } }) || session.refusalStop) { this.#finishRefusalStop(); return true }
        if (session.state.status === "WAITING_FOR_CONFIRMATION") return true
      }
    }
    return false
  }

  /** True when a test file was written or changed after the last verification (ordered by the collector's sequence). */
  #testFileEditedSinceVerification(): boolean {
    const evidence = this.#requiredSession().evidenceCollector.getEvidence()
    const last = evidence.verificationOutcomes.at(-1)
    return evidence.mutationOutcomes.some((mutation) => mutation.status === "APPLIED" && isTestArtifactPath(mutation.path) && (
      !last || (mutation.sequence !== undefined && last.sequence !== undefined ? mutation.sequence > last.sequence : mutation.timestamp > last.timestamp)
    ))
  }

  /** Edits applied and outcomes met so far: what a work unit must increase to be worth continuing. */
  #progressCount(): { applied: number; met: number } {
    const session = this.#requiredSession()
    const applied = session.evidenceCollector.getEvidence().mutationOutcomes.filter((mutation) => mutation.status === "APPLIED").length
    const met = (session.outcomes ?? []).filter((outcome) => outcome.status === "IMPLEMENTED" || outcome.status === "VERIFIED").length
    return { applied, met }
  }

  /** Turn exhaustion without new evidence is reported as a bounded non-progress blocker. */
  #recordTurnExhaustion(): void {
    const session = this.#requiredSession()
    const guard = session.progressGuard
    if (!guard || guard.noEvidenceTurns === 0 || session.nonProgress?.finalBlocker) return
    const signal: ProgressSignal = { kind: "CONTEXT_BURN", count: guard.noEvidenceTurns, threshold: 1, pattern: `the turn budget ran out after ${guard.noEvidenceTurns} turn(s) without new evidence` }
    const plan = buildRecoveryPlan({
      capture: { stage: "DIRECT", signals: [signal] },
      preliminary: { failureClass: "CONTEXT_DEGRADATION", hypothesis: "the run is repeating actions without gaining evidence", check: "CONTEXT_COMPACTION", checkDescription: "count turns since the last new evidence" },
      result: { observed: `${guard.noEvidenceTurns} final turn(s) added no new evidence` },
      budgetAvailable: false,
    })
    session.nonProgress = {
      signals: [...(session.nonProgress?.signals ?? []), signal].slice(-12),
      recoveryAttempted: guard.recoveryCount > 0,
      recoveryCount: guard.recoveryCount,
      recoveryPlan: plan,
      recoveryOutcome: guard.recoveryCount > 0 ? "NOT_RECOVERED" : "ESCALATED",
      finalBlocker: buildNonProgressReport(plan, session.observations.at(-1)?.content ?? "", plan.observedResult ?? ""),
      observationsDropped: session.nonProgress?.observationsDropped ?? 0,
    }
  }

  #completedWorkNotice(): string {
    const session = this.#requiredSession()
    const completedCalls = session.toolCalls.filter((call) => call.outcome === "COMPLETED")
    const evidence = session.evidenceCollector.getEvidence()
    const outcomes = evidence.mutationOutcomes
    const applied = outcomes
      .filter((mutation) => mutation.status === "APPLIED" && mutation.path.trim().length > 0)
      .map((mutation) => mutation.path)
    const alreadyPresent = outcomes
      .filter((mutation) => mutation.status === "ALREADY_SATISFIED" && mutation.path.trim().length > 0)
      .map((mutation) => mutation.path)
    const uniquePaths = [...new Set(applied)]
    const uniquePresent = [...new Set(alreadyPresent)]
    const requested = requiredEditPaths(session.input.task.instruction, session.taskProfile.explicitFilePaths)
    const remaining = requested.filter((wanted) =>
      !uniquePaths.some((path) => pathsReferToSameFile(path, wanted))
      && !uniquePresent.some((path) => pathsReferToSameFile(path, wanted)),
    )
    const lastVerification = evidence.verificationOutcomes.at(-1)
    const verification = lastVerification
      ? `${lastVerification.status}${lastVerification.failureSummary ? `: ${lastVerification.failureSummary.slice(0, 400)}` : ""}`
      : "NOT_RUN"
    const completed = completedCalls.length > 0
      ? completedCalls.map((call) => call.name).join(", ")
      : "none"
    const files = uniquePaths.length > 0 ? uniquePaths.join(", ") : "none"
    const present = uniquePresent.length > 0 ? uniquePresent.join(", ") : "none"
    const leftover = remaining.length > 0
      ? remaining.join(", ")
      : requested.length === 0
        ? "finish the original implementation and run verification"
        : "none"
    return [
      "Continuing from a turn-budget checkpoint.",
      `The original task is unchanged: ${session.input.task.instruction.slice(0, 500)}`,
      `Completed tools: ${completed}.`,
      `Files written this run: ${files}.`,
      `Already-correct files (no write): ${present}.`,
      `Remaining requested files: ${leftover}.`,
      `Last verification: ${verification}.`,
      ...(session.outcomes?.length ? [formatOutcomeReport(session.outcomes).replace(/\n/g, " ")] : []),
      "Do not repeat completed writes or directory listings already done. Finish remaining work only.",
    ].join(" ")
  }

  async #persistTurnLimitCheckpoint(): Promise<void> {
    const session = this.#requiredSession()
    if (!this.#checkpointCoordinator) return
    const observations = session.observations.slice(-8)
    const toolCalls = session.toolCalls.slice(-16)
    const completedPaths = [...new Set(
      session.evidenceCollector.getEvidence().mutationOutcomes
        .filter((mutation) => mutation.status === "APPLIED" && mutation.path.trim().length > 0)
        .map((mutation) => mutation.path),
    )].slice(-16)
    const alreadyPresentPaths = [...new Set(
      session.evidenceCollector.getEvidence().mutationOutcomes
        .filter((mutation) => mutation.status === "ALREADY_SATISFIED" && mutation.path.trim().length > 0)
        .map((mutation) => mutation.path),
    )].slice(-16)
    const lastVerification = session.evidenceCollector.getEvidence().verificationOutcomes.at(-1)
    const explorationSignatures = [...(session.observedLookups?.keys() ?? [])].slice(-32)
    const touchedFilePaths = [...completedPaths, ...alreadyPresentPaths].map((path) => (
      isAbsolute(path) ? path : join(session.input.workspaceRoot, path)
    ))
    try {
      await this.#checkpointCoordinator.checkpoint({
        runId: session.input.task.id,
        reason: "PAUSED",
        phase: "PLANNING",
        turnId: session.turns,
        evidenceVersion: session.turns + 1,
        runtimeState: {
          status: "FAILED",
          pauseReason: "MAX_TURNS_EXCEEDED",
          activeTask: {
            id: session.input.task.id,
            mode: session.input.task.mode,
            instruction: session.input.task.instruction,
          },
          workingContext: {
            observations,
            toolCalls,
            completedPaths,
            alreadyPresentPaths,
            ...(explorationSignatures.length > 0 ? { explorationSignatures } : {}),
            ...(lastVerification
              ? {
                  lastVerification: {
                    status: lastVerification.status,
                    ...(lastVerification.failureSummary ? { failureSummary: lastVerification.failureSummary.slice(0, 500) } : {}),
                  },
                }
              : {}),
          },
        },
        touchedFilePaths,
      })
    } catch {
      // Continuation still works in-process without durability.
    }
  }

  async #handleCall(call: ToolCall | unknown): Promise<boolean> {
    const session = this.#requiredSession()
    let prepared: PreparedToolCall
    try {
      prepared = this.#registry.prepare(call)
    } catch (error) {
      const category = error instanceof ToolRegistryError ? error.code : "INVALID_ARGUMENTS"
      const message = error instanceof Error ? error.message : "Tool call could not be validated"
      const candidate = call && typeof call === "object" && !Array.isArray(call) ? call as Record<string, unknown> : {}
      const callId = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : `malformed-call-${session.toolCalls.length + 1}`
      const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name : "unknown"
      const contract = this.#applyContractFault(name, message, category, argumentPath(candidate.arguments))
      this.#emit("tool.rejected", { callId, name, category: contract.category ?? category })
      const observation = createToolObservation({ toolName: name, callId, error: { category: contract.category ?? category, message: contract.message }, maxContentBytes: this.#observationMaxBytes })
      session.observations.push(observation)
      session.toolCalls.push({ id: callId, name, outcome: "REJECTED", truncated: observation.truncated })
      session.evidenceCollector.recordToolAction({
        id: callId,
        toolName: name,
        outcome: "REJECTED",
        error: contract.message,
      })
      if (contract.stop) return this.#stopRepeatedContract(contract.message)
      if (await this.#observeProgress({ name, arguments: (candidate.arguments ?? {}) as Readonly<Record<string, unknown>> }, observation)) return true
      const { evalResult: rejEval, directive: rejDirective } = await this.#runEval("TOOL_FAILURE")
      if (this.#adaptiveInterventions && rejDirective.decision !== "CONTINUE") {
        const handled = await this.#dispatchDirective(rejEval, rejDirective, "TOOL_FAILURE")
        if (handled) return true
      }
      return false
    }
    const signature = `${prepared.name}\0${stableValue(prepared.arguments)}`
    const effectiveAction = prepared.effectiveAction ?? prepared.definition.action
    const blockedReason = effectiveAction === "run_known_test" ? session.environmentBlocked?.get(String((prepared.arguments as { action?: unknown }).action ?? "")) : undefined
    if (blockedReason) {
      // Asking again would only cost another approval: the workspace cannot run it in this task.
      this.#addErrorObservation(prepared, "ENVIRONMENT_SETUP_REQUIRED", `This verification cannot run in this workspace yet. ${blockedReason} It will not run again in this task. Continue with the requested change and report verification as blocked.`, "DENIED")
      return false
    }
    if (effectiveAction === "run_known_test" && this.#verificationWaitingOnEdit(session)) {
      const last = session.evidenceCollector.getEvidence().verificationOutcomes.at(-1)
      const diagnosisObservation = session.observations.toReversed().find((item) => item.toolName === "run_verification" && item.content.includes("### Diagnosis"))
      const diagnosis = diagnosisObservation ? `\n${diagnosisObservation.content.slice(diagnosisObservation.content.indexOf("### Diagnosis"), diagnosisObservation.content.indexOf("### Diagnosis") + 1_600)}` : ""
      const detail = diagnosis || (last?.failureSummary ? `\n${last.failureSummary}` : "")
      const unchanged = unchangedFailures(session.observations)
      this.#addErrorObservation(
        prepared,
        "VERIFICATION_FAILED",
        unchanged.length > 0
          ? `These tests failed before and after your edits, so more edits will not clear them (they predate this task or come from the environment): ${unchanged.slice(0, 5).join("; ")}. Do not keep re-running or trying to fix them. Continue with the remaining requested work and list them as failing in your final answer.`
          : `The last test run already failed. Change the code before running the tests again.${detail}`,
        "DENIED",
      )
      return false
    }
    if ((prepared.name === "rename_symbol" || prepared.name === "find_symbol") && await this.#answerCompletedRename(prepared)) return false
    // A repeated lookup is answered from the earlier result, not run again (read_file is re-read and compared below).
    const previousLookup = prepared.name !== "read_file" ? session.observedLookups?.get(signature) : undefined
    if (previousLookup && REPLAYABLE_LOOKUPS.has(prepared.name)) {
      await this.#replayLookup(prepared, previousLookup, undefined)
      return false
    }
    const appliedMutations = session.evidenceCollector.getEvidence().mutationOutcomes
    const noAppliedYet = !appliedMutations.some((mutation) => mutation.status === "APPLIED" || mutation.status === "ALREADY_SATISFIED")
    if (session.taskProfile.requiresCodeChange && noAppliedYet && EXPLORATION_TOOLS.has(prepared.name) && session.turns >= MAX_EXPLORATION_TURNS_WITHOUT_EDIT) {
      this.#addErrorObservation(prepared, "DIRECTORY_BUDGET", "Exploration is done. Call create_file or apply_patch for the requested change. Do not search or list directories.", "DENIED")
      return false
    }
    if (session.taskProfile.requiresCodeChange && noAppliedYet && READ_TOOLS.has(prepared.name) && session.turns >= MAX_READ_TURNS_WITHOUT_EDIT) {
      this.#addErrorObservation(prepared, "DIRECTORY_BUDGET", "Enough of the repository has been read. Call create_file or apply_patch now.", "DENIED")
      return false
    }
    if (prepared.name === "list_directory" && session.taskProfile.requiresCodeChange) {
      const listings = session.toolCalls.filter((item) => item.name === "list_directory" && item.outcome === "COMPLETED" && item.alreadyObserved !== true).length
      if (listings >= MAX_EDIT_TASK_DIRECTORY_LISTINGS) {
        this.#addErrorObservation(prepared, "DIRECTORY_BUDGET", "You already listed directories. Read a specific file, search_text once, or apply the requested edit with create_file or apply_patch. Do not list another directory.", "DENIED")
        return false
      }
    }
    if (prepared.name === "create_file") {
      const createdPath = String((prepared.arguments as { path?: unknown }).path ?? "")
      const createdContent = String((prepared.arguments as { content?: unknown }).content ?? "")
      const implementation = session.taskProfile.explicitFilePaths.filter((path) => !isTestArtifactPath(path))
      const importProblems = await relativeImportProblems(session.input.workspaceRoot, createdPath, createdContent)
      if (importProblems.length > 0) {
        this.#addErrorObservation(prepared, "INVALID_ARGUMENTS", describeImportProblems(importProblems, createdPath, implementation), "DENIED")
        return false
      }
    }
    const permission = this.#permission(effectiveAction)
    if (permission === "DENY") {
      try {
        prepared.notifyDenied?.("Permission policy denied this tool request", {
          workspaceRoot: session.input.workspaceRoot,
          taskId: session.input.task.id,
          callId: prepared.id,
          origin: "agent",
        })
      } catch {
        // Safe observer notification
      }
      this.#emit("permission.denied", { callId: prepared.id, name: prepared.name, action: effectiveAction })
      this.#addErrorObservation(prepared, "PERMISSION_DENIED", "Permission policy denied this tool request", "DENIED")
      session.evidenceCollector.recordSecuritySignal({
        id: prepared.id,
        action: effectiveAction,
        reason: "Permission policy denied this tool request",
        denied: true,
      })
      session.evidenceCollector.recordToolAction({
        id: prepared.id,
        toolName: prepared.name,
        outcome: "DENIED",
        error: "Permission policy denied this tool request",
      })
      if (await this.#observeProgress(prepared, session.observations.at(-1)!)) return true
      const { evalResult: secEval, directive: secDirective } = await this.#runEval("TOOL_FAILURE")
      if (this.#adaptiveInterventions && secDirective.decision !== "CONTINUE") {
        const handled = await this.#dispatchDirective(secEval, secDirective, "TOOL_FAILURE")
        if (handled) return true
      }
      return false
    }
    if (permission === "CONFIRM") {
      let reviewable: import("../tools/registry.ts").ReviewableExecution | undefined
      if (prepared.definition.action === "write_file" || prepared.definition.action === "delete_file") {
        if (forbidsAllEdits(session.input.task.instruction)) {
          const message = "The request said not to edit files."
          this.#addErrorObservation(prepared, "PERMISSION_DENIED", message, "DENIED")
          return false
        }
        const target = String((prepared.arguments as { path?: unknown; targetFile?: unknown }).path
          ?? (prepared.arguments as { targetFile?: unknown }).targetFile
          ?? "")
        const denied = excludedEditPaths(session.input.task.instruction)
          .find((named) => target && pathsReferToSameFile(target, named))
        if (denied) {
          const message = `The request said not to edit ${denied}.`
          this.#addErrorObservation(prepared, "PERMISSION_DENIED", message, "DENIED")
          return false
        }
        // Verification uses the project's existing scripts; package.json does not get new scripts to make it run.
        const added = basename(target) === "package.json" && !mentionsPackageManifest(session.input.task.instruction)
          ? await addedScriptNames(session.input.workspaceRoot, target, prepared.arguments as Record<string, unknown>)
          : []
        if (added.length > 0) {
          const message = `The request does not ask to change package.json scripts. Do not add ${added.map((name) => `"${name}"`).join(", ")} to make verification run: verification uses the project's existing scripts (a missing "test" script falls back to "test:unit"). If verification cannot run, report it as blocked. Nothing was changed.`
          this.#addErrorObservation(prepared, "PERMISSION_DENIED", message, "DENIED")
          return false
        }
      }
      if (prepared.prepareForReview) {
        try {
          reviewable = await prepared.prepareForReview({
            workspaceRoot: session.input.workspaceRoot,
            signal: session.input.signal ?? new AbortController().signal,
            taskId: session.input.task.id,
            callId: prepared.id,
            origin: "agent",
          })
          const isVerification = prepared.definition.action === "run_known_test"
          this.#emit(isVerification ? "verification.prepared" : "mutation.prepared", {
            callId: prepared.id,
            name: prepared.name,
            mutationId: reviewable.id,
            ...(isVerification ? { executionId: reviewable.id } : {}),
            path: (prepared.arguments as any).path || (prepared.arguments as any).targetFile || (prepared.arguments as any).file,
          })
          if (reviewable.reviewPayload.truncated === true) {
            throw new Error("Diff is truncated and cannot be reviewed safely")
          }
          const groupPaths = groupedFilePaths(reviewable.reviewPayload)
          if (groupPaths) {
            // A language-service edit group: the same exclusions apply to every file it touches.
            const excluded = excludedEditPaths(session.input.task.instruction)
              .find((named) => groupPaths.some((path) => pathsReferToSameFile(path, named)))
            if (excluded) {
              const message = `The request said not to edit ${excluded}, and this change would edit it. Nothing was changed.`
              this.#addErrorObservation(prepared, "PERMISSION_DENIED", message, "DENIED")
              return false
            }
          }
          // Any single-file write (apply_patch, or create_file over an existing file, which becomes a patch).
          if (!groupPaths && prepared.definition.action === "write_file" && this.#registry.listDefinitions().some((definition) => definition.name === "rename_symbol")) {
            const payload = reviewable.reviewPayload as { path?: unknown; beforeContent?: unknown; proposedContent?: unknown }
            const renamed = handRenamedBinding(String(payload.beforeContent ?? ""), String(payload.proposedContent ?? ""), session.input.task.instruction)
            if (renamed) {
              // Nothing is written: renaming one side by hand breaks every other file that uses the name.
              const path = String(payload.path ?? "")
              const message = `RENAME_BY_PATCH: this patch renames ${renamed.from} to ${renamed.to} in ${path} only, which would break every other file that uses ${renamed.from}. Nothing was changed. Call rename_symbol with path ${path}, symbol ${renamed.from}, newName ${renamed.to}: it renames the definition, imports, re-exports and call sites in all files in one reviewed change. Then use apply_patch for any other part of the request.`
              this.#addErrorObservation(prepared, "INVALID_PATCH", message, "FAILED")
              this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
              session.evidenceCollector.recordToolAction({ id: prepared.id, toolName: prepared.name, outcome: "FAILED", error: message })
              return false
            }
          }
          const proposedPath = String(reviewable.reviewPayload.path ?? (prepared.arguments as { path?: unknown }).path ?? "")
          const proposedContent = typeof reviewable.reviewPayload.proposedContent === "string" ? reviewable.reviewPayload.proposedContent : ""
          if (!groupPaths && proposedPath && proposedContent && prepared.definition.action === "write_file") {
            const implementation = [
              ...session.taskProfile.explicitFilePaths.filter((path) => !isTestArtifactPath(path)),
              ...session.evidenceLedger.filesRead.filter((path) => !isTestArtifactPath(path)),
            ]
            const before = await readFile(isAbsolute(proposedPath) ? proposedPath : join(session.input.workspaceRoot, proposedPath), "utf8").catch(() => "")
            const existing = new Set(proposedContentProblems(proposedPath, before).map((problem) => problem.replace(/^line \d+: /, "")))
            const codeProblems = proposedContentProblems(proposedPath, proposedContent).filter((problem) => !existing.has(problem.replace(/^line \d+: /, "")))
            if (codeProblems.length > 0) {
              const message = `INVALID_CODE: this edit would leave ${proposedPath} invalid (${codeProblems.join("; ")}). Nothing was changed. Read the current file and send a patch that applies cleanly without repeating declarations that already exist.`
              this.#addErrorObservation(prepared, "INVALID_PATCH", message, "FAILED")
              this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
              return false
            }
            if (exportedTypeShapeChanged(proposedPath, before, proposedContent)) (session.typeShapePaths ??= new Set()).add(proposedPath)
            const dangling = await danglingReferences(session.input.workspaceRoot, proposedPath, before, proposedContent).catch(() => [])
            const firstTime = dangling.filter((ref) => !(session.danglingWarned ??= new Set()).has(`${proposedPath}|${ref.value}`))
            if (firstTime.length > 0) {
              for (const ref of firstTime) session.danglingWarned!.add(`${proposedPath}|${ref.value}`)
              const message = `DANGLING_REFERENCE: ${proposedPath} refers to ${firstTime.map((ref) => `${ref.key} "${ref.value}"`).join(", ")}, but no JSON file in the workspace defines an id "${firstTime[0]!.value}" (ids that exist: ${firstTime[0]!.known.join(", ") || "none"}). Nothing was changed. Define it where the other ids are defined, or refer to one that exists; if it is defined outside the repository, send the same edit again.`
              this.#addErrorObservation(prepared, "INVALID_PATCH", message, "FAILED")
              this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
              return false
            }
            const missingReads = unresolvedTestReads(session.input.workspaceRoot, proposedPath, proposedContent)
            if (missingReads.length > 0) {
              const message = `INVALID_TEST: this test reads a file that is not in the workspace (${missingReads.join("; ")}). Nothing was changed. Use a path that exists from this test file (join(__dirname, …) or a relative readFileSync).`
              this.#addErrorObservation(prepared, "INVALID_PATCH", message, "FAILED")
              this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
              return false
            }
            const emptyTest = testExercisesNoProjectCode(proposedPath, proposedContent)
            if (emptyTest) {
              const message = `INVALID_TEST: ${emptyTest}. Nothing was changed. Import the module under test (for example the file you implemented) and assert on what it returns or does.`
              this.#addErrorObservation(prepared, "INVALID_PATCH", message, "FAILED")
              this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
              return false
            }
            const importProblems = await relativeImportProblems(session.input.workspaceRoot, proposedPath, proposedContent)
            if (importProblems.length > 0) {
              const message = describeImportProblems(importProblems, proposedPath, implementation)
              this.#addErrorObservation(prepared, "INVALID_ARGUMENTS", message, "FAILED")
              this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
              return false
            }
          }
          const redirected = groupPaths ? undefined : await this.#misplacedMutationOwner(prepared, reviewable.reviewPayload)
          if (redirected) {
            const message = `WRONG_FILE: this change belongs in ${redirected.owner}, not ${redirected.target}. Call apply_patch on ${redirected.owner} only. Do not add that code to ${redirected.target}.`
            this.#addErrorObservation(prepared, "INVALID_PATCH", message, "FAILED")
            this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
            session.evidenceCollector.recordToolAction({
              id: prepared.id,
              toolName: prepared.name,
              outcome: "FAILED",
              error: message,
            })
            return false
          }
          session.pending = { prepared, signature, reviewable }
          this.#emit(isVerification ? "verification.confirmation_requested" : "mutation.confirmation_requested", {
            callId: prepared.id,
            name: prepared.name,
            mutationId: reviewable.id,
            ...(isVerification ? { executionId: reviewable.id } : {}),
          })
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool preparation failed"
          if (prepared.definition.action === "run_known_test" && message.startsWith("ENVIRONMENT_SETUP_REQUIRED:")) {
            // Found before running: the workspace is not set up. Not a code defect; nothing to approve or revise.
            const blocked = session.environmentBlocked ?? (session.environmentBlocked = new Map())
            blocked.set(String((prepared.arguments as { action?: unknown }).action ?? ""), message)
            this.#addErrorObservation(prepared, "ENVIRONMENT_SETUP_REQUIRED", `${message} Do not change code or project files to work around it. Continue with the requested change and report verification as blocked.`, "FAILED")
            return false
          }
          const contract = this.#applyContractFault(prepared.name, message, errorCode(error), argumentPath(prepared.arguments))
          this.#addErrorObservation(prepared, contract.category ?? "TOOL_PREPARATION_ERROR", contract.message, "FAILED")
          this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message: contract.message })
          session.evidenceCollector.recordToolAction({
            id: prepared.id,
            toolName: prepared.name,
            outcome: "FAILED",
            error: contract.message,
          })
          if (contract.stop) return this.#stopRepeatedContract(contract.message)
          const { evalResult: prepEval, directive: prepDirective } = await this.#runEval("TOOL_FAILURE")
          if (this.#adaptiveInterventions && prepDirective.decision !== "CONTINUE") {
            const handled = await this.#dispatchDirective(prepEval, prepDirective, "TOOL_FAILURE")
            if (handled) return true
          }
          return false
        }
      }
      session.pending = { prepared, signature }
      this.#emit("permission.requested", { callId: prepared.id, name: prepared.name, action: effectiveAction })
      return true
    }
    return this.#execute(prepared, signature)
  }

  async #execute(prepared: PreparedToolCall, signature: string): Promise<boolean> {
    const session = this.#requiredSession()
    this.#emit("tool.requested", { callId: prepared.id, name: prepared.name })
    let observation: ToolObservation
    /** Tool output before any ALREADY_OBSERVED annotation; the repeat guard compares this. */
    let rawContent: string | undefined
    let opId: string | undefined
    let targetFilePath = ""
    if (this.#checkpointCoordinator) {
      if (prepared.definition.action === "write_file" || prepared.definition.action === "delete_file") {
        targetFilePath = (prepared.arguments as any)?.targetFile ?? (prepared.arguments as any)?.path ?? ""
        if (!targetFilePath.startsWith("/") && session.input.workspaceRoot) {
          targetFilePath = join(session.input.workspaceRoot, targetFilePath)
        }
        try {
          const op = await this.#checkpointCoordinator.prepareOperation({
            runId: session.input.task.id,
            evidenceVersion: session.turns + 1,
            kind: "MUTATION",
            authorityId: "mutation-engine",
            preconditions: [],
            expectedPostconditions: targetFilePath ? [{ path: targetFilePath, expectedHash: "", exists: prepared.definition.action !== "delete_file" }] : [],
            payload: { toolId: prepared.id },
          })
          opId = op.operationId
          await this.#checkpointCoordinator.operationJournal.recordStarted(opId, session.input.task.id)
          await this.#checkpointCoordinator.checkpoint({
            runId: session.input.task.id,
            reason: "BEFORE_MUTATION",
            phase: "MUTATION",
            turnId: session.turns,
            evidenceVersion: session.turns + 1,
            runtimeState: { status: "WAITING_FOR_TOOL" },
            touchedFilePaths: targetFilePath ? [targetFilePath] : [],
          })
        } catch (err) {
          const message = `DURABILITY_UNAVAILABLE: Failed pre-mutation durability: ${err instanceof Error ? err.message : String(err)}`
          session.failureReason = "INTERNAL_ERROR"
          this.#addErrorObservation(prepared, "MUTATION_ERROR", message, "FAILED")
          this.#emit("mutation.failed", { callId: prepared.id, name: prepared.name, mutationId: prepared.id, error: new Error(message) })
          this.#emit("task.failed", { message })
          return true
        }
      } else if (prepared.definition.action === "run_known_test") {
        try {
          const op = await this.#checkpointCoordinator.prepareOperation({
            runId: session.input.task.id,
            evidenceVersion: session.turns + 1,
            kind: "VERIFICATION",
            authorityId: "verification-engine",
            preconditions: [],
            expectedPostconditions: [],
            payload: { toolId: prepared.id },
          })
          opId = op.operationId
          await this.#checkpointCoordinator.operationJournal.recordStarted(opId, session.input.task.id)
          await this.#checkpointCoordinator.checkpoint({
            runId: session.input.task.id,
            reason: "BEFORE_VERIFICATION",
            phase: "VERIFYING",
            turnId: session.turns,
            evidenceVersion: session.turns + 1,
            runtimeState: { status: "VERIFYING" },
          })
        } catch (err) {
          const message = `DURABILITY_UNAVAILABLE: Failed pre-verification durability: ${err instanceof Error ? err.message : String(err)}`
          session.failureReason = "INTERNAL_ERROR"
          this.#addErrorObservation(prepared, "VERIFICATION_ERROR", message, "FAILED")
          this.#emit("verification.failed", { callId: prepared.id, name: prepared.name, mutationId: prepared.id, executionId: prepared.id, message })
          this.#emit("task.failed", { message })
          return true
        }
      }
    }

    try {
      const output = await prepared.invoke({
        workspaceRoot: session.input.workspaceRoot,
        signal: session.input.signal ?? new AbortController().signal,
        taskId: session.input.task.id,
        callId: prepared.id,
        origin: "agent",
      })
      let postDurabilityError: Error | undefined
      if (this.#checkpointCoordinator && opId) {
        try {
          if (prepared.definition.action === "run_known_test") {
            const pass = (output as any)?.status === "PASS"
            if (pass) {
              await this.#checkpointCoordinator.operationJournal.recordCompleted(opId, session.input.task.id, prepared.id)
            } else {
              await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, (output as any)?.stderr ?? "Verification non-zero exit")
            }
            await this.#checkpointCoordinator.checkpoint({
              runId: session.input.task.id,
              reason: "AFTER_VERIFICATION",
              phase: "VERIFYING",
              turnId: session.turns,
              evidenceVersion: session.turns + 1,
              runtimeState: { status: "OBSERVING" },
            })
          } else if (prepared.definition.action === "write_file" || prepared.definition.action === "delete_file") {
            await this.#checkpointCoordinator.operationJournal.recordCompleted(opId, session.input.task.id, prepared.id)
            await this.#checkpointCoordinator.checkpoint({
              runId: session.input.task.id,
              reason: "AFTER_MUTATION",
              phase: "MUTATION",
              turnId: session.turns,
              evidenceVersion: session.turns + 1,
              runtimeState: { status: "OBSERVING" },
              touchedFilePaths: targetFilePath ? [targetFilePath] : [],
            })
          }
        } catch (err) {
          postDurabilityError = err instanceof Error ? err : new Error(String(err))
        }
      }
      observation = createToolObservation({
        toolName: prepared.name,
        callId: prepared.id,
        output,
        maxContentBytes: this.#observationMaxBytes,
        ...(toolArguments(prepared.arguments) ? { arguments: toolArguments(prepared.arguments) } : {}),
      })
      if (session.taskProfile.requiresCodeChange && observation.ok) {
        if (prepared.name === "search_text" && observation.content.startsWith("No matching text found")) {
          observation = { ...observation, content: `${observation.content}\n${MISSING_SEARCH_HINT}` }
        } else if (prepared.name === "find_files" && observation.content.startsWith("No matching files found.")) {
          observation = { ...observation, content: `${observation.content}\n${MISSING_FILES_HINT}` }
        }
      }
      let rereadUnchanged = false
      rawContent = observation.content
      if (REPLAYABLE_LOOKUPS.has(prepared.name)) {
        const previous = session.observedLookups?.get(signature)
        if (previous && previous.content === observation.content && !session.progressGuard) {
          // The same file, unchanged since the last read: no new information. (When the direct progress
          // guard is on, it owns repeated reads and their bounded recovery.)
          observation = await this.#replayLookup(prepared, previous, observation)
          rereadUnchanged = true
        } else if (!previous || previous.content !== observation.content) {
          const lookups = session.observedLookups ?? (session.observedLookups = new Map())
          lookups.set(signature, { callId: prepared.id, content: observation.content, truncated: observation.truncated, replays: 0 })
        }
      }
      session.observations.push(observation)
      session.toolCalls.push({ ...recordCall(prepared, "COMPLETED", observation.truncated), ...(rereadUnchanged ? { alreadyObserved: true } : {}) })
      session.evidenceLedger.recordObservation(
        prepared.name,
        prepared.id,
        prepared.arguments as Record<string, unknown>,
        true,
        output,
      )
      session.evidenceCollector.recordToolAction({
        id: prepared.id,
        toolName: prepared.name,
        outcome: "COMPLETED",
        args: prepared.arguments as Record<string, unknown>,
        output,
      })
      this.#emit("tool.completed", { callId: prepared.id, name: prepared.name, truncated: observation.truncated })

      if (postDurabilityError) {
        session.failureReason = "INTERNAL_ERROR"
        const message = `RECOVERY_PERSISTENCE_FAILED: Tool ${prepared.name} succeeded on disk but post-execution persistence failed: ${postDurabilityError.message}`
        this.#emit("task.failed", { message })
        return true
      }

      if (prepared.definition.action === "write_file" || prepared.definition.action === "delete_file") {
        session.observedLookups?.clear()
        session.evidenceCollector.recordMutationOutcome({
          mutationId: prepared.id,
          path: (prepared.arguments as any)?.targetFile || (prepared.arguments as any)?.path || "",
          status: "APPLIED",
          operation: mutationOperation(prepared.name),
        })
        session.evidenceCollector.resolveRecoveredToolContractFailures()
        await this.#refreshRequirementGaps()
        const { evalResult: mutEval, directive: mutDirective } = await this.#runEval("MUTATION_RESULT")
        if (this.#adaptiveInterventions && mutDirective.decision !== "CONTINUE") {
          const handled = await this.#dispatchDirective(mutEval, mutDirective, "MUTATION_RESULT")
          if (handled) return true
        }
      } else if (prepared.definition.action === "run_known_test") {
        const res = output as any
        const status = recordedVerificationStatus(res?.status)
        session.evidenceCollector.recordVerificationOutcome({
          executionId: prepared.id,
          action: (prepared.arguments as any)?.action || "TEST",
          status,
          failedTestCount: typeof res?.failedTests === "number" ? res.failedTests : status === "PASS" ? 0 : 1,
          totalTestCount: res?.totalTests,
          stdout: res?.stdout,
          stderr: res?.stderr,
          diagnosis: res?.diagnosis,
        })
        const { evalResult: verifEval, directive: verifDirective } = await this.#runEval("VERIFICATION_RESULT")
        if (this.#adaptiveInterventions && verifDirective.decision !== "CONTINUE") {
          const handled = await this.#dispatchDirective(verifEval, verifDirective, "VERIFICATION_RESULT")
          if (handled) return true
        }
      }
    } catch (error) {
      if (isAbortError(error, session.input.signal)) {
        this.#cancel()
        return true
      }
      const message = error instanceof Error ? error.message : "Tool execution failed"
      const contract = this.#applyContractFault(prepared.name, message, errorCode(error), argumentPath(prepared.arguments))
      if (this.#checkpointCoordinator && opId) {
        try {
          await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, message)
        } catch (failDurabilityErr) {
          session.failureReason = "INTERNAL_ERROR"
          const failDurabilityMsg = `RECOVERY_PERSISTENCE_FAILED: Tool execution failed and recordFailed persistence failed: ${failDurabilityErr instanceof Error ? failDurabilityErr.message : String(failDurabilityErr)}`
          this.#emit("task.failed", { message: failDurabilityMsg })
          return true
        }
      }
      observation = createToolObservation({
        toolName: prepared.name,
        callId: prepared.id,
        error: { category: contract.category ?? "TOOL_RUNTIME_ERROR", message: contract.message },
        maxContentBytes: this.#observationMaxBytes,
      })
      session.observations.push(observation)
      session.toolCalls.push({ id: prepared.id, name: prepared.name, outcome: "FAILED", truncated: observation.truncated })
      session.evidenceCollector.recordToolAction({
        id: prepared.id,
        toolName: prepared.name,
        outcome: "FAILED",
        args: prepared.arguments as Record<string, unknown>,
        error: contract.message,
      })
      this.#emit("tool.failed", { callId: prepared.id, name: prepared.name, message: contract.message })
      if (contract.stop) return this.#stopRepeatedContract(contract.message)

      const { evalResult: failEval, directive: failDirective } = await this.#runEval("TOOL_FAILURE")
      if (this.#adaptiveInterventions && failDirective.decision !== "CONTINUE") {
        const handled = await this.#dispatchDirective(failEval, failDirective, "TOOL_FAILURE")
        if (handled) return true
      }
    }
    if (await this.#observeProgress(prepared, observation)) return true
    const progressKey = `${signature}\0${observation.ok}\0${rawContent ?? observation.content}`
    session.repeatedProgress = session.lastProgressKey === progressKey ? session.repeatedProgress + 1 : 1
    session.lastProgressKey = progressKey
    const codingProgress = this.#codingGoalVerdict()
    const waitingOnVerification = codingProgress?.editsSatisfied === true && codingProgress.verificationSatisfied === false
    const waitingOnRequestedEdit = codingProgress !== undefined && !codingProgress.editsSatisfied
    if (session.repeatedProgress >= this.#nonProgressThreshold && !waitingOnVerification && !waitingOnRequestedEdit) {
      if (session.taskProfile.directReply) {
        if (!session.conversationAnswerNudged) {
          session.conversationAnswerNudged = true
          session.repeatedProgress = 0
          session.observations.push(createToolObservation({
            toolName: "conversation_gate",
            callId: "conversation-answer",
            error: {
              category: "ANSWER_REQUIRED",
              message: "[ANSWER REQUIRED]\nThis request does not require a source edit. Stop calling tools and answer the user.",
            },
            maxContentBytes: this.#observationMaxBytes,
          }))
          return false
        }
        const text = session.lastAssistantText?.trim()
        if (text) {
          await this.#completeTask(text)
          return true
        }
        session.failureReason = "INCOMPLETE"
        session.finalAnswer = "No code change was required, and no answer was produced."
        this.#emit("task.failed", { message: session.finalAnswer })
        return true
      }
      session.failureReason = "NON_PROGRESS"
      session.terminationSource = "NON_PROGRESS_GUARD"
      this.#emit("task.non_progress", { message: `Repeated ${prepared.name} call made no progress`, threshold: this.#nonProgressThreshold, terminationSource: "NON_PROGRESS_GUARD" })
      return true
    }
    return false
  }

  // ---- Sprint 5C: direct-path non-progress guard (ADR-031) ---------------------------------------

  /** Feeds one tool result to the guard. Returns true when the run must stop (BLOCKED_NON_PROGRESS). */
  async #observeProgress(prepared: Pick<PreparedToolCall, "name" | "arguments">, observation: ToolObservation, mutation?: { readonly path: string; readonly beforeHash?: string; readonly afterHash?: string }): Promise<boolean> {
    const guard = this.#session?.progressGuard
    if (!guard) return false
    const signals = guard.observeTool({
      name: prepared.name,
      args: prepared.arguments,
      ok: observation.ok,
      content: observation.content,
      ...(observation.errorCategory ? { errorCategory: observation.errorCategory } : {}),
      ...(mutation ? { mutation } : {}),
    })
    if (signals.length === 0) return false
    return this.#handleDirectStall(signals, { name: prepared.name, observation })
  }

  /**
   * STALL → capture → classify → one discriminating check → one bounded recovery turn (compacted
   * context + a recovery directive), or stop with a structured BLOCKED_NON_PROGRESS report.
   * The check is deterministic and read-only; the runner never invents a tool call for the model.
   */
  async #handleDirectStall(signals: readonly ProgressSignal[], last: { readonly name: string; readonly observation?: ToolObservation }): Promise<boolean> {
    const session = this.#requiredSession()
    const guard = session.progressGuard!
    if (session.input.signal?.aborted) {
      this.#cancel()
      return true
    }
    const category = last.observation?.errorCategory
    const lastDiagnostic = session.diagnostics.at(-1)
    const capture: FailureCapture = {
      stage: "DIRECT",
      signals,
      ...(last.observation ? { failureText: boundRecoveryText(last.observation.content, 1_200) } : {}),
      ...(category ? { toolErrorCategories: [category] } : {}),
      ...(category === "PERMISSION_DENIED" ? { permissionOutcome: "DENIED" as const } : category === "PERMISSION_REJECTED" ? { permissionOutcome: "REJECTED" as const } : {}),
      ...(lastDiagnostic && lastDiagnostic.totalEstimatedTokens >= session.input.contextBudget.availableContext * 0.9 ? { contextPressure: true } : {}),
    }
    const preliminary = classifyStall(capture)
    const budgetAvailable = guard.recoveryCount < MAX_NON_PROGRESS_RECOVERIES
    const definition = this.#registry.listDefinitions().find((item) => item.name === last.name)
    const result = guard.recoveryCount === 0
      ? await runDiagnosticCheck(preliminary.check, {
          capture,
          tools: {
            available: this.#registry.listDefinitions().filter((item) => this.#permission(item.action) !== "DENY").map((item) => item.name),
            failing: last.name,
            ...(Array.isArray(definition?.inputSchema.required) ? { required: (definition!.inputSchema.required as unknown[]).map(String) } : {}),
          },
          expectedHashes: guard.workspaceHashes,
          currentHash: async (path) => {
            try {
              return sha256(await readFile(await resolveRepositoryPath(session.input.workspaceRoot, path, "file"), "utf8"))
            } catch {
              return undefined
            }
          },
        })
      : { observed: `the same stall persisted after the bounded recovery attempt (${session.nonProgress?.recoveryPlan?.observedResult ?? "no earlier check"})` }
    const plan = buildRecoveryPlan({ capture, preliminary, result, budgetAvailable })
    const previous = session.nonProgress

    if (plan.retryAllowed) {
      guard.recoveryCount += 1
      // Fresh, compact context: each distinct observation once, then one bounded recovery directive.
      const { kept, dropped } = dedupeObservations(session.observations)
      session.observations = kept
      session.observations.push(createToolObservation({
        toolName: "progress_recovery",
        callId: `progress-recovery-${guard.recoveryCount}`,
        error: {
          category: "NON_PROGRESS_RECOVERY",
          message: [
            `No progress: ${describeSignals(signals)}.`,
            `Failure class: ${plan.failureClass}. Hypothesis: ${plan.hypothesis}.`,
            `Diagnostic (${plan.checkDescription}): ${plan.observedResult ?? "not run"}.`,
            `Next: ${plan.correctiveAction}. Do not repeat the previous call; take one different action or answer from the evidence above.`,
          ].join("\n"),
        },
        maxContentBytes: this.#observationMaxBytes,
      }))
      session.nonProgress = {
        signals: [...(previous?.signals ?? []), ...signals].slice(-12),
        recoveryAttempted: true,
        recoveryCount: guard.recoveryCount,
        recoveryPlan: plan,
        recoveryOutcome: "PENDING",
        observationsDropped: (previous?.observationsDropped ?? 0) + dropped,
      }
      this.#emit("recovery.non_progress", { message: stallNotice(signals), failureClass: plan.failureClass })
      return false
    }

    const report = buildNonProgressReport(plan, last.observation?.content ?? "", plan.observedResult ?? result.observed)
    session.nonProgress = {
      signals: [...(previous?.signals ?? []), ...signals].slice(-12),
      recoveryAttempted: guard.recoveryCount > 0,
      recoveryCount: guard.recoveryCount,
      recoveryPlan: plan,
      recoveryOutcome: guard.recoveryCount > 0 ? "NOT_RECOVERED" : "ESCALATED",
      finalBlocker: report,
      observationsDropped: previous?.observationsDropped ?? 0,
    }
    session.failureReason = "NON_PROGRESS"
    session.terminationSource = "NON_PROGRESS_GUARD"
    this.#emit("task.non_progress", { message: formatNonProgressReport(report), terminationSource: "NON_PROGRESS_GUARD", failureClass: report.failureClass })
    return true
  }

  /** Resolves a pending recovery at a terminal state; "RECOVERED" needs new evidence after the recovery. */
  #settleDirectRecovery(): void {
    const session = this.#session
    const evidence = session?.nonProgress
    if (!session || !evidence || evidence.recoveryOutcome !== "PENDING") return
    const status = session.state.status
    if (status !== "COMPLETED" && status !== "FAILED" && status !== "CANCELLED") return
    const recoveryOutcome = status === "CANCELLED" ? "CANCELLED" : status === "COMPLETED" && (session.progressGuard?.evidenceSinceRecovery ?? 0) > 0 ? "RECOVERED" : "NOT_RECOVERED"
    session.nonProgress = { ...evidence, recoveryOutcome }
  }

  /**
   * Answers a repeated read-only lookup with its earlier result (ALREADY_OBSERVED). This is not a refusal or
   * a failure: the first repeat returns the full result. Further repeats with no workspace change get a short
   * answer and count toward the repeated-refusal bound, so a lookup loop still ends.
   */
  async #replayLookup(prepared: PreparedToolCall, previous: ObservedLookup, fresh: ToolObservation | undefined): Promise<ToolObservation> {
    const session = this.#requiredSession()
    previous.replays += 1
    await this.#refreshRequirementGaps()
    const gaps = session.requirementGaps?.length ? ` Still missing from the request: ${session.requirementGaps.join(" ")}` : ""
    const done = session.evidenceCollector.getEvidence().mutationOutcomes.filter((mutation) => mutation.status === "APPLIED" || mutation.status === "ALREADY_SATISFIED").map((mutation) => mutation.path)
    const pending = requiredEditPaths(session.input.task.instruction, session.taskProfile.explicitFilePaths).filter((path) => !done.some((path2) => pathsReferToSameFile(path2, path)))
    const target = pending.length > 0 ? ` The request names ${pending.join(", ")} as a file to create or update; it is not done yet.` : ""
    const what = prepared.name === "read_file" ? "This file is unchanged since you last read it" : "This lookup already ran with the same arguments and nothing in the workspace has changed since, so it was not run again"
    const next = "Repeating it gives no new information. Next, read a file that result names and you have not read, search for something you have not searched, or make the requested change."
    // A result the context budget has since dropped is not "above": the model must be given it again, and that is
    // not a repeat. shortcut: covers both the token budget and the recent-observation window.
    const evicted = session.shownItemIds !== undefined && !session.shownItemIds.has(`observation:${previous.callId}`)
    const full = previous.replays <= FULL_REPLAYS || evicted
    const content = full
      ? `ALREADY_OBSERVED: ${what}. ${next}${target}${gaps}\n\nEarlier result:\n${previous.content}`
      : `ALREADY_OBSERVED: ${what}; its result is already above. ${next}${target}${gaps}`
    const observation: ToolObservation = {
      ...(fresh ?? createToolObservation({ toolName: prepared.name, callId: prepared.id, output: "", maxContentBytes: this.#observationMaxBytes, ...(toolArguments(prepared.arguments) ? { arguments: toolArguments(prepared.arguments) } : {}) })),
      content,
      truncated: full && previous.truncated,
      alreadyObserved: true,
    }
    if (!full) this.#recordRefusal(prepared.name, "ALREADY_OBSERVED", `${prepared.name} ${JSON.stringify(toolArguments(prepared.arguments) ?? {})} repeated without new information`)
    if (fresh) return observation // a re-read: the caller records it on the normal completion path
    session.observations.push(observation)
    session.toolCalls.push({ ...recordCall(prepared, "COMPLETED", observation.truncated), alreadyObserved: true })
    return observation
  }

  /**
   * A rename_symbol/find_symbol on a name this task already renamed: when the file still shows the rename (the
   * old identifier gone, the new one present), answer ALREADY_SATISFIED with no new mutation or approval.
   * Otherwise (the workspace changed, or a different symbol) the call runs normally.
   */
  async #answerCompletedRename(prepared: PreparedToolCall): Promise<boolean> {
    const session = this.#requiredSession()
    const args = prepared.arguments as { path?: unknown; symbol?: unknown; newName?: unknown }
    const symbol = String(args.symbol ?? "")
    const path = String(args.path ?? "")
    const rename = session.completedRenames?.findLast((item) => item.symbol === symbol
      && item.files.some((file) => pathsReferToSameFile(file, path))
      && (prepared.name === "find_symbol" || args.newName === undefined || args.newName === item.newName))
    if (!rename) return false
    let text: string
    try {
      text = await readFile(isAbsolute(path) ? path : join(session.input.workspaceRoot, path), "utf8")
    } catch {
      return false
    }
    if (identifierPattern(symbol).test(text) || !identifierPattern(rename.newName).test(text)) return false
    rename.repeats += 1
    const verification = session.evidenceCollector.getEvidence().verificationOutcomes.at(-1)
    const next = verification ? `The last test run ${verification.status === "PASS" ? "passed" : "did not pass"} after it.` : "Run the tests to verify it."
    const content = `ALREADY_SATISFIED: ${symbol} was already renamed to ${rename.newName} in this task (${rename.files.join(", ")}). ${path} no longer contains ${symbol} and does contain ${rename.newName}. Nothing was changed and no approval is needed. ${next}`
    const observation: ToolObservation = {
      ...createToolObservation({ toolName: prepared.name, callId: prepared.id, output: content, maxContentBytes: this.#observationMaxBytes, ...(toolArguments(prepared.arguments) ? { arguments: toolArguments(prepared.arguments) } : {}) }),
      alreadyObserved: true,
    }
    session.observations.push(observation)
    session.toolCalls.push({ ...recordCall(prepared, "COMPLETED", false), alreadyObserved: true })
    if (rename.repeats > 1) this.#recordRefusal(prepared.name, "ALREADY_SATISFIED", `${symbol} already renamed to ${rename.newName}`)
    return true
  }

  #addErrorObservation(prepared: PreparedToolCall, category: string, message: string, outcome: AgentToolCallRecord["outcome"]): void {
    const session = this.#requiredSession()
    const observation = createToolObservation({
      toolName: prepared.name,
      callId: prepared.id,
      error: { category, message },
      maxContentBytes: this.#observationMaxBytes,
      ...(toolArguments(prepared.arguments) ? { arguments: toolArguments(prepared.arguments) } : {}),
    })
    session.observations.push(observation)
    session.toolCalls.push(recordCall(prepared, outcome, observation.truncated))
    // Runtime-initiated verification (auto-verify-*) is not a model choice and does not count toward the bound.
    if ((outcome === "DENIED" || outcome === "FAILED") && !prepared.id.startsWith("auto-verify-")) this.#recordRefusal(prepared.name, category, message)
  }

  /**
   * Bounded repair: the same refusal repeated without any change to the workspace state (no applied
   * mutation, no new verification run) is non-progress. Reads in between do not reset it. The run stops
   * truthfully instead of looping until the user intervenes (the daily-driver turn budget is unlimited).
   */
  #recordRefusal(toolName: string, category: string, message: string): void {
    const session = this.#requiredSession()
    if (session.refusalStop) return
    const evidence = session.evidenceCollector.getEvidence()
    const state = `${evidence.mutationOutcomes.filter((mutation) => mutation.status === "APPLIED").length}:${evidence.verificationOutcomes.length}`
    const key = `${state}\0${toolName}\0${category}\0${message.slice(0, 400)}`
    const refusals = session.refusals ?? (session.refusals = new Map())
    const count = (refusals.get(key) ?? 0) + 1
    refusals.set(key, count)
    // Listing budget denials are not a stuck refusal: the next useful action is an edit, not a stop.
    if (category === "DIRECTORY_BUDGET") return
    if (count < REPEATED_REFUSAL_LIMIT) return
    session.refusalStop = true
    session.failureReason = "NON_PROGRESS"
    session.terminationSource = "NON_PROGRESS_GUARD"
    const verdict = this.#assessCoding("NOT_RUN")
    session.finalAnswer = (category === "ALREADY_OBSERVED"
      ? `Stopped: ${toolName} was repeated ${count + FULL_REPLAYS + 1} times with the same arguments and returned no new information, and nothing in the workspace changed in between. ${verdict.summary}`
      : `Stopped: ${toolName} was refused ${count} times with the same reason and nothing in the workspace changed in between. Last reason: ${message.split("\n")[0]!.slice(0, 300)} ${verdict.summary}`).trim()
    // The terminal event is emitted by #finishRefusalStop once the current tool call has finished its own
    // events (a refused patch still emits tool.rejected after this point).
  }

  /** Emits the NON_PROGRESS terminal event for a refusal stop exactly once, after the tool call returns. */
  #finishRefusalStop(): void {
    const session = this.#requiredSession()
    if (!session.refusalStop || ["COMPLETED", "FAILED", "CANCELLED"].includes(session.state.status)) return
    this.#emit("task.non_progress", { message: session.finalAnswer ?? "Repeated refusal without progress.", threshold: REPEATED_REFUSAL_LIMIT, terminationSource: "NON_PROGRESS_GUARD" })
  }

  /**
   * Whether applied mutations must be verified inside this session before it may complete. A
   * structured engineering workflow (ADR-030) sets `verificationOwner: "workflow"` on its IMPLEMENT
   * session: its mandatory TEST and VERIFY stages own verification, so the session need not run it.
   */
  #verificationRequired(): boolean {
    const session = this.#requiredSession()
    if (session.input.task.metadata?.verificationOwner === "workflow") return false
    return Boolean(
      session.input.task.metadata?.requireVerification === true ||
      session.input.task.mode === "DEBUG" ||
      session.taskProfile.category === "TEST_DIAGNOSIS" ||
      /\b(?:test|tests|verify|verification|assert|diagnose)\b/i.test(session.input.task.instruction)
    )
  }

  #permission(action: Parameters<typeof classifyPermission>[0]["action"]): ToolPermission {
    const session = this.#requiredSession()
    return this.#permissionEvaluator({ action, mode: session.input.task.mode })
  }

  #cancel(): void {
    const session = this.#requiredSession()
    session.failureReason = "CANCELLED"
    this.#emit("task.cancelled", { message: "Task cancelled" })
  }

  #emit(type: AgentEventType, payload: unknown): void {
    const session = this.#requiredSession()
    const event = createAgentEvent(type, session.input.task.id, payload, this.#factory)
    session.state = applyAgentEvent(session.state, event)
    this.#eventSink?.(event)
  }

  async #runEval(checkpoint: RuntimeEvalCheckpoint): Promise<{ evalResult: RuntimeEvalResult; directive: AdaptiveDirective }> {
    const session = this.#requiredSession()
    if (!this.#runtimeEvals) {
      const evalResult: RuntimeEvalResult = {
        evalId: `eval-disabled-${session.turns}`,
        runId: session.input.task.id,
        turnId: session.turns,
        checkpoint,
        evidenceVersion: 0,
        decision: "CONTINUE",
        scores: {
          progress: 1.0,
          completionConfidence: 1.0,
          verificationCoverage: 1.0,
          planAdherence: 1.0,
          executionEfficiency: 1.0,
          logicalConsistency: 1.0,
          safetyAuthority: 1.0,
        },
        signals: [],
        evaluatorLevel: "L0",
        confidence: 1.0,
      }
      return {
        evalResult,
        directive: { action: "CONTINUE", decision: "CONTINUE", shouldFinalize: false },
      }
    }

    session.evidenceCollector.updateTurn(session.turns)
    const turnId = session.turns
    const runId = session.input.task.id
    const evidenceVersion = session.evidenceCollector.evidenceVersion

    this.#emit("runtime_eval.started", {
      runId,
      turnId,
      checkpoint,
      evidenceVersion,
    })

    const evalResult = await session.evalEngine.evaluate(
      session.evidenceCollector,
      checkpoint,
      turnId,
      session.input.signal,
    )

    session.evalResults.push(evalResult)

    this.#emit("runtime_eval.completed", {
      evalId: evalResult.evalId,
      decision: evalResult.decision,
      scores: evalResult.scores,
      signals: evalResult.signals,
      evaluatorLevel: evalResult.evaluatorLevel,
      confidence: evalResult.confidence,
    })

    if (evalResult.stale) {
      const directive: AdaptiveDirective = { action: "CONTINUE", decision: "CONTINUE", shouldFinalize: false }
      session.evalLedger.recordEval(evalResult, undefined, { staleDropped: true, applied: false })
      return { evalResult, directive }
    }

    const directive = session.evalPolicy.determineDirective(evalResult, session.evidenceCollector.getEvidence())

    if (this.#adaptiveInterventions && directive.decision !== "CONTINUE") {
      this.#emit("runtime_eval.intervention", {
        evalId: evalResult.evalId,
        decision: directive.decision,
        action: directive.action,
        reason: evalResult.signals.map((s) => s.code).join(", "),
      })
      session.evalLedger.recordEval(evalResult, directive.action, { applied: true, staleDropped: false })
    } else {
      session.evalLedger.recordEval(evalResult, undefined, { applied: false, staleDropped: false })
    }

    return { evalResult, directive }
  }

  async #dispatchDirective(
    evalResult: RuntimeEvalResult,
    directive: AdaptiveDirective,
    _checkpoint: RuntimeEvalCheckpoint,
  ): Promise<boolean> {
    const session = this.#requiredSession()
    if (!this.#adaptiveInterventions) return false

    if (session.input.signal?.aborted) {
      this.#cancel()
      return true
    }

    switch (directive.action) {
      case "SCHEDULE_VERIFICATION": {
        if (session.input.signal?.aborted) {
          this.#cancel()
          return true
        }
        const { outcome: verifOutcome, evalResult: postEval, directive: postDirective } = await this.#executeScheduledVerification(evalResult.evalId)
        if (verifOutcome === "WAITING_CONFIRMATION" || session.state.status === "WAITING_FOR_CONFIRMATION" || ["FAILED", "CANCELLED"].includes(session.state.status)) {
          return true
        }
        const hasMutations = session.evidenceCollector.getEvidence().mutationOutcomes.some((m) => m.status === "APPLIED")
        const isVerificationRequired = this.#verificationRequired()
        if (verifOutcome === "UNAVAILABLE" && hasMutations && isVerificationRequired) {
          session.failureReason = "VERIFICATION_UNAVAILABLE"
          session.finalAnswer ??= this.#assessCoding("UNAVAILABLE").summary
          this.#emit("task.failed", { message: "VERIFICATION_UNAVAILABLE: Verification was required following code mutation but verification capability is unavailable" })
          return true
        }
        if (postDirective && postDirective.decision !== "CONTINUE" && postDirective.action !== "NO_OP") {
          return this.#dispatchDirective(postEval!, postDirective, "VERIFICATION_RESULT")
        }
        return false
      }

      case "INJECT_REVISION": {
        session.observations.push(
          createToolObservation({
            toolName: "runtime_eval_revision",
            callId: evalResult.evalId,
            error: { category: "REVISION_REQUIRED", message: directive.promptContext ?? "Revise defect" },
            maxContentBytes: this.#observationMaxBytes,
          }),
        )
        return false
      }

      case "TRIGGER_REPLAN": {
        session.observations.push(
          createToolObservation({
            toolName: "runtime_eval_replan",
            callId: evalResult.evalId,
            error: { category: "REPLAN_REQUIRED", message: directive.promptContext ?? "Replan approach" },
            maxContentBytes: this.#observationMaxBytes,
          }),
        )
        return false
      }

      case "TERMINATE_RUN": {
        session.failureReason = "NON_PROGRESS"
        session.terminationSource = "RUNTIME_EVAL"
        this.#emit("task.non_progress", {
          message: directive.stopReason ?? "Run terminated by runtime evaluation",
          terminationSource: "RUNTIME_EVAL",
        })
        return true
      }

      case "PAUSE_HUMAN": {
        session.pending = {
          prepared: {
            id: evalResult.evalId,
            name: "human_authorization",
            arguments: {},
            definition: {
              name: "human_authorization",
              description: directive.stopReason ?? "Human authorization required",
              action: "terminal_command",
              inputSchema: {},
            },
            effectiveAction: "terminal_command",
            invoke: async () => "APPROVED",
          },
          signature: "human_authorization",
        }
        this.#emit("permission.requested", {
          callId: evalResult.evalId,
          name: "human_authorization",
          action: "ask_human",
        })
        return true
      }

      case "REQUEST_CONTEXT": {
        if (session.input.signal?.aborted) {
          this.#cancel()
          return true
        }

        session.consecutiveContextRequests = (session.consecutiveContextRequests ?? 0) + 1
        if (session.consecutiveContextRequests > MAX_CONSECUTIVE_CONTEXT_REQUESTS) {
          session.evalLedger.recordInterventionOutcome(evalResult.evalId, "DEGRADED", "Maximum consecutive context requests exceeded")
          this.#emit("runtime_eval.outcome", {
            evalId: evalResult.evalId,
            outcome: "DEGRADED",
            details: "Maximum consecutive context requests exceeded",
          })
          session.observations.push(
            createToolObservation({
              toolName: "runtime_eval_replan",
              callId: evalResult.evalId,
              error: {
                category: "CONTEXT_LOOP_EXCEEDED",
                message: "Maximum consecutive context requests exceeded. Please formulate a new plan.",
              },
              maxContentBytes: this.#observationMaxBytes,
            }),
          )
          return false
        }

        const target = directive.contextRequest?.target?.trim()
        let resolved = false
        if (target) {
          try {
            const fileData = await readRepositoryFile(session.input.workspaceRoot, target, { maxBytes: 4096 })
            session.observations.push(
              createToolObservation({
                toolName: "runtime_eval_context",
                callId: evalResult.evalId,
                output: fileData.content.slice(0, 4000),
                maxContentBytes: this.#observationMaxBytes,
              }),
            )
            session.evidenceCollector.recordToolAction({
              id: evalResult.evalId,
              toolName: "runtime_eval_context",
              outcome: "COMPLETED",
              args: { target },
              output: fileData.content.slice(0, 4000),
            })
            resolved = true
          } catch {
            try {
              const searchRes = await searchText(session.input.workspaceRoot, target, { maxResults: 5, maxOutputBytes: 4096 })
              if (searchRes.results.length > 0) {
                const formatted = searchRes.results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n")
                session.observations.push(
                  createToolObservation({
                    toolName: "runtime_eval_context",
                    callId: evalResult.evalId,
                    output: formatted.slice(0, 4000),
                    maxContentBytes: this.#observationMaxBytes,
                  }),
                )
                session.evidenceCollector.recordToolAction({
                  id: evalResult.evalId,
                  toolName: "runtime_eval_context",
                  outcome: "COMPLETED",
                  args: { target },
                  output: formatted.slice(0, 4000),
                })
                resolved = true
              }
            } catch {
              resolved = false
            }
          }
        }
        if (resolved) {
          session.evalLedger.recordInterventionOutcome(evalResult.evalId, "RESOLVED", `Resolved context for ${target}`)
          this.#emit("runtime_eval.outcome", {
            evalId: evalResult.evalId,
            outcome: "RESOLVED",
            details: `Resolved context for ${target}`,
          })
        } else {
          session.evidenceCollector.recordToolAction({
            id: evalResult.evalId,
            toolName: "runtime_eval_context",
            outcome: "FAILED",
            args: { target },
            error: { message: `Context target not found: ${target || "unknown"}` },
          })
          session.evalLedger.recordInterventionOutcome(evalResult.evalId, "DEGRADED", `Context target could not be resolved: ${target || "unknown"}`)
          this.#emit("runtime_eval.outcome", {
            evalId: evalResult.evalId,
            outcome: "DEGRADED",
            details: `Context target could not be resolved: ${target || "unknown"}`,
          })
          session.observations.push(
            createToolObservation({
              toolName: "runtime_eval_replan",
              callId: evalResult.evalId,
              error: {
                category: "CONTEXT_UNAVAILABLE",
                message: `Requested context '${target || "unknown"}' could not be resolved. Please formulate a new plan.`,
              },
              maxContentBytes: this.#observationMaxBytes,
            }),
          )
        }

        if (session.input.signal?.aborted) {
          this.#cancel()
          return true
        }

        const { evalResult: secondEval, directive: secondDirective } = await this.#runEval("PERIODIC")
        if (secondDirective && secondDirective.decision !== "CONTINUE" && secondDirective.action !== "NO_OP") {
          return this.#dispatchDirective(secondEval, secondDirective, "PERIODIC")
        }
        return false
      }

      case "RECOMMEND_MODEL": {
        if (directive.modelRecommendation) {
          session.pendingModelRecommendation = directive.modelRecommendation
          session.pendingRouteHint = {
            ...(session.lastDeploymentId ? { avoidDeploymentId: session.lastDeploymentId } : {}),
            preferredCapabilities: [directive.modelRecommendation.capability as any],
            reasonCode: directive.modelRecommendation.reason,
          }
          session.pendingModelEvalId = evalResult.evalId
          session.observations.push(
            createToolObservation({
              toolName: "runtime_eval_model_recommendation",
              callId: evalResult.evalId,
              output: `Model capability recommendation: ${directive.modelRecommendation.capability} (${directive.modelRecommendation.reason})`,
              maxContentBytes: this.#observationMaxBytes,
            }),
          )
        }
        return false
      }

      case "CONTINUE":
      case "NO_OP":
      default:
        return false
    }
  }

  async #executeScheduledVerification(evalId: string): Promise<{
    outcome: "PASSED" | "FAILED" | "UNAVAILABLE" | "WAITING_CONFIRMATION"
    evalResult?: RuntimeEvalResult
    directive?: AdaptiveDirective
  }> {
    const session = this.#requiredSession()
    let prepared: PreparedToolCall | undefined

    const hasRunVerification = this.#registry.listDefinitions().some((d) => d.name === "run_verification")
    if (hasRunVerification) {
      try {
        prepared = this.#registry.prepare({
          id: `scheduled-verify-${evalId}`,
          name: "run_verification",
          arguments: { action: "TEST" },
        })
      } catch {
        prepared = undefined
      }
    }

    if (prepared) {
      const permission = this.#permission(prepared.definition.action)
      if (permission === "CONFIRM") {
        if (prepared.prepareForReview) {
          let reviewable
          try {
            reviewable = await prepared.prepareForReview({
              workspaceRoot: session.input.workspaceRoot,
              signal: session.input.signal ?? new AbortController().signal,
            })
          } catch {
            session.evalLedger.recordInterventionOutcome(evalId, "UNCHANGED", "Verification capability unavailable in current environment")
            this.#emit("runtime_eval.outcome", {
              evalId,
              outcome: "UNCHANGED",
              details: "Verification capability unavailable in current environment",
            })
            return { outcome: "UNAVAILABLE" }
          }
          this.#emit("verification.prepared", {
            callId: prepared.id,
            name: prepared.name,
            mutationId: reviewable.id,
            executionId: reviewable.id,
          })
          session.pending = { prepared, signature: "run_verification:TEST", reviewable }
          this.#emit("verification.confirmation_requested", {
            callId: prepared.id,
            name: prepared.name,
            mutationId: reviewable.id,
            executionId: reviewable.id,
          })
          return { outcome: "WAITING_CONFIRMATION" }
        }
      } else if (permission === "ALLOW") {
        if (prepared.prepareForReview) {
          let reviewable
          try {
            reviewable = await prepared.prepareForReview({
              workspaceRoot: session.input.workspaceRoot,
              signal: session.input.signal ?? new AbortController().signal,
            })
          } catch {
            session.evalLedger.recordInterventionOutcome(evalId, "UNCHANGED", "Verification capability unavailable in current environment")
            this.#emit("runtime_eval.outcome", {
              evalId,
              outcome: "UNCHANGED",
              details: "Verification capability unavailable in current environment",
            })
            return { outcome: "UNAVAILABLE" }
          }
          this.#emit("verification.started", {
            callId: prepared.id,
            name: prepared.name,
            mutationId: reviewable.id,
            executionId: reviewable.id,
          })
          const onOutput = (chunk: { stream: "stdout" | "stderr"; chunk: string }) => {
            this.#emit("verification.output", {
              callId: prepared!.id,
              name: prepared!.name,
              mutationId: reviewable.id,
              executionId: reviewable.id,
              stream: chunk.stream,
              chunk: chunk.chunk,
            })
          }
          let opId: string | undefined
          if (this.#checkpointCoordinator) {
            try {
              const op = await this.#checkpointCoordinator.prepareOperation({
                runId: session.input.task.id,
                evidenceVersion: session.turns + 1,
                kind: "VERIFICATION",
                authorityId: "verification-engine",
                preconditions: [],
                expectedPostconditions: [],
                payload: { executionId: reviewable.id },
              })
              opId = op.operationId
              await this.#checkpointCoordinator.operationJournal.recordStarted(opId, session.input.task.id)
              await this.#checkpointCoordinator.checkpoint({
                runId: session.input.task.id,
                reason: "BEFORE_VERIFICATION",
                phase: "VERIFYING",
                turnId: session.turns,
                evidenceVersion: session.turns + 1,
                runtimeState: { status: "VERIFYING" },
              })
            } catch (err) {
              const message = `DURABILITY_UNAVAILABLE: Scheduled verification durability failed before execution: ${err instanceof Error ? err.message : String(err)}`
              session.failureReason = "INTERNAL_ERROR"
              this.#emit("verification.failed", {
                callId: prepared.id,
                name: prepared.name,
                mutationId: reviewable.id,
                executionId: reviewable.id,
                message,
              })
              session.evidenceCollector.recordVerificationOutcome({
                executionId: reviewable.id,
                action: "TEST",
                status: "EXECUTION_ERROR",
                failedTestCount: 1,
                stderr: message,
              })
              this.#emit("task.failed", { message })
              return { outcome: "FAILED" }
            }
          }
          let result: any
          try {
            result = (await reviewable.apply({
              workspaceRoot: session.input.workspaceRoot,
              signal: session.input.signal ?? new AbortController().signal,
              onOutput,
            })) as any
          } catch (execErr: any) {
            if (this.#checkpointCoordinator && opId) {
              try {
                await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, execErr.message)
              } catch (failDurabilityErr) {
                session.failureReason = "INTERNAL_ERROR"
                const failDurabilityMsg = `RECOVERY_PERSISTENCE_FAILED: Scheduled verification threw and recordFailed persistence failed: ${failDurabilityErr instanceof Error ? failDurabilityErr.message : String(failDurabilityErr)}`
                this.#emit("task.failed", { message: failDurabilityMsg })
                return { outcome: "FAILED" }
              }
            }
            throw execErr
          }
          let postDurabilityError: Error | undefined
          if (this.#checkpointCoordinator && opId) {
            try {
              if (result.status === "PASS") {
                await this.#checkpointCoordinator.operationJournal.recordCompleted(opId, session.input.task.id, reviewable.id)
              } else {
                await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, result.stderr ?? "Verification non-zero exit")
              }
              await this.#checkpointCoordinator.checkpoint({
                runId: session.input.task.id,
                reason: "AFTER_VERIFICATION",
                phase: "VERIFYING",
                turnId: session.turns,
                evidenceVersion: session.turns + 1,
                runtimeState: { status: "OBSERVING" },
              })
            } catch (err) {
              postDurabilityError = err instanceof Error ? err : new Error(String(err))
            }
          }
          this.#emit("verification.completed", {
            callId: prepared.id,
            name: prepared.name,
            mutationId: reviewable.id,
            executionId: reviewable.id,
            result,
          })
          const verificationStatus = recordedVerificationStatus(result.status)
          session.evidenceCollector.recordVerificationOutcome({
            executionId: reviewable.id,
            action: "TEST",
            status: verificationStatus,
            failedTestCount: typeof result.failedTests === "number" ? result.failedTests : verificationStatus === "PASS" ? 0 : 1,
            totalTestCount: result.totalTests,
            stdout: result.stdout,
            stderr: result.stderr,
            diagnosis: result.diagnosis,
          })
          const obs = createToolObservation({
            toolName: prepared.name,
            callId: prepared.id,
            output: result,
            maxContentBytes: this.#observationMaxBytes,
          })
          session.observations.push(obs)
          session.toolCalls.push({ id: prepared.id, name: prepared.name, outcome: "COMPLETED", truncated: obs.truncated })

          if (postDurabilityError) {
            session.failureReason = "INTERNAL_ERROR"
            const message = `RECOVERY_PERSISTENCE_FAILED: Scheduled verification completed but post-persistence failed: ${postDurabilityError.message}`
            this.#emit("task.failed", { message })
            return { outcome: "FAILED" }
          }

          const { evalResult: postVerifEval, directive: postVerifDirective } = await this.#runEval("VERIFICATION_RESULT")

          const pass = result.status === "PASS"
          session.evalLedger.recordInterventionOutcome(evalId, pass ? "RESOLVED" : "DEGRADED", `Verification ${result.status}`)
          this.#emit("runtime_eval.outcome", {
            evalId,
            outcome: pass ? "RESOLVED" : "DEGRADED",
            details: `Verification result: ${result.status}`,
          })
          return { outcome: pass ? "PASSED" : "FAILED", evalResult: postVerifEval, directive: postVerifDirective }
        }
      }
    } else if (this.#verificationEngine) {
      const permission = this.#permission("run_known_test")
      if (permission === "ALLOW") {
        let command
        try {
          command = await discoverVerificationCommand(session.input.workspaceRoot, "TEST")
        } catch {
          command = undefined
        }

        if (!command) {
          session.evalLedger.recordInterventionOutcome(evalId, "UNCHANGED", "No test command discovered in workspace")
          this.#emit("runtime_eval.outcome", {
            evalId,
            outcome: "UNCHANGED",
            details: "No test command discovered in workspace",
          })
          return { outcome: "UNAVAILABLE" }
        }

        const verifId = `verification-${Date.now()}`
        this.#emit("verification.started", {
          callId: `call-${verifId}`,
          name: "run_verification",
          mutationId: verifId,
          executionId: verifId,
        })
        const preparedVerif = {
          verificationId: verifId,
          action: "TEST" as const,
          executable: command.executable,
          args: command.args,
          cwd: session.input.workspaceRoot,
          timeoutMs: 60000,
          commandPreview: `${command.executable} ${command.args.join(" ")}`,
          packageJsonPath: command.packageJsonPath,
          packageJsonHash: command.packageJsonHash,
          scriptName: command.scriptName,
          scriptBody: command.scriptBody,
        }
        let opId: string | undefined
        if (this.#checkpointCoordinator) {
          try {
            const op = await this.#checkpointCoordinator.prepareOperation({
              runId: session.input.task.id,
              evidenceVersion: session.turns + 1,
              kind: "VERIFICATION",
              authorityId: "verification-engine",
              preconditions: [],
              expectedPostconditions: [],
              payload: { executionId: verifId },
            })
            opId = op.operationId
            await this.#checkpointCoordinator.operationJournal.recordStarted(opId, session.input.task.id)
            await this.#checkpointCoordinator.checkpoint({
              runId: session.input.task.id,
              reason: "BEFORE_VERIFICATION",
              phase: "VERIFYING",
              turnId: session.turns,
              evidenceVersion: session.turns + 1,
              runtimeState: { status: "VERIFYING" },
            })
          } catch (err) {
            const message = `DURABILITY_UNAVAILABLE: Auto test verification durability failed before execution: ${err instanceof Error ? err.message : String(err)}`
            session.failureReason = "INTERNAL_ERROR"
            this.#emit("verification.failed", {
              callId: `call-${verifId}`,
              name: "run_verification",
              mutationId: verifId,
              executionId: verifId,
              message,
            })
            session.evidenceCollector.recordVerificationOutcome({
              executionId: verifId,
              action: "TEST",
              status: "EXECUTION_ERROR",
              failedTestCount: 1,
              stderr: message,
            })
            this.#emit("task.failed", { message })
            return { outcome: "FAILED" }
          }
        }
        let result: any
        try {
          result = await this.#verificationEngine.execute(preparedVerif, session.input.signal)
        } catch (execErr: any) {
          if (this.#checkpointCoordinator && opId) {
            try {
              await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, execErr.message)
            } catch (failDurabilityErr) {
              session.failureReason = "INTERNAL_ERROR"
              const failDurabilityMsg = `RECOVERY_PERSISTENCE_FAILED: Auto test verification threw and recordFailed persistence failed: ${failDurabilityErr instanceof Error ? failDurabilityErr.message : String(failDurabilityErr)}`
              this.#emit("task.failed", { message: failDurabilityMsg })
              return { outcome: "FAILED" }
            }
          }
          throw execErr
        }
        let postDurabilityError: Error | undefined
        if (this.#checkpointCoordinator && opId) {
          try {
            if (result.status === "PASS") {
              await this.#checkpointCoordinator.operationJournal.recordCompleted(opId, session.input.task.id, verifId)
            } else {
              await this.#checkpointCoordinator.operationJournal.recordFailed(opId, session.input.task.id, result.stderr ?? "Verification non-zero exit")
            }
            await this.#checkpointCoordinator.checkpoint({
              runId: session.input.task.id,
              reason: "AFTER_VERIFICATION",
              phase: "VERIFYING",
              turnId: session.turns,
              evidenceVersion: session.turns + 1,
              runtimeState: { status: "OBSERVING" },
            })
          } catch (err) {
            postDurabilityError = err instanceof Error ? err : new Error(String(err))
          }
        }
        this.#emit("verification.completed", {
          callId: `call-${verifId}`,
          name: "run_verification",
          mutationId: verifId,
          executionId: verifId,
          result,
        })
        const verificationStatus = recordedVerificationStatus(result.status)
        const failedCount = typeof (result as any).failedTests === "number" ? (result as any).failedTests : verificationStatus === "PASS" ? 0 : 1
        session.evidenceCollector.recordVerificationOutcome({
          executionId: verifId,
          action: "TEST",
          status: verificationStatus,
          failedTestCount: failedCount,
          totalTestCount: (result as any).totalTests,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(typeof result.diagnosis === "string" ? { diagnosis: result.diagnosis } : {}),
        })
        const obs = createToolObservation({
          toolName: "run_verification",
          callId: `call-${verifId}`,
          output: result,
          maxContentBytes: this.#observationMaxBytes,
        })
        session.observations.push(obs)

        if (postDurabilityError) {
          session.failureReason = "INTERNAL_ERROR"
          const message = `RECOVERY_PERSISTENCE_FAILED: Auto test verification completed but post-persistence failed: ${postDurabilityError.message}`
          this.#emit("task.failed", { message })
          return { outcome: "FAILED" }
        }

        const { evalResult: postVerifEval, directive: postVerifDirective } = await this.#runEval("VERIFICATION_RESULT")

        const pass = result.status === "PASS"
        session.evalLedger.recordInterventionOutcome(evalId, pass ? "RESOLVED" : "DEGRADED", `Verification ${result.status}`)
        this.#emit("runtime_eval.outcome", {
          evalId,
          outcome: pass ? "RESOLVED" : "DEGRADED",
          details: `Verification result: ${result.status}`,
        })
        return { outcome: pass ? "PASSED" : "FAILED", evalResult: postVerifEval, directive: postVerifDirective }
      }
    }

    session.evalLedger.recordInterventionOutcome(evalId, "UNCHANGED", "Verification capability unavailable in current environment")
    this.#emit("runtime_eval.outcome", {
      evalId,
      outcome: "UNCHANGED",
      details: "Verification capability unavailable in current environment",
    })
    return { outcome: "UNAVAILABLE" }
  }

  async #misplacedMutationOwner(
    prepared: PreparedToolCall,
    reviewPayload: { readonly path?: unknown; readonly beforeContent?: unknown; readonly proposedContent?: unknown },
  ): Promise<{ target: string; owner: string } | undefined> {
    if (prepared.definition.action !== "write_file") return undefined
    const session = this.#requiredSession()
    const target = String(reviewPayload.path ?? (prepared.arguments as { path?: unknown }).path ?? "").replaceAll("\\", "/")
    const before = typeof reviewPayload.beforeContent === "string" ? reviewPayload.beforeContent : ""
    const proposed = typeof reviewPayload.proposedContent === "string" ? reviewPayload.proposedContent : ""
    if (!target || !proposed) return undefined
    const known = [
      ...session.evidenceLedger.filesRead,
      ...session.evidenceCollector.getEvidence().mutationOutcomes.map((mutation) => mutation.path),
      ...requiredEditPaths(session.input.task.instruction, session.taskProfile.explicitFilePaths),
    ]
    for (const sibling of candidateOwnerPaths(target, before, proposed)) {
      const inspected = await inspectMutationTarget(session.input.workspaceRoot, sibling)
      if (inspected.kind === "existing") known.push(inspected.path)
    }
    const owner = misplacedExportPath(target, before, proposed, known)
    if (!owner) return undefined
    return { target, owner }
  }

  #stopRepeatedContract(message: string): boolean {
    const session = this.#requiredSession()
    session.failureReason = "INCOMPLETE"
    session.finalAnswer = `Stopped after a repeated tool-contract error. ${message}`
    this.#emit("task.failed", { message: session.finalAnswer })
    return true
  }

  #applyContractFault(toolName: string, message: string, code: string | undefined, path: string | undefined): { message: string; category?: string; stop: boolean } {
    const fault = describeToolContractFault({ toolName, message, code, path, workspaceRoot: this.#requiredSession().input.workspaceRoot })
    if (!fault) return { message, stop: false }
    const session = this.#requiredSession()
    const seen = session.contractFaults ?? (session.contractFaults = new Map())
    const first = seen.get(fault.signature)
    // The same fault twice in one turn is one mistake: the model has not yet seen the correction. Stop only when
    // it repeats the fault in a later turn, after the message reached it.
    if (first !== undefined && session.turns > first) return { message: fault.message, category: fault.category, stop: true }
    if (first === undefined) seen.set(fault.signature, session.turns)
    return { message: fault.message, category: fault.category, stop: false }
  }

  #verificationWaitingOnEdit(session: Session): boolean {
    const evidence = session.evidenceCollector.getEvidence()
    const last = evidence.verificationOutcomes.at(-1)
    if (!last || last.status !== "FAIL") return false
    // Ordered by the collector's sequence: millisecond timestamps cannot order an edit and a run that tie.
    return !evidence.mutationOutcomes.some((mutation) => mutation.status === "APPLIED" && (
      mutation.sequence !== undefined && last.sequence !== undefined ? mutation.sequence > last.sequence : mutation.timestamp > last.timestamp
    ))
  }

  #codingGoalVerdict(): CodingCompletion | undefined {
    const session = this.#requiredSession()
    if (!session.taskProfile.requiresCodeChange) return undefined
    if (session.input.task.metadata?.verificationOwner === "workflow") return undefined
    return this.#assessCoding("NOT_RUN")
  }

  #assessCoding(scheduledVerification: "PASSED" | "UNAVAILABLE" | "NOT_RUN"): CodingCompletion {
    const session = this.#requiredSession()
    const evidence = session.evidenceCollector.getEvidence()
    // A multi-part brief's outcomes (the ledger) decide what is required; files it mentions are context, and any
    // applied source edit counts. Targeted requests keep the named-file rules.
    const editPaths = isSubstantial(deriveOutcomes(session.input.task.instruction))
      ? []
      : requiredEditPaths(session.input.task.instruction, session.taskProfile.explicitFilePaths)
    return assessCodingCompletion({
      requiresCodeChange: session.taskProfile.requiresCodeChange,
      explicitPaths: editPaths,
      requireImplementationChange: implementationChangeRequired(session.input.task.instruction, editPaths),
      requireExistingFileEdit: requestsExistingFileEdit(session.input.task.instruction),
      requireTestEdit: requestsNewTest(session.input.task.instruction),
      mutations: evidence.mutationOutcomes.map((mutation) => ({
        path: mutation.path,
        status: mutation.status,
        at: mutation.timestamp,
        ...(mutation.operation ? { operation: mutation.operation } : {}),
      })),
      verifications: evidence.verificationOutcomes.map((verification) => ({ status: verification.status, at: verification.timestamp, action: verification.action })),
      verificationRequired: this.#verificationRequired(),
      userRejectedMutation: session.mutationRejectedByUser === true,
      scheduledVerification,
      additionalVerification: this.#additionalVerification(),
      ...(session.requirementGaps && session.requirementGaps.length > 0 ? { requirementGaps: session.requirementGaps } : {}),
    })
  }

  /** Recomputes explicit-request gaps after the workspace changed (async file reads; the verdict stays sync). */
  async #refreshRequirementGaps(): Promise<void> {
    const session = this.#requiredSession()
    if (!session.taskProfile.requiresCodeChange) return
    const appliedPaths = session.evidenceCollector.getEvidence().mutationOutcomes
      .filter((mutation) => mutation.status === "APPLIED" || mutation.status === "ALREADY_SATISFIED")
      .map((mutation) => mutation.path)
      .filter((path) => path.trim().length > 0)
    const gaps: string[] = await requirementGaps({
      workspaceRoot: session.input.workspaceRoot,
      instruction: session.input.task.instruction,
      appliedPaths,
      isTestPath: isTestArtifactPath,
    }).catch(() => [])
    const derived = deriveOutcomes(session.input.task.instruction)
    if (isSubstantial(derived)) {
      const evidence = session.evidenceCollector.getEvidence()
      const files = await Promise.all([...new Set(appliedPaths)].slice(-12).map(async (path) => ({
        path,
        content: (await readFile(isAbsolute(path) ? path : join(session.input.workspaceRoot, path), "utf8").catch(() => "")).slice(0, 40_000),
      })))
      const lastEdit = evidence.mutationOutcomes.filter((m) => m.status === "APPLIED").map((m) => m.timestamp).toSorted().at(-1) ?? ""
      const lastVerification = evidence.verificationOutcomes.at(-1)
      const unchangedFailure = lastVerification?.status === "FAIL" && unchangedFailures(session.observations).length > 0
      session.outcomes = evaluateOutcomes(derived, files, lastVerification ? { status: unchangedFailure ? "UNCHANGED_FAILURE" : lastVerification.status, afterLastEdit: lastVerification.timestamp >= lastEdit } : undefined)
      gaps.push(...outcomeGaps(session.outcomes))
    }
    session.requirementGaps = gaps
  }

  /**
   * Checks the project itself defines, required after edits they cover: a `typecheck` script after
   * TypeScript edits. Unit tests alone miss importers of a renamed or removed export.
   */
  #additionalVerification(): string[] {
    const session = this.#requiredSession()
    if (session.typecheckScript === undefined) {
      try {
        const pkg = JSON.parse(readFileSync(join(session.input.workspaceRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }
        session.typecheckScript = typeof pkg.scripts?.typecheck === "string" && pkg.scripts.typecheck.trim().length > 0
      } catch {
        session.typecheckScript = false
      }
    }
    if (!session.typecheckScript) return []
    const touchedTypeScript = session.evidenceCollector.getEvidence().mutationOutcomes
      .some((mutation) => mutation.status === "APPLIED" && /\.(?:ts|tsx|mts|cts)$/.test(mutation.path))
    return touchedTypeScript ? ["TYPECHECK"] : []
  }

  /** The next runtime-owned verification: tests first, then any additional check still missing after the last edit. */
  #nextVerificationAction(): string {
    const session = this.#requiredSession()
    const evidence = session.evidenceCollector.getEvidence()
    const mutations = evidence.mutationOutcomes.map((mutation) => ({ path: mutation.path, status: mutation.status, at: mutation.timestamp }))
    const verifications = evidence.verificationOutcomes.map((verification) => ({ status: verification.status, at: verification.timestamp, action: verification.action }))
    const paths = requiredEditPaths(session.input.task.instruction, session.taskProfile.explicitFilePaths)
    if (actionAfterMutation(mutations, verifications, paths, "TEST") !== "PASS") return "TEST"
    return this.#additionalVerification().find((action) => actionAfterMutation(mutations, verifications, paths, action) !== "PASS") ?? "TEST"
  }

  async #acceptCompletion(content: string, scheduledVerification: "PASSED" | "UNAVAILABLE" | "NOT_RUN", note?: string): Promise<void> {
    const session = this.#requiredSession()
    const verdict = this.#assessCoding(scheduledVerification)
    if (session.input.task.metadata?.verificationOwner === "workflow") {
      await this.#completeTask(content.trim() ? content : verdict.summary)
      return
    }
    if (!verdict.accept) {
      session.failureReason = verdict.failureReason ?? "INCOMPLETE"
      session.finalAnswer = note ? `${verdict.summary} ${note}` : verdict.summary
      this.#emit("task.failed", { message: session.finalAnswer })
      return
    }
    const lastVerification = session.evidenceCollector.getEvidence().verificationOutcomes.at(-1)
    if (lastVerification && lastVerification.status !== "PASS") {
      session.failureReason = lastVerification.status === "FAIL" ? "VERIFICATION_FAILED" : "INCOMPLETE"
      session.finalAnswer = `${verdict.summary} Verification ended with ${lastVerification.status}.`
      this.#emit("task.failed", { message: session.finalAnswer })
      return
    }
    await this.#completeTask(content.trim() ? content : verdict.summary)
  }

  async #completeTask(responseContent: string): Promise<void> {
    const session = this.#requiredSession()
    session.finalAnswer = responseContent
    if (this.#checkpointCoordinator) {
      try {
        await this.#checkpointCoordinator.checkpoint({
          runId: session.input.task.id,
          reason: "COMPLETED",
          phase: "COMPLETED",
          turnId: session.turns,
          evidenceVersion: session.turns + 1,
          runtimeState: { status: "COMPLETED" },
        })
      } catch (err) {
        session.failureReason = "INTERNAL_ERROR"
        const message = `RECOVERY_PERSISTENCE_FAILED: Failed to record COMPLETED checkpoint: ${err instanceof Error ? err.message : String(err)}`
        this.#emit("task.failed", { message })
        return
      }
    }
    delete session.failureReason
    this.#emit("task.completed", { turns: session.turns })
  }

  #encodingFor(session: Session): ConversationEncoding {
    return resolveConversationEncoding(session.input.conversationEncoding ?? this.#conversationEncoding)
  }

  #result(): AgentResult {
    const session = this.#requiredSession()
    const isTerminal = session.state.status === "COMPLETED" ||
      session.state.status === "FAILED" ||
      session.state.status === "CANCELLED"

    const appliedMutations = session.evidenceCollector.getEvidence().mutationOutcomes
      .filter((mutation) => mutation.status === "APPLIED" && mutation.path.trim().length > 0)
      .map((mutation) => ({ path: mutation.path, status: "APPLIED" as const }))

    if (isTerminal && !session.finalAnswer?.trim()) {
      const verdict = this.#assessCoding("NOT_RUN")
      if (session.state.status === "CANCELLED" || session.failureReason === "CANCELLED") {
        session.finalAnswer = `Task cancelled. ${verdict.summary}`
      } else if (session.failureReason === "MAX_TURNS_EXCEEDED") {
        session.finalAnswer = `${verdict.summary} Stopped because the turn budget was exhausted.`
      } else {
        session.finalAnswer = verdict.summary
      }
    }

    const resolvedDeploymentId = session.lastDeploymentId ?? (this.#provider as any).lastDecision?.deploymentId ?? (this.#provider as any).model

    if (isTerminal && this.#performanceLedger && resolvedDeploymentId && !session.performanceOutcomeRecorded) {
      session.performanceOutcomeRecorded = true
      const isCompleted = session.state.status === "COMPLETED"

      const verificationCalls = session.toolCalls.filter(t => t.name === "run_known_test" || t.name === "run_verification")
      const verificationEvals = session.evalResults.filter(r => r.checkpoint === "VERIFICATION_RESULT")
      let verificationSuccess: boolean
      if (verificationCalls.length > 0) {
        verificationSuccess = verificationCalls.every(t => t.outcome === "COMPLETED") &&
          (!verificationEvals.length || verificationEvals.every(e => e.scores.verificationCoverage > 0.5))
      } else if (verificationEvals.length > 0) {
        verificationSuccess = verificationEvals.every(e => e.scores.verificationCoverage > 0.5)
      } else {
        // Read-only or tasks where verification was not applicable
        verificationSuccess = isCompleted
      }

      const toolCallSuccess = session.toolCalls.length === 0 ||
        session.toolCalls.every(t => t.outcome === "COMPLETED")

      const verificationFailures = session.toolCalls.filter(t =>
        (t.name === "run_known_test" || t.name === "run_verification") && t.outcome !== "COMPLETED"
      ).length
      const repairCycles = Math.max(session.continuationAttempts, verificationFailures) + (session.input.repairCycles ?? 0)

      const runtimeCompleted = isCompleted
      const qualitySuccess = runtimeCompleted && verificationSuccess && toolCallSuccess

      this.#performanceLedger.recordAgentOutcome({
        deploymentId: resolvedDeploymentId,
        taskClass: deriveTaskClass(session.input.task.mode),
        success: qualitySuccess,
        runtimeCompleted,
        qualitySuccess,
        verificationSuccess,
        toolCallSuccess,
        repairCycles,
        timeoutOccurred: Boolean(session.timeoutOccurred),
        cancellationOccurred: session.state.status === "CANCELLED" || session.failureReason === "CANCELLED",
        latencyMs: session.startTime ? Date.now() - session.startTime : 0,
      })
    }
    const status = session.state.status === "WAITING_FOR_CONFIRMATION"
      ? "PAUSED"
      : session.state.status as AgentResult["status"]
    this.#settleDirectRecovery()
    if (session.outcomes && session.finalAnswer && !session.finalAnswer.includes("\nOutcomes:\n") && (status === "FAILED" || session.outcomes.some((o) => o.status !== "VERIFIED" && o.status !== "BLOCKED"))) {
      session.finalAnswer = `${session.finalAnswer}\n\n${formatOutcomeReport(session.outcomes)}`
    }
    return {
      status,
      ...(session.finalAnswer !== undefined ? { finalAnswer: session.finalAnswer } : {}),
      ...(session.failureReason ? { failureReason: session.failureReason } : {}),
      ...(session.terminationSource ? { terminationSource: session.terminationSource } : {}),
      turns: session.turns,
      finalState: session.state,
      events: session.state.events,
      contextDiagnostics: session.diagnostics,
      toolCalls: session.toolCalls,
      evalResults: session.evalResults,
      evalSummary: session.evalAnalytics?.formatDeveloperSummary(session.input.task.id),
      observations: session.observations,
      ...(appliedMutations.length > 0 ? { appliedMutations } : {}),
      ...(status === "FAILED" || session.failureReason ? { diagnostics: this.#diagnostics(status) } : {}),
      ...(session.nonProgress ? { nonProgress: session.nonProgress } : {}),
      ...(session.pending ? {
        confirmation: {
          callId: session.pending.prepared.id,
          toolName: session.pending.prepared.name,
          arguments: session.pending.prepared.arguments,
          action: session.pending.prepared.effectiveAction ?? session.pending.prepared.definition.action,
          ...(session.pending.reviewable
            ? (session.pending.prepared.definition.action === "run_known_test"
                ? { preparedCommand: session.pending.reviewable.reviewPayload as any }
                : { preparedMutation: session.pending.reviewable.reviewPayload as any })
            : {})
        },
      } : session.recoveredConfirmation ? {
        confirmation: session.recoveredConfirmation,
      } : {}),
    }
  }

  #diagnostics(status: string) {
    const session = this.#requiredSession()
    const evidence = session.evidenceCollector.getEvidence()
    return buildRunDiagnostics({
      runId: session.input.task.id,
      status,
      failureReason: session.failureReason,
      finalAnswer: session.finalAnswer,
      events: session.state.events,
      toolCalls: session.toolCalls,
      mutations: evidence.mutationOutcomes,
      verifications: evidence.verificationOutcomes,
      pendingApproval: Boolean(session.pending),
      hasCheckpoint: Boolean(this.#checkpointCoordinator),
      unchangedFailures: unchangedFailures(session.observations),
    })
  }

  #requiredSession(): Session {
    if (!this.#session) throw new AgentRunnerError("NO_PENDING_CONFIRMATION", "No task has been started")
    return this.#session
  }
}

/** Identical refusals allowed per workspace state before the run stops as NON_PROGRESS. */
const REPEATED_REFUSAL_LIMIT = 4

function mutationOperation(toolName: string): "create" | "patch" | "delete" {
  if (toolName === "create_file") return "create"
  if (toolName === "delete_file") return "delete"
  return "patch"
}

interface GroupedFile { readonly path: string; readonly beforeHash: string; readonly afterHash: string; readonly beforeContent: string }

/** Per-file entries of a grouped (language-service) review payload, or undefined for a single-file one. */
function groupedFiles(reviewPayload: unknown): readonly GroupedFile[] | undefined {
  const files = reviewPayload && typeof reviewPayload === "object" ? (reviewPayload as { files?: unknown }).files : undefined
  if (!Array.isArray(files) || files.length === 0) return undefined
  return files.filter((file): file is GroupedFile => Boolean(file) && typeof file.path === "string" && typeof file.beforeContent === "string")
}

function groupedFilePaths(reviewPayload: unknown): string[] | undefined {
  return groupedFiles(reviewPayload)?.map((file) => file.path)
}

function mutationPathPayload(args: unknown, reviewPayload: unknown): { path?: string } {
  const path = stringField(args, "path")
    ?? stringField(args, "targetFile")
    ?? stringField(args, "file")
    ?? stringField(reviewPayload, "path")
  return path ? { path } : {}
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  if (typeof field !== "string") return undefined
  const trimmed = field.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function suggestedRelativeImport(filePath: string, specifier: string, implementationPaths: readonly string[]): string | undefined {
  const wanted = basename(specifier)
  const wantedStem = wanted.replace(/\.[^.]+$/, "")
  const matches = [...new Set(implementationPaths.map((path) => path.replaceAll("\\", "/")))].filter((path) => {
    const name = basename(path)
    return name === wanted || name.replace(/\.[^.]+$/, "") === wantedStem
  })
  if (matches.length !== 1 || !matches[0]) return undefined
  let next = relative(dirname(filePath), matches[0]).replaceAll("\\", "/")
  if (!next.startsWith(".")) next = `./${next}`
  return next === specifier ? undefined : next
}

interface RelativeImportProblem {
  readonly specifier: string
  /** The exact specifier that resolves under this project's toolchain, when one exists. */
  readonly fix?: string
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"]
const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

/**
 * Whether relative imports in this file must spell the real file extension. True for native Node ESM
 * (type: module, .mjs/.mts) and native TypeScript execution (type stripping, or no tsconfig at all).
 * False for tsc/bundler projects, where "./format" or "./format.js" resolve to format.ts.
 */
async function requiresExplicitExtension(workspaceRoot: string, filePath: string): Promise<boolean> {
  const importerExt = extname(filePath)
  if (importerExt === ".mjs" || importerExt === ".mts") return true
  let directory = dirname(join(workspaceRoot, filePath))
  let packageText = ""
  let tsconfigText = ""
  let hasTsconfig = false
  for (;;) {
    if (!packageText) packageText = await readOptional(join(directory, "package.json"))
    if (!hasTsconfig && await exists(join(directory, "tsconfig.json"))) {
      hasTsconfig = true
      tsconfigText = await readOptional(join(directory, "tsconfig.json"))
    }
    const parent = dirname(directory)
    if (directory === workspaceRoot || parent === directory || relative(workspaceRoot, parent).startsWith("..")) break
    directory = parent
  }
  const nativeTypeScript = /--experimental-(?:strip|transform)-types/.test(packageText) || /allowImportingTsExtensions|rewriteRelativeImportExtensions/.test(tsconfigText)
  if (TS_EXTENSIONS.includes(importerExt)) return nativeTypeScript || !hasTsconfig
  return /"type"\s*:\s*"module"/.test(packageText) && !hasTsconfig
}

/**
 * Relative imports that will not resolve, each with the exact working specifier when the target file exists.
 * One authority for create_file and apply_patch, so the model gets an actionable correction instead of a retry loop.
 */
async function relativeImportProblems(workspaceRoot: string, filePath: string, content: string): Promise<RelativeImportProblem[]> {
  const specifiers = new Set<string>()
  for (const match of content.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    if (match[1]) specifiers.add(match[1])
  }
  const problems: RelativeImportProblem[] = []
  let explicit: boolean | undefined
  for (const spec of specifiers) {
    const specifier = spec.replace(/[?#].*$/, "") // a bundler suffix such as "?url" or "?raw" is not part of the file name
    const base = normalize(join(workspaceRoot, dirname(filePath), specifier))
    const relativeToWorkspace = relative(workspaceRoot, base)
    if (!relativeToWorkspace || relativeToWorkspace.startsWith("..") || isAbsolute(relativeToWorkspace)) {
      problems.push({ specifier })
      continue
    }
    if (await exists(base) && extname(specifier)) continue
    // The file the specifier means, if any: same path plus an extension, a .js spelling of a .ts file, or an index file.
    const stem = JS_EXTENSIONS.includes(extname(specifier)) ? base.slice(0, -extname(specifier).length) : base
    let target: string | undefined
    for (const candidate of [
      ...TS_EXTENSIONS.map((ext) => `${stem}${ext}`),
      ...JS_EXTENSIONS.map((ext) => `${stem}${ext}`),
      ...[...TS_EXTENSIONS, ...JS_EXTENSIONS].map((ext) => join(base, `index${ext}`)),
    ]) {
      if (candidate !== base && await exists(candidate)) { target = candidate; break }
    }
    if (!target) {
      if (!(await exists(base))) problems.push({ specifier })
      continue
    }
    explicit ??= await requiresExplicitExtension(workspaceRoot, filePath)
    if (!explicit) continue
    let fix = relative(dirname(join(workspaceRoot, filePath)), target).replaceAll("\\", "/")
    if (!fix.startsWith(".")) fix = `./${fix}`
    problems.push({ specifier, fix })
  }
  return problems
}

function describeImportProblems(problems: readonly RelativeImportProblem[], filePath: string, implementationPaths: readonly string[]): string {
  const parts = problems.map((problem) => {
    if (problem.fix) return `"${problem.specifier}" must be written "${problem.fix}" (this project resolves imports with the exact file extension)`
    const suggestion = suggestedRelativeImport(filePath, problem.specifier, implementationPaths)
    return suggestion ? `"${problem.specifier}" does not exist (the named file is "${suggestion}")` : `"${problem.specifier}" does not exist`
  })
  return `These imports do not exist: ${parts.join("; ")}. Use exactly the specifier shown, or import a file that is already in the workspace.`
}
