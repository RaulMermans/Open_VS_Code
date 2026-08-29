import readline from "node:readline";
import { AgentRunner } from "@open-vs-code/agent-core/runner";
import { RepairOrchestrator } from "@open-vs-code/agent-core/repair";
import { MutationEngine } from "@open-vs-code/agent-core/mutations";
import { createMutationToolRegistrations } from "@open-vs-code/agent-core/mutation-registry";
import { VerificationEngine } from "@open-vs-code/agent-core/verifications";
import { createVerificationToolRegistrations } from "@open-vs-code/agent-core/verification-registry";
import { createReadOnlyToolRegistry } from "@open-vs-code/agent-core/read-only-registry";
import { calculateBudget } from "@open-vs-code/agent-core/budget";
import type { AgentEvent, AgentMode } from "@open-vs-code/agent-core/contracts";
import type { PreparedVerification } from "@open-vs-code/agent-core/verification-contracts";

// Assuming we have a production provider like LLM provider
// For now, we fall back to a mock or throw if it isn't wired up to the real LLM endpoint
export interface CLIOptions {
  readonly mode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW";
  readonly instruction: string;
  readonly workspaceRoot: string;
  readonly json?: boolean;
  readonly mockApproval?: "APPROVE" | "REJECT";
}

export async function runCLI(options: CLIOptions): Promise<{ exitCode: number }> {
  // Setup real provider
  // Since we are running on the target machine without local model weights,
  // we would connect to the designated inference endpoint.
  let provider: any;
  try {
    const { HttpModelProvider } = await import("@open-vs-code/agent-core/http-model");
    provider = new HttpModelProvider();
  } catch (e) {
    provider = {
      async executeNextTurn() {
        throw new Error("Model configuration error: Live open-weight inference is configured on the target inference machine.");
      },
      async complete() {
        console.error("\nModel configuration error: Live open-weight inference is configured on the target inference machine.\n"); throw new Error("Model configuration error: Live open-weight inference is configured on the target inference machine.");
      }
    };
  }

  const mutationEngine = new MutationEngine(options.workspaceRoot);
  const verificationEngine = new VerificationEngine({ workspaceRoot: options.workspaceRoot });
  
  const registry = createReadOnlyToolRegistry();
  for (const r of createMutationToolRegistrations({ engine: mutationEngine })) {
    registry.register(r);
  }
  for (const r of createVerificationToolRegistrations(options.workspaceRoot)) {
    registry.register(r);
  }

  const permissionEvaluator = (inputCtx: { readonly action: string; readonly mode: AgentMode }) => {
    // Hard rules from agent core policy
    if (inputCtx.action === "run_shell" || inputCtx.action === "shell") {
      return "DENIED";
    }
    if (["ASK", "PLAN", "REVIEW"].includes(inputCtx.mode)) {
      if (inputCtx.action === "write_file" || inputCtx.action === "run_known_test") return "DENIED";
    }
    if (inputCtx.action === "write_file" || inputCtx.action === "run_known_test") {
      return "CONFIRM";
    }
    return "ALLOW";
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const confirm = async (prompt: string): Promise<boolean> => {
    if (options.mockApproval) {
      if (!options.json) console.log(prompt + options.mockApproval);
      return options.mockApproval === "APPROVE";
    }
    const answer = await new Promise<string>(r => rl.question(prompt, r));
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
        if (ev.payload && (ev.payload as any).name === "search_files") {
          console.log(`  🔍 searching workspace`);
        } else if (ev.payload && (ev.payload as any).name === "read_file") {
          console.log(`  📖 reading file`);
        }
        break;
      case "tool.completed":
        if (ev.payload && (ev.payload as any).name === "search_files") {
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
          console.log(`  ${vRes.action} → ${vRes.status}`);
          if (vRes.status !== "PASS" && vRes.stdout) {
             const lines = vRes.stdout.split('\n').slice(0, 10).join('\n');
             console.log(`\n  <bounded relevant output>\n${lines}\n  </bounded relevant output>`);
          }
        }
        break;
    }
  };

  const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 });
  
  const runnerInput: any = {
    task: { id: "cli-task", mode: options.mode, instruction: options.instruction },
    workspaceRoot: options.workspaceRoot,
    maxTurns: 15,
    contextBudget,
    projectInstructions: []
  };

  let finalResult: any;

  try {
    const ac = new AbortController();
    process.on("SIGINT", () => {
      console.log("\nCancelling...");
      ac.abort();
    });
    runnerInput.signal = ac.signal;

    if (options.mode === "DEBUG") {
      const orchestrator = new RepairOrchestrator(
        { maxRepairAttempts: 5, maxMutations: 10, maxVerificationRuns: 10, maxTotalAgentTurns: 30 },
        verificationEngine,
        () => new AgentRunner({
          provider,
          registry,
          permissionEvaluator: permissionEvaluator as any,
          evidenceGate: false,
          eventSink: sink
        })
      );
      
      const actionRaw = options.instruction.trim().toUpperCase();
      const validActions = ["TEST", "TYPECHECK", "LINT", "BUILD"];
      if (!validActions.includes(actionRaw)) {
        throw new Error(`DEBUG mode requires a verification action (${validActions.join(", ")}) as the instruction. Example: open-vscode-agent DEBUG TEST`);
      }
      
      const preparedVerifRaw = registry.prepare({ id: "init-v", name: "run_verification", arguments: { action: actionRaw } });
      const reviewableVerif = await preparedVerifRaw.prepareForReview!({ workspaceRoot: options.workspaceRoot, signal: ac.signal });
      const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification;

      let result = await orchestrator.run(runnerInput, preparedVerification);
      
      while (result.status === "AWAITING_MUTATION_APPROVAL" || result.status === "AWAITING_VERIFICATION_APPROVAL") {
         if (result.status === "AWAITING_MUTATION_APPROVAL") {
            const pm = result.pendingReview;
            if (!options.json) {
              console.log(`\nProposed Mutation:`);
              console.log(`File: ${pm.path}`);
              console.log(`Operation: ${pm.operation}`);
              console.log(`\n--- old`);
              console.log(`+++ new`);
              console.log(pm.diff);
            }
            const approved = await confirm("\nApprove this change? [y/N] ");
            result = await orchestrator.resume(approved ? "APPROVE" : "REJECT");
         } else {
            const pv = result.pendingReview;
            if (!options.json) {
              console.log(`\nProposed Verification:`);
              console.log(`Action: ${pv.action}`);
              console.log(`Command: ${pv.commandPreview}`);
            }
            const approved = await confirm("\nRun this verification? [y/N] ");
            result = await orchestrator.resume(approved ? "APPROVE" : "REJECT");
         }
      }
      finalResult = { ...result, turns: result.totalAgentTurns };
    } else {
      const runner = new AgentRunner({
        provider,
        registry,
        permissionEvaluator: permissionEvaluator as any,
        evidenceGate: false,
        eventSink: sink
      });

      let runnerResult = await runner.run(runnerInput as any);

      while (runnerResult.status === "PAUSED") {
        const conf = runnerResult.confirmation!;
        
        if (conf.action === "write_file") {
          const pm = conf.preparedMutation!;
          if (!options.json) {
            console.log(`\nProposed Mutation:`);
            console.log(`File: ${pm.path}`);
            console.log(`Operation: ${pm.operation}`);
            console.log(`Lines added: ${pm.linesAdded}, removed: ${pm.linesRemoved}`);
            console.log(`\n--- old`);
            console.log(`+++ new`);
            console.log(pm.diff);
          }

          const approved = await confirm("\nApprove this change? [y/N] ");
          runnerResult = await runner.resume(approved ? "APPROVE" : "REJECT");
        } else if (conf.action === "run_known_test") {
          if (!options.json) {
            console.log(`\nProposed Verification:`);
            console.log(`Action: ${conf.arguments.action}`);
            console.log(`Working directory: ${options.workspaceRoot}`);
          }
          
          const approved = await confirm("\nRun this verification? [y/N] ");
          runnerResult = await runner.resume(approved ? "APPROVE" : "REJECT");
        }
      }
      finalResult = runnerResult;
    }
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ status: "ERROR", error: err.message }, null, 2));
    } else {
      console.error(`\nError: ${err.message}`);
    }
    rl.close();
    return { exitCode: 3 };
  }

  rl.close();

  if (options.json) {
    console.log(JSON.stringify(finalResult, null, 2));
    return { exitCode: finalResult.status === "COMPLETED" ? 0 : (finalResult.status === "CANCELLED" ? 2 : 1) };
  }

  console.log(`\nStatus: ${finalResult.status}`);
  console.log(`Mode: ${options.mode}`);
  if (finalResult.failureReason) {
    console.log(`Reason: ${finalResult.failureReason}`);
  }
  
  const changedFiles = new Set<string>();
  let mutations = 0;
  let verifications = 0;
  for (const ev of finalResult.events || []) {
    if (ev.type === "mutation.applied") {
      mutations++;
    }
    if (ev.type === "mutation.confirmation_requested") {
       if (ev.payload?.preparedMutation?.path) {
         changedFiles.add(ev.payload.preparedMutation.path);
       }
    }
    if (ev.type === "verification.completed") verifications++;
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

  console.log(`\nTurns: ${finalResult.turns || 0}`);

  let exitCode = 0;
  if (finalResult.status === "FAILED") exitCode = 1;
  if (finalResult.status === "CANCELLED") exitCode = 2;

  return { exitCode };
}
