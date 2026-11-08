import { join } from "node:path";
import { AgentRunner } from "./runner.ts";
import { RepairOrchestrator } from "./repair-loop.ts";
import { RoutedModelGateway, StaticHealthChecker } from "../model/routed-gateway.ts";
import { formatRouteIdentity, type ConfiguredRouteIdentity } from "../model/router.ts";
import { EndpointHealthChecker } from "../model/endpoint-health.ts";
import { ModelPerformanceLedger } from "../model/performance-ledger.ts";
import { loadRoutingConfig, resolveProviderApiKey } from "../model/config-loader.ts";
import { ScriptedModelProvider } from "../testing/scripted-model.ts";
import { OpenAICompatibleProvider } from "../model/openai-compatible.ts";
import { resolveDeploymentEndpoint, resolveServedModelId } from "../model/canonical-endpoint.ts";
import { MutationEngine } from "../tools/mutation-engine.ts";
import { VerificationEngine } from "../tools/verification-engine.ts";
import { createReadOnlyToolRegistry } from "../tools/read-only-registry.ts";
import { createMutationToolRegistrations } from "../tools/mutation-registry.ts";
import { createVerificationToolRegistrations } from "../tools/verification-registry.ts";
import { McpCatalog, selectMcpTools, createMcpToolRegistration } from "../mcp/index.ts";
import { loadMcpConfig } from "../mcp/mcp-config-loader.ts";
import { classifyPermission } from "../tools/permissions.ts";
import { BrowserSessionManager, createBrowserToolRegistrations } from "../browser/index.ts";
import { ProjectMemoryLoader } from "../context/memory-loader.ts";
import { SessionSummaryStorage } from "../context/session-storage.ts";
import { MemoryRetriever } from "../context/memory-retriever.ts";
import { discoverSkills, loadSkill } from "../context/skills.ts";
import { selectSkills } from "../context/skill-selector.ts";
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../skills/registry.ts";
import { prepareSkillGuidance, disabledSkillEvidence, SkillInjectionTracker } from "../skills/runtime.ts";
import { compileContext, type ContextCompilerInput, type ProjectInstruction } from "../context/compiler.ts";
import type { SkillEvidence, SkillGuidance } from "../skills/contracts.ts";
import type { LoadedSkill } from "../context/skills.ts";
import type { SkillSelectionResult } from "../context/skill-selector.ts";
import { calculateBudget, estimateTokens } from "../context/budget.ts";
import { CheckpointCoordinator } from "../recovery/checkpoint-coordinator.ts";
import { EngineeringWorkflow } from "../workflow/engine.ts";
import { GovernedDesignWorkflow } from "../design/governed-design-workflow.ts";
import { GovernedReaWorkflow, type ReaEvidenceBundle } from "../rea/index.ts";
import { assessWorkflowEligibility } from "../workflow/policy.ts";
import { CheckpointWorkflowStore, createWorkspaceVerifier } from "../workflow/services.ts";
import type { WorkflowEligibility, WorkflowStageEvent } from "../workflow/contracts.ts";
import { openWorkspaceLearning } from "../learning/node.ts";
import { runLearningStep, type LearningStepResult, type LearningTaskInput } from "../learning/hooks.ts";
import type { LearningRetrieval } from "../learning/contracts.ts";
import type { LearningService } from "../learning/service.ts";
import { resolveRepositoryPath } from "../tools/path-safety.ts";
import type { ResolvedExecutionProfile } from "../modes/contracts.ts";

import type { AgentMode, AgentEvent } from "../contracts/agent.ts";
import type { ModelProvider } from "../contracts/model.ts";
import type { RoutingConfiguration } from "../contracts/routing.ts";
import type { HealthChecker } from "../model/router.ts";
import type { ConversationTurn } from "../contracts/context.ts";

export interface CreateAgentRuntimeOptions {
  workspaceRoot: string;
  mode: AgentMode;
  instruction: string;
  recentTurns?: readonly ConversationTurn[];
  signal?: AbortSignal;
  eventSink: (ev: AgentEvent) => void;
  isTrusted: boolean;
  providerOverride?: ModelProvider;
  routingConfigOverride?: RoutingConfiguration;
  /**
   * When set, a missing override does not read `.open-vs-code/models.json`.
   * The extension sets this so an untrusted workspace file cannot redirect inference.
   */
  skipWorkspaceRoutingFile?: boolean;
  /**
   * Portable Skills Runtime (Sprint 5A, ADR-029). Disabled by default until the HALO A/B benchmark
   * is recorded. When disabled, the frozen ADR-014 `.agents/skills` path behaves exactly as in V1;
   * when enabled, it replaces that path (the two are never active together).
   */
  skills?: {
    enabled?: boolean;
    /** Directory of curated built-in skills; defaults to the copy shipped with agent-core. */
    builtinRoot?: string;
    /** 1 by default; hard-capped at 2 and only with an explicit composes_with rule. */
    maxSkills?: number;
  };
  /**
   * Structured Engineering Loop (Sprint 5B, ADR-030). Disabled by default until the HALO A/B
   * benchmark is recorded. When disabled, or when the task is not eligible, `workflow` is undefined
   * and the direct runner path is used exactly as before.
   */
  workflow?: {
    enabled?: boolean;
    onStage?: (event: WorkflowStageEvent) => void;
  };
  /**
   * Non-progress detection & bounded recovery (Sprint 5C, ADR-031). Disabled by default until the
   * HALO A/B benchmark is recorded; when disabled, the direct and workflow paths behave exactly as in
   * Sprint 5B. When enabled it protects both paths.
   */
  progressMonitor?: {
    enabled?: boolean;
    /** Minimal user-facing notices: "No progress detected…" and the BLOCKED summary. */
    onProgress?: (notice: string) => void;
  };
  /**
   * Bounded memory-to-skill learning (Sprint 5D, ADR-032). Disabled by default. When disabled no
   * learning is extracted, stored, proposed or retrieved, and prompts are exactly as before. When
   * enabled, only APPROVED learning (≤ 10% of the available context) is retrieved; candidates never
   * influence a run, and nothing is approved except by an explicit review command.
   */
  learning?: {
    enabled?: boolean;
  };
  /**
   * Resolved execution profile for a custom mode (Sprint 8D).
   * When provided, enforces the frozen tool allowlist, injects bounded mode instructions,
   * and respects the resolved model and workflow configuration.
   */
  resolvedProfile?: ResolvedExecutionProfile;
  /**
   * Optional authoritative McpCatalog instance (e.g. from McpService).
   * When provided, avoids duplicate catalog instantiation and server process spawning.
   */
  mcpCatalog?: McpCatalog;
  /**
   * Optional governed BrowserSessionManager instance (Sprint 9A).
   * When provided, exposes governed browser tools (browser_open, browser_navigate, browser_snapshot, etc.).
   */
  browserSessionManager?: BrowserSessionManager;
  /**
   * Optional account scope for authorization and evidence provenance isolation (Sprint 10A.1C).
   */
  accountScope?: string;
  /**
   * Optional initial evidence bundle for REA reconstruction handoff (Sprint 10A.1C).
   */
  initialEvidenceBundle?: ReaEvidenceBundle;
}

export async function createAgentRuntime(options: CreateAgentRuntimeOptions) {
  if (options.resolvedProfile) {
    if (options.resolvedProfile.baseMode !== options.mode) {
      throw new Error(
        `Base mode mismatch: runtime mode "${options.mode}" does not match profile base mode "${options.resolvedProfile.baseMode}".`
      );
    }
    if (!options.resolvedProfile.isReady) {
      throw new Error(
        `Cannot execute custom mode "${options.resolvedProfile.profileName}": execution profile is not ready. ${options.resolvedProfile.diagnostics.join("; ")}`
      );
    }
  }
  let provider = options.providerOverride;
  let routedGateway: RoutedModelGateway | undefined;
  let healthChecker: HealthChecker | undefined;
  let performanceLedger: ModelPerformanceLedger | undefined;
  let routingConfig: RoutingConfiguration | undefined;

  if (!provider) {
    const config = options.routingConfigOverride
      ?? (options.skipWorkspaceRoutingFile ? null : await loadRoutingConfig(options.workspaceRoot));
    if (config) routingConfig = config;
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

    const endpointMap = new Map<string, string>();
    const authHeadersMap = new Map<string, Record<string, string>>();
    for (const d of config.deployments as any[]) {
      const providerConfig = config.providers.find((p: any) => p.id === d.providerId);
      if (providerConfig?.kind === "openai_compatible_local") {
        const ep = resolveDeploymentEndpoint(d, providerConfig);
        endpointMap.set(d.id, ep);
        const apiKey = resolveProviderApiKey(providerConfig);
        const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
        if (headers) authHeadersMap.set(d.id, headers);
        const modelConfig = config.models.find((m: any) => m.id === d.modelId);
        const wireModel = resolveServedModelId(d, modelConfig);
        providers.set(d.id, new OpenAICompatibleProvider({
          baseUrl: ep,
          model: wireModel,
          contextWindow: d.contextWindow ?? modelConfig?.contextWindow,
          timeoutMs: 180_000,
          ...(headers ? { headers } : {}),
        }));
      }
    }

    healthChecker = endpointMap.size > 0
      ? new EndpointHealthChecker({ endpoints: endpointMap, headers: authHeadersMap })
      : new StaticHealthChecker(
          new Map(config.deployments.map((d: any) => [d.id, "ready" as const]))
        );

    const ledgerPath = join(options.workspaceRoot, ".open-vs-code", "model-performance-ledger.json");
    performanceLedger = new ModelPerformanceLedger({ persistPath: ledgerPath });
    await performanceLedger.ready;

    routedGateway = new RoutedModelGateway({
      config,
      providers,
      healthChecker,
      performanceLedger,
      mode: options.mode,
      hasTools: true,
      hasStructuredOutput: false,
      preferredDeploymentId: options.resolvedProfile?.effectiveModelId,
    });
    provider = routedGateway;
  } else {
    routedGateway = provider instanceof RoutedModelGateway ? provider : undefined;
    performanceLedger = routedGateway?.performanceLedger;
  }

  const mutationEngine = new MutationEngine(options.workspaceRoot);
  const verificationEngine = new VerificationEngine({ workspaceRoot: options.workspaceRoot });
  const checkpointCoordinator = new CheckpointCoordinator({
    workspaceRoot: options.workspaceRoot,
    mutationEngine,
  });
  
  let registry = createReadOnlyToolRegistry();
  
  if (options.isTrusted) {
    for (const r of createMutationToolRegistrations({ engine: mutationEngine })) {
      registry.register(r);
    }
    for (const r of createVerificationToolRegistrations(options.workspaceRoot)) {
      registry.register(r);
    }
  }

  if (options.browserSessionManager) {
    for (const r of createBrowserToolRegistrations(options.browserSessionManager)) {
      registry.register(r);
    }
  }

  const mcpCatalog = options.mcpCatalog ?? new McpCatalog(await loadMcpConfig(options.workspaceRoot), options.eventSink);
  if (!options.mcpCatalog) {
    await mcpCatalog.discover();
  }
  const mcpConfig = mcpCatalog.getConfig();
  
  const allMcpTools = mcpCatalog.getTools();
  const connectedServers = new Set(mcpCatalog.getConnectedServers());
  const eligibleMcpTools = allMcpTools.filter((t) => connectedServers.has(t.serverId));

  const { selected: selectedMcpTools, eligibleCount: toolsEligible } = selectMcpTools(eligibleMcpTools, {
    task: options.instruction,
    mode: options.mode,
    maxTools: 3,
    schemaBudget: 1500
  });

  const mcpStats = { callsStarted: 0, callsCompleted: 0, callsRejected: 0, callsCancelled: 0, callsTimedOut: 0, callsFailed: 0, resultBytesRetained: 0, resultsTruncated: 0, cleanupCount: 0 };
  
  for (const mcpTool of selectedMcpTools) {
    if (options.resolvedProfile && !options.resolvedProfile.activeMcpServers.includes(mcpTool.serverId)) {
      continue;
    }
    const transport = mcpCatalog.getTransport(mcpTool.serverId);
    if (transport) {
      registry.register(createMcpToolRegistration(mcpTool, transport, mcpConfig, mcpStats));
    }
  }

  if (options.resolvedProfile?.effectiveTools) {
    registry = registry.filterByName(new Set(options.resolvedProfile.effectiveTools));
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
  
  const skillsEnabled =
    options.skills?.enabled === true ||
    (options.resolvedProfile?.appliedSkills !== undefined &&
      options.resolvedProfile.appliedSkills.length > 0 &&
      process.env.OPEN_VS_CODE_SKILLS !== "0");
  let skillSelection: SkillSelectionResult | undefined;
  let actualSkillTokens = 0;
  const selectedSkills: LoadedSkill[] = [];
  let skillGuidance: readonly SkillGuidance[] = [];
  let skillEvidence: SkillEvidence = disabledSkillEvidence();
  let skillRegistry: SkillRegistry | undefined;

  if (skillsEnabled) {
    const builtinRoot = options.skills?.builtinRoot ?? defaultBuiltinSkillsRoot();
    skillRegistry = await SkillRegistry.discover({
      ...(builtinRoot ? { builtinRoot } : {}),
      workspaceRoot: options.workspaceRoot,
      workspaceTrusted: options.isTrusted,
    });
    const prepared = await prepareSkillGuidance({
      enabled: true,
      registry: skillRegistry,
      task: options.instruction,
      mode: options.mode,
      availableTools: registry.listDefinitions().map((definition) => definition.name),
      permissionEvaluator: classifyPermission,
      budget: contextBudget,
      reservedTokens: estimateTokens(options.instruction) + memory.estimatedTokens,
      ...(options.skills?.maxSkills !== undefined ? { maxSkills: options.skills.maxSkills } : {}),
      ...(options.resolvedProfile?.appliedSkills ? { explicitSkillIds: options.resolvedProfile.appliedSkills } : {}),
    });
    skillGuidance = prepared.guidance;
    skillEvidence = prepared.evidence;
    actualSkillTokens = skillEvidence.skillContextTokens;
  } else {
    // Frozen ADR-014 path (V1 behaviour), unchanged.
    const skills = await discoverSkills(options.workspaceRoot);
    const skillBudget = contextBudget.availableContext * 0.15;
    const legacySelection = selectSkills({ task: options.instruction, mode: options.mode, catalog: skills, budgetTokens: skillBudget });
    skillSelection = legacySelection;
    if (legacySelection.primarySkill) {
       let sections = [...legacySelection.primarySkill.sections];
       let loaded = await loadSkill(options.workspaceRoot, legacySelection.primarySkill.metadata, { sections });
       let t = estimateTokens(loaded.body);
       if (t > skillBudget) {
           sections = ["Intent", "When", "Inputs", "Procedure", "Template", "Expected Output"];
           loaded = await loadSkill(options.workspaceRoot, legacySelection.primarySkill.metadata, { sections });
           t = estimateTokens(loaded.body);
       }
       if (t > skillBudget) {
           sections = ["Intent", "When", "Procedure"];
           loaded = await loadSkill(options.workspaceRoot, legacySelection.primarySkill.metadata, { sections });
           t = estimateTokens(loaded.body);
       }
       if (t <= skillBudget) {
           selectedSkills.push(loaded);
           actualSkillTokens += t;
       }
    }
    for (const s of legacySelection.supportingSkills) {
       const loaded = await loadSkill(options.workspaceRoot, s.metadata, { sections: s.sections });
       const t = estimateTokens(loaded.body);
       if (actualSkillTokens + t <= skillBudget) {
           selectedSkills.push(loaded);
           actualSkillTokens += t;
       }
    }
  }

  // Sprint 5D: approved learning only, budget-selected before the run. Candidates never get here.
  let learning: LearningService | undefined;
  let learningRetrieval: LearningRetrieval | undefined;
  let learningOpenError: string | undefined;
  if (options.learning?.enabled === true) {
    try {
      // Built-ins only (metadata): a workspace override must not remove an id from the protected set.
      const builtinRoot = options.skills?.builtinRoot ?? defaultBuiltinSkillsRoot();
      const builtinIds = (await SkillRegistry.discover({ ...(builtinRoot ? { builtinRoot } : {}), workspaceTrusted: false })).entries.map((entry) => entry.id);
      learning = await openWorkspaceLearning({ workspaceRoot: options.workspaceRoot, enabled: true, workspaceTrusted: options.isTrusted, builtinSkillIds: builtinIds });
      learningRetrieval = learning.retrieve({ task: options.instruction, mode: options.mode, availableContext: contextBudget.availableContext });
    } catch (error) {
      // Learning is advisory: a store that cannot be opened leaves the run exactly as with learning off.
      learning = undefined;
      learningOpenError = error instanceof Error ? error.message.slice(0, 200) : "learning store unavailable";
    }
  }
  const learnedMemory = learningRetrieval?.items ?? [];

  // Final-context truth (ADR-029): a skill counts as applied only if the compiler kept it in a request.
  const skillTracker = new SkillInjectionTracker(skillEvidence, skillGuidance);
  const contextCompiler = (input: ContextCompilerInput) => {
    const compiled = compileContext(input);
    skillTracker.observe(compiled);
    return compiled;
  };

  const modeProjectInstructions: ProjectInstruction[] = [];
  if (options.resolvedProfile?.customInstructions) {
    modeProjectInstructions.push({
      id: `mode-instructions:${options.resolvedProfile.profileId}`,
      path: `.open-vs-code/modes/${options.resolvedProfile.profileId}.json`,
      content: `[Mode Instructions: ${options.resolvedProfile.profileName}]\n${options.resolvedProfile.customInstructions}`,
    });
  }
  if (options.resolvedProfile?.contextGuidance) {
    modeProjectInstructions.push({
      id: `mode-context-guidance:${options.resolvedProfile.profileId}`,
      path: `.open-vs-code/modes/${options.resolvedProfile.profileId}.context.json`,
      content: `[Mode Context Guidance: ${options.resolvedProfile.profileName}]\n${options.resolvedProfile.contextGuidance}`,
    });
  }

  const runnerInput = {
    task: { id: `session-${Date.now()}`, mode: options.mode, instruction: options.instruction },
    workspaceRoot: options.workspaceRoot,
    maxTurns: 15,
    contextBudget,
    projectInstructions: modeProjectInstructions,
    ...(options.recentTurns ? { recentTurns: options.recentTurns } : {}),
    memory,
    selectedSkills,
    ...(skillGuidance.length > 0 ? { skillGuidance } : {}),
    ...(learnedMemory.length > 0 ? { learnedMemory } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const progressMonitorEnabled = options.progressMonitor?.enabled === true;
  const progressMonitor = progressMonitorEnabled ? { progressMonitor: { enabled: true } } : {};

  const runner = new AgentRunner({
    provider,
    registry,
    permissionEvaluator: classifyPermission,
    evidenceGate: false,
    eventSink: options.eventSink,
    checkpointCoordinator,
    contextCompiler,
    ...(performanceLedger ? { performanceLedger } : {}),
    ...progressMonitor,
  });

  const workflowEnabled = options.resolvedProfile
    ? options.resolvedProfile.effectiveWorkflow === "structured" && options.workflow?.enabled === true
    : options.workflow?.enabled === true;

  const isReaInvestigationWorkflow =
    options.resolvedProfile?.profileId === "rea-investigation" ||
    options.resolvedProfile?.profileId === "rea-investigation-pack-mode" ||
    (options.resolvedProfile?.appliedSkills !== undefined &&
      (options.resolvedProfile.appliedSkills.includes("rea-investigation-routing") ||
       options.resolvedProfile.appliedSkills.includes("browser-behavior-investigation") ||
       options.resolvedProfile.appliedSkills.includes("javascript-electron-analysis") ||
       options.resolvedProfile.appliedSkills.includes("native-artifact-analysis"))) ||
    options.instruction.toLowerCase().includes("rea-investigation") ||
    options.instruction.toLowerCase().includes("investigate-application") ||
    (options.mode === "REVIEW" &&
      (options.instruction.toLowerCase().includes("investigate") &&
       (options.instruction.toLowerCase().includes("http") || options.instruction.toLowerCase().includes("url") || options.instruction.toLowerCase().includes("target"))));

  const isReaReconstructionWorkflow =
    options.resolvedProfile?.profileId === "rea-reconstruction" ||
    options.resolvedProfile?.profileId === "rea-reconstruction-pack-mode" ||
    (options.resolvedProfile?.appliedSkills !== undefined &&
      (options.resolvedProfile.appliedSkills.includes("reconstruction-planning") ||
       options.resolvedProfile.appliedSkills.includes("reconstruction-verification"))) ||
    options.instruction.toLowerCase().includes("rea-reconstruction") ||
    options.instruction.toLowerCase().includes("clean-room reconstruction");

  const isReaWorkflow = isReaInvestigationWorkflow || isReaReconstructionWorkflow;

  const rawEligibility: WorkflowEligibility = assessWorkflowEligibility({
    enabled: workflowEnabled,
    mode: options.mode,
    instruction: options.instruction,
    isTrusted: options.isTrusted,
  });

  const workflowEligibility: WorkflowEligibility =
    (isReaWorkflow && workflowEnabled && options.isTrusted)
      ? { eligible: true, reason: "ELIGIBLE" }
      : rawEligibility;

  const isDesignWorkflow =
    options.resolvedProfile?.profileId === "advanced-design-motion" ||
    (options.resolvedProfile?.appliedSkills !== undefined &&
      options.resolvedProfile.appliedSkills.includes("design-direction")) ||
    options.instruction.toLowerCase().includes("advanced design") ||
    options.instruction.toLowerCase().includes("design-workflow");

  if (isReaWorkflow || isDesignWorkflow) {
    const specializationName = isReaWorkflow
      ? (isReaInvestigationWorkflow ? "REA Investigation" : "REA Reconstruction")
      : "Advanced Design & Motion";

    if (!options.isTrusted && (isReaReconstructionWorkflow || isDesignWorkflow)) {
      throw new Error(`Specialized workflow "${specializationName}" requires a trusted workspace (UNSUPPORTED).`);
    }

    if (!workflowEnabled) {
      throw new Error(
        `Specialized workflow "${specializationName}" is currently disabled. Enable structured engineering workflow in Settings (open-vs-code.workflow.enabled: true) or run "Open VS Code: Enable Structured Workflow" to use this specialization.`
      );
    }
  }

  const workflow = isReaWorkflow
    ? isReaInvestigationWorkflow
      ? GovernedReaWorkflow.startInvestigation({
          workspaceRoot: options.workspaceRoot,
          mutationEngine,
          checkpointCoordinator,
          browserSessionManager: options.browserSessionManager,
          mcpCatalog: options.mcpCatalog,
          provider,
          onStage: options.workflow?.onStage as any,
          eventSink: options.eventSink,
          signal: options.signal,
          task: options.instruction,
          taskId: runnerInput.task.id,
          skills: skillRegistry,
          accountScope: options.accountScope,
        })
      : GovernedReaWorkflow.startReconstruction({
          workspaceRoot: options.workspaceRoot,
          mutationEngine,
          checkpointCoordinator,
          browserSessionManager: options.browserSessionManager,
          mcpCatalog: options.mcpCatalog,
          verificationEngine,
          provider,
          onStage: options.workflow?.onStage as any,
          eventSink: options.eventSink,
          signal: options.signal,
          task: options.instruction,
          taskId: runnerInput.task.id,
          skills: skillRegistry,
          accountScope: options.accountScope,
          evidenceBundle: options.initialEvidenceBundle,
          testRunner: (options as any).testRunner,
        })
    : isDesignWorkflow
      ? GovernedDesignWorkflow.start({
          workspaceRoot: options.workspaceRoot,
          mutationEngine,
          checkpointCoordinator,
          browserSessionManager: options.browserSessionManager,
          provider,
          onStage: options.workflow?.onStage as any,
          signal: options.signal,
          task: options.instruction,
          taskId: runnerInput.task.id,
          skills: skillRegistry,
        })
      : workflowEligibility.eligible
        ? EngineeringWorkflow.start(
          {
            provider,
            registry,
            permissionEvaluator: classifyPermission,
            verifier: createWorkspaceVerifier(options.workspaceRoot, verificationEngine),
            workspaceRoot: options.workspaceRoot,
            contextBudget,
            store: new CheckpointWorkflowStore(checkpointCoordinator.checkpointStore),
            checkpointCoordinator,
            eventSink: options.eventSink,
            ...(options.workflow?.onStage ? { onStage: options.workflow.onStage } : {}),
            ...(skillRegistry ? { skills: { registry: skillRegistry } } : {}),
            ...(progressMonitorEnabled ? { progress: { enabled: true } } : {}),
            ...(progressMonitorEnabled && options.progressMonitor?.onProgress ? { onProgress: options.progressMonitor.onProgress } : {}),
          },
          {
            task: options.instruction,
            mode: options.mode,
            taskId: runnerInput.task.id,
            memoryDigest: [
              ...memory.projectFacts.map((fact) => fact.content),
              ...memory.decisions.map((decision) => `Decision ${decision.id}: ${decision.summary}`),
              ...learnedMemory.map((item) => item.content),
            ].join("\n"),
            constraints: memory.decisions.map((decision) => `${decision.id}: ${decision.summary}`).join("\n"),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        )
      : undefined;

  const repairOrchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 3, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 20 },
    verificationEngine,
    () => new AgentRunner({
      provider: provider!,
      registry,
      permissionEvaluator: classifyPermission,
      evidenceGate: false,
      eventSink: options.eventSink,
      checkpointCoordinator,
      contextCompiler,
      ...(performanceLedger ? { performanceLedger } : {}),
      ...progressMonitor,
    })
  );

  return {
    runner,
    repairOrchestrator,
    runnerInput,
    mcpCatalog,
    mcpStats,
    routedGateway,
    readRouteIdentity(): ConfiguredRouteIdentity | undefined {
      const route = routedGateway?.lastDiagnostics?.route;
      if (!route || !routingConfig) return undefined;
      return formatRouteIdentity(routingConfig, route.deploymentId, route.providerId, route.modelId);
    },
    mcpSnapshot,
    skillSelection,
    actualSkillTokens,
    selectedSkills,
    skillGuidance,
    /** Reconciled with the final compiled context on every read. */
    get skillEvidence(): SkillEvidence {
      return skillTracker.evidence;
    },
    skillRegistry,
    memory,
    /** Sprint 5D learning service (undefined when disabled) and what it retrieved for this task. */
    learning,
    learningRetrieval,
    learningOpenError,
    /**
     * Runs the bounded learning step after the task has finished. Never throws and never changes the
     * task's result; a no-op when learning is disabled.
     */
    learnAfter: (input: LearningTaskInput): Promise<LearningStepResult> =>
      runLearningStep(learning, input, async (relativePath) => {
        try {
          await resolveRepositoryPath(options.workspaceRoot, relativePath);
          return true;
        } catch {
          return false;
        }
      }),
    workflow,
    workflowEligibility,
    checkpointCoordinator,
    recoveryController: checkpointCoordinator.recoveryController,
    performanceLedger: routedGateway?.performanceLedger,
    healthChecker,
    cleanup: async () => {
      if (!options.mcpCatalog) {
        await mcpCatalog.close();
      }
      mcpStats.cleanupCount += 1;
    }
  };
}
