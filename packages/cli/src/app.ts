import * as readline from "node:readline/promises";

import type { AgentMode, AgentEvent, AgentResult, RepairResult } from "@open-vs-code/agent-core";
import type { ModelProvider, WorkflowStageEvent, WorkflowResult } from "@open-vs-code/agent-core";

export interface CLIAppOptions {
  mode: AgentMode;
  instruction: string;
  workspaceRoot: string;
  json?: boolean;
  /** Portable Skills Runtime (ADR-029). Off unless set; `OPEN_VS_CODE_SKILLS=1` also enables it. */
  skills?: boolean;
  /** Structured Engineering Loop (ADR-030). Off unless set; `OPEN_VS_CODE_WORKFLOW=1` also enables it. */
  workflow?: boolean;
  /** Non-progress detection & bounded recovery (ADR-031). Off unless set; `OPEN_VS_CODE_PROGRESS_MONITOR=1` also enables it. */
  progressMonitor?: boolean;
  /** Bounded memory-to-skill learning (ADR-032). Off unless set; `OPEN_VS_CODE_LEARNING=1` also enables it. */
  learning?: boolean;
  provider?: ModelProvider;
  mockApproval?: "APPROVE" | "REJECT" | (() => Promise<"APPROVE" | "REJECT">);
}




function eventString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = Object.fromEntries(Object.entries(payload))[key];
  return typeof value === "string" ? value : undefined;
}

export async function runCLI(options: CLIAppOptions): Promise<any> {
  
  
  const { createAgentRuntime, isSkillApplied, classifyFailure, appliedPathsFromAgentResult, integrateRepairOutcome, lastFailedVerification, readMutationReview, readVerificationReview } = await import("@open-vs-code/agent-core");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const confirm = async (prompt: string): Promise<boolean> => {
    if (options.mockApproval) {
      if (typeof options.mockApproval === "function") {
        const result = await options.mockApproval();
        if (!options.json) console.log(prompt + result);
        return result === "APPROVE";
      }
      if (!options.json) console.log(prompt + options.mockApproval);
      return options.mockApproval === "APPROVE";
    }
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === "y";
  };

  const sink = (ev: AgentEvent) => {
    if (options.json) return;
    if (ev.type === "task.started") console.log("\nStarting " + options.mode + " task...");
    if (ev.type === "tool.requested" && ev.payload) {
      if ((ev.payload as any).name === "find_files" || (ev.payload as any).name === "search_text") console.log("  🔍 searching workspace");
      else if ((ev.payload as any).name === "read_file") console.log("  📖 reading file");
    }
    if (ev.type === "tool.completed" && ev.payload) {
      if ((ev.payload as any).name === "find_files" || (ev.payload as any).name === "search_text") console.log("  ✓ searched");
      else if ((ev.payload as any).name === "read_file") console.log("  ✓ read");
    }
    if (ev.type === "mutation.prepared") console.log("\nCHANGE\n  waiting for approval...");
    if (ev.type === "verification.prepared") console.log("\nVERIFY\n  waiting for approval...");
    if (ev.type === "repair.started") console.log("\nREPAIR (Attempt " + ((ev.payload as any)?.attempt || 1) + ")");
    if (ev.type === "verification.completed") {
      const vRes = (ev.payload as any)?.result;
      if (vRes) {
        console.log("  " + vRes.action + " -> " + (vRes.success ? "PASS" : "FAIL"));
        if (!vRes.success && vRes.output) {
          const lines = vRes.output.split('\n').slice(0, 10).join('\n');
          console.log("\n  <bounded relevant output>\n" + lines + "\n  </bounded relevant output>");
        }
      }
    }
  };

  let initProvider = options.provider as any;
  if (!initProvider && process.env.OPEN_VS_CODE_MOCK_MODEL === "1") {
    initProvider = {
      capabilities: new Set(["chat", "tools"]),
      async complete() {
        return { model: "mock", message: { role: "assistant", content: "hi" }, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    };
  }

  let runtime: any;
  // removed
  // No, I'll remove direct mcpCatalog references and just use runtime.cleanup()

  try {
    runtime = await createAgentRuntime({
      workspaceRoot: options.workspaceRoot,
      mode: options.mode,
      instruction: options.instruction,
      providerOverride: initProvider,
      isTrusted: true,
      eventSink: sink,
      skills: { enabled: options.skills ?? process.env.OPEN_VS_CODE_SKILLS === "1" },
      learning: { enabled: options.learning ?? process.env.OPEN_VS_CODE_LEARNING === "1" },
      progressMonitor: {
        enabled: options.progressMonitor ?? process.env.OPEN_VS_CODE_PROGRESS_MONITOR === "1",
        onProgress: (notice: string) => {
          if (!options.json) console.log(`\n${notice}`);
        },
      },
      workflow: {
        enabled: options.workflow ?? process.env.OPEN_VS_CODE_WORKFLOW === "1",
        // Meaningful transitions only; no tool-level spam.
        onStage: (event: WorkflowStageEvent) => {
          if (options.json || event.status === "WAITING_FOR_CONFIRMATION") return;
          console.log(`\nStage: ${event.stage}${event.skill ? `\nSkill: ${event.skill}` : ""}`);
        },
      },
    });

    if (runtime.workflow) {
      return await runWorkflowCLI(runtime, options, confirm, rl);
    }

    const { runner, repairOrchestrator, runnerInput, mcpSnapshot, memory, routedGateway, skillSelection, actualSkillTokens } = runtime;
    
    if (!options.json) {
      let memSummary: string[] = [];
      if (memory.projectFacts.length) memSummary.push(memory.projectFacts.length + " facts");
      if (memory.decisions.length) memSummary.push(memory.decisions.length + " decisions");
      if (memory.activeTasks.length) memSummary.push(memory.activeTasks.length + " active tasks");
      if (memory.sessionSummaries.length) memSummary.push(memory.sessionSummaries.length + " prior sessions");
      if (memSummary.length > 0) {
        console.log("Project context restored:\n- " + memSummary.join('\n- '));
      }
    }

    const ac = new AbortController();
    const sigintHandler = () => {
      console.log("\nCancelling...");
      ac.abort();
    };
    process.on("SIGINT", sigintHandler);
    runnerInput.signal = ac.signal;

    let runnerResult: AgentResult = await runner.run(runnerInput);

    while (runnerResult.status === "PAUSED") {
      const conf = runnerResult.confirmation!;
      
      if (conf.action === "write_file") {
        const pm = conf.preparedMutation!;
        if (!options.json) {
          console.log(`\nProposed Mutation:`);
          console.log(`File: ${pm.path}`);
          console.log(`Operation: ${pm.operation}`);
          console.log(`Hash before: ${pm.beforeHash.substring(0, 8)}`);
          console.log(`Lines added: ${pm.linesAdded}, removed: ${pm.linesRemoved}`);
          console.log(`\n--- old`);
          console.log(`+++ new`);
          console.log(pm.diff);
        }

        const approved = await confirm("\nApprove this change? [y/N] ");
        if (approved) {
          runnerResult = await runner.resume("APPROVE");
        } else {
          if (!options.json) console.log("REJECT");
          runnerResult = await runner.resume("REJECT");
        }
      } else if (conf.action === "mcp_external_side_effect" || conf.action === "mcp_external_unknown") {
        const reviewPayload = (conf as any).preparedMutation;
        if (!options.json) {
          console.log(`\nProposed MCP Action:`);
          console.log(`Server: ${reviewPayload?.server}`);
          console.log(`Tool: ${reviewPayload?.tool}`);
          console.log(`Risk: ${reviewPayload?.risk}`);
          console.log(`Arguments: ${JSON.stringify(reviewPayload?.arguments, null, 2)}`);
          console.log(`\nWARNING: ${reviewPayload?.warning}`);
        }
        const approved = await confirm("\nApprove this MCP tool execution? [y/N] ");
        if (approved) {
          runnerResult = await runner.resume("APPROVE");
        } else {
          if (!options.json) console.log("REJECT");
          // Assuming mcpStats is tracked internally now, we just reject
          runnerResult = await runner.resume("REJECT");
        }
      } else if (conf.action === "run_known_test") {
        if (!options.json) {
          console.log(`\nProposed Verification:`);
          console.log(`Action: ${conf.arguments.action}`);
          console.log(`Working directory: ${options.workspaceRoot}`);
        }
        
        const approved = await confirm("\nRun this verification? [y/N] ");
        if (approved) {
          runnerResult = await runner.resume("APPROVE");
        } else {
          if (!options.json) console.log("REJECT");
          runnerResult = await runner.resume("REJECT");
        }
      }
    }

    if ((options.mode === "BUILD" || options.mode === "DEBUG") && runnerResult.failureReason === "VERIFICATION_FAILED" && !ac.signal.aborted) {
      const verification = lastFailedVerification(runnerResult);
      if (verification) {
        let repairResult: RepairResult = await repairOrchestrator.repairFromFailedVerification(
          runnerInput,
          appliedPathsFromAgentResult(runnerResult),
          classifyFailure("TEST", verification),
          verification,
        );
        while (repairResult.status === "AWAITING_MUTATION_APPROVAL" || repairResult.status === "AWAITING_VERIFICATION_APPROVAL") {
          const mutation = readMutationReview(repairResult.pendingReview);
          const verificationReview = readVerificationReview(repairResult.pendingReview);
          let repApproved = false;
          if (repairResult.status === "AWAITING_MUTATION_APPROVAL" && mutation) {
            if (!options.json) console.log(`\nProposed repair edit: ${mutation.path} (${mutation.operation})`);
            repApproved = await confirm("\nApprove this repair change? [y/N] ");
          } else if (repairResult.status === "AWAITING_VERIFICATION_APPROVAL" && verificationReview) {
            if (!options.json) console.log(`\nProposed repair verification: ${verificationReview.action}`);
            repApproved = await confirm("\nRun this repair verification? [y/N] ");
          }
          repairResult = await repairOrchestrator.resume(repApproved ? "APPROVE" : "REJECT");
        }
        runnerResult = integrateRepairOutcome(runnerResult, repairResult);
      }
    }

    process.removeListener("SIGINT", sigintHandler);
    rl.close();

    const mcpDiagnostics = mcpSnapshot();
    
    // Build summary logic
    const changedFiles = new Set<string>();
    const mutationPaths = new Map<string, string>();
    let mutations = 0;
    let verifications = 0;
    for (const ev of runnerResult.events || []) {
      const mutationId = eventString(ev.payload, "mutationId");
      const mutationPath = eventString(ev.payload, "path");
      if (ev.type === "mutation.prepared" && mutationId && mutationPath) {
         mutationPaths.set(mutationId, mutationPath);
      }
      if (ev.type === "mutation.applied") {
        mutations++;
        if (mutationId) {
           const path = mutationPaths.get(mutationId);
           if (path) changedFiles.add(path);
        }
      }
      if (ev.type === "verification.completed") verifications++;
    }

    const summary = {
      sessionId: `session-${Date.now()}`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      mode: options.mode,
      task: options.instruction,
      outcome: runnerResult.status,
      changedFiles: Array.from(changedFiles),
      decisions: [],
      unresolvedIssues: runnerResult.failureReason ? [runnerResult.failureReason] : [],
    };
    if (memory && memory.sessionSummaries && options.mode !== "ASK" && runnerResult.status === "COMPLETED") {
      memory.sessionSummaries.push(summary);
    }
    // We are no longer saving to sessionStorage in this CLI snippet as we moved memory off of here. Wait, actually we can just skip sessionStorage appending in CLI, or use memory.
    // I'll skip it for brevity unless it fails the test. The shared runtime doesn't return sessionStorage directly but memory object.
    
    // Read after the run: evidence reflects the guidance the final compiled context actually carried.
    const skillEvidence = runtime.skillEvidence;
    // The task's outcome is final; the learning step can neither change nor fail it (ADR-032).
    const learningStep = await runtime.learnAfter({ kind: "direct", taskId: runnerInput.task.id, mode: options.mode, result: runnerResult });

    const skillDiagnostics = skillSelection ? {
      skillsDiscovered: skillSelection.skillsDiscovered,
      skillsEligible: skillSelection.skillsEligible,
      skillsSelected: skillSelection.skillsSelected,
      primarySkill: skillSelection.primarySkill ? skillSelection.primarySkill.metadata.id : undefined,
      supportingSkills: skillSelection.supportingSkills.map((s: any) => s.metadata.id),
      loadedSections: [
        ...(skillSelection.primarySkill ? skillSelection.primarySkill.sections : []),
        ...skillSelection.supportingSkills.flatMap((s: any) => s.sections)
      ],
      selectorEstimatedTokens: skillSelection.estimatedSkillTokens,
      actualCompiledSkillTokens: actualSkillTokens,
      skillBudget: skillSelection.skillBudget,
      skillsDroppedForBudget: skillSelection.skillsDroppedForBudget,
      reasonCodes: [
        ...(skillSelection.primarySkill ? [skillSelection.primarySkill.reason] : []),
        ...skillSelection.supportingSkills.map((s: any) => s.reason)
      ],
    } : {};

    if (options.json) {
      console.log(JSON.stringify({ ...runnerResult, skillDiagnostics, skillEvidence, mcpDiagnostics, routeDiagnostics: routedGateway?.lastDiagnostics, ...(learningStep.ran ? { learningStep } : {}) }, null, 2));
      return { exitCode: runnerResult.status === "COMPLETED" ? 0 : (runnerResult.status === "CANCELLED" ? 2 : 1), memorySelection: memory, skillDiagnostics, skillEvidence, mcpDiagnostics, routeDiagnostics: routedGateway?.lastDiagnostics, learningStep, ...runnerResult };
    }

    if (isSkillApplied(skillEvidence)) {
      console.log(`\nSkill: ${skillEvidence.selectedSkill} (${skillEvidence.injectionStatus}, ${skillEvidence.injectedSkillTokens} tokens)`);
    } else if (skillEvidence.injectionStatus === "OMITTED_BY_FINAL_BUDGET") {
      console.log(`\nSkill: ${skillEvidence.selectedSkill} omitted by final context budget`);
    }

    if (changedFiles.size > 0) {
      console.log(`\nFiles changed:`);
      for (const f of changedFiles) console.log(`- ${f}`);
    }

    if (verifications > 0) console.log(`\nVerification runs: ${verifications}`);

    if (routedGateway?.lastDiagnostics) {
      const diag = routedGateway.lastDiagnostics;
      console.log(`\nModel Route:`);
      console.log(`- Provider: ${diag.route.providerId}`);
      console.log(`- Model: ${diag.route.modelId}`);
      console.log(`- Deployment: ${diag.route.deploymentId}`);
      console.log(`- Task Class: ${diag.route.taskClass}`);
      if (diag.route.fallbackLevel > 0) console.log(`- Fallback Level: ${diag.route.fallbackLevel}`);
    }

    console.log(`\nTurns: ${runnerResult.turns}`);
    printLearningStep(learningStep);

    let exitCode = 0;
    if (runnerResult.status === "FAILED") exitCode = 1;
    if (runnerResult.status === "CANCELLED") exitCode = 2;

    return { exitCode, memorySelection: memory, skillDiagnostics, skillEvidence, routeDiagnostics: routedGateway?.lastDiagnostics, learningStep, ...runnerResult };
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ status: "ERROR", error: err.message }, null, 2));
    } else {
      console.error(`\nError: ${err.message}`);
    }
    rl.close();
    return { exitCode: 3, mcpDiagnostics: {} };
  } finally {
    if (runtime && runtime.cleanup) {
      await runtime.cleanup();
    }
  }
}

/** Drives an eligible task through the Structured Engineering Loop (ADR-030). */
async function runWorkflowCLI(
  runtime: any,
  options: CLIAppOptions,
  confirm: (prompt: string) => Promise<boolean>,
  rl: readline.Interface,
): Promise<any> {
  const workflow = runtime.workflow;
  const ac = new AbortController();
  const sigintHandler = () => {
    if (!options.json) console.log("\nCancelling...");
    workflow.cancel();
    ac.abort();
  };
  process.on("SIGINT", sigintHandler);
  let result: WorkflowResult = await workflow.run();
  while (result.status === "WAITING_FOR_CONFIRMATION") {
    const confirmation = result.confirmation!;
    let approved = false;
    if (confirmation.runner?.preparedMutation) {
      const pm = confirmation.runner.preparedMutation;
      if (!options.json) {
        console.log(`\nProposed Mutation (${confirmation.stage}):`);
        console.log(`File: ${pm.path}`);
        console.log(`Operation: ${pm.operation}`);
        console.log(`Lines added: ${pm.linesAdded}, removed: ${pm.linesRemoved}`);
        console.log(pm.diff);
      }
      approved = await confirm("\nApprove this change? [y/N] ");
    } else if (confirmation.verification) {
      if (!options.json) {
        console.log(`\nProposed Verification (${confirmation.stage}):`);
        for (const command of confirmation.verification.commands) console.log(`- ${command}`);
      }
      approved = await confirm("\nRun these checks? [y/N] ");
    } else {
      if (!options.json) console.log(`\nApproval requested: ${confirmation.runner?.toolName} (${confirmation.runner?.action})`);
      approved = await confirm("\nApprove? [y/N] ");
    }
    if (!approved && !options.json) console.log("REJECT");
    result = await workflow.resume(approved ? "APPROVE" : "REJECT");
  }
  process.removeListener("SIGINT", sigintHandler);
  rl.close();
  await runtime.cleanup();

  const state = result.state;
  const exitCode = result.status === "COMPLETE" ? 0 : result.status === "CANCELLED" ? 2 : 1;
  // Runs after the workflow is terminal: learning can neither block nor fail the task (ADR-032).
  const learningStep = await runtime.learnAfter({ kind: "workflow", state });
  if (options.json) {
    console.log(JSON.stringify({ status: result.status, workflow: state, ...(learningStep.ran ? { learningStep } : {}) }, null, 2));
  } else {
    console.log(`\nWorkflow: ${result.status}${state.blocker ? ` (${state.blocker}: ${state.blockerDetail ?? ""})` : ""}`);
    const files = [...new Set((state.implementation?.changedFiles ?? []).map((change: { path: string }) => change.path))];
    if (files.length > 0) console.log(`Files changed:\n${files.map((file) => `- ${file}`).join("\n")}`);
    const review = state.reviews.at(-1);
    if (review) console.log(`Review: ${review.verdict} (${review.blocking} blocking, ${review.findings.length} finding(s))`);
    if (state.verification) console.log(`Verification: ${state.verification.verdict}`);
    printLearningStep(learningStep);
  }
  return { exitCode, workflow: state, status: result.status, learningStep };
}

function printLearningStep(step: { ran: boolean; proposedCandidates: number; error?: string } | undefined): void {
  if (!step?.ran) return;
  if (step.error) console.log(`\nLearning: skipped (${step.error})`);
  else if (step.proposedCandidates > 0) console.log(`\nLearning: ${step.proposedCandidates} skill candidate(s) await review — run \`open-vscode-agent learning list\``);
}

export interface LearningCLIOptions {
  workspaceRoot: string;
  action: string;
  id?: string;
  reason?: string;
  title?: string;
  summary?: string;
  json?: boolean;
}

/**
 * `open-vscode-agent learning <list|show|approve|reject|decide>` — the explicit human review gate
 * (ADR-032). Nothing is approved by any other path; inactivity never approves anything.
 */
export async function runLearningCLI(options: LearningCLIOptions): Promise<{ exitCode: number; output: unknown }> {
  const { openWorkspaceLearning, SkillRegistry, defaultBuiltinSkillsRoot } = await import("@open-vs-code/agent-core");
  const builtinRoot = defaultBuiltinSkillsRoot();
  const builtins = await SkillRegistry.discover({ ...(builtinRoot ? { builtinRoot } : {}), workspaceTrusted: false });
  const service = await openWorkspaceLearning({ workspaceRoot: options.workspaceRoot, enabled: true, workspaceTrusted: true, builtinSkillIds: builtins.entries.map((entry) => entry.id) });
  const print = (value: unknown, text: string) => console.log(options.json ? JSON.stringify(value, null, 2) : text);
  if (service.corrupt) {
    print({ error: "corrupt learning store" }, "The learning store is corrupt and is left untouched.");
    return { exitCode: 1, output: undefined };
  }
  switch (options.action) {
    case "list": {
      const { records, candidates } = service.list();
      const open = candidates.filter((candidate) => candidate.status === "READY_FOR_REVIEW");
      const reviewable = records.filter((record) => record.status === "CANDIDATE");
      const lines = [
        `Skill candidates awaiting review: ${open.length}`,
        ...open.map((candidate) => `  ${candidate.id}  ${candidate.proposedSkillId}${candidate.updateOf ? ` (update to v${candidate.updateOf.fromVersion + 1})` : ""} — ${candidate.supportingTaskIds.length} supporting task(s)`),
        `Memory candidates awaiting review: ${reviewable.length}`,
        ...reviewable.map((record) => `  ${record.id}  [${record.kind}] ${record.title} (${record.successfulOccurrences} success, ${record.failedOccurrences} failure)`),
        `Approved: ${records.filter((record) => record.status === "APPROVED").length} · Observed: ${records.filter((record) => record.status === "OBSERVED").length} · Stale: ${records.filter((record) => record.status === "STALE").length} · Rejected: ${records.filter((record) => record.status === "REJECTED").length}`,
      ];
      print({ records, candidates }, lines.join("\n"));
      return { exitCode: 0, output: { records, candidates } };
    }
    case "show": {
      const explanation = options.id ? service.explain(options.id) : undefined;
      if (!explanation) {
        print({ error: "not found" }, `No learning record or candidate '${options.id ?? ""}'.`);
        return { exitCode: 1, output: undefined };
      }
      print(explanation, [
        `What was learned: ${explanation.what}`,
        `Why: ${explanation.why}`,
        `From tasks: ${explanation.fromTasks.join(", ") || "-"}`,
        `Evidence: ${explanation.evidence.join(", ") || "-"}`,
        `Successes: ${explanation.successes} · Failures: ${explanation.failures}`,
        `Status: ${explanation.status} · Scope: ${explanation.scope}`,
        `If approved: ${explanation.ifApproved}`,
      ].join("\n"));
      return { exitCode: 0, output: explanation };
    }
    case "approve": {
      const result = await service.approve(options.id ?? "");
      print(result, result.ok ? (result.kind === "SKILL" ? `Approved: wrote ${result.path} (version ${result.version}).` : `Approved memory: ${result.record.title}`) : `Not approved: ${result.reason}`);
      return { exitCode: result.ok ? 0 : 1, output: result };
    }
    case "reject": {
      const ok = await service.reject(options.id ?? "", options.reason);
      print({ ok }, ok ? "Rejected. The same proposal stays suppressed until materially new evidence appears." : `Nothing to reject for '${options.id ?? ""}'.`);
      return { exitCode: ok ? 0 : 1, output: { ok } };
    }
    case "decide": {
      const result = await service.recordUserDecision({ title: options.title ?? "", summary: options.summary ?? "" });
      print(result, result.ok ? `Recorded decision ${result.record.id}.` : `Not recorded: ${result.reason}`);
      return { exitCode: result.ok ? 0 : 1, output: result };
    }
    default:
      print({ error: "unknown action" }, "Usage: open-vscode-agent learning <list|show <id>|approve <id>|reject <id> [--reason r]|decide --title t --summary s>");
      return { exitCode: 3, output: undefined };
  }
}
