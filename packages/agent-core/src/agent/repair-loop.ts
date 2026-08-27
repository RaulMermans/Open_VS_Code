import { AgentRunner } from "./runner.ts"
import { FailureClassification, classifyFailure } from "./failure-classification.ts"
import { mapFailureToInvestigation } from "./repair-mapping.ts"
import { RepairBudget, BoundedRepairLifecycle, RepairDecision, RepairAttemptRecord } from "./repair-contracts.ts"
import type { PreparedVerification, VerificationResult } from "../tools/verification-contracts.ts"
import type { AgentResult } from "../contracts/agent.ts"
import { VerificationEngine } from "../tools/verification-engine.ts"

export class RepairOrchestrator implements BoundedRepairLifecycle {
  constructor(
    private readonly budget: RepairBudget,
    private readonly engine: VerificationEngine,
    private readonly createRunner: () => AgentRunner
  ) {}

  async executeRepairLoop(
    originalInput: any,
    preparedVerification: PreparedVerification,
    verificationId: string,
    onMutationReady: (mutationPayload: unknown) => Promise<RepairDecision>
  ): Promise<AgentResult> {
    
    let attempts = 0
    const history: RepairAttemptRecord[] = []
    
    let lastResult: AgentResult | null = null

    while (attempts < this.budget.maxAttempts) {
      attempts++
      
      const verificationResult = await this.engine.execute(
        preparedVerification,
        `${verificationId}-${attempts}`,
        originalInput.signal
      )
      
      if (verificationResult.status === "PASS") {
        if (lastResult) return lastResult
        break // If it passed on attempt 1, we exit
      }
      
      const failure = classifyFailure(preparedVerification.action, verificationResult)
      const investigationPrompt = mapFailureToInvestigation(failure)

      const repairRunner = this.createRunner()
      const repairInput: any = {
        ...originalInput,
        maxTurns: this.budget.maxTurnsPerAttempt,
        task: {
          ...originalInput.task,
          id: `${originalInput.task.id}-repair-${attempts}`,
          instruction: `[REPAIR ATTEMPT ${attempts}/${this.budget.maxAttempts}]\n${investigationPrompt.instruction}`
        },
        projectInstructions: [
          investigationPrompt.systemPrompt,
          ...(originalInput.projectInstructions || [])
        ]
      }
      
      let mutationApplied = false
      lastResult = await repairRunner.run(repairInput)
      
      while (true) {
        if (lastResult.status === "PAUSED" && lastResult.confirmation?.action === "write_file") {
          // Simplification for prototype: Any write_file is treated as the mutation
          const decision = await onMutationReady(lastResult.confirmation.arguments)
          
          if (decision === "APPROVE") {
            lastResult = await repairRunner.resume("APPROVE")
            mutationApplied = true
            break
          } else if (decision === "REJECT") {
            lastResult = await repairRunner.resume("REJECT")
          } else {
            return lastResult
          }
        } else if (lastResult.status === "PAUSED") {
           // Other confirmations (like terminal_command) just get approved for now, or we can reject
           lastResult = await repairRunner.resume("APPROVE")
        } else {
          break
        }
      }
      
      history.push({
        attemptNumber: attempts,
        failure,
        result: lastResult,
        mutationApplied
      })
      
      if (!mutationApplied) {
        break
      }
    }
    
    // We return the last agent result, or throw an error if no attempts were run.
    return lastResult!
  }
}

