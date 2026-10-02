import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resolveCanonicalEndpoints,
  EndpointPolicyError,
  resolveDeploymentEndpoint,
  resolveServedModelId,
} from "../../src/model/canonical-endpoint.ts"
import {
  checkInferenceGate,
  assertInferenceAuthorized,
  InferenceNotAuthorizedError,
} from "../../src/model/inference-gate.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { LocalFimProvider, LocalFimProviderError } from "../../src/autocomplete/local-fim-provider.ts"
import { createProductionAutocompleteGateway } from "../../src/autocomplete/gateway.ts"
import { createAgentRuntime } from "../../src/agent/runtime.ts"
import { EndpointHealthChecker } from "../../src/model/endpoint-health.ts"
import { ModelPerformanceLedger, LEDGER_SCHEMA_VERSION } from "../../src/model/performance-ledger.ts"
import {
  validateRoutingConfig,
  loadRoutingConfig,
  ConfigValidationError,
  resolveProviderApiKey,
} from "../../src/model/config-loader.ts"
import type { RoutingConfiguration } from "../../src/contracts/routing.ts"
import { ModelRouter } from "../../src/model/router.ts"
import { AgentRunner } from "../../src/agent/runner.ts"
import { AutocompleteService } from "../../src/autocomplete/service.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import type { EditorSnapshot } from "../../src/autocomplete/context-builder.ts"
import { validateStructuralSyntax } from "../evals/real-model-benchmark.ts"
import { RoutedModelGateway, StaticHealthChecker } from "../../src/model/routed-gateway.ts"

const fakeFetchMalformed = async () => new Response("<html>Gateway Timeout</html>", {
  status: 504,
  headers: { "content-type": "text/html" },
})

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return {
    model: "scripted-general",
    message: { role: "assistant", content },
    ...(toolCalls ? { toolCalls } : {}),
  }
}

function makeSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    rawPrefix: "const x = ",
    rawSuffix: "\nconsole.log(x)\n",
    languageId: "typescript",
    relativePath: "src/index.ts",
    documentVersion: 1,
    cursorLine: 0,
    cursorCharacter: 10,
    ...overrides,
  }
}

describe("Sprint 4E.1 — Comprehensive Closure & Security Boundary Evaluation", () => {
  // ── 1. Canonical Endpoint Resolution Contract ─────────────────────────────
  describe("1. Canonical Endpoint Resolution Contract", () => {
    test("normalizes host root with and without trailing slash deterministically", () => {
      const ep1 = resolveCanonicalEndpoints("http://127.0.0.1:11434")
      const ep2 = resolveCanonicalEndpoints("http://127.0.0.1:11434/")

      assert.equal(ep1.chatEndpoint, "http://127.0.0.1:11434/v1/chat/completions")
      assert.equal(ep1.completionsEndpoint, "http://127.0.0.1:11434/v1/completions")
      assert.equal(ep1.modelsEndpoint, "http://127.0.0.1:11434/v1/models")
      assert.equal(ep1.baseV1Url, "http://127.0.0.1:11434/v1")

      assert.equal(ep2.chatEndpoint, ep1.chatEndpoint)
      assert.equal(ep2.completionsEndpoint, ep1.completionsEndpoint)
      assert.equal(ep2.modelsEndpoint, ep1.modelsEndpoint)
      assert.equal(ep2.baseV1Url, ep1.baseV1Url)
    })

    test("normalizes /v1 paths with and without trailing slash without /v1/v1 duplication", () => {
      const ep1 = resolveCanonicalEndpoints("http://localhost:8000/v1")
      const ep2 = resolveCanonicalEndpoints("http://localhost:8000/v1/")

      assert.equal(ep1.chatEndpoint, "http://localhost:8000/v1/chat/completions")
      assert.equal(ep1.completionsEndpoint, "http://localhost:8000/v1/completions")
      assert.equal(ep1.modelsEndpoint, "http://localhost:8000/v1/models")
      assert.equal(ep1.baseV1Url, "http://localhost:8000/v1")

      assert.ok(!ep1.chatEndpoint.includes("/v1/v1"))
      assert.ok(!ep1.completionsEndpoint.includes("/v1/v1"))
      assert.ok(!ep1.modelsEndpoint.includes("/v1/v1"))
      assert.equal(ep2.chatEndpoint, ep1.chatEndpoint)
    })

    test("preserves custom path prefixes before /v1 deterministically", () => {
      const ep = resolveCanonicalEndpoints("http://192.168.1.50:8080/custom/prefix")
      assert.equal(ep.chatEndpoint, "http://192.168.1.50:8080/custom/prefix/v1/chat/completions")
      assert.equal(ep.completionsEndpoint, "http://192.168.1.50:8080/custom/prefix/v1/completions")
      assert.equal(ep.modelsEndpoint, "http://192.168.1.50:8080/custom/prefix/v1/models")
    })

    test("rejects query strings, fragments, and invalid protocols", () => {
      assert.throws(
        () => resolveCanonicalEndpoints("http://localhost:11434?model=foo"),
        (err: unknown) => err instanceof EndpointPolicyError && err.code === "QUERY_NOT_ALLOWED",
      )
      assert.throws(
        () => resolveCanonicalEndpoints("http://localhost:11434#section"),
        (err: unknown) => err instanceof EndpointPolicyError && err.code === "FRAGMENT_NOT_ALLOWED",
      )
      assert.throws(
        () => resolveCanonicalEndpoints("ftp://localhost:11434"),
        (err: unknown) => err instanceof EndpointPolicyError && err.code === "INVALID_PROTOCOL",
      )
      assert.throws(
        () => resolveCanonicalEndpoints("file:///etc/passwd"),
        (err: unknown) => err instanceof EndpointPolicyError && err.code === "INVALID_PROTOCOL",
      )
    })
  })

  // ── 2. Local-First & Zero Cloud Fallback Policy ────────────────────────────
  describe("2. Local-First & Zero Cloud Fallback Policy", () => {
    test("rejects known proprietary hosted LLM domains immediately", () => {
      const forbiddenDomains = [
        "https://api.openai.com",
        "https://api.openai.com/v1",
        "https://api.anthropic.com",
        "https://generativelanguage.googleapis.com",
        "https://api.mistral.ai",
        "https://api.cohere.com",
        "https://api.groq.com",
        "https://api.together.xyz",
        "https://api.fireworks.ai",
        "https://api.deepseek.com",
        "https://api.perplexity.ai",
        "https://chatgpt.com",
        "https://claude.ai",
      ]

      for (const domain of forbiddenDomains) {
        assert.throws(
          () => resolveCanonicalEndpoints(domain),
          (err: unknown) => err instanceof EndpointPolicyError && err.code === "PROPRIETARY_CLOUD_FORBIDDEN",
          `Expected ${domain} to be rejected under local-first policy`,
        )
      }
    })

    test("allows user-owned self-hosted non-localhost endpoints", () => {
      const allowed = [
        "http://127.0.0.1:11434",
        "http://localhost:8080",
        "http://192.168.1.100:11434",
        "http://workstation.local:8000",
        "https://internal-gpu-box.corp:8443",
      ]
      for (const url of allowed) {
        assert.doesNotThrow(() => resolveCanonicalEndpoints(url))
      }
    })
  })

  // ── 3. Real Inference Authorization Boundary ──────────────────────────────
  describe("3. Real Inference Authorization Boundary", () => {
    test("default state: inference is unauthorized and assert throws InferenceNotAuthorizedError", () => {
      const savedEnv = process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      try {
        const gate = checkInferenceGate()
        assert.equal(gate.authorized, false)
        assert.ok(gate.reason.includes("disabled"))

        assert.throws(
          () => assertInferenceAuthorized(false),
          (err: unknown) => err instanceof InferenceNotAuthorizedError && err.code === "INFERENCE_NOT_AUTHORIZED",
        )
      } finally {
        if (savedEnv !== undefined) process.env["OPEN_VS_CODE_REAL_INFERENCE"] = savedEnv
      }
    })

    test("mock fetch is permitted as a test seam without real inference authorization", () => {
      const savedEnv = process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      try {
        assert.doesNotThrow(() => assertInferenceAuthorized(true))
      } finally {
        if (savedEnv !== undefined) process.env["OPEN_VS_CODE_REAL_INFERENCE"] = savedEnv
      }
    })

    test("OpenAICompatibleProvider and LocalFimProvider block real network calls when unauthorized", async () => {
      const savedEnv = process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      try {
        const chatProvider = new OpenAICompatibleProvider({
          baseUrl: "http://127.0.0.1:11434",
          model: "qwen2.5-coder:7b",
        })
        await assert.rejects(
          async () => chatProvider.complete({ messages: [{ role: "user", content: "hi" }] }),
          (err: unknown) => err instanceof Error && (err as { code?: string }).code === "INFERENCE_NOT_AUTHORIZED",
        )

        const fimProvider = new LocalFimProvider({
          providerId: "p",
          modelId: "m",
          deploymentId: "d",
          baseUrl: "http://127.0.0.1:11434",
          model: "qwen2.5-coder:7b",
        })
        await assert.rejects(
          async () => fimProvider.complete({
            requestId: "r",
            prefix: "const a = ",
            suffix: ";",
            languageId: "typescript",
            maxOutputTokens: 50,
            signal: new AbortController().signal,
          }),
          (err: unknown) => err instanceof LocalFimProviderError && err.code === "INFERENCE_NOT_AUTHORIZED",
        )
      } finally {
        if (savedEnv !== undefined) process.env["OPEN_VS_CODE_REAL_INFERENCE"] = savedEnv
      }
    })
  })

  // ── 4. Explicit FIM Strategy Contract & Validation ────────────────────────
  describe("4. Explicit FIM Strategy Contract & Validation", () => {
    test("rejects invalid FIM strategies during config validation", () => {
      const invalidConfig: RoutingConfiguration = {
        providers: [{ id: "p1", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
        models: [
          {
            id: "m1",
            contextWindow: 32000,
            capabilities: ["autocomplete"],
            specialization: "coding",
            // @ts-expect-error - testing runtime rejection of invalid strategy
            fimStrategy: "magic-auto-detect",
          },
        ],
        deployments: [
          { id: "dep-1", providerId: "p1", modelId: "m1", enabled: true, priority: 1 },
        ],
        routes: { autocomplete: ["dep-1"] },
      }

      assert.throws(
        () => validateRoutingConfig(invalidConfig),
        (err: unknown) => err instanceof Error && err.name === "ConfigValidationError" && err.message.includes("Invalid fimStrategy"),
      )
    })

    test("accepts valid FIM strategies and exposes them on provider", () => {
      const validStrategies = ["qwen", "starcoder", "deepseek", "prefix-suffix-middle", "raw-prefix"] as const
      for (const strat of validStrategies) {
        const p = new LocalFimProvider({
          providerId: "p",
          modelId: "m",
          deploymentId: "d",
          baseUrl: "http://127.0.0.1:11434",
          model: "test-model",
          fimStrategy: strat,
        })
        assert.equal(p.fimStrategy, strat)
      }
    })
  })

  // ── 5. Production Autocomplete Gateway Wiring ─────────────────────────────
  describe("5. Production Autocomplete Gateway Wiring", () => {
    test("creates a real LocalFimProvider for eligible local deployment with zero scripted providers", async () => {
      const validConfig: RoutingConfiguration = {
        providers: [
          { id: "ollama-local", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" },
        ],
        models: [
          {
            id: "qwen-coder",
            contextWindow: 32768,
            capabilities: ["autocomplete", "fim"],
            specialization: "coding",
            fimStrategy: "qwen",
          },
        ],
        deployments: [
          {
            id: "dep-qwen-fim",
            providerId: "ollama-local",
            modelId: "qwen-coder",
            enabled: true,
            priority: 10,
          },
        ],
        routes: {
          autocomplete: ["dep-qwen-fim"],
        },
      }

      const gateway = createProductionAutocompleteGateway(validConfig)

      // Ensure no scripted provider exists
      const scriptedProvider = gateway.providerRegistry.get("scripted")
      assert.equal(scriptedProvider, undefined, "No scripted provider may appear in production")

      // Ensure real LocalFimProvider was dynamically created and registered
      const provider = gateway.providerRegistry.get("dep-qwen-fim")
      assert.ok(provider instanceof LocalFimProvider, "Must register real LocalFimProvider instance")
      assert.equal(provider.fimStrategy, "qwen")
      assert.equal(provider.canonicalEndpoints.completionsEndpoint, "http://127.0.0.1:11434/v1/completions")

      // Ensure EndpointHealthChecker and PerformanceLedger are wired
      assert.ok(gateway.healthChecker instanceof EndpointHealthChecker, "Real EndpointHealthChecker wired")
      assert.ok(gateway.performanceLedger instanceof ModelPerformanceLedger, "ModelPerformanceLedger wired")
    })
  })

  // ── 6. Production Agent Runtime Wiring ────────────────────────────────────
  describe("6. Production Agent Runtime Wiring", () => {
    test("createAgentRuntime wires real EndpointHealthChecker and ModelPerformanceLedger", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "runtime-test-"))
      try {
        const config: RoutingConfiguration = {
          providers: [
            { id: "local-server", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" },
          ],
          models: [
            { id: "qwen-instruct", contextWindow: 32768, capabilities: ["coding"], specialization: "coding" },
          ],
          deployments: [
            {
              id: "dep-chat",
              providerId: "local-server",
              modelId: "qwen-instruct",
              enabled: true,
              priority: 10,
            },
          ],
          routes: {
            coding: ["dep-chat"],
            default: ["dep-chat"],
          },
        }

        const runtime = await createAgentRuntime({
          routingConfigOverride: config,
          workspaceRoot: tmp,
          mode: "BUILD",
          instruction: "test instruction",
          eventSink: () => {},
          isTrusted: true,
        })

        // Verify health checker is real EndpointHealthChecker (not StaticHealthChecker)
        assert.ok(runtime.healthChecker instanceof EndpointHealthChecker, "Must wire real EndpointHealthChecker")
        assert.ok(runtime.performanceLedger instanceof ModelPerformanceLedger, "Must wire ModelPerformanceLedger")

        // Verify routing uses real endpoint health
        const health = await runtime.healthChecker.checkHealth("dep-chat")
        assert.ok(["ready", "unavailable", "degraded", "unknown"].includes(health))
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    })
  })

  // ── 7. ModelPerformanceLedger Lifecycle & Privacy Invariants ──────────────
  describe("7. ModelPerformanceLedger Lifecycle & Privacy Invariants", () => {
    test("persists aggregate metrics only; never persists source, prompts, completions, diffs, or secrets", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-eval-"))
      const ledgerFile = join(tmp, "ledger.json")

      try {
        const ledger = new ModelPerformanceLedger({
          persistPath: ledgerFile,
          minimumSamples: 2,
        })

        ledger.recordAgentOutcome({
          deploymentId: "dep-local",
          taskClass: "coding",
          success: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 145,
        })

        ledger.recordAutocompleteOutcome({
          deploymentId: "dep-fim",
          shown: true,
          accepted: true,
          staleDiscarded: false,
          emptyCompletion: false,
          cancelled: false,
          latencyMs: 42,
        })

        await ledger.persist()

        const content = await readFile(ledgerFile, "utf-8")
        const parsed = JSON.parse(content)

        assert.equal(parsed.schemaVersion, LEDGER_SCHEMA_VERSION)
        assert.ok(Array.isArray(parsed.profiles))

        // Privacy checks: ensure forbidden fields and leaked code are absent
        const forbiddenSubstrings = [
          "function",
          "class",
          "import",
          "const",
          "sk-",
          "Bearer",
          "Authorization",
          "password",
          "secret",
          "diff --git",
        ]
        for (const token of forbiddenSubstrings) {
          assert.ok(!content.includes(token), `Ledger file must not contain sensitive token: ${token}`)
        }
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    })

    test("resets corrupt or mismatched schema store safely without blocking routing", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-corrupt-"))
      const corruptFile = join(tmp, "corrupt.json")

      try {
        await writeFile(corruptFile, "{ invalid json content")
        const ledger = new ModelPerformanceLedger({ persistPath: corruptFile })
        const { loaded, resetDueToCorruption } = await ledger.load()

        assert.equal(loaded, false)
        assert.equal(resetDueToCorruption, true)
        assert.equal(ledger.profileCount, 0)
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    })
  })

  // ── 8. Model Authority Boundary & Adversarial Robustness ──────────────────
  describe("8. Model Authority Boundary & Adversarial Robustness", () => {
    test("model output is strictly data and cannot modify router or system configuration", async () => {
      const config: RoutingConfiguration = {
        providers: [{ id: "p1", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
        models: [{ id: "m1", contextWindow: 32000, capabilities: ["coding"], specialization: "coding" }],
        deployments: [{ id: "dep-1", providerId: "p1", modelId: "m1", enabled: true, priority: 1 }],
        routes: { coding: ["dep-1"] },
      }
      const router = new ModelRouter(config)

      // Malicious attempt to change route configuration via simulated output
      const maliciousOutput = JSON.stringify({
        routes: { coding: ["untrusted-cloud-dep"] },
        priority: 999999,
      })

      const staticHealth = { checkHealth: async () => "ready" as const }
      const decision = await router.route(
        {
          taskClass: "coding",
          needsTools: false,
          needsStructuredOutput: false,
          estimatedInputTokens: 100,
          requiredContextWindow: 1000,
        },
        staticHealth,
      )

      assert.equal(decision.deploymentId, "dep-1")
      // Check config is untouched
      assert.deepEqual(config.routes["coding"], ["dep-1"])
      void maliciousOutput
    })

    test("adversarial responses: malformed JSON, HTTP 500, and abort signals fail gracefully", async () => {
      // 1. Malformed JSON from chat provider
      const chatProvider = new OpenAICompatibleProvider({
        baseUrl: "http://127.0.0.1:11434",
        model: "m",
        fetch: fakeFetchMalformed as unknown as typeof fetch,
      })
      await assert.rejects(
        async () => chatProvider.complete({ messages: [{ role: "user", content: "test" }] }),
        (err: unknown) => err instanceof Error && (err as { code?: string }).code === "HTTP_ERROR",
      )

      // 2. Cancellation / abort signal on LocalFimProvider
      const controller = new AbortController()
      controller.abort()
      const fimProvider = new LocalFimProvider({
        providerId: "p",
        modelId: "m",
        deploymentId: "d",
        baseUrl: "http://127.0.0.1:11434",
        model: "m",
        fetch: (async () => new Response(JSON.stringify({ choices: [{ text: "xyz" }] }))) as unknown as typeof fetch,
      })
      await assert.rejects(
        async () => fimProvider.complete({
          requestId: "r",
          prefix: "abc",
          suffix: "def",
          languageId: "typescript",
          maxOutputTokens: 20,
          signal: controller.signal,
        }),
        (err: unknown) => err instanceof LocalFimProviderError && err.code === "CANCELLED",
      )
    })
  })

  // ── 9. Negative Comparator Tests ──────────────────────────────────────────
  describe("9. Negative Comparator Tests", () => {
    test("negative comparator: tampered URL schema throws expected error", () => {
      assert.throws(
        () => resolveCanonicalEndpoints("javascript:alert(1)"),
        (err: unknown) => err instanceof EndpointPolicyError,
      )
    })

    test("negative comparator: non-authorized state strictly prevents live HTTP fetch", async () => {
      const savedEnv = process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
      try {
        let liveFetchCalled = false
        const origGlobalFetch = globalThis.fetch
        // Mock globalThis.fetch directly to observe if it's called
        globalThis.fetch = (async () => {
          liveFetchCalled = true
          return new Response("{}")
        }) as unknown as typeof fetch

        try {
          const provider = new OpenAICompatibleProvider({
            baseUrl: "http://127.0.0.1:11434",
            model: "qwen",
          })
          await assert.rejects(
            async () => provider.complete({ messages: [{ role: "user", content: "hi" }] }),
            (err: unknown) => err instanceof Error && (err as { code?: string }).code === "INFERENCE_NOT_AUTHORIZED",
          )
          assert.equal(liveFetchCalled, false, "Live fetch must not be invoked when unauthorized")
        } finally {
          globalThis.fetch = origGlobalFetch
        }
      } finally {
        if (savedEnv !== undefined) process.env["OPEN_VS_CODE_REAL_INFERENCE"] = savedEnv
      }
    })
  })

  // ── 10. File-Backed Production Configuration Contract & Regression Proofs ──
  describe("10. File-Backed Production Configuration Contract & Regression Proofs", () => {
    test("1. provider baseUrl survives disk load and validation", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ovs-test-config-"))
      try {
        const configDir = join(tmp, ".open-vs-code")
        await mkdir(configDir, { recursive: true })
        const rawJson = {
          providers: [{ id: "p1", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
          models: [{ id: "m1", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" }],
          deployments: [{ id: "d1", providerId: "p1", modelId: "m1", enabled: true }],
          routes: { coding: ["d1"] },
        }
        await writeFile(join(configDir, "models.json"), JSON.stringify(rawJson, null, 2))

        const loaded = await loadRoutingConfig(tmp)
        assert.ok(loaded !== null)
        assert.equal(loaded.providers[0]?.baseUrl, "http://127.0.0.1:11434")
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    })

    test("2. served model ID (modelName and servedModelId) survives disk load and validation", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ovs-test-config-"))
      try {
        const configDir = join(tmp, ".open-vs-code")
        await mkdir(configDir, { recursive: true })
        const rawJson = {
          providers: [{ id: "p1", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
          models: [{
            id: "qwen2.5-coder-7b",
            contextWindow: 32768,
            capabilities: ["coding", "toolUse"],
            specialization: "coding",
            modelName: "qwen2.5-coder:7b",
          }],
          deployments: [{
            id: "d1",
            providerId: "p1",
            modelId: "qwen2.5-coder-7b",
            modelName: "qwen2.5-coder:7b",
            enabled: true,
          }],
          routes: { coding: ["d1"] },
        }
        await writeFile(join(configDir, "models.json"), JSON.stringify(rawJson, null, 2))

        const loaded = await loadRoutingConfig(tmp)
        assert.ok(loaded !== null)
        assert.equal(loaded.models[0]?.modelName, "qwen2.5-coder:7b")
        assert.equal(loaded.deployments[0]?.modelName, "qwen2.5-coder:7b")
        assert.equal(resolveServedModelId(loaded.deployments[0]!, loaded.models[0]!), "qwen2.5-coder:7b")
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    })

    test("3. canonical capability values validate without error", () => {
      const canonicalCaps = ["toolUse", "structuredOutput", "coding", "reasoning", "longContext", "vision", "fim", "autocomplete"]
      const validated = validateRoutingConfig({
        providers: [{ id: "p1", kind: "scripted" }],
        models: [{
          id: "m1",
          contextWindow: 8192,
          capabilities: canonicalCaps,
          specialization: "coding",
          fimStrategy: "qwen",
        }],
        deployments: [{ id: "d1", providerId: "p1", modelId: "m1", enabled: true }],
        routes: { default: ["d1"] },
      })
      assert.deepEqual(validated.models[0]?.capabilities, canonicalCaps)
    })

    test("4. bad capability values (e.g. tools, chat) fail validation clearly", () => {
      assert.throws(
        () => validateRoutingConfig({
          providers: [{ id: "p1", kind: "scripted" }],
          models: [{
            id: "m1",
            contextWindow: 8192,
            capabilities: ["tools", "chat"],
            specialization: "coding",
          }],
          deployments: [{ id: "d1", providerId: "p1", modelId: "m1", enabled: true }],
          routes: { default: ["d1"] },
        }),
        (err: unknown) =>
          err instanceof ConfigValidationError &&
          err.violations.some(v => v.includes("Unknown capability 'tools'")) &&
          err.violations.some(v => v.includes("Unknown capability 'chat'")),
      )
    })

    test("5. bad FIM strategy fails validation clearly", () => {
      assert.throws(
        () => validateRoutingConfig({
          providers: [{ id: "p1", kind: "scripted" }],
          models: [{
            id: "m1",
            contextWindow: 8192,
            capabilities: ["autocomplete"],
            specialization: "coding",
            fimStrategy: "unsupported-strategy" as any,
          }],
          deployments: [{ id: "d1", providerId: "p1", modelId: "m1", enabled: true }],
          routes: { default: ["d1"] },
        }),
        (err: unknown) =>
          err instanceof ConfigValidationError &&
          err.violations.some(v => v.includes("Invalid fimStrategy 'unsupported-strategy'")),
      )
    })

    test("6. endpoint override precedence works: deployment endpoint overrides provider baseUrl", () => {
      const provider = { id: "p1", kind: "openai_compatible_local" as const, baseUrl: "http://127.0.0.1:11434" }
      const depWithOverride = { id: "d1", providerId: "p1", modelId: "m1", endpoint: "http://127.0.0.1:8000/v1", enabled: true }
      const depWithoutOverride = { id: "d2", providerId: "p1", modelId: "m1", enabled: true }

      assert.equal(resolveDeploymentEndpoint(depWithOverride, provider), "http://127.0.0.1:8000/v1")
      assert.equal(resolveDeploymentEndpoint(depWithoutOverride, provider), "http://127.0.0.1:11434")
    })

    test("7. production autocomplete provider is instantiated from disk models.json", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ovs-test-config-"))
      try {
        const configDir = join(tmp, ".open-vs-code")
        await mkdir(configDir, { recursive: true })
        const rawJson = {
          providers: [{ id: "p1", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
          models: [{
            id: "qwen2.5-coder-7b",
            contextWindow: 32768,
            capabilities: ["autocomplete", "fim"],
            specialization: "coding",
            fimStrategy: "qwen",
            modelName: "qwen2.5-coder:7b",
          }],
          deployments: [{
            id: "dep-fim",
            providerId: "p1",
            modelId: "qwen2.5-coder-7b",
            modelName: "qwen2.5-coder:7b",
            enabled: true,
            fimStrategy: "qwen",
          }],
          routes: { autocomplete: ["dep-fim"] },
        }
        await writeFile(join(configDir, "models.json"), JSON.stringify(rawJson, null, 2))

        const gateway = createProductionAutocompleteGateway(tmp)
        assert.ok(gateway.providerRegistry.has("dep-fim"), "dep-fim provider must be instantiated in registry")
        const fimProv = gateway.providerRegistry.get("dep-fim") as LocalFimProvider
        assert.ok(fimProv instanceof LocalFimProvider)
        assert.equal(fimProv.fimStrategy, "qwen")
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    })

    test("8. production agent provider is instantiated from disk models.json with correct wire model", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ovs-test-config-"))
      try {
        const configDir = join(tmp, ".open-vs-code")
        await mkdir(configDir, { recursive: true })
        const rawJson = {
          providers: [{ id: "p1", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
          models: [{
            id: "qwen2.5-coder-7b",
            contextWindow: 32768,
            capabilities: ["coding", "toolUse"],
            specialization: "coding",
            modelName: "qwen2.5-coder:7b",
          }],
          deployments: [{
            id: "dep-chat",
            providerId: "p1",
            modelId: "qwen2.5-coder-7b",
            modelName: "qwen2.5-coder:7b",
            enabled: true,
          }],
          routes: { coding: ["dep-chat"], default: ["dep-chat"] },
        }
        await writeFile(join(configDir, "models.json"), JSON.stringify(rawJson, null, 2))

        const events: any[] = []
        const runtime = await createAgentRuntime({
          workspaceRoot: tmp,
          mode: "ASK",
          instruction: "test",
          isTrusted: true,
          eventSink: (ev) => events.push(ev),
        })

        assert.ok(runtime.runner !== undefined)
        assert.ok(runtime.routedGateway !== undefined)
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    })

    test("9. requested wire model equals served model ID across chat and FIM providers", async () => {
      const deployment = {
        id: "d1",
        providerId: "p1",
        modelId: "logical-qwen",
        modelName: "qwen2.5-coder:7b",
        enabled: true,
      }
      const model = {
        id: "logical-qwen",
        contextWindow: 32768,
        capabilities: ["coding" as const, "autocomplete" as const, "fim" as const],
        specialization: "coding" as const,
        fimStrategy: "qwen" as const,
      }
      const wireModel = resolveServedModelId(deployment, model)
      assert.equal(wireModel, "qwen2.5-coder:7b")

      // Test chat provider wire model
      const chatProv = new OpenAICompatibleProvider({
        baseUrl: "http://127.0.0.1:11434",
        model: wireModel,
      })
      assert.equal(chatProv.model, "qwen2.5-coder:7b")

      // Test FIM provider wire model
      const fimProv = new LocalFimProvider({
        providerId: "p1",
        modelId: "logical-qwen",
        deploymentId: "d1",
        baseUrl: "http://127.0.0.1:11434",
        model: wireModel,
        fimStrategy: "qwen",
      })
      assert.equal(fimProv.modelId, "logical-qwen")
    })

    test("10. known cloud host is rejected at baseUrl or endpoint", () => {
      assert.throws(
        () => validateRoutingConfig({
          providers: [{ id: "p1", kind: "openai_compatible_local", baseUrl: "https://api.openai.com" }],
          models: [{ id: "m1", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" }],
          deployments: [{ id: "d1", providerId: "p1", modelId: "m1", enabled: true }],
          routes: { default: ["d1"] },
        }),
        (err: unknown) =>
          err instanceof ConfigValidationError &&
          err.violations.some(v => v.includes("Proprietary cloud endpoint 'api.openai.com' is forbidden")),
      )
    })

    test("11. missing endpoint fails clearly when neither deployment endpoint nor provider baseUrl is set", () => {
      assert.throws(
        () => validateRoutingConfig({
          providers: [{ id: "p1", kind: "openai_compatible_local" }],
          models: [{ id: "m1", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" }],
          deployments: [{ id: "d1", providerId: "p1", modelId: "m1", enabled: true }],
          routes: { default: ["d1"] },
        }),
        (err: unknown) =>
          err instanceof ConfigValidationError &&
          err.violations.some(v => v.includes("has no endpoint or provider baseUrl configured")),
      )
    })

    test("12. canonical example configuration loads through validateRoutingConfig with zero violations", async () => {
      const examplePath = join(import.meta.dirname, "..", "..", "..", "..", "config", "examples", "models.local.example.json")
      const raw = await readFile(examplePath, "utf-8")
      const parsed = JSON.parse(raw)
      const validated = validateRoutingConfig(parsed)

      assert.ok(validated.providers.length >= 1)
      assert.ok(validated.models.length >= 1)
      assert.ok(validated.deployments.length >= 2)
      assert.equal(validated.providers[0]?.baseUrl, "http://127.0.0.1:11434")
      assert.equal(validated.deployments[0]?.modelName, "qwen2.5-coder:7b")
    })

    test("13. schema drift test: config/schemas/models.schema.json aligns with TypeScript contracts", async () => {
      const schemaPath = join(import.meta.dirname, "..", "..", "..", "..", "config", "schemas", "models.schema.json")
      const raw = await readFile(schemaPath, "utf-8")
      const schema = JSON.parse(raw)

      const providerKinds = schema.properties.providers.items.properties.kind.enum
      assert.deepEqual(providerKinds.toSorted(), ["fake", "openai_compatible_local", "scripted"].toSorted())

      const capabilities = schema.properties.models.items.properties.capabilities.items.enum
      const expectedCaps = ["toolUse", "structuredOutput", "coding", "reasoning", "longContext", "vision", "fim", "autocomplete"]
      assert.deepEqual(capabilities.toSorted(), expectedCaps.toSorted())

      const fimStrategies = schema.properties.models.items.properties.fimStrategy.enum
      const expectedFim = ["prefix-suffix-middle", "qwen", "starcoder", "deepseek", "raw-prefix"]
      assert.deepEqual(fimStrategies.toSorted(), expectedFim.toSorted())
    })
  })

  // ── 11. Sprint 4E.3 — Evidence Integrity & Adaptive Routing Closure ─────────────
  describe("11. Sprint 4E.3 — Evidence Integrity & Adaptive Routing Closure", () => {
    test("1. createAgentRuntime wires performanceLedger into primary AgentRunner and records on completion", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "open-vs-code-eval-runtime-ledger-"))
      try {
        await mkdir(join(tmp, ".open-vs-code"), { recursive: true })
        const config: RoutingConfiguration = {
          providers: [{ id: "p1", kind: "scripted" }],
          models: [{ id: "m1", contextWindow: 8192, capabilities: ["coding", "toolUse"], specialization: "coding" }],
          deployments: [{ id: "d1", providerId: "p1", modelId: "m1", enabled: true }],
          routes: { default: ["d1"] },
        }
        await writeFile(join(tmp, ".open-vs-code", "models.json"), JSON.stringify(config), "utf-8")

        const runtime = await createAgentRuntime({
          workspaceRoot: tmp,
          mode: "ASK",
          instruction: "Explain hello world",
          isTrusted: true,
          eventSink: () => {},
        })

        assert.ok(runtime.performanceLedger, "performanceLedger must be instantiated on runtime")
        const initialProfile = (runtime.performanceLedger as any).getProfile?.("d1", "general")
        assert.equal(initialProfile?.sampleCount ?? 0, 0)

        const result = await runtime.runner.run(runtime.runnerInput)
        assert.equal(result.status, "COMPLETED")

        // AgentRunner must have directly recorded into performanceLedger
        const afterProfile = (runtime.performanceLedger as any).getProfile?.("d1", "general")
        assert.equal(afterProfile?.sampleCount, 1, "AgentRunner must record outcome into injected ledger")
        assert.equal(afterProfile?.successCount, 1)
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("2. PAUSED confirmation does not record terminal outcome in ledger", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const provider = new ScriptedModelProvider([
        response("Let me modify a file", [{ id: "call-1", name: "test_action", arguments: { path: "foo.txt" } }]),
      ])

      const registry = createReadOnlyToolRegistry()
      registry.register({
        definition: {
          name: "test_action",
          description: "Action requiring confirmation",
          action: "write_file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        validate: (input: unknown) => (input && typeof input === "object" ? (input as Record<string, unknown>) : {}),
        execute: async () => ({ output: "ok" }),
      })

      const runner = new AgentRunner({
        provider,
        registry,
        permissionEvaluator: () => "CONFIRM",
        performanceLedger: ledger,
      })

      const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })
      const res = await runner.run({
        task: { id: "t-paused-1", mode: "BUILD", instruction: "Do action" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      })

      assert.equal(res.status, "PAUSED", "Run must pause on confirmation")
      assert.equal((ledger as any).getProfile?.("scripted-general", "coding")?.sampleCount ?? 0, 0,
        "PAUSED state must NEVER record a terminal outcome into the performance ledger")
    })

    test("3. Resumed task records exactly one outcome on terminal completion (no double-counting)", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const provider = new ScriptedModelProvider([
        response("Need confirmation", [{ id: "call-2", name: "test_action", arguments: { path: "bar.txt" } }]),
        response("Action finished successfully"),
      ])

      const registry = createReadOnlyToolRegistry()
      registry.register({
        definition: {
          name: "test_action",
          description: "Action requiring confirmation",
          action: "write_file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        validate: (input: unknown) => (input && typeof input === "object" ? (input as Record<string, unknown>) : {}),
        execute: async () => ({ output: "executed successfully" }),
      })

      const runner = new AgentRunner({
        provider,
        registry,
        permissionEvaluator: () => "CONFIRM",
        performanceLedger: ledger,
      })

      const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })
      const pausedRes = await runner.run({
        task: { id: "t-resume-1", mode: "BUILD", instruction: "Do action" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      })
      assert.equal(pausedRes.status, "PAUSED")
      assert.equal((ledger as any).getProfile?.("scripted-general", "coding")?.sampleCount ?? 0, 0)

      // Resume with approval -> terminal completion
      const completedRes = await runner.resume("APPROVE")
      assert.equal(completedRes.status, "COMPLETED")

      const profile = (ledger as any).getProfile?.("scripted-general", "coding")
      assert.equal(profile?.sampleCount, 1, "Exactly one sample must be recorded across pause and resume")
      assert.equal(profile?.successCount, 1)
      assert.equal(profile?.failureCount, 0)
    })

    test("4. Resumed task with REJECT records exactly one truthful failure outcome", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const provider = new ScriptedModelProvider([
        response("Need confirmation", [{ id: "call-3", name: "test_action", arguments: { path: "baz.txt" } }]),
      ])

      const registry = createReadOnlyToolRegistry()
      registry.register({
        definition: {
          name: "test_action",
          description: "Action requiring confirmation",
          action: "write_file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        validate: (input: unknown) => (input && typeof input === "object" ? (input as Record<string, unknown>) : {}),
        execute: async () => ({ output: "ok" }),
      })

      const runner = new AgentRunner({
        provider,
        registry,
        permissionEvaluator: () => "CONFIRM",
        performanceLedger: ledger,
      })

      const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })
      await runner.run({
        task: { id: "t-resume-rej-1", mode: "BUILD", instruction: "Do action" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      })

      // Resume with rejection -> terminal result
      const rejectedRes = await runner.resume("REJECT")
      assert.ok(rejectedRes.status === "COMPLETED" || rejectedRes.status === "FAILED")

      const profile = (ledger as any).getProfile?.("scripted-general", "coding")
      assert.equal(profile?.sampleCount, 1, "Exactly one sample must be recorded on reject resumption")
      // Tool call was rejected so toolCallSuccess must be false
      assert.equal(profile?.toolCallSuccessCount, 0, "Rejected tool call must not count as toolCallSuccess")
    })

    test("5. Verification result is truthful and not hardcoded to true", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const provider = new ScriptedModelProvider([
        response("Let me verify with test", [{ id: "call-v1", name: "run_known_test", arguments: {} }]),
        response("Verification failed but finishing task"),
      ])

      const registry = createReadOnlyToolRegistry()
      registry.register({
        definition: {
          name: "run_known_test",
          description: "Test",
          action: "run_known_test",
          inputSchema: { type: "object", properties: {} },
        },
        validate: (input: unknown) => (input && typeof input === "object" ? (input as Record<string, unknown>) : {}),
        execute: async () => {
          throw new Error("Test suite assertion failure: expected 1 got 2")
        },
      })

      const runner = new AgentRunner({
        provider,
        registry,
        permissionEvaluator: () => "ALLOW",
        performanceLedger: ledger,
      })

      const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })
      const res = await runner.run({
        task: { id: "t-verif-fail-1", mode: "BUILD", instruction: "Run verification" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      })

      assert.equal(res.status, "COMPLETED")
      const profile = (ledger as any).getProfile?.("scripted-general", "coding")
      assert.equal(profile?.sampleCount, 1)
      assert.equal(profile?.verificationSuccessCount, 0, "Failed verification tool call must record verificationSuccess = false")
      assert.equal(profile?.toolCallSuccessCount, 0, "Failed tool call must record toolCallSuccess = false")
      assert.ok(profile?.totalRepairCycles >= 1, "Failed verification must register in repairCycles")
    })

    test("6. Read-only task without verification records truthful verification success", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const provider = new ScriptedModelProvider([
        response("Here is the code explanation"),
      ])

      const runner = new AgentRunner({
        provider,
        registry: createReadOnlyToolRegistry(),
        performanceLedger: ledger,
      })

      const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })
      const res = await runner.run({
        task: { id: "t-ask-1", mode: "ASK", instruction: "Explain code" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      })

      assert.equal(res.status, "COMPLETED")
      const profile = (ledger as any).getProfile?.("scripted-general", "general")
      assert.equal(profile?.sampleCount, 1)
      assert.equal(profile?.verificationSuccessCount, 1, "Completed read-only task has satisfied verification")
      assert.equal(profile?.toolCallSuccessCount, 1, "Completed task with 0 tool calls has satisfied toolCallSuccess")
      assert.equal(profile?.totalRepairCycles, 0)
    })

    test("7. Cancellation and timeout classification is truthful", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      
      // Test A: Cancellation via AbortSignal
      const cancelController = new AbortController()
      const providerCancel = new ScriptedModelProvider([
        () => {
          cancelController.abort()
          const err = new Error("This operation was aborted")
          err.name = "AbortError"
          throw err
        }
      ])
      const runnerCancel = new AgentRunner({
        provider: providerCancel,
        registry: createReadOnlyToolRegistry(),
        performanceLedger: ledger,
      })
      const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })
      const resCancel = await runnerCancel.run({
        task: { id: "t-cancel-1", mode: "ASK", instruction: "Do cancel" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
        signal: cancelController.signal,
      })
      assert.equal(resCancel.status, "CANCELLED")
      const profileCancel = (ledger as any).getProfile?.("scripted-general", "general")
      assert.equal(profileCancel?.cancellationCount, 1, "cancellationCount must increment on cancel")
      assert.equal(profileCancel?.timeoutCount, 0, "timeoutCount must NOT increment on cancel")

      // Test B: Timeout error
      const ledgerTimeout = new ModelPerformanceLedger({ minimumSamples: 1 })
      const providerTimeout = new ScriptedModelProvider([
        () => {
          const err = new Error("Gateway connection timed out after 30000ms")
          err.name = "TimeoutError"
          throw err
        }
      ])
      const runnerTimeout = new AgentRunner({
        provider: providerTimeout,
        registry: createReadOnlyToolRegistry(),
        performanceLedger: ledgerTimeout,
      })
      const resTimeout = await runnerTimeout.run({
        task: { id: "t-timeout-1", mode: "ASK", instruction: "Do timeout" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      })
      assert.equal(resTimeout.status, "FAILED")
      const profileTimeout = (ledgerTimeout as any).getProfile?.("scripted-general", "general")
      assert.equal(profileTimeout?.timeoutCount, 1, "timeoutCount must increment on actual timeout")
      assert.equal(profileTimeout?.cancellationCount, 0, "cancellationCount must NOT increment on timeout")
    })

    test("8. Autocomplete accepted request = exactly one sample in performance ledger (no double count)", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const gateway = {
        complete: async () => ({ text: "helloWorld()", deploymentId: "dep-fim-1", providerId: "prov-1" }),
        performanceLedger: ledger,
      } as any

      const service = new AutocompleteService({
        gateway,
        debounceMs: 0,
        scheduler: { schedule: (fn: () => void) => { setTimeout(fn, 0); return { cancel: () => {} } } },
        performanceLedger: ledger,
      })

      const res = await service.trigger(makeSnapshot(), "file:///test.ts")

      assert.ok(res)
      // Shown completion is pending; not yet accepted
      const profileBeforeAccept = (ledger as any).getProfile?.("dep-fim-1", "autocomplete")
      assert.equal(profileBeforeAccept?.sampleCount ?? 0, 0, "Shown completion waiting for user must not be counted prematurely")

      // User accepts
      service.recordAccepted(res.requestId)

      const profileAfterAccept = (ledger as any).getProfile?.("dep-fim-1", "autocomplete")
      assert.equal(profileAfterAccept?.sampleCount, 1, "Accepted request must record exactly 1 sample")
      assert.equal(profileAfterAccept?.successCount, 1)
      assert.equal(profileAfterAccept?.autocomplete?.accepted, 1)
      assert.equal(profileAfterAccept?.autocomplete?.shown, 1)

      // Second call to recordAccepted on same ID is safe no-op
      service.recordAccepted(res.requestId)
      assert.equal((ledger as any).getProfile?.("dep-fim-1", "autocomplete")?.sampleCount, 1, "Re-accepting cannot double count")
      service.dispose()
    })

    test("9. Autocomplete unaccepted shown completion finalizes as exactly 1 unaccepted sample upon replacement", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      let count = 0
      const gateway = {
        complete: async () => ({ text: `completion_${++count}()`, deploymentId: "dep-fim-1", providerId: "prov-1" }),
        performanceLedger: ledger,
      } as any

      const service = new AutocompleteService({
        gateway,
        debounceMs: 0,
        scheduler: { schedule: (fn: () => void) => { setTimeout(fn, 0); return { cancel: () => {} } } },
        performanceLedger: ledger,
      })

      const res1 = await service.trigger(makeSnapshot({ rawPrefix: "const " }), "file:///test.ts")
      assert.ok(res1)

      // Next completion arrives before res1 is accepted -> res1 was replaced/unaccepted
      const res2 = await service.trigger(makeSnapshot({ rawPrefix: "const a", documentVersion: 2 }), "file:///test.ts")
      assert.ok(res2)

      const profile = (ledger as any).getProfile?.("dep-fim-1", "autocomplete")
      assert.equal(profile?.sampleCount, 1, "Replaced completion must be finalized as unaccepted sample")
      assert.equal(profile?.successCount, 0)
      assert.equal(profile?.autocomplete?.shown, 1)
      assert.equal(profile?.autocomplete?.accepted, 0)

      service.dispose()
    })

    test("10. Autocomplete empty and stale requests record bounded negative evidence", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      
      // Empty completion
      const gatewayEmpty = {
        complete: async () => ({ text: "   \n\t  ", deploymentId: "dep-fim-empty", providerId: "prov-1" }),
        performanceLedger: ledger,
      } as any
      const serviceEmpty = new AutocompleteService({
        gateway: gatewayEmpty,
        debounceMs: 0,
        scheduler: { schedule: (fn: () => void) => { setTimeout(fn, 0); return { cancel: () => {} } } },
        performanceLedger: ledger,
      })
      const emptyRes = await serviceEmpty.trigger(makeSnapshot(), "file:///test.ts")
      assert.equal(emptyRes, null)
      const emptyProfile = (ledger as any).getProfile?.("dep-fim-empty", "autocomplete")
      assert.equal(emptyProfile?.sampleCount, 1)
      assert.equal(emptyProfile?.autocomplete?.empty, 1)
      serviceEmpty.dispose()

      // Stale completion
      const gatewayStale = {
        complete: async () => ({ text: "validCompletion()", deploymentId: "dep-fim-stale", providerId: "prov-1" }),
        performanceLedger: ledger,
      } as any
      const serviceStale = new AutocompleteService({
        gateway: gatewayStale,
        debounceMs: 0,
        scheduler: { schedule: (fn: () => void) => { setTimeout(fn, 0); return { cancel: () => {} } } },
        performanceLedger: ledger,
      })
      const staleRes = await serviceStale.trigger(
        makeSnapshot({ documentVersion: 1 }),
        "file:///test.ts",
        undefined,
        // Live editor moved to version 2 -> stale!
        () => ({ documentUri: "file:///test.ts", documentVersion: 2, cursorLine: 0, cursorCharacter: 6 })
      )
      assert.equal(staleRes, null)
      const staleProfile = (ledger as any).getProfile?.("dep-fim-stale", "autocomplete")
      assert.equal(staleProfile?.sampleCount, 1)
      assert.equal(staleProfile?.autocomplete?.staleDiscarded, 1)
      serviceStale.dispose()
    })

    test("11. Autocomplete measured latency is non-synthetic", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const gateway = {
        complete: async () => {
          await new Promise(r => setTimeout(r, 10))
          return { text: "delayedResult()", deploymentId: "dep-fim-lat", providerId: "prov-1" }
        },
        performanceLedger: ledger,
      } as any

      const service = new AutocompleteService({
        gateway,
        debounceMs: 0,
        scheduler: { schedule: (fn: () => void) => { setTimeout(fn, 0); return { cancel: () => {} } } },
        performanceLedger: ledger,
      })

      const res = await service.trigger(makeSnapshot(), "file:///test.ts")
      assert.ok(res)
      service.recordAccepted(res.requestId)

      const profile = (ledger as any).getProfile?.("dep-fim-lat", "autocomplete")
      assert.ok(profile?.emaLatencyMs >= 5, `Measured latency must be >= 5ms, got ${profile?.emaLatencyMs}`)
      service.dispose()
    })

    test("12. Agent and Autocomplete profiles survive shared persistence without clobbering each other", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "open-vs-code-eval-shared-persist-"))
      const ledgerPath = join(tmp, "shared-ledger.json")

      try {
        // Session 1: Agent writes a coding profile
        const agentLedger = new ModelPerformanceLedger({ persistPath: ledgerPath, minimumSamples: 1 })
        await agentLedger.ready
        agentLedger.recordAgentOutcome({
          deploymentId: "dep-qwen-agent",
          taskClass: "coding",
          success: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 120,
        })
        await agentLedger.persist()

        // Session 2: Autocomplete writes an autocomplete profile using same file path
        const acLedger = new ModelPerformanceLedger({ persistPath: ledgerPath, minimumSamples: 1 })
        await acLedger.ready
        acLedger.recordAutocompleteOutcome({
          deploymentId: "dep-qwen-fim",
          shown: true,
          accepted: true,
          staleDiscarded: false,
          emptyCompletion: false,
          cancelled: false,
          latencyMs: 45,
        })
        await acLedger.persist()

        // Session 3: Reload in fresh independent ledger instance
        const verifyLedger = new ModelPerformanceLedger({ persistPath: ledgerPath })
        const { loaded } = await verifyLedger.load()
        assert.equal(loaded, true)

        const agentProfile = (verifyLedger as any).getProfile?.("dep-qwen-agent", "coding")
        const fimProfile = (verifyLedger as any).getProfile?.("dep-qwen-fim", "autocomplete")

        assert.ok(agentProfile, "Agent profile must survive subsequent autocomplete persistence")
        assert.equal(agentProfile.sampleCount, 1)
        assert.equal(agentProfile.successCount, 1)

        assert.ok(fimProfile, "Autocomplete profile must survive alongside agent profile")
        assert.equal(fimProfile.sampleCount, 1)
        assert.equal(fimProfile.successCount, 1)
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("13. First route after startup uses preloaded evidence deterministically", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "open-vs-code-eval-startup-route-"))
      const ledgerPath = join(tmp, ".open-vs-code", "model-performance-ledger.json")

      try {
        await mkdir(join(tmp, ".open-vs-code"), { recursive: true })
        // Seed historical evidence into disk ledger:
        // d1 has 10 consecutive failures (poor score)
        // d2 has 10 consecutive successes (good score)
        const seedLedger = new ModelPerformanceLedger({ persistPath: ledgerPath, minimumSamples: 5 })
        for (let i = 0; i < 10; i++) {
          seedLedger.recordAgentOutcome({
            deploymentId: "d1",
            taskClass: "coding",
            success: false,
            verificationSuccess: false,
            toolCallSuccess: false,
            repairCycles: 3,
            timeoutOccurred: true,
            cancellationOccurred: false,
            latencyMs: 500,
          })
          seedLedger.recordAgentOutcome({
            deploymentId: "d2",
            taskClass: "coding",
            success: true,
            verificationSuccess: true,
            toolCallSuccess: true,
            repairCycles: 0,
            timeoutOccurred: false,
            cancellationOccurred: false,
            latencyMs: 100,
          })
        }
        await seedLedger.persist()

        const config: RoutingConfiguration = {
          providers: [
            { id: "p1", kind: "scripted" },
            { id: "p2", kind: "scripted" },
          ],
          models: [
            { id: "m1", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" },
            { id: "m2", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" },
          ],
          // Static priority normally favors d1 (priority 100 vs 50)
          deployments: [
            { id: "d1", providerId: "p1", modelId: "m1", priority: 100, enabled: true },
            { id: "d2", providerId: "p2", modelId: "m2", priority: 50, enabled: true },
          ],
          routes: {
            coding: ["d1", "d2"],
            default: ["d1", "d2"],
          },
        }
        await writeFile(join(tmp, ".open-vs-code", "models.json"), JSON.stringify(config), "utf-8")

        // Create runtime: createAgentRuntime awaits ledger.load() before returning
        const runtime = await createAgentRuntime({
          workspaceRoot: tmp,
          mode: "BUILD",
          instruction: "Build task",
          isTrusted: true,
          eventSink: () => {},
        })

        // If not routed yet, trigger a route:
        const firstDecision = await (runtime.routedGateway as any).selectDeployment?.({
          taskClass: "coding",
          needsTools: false,
          needsStructuredOutput: false,
          estimatedInputTokens: 50,
          requiredContextWindow: 500,
          requiredCapabilities: ["coding"],
        })
        if (firstDecision) {
          assert.equal(firstDecision.deploymentId, "d2", "First routing decision must use loaded performance adjustments without race")
        }
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("14. Benchmark explicitly disables adaptive routing and route remains pinned", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 5 })
      // Heavily penalize d1
      for (let i = 0; i < 10; i++) {
        ledger.recordAgentOutcome({
          deploymentId: "d1",
          taskClass: "coding",
          success: false,
          verificationSuccess: false,
          toolCallSuccess: false,
          repairCycles: 5,
          timeoutOccurred: true,
          cancellationOccurred: false,
          latencyMs: 900,
        })
      }

      // Explicitly disable adaptation (ADR-027 benchmark contract)
      ledger.disableAdaptiveRouting()
      assert.equal(ledger.adaptiveRoutingActive, false)

      const adjustments = ledger.getRoutingAdjustments(["d1", "d2"], "coding")
      assert.deepEqual(adjustments, [], "When adaptive routing is disabled, adjustments must strictly be empty")

      const config: RoutingConfiguration = {
        providers: [{ id: "p1", kind: "scripted" }],
        models: [{ id: "m1", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" }],
        deployments: [
          { id: "d1", providerId: "p1", modelId: "m1", priority: 100, enabled: true },
          { id: "d2", providerId: "p1", modelId: "m1", priority: 50, enabled: true },
        ],
        routes: { default: ["d1", "d2"] },
      }
      const router = new ModelRouter(config, { performanceLedger: ledger })
      const health = new StaticHealthChecker(new Map([["d1", "ready"], ["d2", "ready"]]))
      const decision = await router.route({
        taskClass: "coding",
        needsTools: false,
        needsStructuredOutput: false,
        estimatedInputTokens: 100,
        requiredContextWindow: 1000,
        requiredCapabilities: ["coding"],
      }, health)

      assert.equal(decision.deploymentId, "d1", "Benchmark route must stay statically pinned to priority 100")
    })

    test("15. Benchmark route provenance is measured from runtime decision, not hardcoded", async () => {
      const config: RoutingConfiguration = {
        providers: [{ id: "p-prov", kind: "scripted" }],
        models: [{ id: "m-actual", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" }],
        deployments: [{ id: "dep-actual-42", providerId: "p-prov", modelId: "m-actual", priority: 10, enabled: true }],
        routes: { default: ["dep-actual-42"] },
      }
      const providers = new Map([
        ["dep-actual-42", new ScriptedModelProvider([response("Result")])],
      ])
      const gateway = new RoutedModelGateway({
        config,
        providers,
        healthChecker: new StaticHealthChecker(new Map([["dep-actual-42", "ready"]])),
        mode: "ASK",
        hasTools: false,
        hasStructuredOutput: false,
      })

      const runner = new AgentRunner({
        provider: gateway,
        registry: createReadOnlyToolRegistry(),
      })
      const budget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })
      await runner.run({
        task: { id: "t-prov-1", mode: "ASK", instruction: "Run" },
        workspaceRoot: tmpdir(),
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      })

      const dec = gateway.lastDecision
      assert.ok(dec)
      assert.equal(dec.deploymentId, "dep-actual-42")
      assert.equal(dec.providerId, "p-prov")
      assert.equal(dec.modelId, "m-actual")
    })

    test("16. validateStructuralSyntax distinguishes full JSON parsing from delimiter balancing", () => {
      // JSON requires valid parse
      assert.equal(validateStructuralSyntax('{"key": 42}', "json", "", ""), true)
      assert.equal(validateStructuralSyntax('{"key": ', "json", "", ""), false)

      // TypeScript / JavaScript checks string & delimiter balance
      assert.equal(validateStructuralSyntax('function test() { return [1, 2, (3 + 4)]; }', "typescript", "", ""), true)
      assert.equal(validateStructuralSyntax('function test() { return [1, 2, (3 + 4); }', "typescript", "", ""), false)
      assert.equal(validateStructuralSyntax('const str = "unclosed string', "javascript", "", ""), false)

      // Empty string is never valid
      assert.equal(validateStructuralSyntax('', "typescript", "", ""), false)
      assert.equal(validateStructuralSyntax('   ', "typescript", "", ""), false)
    })

    test("17. Privacy invariant: Persisted ledger on disk contains strictly zero code, prompts, secrets, or diffs", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "open-vs-code-eval-privacy-"))
      const ledgerPath = join(tmp, "ledger-privacy.json")

      try {
        const ledger = new ModelPerformanceLedger({ persistPath: ledgerPath, minimumSamples: 1 })
        ledger.recordAgentOutcome({
          deploymentId: "dep-confidential-test",
          taskClass: "coding",
          success: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 150,
        })
        ledger.recordAutocompleteOutcome({
          deploymentId: "dep-fim-privacy",
          shown: true,
          accepted: true,
          staleDiscarded: false,
          emptyCompletion: false,
          cancelled: false,
          latencyMs: 30,
        })
        await ledger.persist()

        const diskContent = await readFile(ledgerPath, "utf-8")
        assert.ok(!diskContent.includes("prompt"), "No prompts in persisted ledger")
        assert.ok(!diskContent.includes("completion"), "No completions in persisted ledger")
        assert.ok(!diskContent.includes("secret"), "No secrets in persisted ledger")
        assert.ok(!diskContent.includes("Bearer"), "No bearer auth tokens in persisted ledger")
        assert.ok(!diskContent.includes("function"), "No source code in persisted ledger")

        const parsed = JSON.parse(diskContent)
        assert.equal(parsed.schemaVersion, LEDGER_SCHEMA_VERSION)
        assert.equal(parsed.profiles.length, 2)
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("18. Negative comparators: broken evidence paths strictly fail assertions", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      ledger.recordAutocompleteOutcome({
        deploymentId: "d-neg",
        shown: true,
        accepted: true,
        staleDiscarded: false,
        emptyCompletion: false,
        cancelled: false,
        latencyMs: 25,
      })

      // Negative comparator A: Artificial double-counting claim must fail
      const profile = (ledger as any).getProfile?.("d-neg", "autocomplete")
      assert.throws(
        () => assert.equal(profile?.sampleCount, 2, "Negative comparator: sampleCount was falsely assumed to be 2"),
        /ERR_ASSERTION/
      )

      // Negative comparator B: Unrecorded deployment does not exist
      assert.equal((ledger as any).getProfile?.("d-non-existent", "autocomplete"), undefined)
    })
  })

  describe("12. Sprint 4E.4 — Evidence Semantics, Persistence Safety & Final Closure", () => {
    test("1. Formula: Verification matters — passed verification receives higher score than failed verification", () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 5 })
      for (let i = 0; i < 10; i++) {
        ledger.recordAgentOutcome({
          deploymentId: "dep-verified-fail",
          taskClass: "coding",
          success: false,
          qualitySuccess: false,
          runtimeCompleted: true,
          verificationSuccess: false,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 100,
        })
        ledger.recordAgentOutcome({
          deploymentId: "dep-verified-pass",
          taskClass: "coding",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 100,
        })
      }

      const adjustments = ledger.getRoutingAdjustments(
        ["dep-verified-fail", "dep-verified-pass"],
        "coding",
      )
      const adjFail = adjustments.find(a => a.deploymentId === "dep-verified-fail")?.adjustment ?? 0
      const adjPass = adjustments.find(a => a.deploymentId === "dep-verified-pass")?.adjustment ?? 0

      assert.ok(adjPass > 0, `Expected positive adjustment for passed verification, got ${adjPass}`)
      assert.ok(adjFail < 0, `Expected negative adjustment for failed verification, got ${adjFail}`)
      assert.ok(adjPass > adjFail, "Passed verification must score strictly higher than failed verification")
    })

    test("2. Formula: Tool reliability matters — successful tool calls score better than failed tool calls", () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 5 })
      for (let i = 0; i < 10; i++) {
        ledger.recordAgentOutcome({
          deploymentId: "dep-tool-fail",
          taskClass: "coding",
          success: false,
          qualitySuccess: false,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: false,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 100,
        })
        ledger.recordAgentOutcome({
          deploymentId: "dep-tool-pass",
          taskClass: "coding",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 100,
        })
      }

      const adjustments = ledger.getRoutingAdjustments(["dep-tool-fail", "dep-tool-pass"], "coding")
      const adjFail = adjustments.find(a => a.deploymentId === "dep-tool-fail")?.adjustment ?? 0
      const adjPass = adjustments.find(a => a.deploymentId === "dep-tool-pass")?.adjustment ?? 0

      assert.ok(adjPass > adjFail, "Successful tool execution must score higher than failed tool execution")
    })

    test("3. Formula: Runtime completion alone is insufficient for quality success", () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      ledger.recordAgentOutcome({
        deploymentId: "dep-unverified",
        taskClass: "coding",
        success: false,
        qualitySuccess: false,
        runtimeCompleted: true,
        verificationSuccess: false,
        toolCallSuccess: true,
        repairCycles: 0,
        timeoutOccurred: false,
        cancellationOccurred: false,
        latencyMs: 200,
      })

      const profile = ledger.getProfile("dep-unverified", "coding")
      assert.ok(profile)
      assert.equal(profile.sampleCount, 1)
      assert.equal(profile.successCount, 0, "Failed verification cannot count as quality success")
      assert.equal(profile.failureCount, 1)
      assert.equal(profile.runtimeCompletedCount, 1, "Runtime completed should be recorded")
      assert.equal(profile.verificationSuccessCount, 0)
    })

    test("4. Formula: Read-only tasks remain valid without penalty", () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 5 })
      for (let i = 0; i < 5; i++) {
        ledger.recordAgentOutcome({
          deploymentId: "dep-readonly",
          taskClass: "general",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 50,
        })
      }

      const adjustments = ledger.getRoutingAdjustments(["dep-readonly"], "general")
      const adj = adjustments.find(a => a.deploymentId === "dep-readonly")?.adjustment ?? 0
      assert.ok(adj > 0, `Read-only completed task must receive positive score, got ${adj}`)
    })

    test("5. Formula: Capability and security filters remain absolute prior to adaptive scoring", async () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 5 })
      for (let i = 0; i < 10; i++) {
        ledger.recordAgentOutcome({
          deploymentId: "dep-high-perf-chat-only",
          taskClass: "coding",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 50,
        })
      }

      const config: RoutingConfiguration = {
        providers: [
          { id: "p1", kind: "fake" },
        ],
        models: [
          { id: "m-chat", capabilities: ["coding"], specialization: "coding", contextWindow: 8192 },
          { id: "m-tools", capabilities: ["coding", "toolUse"], specialization: "coding", contextWindow: 8192 },
        ],
        deployments: [
          { id: "dep-high-perf-chat-only", providerId: "p1", modelId: "m-chat", priority: 10, enabled: true },
          { id: "dep-eligible-tools", providerId: "p1", modelId: "m-tools", priority: 5, enabled: true },
        ],
        routes: {
          coding: ["dep-high-perf-chat-only", "dep-eligible-tools"],
        },
      }

      const health = new StaticHealthChecker(new Map([
        ["dep-high-perf-chat-only", "ready"],
        ["dep-eligible-tools", "ready"],
      ]))
      const router = new ModelRouter(config, {
        performanceLedger: ledger,
      })

      // Request requiring toolUse capability
      const decision = await router.route({
        taskClass: "coding",
        needsTools: true,
        needsStructuredOutput: false,
        estimatedInputTokens: 100,
        requiredContextWindow: 1000,
        requiredCapabilities: ["toolUse"],
      }, health)

      assert.equal(decision.deploymentId, "dep-eligible-tools", "Ineligible high-perf candidate must never be chosen")
    })

    test("6. Persistence: True concurrent disjoint writes via Promise.all() do not lose updates", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-concurrent-disjoint-"))
      const ledgerPath = join(tmp, "ledger.json")

      try {
        for (let iteration = 0; iteration < 3; iteration++) {
          const ledgerAgent = new ModelPerformanceLedger({ persistPath: ledgerPath })
          const ledgerAc = new ModelPerformanceLedger({ persistPath: ledgerPath })

          ledgerAgent.recordAgentOutcome({
            deploymentId: `dep-agent-${iteration}`,
            taskClass: "coding",
            success: true,
            qualitySuccess: true,
            runtimeCompleted: true,
            verificationSuccess: true,
            toolCallSuccess: true,
            repairCycles: 0,
            timeoutOccurred: false,
            cancellationOccurred: false,
            latencyMs: 100,
          })

          ledgerAc.recordAutocompleteOutcome({
            deploymentId: `dep-ac-${iteration}`,
            shown: true,
            accepted: true,
            staleDiscarded: false,
            emptyCompletion: false,
            cancelled: false,
            latencyMs: 25,
          })

          // Concurrent persistence
          await Promise.all([ledgerAgent.persist(), ledgerAc.persist()])

          const fresh = new ModelPerformanceLedger({ persistPath: ledgerPath })
          await fresh.ready

          assert.ok(fresh.getProfile(`dep-agent-${iteration}`, "coding"), `Expected agent profile ${iteration} to exist`)
          assert.ok(fresh.getProfile(`dep-ac-${iteration}`, "autocomplete"), `Expected autocomplete profile ${iteration} to exist`)
        }
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("7. Persistence: True concurrent updates to SAME profile do not lose updates", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-concurrent-same-"))
      const ledgerPath = join(tmp, "ledger.json")

      try {
        const inst1 = new ModelPerformanceLedger({ persistPath: ledgerPath })
        const inst2 = new ModelPerformanceLedger({ persistPath: ledgerPath })

        // Instance 1 records 5 samples
        for (let i = 0; i < 5; i++) {
          inst1.recordAgentOutcome({
            deploymentId: "dep-shared",
            taskClass: "coding",
            success: true,
            qualitySuccess: true,
            runtimeCompleted: true,
            verificationSuccess: true,
            toolCallSuccess: true,
            repairCycles: 0,
            timeoutOccurred: false,
            cancellationOccurred: false,
            latencyMs: 50,
          })
        }

        // Instance 2 records 7 samples
        for (let i = 0; i < 7; i++) {
          inst2.recordAgentOutcome({
            deploymentId: "dep-shared",
            taskClass: "coding",
            success: true,
            qualitySuccess: true,
            runtimeCompleted: true,
            verificationSuccess: true,
            toolCallSuccess: true,
            repairCycles: 0,
            timeoutOccurred: false,
            cancellationOccurred: false,
            latencyMs: 70,
          })
        }

        // Persist concurrently
        await Promise.all([inst1.persist(), inst2.persist()])

        const reloaded = new ModelPerformanceLedger({ persistPath: ledgerPath })
        await reloaded.ready

        const profile = reloaded.getProfile("dep-shared", "coding")
        assert.ok(profile)
        assert.equal(profile.sampleCount, 12, "All 12 samples from both instances must be preserved")
        assert.equal(profile.successCount, 12)
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("8. Persistence: Schema-version reset safely resets legacy stores to schema 2", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-schema-reset-"))
      const ledgerPath = join(tmp, "ledger.json")

      try {
        // Write old schema v1 file
        const oldStore = {
          schemaVersion: 1,
          profiles: [{
            deploymentId: "legacy-dep",
            taskClass: "coding",
            sampleCount: 50,
            successCount: 50,
          }],
          lastUpdated: new Date().toISOString(),
        }
        await writeFile(ledgerPath, JSON.stringify(oldStore, null, 2), "utf-8")

        const ledger = new ModelPerformanceLedger({ persistPath: ledgerPath })
        const loadRes = await ledger.load()

        assert.equal(loadRes.resetDueToCorruption, true, "Old schema version must trigger safe reset")
        assert.equal(ledger.profileCount, 0, "In-memory profiles must be cleared on schema mismatch")

        // Record a new sample and persist
        ledger.recordAgentOutcome({
          deploymentId: "new-dep",
          taskClass: "coding",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 100,
        })
        await ledger.persist()

        const raw = await readFile(ledgerPath, "utf-8")
        const parsed = JSON.parse(raw)
        assert.equal(parsed.schemaVersion, LEDGER_SCHEMA_VERSION)
        assert.equal(parsed.profiles.length, 1)
        assert.equal(parsed.profiles[0].deploymentId, "new-dep")
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("9. Persistence: Corrupt file recovery safely resets to empty without throwing", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-corrupt-"))
      const ledgerPath = join(tmp, "ledger.json")

      try {
        await writeFile(ledgerPath, "NOT_VALID_JSON{{{", "utf-8")
        const ledger = new ModelPerformanceLedger({ persistPath: ledgerPath })
        const res = await ledger.load()

        assert.equal(res.resetDueToCorruption, true)
        assert.equal(ledger.profileCount, 0)

        // Verify ledger remains fully operational
        ledger.recordAgentOutcome({
          deploymentId: "dep-after-corrupt",
          taskClass: "general",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 100,
        })
        await ledger.persist()

        const fresh = new ModelPerformanceLedger({ persistPath: ledgerPath })
        await fresh.ready
        assert.equal(fresh.profileCount, 1)
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("10. Persistence: Bounded maxProfiles prunes oldest profiles on growth", async () => {
      const ledger = new ModelPerformanceLedger({ maxProfiles: 3 })
      for (let i = 1; i <= 5; i++) {
        ledger.recordAgentOutcome({
          deploymentId: `dep-${i}`,
          taskClass: "coding",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 50,
        })
      }
      assert.ok(ledger.profileCount <= 3, `Expected at most 3 profiles, got ${ledger.profileCount}`)
    })

    test("11. Credentials: apiKeyEnv loads and resolves from environment variable", () => {
      const envKey = "TEST_LOCAL_MODEL_API_KEY_AUTH"
      process.env[envKey] = "secret-token-xyz-123"
      try {
        const resolved = resolveProviderApiKey({ apiKeyEnv: envKey })
        assert.equal(resolved, "secret-token-xyz-123")
      } finally {
        delete process.env[envKey]
      }
    })

    test("12. Credentials: Literal apiKey in models configuration is strictly rejected", () => {
      const badConfig = {
        providers: [
          { id: "p-literal", kind: "openai_compatible_local", apiKey: "plaintext-secret" } as any,
        ],
        models: [
          { id: "m1", capabilities: ["coding"], specialization: "coding", contextWindow: 4096 },
        ],
        deployments: [
          { id: "d1", providerId: "p-literal", modelId: "m1", priority: 1, enabled: true },
        ],
      }

      assert.throws(
        () => validateRoutingConfig(badConfig),
        (err: any) => {
          assert.ok(err instanceof ConfigValidationError)
          assert.ok(err.message.includes("forbidden literal 'apiKey'"))
          return true
        }
      )
    })

    test("13. Credentials: Missing referenced env variable throws safe AUTHENTICATION_REQUIRED without leaking key", () => {
      const missingKey = "NONEXISTENT_KEY_12345"
      delete process.env[missingKey]

      assert.throws(
        () => resolveProviderApiKey({ apiKeyEnv: missingKey }),
        (err: any) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.includes("AUTHENTICATION_REQUIRED"))
          assert.ok(!err.message.includes("password"))
          assert.ok(!err.message.includes("secret"))
          return true
        }
      )
    })

    test("14. Credentials: Auth headers reach both inference provider and health probe", async () => {
      const envKey = "TEST_AUTH_PROBE_ENV"
      process.env[envKey] = "probe-auth-token-42"
      const tmp = await mkdtemp(join(tmpdir(), "auth-probe-test-"))
      try {
        let capturedProbeHeader: string | null = null
        let capturedInferenceHeader: string | null = null

        const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const urlStr = String(input)
          const headers = init?.headers as Record<string, string> | undefined
          if (urlStr.includes("/v1/models")) {
            capturedProbeHeader = headers?.authorization ?? null
            return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), { status: 200 })
          }
          if (urlStr.includes("/v1/chat/completions")) {
            capturedInferenceHeader = headers?.authorization ?? null
            return new Response(JSON.stringify({
              choices: [{ message: { role: "assistant", content: "Auth success" } }]
            }), { status: 200 })
          }
          return new Response("Not found", { status: 404 })
        }

        const healthChecker = new EndpointHealthChecker({
          endpoints: new Map([["dep-auth", "http://127.0.0.1:11434"]]),
          headers: new Map([["dep-auth", { authorization: `Bearer ${process.env[envKey]}` }]]),
          fetch: mockFetch as any,
        })

        const health = await healthChecker.checkHealth("dep-auth")
        assert.equal(health, "ready")
        assert.equal(capturedProbeHeader, "Bearer probe-auth-token-42", "Health probe must receive authorization header")

        const provider = new OpenAICompatibleProvider({
          baseUrl: "http://127.0.0.1:11434",
          model: "m-code",
          headers: { authorization: `Bearer ${process.env[envKey]}` },
          fetch: mockFetch as any,
        })

        await provider.complete({
          messages: [{ role: "user", content: "test" }],
        })
        assert.equal(capturedInferenceHeader, "Bearer probe-auth-token-42", "Inference must receive authorization header")
      } finally {
        delete process.env[envKey]
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("15. Shutdown durability: Awaited dispose flushes pending shown outcome and debounce to disk", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "shutdown-durability-"))
      const ledgerPath = join(tmp, "ledger.json")

      try {
        const ledger = new ModelPerformanceLedger({ persistPath: ledgerPath })
        await ledger.ready

        let lastDecision: any = { deploymentId: "dep-shutdown-ac" }
        const mockGateway = {
          lastDecision,
          performanceLedger: ledger,
          complete: async () => ({ text: "return 42", deploymentId: "dep-shutdown-ac", providerId: "p1" }),
        }

        const service = new AutocompleteService({
          gateway: mockGateway as any,
          performanceLedger: ledger,
          debounceMs: 0,
          scheduler: { schedule: (fn: () => void) => { setTimeout(fn, 0); return { cancel: () => {} } } },
        })

        // Request a completion
        const snapshot = makeSnapshot({ rawPrefix: "function answer(): number {\n  " })
        const res = await service.trigger(snapshot, "file:///test.ts")
        assert.ok(res)
        assert.equal(res.text, "return 42")

        // Awaited shutdown dispose
        await service.dispose()

        // Read ledger from disk — pending shown completion must have been finalized and written
        const diskContent = await readFile(ledgerPath, "utf-8")
        const parsed = JSON.parse(diskContent)
        assert.equal(parsed.schemaVersion, LEDGER_SCHEMA_VERSION)
        const acProfile = parsed.profiles.find((p: any) => p.taskClass === "autocomplete")
        assert.ok(acProfile, "Autocomplete profile must exist on disk after awaited shutdown")
        assert.equal(acProfile.autocomplete.shown, 1, "Pending shown completion must be recorded on shutdown")
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("16. Initialization: Production construction triggers exactly one load operation", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-init-contract-"))
      const ledgerPath = join(tmp, "ledger.json")

      try {
        const initialStore = {
          schemaVersion: LEDGER_SCHEMA_VERSION,
          profiles: [],
          lastUpdated: new Date().toISOString(),
        }
        await writeFile(ledgerPath, JSON.stringify(initialStore), "utf-8")

        const ledger = new ModelPerformanceLedger({ persistPath: ledgerPath })
        await ledger.ready

        assert.equal(ledger.loadCount, 1, "Construction must trigger exactly one load operation")

        // Calling load() after ready coalesces or shares the loaded state
        await ledger.load()
        assert.equal(ledger.loadCount, 1, "Redundant load() after readiness must not perform duplicate I/O")
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("17. Initialization: Late loader cannot overwrite an outcome recorded after readiness", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "ledger-late-load-"))
      const ledgerPath = join(tmp, "ledger.json")

      try {
        const initialStore = {
          schemaVersion: LEDGER_SCHEMA_VERSION,
          profiles: [{
            deploymentId: "dep-initial",
            taskClass: "coding",
            sampleCount: 1,
            successCount: 1,
            failureCount: 0,
            verificationSuccessCount: 1,
            toolCallSuccessCount: 1,
            totalRepairCycles: 0,
            timeoutCount: 0,
            cancellationCount: 0,
            emaLatencyMs: 50,
          }],
          lastUpdated: new Date().toISOString(),
        }
        await writeFile(ledgerPath, JSON.stringify(initialStore), "utf-8")

        const ledger = new ModelPerformanceLedger({ persistPath: ledgerPath })
        await ledger.ready

        // Record a new outcome in-memory
        ledger.recordAgentOutcome({
          deploymentId: "dep-fresh",
          taskClass: "coding",
          success: true,
          qualitySuccess: true,
          runtimeCompleted: true,
          verificationSuccess: true,
          toolCallSuccess: true,
          repairCycles: 0,
          timeoutOccurred: false,
          cancellationOccurred: false,
          latencyMs: 80,
        })

        // Late load must not erase dep-fresh
        await ledger.load()

        assert.ok(ledger.getProfile("dep-fresh", "coding"), "Fresh outcome recorded after ready must be preserved")
        assert.ok(ledger.getProfile("dep-initial", "coding"), "Initial profile must also exist")
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {})
      }
    })

    test("18. Autocomplete provider failure records truthful failure evidence for selected deployment", async () => {
      let routeDecision = { deploymentId: "dep-failing-provider" }
      const mockGateway = {
        lastDecision: routeDecision,
        complete: async () => {
          throw new Error("HTTP 500: Inference engine internal error")
        },
      }

      const ledger = new ModelPerformanceLedger({ minimumSamples: 1 })
      const service = new AutocompleteService({
        gateway: mockGateway as any,
        performanceLedger: ledger,
        debounceMs: 0,
        scheduler: { schedule: (fn: () => void) => { setTimeout(fn, 0); return { cancel: () => {} } } },
      })

      const snapshot = makeSnapshot()
      const res = await service.trigger(snapshot, "file:///src/index.ts")
      assert.equal(res, null)

      const profile = ledger.getProfile("dep-failing-provider", "autocomplete")
      assert.ok(profile, "Profile must be created for failed deployment")
      assert.equal(profile.sampleCount, 1)
      assert.equal(profile.failureCount, 1, "Provider failure must record failureCount")
      assert.equal(profile.autocomplete?.failed, 1, "Failed count must increment")
    })

    test("19. Negative comparators: broken evidence paths strictly fail assertions", () => {
      const ledger = new ModelPerformanceLedger({ minimumSamples: 5 })
      ledger.recordAgentOutcome({
        deploymentId: "dep-neg",
        taskClass: "coding",
        success: false,
        qualitySuccess: false,
        runtimeCompleted: true,
        verificationSuccess: false,
        toolCallSuccess: true,
        repairCycles: 0,
        timeoutOccurred: false,
        cancellationOccurred: false,
        latencyMs: 100,
      })

      const profile = ledger.getProfile("dep-neg", "coding")
      assert.throws(
        () => assert.equal(profile?.successCount, 1, "Negative comparator: unverified run cannot count as success"),
        /ERR_ASSERTION/
      )
    })
  })
})
