# Scratchpad

- Current state: Sprint 4E.2 is COMPLETE (Implementation Sealed; Real-Host Evidence Blocked).
- Accomplishments:
  - Canonical OpenAI-compatible endpoint contract implemented (`packages/agent-core/src/model/canonical-endpoint.ts`).
  - Authoritative endpoint ownership: `deployment.endpoint` takes precedence over `provider.baseUrl`, failing clearly on missing/malformed/cloud endpoints.
  - Logical model ID separated from wire identifier via `modelName` and `servedModelId`.
  - Bug A fixed: `provider.baseUrl` and `provider.apiKey` strictly preserved through `validateRoutingConfig` and loader pipeline.
  - Reconciled model capability vocabulary: single authoritative vocabulary matching `RoutingModelCapability` (`toolUse`, `coding`, `fim`, `autocomplete`).
  - Created real JSON schema at `config/schemas/models.schema.json` and canonical example at `config/examples/models.local.example.json` with zero-drift regression test.
  - Explicit FIM strategy invariant: deployments/models eligible for FIM must declare explicit strategy (`qwen`, `starcoder`, etc.); no silent default.
  - Production agent runtime benchmark path refactored: exercises temporary workspace `.open-vs-code/models.json` -> `loadRoutingConfig` -> `createAgentRuntime` -> `RoutedModelGateway` -> `ModelRouter` -> local provider -> tools -> result.
  - Added 4 genuine repository inspection tasks (`T001`-`T004`) requiring tools; hallucinated answers without tool calls fail fixture.
  - Production autocomplete benchmark path refactored: exercises `.open-vs-code/models.json` -> `createProductionAutocompleteGateway`.
  - Truthful FIM validation: `validateSyntax` parses JSON / checks delimiters, distinguishing `nonEmpty` from `syntaxValid`.
  - Operator authorization boundary preserved: `OPEN_VS_CODE_REAL_INFERENCE=1` required for real HTTP calls in production.
  - Deterministic evaluation suites: 64 integration scenarios pass twice with 100% determinism; 32 closure scenarios in `sprint-4e-closure-eval.test.ts` pass with zero failures.

Next:
Execute real-model benchmark on designated inference host with operator authorization, then proceed to Sprint 4F (Code-OSS / VSCodium Desktop Packaging).
