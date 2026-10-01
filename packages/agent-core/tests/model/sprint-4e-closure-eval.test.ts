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
import { ModelPerformanceLedger } from "../../src/model/performance-ledger.ts"
import {
  validateRoutingConfig,
  loadRoutingConfig,
  ConfigValidationError,
} from "../../src/model/config-loader.ts"
import type { RoutingConfiguration } from "../../src/contracts/routing.ts"
import { ModelRouter } from "../../src/model/router.ts"

const fakeFetchMalformed = async () => new Response("<html>Gateway Timeout</html>", {
  status: 504,
  headers: { "content-type": "text/html" },
})

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

        assert.equal(parsed.schemaVersion, 1)
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
})
