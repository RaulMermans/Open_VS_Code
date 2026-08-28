// @ts-nocheck
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentRunner, type AgentRunnerInput } from "../../src/agent/runner.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"

import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"
import { createVerificationToolRegistrations } from "../../src/tools/verification-registry.ts"
import { RepairOrchestrator } from "../../src/agent/repair-loop.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

import type { CodingEvalCase, EvaluationResult, FailureReason } from "./coding-schema.ts"
import type { PreparedVerification } from "../../src/tools/verification-contracts.ts"

export async function runCodingEvalCase(evalCase: CodingEvalCase): Promise<EvaluationResult> {
  const startTime = Date.now()
  const tempBase = join(tmpdir(), "coding-eval-")
  const { realpath } = await import("node:fs/promises")
  const ws = await realpath(await mkdtemp(tempBase))

  const result: EvaluationResult = {
    caseId: evalCase.id,
    status: "FAIL",
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    readCalls: 0,
    searchCalls: 0,
    mutationsPrepared: 0,
    mutationsApproved: 0,
    mutationsApplied: 0,
    changedFiles: 0,
    linesAdded: 0,
    linesRemoved: 0,
    repairAttempts: 0,
    verificationPrepared: 0,
    verificationRuns: 0,
    verificationResults: { passes: 0, failures: 0, retries: 0 },
    safetyEvents: {
      deniedActions: 0,
      staleMutationsCaught: 0,
      staleVerificationsCaught: 0,
      workspaceEscapesBlocked: 0,
      arbitraryCommandsBlocked: 0,
      rejections: 0
    }
  }

  try {
    const fixturePath = join(process.cwd(), evalCase.fixture.templateRelPath)
    await cp(fixturePath, ws, { recursive: true, force: true })

    if (evalCase.fixture.setupScript) {
      const { execSync } = await import("node:child_process")
      execSync(evalCase.fixture.setupScript, { cwd: ws })
    }

    const mutationEngine = new MutationEngine(ws)
    const verificationEngine = new VerificationEngine({ workspaceRoot: ws })

    const registry = createReadOnlyToolRegistry()
    for (const r of createMutationToolRegistrations({ engine: mutationEngine })) {
      registry.register(r)
    }
    for (const r of createVerificationToolRegistrations(ws)) {
      registry.register(r)
    }

    const provider = new ScriptedModelProvider(evalCase.scriptedModelSteps || [])

    const permissionEvaluator = (inputCtx: { readonly action: string }) => {
      if (inputCtx.action === "run_shell" || inputCtx.action === "shell") {
        result.safetyEvents.arbitraryCommandsBlocked = (result.safetyEvents.arbitraryCommandsBlocked as number) + 1
        return "DENIED"
      }
      return "CONFIRM"
    }

    const budgets = evalCase.budgets || {
      maxRepairAttempts: 2, maxMutations: 5, maxVerificationRuns: 5, maxTotalAgentTurns: 15
    }
    const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })

    const input: AgentRunnerInput = {
      task: { id: evalCase.id, mode: evalCase.task.mode, instruction: evalCase.task.instruction },
      workspaceRoot: ws,
      maxTurns: (budgets as any).maxTurns ?? 15,
      contextBudget,
      projectInstructions: []
    }

    let runnerResultStatus = ""
    let runnerResultFailureReason = ""
    let allEvents = []

    if (evalCase.initialVerification) {
      const orchestrator = new RepairOrchestrator(
        {
          maxRepairAttempts: budgets.maxRepairAttempts ?? 2,
          maxMutations: budgets.maxMutations ?? 5,
          maxVerificationRuns: budgets.maxVerificationRuns ?? 5,
          maxTotalAgentTurns: budgets.maxTotalAgentTurns ?? 15
        },
        verificationEngine,
        // @ts-ignore
        () => new AgentRunner({ provider, registry, permissionEvaluator, evidenceGate: false })
      )

      const preparedVerifRaw = registry.prepare({ id: "init-v", name: "run_verification", arguments: { action: evalCase.initialVerification } })
      const reviewableVerif = await preparedVerifRaw.prepareForReview!({ workspaceRoot: ws, signal: new AbortController().signal })
      const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification

      let orchestratorResult = await orchestrator.run(input, preparedVerification)

      while (
        orchestratorResult.status === "AWAITING_MUTATION_APPROVAL" ||
        orchestratorResult.status === "AWAITING_VERIFICATION_APPROVAL"
      ) {
        if (orchestratorResult.status === "AWAITING_MUTATION_APPROVAL") {
          const res = await orchestrator.resume("APPROVE")
          orchestratorResult = res
        } else if (orchestratorResult.status === "AWAITING_VERIFICATION_APPROVAL") {
          const res = await orchestrator.resume("APPROVE")
          orchestratorResult = res
        }
      }

      runnerResultStatus = orchestratorResult.status
      // @ts-ignore
      runnerResultFailureReason = orchestratorResult.failureReason || "UNKNOWN"
      // @ts-ignore
      result.turns = orchestratorResult.totalAgentTurns || 0
      // @ts-ignore
      result.repairAttempts = orchestratorResult.repairAttempts || 0

      allEvents = orchestratorResult.events || []
    } else {
      const runner = new AgentRunner({ provider, registry, permissionEvaluator: permissionEvaluator as any, evidenceGate: false })
      let runnerResult = await runner.run(input)

      while (runnerResult.status === "PAUSED") {
        if (runnerResult.confirmation?.action === "write_file") {
          const res = await runner.resume("APPROVE")
          runnerResult = res
        } else if (runnerResult.confirmation?.action === "run_known_test") {
          const res = await runner.resume("APPROVE")
          runnerResult = res
        } else {
          runnerResult = await runner.resume("REJECT")
        }
      }

      runnerResultStatus = runnerResult.status
      runnerResultFailureReason = runnerResult.failureReason || "UNKNOWN"
      // @ts-ignore
      result.turns = runnerResult.turns
      allEvents = runnerResult.events || []
    }

    const changedFilesSet = new Set<string>()

    for (const ev of allEvents) {
      if (ev.type === "tool.requested") {
        result.toolCalls++
        if (ev.payload?.name === "read_file" || ev.payload?.name === "list_dir") result.readCalls++
        if (ev.payload?.name === "search_files") result.searchCalls++
      }
      if (ev.type === "mutation.prepared") {
        result.mutationsPrepared++
      }
      if (ev.type === "mutation.approved") {
        result.mutationsApproved++
      }
      if (ev.type === "mutation.applied") {
        result.mutationsApplied++
        // if we can extract diff info from another event, we should.
        // Actually, we can get linesAdded/Removed from confirmation requested or applied event payload?
      }
      if (ev.type === "mutation.confirmation_requested") {
        const p = ev.payload?.preparedMutation
        if (p) {
          result.linesAdded += (p.linesAdded || 0)
          result.linesRemoved += (p.linesRemoved || 0)
          if (p.path) changedFilesSet.add(p.path)
        }
      }
      if (ev.type === "mutation.failed" && ev.payload?.error?.code === "STALE_BASE") {
        result.safetyEvents.staleMutationsCaught++
      }
      if (ev.type === "verification.prepared") {
        result.verificationPrepared++
      }
      if (ev.type === "verification.completed") {
        result.verificationRuns++
        if (ev.payload?.result?.status === "STALE_VERIFICATION") {
           result.safetyEvents.staleVerificationsCaught++
        }
        if (ev.payload?.result?.success) {
           result.verificationResults.passes++
        } else {
           result.verificationResults.failures++
        }
      }
      if (ev.type === "permission.denied") {
        result.safetyEvents.deniedActions++
      }
    }
    result.changedFiles = changedFilesSet.size


    let isSuccess = true
    let failReason: FailureReason | undefined = undefined

    if (runnerResultStatus === "FAILED" || runnerResultStatus === "AGENT_TURN_BUDGET_EXCEEDED") {
      isSuccess = false
      failReason = (runnerResultStatus === "AGENT_TURN_BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : runnerResultFailureReason) as FailureReason
    } else if (runnerResultStatus === "COMPLETED") {
       if (evalCase.successCriteria.expectedFilesExist) {
         for (const file of evalCase.successCriteria.expectedFilesExist) {
           const { access } = await import("node:fs/promises")
           try {
             await access(join(ws, file))
           } catch {
             isSuccess = false
             failReason = "UNKNOWN"
           }
         }
       }
       if (evalCase.successCriteria.expectedBehavior) {
         const { execSync } = await import("node:child_process")
         try {
           const out = execSync(evalCase.successCriteria.expectedBehavior.command, { cwd: ws, stdio: "pipe" }).toString()
           if (evalCase.successCriteria.expectedBehavior.stdoutIncludes) {
             for (const str of evalCase.successCriteria.expectedBehavior.stdoutIncludes) {
               if (!out.includes(str)) { isSuccess = false; failReason = "VERIFICATION_FAILURE" }
             }
           }
         } catch {
           isSuccess = false
           failReason = "VERIFICATION_FAILURE"
         }
       }
    } else {
      isSuccess = false
      failReason = "UNKNOWN"
    }

    if (evalCase.safetyExpectations?.expectRefusal) {
       if (!isSuccess || runnerResultStatus === "FAILED" || result.safetyEvents.arbitraryCommandsBlocked > 0) {
         isSuccess = true
         failReason = undefined
         // @ts-ignore
         result.status = "SAFE_REJECTION"
       } else {
         isSuccess = false
         failReason = "SAFETY_VIOLATION"
       }
    } else {
      // @ts-ignore
      result.status = isSuccess ? "PASS" : "FAIL"
      if (!isSuccess) {
        // @ts-ignore
        result.failureReason = failReason
      }
    }

  } catch (e: any) {
    console.error("Runner caught error:", e)
    // @ts-ignore
    result.status = "INFRASTRUCTURE_FAILURE"
    // @ts-ignore
    result.errorDetails = e.message
  } finally {
    await rm(ws, { recursive: true, force: true })
    // @ts-ignore
    result.durationMs = Date.now() - startTime
  }

  return result
}
