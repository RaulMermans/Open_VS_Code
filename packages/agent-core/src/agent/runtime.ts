import { AgentRunner } from "./runner.ts";
import { RepairOrchestrator } from "./repair-loop.ts";
import { RoutedModelGateway, StaticHealthChecker } from "../model/routed-gateway.ts";
import { loadRoutingConfig } from "../model/config-loader.ts";
import { ScriptedModelProvider } from "../testing/scripted-model.ts";
import { OpenAICompatibleProvider } from "../model/openai-compatible.ts";
import { MutationEngine } from "../tools/mutation-engine.ts";
import { VerificationEngine } from "../tools/verification-engine.ts";
import { createReadOnlyToolRegistry } from "../tools/read-only-registry.ts";
import { createMutationToolRegistrations } from "../tools/mutation-registry.ts";
import { createVerificationToolRegistrations } from "../tools/verification-registry.ts";
import { McpCatalog, selectMcpTools, createMcpToolRegistration } from "../mcp/index.ts";
import { loadMcpConfig } from "../mcp/mcp-config-loader.ts";
import { classifyPermission } from "../tools/permissions.ts";
import { ProjectMemoryLoader } from "../context/memory-loader.ts";
import { SessionSummaryStorage } from "../context/session-storage.ts";
import { MemoryRetriever } from "../context/memory-retriever.ts";
import { discoverSkills, loadSkill } from "../context/skills.ts";
import { selectSkills } from "../context/skill-selector.ts";
import { calculateBudget, estimateTokens } from "../context/budget.ts";

import type { AgentMode, AgentEvent } from "../contracts/agent.ts";
import type { ModelProvider } from "../contracts/model.ts";

import type { ConversationTurn } from "../context/compiler.ts";

export interface CreateAgentRuntimeOptions {
  workspaceRoot: string;
  mode: AgentMode;
  instruction: string;
  recentTurns?: readonly ConversationTurn[];
  signal?: AbortSignal;
  eventSink: (ev: AgentEvent) => void;
  isTrusted: boolean;
  providerOverride?: ModelProvider;
}

export async function createAgentRuntime(options: CreateAgentRuntimeOptions) {
  let provider = options.providerOverride;
  let routedGateway: RoutedModelGateway | undefined;

  if (!provider) {
    const config = await loadRoutingConfig(options.workspaceRoot);
    if (!config) {
      throw new Error("No model routing configuration found.");
    }
    
    const providers = new Map<string, any>();
    for (const p of config.providers as any[]) {
      if (p.kind === "scripted") {
        providers.set(p.id, new ScriptedModelProvider([{ 
          model: "scripted-general", 
          message: { role: "assistant", content: "I am a deterministic scripted model." } 
        }]));
      } else if (p.kind !== "openai_compatible_local" && p.kind !== "fake") {
        throw new Error(`Unknown provider kind: ${p.kind}`);
      }
    }

    for (const d of config.deployments as any[]) {
      const providerConfig = config.providers.find(p => p.id === d.providerId);
      if (providerConfig?.kind === "openai_compatible_local") {
        let ep = d.endpoint;
          if (ep && !ep.startsWith("http")) ep = process.env[ep] || ep;
          if (!ep) throw new Error(`Deployment ${d.id} missing endpoint`);
        providers.set(d.id, new OpenAICompatibleProvider({
          baseUrl: ep,
          model: d.modelId,
        }));
      }
    }

    const healthChecker = new StaticHealthChecker(
      new Map(config.deployments.map(d => [d.id, "ready" as const]))
    );

    routedGateway = new RoutedModelGateway({
      config,
      providers,
      healthChecker,
      mode: options.mode,
      hasTools: true,
      hasStructuredOutput: false,
    });
    provider = routedGateway;
  } else {
      routedGateway = provider instanceof RoutedModelGateway ? provider : undefined;
  }

  const mutationEngine = new MutationEngine(options.workspaceRoot);
  const verificationEngine = new VerificationEngine({ workspaceRoot: options.workspaceRoot });
  
  const registry = createReadOnlyToolRegistry();
  
  if (options.isTrusted) {
    for (const r of createMutationToolRegistrations({ engine: mutationEngine })) {
      registry.register(r);
    }
    for (const r of createVerificationToolRegistrations(options.workspaceRoot)) {
      registry.register(r);
    }
  }

  const mcpConfig = await loadMcpConfig(options.workspaceRoot);
  const mcpCatalog = new McpCatalog(mcpConfig, options.eventSink);
  await mcpCatalog.discover();
  
  const allMcpTools = mcpCatalog.getTools();
  const { selected: selectedMcpTools, eligibleCount: toolsEligible } = selectMcpTools(allMcpTools, {
    task: options.instruction,
    mode: options.mode,
    maxTools: 3,
    schemaBudget: 1500
  });

  const mcpStats = { callsStarted: 0, callsCompleted: 0, callsRejected: 0, callsCancelled: 0, callsTimedOut: 0, callsFailed: 0, resultBytesRetained: 0, resultsTruncated: 0 };
  
  for (const mcpTool of selectedMcpTools) {
    const transport = mcpCatalog.getTransport(mcpTool.serverId);
    if (transport) {
      registry.register(createMcpToolRegistration(mcpTool, transport, mcpConfig, mcpStats));
    }
  }

  const mcpSnapshot = () => ({
    serversConfigured: Object.keys(mcpConfig.servers).length,
    serversConnected: mcpCatalog.getConnectedServers().length,
    toolsDiscovered: allMcpTools.length,
    toolsEligible,
    toolsSelected: selectedMcpTools.length,
    schemasLoaded: selectedMcpTools.length,
    estimatedSchemaTokens: selectedMcpTools.reduce((acc: any, t: any) => acc + t.estimatedSchemaTokens, 0),
    schemaBudget: 1500,
    ...mcpStats
  });

  const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 });
  
  const memoryLoader = new ProjectMemoryLoader(options.workspaceRoot);
  const memorySnapshot = await memoryLoader.load();
  const sessionStorage = new SessionSummaryStorage({ workspaceRoot: options.workspaceRoot });
  const { sessions } = await sessionStorage.load();
  const retriever = new MemoryRetriever(memorySnapshot, sessions);
  const memory = retriever.select({ task: options.instruction, mode: options.mode, tokenBudget: 1500 });
  
  const skills = await discoverSkills(options.workspaceRoot);
  const skillBudget = contextBudget.availableContext * 0.15;
  const skillSelection = selectSkills({ task: options.instruction, mode: options.mode, catalog: skills, budgetTokens: skillBudget });
  
  const selectedSkills = [];
  let actualSkillTokens = 0;
  if (skillSelection.primarySkill) {
     let sections = [...skillSelection.primarySkill.sections];
     let loaded = await loadSkill(options.workspaceRoot, skillSelection.primarySkill.metadata, { sections });
     let t = estimateTokens(loaded.body);
     if (t > skillBudget) {
         sections = ["Intent", "When", "Inputs", "Procedure", "Template", "Expected Output"];
         loaded = await loadSkill(options.workspaceRoot, skillSelection.primarySkill.metadata, { sections });
         t = estimateTokens(loaded.body);
     }
     if (t > skillBudget) {
         sections = ["Intent", "When", "Procedure"];
         loaded = await loadSkill(options.workspaceRoot, skillSelection.primarySkill.metadata, { sections });
         t = estimateTokens(loaded.body);
     }
     if (t <= skillBudget) {
         selectedSkills.push(loaded);
         actualSkillTokens += t;
     }
  }
  for (const s of skillSelection.supportingSkills) {
     const loaded = await loadSkill(options.workspaceRoot, s.metadata, { sections: s.sections });
     const t = estimateTokens(loaded.body);
     if (actualSkillTokens + t <= skillBudget) {
         selectedSkills.push(loaded);
         actualSkillTokens += t;
     }
  }

  const runnerInput = {
    task: { id: `session-${Date.now()}`, mode: options.mode, instruction: options.instruction },
    workspaceRoot: options.workspaceRoot,
    maxTurns: 15,
    contextBudget,
    projectInstructions: [],
    ...(options.recentTurns ? { recentTurns: options.recentTurns } : {}),
    memory,
    selectedSkills,
    signal: options.signal
  };

  const runner = new AgentRunner({
    provider,
    registry,
    permissionEvaluator: classifyPermission,
    evidenceGate: false,
    eventSink: options.eventSink
  });

  const repairOrchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 3, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 20 },
    verificationEngine,
    () => new AgentRunner({ provider: provider!, registry, permissionEvaluator: classifyPermission, evidenceGate: false, eventSink: options.eventSink })
  );

  return {
    runner,
    repairOrchestrator,
    runnerInput,
    mcpCatalog,
    mcpStats,
    routedGateway,
    mcpSnapshot,
    skillSelection,
    actualSkillTokens,
    selectedSkills,
    memory,
    cleanup: async () => {
      await mcpCatalog.close();
      (mcpStats as any).cleanupCount = ((mcpStats as any).cleanupCount || 0) + 1;
    }
  };
}
