# Scratchpad

- Current state: Sprint 4E.4 is COMPLETE (Implementation Sealed; Real-Host Benchmark Attempted & Evidence Blocked).
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
  - Real-host benchmark executed with `OPEN_VS_CODE_REAL_INFERENCE=1`: captured host hardware (Apple M3 Pro, 18GB RAM, darwin arm64, Ollama client v0.32.15); verified safe blocked execution (`could not connect to running Ollama instance / 0 models installed`).

Next:
Sprint 4E is sealed. Proceed to Sprint 4F (Code-OSS / VSCodium Desktop Packaging) when ready.
