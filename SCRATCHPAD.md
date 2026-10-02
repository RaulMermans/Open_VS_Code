# Scratchpad

- Current state: Sprint 4E.4 IMPLEMENTATION COMPLETE — REAL HOST EVIDENCE BLOCKED
- Accomplishments (Sprint 4E.4):
  - Corrected agent success semantics: `AgentRunner.#result()` now separates `runtimeCompleted` from `qualitySuccess = runtimeCompleted && verificationSuccess && toolCallSuccess`, recording truthful quality evidence.
  - Adaptive routing formula updated in `ModelPerformanceLedger.getRoutingAdjustments()`: uses explicit deterministic formula `qualityScore = 0.50 * successRate + 0.30 * verificationRate + 0.20 * toolRate - repairPenalty - timeoutPenalty` bounded to `[-maxAdjustment, +maxAdjustment]` with hysteresis and sample floor.
  - Handled persisted evidence safely: bumped `LEDGER_SCHEMA_VERSION = 2`; legacy v1 profiles are safely rejected/reset to avoid mixing incompatible success metrics without losing workspace configuration.
  - Fixed concurrent ledger writes: implemented per-path async serialization queue (`persistQueuesByPath`) and delta merging (`#deltas`), guaranteeing concurrent `persist()` calls and multi-instance same-profile updates never lose evidence.
  - Eliminated duplicate startup loading: unified contract around `ready` promise and single initial `#loadPromise`, guaranteeing exactly one initial load and ensuring late loaders cannot overwrite freshly recorded in-memory evidence.
  - Removed plaintext API-key configuration: removed literal `apiKey` from `ProviderDescriptor`, `models.schema.json`, and loader; enforced env-only `apiKeyEnv` which propagates to both inference headers and health check probes without leaking secrets.
  - Durable autocomplete shutdown persistence: converted `dispose()` across `AutocompleteService` and `AutocompleteController` plus VS Code `extension.deactivate()` to return `Promise<void>`, ensuring pending shown suggestions and debounce writes are fully flushed and awaited on shutdown.
  - Truthful autocomplete failure accounting: provider failures during execution record explicit failure evidence for the selected deployment.
  - Evaluation & Test Gates: 69/69 tests in `sprint-4e-closure-eval.test.ts` pass cleanly (19 new Sprint 4E.4 tests); all monorepo test suites (`typecheck`, `lint`, `build`, `test`, `eval:coding`, `eval:runtime`, `eval:recovery`, `eval:performance`, `git diff --check`) pass with 100% determinism.
  - Benchmark Preflight Acceptance: Verified preflight gate blocks execution safely with BLOCKED_WITH_EVIDENCE when models are not installed (0 served models / Ollama server unavailable), preventing fake passes and unexecuted 18-task sweeps.

Next:
Sprint 4E.4 deterministic implementation complete and verified. Awaiting operator-managed real model run with installed model weights. Do NOT create Sprint 4E.5.
