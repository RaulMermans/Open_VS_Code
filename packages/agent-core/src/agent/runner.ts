import { createToolObservation, type ToolObservation } from "./observations.ts"
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
import type { ProjectInstruction } from "../context/compiler.ts"
import { classifyTaskProfile, type TaskProfile } from "./task-profile.ts"
import { EvidenceLedger } from "./evidence.ts"
import { RuntimeEvalEngine } from "../runtime-evals/runtime-eval-engine.ts"
import { AdaptiveControlPolicy, type AdaptiveDirective } from "../runtime-evals/adaptive-control-policy.ts"
import { RuntimeEvalLedger } from "../runtime-evals/runtime-eval-ledger.ts"
import { RuntimeEvalAnalytics } from "../runtime-evals/analytics.ts"
import { RuntimeEvidenceCollector } from "../runtime-evals/evidence.ts"
import type { RuntimeEvalCheckpoint, RuntimeEvalResult } from "../runtime-evals/contracts.ts"
import type { VerificationEngine } from "../tools/verification-engine.ts"
import { discoverVerificationCommand } from "../tools/verification-discovery.ts"
import { readRepositoryFile } from "../tools/read-file.ts"
import { searchText } from "../tools/search-text.ts"
import type { CheckpointCoordinator } from "../recovery/checkpoint-coordinator.ts"
import { evaluateL0 } from "../runtime-evals/evaluators/l0-deterministic.ts"
import { join } from "node:path"

export type ConfirmationDecision = "APPROVE" | "REJECT"

export interface AgentRunnerInput {
  readonly task: AgentTask
  readonly workspaceRoot: string
  readonly maxTurns: number
  readonly contextBudget: ContextBudget
  readonly projectInstructions: readonly ProjectInstruction[]
  readonly selectedSkills?: readonly LoadedSkill[]
  readonly codeContext?: readonly ContextItem[]
  readonly recentTurns?: readonly ConversationTurn[]
  readonly signal?: AbortSignal
  readonly taskProfile?: TaskProfile
}

export interface AgentRunnerDependencies {
  readonly provider: ModelProvider
  readonly registry: ToolRegistry
  readonly eventFactory?: AgentEventFactory
  readonly eventSink?: (event: AgentState["events"][number]) => void
  readonly permissionEvaluator?: typeof classifyPermission
  readonly contextCompiler?: (input: ContextCompilerInput) => CompiledContext
  readonly nonProgressThreshold?: number
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
}

interface PendingConfirmation {
  readonly prepared: PreparedToolCall
  readonly signature: string
  readonly reviewable?: import("../tools/registry.ts").ReviewableExecution
}

interface Session {
  readonly input: AgentRunnerInput
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
}

export const MAX_CONSECUTIVE_CONTEXT_REQUESTS = 2

export type AgentRunnerErrorCode = "ACTIVE_SESSION" | "NO_PENDING_CONFIRMATION" | "TERMINAL_STATE" | "INVALID_INPUT"

export class AgentRunnerError extends Error {
  readonly code: AgentRunnerErrorCode

  constructor(code: AgentRunnerErrorCode, message: string) {
    super(message)
    this.name = "AgentRunnerError"
    this.code = code
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
  #session?: Session | undefined

  constructor(dependencies: AgentRunnerDependencies) {
    this.#provider = dependencies.provider
    this.#registry = dependencies.registry
    this.#factory = dependencies.eventFactory ?? defaultEventFactory()
    this.#eventSink = dependencies.eventSink
    this.#permissionEvaluator = dependencies.permissionEvaluator ?? classifyPermission
    this.#contextCompiler = dependencies.contextCompiler ?? compileContext
    this.#nonProgressThreshold = dependencies.nonProgressThreshold ?? 3
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
      this.#addErrorObservation(pending.prepared, "PERMISSION_REJECTED", "Caller rejected this tool request", "REJECTED")
    } else {
      if (pending.reviewable) {
        const reviewable = pending.reviewable
        const isVerification = pending.prepared.definition.action === "run_known_test"
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
          if (this.#checkpointCoordinator && !isVerification) {
            const payload = reviewable.reviewPayload as any
            targetFilePath = payload?.path ?? (pending.prepared.arguments as any)?.targetFile ?? (pending.prepared.arguments as any)?.path ?? ""
            if (!targetFilePath.startsWith("/") && session.input.workspaceRoot) {
              targetFilePath = join(session.input.workspaceRoot, targetFilePath)
            }
            if (payload?.beforeContent !== undefined && payload?.beforeContent !== null && payload.beforeContent !== "") {
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
                preconditions: payload?.beforeHash ? [{ path: targetFilePath, expectedHash: payload.beforeHash, exists: true }] : [],
                expectedPostconditions: payload?.afterHash ? [{ path: targetFilePath, expectedHash: payload.afterHash, exists: true }] : [],
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
                touchedFilePaths: targetFilePath ? [targetFilePath] : [],
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
                  touchedFilePaths: targetFilePath ? [targetFilePath] : [],
                })
              }
            } catch (err) {
              postDurabilityError = err instanceof Error ? err : new Error(String(err))
            }
          }
          if (isVerification) {
            this.#emit("verification.completed", {
              callId: pending.prepared.id,
              name: pending.prepared.name,
              mutationId: reviewable.id,
              executionId: reviewable.id,
              result,
            })
            session.evidenceCollector.recordVerificationOutcome({
              executionId: reviewable.id,
              action: (pending.prepared.arguments as any)?.action || "TEST",
              status: result.status,
              failedTestCount: (result as any).failedTests ?? (result.status === "FAIL" ? 1 : 0),
              totalTestCount: (result as any).totalTests,
              stdout: result.stdout,
              stderr: result.stderr,
            })
          } else {
            if (result.status === "APPLIED") {
              this.#emit("mutation.applied", { callId: pending.prepared.id, name: pending.prepared.name, mutationId: reviewable.id })
            } else {
              this.#emit("mutation.failed", { callId: pending.prepared.id, name: pending.prepared.name, mutationId: reviewable.id, error: result.error })
            }
            session.evidenceCollector.recordMutationOutcome({
              mutationId: reviewable.id,
              path: (pending.prepared.arguments as any)?.targetFile || (pending.prepared.arguments as any)?.path || "",
              status: result.status === "APPLIED" ? "APPLIED" : (result.error?.code === "STALE_BASE" ? "STALE" : "FAILED"),
              diffSummary: (reviewable.reviewPayload as any)?.summary || "",
            })
          }
          observation = createToolObservation({ toolName: pending.prepared.name, callId: pending.prepared.id, output: result, maxContentBytes: this.#observationMaxBytes })
          session.observations.push(observation)
          session.toolCalls.push({ id: pending.prepared.id, name: pending.prepared.name, outcome: (!isVerification && result.status === "APPLIED") || isVerification ? "COMPLETED" : "FAILED", truncated: observation.truncated })
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

    // Check if recovery requires human escalation or reconfirmation
    if (directive.decision === "ASK_HUMAN" || plan.disposition === "ASK_HUMAN" || plan.disposition === "RECONFIRM" || plan.divergenceClass === "BLOCKED_DIVERGENCE") {
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
      state: initialAgentState(),
      turns: latestCp.turnId ?? 0,
      continuationAttempts: 0,
      observations: [],
      diagnostics: [],
      toolCalls: [],
      repeatedProgress: 0,
    }
    return this.#continue()
  }

  async #continue(): Promise<AgentResult> {
    const session = this.#requiredSession()
    while (!["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_CONFIRMATION"].includes(session.state.status)) {
      if (session.input.signal?.aborted) {
        this.#cancel()
        break
      }
      if (session.turns >= session.input.maxTurns) {
        session.failureReason = "MAX_TURNS_EXCEEDED"
        this.#emit("task.max_turns", { message: `Maximum of ${session.input.maxTurns} model turns reached` })
        break
      }

      const hasRealEvidence = session.evidenceLedger.totalObservations > 0
      const isEvidenceSatisfied = hasRealEvidence && session.evidenceLedger.evaluate(
        session.taskProfile.evidenceRequirements,
        session.taskProfile.explicitFilePaths,
      ).satisfied

      const isTurnBudgetTight = session.turns >= session.input.maxTurns - 1

      const dynamicBanner = isEvidenceSatisfied
        ? "\n\n[STATUS: EVIDENCE READY]\nYou have gathered the necessary repository evidence. DO NOT call any more tools. Provide your final concise, grounded answer directly now."
        : isTurnBudgetTight
          ? "\n\n[TURN BUDGET WARNING]\nYou are approaching your turn limit. Provide your grounded answer now without calling any further tools."
          : ""

      const phaseInstruction = isEvidenceSatisfied
        ? `Phase 2 - Answer: You have gathered sufficient repository evidence below. Analyze the observations and provide your final grounded answer directly now with exact names, strings, constants, and paths from the observations. Do not call any further tools.`
        : `Phase 1 - Investigation: Use tools to inspect the repository. Strategy: ${session.taskProfile.toolGuidance}`

      const guidanceInstruction: ProjectInstruction = {
        id: "investigation-guidance",
        path: "GUIDELINES.md",
        content: `Operating Guidelines:
- ${phaseInstruction}
- Grounding: Always include the exact function names, literals, values, ports, and file paths found in the observations.
- Completion: When you have sufficient evidence from the observations to answer, output your answer directly without calling more tools.${dynamicBanner}`,
      }

      let compiled: CompiledContext
      try {
        compiled = this.#contextCompiler({
          task: session.input.task.instruction,
          projectInstructions: [guidanceInstruction, ...session.input.projectInstructions],
          ...(session.input.selectedSkills ? { selectedSkills: session.input.selectedSkills } : {}),
          ...(session.input.codeContext ? { codeContext: session.input.codeContext } : {}),
          ...(session.input.recentTurns ? { recentTurns: session.input.recentTurns } : {}),
          observations: session.observations,
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
      this.#emit("context.compiled", { turn, estimatedTokens: compiled.totalEstimatedTokens, omittedCount: compiled.omittedItemIds.length })

      const allowedToolNames = new Set(session.taskProfile.allowedTools)
      const isStandardToolsOnly = this.#registry
        .listDefinitions()
        .every((d) => ["read_file", "list_directory", "find_files", "search_text"].includes(d.name))

      const tools = this.#registry
        .listDefinitions()
        .filter((definition) => !isStandardToolsOnly || allowedToolNames.has(definition.name))
        .filter((definition) => this.#permission(definition.action) !== "DENY")

      let promptContent = renderContext(compiled)
      if (isStandardToolsOnly && (isEvidenceSatisfied || isTurnBudgetTight)) {
        promptContent += "\n\n---\n**Instruction**: Repository evidence has been collected above. DO NOT emit any tool calls. Provide your final grounded answer directly now."
      }

      session.consecutiveContextRequests = 0

      const request: ModelRequest = {
        messages: [{ role: "user", content: promptContent }],
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
      if (newDeploymentId) {
        session.lastDeploymentId = newDeploymentId
      }
      const calls = response.toolCalls ?? []
      this.#emit("model.completed", { turn, toolCallCount: calls.length, hasAnswer: response.message.content.length > 0 })
      if (calls.length === 0) {
        if (this.#evidenceGate) {
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

        // T-4404 / T-4417: BEFORE_COMPLETION evaluation checkpoint
        const { evalResult: beforeCompEval, directive } = await this.#runEval("BEFORE_COMPLETION")

        if (this.#adaptiveInterventions) {
          if (directive.action === "SCHEDULE_VERIFICATION") {
            const { outcome: verifOutcome, evalResult: postVerifEval, directive: postVerifDirective } = await this.#executeScheduledVerification(beforeCompEval.evalId)
            if (verifOutcome === "WAITING_CONFIRMATION" || session.state.status === "WAITING_FOR_CONFIRMATION" || ["FAILED", "CANCELLED"].includes(session.state.status)) {
              return this.#result()
            }

            const hasMutations = session.evidenceCollector.getEvidence().mutationOutcomes.some((m) => m.status === "APPLIED")
            const isVerificationRequired = Boolean(
              session.input.task.metadata?.requireVerification === true ||
              session.input.task.mode === "DEBUG" ||
              session.taskProfile.category === "TEST_DIAGNOSIS" ||
              /\b(?:test|tests|verify|verification|assert|diagnose)\b/i.test(session.input.task.instruction)
            )

            if (verifOutcome === "UNAVAILABLE") {
              if (hasMutations && isVerificationRequired) {
                session.failureReason = "INTERNAL_ERROR"
                this.#emit("task.failed", { message: "VERIFICATION_UNAVAILABLE: Verification was required following code mutation but verification capability is unavailable" })
                break
              }
              await this.#completeTask(response.message.content)
              break
            }

            if (verifOutcome === "PASSED") {
              // Post-verification evaluation MUST control whether completion is allowed!
              if (postVerifDirective && postVerifDirective.decision !== "CONTINUE") {
                const handled = await this.#dispatchDirective(postVerifEval!, postVerifDirective, "VERIFICATION_RESULT")
                if (handled) return this.#result()
                continue
              }
              await this.#completeTask(response.message.content)
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

        await this.#completeTask(response.message.content)
        break
      }

      for (const call of calls) {
        if (await this.#handleCall(call)) break
      }
    }
    return this.#result()
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
      this.#emit("tool.rejected", { callId, name, category })
      const observation = createToolObservation({ toolName: name, callId, error: { category, message }, maxContentBytes: this.#observationMaxBytes })
      session.observations.push(observation)
      session.toolCalls.push({ id: callId, name, outcome: "REJECTED", truncated: observation.truncated })
      session.evidenceCollector.recordToolAction({
        id: callId,
        toolName: name,
        outcome: "REJECTED",
        error: message,
      })
      const { evalResult: rejEval, directive: rejDirective } = await this.#runEval("TOOL_FAILURE")
      if (this.#adaptiveInterventions && rejDirective.decision !== "CONTINUE") {
        const handled = await this.#dispatchDirective(rejEval, rejDirective, "TOOL_FAILURE")
        if (handled) return true
      }
      return false
    }
    const signature = `${prepared.name}\0${stableValue(prepared.arguments)}`
    const permission = this.#permission(prepared.definition.action)
    if (permission === "DENY") {
      this.#emit("permission.denied", { callId: prepared.id, name: prepared.name, action: prepared.definition.action })
      this.#addErrorObservation(prepared, "PERMISSION_DENIED", "Permission policy denied this tool request", "DENIED")
      session.evidenceCollector.recordSecuritySignal({
        id: prepared.id,
        action: prepared.definition.action,
        reason: "Permission policy denied this tool request",
        denied: true,
      })
      session.evidenceCollector.recordToolAction({
        id: prepared.id,
        toolName: prepared.name,
        outcome: "DENIED",
        error: "Permission policy denied this tool request",
      })
      const { evalResult: secEval, directive: secDirective } = await this.#runEval("TOOL_FAILURE")
      if (this.#adaptiveInterventions && secDirective.decision !== "CONTINUE") {
        const handled = await this.#dispatchDirective(secEval, secDirective, "TOOL_FAILURE")
        if (handled) return true
      }
      return false
    }
    if (permission === "CONFIRM") {
      let reviewable: import("../tools/registry.ts").ReviewableExecution | undefined
      if (prepared.prepareForReview) {
        try {
          reviewable = await prepared.prepareForReview({ workspaceRoot: session.input.workspaceRoot, signal: session.input.signal ?? new AbortController().signal })
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
          this.#addErrorObservation(prepared, "TOOL_PREPARATION_ERROR", message, "FAILED")
          this.#emit("tool.rejected", { callId: prepared.id, name: prepared.name, message })
          session.evidenceCollector.recordToolAction({
            id: prepared.id,
            toolName: prepared.name,
            outcome: "FAILED",
            error: message,
          })
          const { evalResult: prepEval, directive: prepDirective } = await this.#runEval("TOOL_FAILURE")
          if (this.#adaptiveInterventions && prepDirective.decision !== "CONTINUE") {
            const handled = await this.#dispatchDirective(prepEval, prepDirective, "TOOL_FAILURE")
            if (handled) return true
          }
          return false
        }
      }
      session.pending = { prepared, signature }
      this.#emit("permission.requested", { callId: prepared.id, name: prepared.name, action: prepared.definition.action })
      return true
    }
    return this.#execute(prepared, signature)
  }

  async #execute(prepared: PreparedToolCall, signature: string): Promise<boolean> {
    const session = this.#requiredSession()
    this.#emit("tool.requested", { callId: prepared.id, name: prepared.name })
    let observation: ToolObservation
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
      const output = await prepared.invoke({ workspaceRoot: session.input.workspaceRoot, signal: session.input.signal ?? new AbortController().signal })
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
      observation = createToolObservation({ toolName: prepared.name, callId: prepared.id, output, maxContentBytes: this.#observationMaxBytes })
      session.observations.push(observation)
      session.toolCalls.push({ id: prepared.id, name: prepared.name, outcome: "COMPLETED", truncated: observation.truncated })
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
        session.evidenceCollector.recordMutationOutcome({
          mutationId: prepared.id,
          path: (prepared.arguments as any)?.targetFile || (prepared.arguments as any)?.path || "",
          status: "APPLIED",
        })
        const { evalResult: mutEval, directive: mutDirective } = await this.#runEval("MUTATION_RESULT")
        if (this.#adaptiveInterventions && mutDirective.decision !== "CONTINUE") {
          const handled = await this.#dispatchDirective(mutEval, mutDirective, "MUTATION_RESULT")
          if (handled) return true
        }
      } else if (prepared.definition.action === "run_known_test") {
        const res = output as any
        const status = res?.status === "PASS" ? "PASS" : res?.status === "FAIL" ? "FAIL" : "PASS"
        session.evidenceCollector.recordVerificationOutcome({
          executionId: prepared.id,
          action: (prepared.arguments as any)?.action || "TEST",
          status,
          failedTestCount: res?.failedTests ?? (status === "FAIL" ? 1 : 0),
          totalTestCount: res?.totalTests,
          stdout: res?.stdout,
          stderr: res?.stderr,
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
        error: { category: "TOOL_RUNTIME_ERROR", message },
        maxContentBytes: this.#observationMaxBytes,
      })
      session.observations.push(observation)
      session.toolCalls.push({ id: prepared.id, name: prepared.name, outcome: "FAILED", truncated: observation.truncated })
      session.evidenceCollector.recordToolAction({
        id: prepared.id,
        toolName: prepared.name,
        outcome: "FAILED",
        args: prepared.arguments as Record<string, unknown>,
        error: message,
      })
      this.#emit("tool.failed", { callId: prepared.id, name: prepared.name, message })

      const { evalResult: failEval, directive: failDirective } = await this.#runEval("TOOL_FAILURE")
      if (this.#adaptiveInterventions && failDirective.decision !== "CONTINUE") {
        const handled = await this.#dispatchDirective(failEval, failDirective, "TOOL_FAILURE")
        if (handled) return true
      }
    }
    const progressKey = `${signature}\0${observation.ok}\0${observation.content}`
    session.repeatedProgress = session.lastProgressKey === progressKey ? session.repeatedProgress + 1 : 1
    session.lastProgressKey = progressKey
    if (session.repeatedProgress >= this.#nonProgressThreshold) {
      session.failureReason = "NON_PROGRESS"
      session.terminationSource = "NON_PROGRESS_GUARD"
      this.#emit("task.non_progress", { message: `Repeated ${prepared.name} call made no progress`, threshold: this.#nonProgressThreshold, terminationSource: "NON_PROGRESS_GUARD" })
      return true
    }
    return false
  }

  #addErrorObservation(prepared: PreparedToolCall, category: string, message: string, outcome: AgentToolCallRecord["outcome"]): void {
    const session = this.#requiredSession()
    const observation = createToolObservation({ toolName: prepared.name, callId: prepared.id, error: { category, message }, maxContentBytes: this.#observationMaxBytes })
    session.observations.push(observation)
    session.toolCalls.push({ id: prepared.id, name: prepared.name, outcome, truncated: observation.truncated })
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
        const isVerificationRequired = Boolean(
          session.input.task.metadata?.requireVerification === true ||
          session.input.task.mode === "DEBUG" ||
          session.taskProfile.category === "TEST_DIAGNOSIS" ||
          /\b(?:test|tests|verify|verification|assert|diagnose)\b/i.test(session.input.task.instruction)
        )
        if (verifOutcome === "UNAVAILABLE" && hasMutations && isVerificationRequired) {
          session.failureReason = "INTERNAL_ERROR"
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
          session.evidenceCollector.recordVerificationOutcome({
            executionId: reviewable.id,
            action: "TEST",
            status: result.status,
            failedTestCount: result.failedTests ?? (result.status === "FAIL" ? 1 : 0),
            totalTestCount: result.totalTests,
            stdout: result.stdout,
            stderr: result.stderr,
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
        const failedCount = (result as any).failedTests ?? (result.status === "FAIL" ? 1 : 0)
        session.evidenceCollector.recordVerificationOutcome({
          executionId: verifId,
          action: "TEST",
          status: result.status,
          failedTestCount: failedCount,
          totalTestCount: (result as any).totalTests,
          stdout: result.stdout,
          stderr: result.stderr,
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
    this.#emit("task.completed", { turns: session.turns })
  }

  #result(): AgentResult {
    const session = this.#requiredSession()
    if (this.#performanceLedger && session.lastDeploymentId && !session.performanceOutcomeRecorded) {
      session.performanceOutcomeRecorded = true
      const isCompleted = session.state.status === "COMPLETED"
      const verificationSuccess = isCompleted || session.evalResults.some(r => r.checkpoint === "VERIFICATION_RESULT" && r.scores.verificationCoverage > 0.5)
      const toolCallSuccess = session.toolCalls.length === 0 || !session.toolCalls.some(t => t.outcome === "REJECTED" || t.outcome === "DENIED")
      this.#performanceLedger.recordAgentOutcome({
        deploymentId: session.lastDeploymentId,
        taskClass: deriveTaskClass(session.input.task.mode),
        success: isCompleted,
        verificationSuccess,
        toolCallSuccess,
        repairCycles: session.toolCalls.filter(t => t.name === "run_known_test" && t.outcome !== "COMPLETED").length,
        timeoutOccurred: session.failureReason === "MODEL_ERROR",
        cancellationOccurred: session.state.status === "CANCELLED",
        latencyMs: session.startTime ? Date.now() - session.startTime : 0,
      })
    }
    const status = session.state.status === "WAITING_FOR_CONFIRMATION"
      ? "PAUSED"
      : session.state.status as AgentResult["status"]
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
      ...(session.pending ? {
        confirmation: {
          callId: session.pending.prepared.id,
          toolName: session.pending.prepared.name,
          arguments: session.pending.prepared.arguments,
          action: session.pending.prepared.definition.action,
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

  #requiredSession(): Session {
    if (!this.#session) throw new AgentRunnerError("NO_PENDING_CONFIRMATION", "No task has been started")
    return this.#session
  }
}
