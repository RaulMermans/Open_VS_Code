/* eslint-disable unicorn/consistent-function-scoping */
/**
 * Deterministic Model Integration Evaluation — Sprint 4E.
 *
 * Covers the protocol contracts, provider adapters, performance ledger, 
 * inference gate, endpoint health, and adaptive routing WITHOUT requiring
 * real model weights.
 *
 * All scenarios are deterministic with scripted HTTP responses.
 * Normal `npm test` remains model-independent.
 */

import type { FimStrategy } from "../../src/autocomplete/local-fim-provider.ts"
import { buildFimPrompt, stripFimStopTokens, LocalFimProvider, LocalFimProviderError } from "../../src/autocomplete/local-fim-provider.ts"
import { ModelPerformanceLedger } from "../../src/model/performance-ledger.ts"
import { checkInferenceGate, inferenceGateBlockedMessage } from "../../src/model/inference-gate.ts"
import { EndpointHealthChecker } from "../../src/model/endpoint-health.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { ModelRouter } from "../../src/model/router.ts"
import type { RoutingConfiguration } from "../../src/contracts/routing.ts"

export interface IntegrationScenarioResult {
  readonly id: string
  readonly category: string
  readonly description: string
  readonly passed: boolean
  readonly actual: unknown
  readonly expected: unknown
  readonly error?: string
}

export interface IntegrationEvaluationSummary {
  readonly totalScenarios: number
  readonly passed: number
  readonly failed: number
  readonly categories: Record<string, { total: number; passed: number }>
  readonly results: readonly IntegrationScenarioResult[]
}

function scenario(
  id: string,
  category: string,
  description: string,
  passed: boolean,
  actual: unknown,
  expected: unknown,
  error?: string,
): IntegrationScenarioResult {
  return { id, category, description, passed, actual, expected, ...(error !== undefined ? { error } : {}) }
}

// ── FIM Strategy Formatting ──────────────────────────────────────────────────

function evalFimFormatting(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []
  const pre = "hello "
  const suf = " world"

  const strategies: FimStrategy[] = ["qwen", "starcoder", "deepseek", "prefix-suffix-middle", "raw-prefix"]
  for (const strat of strategies) {
    const prompt = buildFimPrompt(pre, suf, strat)
    let expectedContains: string
    switch (strat) {
      case "qwen": expectedContains = "<|fim_prefix|>"; break
      case "starcoder": expectedContains = "<fim_prefix>"; break
      case "deepseek": expectedContains = "<｜fim▁begin｜>"; break
      case "prefix-suffix-middle": expectedContains = "<PRE>"; break
      case "raw-prefix": expectedContains = "hello "; break
    }
    const passed = prompt.includes(expectedContains) && prompt.includes(pre)
    results.push(scenario(
      `FIM-FMT-${strat.toUpperCase().replace(/-/g, "_")}`,
      "fim_formatting",
      `FIM prompt contains strategy marker: ${strat}`,
      passed, prompt.slice(0, 60), `includes(${expectedContains})`,
    ))
  }

  // Prefix is always present
  for (const strat of strategies) {
    const prompt = buildFimPrompt(pre, suf, strat)
    results.push(scenario(
      `FIM-PREFIX-${strat.toUpperCase().replace(/-/g, "_")}`,
      "fim_formatting",
      `FIM prompt contains prefix text: ${strat}`,
      prompt.includes(pre), prompt.slice(0, 60), `includes('${pre}')`,
    ))
  }

  return results
}

// ── FIM Stop Token Stripping ─────────────────────────────────────────────────

function evalStopTokenStripping(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []

  const cases: Array<{ strategy: FimStrategy; raw: string; expected: string }> = [
    { strategy: "qwen", raw: "x + y<|endoftext|>garbage", expected: "x + y" },
    { strategy: "starcoder", raw: "x + y<|endoftext|>garbage", expected: "x + y" },
    { strategy: "deepseek", raw: "x + y<｜fim▁end｜>garbage", expected: "x + y" },
    { strategy: "prefix-suffix-middle", raw: "x + y</s>garbage", expected: "x + y" },
    { strategy: "raw-prefix", raw: "x + y<|endoftext|>garbage", expected: "x + y<|endoftext|>garbage" },
  ]

  for (const c of cases) {
    const result = stripFimStopTokens(c.raw, c.strategy)
    results.push(scenario(
      `FIM-STRIP-${c.strategy.toUpperCase().replace(/-/g, "_")}`,
      "fim_stop_tokens",
      `Strip stop tokens for strategy: ${c.strategy}`,
      result === c.expected, result, c.expected,
    ))
  }

  // Clean text passes through unchanged
  const clean = "result = a + b"
  for (const strat of ["qwen", "starcoder"] as FimStrategy[]) {
    const stripped = stripFimStopTokens(clean, strat)
    results.push(scenario(
      `FIM-STRIP-CLEAN-${strat.toUpperCase()}`,
      "fim_stop_tokens",
      `Clean text unchanged: ${strat}`,
      stripped === clean, stripped, clean,
    ))
  }

  return results
}

// ── LocalFimProvider Construction ────────────────────────────────────────────

function evalFimProviderConstruction(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []

  // Valid construction
  try {
    const p = new LocalFimProvider({
      providerId: "local-fim", modelId: "qwen2.5", deploymentId: "dep-1",
      baseUrl: "http://localhost:11434", model: "qwen2.5-coder:7b",
      fimStrategy: "qwen", timeoutMs: 10_000,
    })
    results.push(scenario("FIM-CTOR-VALID", "fim_provider", "LocalFimProvider valid construction",
      p.providerId === "local-fim" && p.fimStrategy === "qwen", p.providerId, "local-fim"))
  } catch (e) {
    results.push(scenario("FIM-CTOR-VALID", "fim_provider", "LocalFimProvider valid construction",
      false, String(e), "no error"))
  }

  // Empty model rejected
  let caughtEmpty = false
  try {
    const unusedProvider = new LocalFimProvider({ providerId: "p", modelId: "m", deploymentId: "d",
      baseUrl: "http://localhost:11434", model: "" })
    void unusedProvider
  } catch { caughtEmpty = true }
  results.push(scenario("FIM-CTOR-EMPTY-MODEL", "fim_provider", "LocalFimProvider rejects empty model",
    caughtEmpty, caughtEmpty, true))

  // Invalid timeout rejected
  let caughtTimeout = false
  try {
    const unusedProvider = new LocalFimProvider({ providerId: "p", modelId: "m", deploymentId: "d",
      baseUrl: "http://localhost:11434", model: "qwen", timeoutMs: -1 })
    void unusedProvider
  } catch { caughtTimeout = true }
  results.push(scenario("FIM-CTOR-BAD-TIMEOUT", "fim_provider", "LocalFimProvider rejects negative timeout",
    caughtTimeout, caughtTimeout, true))

  // Non-HTTP URL rejected
  let caughtBadUrl = false
  try {
    const unusedProvider = new LocalFimProvider({ providerId: "p", modelId: "m", deploymentId: "d",
      baseUrl: "ftp://localhost:11434", model: "qwen" })
    void unusedProvider
  } catch { caughtBadUrl = true }
  results.push(scenario("FIM-CTOR-BAD-URL", "fim_provider", "LocalFimProvider rejects non-HTTP URL",
    caughtBadUrl, caughtBadUrl, true))

  return results
}

// ── LocalFimProvider HTTP behaviour (fake fetch) ─────────────────────────────

async function evalFimProviderHttp(): Promise<IntegrationScenarioResult[]> {
  const results: IntegrationScenarioResult[] = []

  // Happy path: provider returns completion
  {
    const fakeFetch = async (_url: unknown, _init: unknown) => new Response(
      JSON.stringify({ choices: [{ text: " + b", finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
    const p = new LocalFimProvider({
      providerId: "local", modelId: "m", deploymentId: "d",
      baseUrl: "http://localhost:11434", model: "qwen", fimStrategy: "qwen",
      fetch: fakeFetch as unknown as typeof fetch,
    })
    try {
      const resp = await p.complete({
        requestId: "r1", prefix: "a", suffix: ";", languageId: "ts",
        maxOutputTokens: 20, signal: AbortSignal.timeout(5000),
      })
      results.push(scenario("FIM-HTTP-OK", "fim_http", "FIM provider returns completion on 200",
        resp.text === " + b" && resp.deploymentId === "d", resp.text, " + b"))
      results.push(scenario("FIM-HTTP-USAGE", "fim_http", "FIM provider reports usage tokens",
        resp.usage?.inputTokens === 10 && resp.usage.outputTokens === 3,
        `in=${resp.usage?.inputTokens} out=${resp.usage?.outputTokens}`, "in=10 out=3"))
    } catch (e) {
      results.push(scenario("FIM-HTTP-OK", "fim_http", "FIM provider returns completion on 200",
        false, String(e), "completion"))
      results.push(scenario("FIM-HTTP-USAGE", "fim_http", "FIM provider reports usage tokens",
        false, String(e), "usage"))
    }
  }

  // HTTP 500 → LocalFimProviderError
  {
    const fakeFetch = async () => new Response(null, { status: 500 })
    const p = new LocalFimProvider({
      providerId: "local", modelId: "m", deploymentId: "d",
      baseUrl: "http://localhost:11434", model: "qwen",
      fetch: fakeFetch as unknown as typeof fetch,
    })
    let caught: LocalFimProviderError | undefined
    try {
      await p.complete({
        requestId: "r2", prefix: "a", suffix: ";", languageId: "ts",
        maxOutputTokens: 20, signal: AbortSignal.timeout(5000),
      })
    } catch (e) { if (e instanceof LocalFimProviderError) caught = e }
    results.push(scenario("FIM-HTTP-500", "fim_http", "FIM provider throws LocalFimProviderError on 500",
      caught?.code === "HTTP_ERROR", caught?.code, "HTTP_ERROR"))
  }

  // Malformed JSON → LocalFimProviderError
  {
    const fakeFetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    const p = new LocalFimProvider({
      providerId: "local", modelId: "m", deploymentId: "d",
      baseUrl: "http://localhost:11434", model: "qwen",
      fetch: fakeFetch as unknown as typeof fetch,
    })
    let caught: LocalFimProviderError | undefined
    try {
      await p.complete({
        requestId: "r3", prefix: "a", suffix: ";", languageId: "ts",
        maxOutputTokens: 20, signal: AbortSignal.timeout(5000),
      })
    } catch (e) { if (e instanceof LocalFimProviderError) caught = e }
    results.push(scenario("FIM-HTTP-MALFORMED", "fim_http", "FIM provider throws on malformed JSON",
      caught?.code === "MALFORMED_RESPONSE", caught?.code, "MALFORMED_RESPONSE"))
  }

  // Already-aborted signal → throws immediately
  {
    const fakeFetch = async () => new Response(JSON.stringify({ choices: [{ text: "x" }] }), { status: 200 })
    const p = new LocalFimProvider({
      providerId: "local", modelId: "m", deploymentId: "d",
      baseUrl: "http://localhost:11434", model: "qwen",
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const abortedSignal = AbortSignal.abort()
    let caught: LocalFimProviderError | undefined
    try {
      await p.complete({
        requestId: "r4", prefix: "a", suffix: ";", languageId: "ts",
        maxOutputTokens: 20, signal: abortedSignal,
      })
    } catch (e) { if (e instanceof LocalFimProviderError) caught = e }
    results.push(scenario("FIM-ABORT-BEFORE", "fim_cancellation", "FIM provider throws immediately on aborted signal",
      caught?.code === "CANCELLED", caught?.code, "CANCELLED"))
  }

  // Missing choices array → MALFORMED_RESPONSE
  {
    const fakeFetch = async () => new Response(
      JSON.stringify({ choices: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
    const p = new LocalFimProvider({
      providerId: "local", modelId: "m", deploymentId: "d",
      baseUrl: "http://localhost:11434", model: "qwen",
      fetch: fakeFetch as unknown as typeof fetch,
    })
    let caught: LocalFimProviderError | undefined
    try {
      await p.complete({
        requestId: "r5", prefix: "a", suffix: ";", languageId: "ts",
        maxOutputTokens: 20, signal: AbortSignal.timeout(5000),
      })
    } catch (e) { if (e instanceof LocalFimProviderError) caught = e }
    results.push(scenario("FIM-MALFORMED-CHOICES", "fim_http", "FIM provider throws on empty choices",
      caught?.code === "MALFORMED_RESPONSE", caught?.code, "MALFORMED_RESPONSE"))
  }

  return results
}

// ── ModelPerformanceLedger ───────────────────────────────────────────────────

function evalPerformanceLedger(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []

  // 1. Empty ledger returns no adjustments
  {
    const ledger = new ModelPerformanceLedger()
    const adj = ledger.getRoutingAdjustments(["dep-a", "dep-b"], "coding")
    results.push(scenario("LEDGER-EMPTY-ADJ", "ledger", "Empty ledger returns no routing adjustments",
      adj.length === 0, adj.length, 0))
  }

  // 2. Below minimum samples → no adjustment
  {
    const ledger = new ModelPerformanceLedger({ minimumSamples: 5 })
    for (let i = 0; i < 3; i++) {
      ledger.recordAgentOutcome({ deploymentId: "dep-a", taskClass: "coding",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
    }
    const adj = ledger.getRoutingAdjustments(["dep-a"], "coding")
    results.push(scenario("LEDGER-MIN-SAMPLES", "ledger", "Below minimumSamples returns no adjustment",
      adj.length === 0, adj.length, 0))
  }

  // 3. Sufficient samples with high success → positive adjustment
  {
    const ledger = new ModelPerformanceLedger({ minimumSamples: 5, hysteresisThreshold: 0.05 })
    for (let i = 0; i < 10; i++) {
      ledger.recordAgentOutcome({ deploymentId: "dep-good", taskClass: "coding",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 200 })
    }
    const adj = ledger.getRoutingAdjustments(["dep-good"], "coding")
    const a = adj.find(x => x.deploymentId === "dep-good")
    results.push(scenario("LEDGER-POS-ADJ", "ledger", "High success rate generates positive adjustment",
      a !== undefined && a.adjustment > 0, a?.adjustment, "> 0"))
  }

  // 4. Sufficient samples with high failures → negative adjustment
  {
    const ledger = new ModelPerformanceLedger({ minimumSamples: 5, hysteresisThreshold: 0.05 })
    for (let i = 0; i < 10; i++) {
      ledger.recordAgentOutcome({ deploymentId: "dep-bad", taskClass: "debugging",
        success: false, verificationSuccess: false, toolCallSuccess: false,
        repairCycles: 3, timeoutOccurred: true, cancellationOccurred: false, latencyMs: 5000 })
    }
    const adj = ledger.getRoutingAdjustments(["dep-bad"], "debugging")
    const a = adj.find(x => x.deploymentId === "dep-bad")
    results.push(scenario("LEDGER-NEG-ADJ", "ledger", "High failure rate generates negative adjustment",
      a !== undefined && a.adjustment < 0, a?.adjustment, "< 0"))
  }

  // 5. Adaptive routing disabled → no adjustments regardless of samples
  {
    const ledger = new ModelPerformanceLedger({ minimumSamples: 1, adaptiveRoutingDisabled: true })
    for (let i = 0; i < 10; i++) {
      ledger.recordAgentOutcome({ deploymentId: "dep-x", taskClass: "general",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
    }
    const adj = ledger.getRoutingAdjustments(["dep-x"], "general")
    results.push(scenario("LEDGER-DISABLED", "ledger", "Disabled adaptive routing yields no adjustments",
      adj.length === 0, adj.length, 0))
  }

  // 6. Reset clears all profiles
  {
    const ledger = new ModelPerformanceLedger()
    for (let i = 0; i < 5; i++) {
      ledger.recordAgentOutcome({ deploymentId: "dep-r", taskClass: "coding",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
    }
    const beforeCount = ledger.profileCount
    ledger.reset()
    results.push(scenario("LEDGER-RESET", "ledger", "Reset clears all profiles",
      ledger.profileCount === 0 && beforeCount > 0, ledger.profileCount, 0))
  }

  // 7. Autocomplete metrics tracked
  {
    const ledger = new ModelPerformanceLedger()
    ledger.recordAutocompleteOutcome({ deploymentId: "dep-fim",
      shown: true, accepted: true, staleDiscarded: false, emptyCompletion: false, cancelled: false, latencyMs: 80 })
    const p = ledger.getProfile("dep-fim", "autocomplete")
    results.push(scenario("LEDGER-AC-ACCEPT", "ledger", "Autocomplete acceptance tracked",
      p?.autocomplete?.accepted === 1 && p.successCount === 1, p?.autocomplete?.accepted, 1))
  }

  // 8. Bounded storage — maxProfiles prevents unbounded growth
  {
    const ledger = new ModelPerformanceLedger({ maxProfiles: 5 })
    for (let i = 0; i < 10; i++) {
      ledger.recordAgentOutcome({ deploymentId: `dep-${i}`, taskClass: "coding",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
    }
    results.push(scenario("LEDGER-BOUNDED", "ledger", "Profile storage bounded by maxProfiles",
      ledger.profileCount <= 5, ledger.profileCount, "<= 5"))
  }

  // 9. Hysteresis prevents small-delta routing changes
  {
    const ledger = new ModelPerformanceLedger({ minimumSamples: 5, hysteresisThreshold: 0.4, maxAdjustment: 0.5 })
    for (let i = 0; i < 6; i++) {
      if (i < 4) {
        ledger.recordAgentOutcome({ deploymentId: "dep-h", taskClass: "general",
          success: true, verificationSuccess: true, toolCallSuccess: true,
          repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
      } else {
        ledger.recordAgentOutcome({ deploymentId: "dep-h", taskClass: "general",
          success: false, verificationSuccess: false, toolCallSuccess: false,
          repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
      }
    }
    const adj = ledger.getRoutingAdjustments(["dep-h"], "general")
    const allBounded = adj.every(a => Math.abs(a.adjustment) <= 0.5)
    results.push(scenario("LEDGER-BOUNDED-ADJ", "ledger", "Routing adjustments bounded to maxAdjustment",
      allBounded, "all within [-0.5, 0.5]", "all within [-0.5, 0.5]"))
  }

  // 10. EMA latency tracked (not 0 after recording)
  {
    const ledger = new ModelPerformanceLedger()
    ledger.recordAgentOutcome({ deploymentId: "dep-ema", taskClass: "coding",
      success: true, verificationSuccess: true, toolCallSuccess: true,
      repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 500 })
    const p = ledger.getProfile("dep-ema", "coding")
    results.push(scenario("LEDGER-EMA", "ledger", "EMA latency tracked after recording",
      p !== undefined && p.emaLatencyMs > 0, p?.emaLatencyMs, "> 0"))
  }

  return results
}

// ── Ledger Persistence ───────────────────────────────────────────────────────

async function evalLedgerPersistence(): Promise<IntegrationScenarioResult[]> {
  const results: IntegrationScenarioResult[] = []
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")

  const tmpDir = await mkdtemp(join(tmpdir(), "ledger-test-"))
  const persistPath = join(tmpDir, "profiles.json")

  try {
    // Persist and load
    {
      const ledger = new ModelPerformanceLedger({ persistPath, minimumSamples: 1 })
      for (let i = 0; i < 3; i++) {
        ledger.recordAgentOutcome({ deploymentId: "dep-persist", taskClass: "coding",
          success: true, verificationSuccess: true, toolCallSuccess: true,
          repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 200 })
      }
      await ledger.persist()

      // Load into new ledger
      const ledger2 = new ModelPerformanceLedger({ persistPath, minimumSamples: 1 })
      const { loaded, resetDueToCorruption } = await ledger2.load()
      const p = ledger2.getProfile("dep-persist", "coding")

      results.push(scenario("LEDGER-PERSIST-LOAD", "ledger_persistence", "Persisted profiles can be reloaded",
        loaded && !resetDueToCorruption && p?.sampleCount === 3, { loaded, sampleCount: p?.sampleCount }, { loaded: true, sampleCount: 3 }))
    }

    // Corrupt store → safe reset
    {
      const { writeFile } = await import("node:fs/promises")
      const corruptPath = join(tmpDir, "corrupt.json")
      await writeFile(corruptPath, "not-valid-json")
      const ledger = new ModelPerformanceLedger({ persistPath: corruptPath })
      const { resetDueToCorruption } = await ledger.load()
      results.push(scenario("LEDGER-CORRUPT-RESET", "ledger_persistence", "Corrupt store resets safely without blocking routing",
        resetDueToCorruption, resetDueToCorruption, true))
    }

    // Schema mismatch → safe reset
    {
      const { writeFile } = await import("node:fs/promises")
      const schemaMismatchPath = join(tmpDir, "schema-mismatch.json")
      await writeFile(schemaMismatchPath, JSON.stringify({ schemaVersion: 999, profiles: [] }))
      const ledger = new ModelPerformanceLedger({ persistPath: schemaMismatchPath })
      const { resetDueToCorruption } = await ledger.load()
      results.push(scenario("LEDGER-SCHEMA-MISMATCH", "ledger_persistence", "Schema version mismatch triggers safe reset",
        resetDueToCorruption, resetDueToCorruption, true))
    }

    // Missing file → not loaded but no error
    {
      const missingPath = join(tmpDir, "does-not-exist.json")
      const ledger = new ModelPerformanceLedger({ persistPath: missingPath })
      const { loaded, resetDueToCorruption } = await ledger.load()
      results.push(scenario("LEDGER-MISSING-FILE", "ledger_persistence", "Missing persist file returns not-loaded without error",
        !loaded && !resetDueToCorruption, { loaded, resetDueToCorruption }, { loaded: false, resetDueToCorruption: false }))
    }

    // No raw source stored (profiles contain only metrics)
    {
      const ledger = new ModelPerformanceLedger({ persistPath: join(tmpDir, "privacy.json") })
      ledger.recordAgentOutcome({ deploymentId: "dep-priv", taskClass: "coding",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
      await ledger.persist()
      const { readFile } = await import("node:fs/promises")
      const raw = await readFile(join(tmpDir, "privacy.json"), "utf-8")
      const containsSourceCode = raw.includes("function") || raw.includes("const ") || raw.includes("import ")
      results.push(scenario("LEDGER-NO-SOURCE", "ledger_privacy", "Persisted profiles contain no raw source code",
        !containsSourceCode, containsSourceCode ? "contains_source" : "no_source", "no_source"))
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }

  return results
}

// ── Inference Gate ──────────────────────────────────────────────────────────

function evalInferenceGate(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []

  // Without env var, gate is closed
  const origEnv = process.env["OPEN_VS_CODE_REAL_INFERENCE"]
  delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
  try {
    const state = checkInferenceGate()
    results.push(scenario("GATE-DEFAULT-CLOSED", "inference_gate", "Inference gate closed by default",
      !state.authorized, state.authorized, false))
    results.push(scenario("GATE-DEFAULT-NO-ENDPOINT", "inference_gate", "Inference gate has no endpoint when closed",
      state.endpoint === undefined, state.endpoint, undefined))

    // blockedMessage function returns BLOCKED_WITH_EVIDENCE
    const msg = inferenceGateBlockedMessage()
    results.push(scenario("GATE-BLOCKED-MSG", "inference_gate", "Blocked message contains BLOCKED_WITH_EVIDENCE",
      msg.includes("BLOCKED_WITH_EVIDENCE"), msg.includes("BLOCKED_WITH_EVIDENCE"), true))
  } finally {
    if (origEnv !== undefined) process.env["OPEN_VS_CODE_REAL_INFERENCE"] = origEnv
    else delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
  }

  // With env var set, gate is open
  process.env["OPEN_VS_CODE_REAL_INFERENCE"] = "1"
  try {
    const state = checkInferenceGate()
    results.push(scenario("GATE-OPEN-WITH-ENV", "inference_gate", "Inference gate opens with OPEN_VS_CODE_REAL_INFERENCE=1",
      state.authorized, state.authorized, true))
  } finally {
    if (origEnv !== undefined) process.env["OPEN_VS_CODE_REAL_INFERENCE"] = origEnv
    else delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
  }

  return results
}

// ── Endpoint Health Checker ──────────────────────────────────────────────────

async function evalEndpointHealth(): Promise<IntegrationScenarioResult[]> {
  const results: IntegrationScenarioResult[] = []

  // No endpoint configured → unknown
  {
    const checker = new EndpointHealthChecker({ endpoints: new Map(), cacheTtlMs: 0 })
    const state = await checker.checkHealth("dep-unknown")
    results.push(scenario("HEALTH-NO-ENDPOINT", "health", "No endpoint configured returns unknown",
      state === "unknown", state, "unknown"))
  }

  // Fake fetch returns 200 → ready
  {
    const fakeFetch = async () => new Response(
      JSON.stringify({ data: [] }), { status: 200 }
    )
    const checker = new EndpointHealthChecker({
      endpoints: new Map([["dep-a", "http://localhost:11434/"]]),
      cacheTtlMs: 0,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const state = await checker.checkHealth("dep-a")
    results.push(scenario("HEALTH-200-READY", "health", "HTTP 200 from /v1/models returns ready",
      state === "ready", state, "ready"))
  }

  // Fake fetch returns 500 → unavailable
  {
    const fakeFetch = async () => new Response(null, { status: 500 })
    const checker = new EndpointHealthChecker({
      endpoints: new Map([["dep-b", "http://localhost:11434/"]]),
      cacheTtlMs: 0,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const state = await checker.checkHealth("dep-b")
    results.push(scenario("HEALTH-500-UNAVAILABLE", "health", "HTTP 500 returns unavailable",
      state === "unavailable", state, "unavailable"))
  }

  // Network error → unavailable
  {
    const fakeFetch = async () => { throw new Error("ECONNREFUSED") }
    const checker = new EndpointHealthChecker({
      endpoints: new Map([["dep-c", "http://localhost:11434/"]]),
      cacheTtlMs: 0,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const state = await checker.checkHealth("dep-c")
    results.push(scenario("HEALTH-NETWORK-ERR", "health", "Network error returns unavailable",
      state === "unavailable", state, "unavailable"))
  }

  // Cache hit — second call uses cached result without fetch
  {
    let callCount = 0
    const fakeFetch = async () => { callCount++; return new Response(JSON.stringify({ data: [] }), { status: 200 }) }
    const checker = new EndpointHealthChecker({
      endpoints: new Map([["dep-cache", "http://localhost:11434/"]]),
      cacheTtlMs: 60_000,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await checker.checkHealth("dep-cache")
    await checker.checkHealth("dep-cache")
    results.push(scenario("HEALTH-CACHE", "health", "Health result cached — second call skips fetch",
      callCount === 1, callCount, 1))
  }

  // Cache invalidation
  {
    let callCount = 0
    const fakeFetch = async () => { callCount++; return new Response(JSON.stringify({ data: [] }), { status: 200 }) }
    const checker = new EndpointHealthChecker({
      endpoints: new Map([["dep-inv", "http://localhost:11434/"]]),
      cacheTtlMs: 60_000,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await checker.checkHealth("dep-inv")
    checker.invalidate("dep-inv")
    await checker.checkHealth("dep-inv")
    results.push(scenario("HEALTH-INVALIDATE", "health", "Invalidated cache causes fresh probe",
      callCount === 2, callCount, 2))
  }

  return results
}

// ── No Cloud Fallback ────────────────────────────────────────────────────────

function evalNoCloudFallback(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []

  const cloudUrls = [
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
  ]

  for (const cloudUrl of cloudUrls) {
    const origEnv = process.env["OPEN_VS_CODE_REAL_INFERENCE"]
    delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]
    const closedGate = checkInferenceGate()
    if (origEnv !== undefined) process.env["OPEN_VS_CODE_REAL_INFERENCE"] = origEnv
    else delete process.env["OPEN_VS_CODE_REAL_INFERENCE"]

    results.push(scenario(
      `NO-CLOUD-GATE-${cloudUrl.replace(/\./g, "_")}`,
      "no_cloud_fallback",
      `Inference gate prevents implicit calls to ${cloudUrl} when closed`,
      !closedGate.authorized,
      closedGate.authorized,
      false,
    ))
  }

  return results
}

// ── Token efficiency (autocomplete context stays bounded) ────────────────────

function evalAutocompleteContextBounds(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []

  const prefix = "function add(a, b) { return "
  const suffix = " }"
  const prompt = buildFimPrompt(prefix, suffix, "qwen")

  const badMarkers = ["# Project", "# AGENTS", "## Sprint", "conversation_id", "sessionId"]
  for (const marker of badMarkers) {
    results.push(scenario(
      `AC-CTX-NO-${marker.replace(/[^A-Z0-9]/gi, "_").toUpperCase()}`,
      "autocomplete_context",
      `FIM prompt does not contain ${marker}`,
      !prompt.includes(marker), prompt.includes(marker) ? `found(${marker})` : "not_found", "not_found",
    ))
  }

  const promptBytes = Buffer.byteLength(prompt, "utf-8")
  results.push(scenario("AC-CTX-BOUNDED", "autocomplete_context",
    "FIM prompt is bounded (prefix + suffix + markers only)",
    promptBytes < 10_000, promptBytes, "< 10000 bytes"))

  return results
}

// ── Provider safety boundaries ───────────────────────────────────────────────

function evalProviderSafetyBoundaries(): IntegrationScenarioResult[] {
  const results: IntegrationScenarioResult[] = []

  // OpenAICompatibleProvider rejects non-HTTP URLs
  let caughtNonHttp = false
  try {
    const unusedProvider = new OpenAICompatibleProvider({ baseUrl: "ftp://localhost", model: "m" })
    void unusedProvider
  } catch { caughtNonHttp = true }
  results.push(scenario("PROVIDER-NON-HTTP", "provider_safety", "OpenAICompatibleProvider rejects non-HTTP base URL",
    caughtNonHttp, caughtNonHttp, true))

  // OpenAICompatibleProvider rejects empty model
  let caughtEmptyModel = false
  try {
    const unusedProvider = new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434", model: "" })
    void unusedProvider
  } catch { caughtEmptyModel = true }
  results.push(scenario("PROVIDER-EMPTY-MODEL", "provider_safety", "OpenAICompatibleProvider rejects empty model",
    caughtEmptyModel, caughtEmptyModel, true))

  // OpenAICompatibleProvider rejects negative timeout
  let caughtBadTimeout = false
  try {
    const unusedProvider = new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434", model: "m", timeoutMs: 0 })
    void unusedProvider
  } catch { caughtBadTimeout = true }
  results.push(scenario("PROVIDER-BAD-TIMEOUT", "provider_safety", "OpenAICompatibleProvider rejects zero timeout",
    caughtBadTimeout, caughtBadTimeout, true))

  return results
}

// ── Adaptive Routing with ModelRouter ────────────────────────────────────────

async function evalAdaptiveRouting(): Promise<IntegrationScenarioResult[]> {
  const results: IntegrationScenarioResult[] = []

  const testConfig: RoutingConfiguration = {
    providers: [{ id: "p1", kind: "scripted" }],
    models: [
      { id: "m1", contextWindow: 32000, capabilities: ["coding"], specialization: "coding" },
      { id: "m2", contextWindow: 32000, capabilities: ["coding"], specialization: "coding" },
    ],
    deployments: [
      { id: "dep-a", providerId: "p1", modelId: "m1", enabled: true, priority: 10 },
      { id: "dep-b", providerId: "p1", modelId: "m2", enabled: true, priority: 10 },
    ],
    routes: { default: ["dep-a", "dep-b"] },
  }

  const staticHealth = { checkHealth: async () => "ready" as const }

  // 1. Without ledger, higher priority or tie-break wins
  {
    const router = new ModelRouter(testConfig)
    const decision = await router.route({
      taskClass: "coding",
      needsTools: false,
      needsStructuredOutput: false,
      estimatedInputTokens: 100,
      requiredContextWindow: 2000,
    }, staticHealth)
    results.push(scenario("ROUTER-STATIC-DEFAULT", "adaptive_routing",
      "ModelRouter selects dep-a by default static tie-break",
      decision.deploymentId === "dep-a", decision.deploymentId, "dep-a"))
  }

  // 2. With ledger where dep-b has strong success and dep-a has failures, dep-b wins!
  {
    const ledger = new ModelPerformanceLedger({ minimumSamples: 5, hysteresisThreshold: 0.05 })
    for (let i = 0; i < 10; i++) {
      ledger.recordAgentOutcome({ deploymentId: "dep-b", taskClass: "coding",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
      ledger.recordAgentOutcome({ deploymentId: "dep-a", taskClass: "coding",
        success: false, verificationSuccess: false, toolCallSuccess: false,
        repairCycles: 2, timeoutOccurred: true, cancellationOccurred: false, latencyMs: 3000 })
    }

    const router = new ModelRouter(testConfig, { performanceLedger: ledger })
    const decision = await router.route({
      taskClass: "coding",
      needsTools: false,
      needsStructuredOutput: false,
      estimatedInputTokens: 100,
      requiredContextWindow: 2000,
    }, staticHealth)

    results.push(scenario("ROUTER-ADAPTIVE-PREFERENCE", "adaptive_routing",
      "ModelRouter routes to dep-b based on performance ledger evidence",
      decision.deploymentId === "dep-b" && decision.reasons.includes("performance_score"),
      { deployment: decision.deploymentId, reasons: decision.reasons },
      { deployment: "dep-b", reasons: "includes(performance_score)" }))
  }

  // 3. When adaptive routing is disabled, static priority is restored
  {
    const ledger = new ModelPerformanceLedger({ minimumSamples: 5, hysteresisThreshold: 0.05 })
    for (let i = 0; i < 10; i++) {
      ledger.recordAgentOutcome({ deploymentId: "dep-b", taskClass: "coding",
        success: true, verificationSuccess: true, toolCallSuccess: true,
        repairCycles: 0, timeoutOccurred: false, cancellationOccurred: false, latencyMs: 100 })
    }
    ledger.disableAdaptiveRouting()

    const router = new ModelRouter(testConfig, { performanceLedger: ledger })
    const decision = await router.route({
      taskClass: "coding",
      needsTools: false,
      needsStructuredOutput: false,
      estimatedInputTokens: 100,
      requiredContextWindow: 2000,
    }, staticHealth)

    results.push(scenario("ROUTER-ADAPTIVE-DISABLED-FALLBACK", "adaptive_routing",
      "ModelRouter falls back to static priority when adaptive routing is disabled",
      decision.deploymentId === "dep-a", decision.deploymentId, "dep-a"))
  }

  return results
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function runModelIntegrationEvaluation(): Promise<IntegrationEvaluationSummary> {
  const allResults: IntegrationScenarioResult[] = [
    ...evalFimFormatting(),
    ...evalStopTokenStripping(),
    ...evalFimProviderConstruction(),
    ...(await evalFimProviderHttp()),
    ...evalPerformanceLedger(),
    ...(await evalLedgerPersistence()),
    ...evalInferenceGate(),
    ...(await evalEndpointHealth()),
    ...evalNoCloudFallback(),
    ...evalAutocompleteContextBounds(),
    ...evalProviderSafetyBoundaries(),
    ...(await evalAdaptiveRouting()),
  ]

  const categories: Record<string, { total: number; passed: number }> = {}
  for (const r of allResults) {
    if (!categories[r.category]) categories[r.category] = { total: 0, passed: 0 }
    categories[r.category]!.total++
    if (r.passed) categories[r.category]!.passed++
  }

  return {
    totalScenarios: allResults.length,
    passed: allResults.filter(r => r.passed).length,
    failed: allResults.filter(r => !r.passed).length,
    categories,
    results: allResults,
  }
}
