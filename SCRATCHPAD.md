# Scratchpad

- Current state: SPRINT 4F COMPLETE — OPEN VS CODE V1 DESKTOP CANDIDATE (Remaining Gate: HALO Target-Host Release Acceptance Only)
- Accomplishments (Sprint 4F Closure):
  - Proved real desktop GUI lifecycle: Category C acceptance test 1 launches packaged `Open VS Code.app`, reaches healthy running state in isolated test profile, and cleanly exits via SIGTERM (`npm run desktop:accept`).
  - Proved real VSCodium extension host discovery and activation: Category C acceptance test 2 executes test runner inside the real extension host process, proving bundled `open-vs-code.vscode-integration` is discovered, activates (`ext.activate()`), and registers all 10 `open-vs-code.*` commands.
  - Proved distributable archive integrity and strict codesigning: Category C acceptance test 3 extracts `Open-VS-Code-darwin-arm64-0.1.0.tar.gz` and verifies `codesign --verify --deep --strict`.
  - Proved packaged integration across extension boundaries: Category D smoke tests 12 & 13 prove inline autocomplete (`AutocompleteController` -> `AutocompleteService` -> Production Gateway -> `ModelRouter` -> `LocalFimProvider` -> `/v1/completions`) and chat turns (`ChatController` -> `AgentSessionBridge` -> `AgentRuntime` -> `/v1/chat/completions`) against mock fixture with zero cloud fallback.
  - Reconciled HALO architecture & target hardware: Reconciled ADR-020 HALO Core capability path (`/inference/capability/chat`) and ADR-027 direct OpenAI-compatible FIM path (`/v1/completions`) in `docs/deployment/HALO_ACCEPTANCE.md`. Corrected target platform to AMD Halo host with runtime/model placeholders. Zero model weights installed on development Mac.
  - Strict codesigning truth: `package.ts` executes `codesign --verify --deep --strict` on staged app bundle; throws on failure; truthfully reports "Ad-hoc signed and verified (Local V1 Candidate)". Does not claim Apple Developer ID notarization.
  - Pinned, repeatable packaging process: Clarified Option A terminology in ADR-028 and project documentation.
  - All 13 desktop smoke tests and 3 real runtime acceptance tests pass 100% green.

Next:
Execute HALO target inference host acceptance runbook (`OPEN_VS_CODE_REAL_INFERENCE=1 npm run eval:models`) on the designated AMD Halo host once provisioned.
