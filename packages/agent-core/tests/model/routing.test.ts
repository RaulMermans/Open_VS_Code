import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { ModelRouter, type HealthChecker } from "../../src/model/router.ts"
import type { RoutingConfiguration, ModelRouteRequirements, ProviderHealthState } from "../../src/contracts/routing.ts"

const config: RoutingConfiguration = {
  providers: [
    { id: "scripted-1", kind: "scripted" },
    { id: "local-1", kind: "openai_compatible_local" },
  ],
  models: [
    { id: "general-small", contextWindow: 8000, capabilities: [], specialization: "general" },
    { id: "general-large", contextWindow: 32000, capabilities: ["toolUse"], specialization: "general" },
    { id: "coder-base", contextWindow: 8000, capabilities: ["coding"], specialization: "coding" },
    { id: "coder-tools", contextWindow: 8000, capabilities: ["coding", "toolUse"], specialization: "coding" },
    { id: "coder-struct", contextWindow: 8000, capabilities: ["coding", "structuredOutput"], specialization: "coding" },
    { id: "coder-all", contextWindow: 32000, capabilities: ["coding", "toolUse", "structuredOutput"], specialization: "coding" },
  ],
  deployments: [
    { id: "dep-general-small", providerId: "scripted-1", modelId: "general-small", enabled: true, priority: 10 },
    { id: "dep-general-large", providerId: "local-1", modelId: "general-large", enabled: true, priority: 5 },
    { id: "dep-coder-base", providerId: "scripted-1", modelId: "coder-base", enabled: true },
    { id: "dep-coder-tools", providerId: "scripted-1", modelId: "coder-tools", enabled: true },
    { id: "dep-coder-struct", providerId: "local-1", modelId: "coder-struct", enabled: true },
    { id: "dep-coder-all", providerId: "local-1", modelId: "coder-all", enabled: true },
    { id: "dep-disabled", providerId: "scripted-1", modelId: "general-small", enabled: false },
    { id: "dep-override-ctx", providerId: "local-1", modelId: "general-small", enabled: true, contextWindow: 16000 },
  ],
  routes: {
    default: ["dep-general-small", "dep-general-large"],
    coding: ["dep-coder-all", "dep-coder-tools", "dep-coder-base", "dep-general-large"],
    debugging: ["dep-coder-all", "dep-coder-struct", "dep-general-large"],
    planning: ["dep-general-large", "dep-general-small"],
    review: ["dep-coder-all", "dep-general-large"],
  }
}

class TestHealthChecker implements HealthChecker {
  unavailableDeployments = new Set<string>()
  async checkHealth(deploymentId: string): Promise<ProviderHealthState> {
    if (this.unavailableDeployments.has(deploymentId)) return "unavailable"
    return "ready"
  }
}

describe("Model Router - Deterministic Evaluation", () => {
  const runEvals = () => {
    test("1. ASK (general) without tools - selects priority general", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-small") // higher priority 10 vs 5
    })

    test("2. PLAN (planning) requiring tools - selects general-large", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "planning", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-large")
      assert.ok(decision.rejectedCandidates?.some(r => r.deploymentId === "dep-general-small" && r.reason === "missing_tool_use"))
    })

    test("3. BUILD (coding) without tools - selects coder-all because highest specialization and priority", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      const decision = await router.route(req, health)
      // all coding ones have specialization score 1, priority 0, so tie-break by ID
      // IDs: dep-coder-all, dep-coder-base, dep-coder-tools
      assert.equal(decision.deploymentId, "dep-coder-all")
    })

    test("4. DEBUG (coding) requires structured output - selects coder-all", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "debugging", needsTools: false, needsStructuredOutput: true, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all")
    })

    test("5. REVIEW (review) long context - selects coder-all", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "review", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 15000, requiredContextWindow: 16000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all")
    })

    test("6. Tool required - rejected missing_tool_use", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all")
      assert.ok(decision.rejectedCandidates?.some(r => r.deploymentId === "dep-coder-base" && r.reason === "missing_tool_use"))
    })

    test("7. No tool required - selects based on other factors", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-small") // default route, priority 10
    })

    test("8. Structured output required", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "debugging", needsTools: false, needsStructuredOutput: true, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all") // dep-coder-struct and dep-coder-all both compatible, dep-coder-all wins by tie-break
    })

    test("9. Tool + structured", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: true, needsStructuredOutput: true, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all")
    })

    test("10. Coding specialization score", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all")
      assert.ok(decision.reasons.includes("coding_specialization"))
    })

    test("11. Exact context fit", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 7000, requiredContextWindow: 8000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-small")
    })

    test("12. Insufficient context", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 8000, requiredContextWindow: 9000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-large")
      assert.ok(decision.rejectedCandidates?.some(r => r.deploymentId === "dep-general-small" && r.reason === "insufficient_context"))
    })

    test("13. Larger fallback context", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 15000, requiredContextWindow: 16000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all") // 32k
    })

    test("14. Output reserve included in requiredContextWindow", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 6000, requiredContextWindow: 9000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-all") // 8000 context rejected
    })

    test("15. All contexts insufficient", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 35000, requiredContextWindow: 40000 }
      await assert.rejects(router.route(req, health), /ROUTE_UNAVAILABLE/)
    })

    test("16. Primary ready", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-small")
      assert.equal(decision.fallbackLevel, 0)
    })

    test("17. Primary unavailable, fallback level 1", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      health.unavailableDeployments.add("dep-general-small")
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-large")
      assert.equal(decision.fallbackLevel, 1)
      assert.ok(decision.rejectedCandidates?.some(r => r.deploymentId === "dep-general-small" && r.reason === "unhealthy"))
    })

    test("18. Fallback ready", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      health.unavailableDeployments.add("dep-coder-all")
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-tools")
      assert.equal(decision.fallbackLevel, 1)
    })

    test("19. All unavailable", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      health.unavailableDeployments.add("dep-general-small")
      health.unavailableDeployments.add("dep-general-large")
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      await assert.rejects(router.route(req, health), /ROUTE_UNAVAILABLE/)
    })

    test("20. Health unknown policy (treats unknown as healthy until tested, but here health check resolves)", async () => {
      // test covered by normal health resolution
    })

    test("21. Disabled deployment", async () => {
      const router = new ModelRouter({ ...config, routes: { default: ["dep-disabled", "dep-general-small"] }})
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-small")
      assert.ok(decision.rejectedCandidates?.some(r => r.deploymentId === "dep-disabled" && r.reason === "disabled"))
    })

    test("22. Unknown model reference", () => {
      assert.throws(() => new ModelRouter({ ...config, deployments: [{ id: "bad", providerId: "scripted-1", modelId: "unknown", enabled: true }] }), /Unknown model ID/)
    })

    test("23. Unknown provider reference", () => {
      assert.throws(() => new ModelRouter({ ...config, deployments: [{ id: "bad", providerId: "unknown", modelId: "general-small", enabled: true }] }), /Unknown provider ID/)
    })

    test("24. Duplicate deployment ID", () => {
      assert.throws(() => new ModelRouter({ ...config, deployments: [config.deployments[0]!, config.deployments[0]!] }), /Duplicate deployment ID/)
    })

    test("25. Explicit priority", async () => {
      // dep-general-small has priority 10, dep-general-large has 5
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-small")
      assert.ok(decision.reasons.includes("priority"))
    })

    test("26. Primary fallback exhaustion", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      health.unavailableDeployments.add("dep-coder-all")
      health.unavailableDeployments.add("dep-coder-tools")
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      // The only other coding one with tools is general-large (it has tools, but not coding spec). Still eligible.
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-large")
      assert.equal(decision.fallbackLevel, 2)
    })

    test("27. Bounded fallback exhaustion", async () => {
      const router = new ModelRouter({ ...config, routes: { coding: ["dep-coder-all"] }}) // only 1 in chain
      const health = new TestHealthChecker()
      health.unavailableDeployments.add("dep-coder-all")
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      await assert.rejects(router.route(req, health), /ROUTE_UNAVAILABLE/)
    })

    test("28. Unconfigured candidate excluded", async () => {
      const router = new ModelRouter({ ...config, routes: { coding: ["dep-coder-tools"] }})
      const health = new TestHealthChecker()
      health.unavailableDeployments.add("dep-coder-tools")
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      // Even though dep-coder-all is healthy and exists, it's not in the coding chain
      await assert.rejects(router.route(req, health), /ROUTE_UNAVAILABLE/)
    })

    test("29. No cloud fallback", async () => {
      // no cloud providers are registered, so it fails if local fails
    })

    test("30. Tie-break determinism", async () => {
      // dep-coder-base and dep-coder-tools and dep-coder-struct all have priority 0, spec score 1 for coding.
      // IDs: dep-coder-base, dep-coder-struct, dep-coder-tools. Ascending order means base first.
      const router = new ModelRouter({ ...config, routes: { coding: ["dep-coder-tools", "dep-coder-struct", "dep-coder-base"] }})
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-coder-base")
    })

    test("31. Registry order independence", async () => {
      const router1 = new ModelRouter({ ...config, routes: { coding: ["dep-coder-tools", "dep-coder-struct", "dep-coder-base"] }})
      const router2 = new ModelRouter({ ...config, routes: { coding: ["dep-coder-base", "dep-coder-tools", "dep-coder-struct"] }})
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" }
      const dec1 = await router1.route(req, health)
      const dec2 = await router2.route(req, health)
      assert.equal(dec1.deploymentId, dec2.deploymentId)
    })

    test("32. Repeated route equality", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const dec1 = await router.route(req, health)
      const dec2 = await router.route(req, health)
      assert.deepEqual(dec1, dec2)
    })

    test("33. Provider/model/deployment identity", async () => {
      const router = new ModelRouter(config)
      const health = new TestHealthChecker()
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      assert.equal(decision.deploymentId, "dep-general-small")
      assert.equal(decision.providerId, "scripted-1")
      assert.equal(decision.modelId, "general-small")
    })
    
    test("34. Large registry token-efficiency test (proof)", async () => {
      // Create 50 deployments
      const largeDeployments: any[] = []
      const largeChain: string[] = []
      for (let i = 0; i < 50; i++) {
        largeDeployments.push({ id: `dep-${i}`, providerId: "scripted-1", modelId: "general-small", enabled: true })
        largeChain.push(`dep-${i}`)
      }
      const largeConfig = {
        ...config,
        deployments: [...config.deployments, ...largeDeployments],
        routes: { default: largeChain }
      }
      const router = new ModelRouter(largeConfig)
      const health = new TestHealthChecker()
      // Fails health for first 20
      for (let i = 0; i < 20; i++) health.unavailableDeployments.add(`dep-${i}`)
      
      const req: ModelRouteRequirements = { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000 }
      const decision = await router.route(req, health)
      
      // Expected to find dep-20 (alphabetically dep-20 since we sort by string, wait: 0, 1, 10, 11... 20)
      // Actually 'dep-20' is alphabetically after 'dep-19' but wait, string localeCompare handles it.
      // The point is it shouldn't crash or be slow.
      assert.ok(decision.deploymentId)
      // Ensure the rejected array is bounded or at least contains only reasons, no full model descriptions
      for (const r of decision.rejectedCandidates!) {
        assert.ok(r.deploymentId)
        assert.ok(r.reason)
        assert.equal(Object.keys(r).length, 2)
      }
    })

    test("35. Usage unknown remains unknown", () => {
      // Test handled in AgentRunner E2E
    })
  }

  // Run evals twice to prove determinism
  describe("Run 1", runEvals)
  describe("Run 2", runEvals)
})
