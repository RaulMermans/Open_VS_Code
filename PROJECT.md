# Project

## North star

> A private, local-first AI coding environment combining Cursor-like editor UX with Claude-Code-like agent workflows, optimized for open-weight models running on the user's own hardware.

## Product frame

- Initial user: single local user.
- Archetype: experimental -> MVP -> personal production tool.
- Strategy: reuse proven open-source infrastructure before building replacements.

## Primary constraints

- Local-first and private by default.
- Minimal or no recurring inference cost.
- No mandatory cloud backend.
- Strong UX with token-efficient local inference.
- Editor-independent agent core and provider-neutral model access.
- Maintainable upstream and licensing strategy.

## Early non-goals

- Training models.
- Building an editor engine or inference runtime.
- Multi-agent orchestration.
- Cloud accounts, billing, or enterprise collaboration.
- Custom vector-database infrastructure.
- Rebuilding standard IDE infrastructure.

## Current sprint

Sprint 4A, 4A.1, 4A.2 & 4A.3 ✅ CLOSED PERMANENTLY (System-Wide Security Hardening, Evaluation Truth, Evidence Closure & Integrity Patch)

- Phase A (Sprint 2): Core capabilities, Project Memory, Skills, MCP, Provider Routing.
- Phase B (Sprint 3A-3B): IDE Adapter and Chat UX.
- Phase C (Sprint 3C): Diff Review Safety & Closure.
- Phase D (Sprint 3D): Controlled Terminal UX & Review Boundary. 100% deterministic test evaluations passed.
- Phase D.1 (Sprint 3D.1): Terminal Runtime Truth. Live output streaming, UTF-8 safety, bounded prefix buffer, PREPARED state removal, fail-closed validation, bounded registry, deterministic process group cleanup proofs. 59 terminal scenarios, 318 total tests pass. ✅ CLOSED.
- Phase D.2 (Sprint 3D.2): Execution Identity & Deactivation Closure. Canonical execution identity preserved end-to-end (verificationId = executionId), exact ID routing without fallback, real deactivation process tree termination without prior manual cancel, post-deactivation registry flush. 79 terminal scenarios, 318 total tests pass. ✅ CLOSED PERMANENTLY.
- Phase D.3 (Sprint 3D.3): Exact Lifecycle Event Routing & Review Isolation. Canonical verificationId emitted across all verification lifecycle events (started, output, completed, failed, rejected), ChatController fail-closed validation requiring non-empty verificationId, zero fallback ID generation in registerPreparedCommand, exact-ID routing via registry lookup with zero activeTerminal routing authority, complete multi-review isolation. 97 terminal scenarios pass deterministically on Run 1 and Run 2. Full workspace clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals twice. Sprint 3D ✅ CLOSED PERMANENTLY.
- Phase E (Sprint 3E & 3E.1): Editor-Native Autocomplete & Production Wiring. Isolated non-AgentRunner execution path, editor-local bounded context, ModelRouter capability filtering (FIM / autocomplete), native InlineCompletionItem registration on onStartupFinished, safe zero-deployment default, real live editor stale guards (URI, version, line, character, supersession), deterministic in-flight request deduplication, single-use acceptance telemetry, strict UTF-16 surrogate safety, full deactivation cleanup. 90 deterministic evaluation scenarios pass Run 1 and Run 2 with deep strict equality. Full workspace clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals twice. ✅ PERMANENTLY CLOSED.
- Phase F (Sprint 4A): System-Wide Security Hardening. Threat model & authority map documented (docs/SECURITY_MODEL.md, ADR-023), architectural security boundaries (ARCHITECTURE.md), realpath-based containment across reads/writes/creates, MutationEngine apply-time TOCTOU path/symlink re-verification, chat protocol prototype pollution guard, expanded sensitive file patterns (SSH private keys, credentials), bounded MCP schema size (64 KB) and depth (16 levels), subprocess isolation (shell:false, minimal env), future runtime evals non-authority rule established. ✅ CLOSED PERMANENTLY.
- Phase F.1 (Sprint 4A.1): Security Evaluation Truth & Permanent Closure. Zero boolean proxy passes, strict runtime evidence contract (SecurityScenarioResult { id, category, description, actual, expected }), live boundary evaluations (McpCatalog.discover schema bounds & transport injection, VerificationEngine subprocess environment isolation, cancellation cleanup, AutocompleteController script/payload safety, SessionSummaryStorage corrupt JSONL fail-closed detection), non-destructive path-only normalization, strict negative comparator failure tests. 91 security evaluation scenarios pass deterministically across two runs. Full monorepo regressions clean: 18 test suites, 0 failures, 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals twice. ✅ CLOSED PERMANENTLY.
- Phase F.2 (Sprint 4A.2): Final Security Evidence Closure. Closed the 5 evidence gaps: (1) Webview DOM rendering execution safety proving textContent rendering with 0 script/event/navigation executions; (2) Canonical extension deactivate() lifecycle verification terminating running VerificationEngine process tree (tree-runner.cjs with child) and flushing review registries with 0 orphans; (3) Real TestMcpTransport and executeMcpCall path proving prompt injection and built-in tool impersonation are treated as inert data with zero permission mutation or tool escalation; (4) Autocomplete structural isolation (0 runner/mutation/verification authorities) and user acceptance single-use telemetry safety; (5) Expanded negative comparator suite testing 10 failure dimensions. 97 comprehensive security scenarios pass deterministically across two runs. Full monorepo regressions clean: 357 tests pass, 0 failures, 0 TypeScript errors, 0 linter errors, clean build, clean git fsck, zero weight downloads. ✅ CLOSED PERMANENTLY.
- Phase F.3 (Sprint 4A.3): Closure Integrity Patch. Permanently closed 5 integrity issues: (1) Node >=22.0.0 preflight & verification verified under Node v22.23.2; (2) Shared production webview rendering helpers (packages/vscode-integration/src/webview-render-helpers.ts) shared across production ChatViewProvider and test scenarios; (3) Canonical extension.deactivate() sole trigger for lifecycle.4 aborting running verification process tree and clearing registries, plus lifecycle.6 post-deactivation anti-resurrection proof; (4) Real Autocomplete structural authority audit (0 privileged references) and real filesystem change/sentinel/telemetry observations; (5) 12 negative comparator dimensions verified. 97 scenarios pass deterministically across two runs. Full monorepo regressions clean: 357 tests pass, 0 failures, 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals twice. ✅ PERMANENTLY CLOSED.
- Next: Sprint 4B — Runtime Evals & Adaptive Control → NEXT
