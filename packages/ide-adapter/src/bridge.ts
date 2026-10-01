import { AgentMode, AgentEvent, AgentResult, ConversationTurn } from "@open-vs-code/agent-core";
import { createAgentRuntime, calculateBudget } from "@open-vs-code/agent-core";
import { IdeHost, IdeContextSnapshot } from "./contracts.js";
import { buildBoundedIdeContextSnapshot } from "./bounds.js";

export interface BridgeOptions {
  host: IdeHost;
  workspaceRoot: string;
  providerOverride?: any;
}

export class AgentSessionBridge {
  private host: IdeHost;
  private workspaceRoot: string;
  private activeSession: boolean = false;
  private providerOverride?: any;
  
  constructor(options: BridgeOptions) {
    this.host = options.host;
    this.workspaceRoot = options.workspaceRoot;
    this.providerOverride = options.providerOverride;
  }
  
  public async runTask(instruction: string, mode: AgentMode, signal: AbortSignal, onEvent?: (ev: AgentEvent) => void, recentTurns?: readonly ConversationTurn[]): Promise<AgentResult> {
    if (this.activeSession) {
      await this.host.showError("A session is already active.");
      return Promise.reject(new Error("A session is already active."));
    }
    
    this.activeSession = true;
    try {
      return await this._run(instruction, mode, signal, onEvent, recentTurns);
    } finally {
      this.activeSession = false;
    }
  }
  
  private async _run(instruction: string, mode: AgentMode, signal: AbortSignal, onEvent?: (ev: AgentEvent) => void, recentTurns?: readonly ConversationTurn[]): Promise<AgentResult> {
    const t0 = Date.now();
    await this.host.showOutput(`Starting ${mode} task: ${instruction}`);
    
    // Check trust
    const isTrusted = await this.host.isWorkspaceTrusted();
    if (!isTrusted && (mode === "BUILD" || mode === "DEBUG")) {
      await this.host.showError("Cannot run BUILD or DEBUG in an untrusted workspace.");
      return { status: "FAILED", failureReason: "INTERNAL_ERROR", turns: 0, finalState: { status: "FAILED", events: [] }, events: [], contextDiagnostics: [], toolCalls: [] };
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
        providerOverride: this.providerOverride
      });
      (this as any)._lastRuntime = runtime;
      
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
        } else if (conf.action.startsWith("mcp_external")) {
          const prompt = `Approve MCP tool execution? (${conf.action})`;
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
      await this.host.showOutput(`Task Finished: ${runnerResult.status}`);
      if (runtime?.performanceLedger && runtime?.routedGateway?.lastDecision) {
        const lastDec = runtime.routedGateway.lastDecision;
        runtime.performanceLedger.recordAgentOutcome({
          deploymentId: lastDec.deploymentId,
          taskClass: lastDec.taskClass,
          success: runnerResult.status === "COMPLETED",
          verificationSuccess: true,
          toolCallSuccess: (runnerResult.toolCalls?.length ?? 0) > 0,
          repairCycles: 0,
          timeoutOccurred: runnerResult.failureReason === "TIMEOUT",
          cancellationOccurred: runnerResult.failureReason === "CANCELLED",
          latencyMs: Date.now() - t0,
        });
        void runtime.performanceLedger.persist().catch(() => {});
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
        await runtime.cleanup();
      }
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
