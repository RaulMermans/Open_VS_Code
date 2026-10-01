# Scratchpad

- Current state: Sprint 4E.1 is COMPLETE (Implementation Sealed; Real-Host Evidence Blocked).
- Accomplishments:
  - Canonical OpenAI-compatible endpoint contract implemented (`packages/agent-core/src/model/canonical-endpoint.ts`).
  - Deterministic URL normalization (/v1, host root, trailing slashes, zero /v1/v1 duplication, queries/fragments rejected).
  - Explicit local/open-weight provider invariant: known proprietary cloud endpoints (OpenAI, Anthropic, Google, DeepSeek, etc.) strictly rejected with `EndpointPolicyError`.
  - Operator authorization boundary enforced: `OPEN_VS_CODE_REAL_INFERENCE=1` required for real HTTP calls in production, while preserving unit test seams via mock fetch.
  - Explicit FIM strategy configuration (`qwen`, `starcoder`, `deepseek`, `prefix-suffix-middle`, `raw-prefix`) validated with `ConfigValidationError`.
  - Production autocomplete gateway dynamically creates real `LocalFimProvider` instances for eligible local deployments; zero scripted providers in production.
  - Production agent runtime wires real `EndpointHealthChecker` probing `/v1/models` and workspace-scoped `ModelPerformanceLedger` (`.open-vs-code/model-performance-ledger.json`).
  - `ModelPerformanceLedger` records aggregate outcomes without source code, prompts, completions, diffs, or secrets; handles corruption recovery safely.
  - Real model benchmark harness refactored to exercise genuine Open VS Code production pipeline (`AgentRunner` -> `RoutedModelGateway` -> `ModelRouter` -> local provider -> bounded tools -> evidence).
  - Sprint 4E.1 closure and security evaluation suite: 19 scenarios pass 100% deterministically.
  - Deterministic model integration suite: 64 scenarios pass 100% deterministically twice.

Next:
Execute real-model benchmark on designated inference host with operator authorization, then proceed to Sprint 4F (Code-OSS / VSCodium Desktop Packaging).
