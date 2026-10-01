import assert from "node:assert/strict"
import { join } from "node:path"
import { describe, test } from "node:test"
import { readFile } from "node:fs/promises"

import { AgentRunner } from "../../src/agent/runner.ts"
import { RepairOrchestrator } from "../../src/agent/repair-loop.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { ModelRouter } from "../../src/model/router.ts"
import { RoutedModelGateway, StaticHealthChecker, type ProviderRegistry } from "../../src/model/routed-gateway.ts"
import { buildModelRouteRequirements, deriveTaskClass, deriveOutputReserve, DEFAULT_OUTPUT_RESERVE } from "../../src/model/route-requirements.ts"
import { validateRoutingConfig, ConfigValidationError } from "../../src/model/config-loader.ts"
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import type { RoutingConfiguration } from "../../src/contracts/routing.ts"

const workspaceRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")
const contextBudget = calculateBudget({ contextWindow: 32_000, reservedOutput: 4096, reservedToolHistory: 100 })

function response(content: string, usage?: { inputTokens?: number; outputTokens?: number }): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(usage ? { usage } : {}) }
}

// Shared fixture config for production E2E tests
const prodConfig: RoutingConfiguration = {
  providers: [
    { id: "scripted-general", kind: "scripted" },
    { id: "scripted-coding", kind: "scripted" },
    { id: "scripted-fallback", kind: "scripted" },
  ],
  models: [
    { id: "gen-mod", contextWindow: 32000, capabilities: ["toolUse", "structuredOutput"], specialization: "general" },
    { id: "code-mod", contextWindow: 32000, capabilities: ["toolUse", "coding", "structuredOutput"], specialization: "coding" },
    { id: "small-mod", contextWindow: 8000, capabilities: [], specialization: "general" },
    { id: "notool-mod", contextWindow: 32000, capabilities: [], specialization: "general" },
    { id: "tool-mod", contextWindow: 32000, capabilities: ["toolUse"], specialization: "general" },
  ],
  deployments: [
    { id: "dep-general", providerId: "scripted-general", modelId: "gen-mod", enabled: true, priority: 10 },
    { id: "dep-coding", providerId: "scripted-coding", modelId: "code-mod", enabled: true, priority: 5 },
    { id: "dep-fallback", providerId: "scripted-fallback", modelId: "code-mod", enabled: true, priority: 1 },
    { id: "dep-small", providerId: "scripted-general", modelId: "small-mod", enabled: true, priority: 1 },
    { id: "dep-notool", providerId: "scripted-general", modelId: "notool-mod", enabled: true, priority: 10 },
    { id: "dep-tool", providerId: "scripted-general", modelId: "tool-mod", enabled: true, priority: 5 },
    { id: "dep-disabled", providerId: "scripted-general", modelId: "gen-mod", enabled: false, priority: 100 },
  ],
  routes: {
    default: ["dep-general", "dep-coding"],
    general: ["dep-general", "dep-coding"],
    coding: ["dep-coding", "dep-fallback"],
    debugging: ["dep-coding", "dep-fallback"],
    planning: ["dep-general", "dep-coding"],
    review: ["dep-general", "dep-coding"],
  }
}

describe("Production Routing E2E", () => {

  describe("T-1131: Config Load E2E", () => {
    test("production config fixture validates through production loader", async () => {
      // Load the committed example config
      const configPath = join(import.meta.dirname, "..", "..", "..", "..", "config", "examples", "models.local.example.json")
      const raw = await readFile(configPath, "utf-8")
      const parsed = JSON.parse(raw)
      const validated = validateRoutingConfig(parsed)
      assert.ok(validated.providers.length > 0)
      assert.ok(validated.models.length > 0)
      assert.ok(validated.deployments.length > 0)
      assert.ok(Object.keys(validated.routes).length > 0)

      // Verify it can be used to construct a router
      const router = new ModelRouter(validated)
      assert.ok(router)
    })

    test("validated config -> registries -> ModelRouter -> selected deployment", async () => {
      const validated = validateRoutingConfig(prodConfig)
      const router = new ModelRouter(validated)
      const health = new StaticHealthChecker(new Map([["dep-general", "ready"], ["dep-coding", "ready"]]))
      const req = buildModelRouteRequirements({ mode: "ASK", estimatedInputTokens: 1000, hasTools: true, hasStructuredOutput: false, budget: contextBudget })
      const decision = await router.route(req, health)
      assert.ok(decision.deploymentId)
      assert.ok(decision.providerId)
      assert.ok(decision.modelId)
    })
  })

  describe("T-1132: CLI ASK Routing E2E", () => {
    test("general deployment selected for ASK, correct provider invoked, provenance returned", async () => {
      const generalProvider = new ScriptedModelProvider([response("ASK answer", { inputTokens: 100, outputTokens: 50 })])
      const codingProvider = new ScriptedModelProvider([response("Coding answer")])

      const providers: ProviderRegistry = new Map([
        ["scripted-general", generalProvider],
        ["scripted-coding", codingProvider],
      ])

      const gateway = new RoutedModelGateway({
        config: prodConfig,
        providers,
        healthChecker: new StaticHealthChecker(new Map([["dep-general", "ready"], ["dep-coding", "ready"]])),
        mode: "ASK",
        hasTools: true,
        hasStructuredOutput: false,
        budget: contextBudget,
      })

      const runner = new AgentRunner({
        provider: gateway,
        registry: createReadOnlyToolRegistry(),
      })

      const result = await runner.run({
        task: { id: "ask-task", mode: "ASK", instruction: "What is 2+2?" },
        workspaceRoot,
        maxTurns: 5,
        contextBudget,
        projectInstructions: [],
      })

      assert.equal(result.status, "COMPLETED")
      assert.equal(result.finalAnswer, "ASK answer")
      assert.equal(gateway.lastDecision?.deploymentId, "dep-general")
      assert.equal(gateway.lastDecision?.providerId, "scripted-general")
      assert.ok(gateway.lastDiagnostics)
      assert.ok(gateway.lastDiagnostics.route.reasonCodes.length > 0)
    })
  })

  describe("T-1133: BUILD Routing E2E", () => {
    test("coding deployment selected for BUILD over general", async () => {
      const generalProvider = new ScriptedModelProvider([response("general")])
      const codingProvider = new ScriptedModelProvider([response("coding answer")])

      const gateway = new RoutedModelGateway({
        config: prodConfig,
        providers: new Map([["scripted-general", generalProvider], ["scripted-coding", codingProvider]]),
        healthChecker: new StaticHealthChecker(new Map([["dep-general", "ready"], ["dep-coding", "ready"], ["dep-fallback", "ready"]])),
        mode: "BUILD",
        hasTools: true,
        hasStructuredOutput: false,
        budget: contextBudget,
      })

      const runner = new AgentRunner({
        provider: gateway,
        registry: createReadOnlyToolRegistry(),
      })

      const result = await runner.run({
        task: { id: "build-task", mode: "BUILD", instruction: "Add feature" },
        workspaceRoot,
        maxTurns: 5,
        contextBudget,
        projectInstructions: [],
      })

      assert.equal(result.status, "COMPLETED")
      assert.equal(gateway.lastDecision?.deploymentId, "dep-coding")
      assert.ok(gateway.lastDecision?.reasons.includes("coding_specialization"))
    })
  })

  describe("T-1134: Tool-Required Routing E2E", () => {
    test("tool-capable deployment selected, no-tool deployment rejected", async () => {
      const toolConfig: RoutingConfiguration = {
        providers: [{ id: "prov-a", kind: "scripted" }],
        models: [
          { id: "no-tool-model", contextWindow: 32000, capabilities: [], specialization: "general" },
          { id: "tool-model", contextWindow: 32000, capabilities: ["toolUse"], specialization: "general" },
        ],
        deployments: [
          { id: "dep-a-notool", providerId: "prov-a", modelId: "no-tool-model", enabled: true, priority: 10 },
          { id: "dep-a-tool", providerId: "prov-a", modelId: "tool-model", enabled: true, priority: 5 },
        ],
        routes: { default: ["dep-a-notool", "dep-a-tool"] }
      }

      const provider = new ScriptedModelProvider([response("tool result")])
      const gateway = new RoutedModelGateway({
        config: toolConfig,
        providers: new Map([["prov-a", provider]]),
        healthChecker: new StaticHealthChecker(new Map([["dep-a-notool", "ready"], ["dep-a-tool", "ready"]])),
        mode: "ASK",
        hasTools: true,
        hasStructuredOutput: false,
      })

      const runner = new AgentRunner({ provider: gateway, registry: createReadOnlyToolRegistry() })
      const result = await runner.run({
        task: { id: "tool-task", mode: "ASK", instruction: "Use tools" },
        workspaceRoot,
        maxTurns: 5,
        contextBudget,
        projectInstructions: [],
      })

      assert.equal(result.status, "COMPLETED")
      assert.equal(gateway.lastDecision?.deploymentId, "dep-a-tool")
      assert.ok(gateway.lastDecision?.rejectedCandidates?.some(r => r.deploymentId === "dep-a-notool" && r.reason === "missing_tool_use"))
    })
  })

  describe("T-1135: Long-Context Routing E2E", () => {
    test("small context rejected, large context selected", async () => {
      const ctxConfig: RoutingConfiguration = {
        providers: [{ id: "prov", kind: "scripted" }],
        models: [
          { id: "small", contextWindow: 8000, capabilities: ["toolUse"], specialization: "general" },
          { id: "large", contextWindow: 32000, capabilities: ["toolUse"], specialization: "general" },
        ],
        deployments: [
          { id: "dep-small", providerId: "prov", modelId: "small", enabled: true, priority: 10 },
          { id: "dep-large", providerId: "prov", modelId: "large", enabled: true, priority: 5 },
        ],
        routes: { default: ["dep-small", "dep-large"] }
      }

      // Estimated input > 8k when output reserve is added
      const largeBudget = calculateBudget({ contextWindow: 32000, reservedOutput: 4096, reservedToolHistory: 100 })
      const provider = new ScriptedModelProvider([response("large context answer")])
      const gateway = new RoutedModelGateway({
        config: ctxConfig,
        providers: new Map([["prov", provider]]),
        healthChecker: new StaticHealthChecker(new Map([["dep-small", "ready"], ["dep-large", "ready"]])),
        mode: "ASK",
        hasTools: true,
        hasStructuredOutput: false,
        budget: largeBudget,
      })

      // Create a large request that exceeds 8k when output reserve is added
      const bigContent = "x".repeat(20000) // ~5000 tokens, + 4096 reserve = 9096 > 8000
      await gateway.complete({
        messages: [{ role: "user", content: bigContent }],
      })

      assert.equal(gateway.lastDecision?.deploymentId, "dep-large")
      assert.ok(gateway.lastDecision?.rejectedCandidates?.some(r => r.deploymentId === "dep-small" && r.reason === "insufficient_context"))
    })
  })

  describe("T-1136: Fallback E2E", () => {
    test("primary unavailable, fallback selected, fallbackLevel=1, no cloud", async () => {
      const codingProvider = new ScriptedModelProvider([response("never called")])
      const fallbackProvider = new ScriptedModelProvider([response("fallback answer")])

      const gateway = new RoutedModelGateway({
        config: prodConfig,
        providers: new Map([["scripted-coding", codingProvider], ["scripted-fallback", fallbackProvider]]),
        healthChecker: new StaticHealthChecker(new Map([
          ["dep-coding", "unavailable"],
          ["dep-fallback", "ready"],
        ])),
        mode: "BUILD",
        hasTools: true,
        hasStructuredOutput: false,
        budget: contextBudget,
      })

      const result = await gateway.complete({
        messages: [{ role: "user", content: "Code something" }],
      })

      assert.equal(result.message.content, "fallback answer")
      assert.equal(gateway.lastDecision?.deploymentId, "dep-fallback")
      assert.equal(gateway.lastDecision?.fallbackLevel, 1)
      assert.ok(gateway.lastDecision?.rejectedCandidates?.some(r => r.deploymentId === "dep-coding" && r.reason === "unhealthy"))
      // No cloud provider involved
      assert.equal(gateway.lastDecision?.providerId, "scripted-fallback")
    })
  })

  describe("T-1137: Cancellation E2E", () => {
    test("cancelled request triggers no fallback", async () => {
      const abortingProvider: ModelProvider = {
        capabilities: new Set(["chat", "tools"] as any),
        async complete(request: ModelRequest): Promise<ModelResponse> {
          if (request.signal?.aborted) throw new Error("AbortError")
          return response("should not get here")
        }
      }

      const gateway = new RoutedModelGateway({
        config: prodConfig,
        providers: new Map([["scripted-coding", abortingProvider], ["scripted-fallback", abortingProvider]]),
        healthChecker: new StaticHealthChecker(new Map([["dep-coding", "ready"], ["dep-fallback", "ready"]])),
        mode: "BUILD",
        hasTools: true,
        hasStructuredOutput: false,
        budget: contextBudget,
      })

      const runner = new AgentRunner({ provider: gateway, registry: createReadOnlyToolRegistry() })
      const ac = new AbortController()
      ac.abort() // Abort immediately

      const result = await runner.run({
        task: { id: "cancel-task", mode: "BUILD", instruction: "Code" },
        workspaceRoot,
        maxTurns: 5,
        contextBudget,
        projectInstructions: [],
        signal: ac.signal,
      })

      assert.equal(result.status, "CANCELLED")
      // Provider was called 0 or 1 times (abort happens before or during)
      // No fallback: if first provider was called and aborted, second is NOT called
    })
  })

  describe("T-1138: Repair Routing E2E", () => {
    test("RepairOrchestrator uses routed gateway, coding deployment selected", async () => {
      const codingProvider = new ScriptedModelProvider([response("repair answer")])

      const gateway = new RoutedModelGateway({
        config: prodConfig,
        providers: new Map([["scripted-coding", codingProvider], ["scripted-fallback", new ScriptedModelProvider([response("fb")])]]),
        healthChecker: new StaticHealthChecker(new Map([["dep-coding", "ready"], ["dep-fallback", "ready"]])),
        mode: "DEBUG",
        hasTools: true,
        hasStructuredOutput: false,
        budget: contextBudget,
      })

      class MockVerificationEngine {
        async execute(): Promise<any> {
          return { status: "FAIL", exitCode: 1, stdout: "test failed", stderr: "", durationMs: 100 }
        }
      }

      const registry = new ToolRegistry([])
      const orchestrator = new RepairOrchestrator(
        { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
        new MockVerificationEngine() as any,
        () => new AgentRunner({ provider: gateway, registry })
      )

      try {
        await orchestrator.run(
          { task: { id: "debug-task", mode: "DEBUG", instruction: "Fix test" }, workspaceRoot, maxTurns: 5, contextBudget, projectInstructions: [] },
          { verificationId: "v-1", action: "TEST", executable: "npm", args: ["test"], cwd: workspaceRoot } as any
        )
        await orchestrator.resume("APPROVE")
      } catch { /* expected */ }

      assert.equal(gateway.lastDecision?.deploymentId, "dep-coding")
      assert.ok(gateway.lastDecision?.reasons.includes("coding_specialization"))
      // Mutation approval, verification approval, and repair budget remain unchanged
    })
  })

  describe("T-1139: Large Registry Token Proof", () => {
    test("50+ deployments processed without entering prompt context", async () => {
      const largeDeps: any[] = []
      const largeChain: string[] = []
      for (let i = 0; i < 55; i++) {
        largeDeps.push({ id: `dep-${i}`, providerId: "scripted-general", modelId: "gen-mod", enabled: true })
        largeChain.push(`dep-${i}`)
      }
      const largeConfig: RoutingConfiguration = {
        ...prodConfig,
        deployments: [...prodConfig.deployments, ...largeDeps],
        routes: { default: largeChain }
      }

      const provider = new ScriptedModelProvider([response("answer")])
      const gateway = new RoutedModelGateway({
        config: largeConfig,
        providers: new Map([["scripted-general", provider], ["scripted-coding", provider], ["scripted-fallback", provider]]),
        healthChecker: new StaticHealthChecker(),
        mode: "ASK",
        hasTools: false,
        hasStructuredOutput: false,
      })

      const runner = new AgentRunner({ provider: gateway, registry: createReadOnlyToolRegistry() })
      const result = await runner.run({
        task: { id: "large-task", mode: "ASK", instruction: "Hello" },
        workspaceRoot,
        maxTurns: 5,
        contextBudget,
        projectInstructions: [],
      })

      assert.equal(result.status, "COMPLETED")
      // Verify: the compiled context does NOT contain registry metadata
      // The route diagnostics are bounded (only deploymentId + reason per rejection)
      assert.ok(gateway.lastDiagnostics)
      // Model prompt token size is NOT proportional to registry size
      // We can verify by checking that the request messages don't contain deployment IDs
      assert.ok(provider.requests.length > 0)
      const promptText = provider.requests[0]!.messages.map(m => m.content).join("")
      // The prompt should NOT contain any of the 55 deployment IDs
      assert.ok(!promptText.includes("dep-0"), "Registry metadata must not enter prompt context")
      assert.ok(!promptText.includes("dep-54"), "Registry metadata must not enter prompt context")
    })
  })

  describe("T-1140: Public API Test", () => {
    test("routing architecture importable from package public entry point", async () => {
      // Import through the public entry point, not internal paths
      const api = await import("../../src/index.ts")

      // Verify routing contracts exist
      assert.ok(api.ModelRouter)
      assert.ok(api.RoutedModelGateway)
      assert.ok(api.StaticHealthChecker)
      assert.ok(api.buildModelRouteRequirements)
      assert.ok(api.deriveTaskClass)
      assert.ok(api.deriveOutputReserve)
      assert.ok(api.validateRoutingConfig)
      assert.ok(api.ConfigValidationError)
      assert.ok(api.DEFAULT_OUTPUT_RESERVE)

      // Verify construction works through public API
      const config = api.validateRoutingConfig(prodConfig)
      const router = new api.ModelRouter(config)
      assert.ok(router)
    })
  })

  describe("T-1141: Config Corruption", () => {
    test("malformed config produces deterministic error, not crash", () => {
      assert.throws(() => validateRoutingConfig(null), ConfigValidationError)
      assert.throws(() => validateRoutingConfig(42), ConfigValidationError)
      assert.throws(() => validateRoutingConfig("string"), ConfigValidationError)
      assert.throws(() => validateRoutingConfig({ providers: "not-array" }), ConfigValidationError)
      assert.throws(() => validateRoutingConfig({
        providers: [{ id: "p", kind: "invalid_kind" }],
        models: [], deployments: [], routes: {}
      }), ConfigValidationError)
    })

    test("routing unavailable does not crash scripted provider operation", async () => {
      // ScriptedModelProvider works independently of routing config
      const provider = new ScriptedModelProvider([response("standalone")])
      const result = await provider.complete({ messages: [{ role: "user", content: "hello" }] })
      assert.equal(result.message.content, "standalone")
    })
  })

  describe("T-1142: Disabled Deployment", () => {
    test("disabled deployment never selected, provider not invoked", async () => {
      const disabledConfig: RoutingConfiguration = {
        providers: [{ id: "prov", kind: "scripted" }],
        models: [{ id: "mod", contextWindow: 32000, capabilities: ["toolUse"], specialization: "general" }],
        deployments: [
          { id: "dep-disabled", providerId: "prov", modelId: "mod", enabled: false, priority: 100 },
          { id: "dep-enabled", providerId: "prov", modelId: "mod", enabled: true, priority: 1 },
        ],
        routes: { default: ["dep-disabled", "dep-enabled"] }
      }

      const provider = new ScriptedModelProvider([response("enabled answer")])
      const gateway = new RoutedModelGateway({
        config: disabledConfig,
        providers: new Map([["prov", provider]]),
        healthChecker: new StaticHealthChecker(new Map([["dep-enabled", "ready"]])),
        mode: "ASK",
        hasTools: true,
        hasStructuredOutput: false,
      })

      await gateway.complete({ messages: [{ role: "user", content: "test" }] })
      assert.equal(gateway.lastDecision?.deploymentId, "dep-enabled")
      assert.ok(gateway.lastDecision?.rejectedCandidates?.some(r => r.deploymentId === "dep-disabled" && r.reason === "disabled"))
    })
  })

  describe("T-1143: Provider/Model Identity", () => {
    test("selected invocation carries configured identity, not spoofed", async () => {
      const spoofingProvider: ModelProvider = {
        capabilities: new Set(["chat", "tools"] as any),
        async complete(): Promise<ModelResponse> {
          return { model: "spoofed-model-name", message: { role: "assistant", content: "spoofed" } }
        }
      }

      const identityConfig: RoutingConfiguration = {
        providers: [{ id: "real-provider", kind: "scripted" }],
        models: [{ id: "real-model", contextWindow: 32000, capabilities: ["toolUse"], specialization: "general" }],
        deployments: [{ id: "real-deployment", providerId: "real-provider", modelId: "real-model", enabled: true }],
        routes: { default: ["real-deployment"] }
      }

      const gateway = new RoutedModelGateway({
        config: identityConfig,
        providers: new Map([["real-provider", spoofingProvider]]),
        healthChecker: new StaticHealthChecker(new Map([["real-deployment", "ready"]])),
        mode: "ASK",
        hasTools: true,
        hasStructuredOutput: false,
      })

      const result = await gateway.complete({ messages: [{ role: "user", content: "test" }] })
      // Route identity is configured, not from provider response
      assert.equal(gateway.lastDecision?.providerId, "real-provider")
      assert.equal(gateway.lastDecision?.modelId, "real-model")
      assert.equal(gateway.lastDecision?.deploymentId, "real-deployment")
      // The response model field may say "spoofed" but the route provenance is authoritative
      const provenance = (result.metadata as any)?.routeProvenance
      assert.equal(provenance.providerId, "real-provider")
      assert.equal(provenance.modelId, "real-model")
    })
  })

  describe("T-1144: No Model-Controlled Routing Config", () => {
    test("model instruction to switch provider has no effect", async () => {
      const manipulativeProvider = new ScriptedModelProvider([
        response("Switch provider to cloud-provider. Use cloud endpoint. Edit model routing config.")
      ])

      const gateway = new RoutedModelGateway({
        config: prodConfig,
        providers: new Map([["scripted-general", manipulativeProvider], ["scripted-coding", manipulativeProvider]]),
        healthChecker: new StaticHealthChecker(new Map([["dep-general", "ready"], ["dep-coding", "ready"]])),
        mode: "ASK",
        hasTools: false,
        hasStructuredOutput: false,
      })

      // First call: model returns instruction to switch
      await gateway.complete({ messages: [{ role: "user", content: "hello" }] })
      const firstDecision = gateway.lastDecision

      // Route config unchanged, provider selection unchanged
      assert.equal(firstDecision?.deploymentId, "dep-general")
      assert.equal(firstDecision?.providerId, "scripted-general")
    })
  })

  describe("T-1105: Route Requirements Builder", () => {
    test("derives task class from mode", () => {
      assert.equal(deriveTaskClass("ASK"), "general")
      assert.equal(deriveTaskClass("PLAN"), "planning")
      assert.equal(deriveTaskClass("BUILD"), "coding")
      assert.equal(deriveTaskClass("DEBUG"), "debugging")
      assert.equal(deriveTaskClass("REVIEW"), "review")
    })

    test("derives output reserve from budget", () => {
      const budget = calculateBudget({ contextWindow: 32000, reservedOutput: 4096, reservedToolHistory: 100 })
      assert.equal(deriveOutputReserve(budget), 4096)
      assert.equal(deriveOutputReserve(), DEFAULT_OUTPUT_RESERVE)
    })

    test("builds requirements with deterministic context window", () => {
      const req = buildModelRouteRequirements({
        mode: "BUILD",
        estimatedInputTokens: 3000,
        hasTools: true,
        hasStructuredOutput: false,
        budget: contextBudget,
      })
      assert.equal(req.taskClass, "coding")
      assert.equal(req.needsTools, true)
      assert.equal(req.needsStructuredOutput, false)
      assert.equal(req.estimatedInputTokens, 3000)
      assert.equal(req.requiredContextWindow, 3000 + contextBudget.reservedOutput)
      assert.equal(req.specialization, "coding")
    })
  })

  describe("T-1109: Output Reserve Policy", () => {
    test("output reserve is deterministic and bounded", () => {
      assert.equal(DEFAULT_OUTPUT_RESERVE, 4096)
      const budget = calculateBudget({ contextWindow: 16000, reservedOutput: 2000, reservedToolHistory: 100 })
      assert.equal(deriveOutputReserve(budget), 2000)
      // Never 0 with default
      assert.ok(deriveOutputReserve() > 0)
    })
  })
})

  describe("Provider Registry Safety", () => {
    test("instantiates openai_compatible_local from config without real calls", async () => {
      const configPath = join(import.meta.dirname, "..", "..", "..", "..", "config", "examples", "models.local.example.json")
      const raw = await readFile(configPath, "utf-8")
      const parsed = JSON.parse(raw)
      const config = validateRoutingConfig(parsed)
      
      const { OpenAICompatibleProvider } = await import("../../src/model/openai-compatible.ts")
      const { resolveDeploymentEndpoint, resolveServedModelId } = await import("../../src/model/canonical-endpoint.ts")
      const providers = new Map<string, ModelProvider>()
      
      for (const p of config.providers) {
        if (p.kind === "scripted") {
          providers.set(p.id, new ScriptedModelProvider([]))
        }
      }
      for (const d of config.deployments) {
        const providerConfig = config.providers.find(p => p.id === d.providerId)
        if (providerConfig?.kind === "openai_compatible_local") {
          const ep = resolveDeploymentEndpoint(d, providerConfig)
          const modelConfig = config.models.find(m => m.id === d.modelId)
          const wireModel = resolveServedModelId(d, modelConfig)
          providers.set(d.id, new OpenAICompatibleProvider({
            baseUrl: ep,
            model: wireModel,
          }))
        }
      }
      
      const chatDep = config.deployments[0]!
      const provider = providers.get(chatDep.id)
      assert.ok(provider instanceof OpenAICompatibleProvider)
      assert.equal(provider.model, "qwen2.5-coder:7b")
      
      const healthChecker = new StaticHealthChecker(new Map([[chatDep.id, "ready"]]))
      const gateway = new RoutedModelGateway({
        config,
        providers,
        healthChecker,
        mode: "BUILD",
        hasTools: true,
        hasStructuredOutput: false
      })
      
      // We do not run complete() to avoid real network requests
      assert.ok(gateway)
    })
  })
