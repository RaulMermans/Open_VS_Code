import { createToolObservation, type ToolObservation } from "./observations.ts"
import { createAgentEvent, type AgentEventFactory, type AgentEventType } from "./events.ts"
import { applyAgentEvent, initialAgentState } from "./state.ts"
import { compileContext, type ContextCompilerInput } from "../context/compiler.ts"
import { ContextBudgetError } from "../context/budget.ts"
import type {
  AgentContextDiagnostic,
  AgentFailureReason,
  AgentResult,
  AgentState,
  AgentTask,
  AgentToolCallRecord,
} from "../contracts/agent.ts"
import type { CompiledContext, ContextBudget, ContextItem } from "../contracts/context.ts"
import type { ModelProvider, ModelRequest } from "../contracts/model.ts"
import type { ToolCall, ToolPermission } from "../contracts/tools.ts"
import { classifyPermission } from "../tools/permissions.ts"
import { type PreparedToolCall, ToolRegistry, ToolRegistryError } from "../tools/registry.ts"
import type { LoadedSkill } from "../context/skills.ts"
import type { ProjectInstruction } from "../context/compiler.ts"
import { classifyTaskProfile, type TaskProfile } from "./task-profile.ts"
import { EvidenceLedger } from "./evidence.ts"

export type ConfirmationDecision = "APPROVE" | "REJECT"

export interface AgentRunnerInput {
  readonly task: AgentTask
  readonly workspaceRoot: string
  readonly maxTurns: number
  readonly contextBudget: ContextBudget
  readonly projectInstructions: readonly ProjectInstruction[]
  readonly selectedSkill?: LoadedSkill
  readonly codeContext?: readonly ContextItem[]
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
}

interface PendingConfirmation {
  readonly prepared: PreparedToolCall
  readonly signature: string
}

interface Session {
  readonly input: AgentRunnerInput
  readonly taskProfile: TaskProfile
  readonly evidenceLedger: EvidenceLedger
  state: AgentState
  turns: number
  continuationAttempts: number
  observations: ToolObservation[]
  diagnostics: AgentContextDiagnostic[]
  toolCalls: AgentToolCallRecord[]
  pending?: PendingConfirmation
  finalAnswer?: string
  failureReason?: AgentFailureReason
  lastProgressKey?: string
  repeatedProgress: number
}

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
  readonly #eventSink?: AgentRunnerDependencies["eventSink"]
  readonly #permissionEvaluator: typeof classifyPermission
  readonly #contextCompiler: (input: ContextCompilerInput) => CompiledContext
  readonly #nonProgressThreshold: number
  readonly #observationMaxBytes: number
  readonly #evidenceGate: boolean
  readonly #maxContinuations: number
  #session?: Session

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
    if (!Number.isInteger(this.#nonProgressThreshold) || this.#nonProgressThreshold < 2) {
      throw new AgentRunnerError("INVALID_INPUT", "nonProgressThreshold must be an integer of at least 2")
    }
  }

  async run(input: AgentRunnerInput): Promise<AgentResult> {
    if (this.#session && !["COMPLETED", "FAILED", "CANCELLED"].includes(this.#session.state.status)) {
      throw new AgentRunnerError("ACTIVE_SESSION", "Runner already has an active task")
    }
    if (!Number.isInteger(input.maxTurns) || input.maxTurns <= 0) throw new AgentRunnerError("INVALID_INPUT", "maxTurns must be a positive integer")
    if (!input.workspaceRoot.trim()) throw new AgentRunnerError("INVALID_INPUT", "workspaceRoot must not be empty")
    const taskProfile = input.taskProfile ?? classifyTaskProfile(input.task.instruction, input.task.mode)
    this.#session = {
      input,
      taskProfile,
      evidenceLedger: new EvidenceLedger(),
      state: initialAgentState(),
      turns: 0,
      continuationAttempts: 0,
      observations: [],
      diagnostics: [],
      toolCalls: [],
      repeatedProgress: 0,
    }
    this.#emit("task.started", { task: input.task })
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
      this.#emit("permission.rejected", { callId: pending.prepared.id, name: pending.prepared.name })
      this.#addErrorObservation(pending.prepared, "PERMISSION_REJECTED", "Caller rejected this tool request", "REJECTED")
    } else {
      this.#emit("permission.approved", { callId: pending.prepared.id, name: pending.prepared.name })
      if (await this.#execute(pending.prepared, pending.signature)) return this.#result()
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
          ...(session.input.selectedSkill ? { selectedSkill: session.input.selectedSkill } : {}),
          ...(session.input.codeContext ? { codeContext: session.input.codeContext } : {}),
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

      const request: ModelRequest = {
        messages: [{ role: "user", content: promptContent }],
        ...(session.input.signal ? { signal: session.input.signal } : {}),
        tools,
        metadata: { turn, tools },
      }
      this.#emit("model.requested", { turn })
      session.turns = turn
      let response
      try {
        response = await this.#provider.complete(request)
      } catch (error) {
        if (isAbortError(error, session.input.signal)) this.#cancel()
        else {
          session.failureReason = "MODEL_ERROR"
          this.#emit("model.failed", { turn, message: error instanceof Error ? error.message : "Model request failed" })
        }
        break
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
        session.finalAnswer = response.message.content
        this.#emit("task.completed", { turns: session.turns })
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
      return false
    }
    const signature = `${prepared.name}\0${stableValue(prepared.arguments)}`
    const permission = this.#permission(prepared.definition.action)
    if (permission === "DENY") {
      this.#emit("permission.denied", { callId: prepared.id, name: prepared.name, action: prepared.definition.action })
      this.#addErrorObservation(prepared, "PERMISSION_DENIED", "Permission policy denied this tool request", "DENIED")
      return false
    }
    if (permission === "CONFIRM") {
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
    try {
      const output = await prepared.invoke({ workspaceRoot: session.input.workspaceRoot, signal: session.input.signal ?? new AbortController().signal })
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
      this.#emit("tool.completed", { callId: prepared.id, name: prepared.name, truncated: observation.truncated })
    } catch (error) {
      if (isAbortError(error, session.input.signal)) {
        this.#cancel()
        return true
      }
      const message = error instanceof Error ? error.message : "Tool execution failed"
      observation = createToolObservation({
        toolName: prepared.name,
        callId: prepared.id,
        error: { category: "TOOL_RUNTIME_ERROR", message },
        maxContentBytes: this.#observationMaxBytes,
      })
      session.observations.push(observation)
      session.toolCalls.push({ id: prepared.id, name: prepared.name, outcome: "FAILED", truncated: observation.truncated })
      this.#emit("tool.failed", { callId: prepared.id, name: prepared.name, message })
    }
    const progressKey = `${signature}\0${observation.ok}\0${observation.content}`
    session.repeatedProgress = session.lastProgressKey === progressKey ? session.repeatedProgress + 1 : 1
    session.lastProgressKey = progressKey
    if (session.repeatedProgress >= this.#nonProgressThreshold) {
      session.failureReason = "NON_PROGRESS"
      this.#emit("task.non_progress", { message: `Repeated ${prepared.name} call made no progress`, threshold: this.#nonProgressThreshold })
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

  #result(): AgentResult {
    const session = this.#requiredSession()
    const status = session.state.status === "WAITING_FOR_CONFIRMATION"
      ? "PAUSED"
      : session.state.status as AgentResult["status"]
    return {
      status,
      ...(session.finalAnswer !== undefined ? { finalAnswer: session.finalAnswer } : {}),
      ...(session.failureReason ? { failureReason: session.failureReason } : {}),
      turns: session.turns,
      finalState: session.state,
      events: session.state.events,
      contextDiagnostics: session.diagnostics,
      toolCalls: session.toolCalls,
      ...(session.pending ? {
        confirmation: {
          callId: session.pending.prepared.id,
          toolName: session.pending.prepared.name,
          arguments: session.pending.prepared.arguments,
          action: session.pending.prepared.definition.action,
        },
      } : {}),
    }
  }

  #requiredSession(): Session {
    if (!this.#session) throw new AgentRunnerError("NO_PENDING_CONFIRMATION", "No task has been started")
    return this.#session
  }
}
