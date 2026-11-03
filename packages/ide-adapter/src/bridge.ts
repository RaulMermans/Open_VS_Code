import { AgentMode, AgentEvent, AgentResult, ConversationTurn, type SkillEvidence, type WorkflowState, type WorkflowResult, type ResolvedExecutionProfile, type McpCatalog, type BrowserSessionManager } from "@open-vs-code/agent-core";
import { createAgentRuntime, calculateBudget, isSkillApplied } from "@open-vs-code/agent-core";
import { IdeHost, IdeContextSnapshot } from "./contracts.js";
import { buildBoundedIdeContextSnapshot } from "./bounds.js";

export interface BridgeOptions {
  host: IdeHost;
  workspaceRoot: string;
  providerOverride?: any;
  /** Portable Skills Runtime (ADR-029); disabled unless the host enables it. */
  skills?: { enabled: boolean; builtinRoot?: string };
  /** Structured Engineering Loop (ADR-030); disabled unless the host enables it. */
  workflow?: { enabled: boolean };
  /** Non-progress detection & bounded recovery (ADR-031); disabled unless the host enables it. */
  progressMonitor?: { enabled: boolean };
  /** Bounded memory-to-skill learning (ADR-032); disabled unless the host enables it. */
  learning?: { enabled: boolean };
  /** Authoritative MCP catalog (e.g. from McpService) */
  mcpCatalog?: McpCatalog;
  /** Governed BrowserSessionManager (Sprint 9A) */
  browserSessionManager?: BrowserSessionManager;
  /** Authenticated account identity scope for evidence and session isolation */
  accountScope?: string;
}

export class AgentSessionBridge {
  private host: IdeHost;
  private workspaceRoot: string;
  private activeSession: boolean = false;
  private providerOverride?: any;
  private skills?: BridgeOptions["skills"];
  private lastSkillEvidence?: SkillEvidence;
  private workflow?: BridgeOptions["workflow"];
  private progressMonitor?: BridgeOptions["progressMonitor"];
  private learning?: BridgeOptions["learning"];
  private mcpCatalog?: BridgeOptions["mcpCatalog"];
  private browserSessionManager?: BrowserSessionManager;
  private lastWorkflowState?: WorkflowState;
  private accountScope?: string;
  
  constructor(options: BridgeOptions) {
    this.host = options.host;
    this.workspaceRoot = options.workspaceRoot;
    this.providerOverride = options.providerOverride;
    this.skills = options.skills;
    this.workflow = options.workflow;
    this.progressMonitor = options.progressMonitor;
    this.learning = options.learning;
    this.mcpCatalog = options.mcpCatalog;
    this.browserSessionManager = options.browserSessionManager;
    this.accountScope = options.accountScope;
  }

  /** Bounded workflow state of the most recent structured task, if one ran. */
  public get workflowState(): WorkflowState | undefined {
    return this.lastWorkflowState;
  }

  /** Bounded, privacy-safe skill evidence from the most recent task (ids, versions, reason codes only). */
  public get skillEvidence(): SkillEvidence | undefined {
    return this.lastSkillEvidence;
  }
  
  public async runTask(
    instruction: string,
    mode: AgentMode,
    signal: AbortSignal,
    onEvent?: (ev: AgentEvent) => void,
    recentTurns?: readonly ConversationTurn[],
    resolvedProfile?: ResolvedExecutionProfile
  ): Promise<AgentResult> {
    if (this.activeSession) {
      await this.host.showError("A session is already active.");
      return Promise.reject(new Error("A session is already active."));
    }
    
    this.activeSession = true;
    try {
      return await this._run(instruction, mode, signal, onEvent, recentTurns, resolvedProfile);
    } finally {
      this.activeSession = false;
    }
  }
  
  private async _run(
    instruction: string,
    mode: AgentMode,
    signal: AbortSignal,
    onEvent?: (ev: AgentEvent) => void,
    recentTurns?: readonly ConversationTurn[],
    resolvedProfile?: ResolvedExecutionProfile
  ): Promise<AgentResult> {
    const t0 = Date.now();
    await this.host.showOutput(`Starting ${mode} task: ${instruction}`);
    
    // Check trust
    const isTrusted = await this.host.isWorkspaceTrusted();
    if (!isTrusted && (mode === "BUILD" || mode === "DEBUG")) {
      await this.host.showError("Cannot run BUILD or DEBUG in an untrusted workspace.");
      return { status: "FAILED", failureReason: "INTERNAL_ERROR", turns: 0, finalState: { status: "FAILED", events: [] }, events: [], contextDiagnostics: [], toolCalls: [] };
    }

    if (resolvedProfile) {
      if (resolvedProfile.baseMode !== mode) {
        const msg = `Base mode mismatch: execution mode "${mode}" does not match profile base mode "${resolvedProfile.baseMode}".`;
        await this.host.showError(msg);
        return {
          status: "FAILED",
          failureReason: "INTERNAL_ERROR",
          turns: 0,
          finalState: { status: "FAILED", events: [] },
          events: [],
          contextDiagnostics: [{ turn: 0, totalEstimatedTokens: 0, omittedItemIds: [msg] }],
          toolCalls: [],
        };
      }
      if (!resolvedProfile.isReady) {
        const msg = `Custom mode "${resolvedProfile.profileName}" is not ready for execution: ${resolvedProfile.diagnostics.join("; ")}`;
        await this.host.showError(msg);
        return {
          status: "FAILED",
          failureReason: "INTERNAL_ERROR",
          turns: 0,
          finalState: { status: "FAILED", events: [] },
          events: [],
          contextDiagnostics: resolvedProfile.diagnostics.map((d) => ({ turn: 0, totalEstimatedTokens: 0, omittedItemIds: [d] })),
          toolCalls: [],
        };
      }
    }
    
    // Capture IDE context
    const rawSnapshot = await this.host.getSnapshot();
    
    // We do not have the exact model context window until after routing.
    // Use the canonical pre-route context policy: 8000 total window.
    const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 });
    const snapshot = buildBoundedIdeContextSnapshot(rawSnapshot, budget.availableContext);
    
    await this.host.showOutput(`Captured IDE Context: Active=${snapshot.activeDocument?.uri ?? 'none'}, Visible=${snapshot.visibleDocuments.length}, Diagnostics=${snapshot.diagnostics.length}`);
    
    // Append IDE context to instruction
    let contextInstruction = instruction;
    if (snapshot.activeDocument) {
      contextInstruction += `\n\n[IDE Context]\nActive File: ${snapshot.activeDocument.workspaceRelativePath || snapshot.activeDocument.uri}`;
      if (snapshot.selection && snapshot.selection.selectedText) {
        contextInstruction += `\nSelection:\n${snapshot.selection.selectedText}`;
      }
    }
    
    const sink = (ev: AgentEvent) => {
      this.handleEvent(ev);
      if (onEvent) onEvent(ev);
    };

    let runtime: any;
    try {
      runtime = await createAgentRuntime({
        workspaceRoot: this.workspaceRoot,
        mode,
        instruction: contextInstruction,
        recentTurns,
        signal,
        isTrusted,
        eventSink: sink,
        providerOverride: this.providerOverride,
        ...(this.accountScope ? { accountScope: this.accountScope } : {}),
        ...(resolvedProfile ? { resolvedProfile } : {}),
        ...(this.mcpCatalog ? { mcpCatalog: this.mcpCatalog } : {}),
        ...(this.browserSessionManager ? { browserSessionManager: this.browserSessionManager } : {}),
        ...(this.skills
          ? { skills: this.skills }
          : resolvedProfile?.appliedSkills && resolvedProfile.appliedSkills.length > 0
          ? { skills: { enabled: true } }
          : {}),
        ...(this.learning?.enabled ? { learning: { enabled: true } } : {}),
        ...(this.progressMonitor?.enabled ? {
          progressMonitor: {
            enabled: true,
            onProgress: (notice: string) => void this.host.showOutput(notice),
          },
        } : {}),
        ...(this.workflow?.enabled ? {
          workflow: {
            enabled: true,
            // Meaningful stage transitions only.
            onStage: (event: { stage: string; status: string; skill?: string }) => {
              if (event.status !== "WAITING_FOR_CONFIRMATION") void this.host.showOutput(`Stage: ${event.stage}${event.skill ? ` · Skill: ${event.skill}` : ""}`);
            },
          },
        } : {}),
      });
      (this as any)._lastRuntime = runtime;
      
      if (runtime.workflow) {
        const workflowResult = await this._runWorkflow(runtime.workflow, signal);
        if (this.lastWorkflowState) await this._learn(runtime, { kind: "workflow", state: this.lastWorkflowState });
        return workflowResult;
      }

      const { runner, repairOrchestrator, runnerInput } = runtime;
      
      let runnerResult = await runner.run(runnerInput as any);
      
      while (runnerResult.status === "PAUSED") {
        if (signal.aborted) {
          runnerResult = await runner.resume("REJECT");
          break;
        }
        const conf = runnerResult.confirmation!;
        let approved = false;
        
        if (conf.action === "write_file") {
          const pm = conf.preparedMutation!;
          const prompt = `Approve mutation on ${pm.path}? (${pm.operation})`;
          const res = await this.host.requestConfirmation(prompt, pm);
          approved = (res === "APPROVE");
        } else if (conf.action === "run_known_test") {
          const pv = conf.preparedCommand;
          const actionName = pv?.action || (conf.arguments as any)?.action || "TEST";
          const prompt = `Run verification ${actionName}?`;
          const payload = {
            action: conf.action,
            arguments: conf.arguments,
            preparedCommand: pv,
          };
          const res = await this.host.requestConfirmation(prompt, payload);
          approved = (res === "APPROVE");
        } else if (conf.action.startsWith("mcp_external") || conf.action === "mcp_sensitive_data_transmission") {
          const prompt = `Approve MCP tool execution? (${conf.action})`;
          const res = await this.host.requestConfirmation(prompt, conf);
          approved = (res === "APPROVE");
        } else if (conf.action.startsWith("browser_")) {
          const review = (conf.preparedMutation ?? {}) as Record<string, unknown>;
          const targetDesc =
            typeof review.targetName === "string" && review.targetName
              ? ` on "${review.targetName}"`
              : typeof review.fieldName === "string" && review.fieldName
              ? ` into "${review.fieldName}"`
              : typeof review.url === "string" && review.url
              ? ` to ${review.url}`
              : typeof review.refId === "string"
              ? ` (${review.refId})`
              : "";
          const prompt = `Approve ${conf.toolName}${targetDesc}? (${conf.action})`;
          const res = await this.host.requestConfirmation(prompt, conf);
          approved = (res === "APPROVE");
        }
        
        if (approved) {
          if (conf.action === "run_known_test" && (mode === "DEBUG" || mode === "BUILD")) {
            let repairResult = await repairOrchestrator.run(runnerInput as any, (conf.preparedCommand || conf.preparedMutation) as any);
            while (repairResult.status === "AWAITING_MUTATION_APPROVAL" || repairResult.status === "AWAITING_VERIFICATION_APPROVAL") {
              if (signal.aborted) {
                repairResult = await repairOrchestrator.resume("REJECT");
                break;
              }
              let repApproved = false;
              if (repairResult.status === "AWAITING_MUTATION_APPROVAL") {
                const pm = repairResult.pendingReview as any;
                const prompt = `Approve mutation on ${pm.path}? (${pm.operation})`;
                const res = await this.host.requestConfirmation(prompt, pm);
                repApproved = (res === "APPROVE");
              } else if (repairResult.status === "AWAITING_VERIFICATION_APPROVAL") {
                const pv = repairResult.pendingReview as any;
                const actionName = pv?.action || pv?.arguments?.action || "TEST";
                const prompt = `Run verification ${actionName}?`;
                const payload = {
                  action: "run_known_test",
                  arguments: pv?.arguments || { action: actionName },
                  preparedCommand: pv,
                };
                const res = await this.host.requestConfirmation(prompt, payload);
                repApproved = (res === "APPROVE");
              }
              repairResult = await repairOrchestrator.resume(repApproved ? "APPROVE" : "REJECT");
            }
            runnerResult = repairResult as any;
            break;
          } else {
            runnerResult = await runner.resume("APPROVE");
          }
        } else {
          runnerResult = await runner.resume("REJECT");
        }
      }
      // Final-context truth: report the skill only if its guidance reached a model request.
      this.lastSkillEvidence = runtime.skillEvidence;
      if (isSkillApplied(runtime.skillEvidence)) {
        await this.host.showOutput(`Skill: ${runtime.skillEvidence.selectedSkill}`);
      }
      await this.host.showOutput(`Task Finished: ${runnerResult.status}`);
      await this._learn(runtime, { kind: "direct", taskId: runnerInput.task.id, mode, result: runnerResult });
      if (runtime?.performanceLedger) {
        await runtime.performanceLedger.persist().catch(() => {});
      }
      return runnerResult as AgentResult;
    } catch (e: any) {
      // T-1612: observe cancellation from actual core/bridge result, not inferred from signal alone.
      // AbortError thrown by the provider when signal fires → emit observable CANCELLED terminal result.
      if (e?.name === "AbortError" || signal.aborted) {
        await this.host.showOutput("Task Finished: CANCELLED");
        return { status: "CANCELLED", turns: 0, finalState: { status: "CANCELLED", events: [] }, events: [], contextDiagnostics: [], toolCalls: [] } as AgentResult;
      } else {
        throw e;
      }
    } finally {
      if (runtime) {
        this.lastSkillEvidence = runtime.skillEvidence;
        await runtime.cleanup();
      }
    }
  }
  
  /** Runs after the task is finished; learning never changes or fails the task (ADR-032). */
  private async _learn(runtime: any, input: unknown): Promise<void> {
    if (!this.learning?.enabled || typeof runtime?.learnAfter !== "function") return;
    const step = await runtime.learnAfter(input);
    if (step?.proposedCandidates > 0) {
      await this.host.showOutput(`Learning: ${step.proposedCandidates} skill candidate(s) await review (Open VS Code: Review Learning Candidates)`);
    }
  }

  /** Drives a structured workflow; every confirmation goes through the host, exactly as on the direct path. */
  private async _runWorkflow(workflow: any, signal: AbortSignal): Promise<AgentResult> {
    const onAbort = () => workflow.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      let result: WorkflowResult = await workflow.run();
      while (result.status === "WAITING_FOR_CONFIRMATION") {
        const confirmation = result.confirmation!;
        let approved = false;
        if (signal.aborted) {
          approved = false;
        } else if (confirmation.runner?.preparedMutation) {
          const pm = confirmation.runner.preparedMutation;
          approved = (await this.host.requestConfirmation(`Approve mutation on ${pm.path}? (${pm.operation})`, pm)) === "APPROVE";
        } else if (confirmation.verification) {
          approved = (await this.host.requestConfirmation(`Run ${confirmation.stage} checks: ${confirmation.verification.commands.join(", ")}?`, confirmation.verification)) === "APPROVE";
        } else if (confirmation.runner) {
          approved = (await this.host.requestConfirmation(`Approve ${confirmation.runner.toolName}? (${confirmation.runner.action})`, confirmation.runner)) === "APPROVE";
        }
        const confirmationToken = confirmation.runner?.callId;
        result = await workflow.resume(approved ? "APPROVE" : "REJECT", confirmationToken);
      }
      const state = result.state;
      this.lastWorkflowState = state;
      await this.host.showOutput(`Task Finished: ${result.status}${state.blocker ? ` (${state.blocker})` : ""}`);
      const status = result.status === "COMPLETE" ? "COMPLETED" : result.status === "CANCELLED" ? "CANCELLED" : "FAILED";
      const review = state.reviews.at(-1);
      const finalAnswer = [
        `Workflow ${result.status}${state.blocker ? `: ${state.blocker}${state.blockerDetail ? ` — ${state.blockerDetail}` : ""}` : ""}`,
        ...(state.implementation ? [`Changed: ${[...new Set(state.implementation.changedFiles.map((change) => change.path))].join(", ")}`] : []),
        ...(review ? [`Review: ${review.verdict} (${review.blocking} blocking)`] : []),
        ...(state.verification ? [`Verification: ${state.verification.verdict}`] : []),
      ].join("\n");
      return {
        status,
        ...(status === "FAILED" ? { failureReason: "INTERNAL_ERROR" as const } : {}),
        finalAnswer,
        turns: state.stages.reduce((total, record) => total + record.modelCalls, 0),
        finalState: { status, events: [] },
        events: [],
        contextDiagnostics: [],
        toolCalls: [],
      } as AgentResult;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private handleEvent(ev: AgentEvent) {
    switch (ev.type) {
      case "task.started":
        this.host.showOutput("Task started.");
        break;
      case "tool.requested":
        this.host.showOutput(`Tool requested: ${(ev.payload as any)?.name}`);
        break;
      case "tool.completed":
        this.host.showOutput(`Tool completed: ${(ev.payload as any)?.name}`);
        break;
      case "mutation.prepared":
        this.host.showOutput(`Mutation prepared for ${(ev.payload as any)?.path}`);
        break;
      case "verification.prepared":
        this.host.showOutput(`Verification prepared.`);
        break;
      case "mutation.applied":
        this.host.showOutput(`Mutation applied.`);
        break;
    }
  }
}
