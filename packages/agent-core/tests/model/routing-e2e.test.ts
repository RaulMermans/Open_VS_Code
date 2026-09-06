import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse, ModelProvider, ModelRequest } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { RepairOrchestrator } from "../../src/agent/repair-loop.ts"
import { ModelRouter, type HealthChecker } from "../../src/model/router.ts"
import type { RoutingConfiguration, ModelRouteRequirements, ProviderHealthState, RouteDecision } from "../../src/contracts/routing.ts"

const workspaceRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")
const contextBudget = calculateBudget({ contextWindow: 32_000, reservedOutput: 100, reservedToolHistory: 100 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

const config: RoutingConfiguration = {
  providers: [
    { id: "scripted-general", kind: "scripted" },
    { id: "scripted-coding", kind: "scripted" },
    { id: "scripted-fallback", kind: "scripted" },
  ],
  models: [
    { id: "gen-mod", contextWindow: 32000, capabilities: ["toolUse"], specialization: "general" },
    { id: "code-mod", contextWindow: 32000, capabilities: ["toolUse", "coding"], specialization: "coding" },
  ],
  deployments: [
    { id: "dep-general", providerId: "scripted-general", modelId: "gen-mod", enabled: true, priority: 10 },
    { id: "dep-coding", providerId: "scripted-coding", modelId: "code-mod", enabled: true, priority: 5 },
    { id: "dep-fallback", providerId: "scripted-fallback", modelId: "code-mod", enabled: true, priority: 1 },
  ],
  routes: {
    general: ["dep-general", "dep-coding"],
    coding: ["dep-coding", "dep-fallback"],
  }
}

class TestHealthChecker implements HealthChecker {
  unavailableDeployments = new Set<string>()
  async checkHealth(deploymentId: string): Promise<ProviderHealthState> {
    if (this.unavailableDeployments.has(deploymentId)) return "unavailable"
    return "ready"
  }
}

// A wrapper provider that uses the router to route requests to actual ScriptedModelProviders
class RoutedModelProvider implements ModelProvider {
  capabilities = new Set(["chat", "tools"] as const)
  
  constructor(
    private router: ModelRouter,
    private healthChecker: HealthChecker,
    private taskClass: "general" | "coding",
    private providers: Record<string, ModelProvider>
  ) {}
  
  lastDecision?: RouteDecision
  
  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Determine requirements (stubbed for E2E proof)
    const req: ModelRouteRequirements = {
      taskClass: this.taskClass,
      needsTools: true,
      needsStructuredOutput: false,
      estimatedInputTokens: 1000,
      requiredContextWindow: 2000,
      specialization: this.taskClass === "coding" ? "coding" : "general"
    }
    
    const decision = await this.router.route(req, this.healthChecker, request.signal)
    this.lastDecision = decision
    
    const provider = this.providers[decision.providerId]
    if (!provider) throw new Error("Provider not found")
      
    // Inject provenance metadata into response
    const res = await provider.complete(request)
    return {
      ...res,
      metadata: {
        ...res.metadata,
        routeDecision: decision
      }
    }
  }
}

test("AgentRunner E2E with routing", async () => {
  const providers = {
    "scripted-general": new ScriptedModelProvider([response("I am general")]),
    "scripted-coding": new ScriptedModelProvider([response("I am coding")]),
  }
  
  const router = new ModelRouter(config)
  const health = new TestHealthChecker()
  const routedProvider = new RoutedModelProvider(router, health, "general", providers)
  
  const runner = new AgentRunner({
    provider: routedProvider,
    registry: createReadOnlyToolRegistry(),
  })
  
  const result = await runner.run({
    task: { id: "task-ask", mode: "ASK", instruction: "Hello" },
    workspaceRoot,
    maxTurns: 5,
    contextBudget,
    projectInstructions: [],
  })
  
  assert.equal(result.status, "COMPLETED")
  assert.equal(result.finalAnswer, "I am general")
  assert.equal(routedProvider.lastDecision?.deploymentId, "dep-general")
})

test("RepairOrchestrator E2E with routing", async () => {
  const providers = {
    "scripted-coding": new ScriptedModelProvider([response("I am coding repair")]),
  }
  
  const router = new ModelRouter(config)
  const health = new TestHealthChecker()
  const routedProvider = new RoutedModelProvider(router, health, "coding", providers)
  
  class MockVerificationEngine {
    async execute(): Promise<any> {
      return {
        status: "FAIL",
        exitCode: 1,
        stdout: "test failed",
        stderr: "",
        durationMs: 100
      }
    }
  }
  const verificationEngine = new MockVerificationEngine() as any

  const { ToolRegistry } = await import("../../src/tools/registry.ts")
  const registry = new ToolRegistry([])

  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
    verificationEngine,
    () => new AgentRunner({
      provider: routedProvider,
      registry,
    })
  )
  
  try {
    await orchestrator.run(
      {
        task: { id: "task-debug", mode: "DEBUG", instruction: "Fix it" },
        workspaceRoot,
        maxTurns: 5,
        contextBudget,
        projectInstructions: [],
      },
      {
        verificationId: "v-1",
        action: "TEST",
        executable: "npm",
        args: ["test"],
        cwd: workspaceRoot
      } as any
    )
    await orchestrator.resume("APPROVE")
  } catch (err) {
    console.error(err)
  }
  
  assert.equal(routedProvider.lastDecision?.deploymentId, "dep-coding")
})

test("Provider failure / fallback E2E", async () => {
  const providers = {
    "scripted-coding": new ScriptedModelProvider([response("Never called")]),
    "scripted-fallback": new ScriptedModelProvider([response("I am fallback")]),
  }
  
  const router = new ModelRouter(config)
  const health = new TestHealthChecker()
  health.unavailableDeployments.add("dep-coding") // Force fallback
  
  const routedProvider = new RoutedModelProvider(router, health, "coding", providers)
  
  const runner = new AgentRunner({
    provider: routedProvider,
    registry: createReadOnlyToolRegistry(),
  })
  
  const result = await runner.run({
    task: { id: "task-build", mode: "BUILD", instruction: "Code" },
    workspaceRoot,
    maxTurns: 5,
    contextBudget,
    projectInstructions: [],
  })
  
  assert.equal(result.finalAnswer, "I am fallback")
  assert.equal(routedProvider.lastDecision?.deploymentId, "dep-fallback")
  assert.equal(routedProvider.lastDecision?.fallbackLevel, 1)
})

test("Cancellation aborts before provider fallback", async () => {
  const providers = {
    "scripted-coding": new ScriptedModelProvider([
      (req) => {
        if (req.signal?.aborted) throw new Error("AbortError")
        return response("slow")
      }
    ]),
  }
  
  const router = new ModelRouter(config)
  const health = new TestHealthChecker()
  const routedProvider = new RoutedModelProvider(router, health, "coding", providers)
  
  const runner = new AgentRunner({
    provider: routedProvider,
    registry: createReadOnlyToolRegistry(),
  })
  
  const ac = new AbortController()
  const p = runner.run({
    task: { id: "task-build", mode: "BUILD", instruction: "Code" },
    workspaceRoot,
    maxTurns: 5,
    contextBudget,
    projectInstructions: [],
    signal: ac.signal
  })
  
  ac.abort()
  const res = await p
  assert.equal(res.status, "CANCELLED")
})
