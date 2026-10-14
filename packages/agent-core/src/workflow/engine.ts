/**
 * EngineeringWorkflow (Sprint 5B, ADR-030): one sequential, bounded orchestration over the existing
 * AgentRunner, PermissionGate, VerificationEngine, skills runtime and recovery store.
 *
 *   PLAN → IMPLEMENT → TEST → REVIEW → VERIFY → COMPLETE   (any stage → BLOCKED | CANCELLED)
 *
 * Each model stage runs a brand-new AgentRunner session with a stage-specific tool envelope and an
 * instruction rebuilt from persisted artifacts, so no stage inherits another stage's conversation.
 * TEST and VERIFY are deterministic: they run repository-defined checks, never model-invented commands.
 */
import { readFile } from "node:fs/promises"

import { AgentRunner, type ConfirmationDecision } from "../agent/runner.ts"
import { compileContext, type ContextCompilerInput } from "../context/compiler.ts"
import { estimateTokens } from "../context/budget.ts"
import type { AgentConfirmationRequest, AgentEvent, AgentMode, AgentResult } from "../contracts/agent.ts"
import type { ContextBudget } from "../contracts/context.ts"
import type { ModelProvider } from "../contracts/model.ts"
import type { CheckpointCoordinator } from "../recovery/checkpoint-coordinator.ts"
import type { SkillRegistry } from "../skills/registry.ts"
import { SkillInjectionTracker, disabledSkillEvidence, prepareSkillGuidance } from "../skills/runtime.ts"
import { sha256 } from "../tools/mutation-engine.ts"
import { resolveRepositoryPath } from "../tools/path-safety.ts"
import type { ToolRegistry } from "../tools/registry.ts"
import type { VerificationAction } from "../tools/verification-contracts.ts"
import { boundText, changedFileFromMutation, checkOutcome, parsePlanArtifact, parseReviewEvidence, renderDiff, uniquePaths } from "./artifacts.ts"
import { implementInstruction, planInstruction, reviewInstruction, reviewRepairReason, testRepairReason } from "./context.ts"
import {
  ARTIFACT_LIMITS,
  DEFAULT_WORKFLOW_POLICY,
  TERMINAL_STAGES,
  type CheckOutcome,
  type EngineeringStage,
  type StageRecord,
  type WorkflowBlocker,
  type WorkflowConfirmation,
  type WorkflowPolicy,
  type WorkflowResult,
  type WorkflowStageEvent,
  type WorkflowState,
  type WorkStage,
} from "./contracts.ts"
import { STAGE_ENVELOPES, assertTransition, stagePermission, type PermissionEvaluator } from "./policy.ts"
import type { WorkflowStateStore, WorkflowVerifier } from "./services.ts"

export interface EngineeringWorkflowDependencies {
  readonly provider: ModelProvider
  /** The full tool registry; each stage sees only `registry.restrict(envelope)`. */
  readonly registry: ToolRegistry
  /** The base PermissionGate (normally `classifyPermission`). Stages can only narrow it. */
  readonly permissionEvaluator: PermissionEvaluator
  readonly verifier: WorkflowVerifier
  readonly workspaceRoot: string
  readonly contextBudget: ContextBudget
  readonly store?: WorkflowStateStore
  readonly checkpointCoordinator?: CheckpointCoordinator
  readonly eventSink?: (event: AgentEvent) => void
  readonly onStage?: (event: WorkflowStageEvent) => void
  readonly skills?: { readonly registry: SkillRegistry }
  readonly policy?: Partial<WorkflowPolicy>
  readonly clock?: () => string
  readonly idFactory?: () => string
}

export interface EngineeringWorkflowInput {
  readonly task: string
  readonly mode: AgentMode
  readonly taskId?: string
  readonly workflowId?: string
  readonly memoryDigest?: string
  readonly constraints?: string
  readonly signal?: AbortSignal
}

/** Context a restored workflow needs that is deliberately not persisted (it is re-derived). */
export type RestoreInput = Pick<EngineeringWorkflowInput, "memoryDigest" | "constraints" | "signal">

interface ActiveModelStage {
  readonly stage: WorkStage
  readonly runner: AgentRunner
  readonly tracker: SkillInjectionTracker
  readonly onDone: (result: AgentResult) => Promise<void>
  confirmation?: AgentConfirmationRequest
}

type Step = "CONTINUE" | "PAUSED"

function defaultId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class EngineeringWorkflow {
  readonly #deps: EngineeringWorkflowDependencies
  readonly #policy: WorkflowPolicy
  readonly #clock: () => string
  readonly #inputs: { readonly task: string; readonly memoryDigest?: string; readonly constraints?: string }
  readonly #abort = new AbortController()
  #state: WorkflowState
  #active: ActiveModelStage | undefined
  #pendingVerification: { readonly stage: "TEST" | "VERIFY"; readonly actions: readonly VerificationAction[] } | undefined
  #driving = false

  private constructor(deps: EngineeringWorkflowDependencies, state: WorkflowState, inputs: RestoreInput) {
    this.#deps = deps
    this.#policy = { ...DEFAULT_WORKFLOW_POLICY, ...deps.policy }
    this.#clock = deps.clock ?? (() => new Date().toISOString())
    this.#state = state
    this.#inputs = {
      task: state.task,
      ...(inputs.memoryDigest ? { memoryDigest: boundText(inputs.memoryDigest, 1_500) } : {}),
      ...(inputs.constraints ? { constraints: boundText(inputs.constraints, 1_500) } : {}),
    }
    if (inputs.signal) {
      if (inputs.signal.aborted) this.#abort.abort()
      else inputs.signal.addEventListener("abort", () => this.#abort.abort(), { once: true })
    }
  }

  static start(deps: EngineeringWorkflowDependencies, input: EngineeringWorkflowInput): EngineeringWorkflow {
    if (!input.task.trim()) throw new TypeError("Workflow task must not be empty")
    const now = (deps.clock ?? (() => new Date().toISOString()))()
    const workflowId = input.workflowId ?? (deps.idFactory ?? defaultId)()
    const state: WorkflowState = {
      schemaVersion: 1,
      workflowId,
      taskId: input.taskId ?? workflowId,
      mode: input.mode,
      task: input.task,
      status: "RUNNING",
      currentStage: "PLAN",
      completedStages: [],
      selectedSkillIds: [],
      reviews: [],
      retryCounts: { plan: 0, implement: 0, review: 0, testRepairs: 0, reviewRepairs: 0 },
      stages: [],
      createdAt: now,
      updatedAt: now,
    }
    return new EngineeringWorkflow(deps, state, input)
  }

  /**
   * Restores a persisted workflow. Completed stages are never re-run. A confirmation that was pending
   * when the process stopped is never treated as approved: a pending runner stage restarts with a
   * fresh session, and pending verification checks are re-requested.
   */
  static async restore(deps: EngineeringWorkflowDependencies, workflowId: string, input: RestoreInput = {}): Promise<EngineeringWorkflow> {
    if (!deps.store) throw new Error("Workflow restore requires a state store")
    const state = await deps.store.load(workflowId)
    if (!state) throw new Error(`No persisted workflow ${workflowId}`)
    const workflow = new EngineeringWorkflow(deps, state, input)
    if (state.pending?.kind === "VERIFICATION") {
      workflow.#pendingVerification = { stage: state.pending.stage, actions: state.pending.actions }
    } else if (state.pending?.kind === "RUNNER") {
      // The runner session lived in the previous process. Close that attempt and restart the stage
      // from its artifacts; the pending action was never approved and is not replayed.
      const { pending: _dropped, ...rest } = state
      workflow.#state = { ...rest, status: "RUNNING" }
      workflow.#patchRecord({ status: "FAILED", endedAt: workflow.#clock(), outcome: "INTERRUPTED_BY_RESTART" })
    }
    return workflow
  }

  get state(): WorkflowState {
    return this.#state
  }

  get policy(): WorkflowPolicy {
    return this.#policy
  }

  /** Stops the workflow. No later stage, review or verification runs. */
  cancel(): void {
    this.#abort.abort()
  }

  async run(): Promise<WorkflowResult> {
    if (TERMINAL_STAGES.has(this.#state.currentStage)) return this.#result()
    if (this.#state.status === "WAITING_FOR_CONFIRMATION") return this.#result()
    await this.#persist()
    return this.#drive()
  }

  async resume(decision: ConfirmationDecision): Promise<WorkflowResult> {
    if (TERMINAL_STAGES.has(this.#state.currentStage)) return this.#result()
    if (this.#aborted()) return this.#drive()
    if (this.#state.status !== "WAITING_FOR_CONFIRMATION") throw new Error("Workflow has no pending confirmation")

    if (this.#pendingVerification) {
      const { stage, actions } = this.#pendingVerification
      this.#pendingVerification = undefined
      this.#setPending(undefined)
      if (decision === "REJECT") return this.#blockAndStop("VERIFICATION_REJECTED", `${stage} checks were not approved`)
      await this.#executeChecks(stage, actions)
      return this.#drive()
    }

    const active = this.#active
    if (!active) throw new Error("Workflow has no active stage to resume")
    const confirmation = active.confirmation
    this.#setPending(undefined)
    let result: AgentResult
    try {
      result = await active.runner.resume(decision)
    } catch (error) {
      return this.#blockAndStop("STAGE_FAILED", error instanceof Error ? error.message : String(error))
    }
    if (decision === "APPROVE" && confirmation?.preparedMutation && this.#mutationApplied(result, confirmation.callId)) {
      this.#recordChange(confirmation)
    }
    if ((await this.#afterRunner(active, result)) === "PAUSED") return this.#result()
    return this.#drive()
  }

  // ---- driver -------------------------------------------------------------------------------------

  async #drive(): Promise<WorkflowResult> {
    if (this.#driving) throw new Error("Workflow is already running")
    this.#driving = true
    try {
      while (!TERMINAL_STAGES.has(this.#state.currentStage)) {
        if (this.#aborted()) {
          await this.#terminate("CANCELLED")
          break
        }
        const step = await this.#runStage(this.#state.currentStage as WorkStage)
        if (step === "PAUSED") break
      }
      return this.#result()
    } finally {
      this.#driving = false
    }
  }

  async #runStage(stage: WorkStage): Promise<Step> {
    switch (stage) {
      case "PLAN":
        return this.#startModelStage("PLAN", planInstruction(this.#inputs), (result) => this.#completePlan(result))
      case "IMPLEMENT":
        return this.#startModelStage("IMPLEMENT", implementInstruction(this.#inputs, this.#state), (result) => this.#completeImplement(result))
      case "TEST":
        return this.#requestChecks("TEST", ["TEST"])
      case "REVIEW":
        return this.#startModelStage("REVIEW", reviewInstruction(this.#inputs, this.#state), (result) => this.#completeReview(result))
      case "VERIFY":
        return this.#requestChecks("VERIFY", this.#policy.verifyActions)
    }
  }

  // ---- model stages -------------------------------------------------------------------------------

  async #startModelStage(stage: WorkStage, instruction: string, onDone: (result: AgentResult) => Promise<void>): Promise<Step> {
    const envelope = STAGE_ENVELOPES[stage]
    const registry = this.#deps.registry.restrict(envelope.actions)
    const permission = stagePermission(stage, this.#deps.permissionEvaluator)

    let guidance: Awaited<ReturnType<typeof prepareSkillGuidance>> | undefined
    if (this.#deps.skills) {
      // Selection keys on the original task, filtered by the stage's mode and tool envelope.
      guidance = await prepareSkillGuidance({
        enabled: true,
        registry: this.#deps.skills.registry,
        task: this.#state.task,
        mode: envelope.mode,
        availableTools: registry.listDefinitions().map((definition) => definition.name),
        permissionEvaluator: permission,
        budget: this.#deps.contextBudget,
        reservedTokens: estimateTokens(instruction),
      })
    }
    const tracker = new SkillInjectionTracker(guidance?.evidence ?? disabledSkillEvidence(), guidance?.guidance ?? [])
    const contextCompiler = (input: ContextCompilerInput) => {
      const compiled = compileContext(input)
      tracker.observe(compiled)
      return compiled
    }
    const runner = new AgentRunner({
      provider: this.#deps.provider,
      registry,
      permissionEvaluator: permission,
      evidenceGate: false,
      contextCompiler,
      ...(this.#deps.eventSink ? { eventSink: this.#deps.eventSink } : {}),
      ...(stage === "IMPLEMENT" && this.#deps.checkpointCoordinator ? { checkpointCoordinator: this.#deps.checkpointCoordinator } : {}),
    })
    const attempt = this.#state.stages.filter((record) => record.stage === stage).length + 1
    const active: ActiveModelStage = { stage, runner, tracker, onDone }
    this.#active = active
    this.#beginRecord(stage, attempt, envelope.mode)

    let result: AgentResult
    try {
      result = await runner.run({
        task: {
          id: `${this.#state.workflowId}:${stage}:${attempt}`,
          mode: envelope.mode,
          instruction,
          // TEST and VERIFY are mandatory after IMPLEMENT (transition guards), so they own verification.
          ...(stage === "IMPLEMENT" ? { metadata: { verificationOwner: "workflow" } } : {}),
        },
        workspaceRoot: this.#deps.workspaceRoot,
        maxTurns: this.#policy.maxStageTurns,
        contextBudget: this.#deps.contextBudget,
        projectInstructions: [],
        ...(guidance && guidance.guidance.length > 0 ? { skillGuidance: guidance.guidance } : {}),
        signal: this.#abort.signal,
      })
    } catch (error) {
      await this.#finishRecord("FAILED", { outcome: "RUNNER_ERROR" })
      await this.#block("STAGE_FAILED", error instanceof Error ? error.message : String(error))
      return "CONTINUE"
    }
    return this.#afterRunner(active, result)
  }

  async #afterRunner(active: ActiveModelStage, result: AgentResult): Promise<Step> {
    this.#updateRecordFromRunner(active, result)
    if (result.status === "PAUSED" && result.confirmation) {
      active.confirmation = result.confirmation
      this.#setPending({ kind: "RUNNER", stage: active.stage, callId: result.confirmation.callId, toolName: result.confirmation.toolName, action: result.confirmation.action })
      this.#patchRecord({ status: "WAITING_FOR_CONFIRMATION" })
      await this.#persist()
      this.#emitStage()
      return "PAUSED"
    }
    this.#active = undefined
    if (result.status === "CANCELLED" || this.#aborted()) {
      await this.#finishRecord("CANCELLED", { outcome: "CANCELLED" })
      await this.#terminate("CANCELLED")
      return "CONTINUE"
    }
    await active.onDone(result)
    return "CONTINUE"
  }

  async #completePlan(result: AgentResult): Promise<void> {
    const plan = result.status === "COMPLETED" ? parsePlanArtifact(result.finalAnswer) : undefined
    if (!plan) {
      await this.#finishRecord("FAILED", { outcome: result.status === "COMPLETED" ? "PLAN_INVALID" : (result.failureReason ?? result.status) })
      await this.#retryOrBlock("PLAN", "plan", result.status === "COMPLETED" ? "PLAN_INVALID" : "STAGE_FAILED")
      return
    }
    this.#state = { ...this.#state, plan }
    await this.#finishRecord("PASSED", { outcome: "PLAN_READY" })
    await this.#transition("IMPLEMENT", "PLAN")
  }

  async #completeImplement(result: AgentResult): Promise<void> {
    const repairing = this.#state.repairReason !== undefined
    const pass = this.#currentPass()
    const newChanges = (this.#state.implementation?.changedFiles ?? []).filter((change) => change.pass === pass).length
    if (result.status !== "COMPLETED") {
      await this.#finishRecord("FAILED", { outcome: result.failureReason ?? result.status })
      if (newChanges === 0) {
        await this.#retryOrBlock("IMPLEMENT", "implement", "STAGE_FAILED")
        return
      }
    } else {
      await this.#finishRecord(newChanges > 0 ? "PASSED" : "FAILED", { outcome: `${newChanges} change(s)` })
    }
    if (newChanges === 0) {
      await this.#block(repairing ? "REPAIR_PRODUCED_NO_CHANGES" : "NO_CHANGES", "IMPLEMENT applied no changes")
      return
    }
    const implementation = this.#state.implementation!
    // Fresh test evidence is required after every implementation pass.
    const { repairReason: _done, test: _stale, ...rest } = this.#state
    this.#state = {
      ...rest,
      implementation: { ...implementation, passes: pass, summary: boundText(result.finalAnswer, ARTIFACT_LIMITS.summaryChars) },
    }
    await this.#transition("TEST", "IMPLEMENT")
  }

  async #completeReview(result: AgentResult): Promise<void> {
    const attempt = this.#state.reviews.length + 1
    const changes = this.#state.implementation?.changedFiles ?? []
    const review = result.status === "COMPLETED"
      ? parseReviewEvidence(result.finalAnswer, attempt, { diff: renderDiff(changes).text, changedFiles: uniquePaths(changes), fileContents: await this.#readChangedFiles() })
      : undefined
    if (!review) {
      await this.#finishRecord("FAILED", { outcome: result.status === "COMPLETED" ? "REVIEW_UNPARSEABLE" : (result.failureReason ?? result.status) })
      await this.#retryOrBlock("REVIEW", "review", result.status === "COMPLETED" ? "REVIEW_UNPARSEABLE" : "STAGE_FAILED")
      return
    }
    this.#state = { ...this.#state, reviews: [...this.#state.reviews, review] }
    await this.#finishRecord(review.blocking > 0 ? "FAILED" : "PASSED", { outcome: `${review.verdict} (${review.blocking} blocking)` })
    if (review.blocking === 0) {
      await this.#transition("VERIFY", "REVIEW")
      return
    }
    if (this.#state.retryCounts.reviewRepairs >= this.#policy.maxReviewRepairs) {
      await this.#block("BLOCKED_REVIEW", `${review.blocking} blocking finding(s) after ${this.#state.retryCounts.reviewRepairs} repair cycle(s)`)
      return
    }
    await this.#startRepair("REVIEW", "reviewRepairs", reviewRepairReason(this.#state))
  }

  // ---- deterministic stages -----------------------------------------------------------------------

  async #requestChecks(stage: "TEST" | "VERIFY", wanted: readonly VerificationAction[]): Promise<Step> {
    const attempt = this.#state.stages.filter((record) => record.stage === stage).length + 1
    this.#beginRecord(stage, attempt, STAGE_ENVELOPES[stage].mode)
    const available: { action: VerificationAction; command: string }[] = []
    for (const action of wanted) {
      const command = await this.#deps.verifier.discover(action)
      if (command) available.push({ action, command })
    }
    if (available.length === 0) {
      await this.#finishRecord("BLOCKED", { outcome: "NO_CHECKS" })
      if (stage === "TEST") {
        this.#state = { ...this.#state, test: { attempted: false, commands: [], passed: false, outcomes: [], failureFingerprints: [] } }
        await this.#block("NO_TEST_COMMAND", "the repository defines no test command")
      } else {
        this.#state = { ...this.#state, verification: { verdict: "BLOCKED", outcomes: [], diffIntegrity: "NO_CHANGES", divergedFiles: [], reason: "no verification commands" } }
        await this.#block("VERIFY_UNAVAILABLE", "the repository defines no verification commands")
      }
      return "CONTINUE"
    }
    // The PermissionGate decides; stage membership is never approval.
    const permission = stagePermission(stage, this.#deps.permissionEvaluator)({ action: "run_known_test", mode: STAGE_ENVELOPES[stage].mode })
    if (permission === "DENY") {
      await this.#finishRecord("BLOCKED", { outcome: "PERMISSION_DENIED" })
      await this.#block("VERIFICATION_DENIED", `${stage} checks are denied by the permission policy`)
      return "CONTINUE"
    }
    const actions = available.map((item) => item.action)
    if (permission === "CONFIRM") {
      this.#pendingVerification = { stage, actions }
      this.#setPending({ kind: "VERIFICATION", stage, actions, commands: available.map((item) => item.command) })
      this.#patchRecord({ status: "WAITING_FOR_CONFIRMATION" })
      await this.#persist()
      this.#emitStage()
      return "PAUSED"
    }
    await this.#executeChecks(stage, actions)
    return "CONTINUE"
  }

  async #executeChecks(stage: "TEST" | "VERIFY", actions: readonly VerificationAction[]): Promise<void> {
    this.#patchRecord({ status: "RUNNING" })
    const outcomes: CheckOutcome[] = []
    for (const action of actions) {
      if (this.#aborted()) break
      try {
        const { command, result } = await this.#deps.verifier.run(action, this.#abort.signal)
        outcomes.push(checkOutcome(action, command, result))
      } catch (error) {
        outcomes.push(checkOutcome(action, action, { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: 0 }))
      }
    }
    if (this.#aborted()) {
      await this.#finishRecord("CANCELLED", { outcome: "CANCELLED" })
      await this.#terminate("CANCELLED")
      return
    }
    const passed = outcomes.length > 0 && outcomes.every((outcome) => outcome.status === "PASS")
    if (stage === "TEST") await this.#completeTest(outcomes, passed)
    else await this.#completeVerify(outcomes, passed)
  }

  async #completeTest(outcomes: readonly CheckOutcome[], passed: boolean): Promise<void> {
    const test = {
      attempted: true,
      commands: outcomes.map((outcome) => outcome.command),
      passed,
      outcomes,
      failureFingerprints: outcomes.filter((outcome) => outcome.status !== "PASS").map((outcome) => outcome.fingerprint),
    }
    this.#state = { ...this.#state, test }
    await this.#finishRecord(passed ? "PASSED" : "FAILED", { outcome: passed ? "PASS" : outcomes.map((outcome) => outcome.status).join(",") })
    if (passed) {
      await this.#transition("REVIEW", "TEST")
      return
    }
    if (this.#state.retryCounts.testRepairs >= this.#policy.maxTestRepairs) {
      await this.#block("TEST_REPAIR_LIMIT", `tests still failing after ${this.#state.retryCounts.testRepairs} repair pass(es)`)
      return
    }
    await this.#startRepair("TEST", "testRepairs", testRepairReason(test))
  }

  async #completeVerify(outcomes: readonly CheckOutcome[], passed: boolean): Promise<void> {
    const changes = this.#state.implementation?.changedFiles ?? []
    const diverged = await this.#divergedFiles()
    const diffIntegrity = changes.length === 0 ? "NO_CHANGES" : diverged.length > 0 ? "DIVERGED" : "INTACT"
    const verdict = passed && diffIntegrity === "INTACT" ? "READY" : "NOT_READY"
    this.#state = {
      ...this.#state,
      verification: {
        verdict,
        outcomes,
        diffIntegrity,
        divergedFiles: diverged,
        ...(verdict === "NOT_READY" ? { reason: !passed ? "a verification check failed" : "workspace diverged from the reviewed diff" } : {}),
      },
    }
    await this.#finishRecord(verdict === "READY" ? "PASSED" : "FAILED", { outcome: verdict })
    if (verdict === "READY") {
      await this.#transition("COMPLETE", "VERIFY")
      return
    }
    // VERIFY never mutates: a NOT_READY verdict ends the workflow for the user to decide.
    await this.#block("VERIFY_NOT_READY", this.#state.verification!.reason!)
  }

  /** Bounded repair: the transition guard checks the limit before the counter is spent. */
  async #startRepair(from: "TEST" | "REVIEW", counter: "testRepairs" | "reviewRepairs", reason: string): Promise<void> {
    this.#state = { ...this.#state, repairReason: reason }
    assertTransition(this.#state, "IMPLEMENT", this.#policy)
    this.#state = { ...this.#state, retryCounts: { ...this.#state.retryCounts, [counter]: this.#state.retryCounts[counter] + 1 } }
    await this.#transition("IMPLEMENT", from, { guarded: true })
  }

  // ---- change tracking ----------------------------------------------------------------------------

  /** The implementation pass now running: 1 for the initial pass, 2+ for repairs. */
  #currentPass(): number {
    return (this.#state.implementation?.passes ?? 0) + 1
  }

  #mutationApplied(result: AgentResult, callId: string): boolean {
    return result.events.some((event) => event.type === "mutation.applied" && (event.payload as { callId?: string } | undefined)?.callId === callId)
  }

  #recordChange(confirmation: AgentConfirmationRequest): void {
    const change = changedFileFromMutation(confirmation.preparedMutation!, this.#currentPass())
    const current = this.#state.implementation ?? { changedFiles: [], passes: 0, summary: "" }
    this.#state = { ...this.#state, implementation: { ...current, changedFiles: [...current.changedFiles, change] } }
  }

  async #readWorkspaceFile(path: string): Promise<string | undefined> {
    try {
      const resolved = await resolveRepositoryPath(this.#deps.workspaceRoot, path, "file")
      const content = await readFile(resolved, "utf8")
      return content
    } catch {
      return undefined
    }
  }

  async #readChangedFiles(): Promise<Map<string, string>> {
    const contents = new Map<string, string>()
    for (const path of uniquePaths(this.#state.implementation?.changedFiles ?? [])) {
      const content = await this.#readWorkspaceFile(path)
      if (content !== undefined) contents.set(path, content.slice(0, ARTIFACT_LIMITS.groundingFileBytes))
    }
    return contents
  }

  /** Files whose current content no longer matches the last reviewed change (diff integrity). */
  async #divergedFiles(): Promise<string[]> {
    const latest = new Map<string, string>()
    for (const change of this.#state.implementation?.changedFiles ?? []) latest.set(change.path, change.afterHash)
    const diverged: string[] = []
    for (const [path, afterHash] of latest) {
      const content = await this.#readWorkspaceFile(path)
      if (content === undefined || sha256(content) !== afterHash) diverged.push(path)
    }
    return diverged
  }

  // ---- state transitions --------------------------------------------------------------------------

  async #transition(to: EngineeringStage, from: WorkStage, options: { guarded?: boolean } = {}): Promise<void> {
    if (!options.guarded) assertTransition(this.#state, to, this.#policy)
    const completedStages = this.#state.completedStages.includes(from) ? this.#state.completedStages : [...this.#state.completedStages, from]
    this.#state = {
      ...this.#state,
      currentStage: to,
      completedStages,
      status: to === "COMPLETE" ? "COMPLETE" : "RUNNING",
      updatedAt: this.#clock(),
    }
    await this.#persist()
    this.#emitStage()
  }

  async #retryOrBlock(stage: WorkStage, counter: "plan" | "implement" | "review", blocker: WorkflowBlocker): Promise<void> {
    const used = this.#state.retryCounts[counter]
    if (used < this.#policy.maxStageRetries) {
      this.#state = { ...this.#state, retryCounts: { ...this.#state.retryCounts, [counter]: used + 1 }, updatedAt: this.#clock() }
      await this.#persist()
      return
    }
    await this.#block(blocker, `${stage} failed after ${used + 1} attempt(s)`)
  }

  async #block(blocker: WorkflowBlocker, detail: string): Promise<void> {
    this.#state = { ...this.#state, blocker, blockerDetail: boundText(detail) }
    await this.#terminate("BLOCKED")
  }

  async #blockAndStop(blocker: WorkflowBlocker, detail: string): Promise<WorkflowResult> {
    this.#active = undefined
    const open = this.#state.stages.at(-1)
    if (open && !open.endedAt) await this.#finishRecord("BLOCKED", { outcome: blocker })
    await this.#block(blocker, detail)
    return this.#result()
  }

  async #terminate(stage: "BLOCKED" | "CANCELLED"): Promise<void> {
    this.#active = undefined
    this.#pendingVerification = undefined
    const open = this.#state.stages.at(-1)
    if (open && !open.endedAt) await this.#finishRecord(stage === "CANCELLED" ? "CANCELLED" : "BLOCKED", { outcome: stage })
    const { pending: _pending, ...rest } = this.#state
    this.#state = { ...rest, currentStage: stage, status: stage, updatedAt: this.#clock() }
    await this.#persist()
    this.#emitStage()
  }

  #setPending(pending: WorkflowState["pending"]): void {
    const { pending: _old, ...rest } = this.#state
    this.#state = pending
      ? { ...rest, pending, status: "WAITING_FOR_CONFIRMATION", updatedAt: this.#clock() }
      : { ...rest, status: TERMINAL_STAGES.has(rest.currentStage) ? rest.status : "RUNNING", updatedAt: this.#clock() }
  }

  #aborted(): boolean {
    return this.#abort.signal.aborted
  }

  // ---- evidence -----------------------------------------------------------------------------------

  #beginRecord(stage: WorkStage, attempt: number, mode: AgentMode): void {
    const record: StageRecord = {
      stage,
      attempt,
      startedAt: this.#clock(),
      status: "RUNNING",
      mode,
      modelCalls: 0,
      contextTokens: 0,
      toolsUsed: [],
      skillInjection: "NOT_APPLICABLE",
      skillInjected: false,
    }
    this.#state = { ...this.#state, stages: [...this.#state.stages, record] }
    this.#emitStage(attempt)
  }

  #patchRecord(patch: Partial<StageRecord>): void {
    const stages = [...this.#state.stages]
    const last = stages.at(-1)
    if (!last) return
    stages[stages.length - 1] = { ...last, ...patch }
    this.#state = { ...this.#state, stages }
  }

  #updateRecordFromRunner(active: ActiveModelStage, result: AgentResult): void {
    const evidence = active.tracker.evidence
    const injected = evidence.injectedSkills.length > 0
    this.#patchRecord({
      modelCalls: result.turns,
      contextTokens: result.contextDiagnostics.reduce((peak, diagnostic) => Math.max(peak, diagnostic.totalEstimatedTokens), 0),
      toolsUsed: [...new Set(result.toolCalls.map((call) => call.name))].toSorted(),
      ...(evidence.selectedSkill ? { selectedSkill: evidence.selectedSkill } : {}),
      skillInjection: evidence.injectionStatus,
      skillInjected: injected,
    })
    if (injected) {
      const ids = new Set([...this.#state.selectedSkillIds, ...evidence.injectedSkills])
      this.#state = { ...this.#state, selectedSkillIds: [...ids] }
    }
  }

  async #finishRecord(status: StageRecord["status"], patch: Partial<StageRecord> = {}): Promise<void> {
    this.#patchRecord({ ...patch, status, endedAt: this.#clock() })
  }

  #emitStage(attempt?: number): void {
    const last = this.#state.stages.at(-1)
    this.#deps.onStage?.({
      workflowId: this.#state.workflowId,
      stage: this.#state.currentStage,
      status: this.#state.status,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(last?.skillInjected && last.selectedSkill ? { skill: last.selectedSkill } : {}),
    })
  }

  async #persist(): Promise<void> {
    this.#state = { ...this.#state, updatedAt: this.#clock() }
    await this.#deps.store?.save(this.#state)
  }

  #result(): WorkflowResult {
    let confirmation: WorkflowConfirmation | undefined
    const pending = this.#state.pending
    if (pending?.kind === "RUNNER" && this.#active?.confirmation) {
      confirmation = { stage: pending.stage, runner: this.#active.confirmation }
    } else if (pending?.kind === "VERIFICATION") {
      confirmation = { stage: pending.stage, verification: { actions: pending.actions, commands: pending.commands } }
    }
    return { status: this.#state.status, state: this.#state, ...(confirmation ? { confirmation } : {}) }
  }
}

