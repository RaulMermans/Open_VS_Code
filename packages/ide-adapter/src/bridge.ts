import { AgentMode, AgentEvent } from "@open-vs-code/agent-core";
import { createAgentRuntime } from "@open-vs-code/agent-core";
import { IdeHost, IdeContextSnapshot } from "./contracts.js";

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
  
  public async runTask(instruction: string, mode: AgentMode, signal: AbortSignal): Promise<void> {
    if (this.activeSession) {
      await this.host.showError("A session is already active.");
      return;
    }
    
    this.activeSession = true;
    try {
      await this._run(instruction, mode, signal);
    } finally {
      this.activeSession = false;
    }
  }
  
  private async _run(instruction: string, mode: AgentMode, signal: AbortSignal) {
    await this.host.showOutput(`Starting ${mode} task: ${instruction}`);
    
    // Check trust
    const isTrusted = await this.host.isWorkspaceTrusted();
    if (!isTrusted && (mode === "BUILD" || mode === "DEBUG")) {
      await this.host.showError("Cannot run BUILD or DEBUG in an untrusted workspace.");
      return;
    }
    
    // Capture IDE context
    const snapshot = await this.host.getSnapshot();
    await this.host.showOutput(`Captured IDE Context: Active=${snapshot.activeDocument?.uri ?? 'none'}, Visible=${snapshot.visibleDocuments.length}, Diagnostics=${snapshot.diagnostics.length}`);
    
    // Append IDE context to instruction
    let contextInstruction = instruction;
    if (snapshot.activeDocument) {
      contextInstruction += `\n\n[IDE Context]\nActive File: ${snapshot.activeDocument.workspaceRelativePath || snapshot.activeDocument.uri}`;
      if (snapshot.selection && snapshot.selection.selectedText) {
        contextInstruction += `\nSelection:\n${snapshot.selection.selectedText}`;
      }
    }
    
    const sink = (ev: AgentEvent) => this.handleEvent(ev);

    let runtime: any;
    try {
      runtime = await createAgentRuntime({
        workspaceRoot: this.workspaceRoot,
        mode,
        instruction: contextInstruction,
        signal,
        isTrusted,
        eventSink: sink,
        providerOverride: this.providerOverride
      });
      
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
          const prompt = `Run verification ${conf.arguments.action}?`;
          const res = await this.host.requestConfirmation(prompt, conf.arguments);
          approved = (res === "APPROVE");
        } else if (conf.action.startsWith("mcp_external")) {
          const prompt = `Approve MCP tool execution? (${conf.action})`;
          const res = await this.host.requestConfirmation(prompt, conf);
          approved = (res === "APPROVE");
        }
        
        if (approved) {
          if (conf.action === "run_known_test" && (mode === "DEBUG" || mode === "BUILD")) {
            let repairResult = await repairOrchestrator.run(runnerInput as any, conf.preparedMutation as any);
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
                const prompt = `Run verification ${pv.arguments?.action || "TEST"}?`;
                const res = await this.host.requestConfirmation(prompt, pv.arguments);
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
