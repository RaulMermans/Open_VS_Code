import { AgentRunner, AgentRunnerInput } from "./runner.ts"
import { FailureClassification, classifyFailure } from "./failure-classification.ts"
import { mapFailureToInvestigation } from "./repair-mapping.ts"
import { RepairBudget, BoundedRepairLifecycle, RepairDecision, RepairAttemptRecord, RepairResult, RepairStatus } from "./repair-contracts.ts"
import type { PreparedVerification, VerificationResult } from "../tools/verification-contracts.ts"
import type { AgentResult } from "../contracts/agent.ts"
import { VerificationEngine } from "../tools/verification-engine.ts"

type WorkflowState = 
  | { type: "INITIAL" }
  | { type: "RUNNING_VERIFICATION", prepared: PreparedVerification }
  | { type: "AWAITING_VERIFICATION_APPROVAL", prepared: PreparedVerification }
  | { type: "INVESTIGATING", failure: FailureClassification }
  | { type: "AWAITING_MUTATION_APPROVAL" }
  | { type: "TERMINATED", result: RepairResult }

export class RepairOrchestrator implements BoundedRepairLifecycle {
  #state: WorkflowState = { type: "INITIAL" }
  #input!: AgentRunnerInput
  #runner: AgentRunner | null = null
  #lastAgentResult: AgentResult | null = null
  
  #attempts = 0
  #mutationsPrepared = 0
  #mutationsApplied = 0
  #verificationRuns = 0
  #totalTurns = 0
  #totalTurnsBeforeCurrentRunner = 0
  #changedFiles = new Set<string>()
  #events: any[] = []
  #history: RepairAttemptRecord[] = []
  #fingerprints = new Set<string>()

  constructor(
    private readonly budget: RepairBudget,
    private readonly engine: VerificationEngine,
    private readonly createRunner: () => AgentRunner
  ) {}

  async run(
    originalInput: AgentRunnerInput,
    preparedVerification: PreparedVerification
  ): Promise<RepairResult> {
    this.#input = originalInput
    this.#emitEvent("repair.started", { task: originalInput.task.id })
    
    this.#state = { type: "AWAITING_VERIFICATION_APPROVAL", prepared: preparedVerification }
    this.#emitEvent("repair.verification_prepared", preparedVerification)
    
    return this.#buildResult("AWAITING_VERIFICATION_APPROVAL", preparedVerification)
  }

  async resume(decision: RepairDecision): Promise<RepairResult> {
    if (this.#state.type === "AWAITING_VERIFICATION_APPROVAL") {
      if (decision === "REJECT") {
        this.#emitEvent("repair.verification_rejected", {})
        return this.#terminate("REJECTED_BY_USER", "Verification rejected")
      }
      this.#emitEvent("repair.verification_approved", {})
      const prepared = this.#state.prepared
      return this.#executeVerification(prepared)
    }
    
    if (this.#state.type === "AWAITING_MUTATION_APPROVAL") {
      if (decision === "REJECT") {
        this.#emitEvent("repair.mutation_rejected", {})
        return this.#terminate("REJECTED_BY_USER", "Mutation rejected")
      }
      this.#emitEvent("repair.mutation_approved", {})
      return this.#resumeRunner(decision)
    }
    
    throw new Error("Invalid state for resume")
  }

  async #executeVerification(prepared: PreparedVerification): Promise<RepairResult> {
    if (this.#verificationRuns >= this.budget.maxVerificationRuns) {
      this.#emitEvent("repair.budget_exhausted", { reason: "VERIFICATION_BUDGET_EXCEEDED" })
      return this.#terminate("VERIFICATION_BUDGET_EXCEEDED")
    }
    
    this.#emitEvent("repair.verification_started", { verificationId: prepared.verificationId })
    
    const result = await this.engine.execute(prepared, this.#input.signal)
    
    if (result.status !== "STALE_VERIFICATION" && result.status !== "EXECUTION_ERROR" && result.status !== "CANCELLED") {
      this.#verificationRuns++
    }
    
    this.#emitEvent("repair.verification_completed", result)
    
    if (result.status === "PASS") {
      return this.#terminate("COMPLETED", undefined, result)
    }
    
    if (result.status === "TIMEOUT") {
      return this.#terminate("TIMEOUT", "Verification timed out", result)
    }
    
    if (result.status === "EXECUTION_ERROR" || result.status === "CANCELLED" || result.status === "STALE_VERIFICATION") {
      return this.#terminate(result.status as any, result.stderr || "Verification failed to execute", result)
    }
    
    const failure = classifyFailure(prepared.action, result)
    
    const fingerprint = `${failure.category}:${failure.details}`
    if (this.#fingerprints.has(fingerprint)) {
      this.#emitEvent("repair.non_progress", { fingerprint })
      return this.#terminate("REPAIR_NON_PROGRESS", "Repeated failure signature", result)
    }
    this.#fingerprints.add(fingerprint)
    
    this.#state = { type: "INVESTIGATING", failure }
    return this.#startInvestigation(failure, result)
  }

  async #startInvestigation(failure: FailureClassification, verifResult: VerificationResult): Promise<RepairResult> {
    if (this.#attempts >= this.budget.maxRepairAttempts) {
      this.#emitEvent("repair.budget_exhausted", { reason: "REPAIR_ATTEMPTS_EXCEEDED" })
      return this.#terminate("REPAIR_ATTEMPTS_EXCEEDED", undefined, verifResult)
    }
    
    if (this.#totalTurns >= this.budget.maxTotalAgentTurns) {
      this.#emitEvent("repair.budget_exhausted", { reason: "AGENT_TURN_BUDGET_EXCEEDED" })
      return this.#terminate("AGENT_TURN_BUDGET_EXCEEDED", undefined, verifResult)
    }

    this.#attempts++
    this.#totalTurnsBeforeCurrentRunner = this.#totalTurns
    this.#emitEvent("repair.investigation_started", { attempt: this.#attempts })
    
    const prompt = mapFailureToInvestigation(failure)
    this.#runner = this.createRunner()
    
    const repairInput: AgentRunnerInput = {
      ...this.#input,
      maxTurns: Math.min(this.budget.maxTotalAgentTurns - this.#totalTurns, 10),
      task: {
        ...this.#input.task,
        id: `${this.#input.task.id}-repair-${this.#attempts}`,
        instruction: `[REPAIR ATTEMPT ${this.#attempts}/${this.budget.maxRepairAttempts}]\n${prompt.instruction}`
      },
      projectInstructions: [
        {
          id: `repair-instruction-${this.#attempts}`,
          path: "repair-instruction.md",
          content: prompt.systemPrompt
        },
        ...(this.#input.projectInstructions || [])
      ]
    }
    
    const result = await this.#runner.run(repairInput)
    return this.#handleRunnerResult(result)
  }

  async #resumeRunner(decision: RepairDecision): Promise<RepairResult> {
    if (!this.#runner) throw new Error("No active runner")
    
    const pendingMut = this.#lastAgentResult?.confirmation?.preparedMutation
    const callId = this.#lastAgentResult?.confirmation?.callId
    
    const result = await this.#runner.resume(decision)
    
    if (decision === "APPROVE" && this.#lastAgentResult?.confirmation?.action === "write_file" && pendingMut && callId) {
       const callRecord = result.toolCalls.find(c => c.id === callId)
       if (callRecord && callRecord.outcome === "COMPLETED") {
         this.#mutationsApplied++
         this.#emitEvent("repair.mutation_applied", {
           preparedMutationId: pendingMut.id,
           path: pendingMut.path,
           operation: pendingMut.operation,
           resultingHash: pendingMut.afterHash
         })
         this.#changedFiles.add(pendingMut.path)
       }
    }
    
    return this.#handleRunnerResult(result)
  }

  async #handleRunnerResult(result: AgentResult): Promise<RepairResult> {
    this.#totalTurns = this.#totalTurnsBeforeCurrentRunner + result.turns
    this.#lastAgentResult = result
    
    if (result.status === "PAUSED") {
      if (result.confirmation?.action === "write_file") {
        this.#mutationsPrepared++
        if (this.#mutationsPrepared > this.budget.maxMutations) {
           this.#emitEvent("repair.budget_exhausted", { reason: "MUTATION_BUDGET_EXCEEDED" })
           return this.#terminate("MUTATION_BUDGET_EXCEEDED")
        }
        this.#state = { type: "AWAITING_MUTATION_APPROVAL" }
        this.#emitEvent("repair.mutation_prepared", result.confirmation.preparedMutation)
        return this.#buildResult("AWAITING_MUTATION_APPROVAL", result.confirmation.preparedMutation)
      } else if (result.confirmation?.action === "run_known_test") {
        const preparedVerif = result.confirmation.preparedMutation as unknown as PreparedVerification
        this.#state = { type: "AWAITING_VERIFICATION_APPROVAL", prepared: preparedVerif }
        this.#emitEvent("repair.verification_prepared", preparedVerif)
        return this.#buildResult("AWAITING_VERIFICATION_APPROVAL", preparedVerif)
      } else {
        this.#emitEvent("repair.unsupported_tool", { action: result.confirmation?.action })
        return this.#resumeRunner("REJECT")
      }
    }
    
    if (result.status === "FAILED") {
       if (result.failureReason === "MAX_TURNS_EXCEEDED") {
         return this.#terminate("AGENT_TURN_BUDGET_EXCEEDED", "Agent turn budget exceeded")
       }
       const stale = result.events.some(e => 
          e.type === "mutation.failed" && 
          ((e.payload as any)?.error?.code === "STALE_BASE" || (e.payload as any)?.message?.includes("STALE_BASE"))
       )
       if (stale) return this.#terminate("STALE_BASE", "Stale mutation base")
       return this.#terminate("FAILED", result.failureReason)
    }
    
    if (result.status === "CANCELLED") {
       return this.#terminate("CANCELLED", "Agent runner cancelled")
    }
    
    return this.#terminate("FAILED", "Agent completed without verifying fix")
  }

  #emitEvent(type: string, payload: any) {
    this.#events.push({ type, timestamp: Date.now(), ...payload })
  }

  #terminate(status: any, reason?: string, verif?: VerificationResult): RepairResult {
    this.#state = { type: "TERMINATED", result: this.#buildResult(status, undefined, reason, verif) }
    this.#emitEvent(status === "COMPLETED" ? "repair.completed" : "repair.failed", { reason })
    return (this.#state as any).result
  }

  #buildResult(status: any, pendingReview?: any, failureReason?: string, verif?: VerificationResult): RepairResult {
    const res: RepairResult = {
      status,
      task: this.#input?.task.id || "unknown",
      repairAttempts: this.#attempts,
      mutationsPrepared: this.#mutationsPrepared,
      mutationsApplied: this.#mutationsApplied,
      verificationRuns: this.#verificationRuns,
      totalAgentTurns: this.#totalTurns,
      changedFiles: Array.from(this.#changedFiles),
      events: [...this.#events],
    }
    if (verif !== undefined) {
      (res as any).finalVerification = verif
    }
    if (failureReason !== undefined) {
      (res as any).failureReason = failureReason
    }
    if (pendingReview !== undefined) {
      (res as any).pendingReview = pendingReview
    }
    return res
  }
}
