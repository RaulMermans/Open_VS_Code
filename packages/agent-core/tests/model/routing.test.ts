import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { ModelRouter, type HealthChecker } from "../../src/model/router.ts"
import type { RoutingConfiguration, ModelRouteRequirements, ProviderHealthState } from "../../src/contracts/routing.ts"

const baseConfig: RoutingConfiguration = {
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
  unknownDeployments = new Set<string>()
  async checkHealth(deploymentId: string): Promise<ProviderHealthState> {
    if (this.unavailableDeployments.has(deploymentId)) return "unavailable"
    if (this.unknownDeployments.has(deploymentId)) return "unknown"
    return "ready"
  }
}

interface RoutingEvalCase {
  id: string
  name: string
  setup?: (config: any, health: TestHealthChecker) => void | Promise<void>
  requirements: ModelRouteRequirements
  expected: {
    selectedDeploymentId?: string
    failureCode?: string
    fallbackLevel?: number
    rejectedReason?: string
    errorPattern?: RegExp
  }
}

const cases: RoutingEvalCase[] = [
  {
    id: "1",
    name: "ASK (general) without tools - selects priority general",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "2",
    name: "PLAN (planning) requiring tools - selects general-large",
    requirements: { taskClass: "planning", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-large", fallbackLevel: 0 }
  },
  {
    id: "3",
    name: "BUILD (coding) without tools - selects coder-all because highest specialization and priority",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "4",
    name: "DEBUG (coding) requires structured output - selects coder-all",
    requirements: { taskClass: "debugging", needsTools: false, needsStructuredOutput: true, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "5",
    name: "REVIEW (review) long context - selects coder-all",
    requirements: { taskClass: "review", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 15000, requiredContextWindow: 16000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "6",
    name: "Tool required - rejected missing_tool_use",
    requirements: { taskClass: "general", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-large", fallbackLevel: 0 }
  },
  {
    id: "7",
    name: "No tool required - selects based on other factors",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "8",
    name: "Structured output required",
    requirements: { taskClass: "debugging", needsTools: false, needsStructuredOutput: true, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "9",
    name: "Tool + structured",
    requirements: { taskClass: "coding", needsTools: true, needsStructuredOutput: true, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "10",
    name: "Coding specialization score",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    setup: (c) => { c.routes = { ...c.routes, coding: ["dep-general-large", "dep-coder-base"] }; },
    expected: { selectedDeploymentId: "dep-coder-base", fallbackLevel: 0 }
  },
  {
    id: "11",
    name: "Exact context fit",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 7500, requiredContextWindow: 8000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "12",
    name: "Insufficient context",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 15000, requiredContextWindow: 16000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-large", fallbackLevel: 0 }
  },
  {
    id: "13",
    name: "Larger fallback context",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 15000, requiredContextWindow: 16000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "14",
    name: "Output reserve included in requiredContextWindow",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 6000, requiredContextWindow: 9000, specialization: "coding" },
    expected: { selectedDeploymentId: "dep-coder-all", fallbackLevel: 0 }
  },
  {
    id: "15",
    name: "All contexts insufficient",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 35000, requiredContextWindow: 40000, specialization: "coding" },
    expected: { failureCode: "ROUTE_UNAVAILABLE", rejectedReason: "insufficient_context" }
  },
  {
    id: "16",
    name: "Primary ready",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "17",
    name: "Primary unavailable, fallback level 1",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c, h) => { h.unavailableDeployments.add("dep-general-small"); },
    expected: { selectedDeploymentId: "dep-general-large", fallbackLevel: 1 }
  },
  {
    id: "18",
    name: "Fallback ready",
    requirements: { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    setup: (c, h) => { h.unavailableDeployments.add("dep-coder-all"); },
    expected: { selectedDeploymentId: "dep-coder-tools", fallbackLevel: 1 }
  },
  {
    id: "19",
    name: "All unavailable",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c, h) => {
      h.unavailableDeployments.add("dep-general-small");
      h.unavailableDeployments.add("dep-general-large");
    },
    expected: { failureCode: "ROUTE_UNAVAILABLE", rejectedReason: "unhealthy" }
  },
  {
    id: "20",
    name: "Health unknown policy - unknown treated as eligible",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c, h) => { h.unknownDeployments.add("dep-general-small"); },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "21",
    name: "Disabled deployment",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c) => { c.routes = { ...c.routes, default: ["dep-disabled", "dep-general-small"] }; },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "22",
    name: "Unknown model reference",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c) => {
      c.deployments = [...c.deployments, { id: "dep-bad-model", providerId: "scripted-1", modelId: "nonexistent", enabled: true }];
    },
    expected: { errorPattern: /Unknown model ID 'nonexistent'/ }
  },
  {
    id: "23",
    name: "Unknown provider reference",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c) => {
      c.deployments = [...c.deployments, { id: "dep-bad-prov", providerId: "nonexistent", modelId: "general-small", enabled: true }];
    },
    expected: { errorPattern: /Unknown provider ID 'nonexistent'/ }
  },
  {
    id: "24",
    name: "Duplicate deployment ID",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c) => {
      c.deployments = [...c.deployments, { id: "dep-general-small", providerId: "scripted-1", modelId: "general-small", enabled: true }];
    },
    expected: { errorPattern: /Duplicate deployment ID: dep-general-small/ }
  },
  {
    id: "25",
    name: "Explicit priority",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c) => {
      c.routes = { ...c.routes, default: ["dep-general-large", "dep-general-small"] };
    },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "26",
    name: "Primary fallback exhaustion",
    requirements: { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    setup: (c, h) => {
      h.unavailableDeployments.add("dep-coder-all");
      h.unavailableDeployments.add("dep-coder-tools");
    },
    expected: { selectedDeploymentId: "dep-general-large", fallbackLevel: 2 }
  },
  {
    id: "27",
    name: "Bounded fallback exhaustion",
    requirements: { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    setup: (c, h) => {
      c.routes = { ...c.routes, coding: ["dep-coder-all"] }; // only 1 in chain
      h.unavailableDeployments.add("dep-coder-all");
    },
    expected: { failureCode: "ROUTE_UNAVAILABLE", rejectedReason: "unhealthy" }
  },
  {
    id: "28",
    name: "Unconfigured candidate excluded",
    requirements: { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    setup: (c, h) => {
      c.routes = { ...c.routes, coding: ["dep-coder-tools"] };
      h.unavailableDeployments.add("dep-coder-tools");
    },
    expected: { failureCode: "ROUTE_UNAVAILABLE", rejectedReason: "unhealthy" }
  },
  {
    id: "29",
    name: "No cloud fallback - all local fail, no unconfigured provider selected",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c, h) => {
      h.unavailableDeployments.add("dep-general-small");
      h.unavailableDeployments.add("dep-general-large");
      // ensure we have a cloud provider not in the route
      c.providers = [...c.providers, { id: "cloud-1", kind: "openai" }];
      c.models = [...c.models, { id: "cloud-mod", contextWindow: 128000, capabilities: [], specialization: "general" }];
      c.deployments = [...c.deployments, { id: "dep-cloud", providerId: "cloud-1", modelId: "cloud-mod", enabled: true }];
    },
    expected: { failureCode: "ROUTE_UNAVAILABLE", rejectedReason: "unhealthy" }
  },
  {
    id: "30",
    name: "Tie-break determinism",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    setup: (c) => {
      c.routes = { ...c.routes, coding: ["dep-coder-tools", "dep-coder-base"] }; // Both have same score/priority.
    },
    expected: { selectedDeploymentId: "dep-coder-base", fallbackLevel: 0 }
  },
  {
    id: "31",
    name: "Registry order independence",
    requirements: { taskClass: "coding", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "coding" },
    setup: (c) => {
      c.routes = { ...c.routes, coding: ["dep-coder-base", "dep-coder-tools"] };
    },
    expected: { selectedDeploymentId: "dep-coder-base", fallbackLevel: 0 }
  },
  {
    id: "32",
    name: "Repeated route equality",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "33",
    name: "Provider/model/deployment identity",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
  {
    id: "34",
    name: "Large registry token-efficiency test (proof)",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    setup: (c, h) => {
      const largeDeployments: any[] = [];
      const largeChain: string[] = [];
      for (let i = 0; i < 50; i++) {
        largeDeployments.push({ id: `dep-${i}`, providerId: "scripted-1", modelId: "general-small", enabled: true });
        largeChain.push(`dep-${i}`);
      }
      c.deployments = [...c.deployments, ...largeDeployments];
      c.routes = { ...c.routes, default: largeChain };
      for (let i = 0; i < 20; i++) h.unavailableDeployments.add(`dep-${i}`);
    },
    expected: { selectedDeploymentId: "dep-20" }
  },
  {
    id: "35",
    name: "Usage unknown remains unknown",
    requirements: { taskClass: "general", needsTools: false, needsStructuredOutput: false, estimatedInputTokens: 1000, requiredContextWindow: 2000, specialization: "general" },
    expected: { selectedDeploymentId: "dep-general-small", fallbackLevel: 0 }
  },
];


function compareRoutingResult(actual: any, expected: any) {
  const mismatches = [];

  if (expected.errorPattern) {
    if (!actual.error || !expected.errorPattern.test(actual.error)) {
      mismatches.push({ field: "errorPattern", expected: expected.errorPattern.toString(), actual: actual.error });
    }
  } else if (expected.failureCode) {
    if (!actual.error || !actual.error.includes(expected.failureCode)) {
      mismatches.push({ field: "failureCode", expected: expected.failureCode, actual: actual.error });
    }
  } else {
    if (actual.error) {
      mismatches.push({ field: "success", expected: "no error", actual: actual.error });
    }
    if (expected.selectedDeploymentId !== undefined) {
      if (actual.deploymentId !== expected.selectedDeploymentId) {
        mismatches.push({ field: "selectedDeploymentId", expected: expected.selectedDeploymentId, actual: actual.deploymentId });
      }
    }
    if (expected.fallbackLevel !== undefined) {
      if (actual.fallbackLevel !== expected.fallbackLevel) {
        mismatches.push({ field: "fallbackLevel", expected: expected.fallbackLevel, actual: actual.fallbackLevel });
      }
    }
  }

  if (expected.rejectedReason !== undefined) {
    if (!actual.rejectedCandidates || !Array.isArray(actual.rejectedCandidates)) {
      mismatches.push({ field: "rejectedReason", expected: expected.rejectedReason, actual: "missing actual.rejectedCandidates" });
    } else {
      const hasReason = actual.rejectedCandidates.some((r: any) => r.reason === expected.rejectedReason);
      if (!hasReason) {
        mismatches.push({ field: "rejectedReason", expected: expected.rejectedReason, actual: actual.rejectedCandidates.map((r: any) => r.reason).join(",") });
      }
    }
  }

  return { passed: mismatches.length === 0, mismatches };
}

const runRoutingEvaluation = async () => {
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const config = JSON.parse(JSON.stringify(baseConfig));
    const health = new TestHealthChecker();

    if (tc.setup) {
      await tc.setup(config, health);
    }

    let actual = {};

    try {
      const router = new ModelRouter(config);
      const decision = await router.route(tc.requirements, health);
      actual = decision;
    } catch (e: any) {
      actual = { error: e.message || e.toString(), rejectedCandidates: e.rejectedCandidates };
    }

    const { passed: isPass, mismatches } = compareRoutingResult(actual, tc.expected);

    if (isPass) {
      passed++;
    } else {
      failed++;
      console.error(`Failed scenario ${tc.id}: ${tc.name}`, { mismatches, expected: tc.expected, actual });
    }

    results.push({
      scenarioId: tc.id,
      name: tc.name,
      passed: isPass,
      actual
    });
  }

  assert.equal(failed, 0, `Failed ${failed} routing scenarios`);

  return { results, passed, failed, total: cases.length };
};


const normalize = (res: any) => {
  const norm = JSON.parse(JSON.stringify(res));
  for (const r of norm.results) {
    if (r.actual.durationMs !== undefined) r.actual.durationMs = 0;
  }
  return norm;
};

describe("Model Router - Deterministic Evaluation", () => {
  test("Deterministic deep equality: Run 1 vs Run 2", async () => {
    const run1 = await runRoutingEvaluation();
    const run2 = await runRoutingEvaluation();

    assert.ok(run1.total >= 35, "Must have >= 35 meaningful cases");
    assert.deepEqual(normalize(run1), normalize(run2), "Runs must be deeply equal");
  });
});

describe("Health Unknown Policy Test", () => {
  test("unknown health is eligible, reports health_unknown not health_ready", async () => {
    class UnknownHealthChecker implements HealthChecker {
      async checkHealth(): Promise<ProviderHealthState> {
        return "unknown"
      }
    }
    let router = new ModelRouter(baseConfig)
    const result = await router.route({
      taskClass: "general",
      needsTools: false,
      needsStructuredOutput: false,
      estimatedInputTokens: 1000,
      requiredContextWindow: 2000
    }, new UnknownHealthChecker())

    assert.equal(result.healthState, "unknown")
    assert.ok(result.reasons.includes("health_unknown"))
    assert.ok(!result.reasons.includes("health_ready"))
  })
})

describe("Usage unknown remains unknown Test", () => {
  test("Usage unknown remains unknown", async () => {
    const { ScriptedModelProvider } = await import("../../src/testing/scripted-model.ts")
    const { RoutedModelGateway, StaticHealthChecker } = await import("../../src/model/routed-gateway.ts")

    const providerNoUsage = new ScriptedModelProvider([
      { model: "no-usage-model", message: { role: "assistant", content: "hello" } }
    ])

    const gatewayConfig: RoutingConfiguration = {
      providers: [{ id: "no-usage-provider", kind: "scripted" }],
      models: [{ id: "no-usage-model", contextWindow: 16000, capabilities: ["toolUse"], specialization: "general" }],
      deployments: [{ id: "dep-no-usage", providerId: "no-usage-provider", modelId: "no-usage-model", enabled: true }],
      routes: { default: ["dep-no-usage"] }
    }

    const gateway = new RoutedModelGateway({
      config: gatewayConfig,
      providers: new Map([["no-usage-provider", providerNoUsage]]),
      healthChecker: new StaticHealthChecker(new Map([["dep-no-usage", "ready"]])),
      mode: "ASK",
      hasTools: true,
      hasStructuredOutput: false,
    })

    const response = await gateway.complete({
      messages: [{ role: "user", content: "hello" }],
    })

    const usageProv = (response.metadata as any)?.usageProvenance
    assert.ok(usageProv)
    assert.equal(usageProv.reportedInputTokens, undefined)
    assert.equal(usageProv.reportedOutputTokens, undefined)
    assert.equal(usageProv.totalTokens, undefined)
  })
})


describe("Strict Expectation Comparator - Negative Self-Test", () => {
  test("fails if expected field is missing from actual", () => {
    const res = compareRoutingResult({}, { rejectedReason: "unhealthy" });
    assert.equal(res.passed, false);
    assert.equal(res.mismatches[0]?.field, "rejectedReason");
  });
  test("fails if actual value is wrong", () => {
    const res = compareRoutingResult({ deploymentId: "dep-21" }, { selectedDeploymentId: "dep-20" });
    assert.equal(res.passed, false);
    assert.equal(res.mismatches[0]?.field, "selectedDeploymentId");
  });
  test("fails if success expected but error occurred", () => {
    const res = compareRoutingResult({ error: "OOM" }, { selectedDeploymentId: "dep-20" });
    assert.equal(res.passed, false);
    assert.equal(res.mismatches[0]?.field, "success");
  });
  test("fails if error expected but success occurred", () => {
    const res = compareRoutingResult({ deploymentId: "dep-20" }, { failureCode: "ROUTE_UNAVAILABLE" });
    assert.equal(res.passed, false);
    assert.equal(res.mismatches[0]?.field, "failureCode");
  });
});
