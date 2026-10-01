# ADR-027: Real Local Open-Weight Models, Production FIM, and Adaptive Routing

**Status:** Accepted  
**Sprint:** 4E — Real OSS Models + FIM Provider & Benchmarking  
**Date:** 2026-09-28

---

## Context

Sprints 2D, 3E, 4A–4D established provider/router contracts, editor-native autocomplete,
security hardening, runtime evals, checkpoints, and bounded performance monitoring using
scripted/deterministic providers. Sprint 4E connects the existing architecture to **real
self-hosted open-weight local model inference** and introduces:

- A designated inference-host authorization gate.
- Production FIM/autocomplete adapter with provider-isolated FIM token formatting.
- A bounded `ModelPerformanceLedger` fed by runtime eval outcomes.
- Evidence-driven adaptive routing with hysteresis and static fallback.
- A real model benchmark harness (separate from deterministic CI).

---

## Decisions

### 1. Designated Inference-Host Gate

Real inference is allowed **only** when `OPEN_VS_CODE_REAL_INFERENCE=1` is set in the
process environment. This is an explicit operator action — the application does NOT infer
authorization from the mere presence of Ollama, vLLM, or GPU hardware.

**Default: real inference = DISABLED.**

Without the gate:
- No model weights are pulled or downloaded.
- No real inference runs.
- No benchmark results are fabricated.
- The system reports `BLOCKED_WITH_EVIDENCE`.

The gate is implemented in `src/model/inference-gate.ts` and checked by the benchmark
harness CLI and any real-inference code path before invocation.

### 2. No Application-Managed Model Downloads

The application does **not** download, pull, or auto-install model weights. Model
installation remains an explicit operator action (e.g., `ollama pull` run manually by the
operator, never by the application). The `.gitignore` is updated to protect against
accidental weight commits:

```
*.gguf
*.safetensors
*.ggml
*.bin (model checkpoints)
*.pt / *.pth
.ollama/
.huggingface/
```

### 3. Local/Self-Hosted Provider Architecture

The production provider path reuses the existing `OpenAICompatibleProvider` for agent/chat
tasks and a new `LocalFimProvider` for FIM/autocomplete. Both speak to a
**self-hosted OpenAI-compatible local endpoint** (Ollama, vLLM, llama.cpp server).

Architecture after Sprint 4E:

```
AgentRunner
  → RoutedModelGateway
  → ModelRouter            (security/capability/context filter first)
  → OpenAICompatibleProvider  (local endpoint: http://<host>:<port>)
  → self-hosted model

AutocompleteGateway
  → ModelRouter            (fim/autocomplete capability filter)
  → LocalFimProvider       (local endpoint: http://<host>:<port>/v1/completions)
  → self-hosted FIM model

Runtime Evals
  → ModelPerformanceLedger (bounded aggregate evidence)
  → future routing adjustment (evidence-driven, bounded, hysteresis-protected)
```

Runtime eval does NOT grant new authority. It only influences routing preference
among already security/capability-eligible candidates.

### 4. Model Capability Metadata

Real model deployments declare capabilities explicitly in `models.json`. The router
does NOT infer capability from model name patterns. Example:

```json
{
  "models": [{
    "id": "qwen2.5-coder-7b",
    "contextWindow": 32768,
    "capabilities": ["toolUse", "coding", "fim", "autocomplete"],
    "specialization": "coding",
    "family": "qwen",
    "provenance": "Qwen2.5-Coder-7B-Instruct (Apache 2.0)"
  }]
}
```

### 5. Production FIM Adapter (`LocalFimProvider`)

The `LocalFimProvider` (`src/autocomplete/local-fim-provider.ts`):
- Uses `POST /v1/completions` (not `/v1/chat/completions`) for FIM.
- Owns **all** provider-specific FIM token formatting (`fimStrategy` config).
- FIM tokens (`<|fim_prefix|>`, `<fim_prefix>`, `<PRE>`, etc.) appear **ONLY** in
  this adapter — never in `AutocompleteService`, `AutocompleteGateway`, or `ModelRouter`.
- Supported strategies: `qwen`, `starcoder`, `deepseek`, `prefix-suffix-middle`, `raw-prefix`.
- Strips provider-specific stop tokens from completions.
- Respects `AbortSignal` — throws `LocalFimProviderError` with code `CANCELLED`.
- Enforces `maxOutputTokens` — no unbounded output.

### 6. Real Benchmark Methodology

The `runRealModelBenchmark()` function (`tests/evals/real-model-benchmark.ts`):
- Is **only invoked** via `npm run eval:models` — never during `npm test`.
- Requires explicit inference gate authorization.
- Separates warmup from measured runs.
- Records: `hardware`, `OS`, `nodeVersion`, `providerRuntime`, `modelIds`,
  `gitSha`, `timestamp`.
- Records: `agentTasks`, `fimTasks`, per-task latency, token counts (when reported).
- Does NOT commit: weights, raw prompts containing source code, secrets.
- Disables adaptive routing during benchmark runs (prevents contamination of
  later benchmark tasks by earlier results).
- Produces a lightweight JSON artifact with schema version.

### 7. Deterministic Integration Eval vs. Real Benchmark

Two separate harnesses exist:

| Harness | Command | Models required | Purpose |
|---------|---------|-----------------|---------|
| `runModelIntegrationEvaluation()` | `npm test` | None — scripted fetch | Protocol contracts, FIM formatting, ledger logic, gate, health |
| `runRealModelBenchmark()` | `npm run eval:models` | Real local model | Real quality and latency measurement |

These are **never merged**. Scripted provider results are never presented as real
model performance.

### 8. ModelPerformanceLedger

The `ModelPerformanceLedger` (`src/model/performance-ledger.ts`):
- Stores **aggregate** outcome evidence keyed by `(deploymentId, taskClass)`.
- Uses exponential moving average (EMA, α=0.2) for latency — no per-task list.
- Bounded by `maxProfiles` (default: 50).
- Persisted as JSON with schema version — corrupt/schema-mismatched store resets safely.
- **Privacy**: never persists source code, prompt bodies, terminal contents, or secrets.
- **Resettable**: `ledger.reset()` clears aggregates without affecting configuration.

### 9. Runtime-Eval Feedback Loop

```
Agent task completes
  → RuntimeEvalLedger records outcome (existing Sprint 4B infrastructure)
  → ModelPerformanceLedger.recordAgentOutcome() called with:
     deploymentId, taskClass, success, verificationSuccess,
     toolCallSuccess, repairCycles, timeoutOccurred, latencyMs
  → Aggregate profile updated (EMA, counts)

Autocomplete accepted/rejected
  → ModelPerformanceLedger.recordAutocompleteOutcome() called with:
     deploymentId, shown, accepted, staleDiscarded, emptyCompletion,
     cancelled, latencyMs
     (completion text is NEVER stored)
```

### 10. Bounded Adaptive Routing

`ModelPerformanceLedger.getRoutingAdjustments()`:
- Returns `[]` if `adaptiveRoutingDisabled` is true.
- Returns `[]` if samples < `minimumSamples` (default: 5).
- Score formula: `successRate - repairPenalty - timeoutPenalty`, normalized to `[-1, +1]`.
- Adjustment clamped to `[-maxAdjustment, +maxAdjustment]` (default: 0.5).
- **Hysteresis**: adjustment is omitted if `|adjustment| < hysteresisThreshold` (default: 0.1).
- Security and capability filters happen **before** any performance adjustment.
- Static routing is always the fallback when insufficient evidence exists.

### 11. Minimum Samples Threshold

Routing evidence does not influence selection until `minimumSamples` (default: 5)
outcomes are recorded for the `(deploymentId, taskClass)` pair. This prevents
unstable routing after a single success or failure.

### 12. Hysteresis / Anti-Flapping

Small-magnitude adjustments below `hysteresisThreshold` are ignored. This prevents
the router from switching between close candidates on marginal evidence.

### 13. Static Routing Remains the Safe Default

When:
- Adaptive routing is disabled (`adaptiveRoutingDisabled: true`)
- Fewer than `minimumSamples` outcomes exist
- The ledger is corrupt and has been reset

The router falls back to the configured static priority from `models.json`. The product
is always usable even with a fresh or corrupt ledger.

### 14. Privacy Invariants

The `ModelPerformanceLedger` must NEVER persist:
- Source code or file contents.
- Prompt or completion text.
- Terminal command output.
- Secrets, tokens, or credentials.
- Raw diffs.

Only metrics (counts, rates, EMA latencies) are stored.

### 15. No Self-Modifying Weights or Policy

Runtime evidence may only modify **bounded routing preferences**. It must NOT:
- Retrain or fine-tune model weights.
- Modify security policy or permissions.
- Rewrite source code (including AGENTS.md, PLAN.md).
- Download new model weights.
- Expand agent authority.

### 16. Profile Reset Operator Action

`ledger.reset()` provides a bounded, auditable operator action to clear learned routing
statistics. It affects only performance aggregates — no model files, no configuration,
no project memory is affected.

### 17. Benchmark Reproducibility

Each benchmark artifact identifies:
- `schemaVersion`: numeric schema version for artifact format.
- `gitSha`: exact Git SHA of the codebase under test.
- `timestamp`: ISO 8601 run timestamp.
- `hardware`: CPU model, cores, RAM, OS.
- `nodeVersion`: Node.js version.
- `providerRuntime`: Ollama version or equivalent.
- `agentModelId`, `fimModelId`: exact model identifiers.

Real model text output is not deterministic. Results report **success rates, median
latency, p95 latency, and token counts** rather than requiring exact string equality.

### 18. Adaptive Routing Disable Switch

`adaptiveRoutingDisabled` can be set to `true` to revert routing to pure static
priority. Useful for:
- Pinned benchmark runs (prevents earlier benchmark tasks from contaminating later ones).
- Debugging routing decisions.
- Safe rollback when adaptive routing behaves unexpectedly.

### 19. Configuration Truth & Endpoint Ownership (Sprint 4E.2 Refinement)

Sprint 4E.2 establishes strict configuration invariants:
- **Canonical Endpoint Precedence**: `deployment.endpoint` (explicit override or env var) takes precedence over `provider.baseUrl`. Deployments failing to resolve an endpoint fail validation fail-closed (`CONFIG_VALIDATION_ERROR`).
- **Wire Model Identifier Separation**: Stable logical `id` is decoupled from physical wire identifier (`modelName` / `servedModelId`). Resolution order: `deployment.modelName` > `deployment.servedModelId` > `model.modelName` > `model.servedModelId` > `deployment.modelId`.
- **Provider BaseUrl Preservation**: Config loading (`validateRoutingConfig`) strictly preserves `provider.baseUrl` without dropping it during provider reconstruction.
- **Explicit FIM Invariant**: Any deployment or model declaring `fim` or `autocomplete` capability must specify an explicit valid `fimStrategy`. Silently defaulting to generic fallback is forbidden.

---

## Alternatives Considered

- **Per-task raw history**: Rejected — unbounded storage, privacy risk.
- **Model retraining from outcomes**: Out of scope — no weight modification.
- **Separate FIM router**: Rejected — existing `ModelRouter` + capability filter is sufficient.
- **Cloud fallback**: Rejected — violates local-first product principle.
- **Automatic model download**: Rejected — operator-only action.
- **Inferring FIM capability from model name**: Rejected — capability must be explicit in config.

---

## Consequences

- Real inference flows through the existing `ModelRouter` → `OpenAICompatibleProvider`
  or `LocalFimProvider` path with no new routing layer.
- FIM token formatting is provably isolated to `LocalFimProvider`.
- Normal `npm test` remains model-independent (no Ollama, no GPU required).
- Sprint 4F (desktop packaging) can now integrate real model configuration into
  the Code-OSS/VSCodium shell.
