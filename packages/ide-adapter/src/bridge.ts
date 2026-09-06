import { 
  AgentRunner, AgentMode, AgentEvent, MutationEngine, VerificationEngine,
  createReadOnlyToolRegistry, createMutationToolRegistrations, createVerificationToolRegistrations,
  calculateBudget, classifyPermission, ProjectMemoryLoader, SessionSummaryStorage,
  MemoryRetriever, discoverSkills, selectSkills, loadSkill, estimateTokens,
  RoutedModelGateway, loadRoutingConfig, StaticHealthChecker, ScriptedModelProvider, OpenAICompatibleProvider,
  McpCatalog, selectMcpTools, createMcpToolRegistration, RepairOrchestrator
} from "@open-vs-code/agent-core";
import { IdeHost, IdeContextSnapshot } from "./contracts.js";

// Utility to load mcp config locally since it's not exported from core?
// Oh wait, `cli/app.ts` imports `loadMcpConfig` from `./mcp-loader.ts`.
// Let's implement a similar minimal loader here or require it as a dependency.
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function loadMcpConfig(workspaceRoot: string): Promise<any> {
  const configPath = path.join(workspaceRoot, ".open-vs-code", "mcp.json");
  try {
    const data = await fs.readFile(configPath, "utf-8");
    return JSON.parse(data);
  } catch (err: any) {
    if (err.code === "ENOENT") return { mcpServers: {} };
    throw err;
  }
}

export interface BridgeOptions {
  host: IdeHost;
  workspaceRoot: string;
}

export class AgentSessionBridge {
  private host: IdeHost;
  private workspaceRoot: string;
  private activeSession: boolean = false;
  
  constructor(options: BridgeOptions) {
    this.host = options.host;
    this.workspaceRoot = options.workspaceRoot;
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
    
    // Load config and set up provider
    const config = await loadRoutingConfig(this.workspaceRoot);
    if (!config) {
      throw new Error("No model routing configuration found.");
    }
    
    const providers = new Map<string, any>();
    for (const p of config.providers) {
      if (p.kind === "scripted") {
        providers.set(p.id, new ScriptedModelProvider([{ 
          model: "scripted-general", 
          message: { role: "assistant", content: "I am a deterministic scripted model." } 
        }]));
      } else if (p.kind !== "openai_compatible_local" && p.kind !== "fake") {
        throw new Error(`Unknown provider kind: ${p.kind}`);
      }
    }

    for (const d of config.deployments) {
      const providerConfig = config.providers.find(p => p.id === d.providerId);
      if (providerConfig?.kind === "openai_compatible_local") {
        if (!d.endpoint) throw new Error(`Deployment ${d.id} missing endpoint`);
        providers.set(d.id, new OpenAICompatibleProvider({
          baseUrl: d.endpoint,
          model: d.modelId,
        }));
      }
    }
    
    const healthChecker = new StaticHealthChecker(
      new Map(config.deployments.map(d => [d.id, "ready" as const]))
    );
    
    const provider = new RoutedModelGateway({
      config,
      providers,
      healthChecker,
      mode,
      hasTools: true,
      hasStructuredOutput: false,
    });
    
    // Setup engines and registry
    const mutationEngine = new MutationEngine(this.workspaceRoot);
    const verificationEngine = new VerificationEngine({ workspaceRoot: this.workspaceRoot });
    const registry = createReadOnlyToolRegistry();
    
    // In untrusted workspaces, do not register mutations/verifications
    if (isTrusted) {
      for (const r of createMutationToolRegistrations({ engine: mutationEngine })) registry.register(r);
      for (const r of createVerificationToolRegistrations(this.workspaceRoot)) registry.register(r);
    }
    
    const sink = (ev: AgentEvent) => this.handleEvent(ev);
    
    const mcpConfig = await loadMcpConfig(this.workspaceRoot);
    const mcpCatalog = new McpCatalog(mcpConfig, sink);
    await mcpCatalog.discover();
    const allMcpTools = mcpCatalog.getTools();
    const { selected: selectedMcpTools } = selectMcpTools(allMcpTools, {
      task: instruction, mode, maxTools: 3, schemaBudget: 1500
    });
    
    const mcpStats = { callsStarted: 0, callsCompleted: 0, callsRejected: 0, callsCancelled: 0, callsTimedOut: 0, callsFailed: 0, resultBytesRetained: 0, resultsTruncated: 0 };
    for (const tool of selectedMcpTools) {
      const transport = mcpCatalog.getTransport(tool.serverId);
      if (transport) registry.register(createMcpToolRegistration(tool, transport, mcpConfig, mcpStats));
    }
    
    const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 });
    
    const memoryLoader = new ProjectMemoryLoader(this.workspaceRoot);
    const memorySnapshot = await memoryLoader.load();
    const sessionStorage = new SessionSummaryStorage({ workspaceRoot: this.workspaceRoot });
    const { sessions } = await sessionStorage.load();
    const retriever = new MemoryRetriever(memorySnapshot, sessions);
    const memory = retriever.select({ task: instruction, mode, tokenBudget: 1500 });
    
    const skills = await discoverSkills(this.workspaceRoot);
    const skillBudget = contextBudget.availableContext * 0.15;
    const skillSelection = selectSkills({ task: instruction, mode, catalog: skills, budgetTokens: skillBudget });
    
    const selectedSkills = [];
    let actualTokens = 0;
    if (skillSelection.primarySkill) {
      let loaded = await loadSkill(this.workspaceRoot, skillSelection.primarySkill.metadata, { sections: skillSelection.primarySkill.sections });
      let t = estimateTokens(loaded.body);
      if (t <= skillBudget) {
        selectedSkills.push(loaded);
        actualTokens += t;
      }
    }
    for (const s of skillSelection.supportingSkills) {
      const loaded = await loadSkill(this.workspaceRoot, s.metadata, { sections: s.sections });
      const t = estimateTokens(loaded.body);
      if (actualTokens + t <= skillBudget) {
        selectedSkills.push(loaded);
        actualTokens += t;
      }
    }
    
    const runnerInput: any = {
      task: { id: `session-${Date.now()}`, mode, instruction: contextInstruction },
      workspaceRoot: this.workspaceRoot,
      maxTurns: 15,
      contextBudget,
      projectInstructions: [],
      memory,
      selectedSkills,
      signal
    };
    
    const runner = new AgentRunner({
      provider,
      registry,
      permissionEvaluator: classifyPermission,
      evidenceGate: false,
      eventSink: sink
    });
    
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
          const repair = new RepairOrchestrator(
            { maxRepairAttempts: 3, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 20 },
            verificationEngine,
            () => new AgentRunner({ provider, registry, permissionEvaluator: classifyPermission, evidenceGate: false, eventSink: sink })
          );
          
          let repairResult = await repair.run(runnerInput as any, conf.preparedMutation as any);
          while (repairResult.status === "AWAITING_MUTATION_APPROVAL" || repairResult.status === "AWAITING_VERIFICATION_APPROVAL") {
            if (signal.aborted) {
              repairResult = await repair.resume("REJECT");
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
            repairResult = await repair.resume(repApproved ? "APPROVE" : "REJECT");
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
    await mcpCatalog.close();
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
