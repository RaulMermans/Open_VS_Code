import { AgentRunner } from "@open-vs-code/agent-core";
import { loadMcpConfig } from "./mcp-loader.ts";
import { McpCatalog, selectMcpTools, createMcpToolRegistration } from "@open-vs-code/agent-core";
import { RepairOrchestrator } from "@open-vs-code/agent-core";
import { MutationEngine } from "@open-vs-code/agent-core";
import { VerificationEngine } from "@open-vs-code/agent-core";
import { createReadOnlyToolRegistry } from "@open-vs-code/agent-core";
import { createMutationToolRegistrations } from "@open-vs-code/agent-core";
import { createVerificationToolRegistrations } from "@open-vs-code/agent-core";
import { calculateBudget, classifyPermission, ProjectMemoryLoader, SessionSummaryStorage, MemoryRetriever, discoverSkills, selectSkills, loadSkill, estimateTokens } from "@open-vs-code/agent-core";
import { RoutedModelGateway, loadRoutingConfig, StaticHealthChecker } from "@open-vs-code/agent-core";
import * as readline from "node:readline/promises";

import type { AgentMode, AgentEvent } from "@open-vs-code/agent-core";
import type { ModelProvider } from "@open-vs-code/agent-core";

export interface CLIAppOptions {
  mode: AgentMode;
  instruction: string;
  workspaceRoot: string;
  json?: boolean;
  provider?: ModelProvider;
  mockApproval?: "APPROVE" | "REJECT" | (() => Promise<"APPROVE" | "REJECT">);
}



export async function runCLI(options: CLIAppOptions): Promise<any> {
  const startedAt = new Date().toISOString();
  let provider: ModelProvider = options.provider as any;
  if (!provider) {
    // 1. Try to load routing config from workspace
    const config = await loadRoutingConfig(options.workspaceRoot);
    
    if (config) {
      // 2. Set up providers registry.
      const { ScriptedModelProvider, OpenAICompatibleProvider } = await import("@open-vs-code/agent-core");
      const providers = new Map<string, ModelProvider>();

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

      // 3. Initialize Gateway
      // For now, assume deployments are healthy.
      const healthChecker = new StaticHealthChecker(
        new Map(config.deployments.map(d => [d.id, "ready" as const]))
      );

      // The ContextBudget will be formally calculated later, but we can pass undefined 
      // here and the gateway will use DEFAULT_OUTPUT_RESERVE
      provider = new RoutedModelGateway({
        config,
        providers,
        healthChecker,
        mode: options.mode,
        hasTools: true, // We always provide tools in the CLI
        hasStructuredOutput: false, // Not using structured output yet
      });
    } else if (process.env.OPEN_VS_CODE_MOCK_MODEL === "1") {
      provider = {
        capabilities: new Set(["chat", "tools"] as any),
        async complete() {
          return { model: "mock", message: { role: "assistant", content: "hi" }, usage: { inputTokens: 0, outputTokens: 0 } };
        }
      };
    } else {
      // If no routing config and no mock, we throw configuration error
      console.error("\nModel configuration error: Live open-weight inference is configured on the target inference machine.\n"); throw new Error("Model configuration error: Live open-weight inference is configured on the target inference machine.");
    }
  }
  
  // Track the routed gateway for reporting diagnostics later
  const routedGateway = provider instanceof RoutedModelGateway ? provider : undefined;

  const mutationEngine = new MutationEngine(options.workspaceRoot);
  const verificationEngine = new VerificationEngine({ workspaceRoot: options.workspaceRoot });
  
  const registry = createReadOnlyToolRegistry();
  for (const r of createMutationToolRegistrations({ engine: mutationEngine })) {
    registry.register(r);
  }
  for (const r of createVerificationToolRegistrations(options.workspaceRoot)) {
    registry.register(r);
  }


  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

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
    
    // Event rendering logic
    switch (ev.type) {
      case "task.started":
        console.log(`\nStarting ${options.mode} task...`);
        break;
      case "tool.requested":
        if (ev.payload && ((ev.payload as any).name === "find_files" || (ev.payload as any).name === "search_text")) {
          console.log(`  🔍 searching workspace`);
        } else if (ev.payload && (ev.payload as any).name === "read_file") {
          console.log(`  📖 reading file`);
        }
        break;
      case "tool.completed":
        if (ev.payload && ((ev.payload as any).name === "find_files" || (ev.payload as any).name === "search_text")) {
          console.log(`  ✓ searched`);
        } else if (ev.payload && (ev.payload as any).name === "read_file") {
          console.log(`  ✓ read`);
        }
        break;
      case "mutation.prepared":
        console.log(`\nCHANGE`);
        console.log(`  waiting for approval...`);
        break;
      case "verification.prepared":
        console.log(`\nVERIFY`);
        console.log(`  waiting for approval...`);
        break;
      case "repair.started":
        console.log(`\nREPAIR (Attempt ${(ev.payload as any)?.attempt || 1})`);
        break;
      case "verification.completed":
        const vRes = (ev.payload as any)?.result;
        if (vRes) {
          console.log(`  ${vRes.action} → ${vRes.success ? "PASS" : "FAIL"}`);
          if (!vRes.success && vRes.output) {
             const lines = vRes.output.split('\n').slice(0, 10).join('\n');
             console.log(`\n  <bounded relevant output>\n${lines}\n  </bounded relevant output>`);
          }
        }
        break;
    }
  };

  const mcpConfig = await loadMcpConfig(options.workspaceRoot);
  const mcpCatalog = new McpCatalog(mcpConfig, sink);
  await mcpCatalog.discover();
  const allMcpTools = mcpCatalog.getTools();
  const { selected: selectedMcpTools, eligibleCount: toolsEligible } = selectMcpTools(allMcpTools, {
    task: options.instruction,
    mode: options.mode,
    maxTools: 3,
    schemaBudget: 1500
  });

  const mcpStats = {
    callsStarted: 0,
    callsCompleted: 0,
    callsRejected: 0,
    callsCancelled: 0,
    callsTimedOut: 0,
    callsFailed: 0,
    resultBytesRetained: 0,
    resultsTruncated: 0,
  };

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
    estimatedSchemaTokens: selectedMcpTools.reduce((acc, t) => acc + t.estimatedSchemaTokens, 0),
    schemaBudget: 1500,
    ...mcpStats
  });

  const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 });
  

  const memoryLoader = new ProjectMemoryLoader(options.workspaceRoot);
  const memorySnapshot = await memoryLoader.load();
  const sessionStorage = new SessionSummaryStorage({ workspaceRoot: options.workspaceRoot });
  const { sessions } = await sessionStorage.load();
  const retriever = new MemoryRetriever(memorySnapshot, sessions);
  const memory = retriever.select({
    task: options.instruction,
    mode: options.mode,
    tokenBudget: 1500
  });

  if (!options.json) {
    let memSummary = [];
    if (memory.projectFacts.length) memSummary.push(`${memory.projectFacts.length} facts`);
    if (memory.decisions.length) memSummary.push(`${memory.decisions.length} decisions`);
    if (memory.activeTasks.length) memSummary.push(`${memory.activeTasks.length} active tasks`);
    if (memory.sessionSummaries.length) memSummary.push(`${memory.sessionSummaries.length} prior sessions`);
    if (memSummary.length > 0) {
      console.log(`Project context restored:\n- ${memSummary.join('\n- ')}`);
    }
  }

  // T-652: Skill Discovery and Selection
  const skills = await discoverSkills(options.workspaceRoot);
  const skillBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 }).availableContext * 0.15; // roughly 15%
  const skillSelection = selectSkills({
    task: options.instruction,
    mode: options.mode,
    catalog: skills,
    budgetTokens: skillBudget
  });

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

  const runnerInput: any = {
    task: { id: "cli-task", mode: options.mode, instruction: options.instruction },
    workspaceRoot: options.workspaceRoot,
    maxTurns: 15,
    contextBudget,
    projectInstructions: [],
    memory,
    selectedSkills
  };

  let finalResult: any;
  let sigintHandler: any;

  try {
    if (options.mode === "DEBUG") {
      // For DEBUG, we can use the repair loop if there's a verification target. 
      // Actually DEBUG can just run as normal AgentRunner until it wants to verify.
      // Wait, T-315: DEBUG should use disciplined loop: reproduce / inspect -> hypotheses -> targeted checks -> root cause -> minimal patch -> verification.
      // RepairOrchestrator requires a `PreparedVerification` to start.
      // So if mode is DEBUG, we first run the agent to prepare a verification or fix something.
      // We will just use the agent runner. If it prepares a verification, we can hand it off to the repair orchestrator?
      // For CLI, using AgentRunner handles the loop up to CONFIRM.
    }

    const runner = new AgentRunner({
      provider,
      registry,
      permissionEvaluator: classifyPermission,
      evidenceGate: false,
      eventSink: sink
    });

    // Handle cancellation
    const ac = new AbortController();
    sigintHandler = () => {
      console.log("\nCancelling...");
      ac.abort();
    };
    process.on("SIGINT", sigintHandler);
    runnerInput.signal = ac.signal;

    let runnerResult = await runner.run(runnerInput as any);

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
          mcpStats.callsRejected++;
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
          if (options.mode === "DEBUG" || options.mode === "BUILD") {
            const repair = new RepairOrchestrator(
              { maxRepairAttempts: 3, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 20 },
              verificationEngine,
              () => new AgentRunner({ provider, registry, permissionEvaluator: classifyPermission, evidenceGate: false, eventSink: sink })
            );
            
            let repairResult = await repair.run(runnerInput as any, conf.preparedMutation as any);
            
            while (repairResult.status === "AWAITING_MUTATION_APPROVAL" || repairResult.status === "AWAITING_VERIFICATION_APPROVAL") {
              if (repairResult.status === "AWAITING_MUTATION_APPROVAL") {
                const pm = repairResult.pendingReview as any;
                if (!options.json) {
                  console.log(`\nProposed Mutation (Repair):`);
                  console.log(`File: ${pm.path}`);
                  console.log(`Operation: ${pm.operation}`);
                  console.log(`Hash before: ${pm.beforeHash.substring(0, 8)}`);
                  console.log(`Lines added: ${pm.linesAdded}, removed: ${pm.linesRemoved}`);
                  console.log(`\n--- old`);
                  console.log(`+++ new`);
                  console.log(pm.diff);
                }
                const repApproved = await confirm("\nApprove this change? [y/N] ");
                repairResult = await repair.resume(repApproved ? "APPROVE" : "REJECT");
              } else if (repairResult.status === "AWAITING_VERIFICATION_APPROVAL") {
                const pv = repairResult.pendingReview as any;
                if (!options.json) {
                  console.log(`\nProposed Verification (Repair):`);
                  console.log(`Action: ${pv.arguments?.action || "TEST"}`);
                }
                const repApproved = await confirm("\nRun this verification? [y/N] ");
                repairResult = await repair.resume(repApproved ? "APPROVE" : "REJECT");
              }
            }
            
            finalResult = repairResult;
            break; // End the main runner loop since repair took over
          } else {
            runnerResult = await runner.resume("APPROVE");
          }
        } else {
          if (!options.json) console.log("REJECT");
          runnerResult = await runner.resume("REJECT");
        }
      }
    }

    if (!finalResult) finalResult = runnerResult;
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ status: "ERROR", error: err.message }, null, 2));
    } else {
      console.error(`\nError: ${err.message}`);
    }
    const mcpDiagnostics = mcpSnapshot();
    await mcpCatalog.close();
    rl.close();
  // Remove listener
  if (typeof sigintHandler !== "undefined") {
    process.removeListener("SIGINT", sigintHandler);
  }
    return { exitCode: 3, mcpDiagnostics }; // config / runtime error
  }

  const mcpDiagnostics = mcpSnapshot();
  await mcpCatalog.close();
  rl.close();



  console.log(`\nStatus: ${finalResult.status}`);
  console.log(`Mode: ${options.mode}`);
  if (finalResult.failureReason) {
    console.log(`Reason: ${finalResult.failureReason}`);
  }
  
  // Extract summary stats from events
  const changedFiles = new Set<string>();
  const mutationPaths = new Map<string, string>();
  let mutations = 0;
  let verifications = 0;
  for (const ev of finalResult.events) {
    if (ev.type === "mutation.prepared") {
       if (ev.payload?.mutationId && ev.payload?.path) {
         mutationPaths.set(ev.payload.mutationId, ev.payload.path);
       }
    }
    if (ev.type === "mutation.confirmation_requested") {
       // do not add here, wait for applied
    }
    if (ev.type === "mutation.applied") {
      mutations++;
      if (ev.payload?.mutationId) {
         const path = mutationPaths.get(ev.payload.mutationId);
         if (path) changedFiles.add(path);
      }
    }
    if (ev.type === "verification.completed") verifications++;
  }


  const summary = {
    sessionId: `session-${Date.now()}`,
    startedAt,
    completedAt: new Date().toISOString(),
    mode: options.mode,
    task: options.instruction,
    outcome: finalResult.status,
    changedFiles: Array.from(changedFiles),
    decisions: [],
    unresolvedIssues: finalResult.failureReason ? [finalResult.failureReason] : [],
  };
  const appendResult = await sessionStorage.append(summary);
  if (appendResult === "SKIPPED_CORRUPT_STATE" && !options.json) {
    console.warn("\nWarning: Session continuity: not saved — existing memory state is corrupt");
  } else if (appendResult === "REJECTED_OVERSIZED" && !options.json) {
    console.warn("\nWarning: Session continuity: not saved — session summary exceeds hard size limit");
  } else if (appendResult === "FAILED" && !options.json) {
    console.warn("\nWarning: Session continuity: not saved — storage write failed");
  }

  const skillDiagnostics = {
    skillsDiscovered: skillSelection.skillsDiscovered,
    skillsEligible: skillSelection.skillsEligible,
    skillsSelected: skillSelection.skillsSelected,
    primarySkill: skillSelection.primarySkill ? skillSelection.primarySkill.metadata.id : undefined,
    supportingSkills: skillSelection.supportingSkills.map(s => s.metadata.id),
    loadedSections: [
      ...(skillSelection.primarySkill ? skillSelection.primarySkill.sections : []),
      ...skillSelection.supportingSkills.flatMap(s => s.sections)
    ],
    selectorEstimatedTokens: skillSelection.estimatedSkillTokens,
    actualCompiledSkillTokens: actualSkillTokens,
    skillBudget: skillSelection.skillBudget,
    skillsDroppedForBudget: skillSelection.skillsDroppedForBudget,
    reasonCodes: [
      ...(skillSelection.primarySkill ? [skillSelection.primarySkill.reason] : []),
      ...skillSelection.supportingSkills.map(s => s.reason)
    ],
  };

  if (options.json) {
    console.log(JSON.stringify({ ...finalResult, skillDiagnostics, mcpDiagnostics, routeDiagnostics: routedGateway?.lastDiagnostics }, null, 2));
    return { exitCode: finalResult.status === "COMPLETED" ? 0 : (finalResult.status === "CANCELLED" ? 2 : 1), memorySelection: memory, skillDiagnostics, mcpDiagnostics, routeDiagnostics: routedGateway?.lastDiagnostics, ...finalResult };
  }

  if (changedFiles.size > 0) {
    console.log(`\nFiles changed:`);
    for (const f of changedFiles) {
      console.log(`- ${f}`);
    }
  }

  if (verifications > 0) {
    console.log(`\nVerification runs: ${verifications}`);
  }

  if (routedGateway?.lastDiagnostics) {
    const diag = routedGateway.lastDiagnostics;
    console.log(`\nModel Route:`);
    console.log(`- Provider: ${diag.route.providerId}`);
    console.log(`- Model: ${diag.route.modelId}`);
    console.log(`- Deployment: ${diag.route.deploymentId}`);
    console.log(`- Task Class: ${diag.route.taskClass}`);
    if (diag.route.fallbackLevel > 0) {
      console.log(`- Fallback Level: ${diag.route.fallbackLevel}`);
    }
  }

  console.log(`\nTurns: ${finalResult.turns}`);

  let exitCode = 0;
  if (finalResult.status === "FAILED") exitCode = 1;
  if (finalResult.status === "CANCELLED") exitCode = 2;

  return { exitCode, memorySelection: memory, skillDiagnostics, routeDiagnostics: routedGateway?.lastDiagnostics, ...finalResult };
}
