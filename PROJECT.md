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

Sprint 4B ✅ CLOSED (Runtime Evals & Adaptive Control)

- Phase A (Sprint 2): Core capabilities, Project Memory, Skills, MCP, Provider Routing.
- Phase B (Sprint 3A-3B): IDE Adapter and Chat UX.
- Phase C (Sprint 3C): Diff Review Safety & Closure.
- Phase D (Sprint 3D): Controlled Terminal UX & Review Boundary. 100% deterministic test evaluations passed.
- Phase D.1 (Sprint 3D.1): Terminal Runtime Truth. Live output streaming, UTF-8 safety, bounded prefix buffer, PREPARED state removal, fail-closed validation, bounded registry, deterministic process group cleanup proofs. 59 terminal scenarios, 318 total tests pass. ✅ CLOSED.
- Phase D.2 (Sprint 3D.2): Execution Identity & Deactivation Closure. Canonical execution identity preserved end-to-end (verificationId = executionId), exact ID routing without fallback, real deactivation process tree termination without prior manual cancel, post-deactivation registry flush. 79 terminal scenarios, 318 total tests pass. ✅ CLOSED PERMANENTLY.
- Phase D.3 (Sprint 3D.3): Exact Lifecycle Event Routing & Review Isolation. Canonical verificationId emitted across all verification lifecycle events (started, output, completed, failed, rejected), ChatController fail-closed validation requiring non-empty verificationId, zero fallback ID generation in registerPreparedCommand, exact-ID routing via registry lookup with zero activeTerminal routing authority, complete multi-review isolation. 97 terminal scenarios pass deterministically on Run 1 and Run 2. Full workspace clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals twice. Sprint 3D ✅ CLOSED PERMANENTLY.
- Phase E (Sprint 3E & 3E.1): Editor-Native Autocomplete & Production Wiring. Isolated non-AgentRunner execution path, editor-local bounded context, ModelRouter capability filtering (FIM / autocomplete), native InlineCompletionItem registration on onStartupFinished, safe zero-deployment default, real live editor stale guards (URI, version, line, character, supersession), deterministic in-flight request deduplication, single-use acceptance telemetry, strict UTF-16 surrogate safety, full deactivation cleanup. 90 deterministic evaluation scenarios pass Run 1 and Run 2 with deep strict equality. Full workspace clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals twice. ✅ PERMANENTLY CLOSED.
- Phase F (Sprint 4A): System-Wide Security Hardening. Threat model & authority map documented (docs/SECURITY_MODEL.md, ADR-023), architectural security boundaries (ARCHITECTURE.md), realpath-based containment across reads/writes/creates, MutationEngine apply-time TOCTOU path/symlink re-verification, chat protocol prototype pollution guard, expanded sensitive file patterns (SSH private keys, credentials), bounded MCP schema size (64 KB) and depth (16 levels), subprocess isolation (shell:false, minimal env), future runtime evals non-authority rule established. ✅ CLOSED PERMANENTLY.
- Phase F.1 (Sprint 4A.1): Security Evaluation Truth & Permanent Closure. Zero boolean proxy passes, strict runtime evidence contract (SecurityScenarioResult { id, category, description, actual, expected }), live boundary evaluations, non-destructive path-only normalization, strict negative comparator failure tests. 91 security evaluation scenarios pass deterministically across two runs. ✅ CLOSED PERMANENTLY.
- Phase F.2 (Sprint 4A.2): Final Security Evidence Closure. Closed the 5 evidence gaps: Webview DOM rendering textContent safety, canonical deactivate() lifecycle process cleanup, TestMcpTransport prompt injection non-authority, Autocomplete structural isolation, and expanded negative comparators. 97 scenarios pass deterministically across two runs. ✅ CLOSED PERMANENTLY.
- Phase F.3 (Sprint 4A.3): Closure Integrity Patch. Node >=22.0.0 verified, shared webview-render-helpers.ts, canonical extension.deactivate() process termination, real Autocomplete structural prototype audit. 97 scenarios pass deterministically. ✅ CLOSED PERMANENTLY.
- Phase G (Sprint 4B): Runtime Evals & Adaptive Control. Tiered runtime evaluation engine (L0 deterministic, L1 heuristic with action cycle penalty, L2 selective critic with timeout race fallback), strict non-authoritative invariant (evaluations advise/recommend, never execute mutations or bypass security), bounded evidence collector with secret redaction, adaptive control policy (CONTINUE, SCHEDULE_VERIFICATION, INJECT_REVISION, TRIGGER_REPLAN, TERMINATE_RUN, PAUSE_HUMAN, RECOMMEND_MODEL, NO_OP), runtime eval ledger and analytics audit trail, AgentRunner integration with configurable adaptiveInterventions. 72 runtime evaluation scenarios pass deterministically across two runs with negative comparators. Full monorepo regressions clean: 336 unit tests pass, 30/30 coding benchmark cases pass (100% task success rate, 100% safety, 100% multi-file). ✅ CLOSED.
- Phase G.1 (Sprint 4B.1): Adaptive Loop Integrity & Real Runtime-Eval Closure. Live closed-loop execution: stale evaluation version guards with non-caching, post-verification evaluation completion authority, fail-closed VERIFICATION_UNAVAILABLE on required test mutations, MUTATION_RESULT and TOOL_FAILURE active dispatch, REQUEST_MORE_CONTEXT bounded repository resolution, CHANGE_MODEL modelRecommendation metadata forwarding, strict hard L0 dominance over L2 critic suggestions, RUNTIME_EVAL vs NON_PROGRESS_GUARD separation, PAUSE_HUMAN WAITING_FOR_CONFIRMATION state transition integrity. 82 scenarios pass deterministically across two runs with zero boolean proxies. Full workspace clean: 336 unit tests pass, 30/30 coding evals (100%). ✅ CLOSED.
- Phase G.2 (Sprint 4B.2): Adaptive Decision Completion & Permanent Runtime-Eval Closure. Universal post-verification causality across MUTATION_RESULT, BEFORE_COMPLETION, and generic directives; narrow 1-turn ModelRouteHint consumed by ModelRouter and RoutedModelGateway without provider recreation; bounded REQUEST_MORE_CONTEXT (max 2 turns) with explicit re-evaluation; intervention outcome linking (RESOLVED, UNCHANGED, DEGRADED) in RuntimeEvalLedger. 107 runtime evaluation scenarios pass deterministically across two runs with negative comparators. Full monorepo regressions clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals (100%). ✅ CLOSED.
- Phase G.3 (Sprint 4B.3): Integrated Route Proof & Documentation Integrity. Real end-to-end CHANGE_MODEL proof connecting AgentRunner -> RoutedModelGateway -> ModelRouter -> Provider A -> RuntimeEvalEngine (L2 critic CHANGE_MODEL) -> AdaptiveControlPolicy (RECOMMEND_MODEL) -> ModelRouteHint -> AgentRunner Turn 2 -> RoutedModelGateway -> ModelRouter -> Provider B -> response -> route provenance -> RuntimeEvalLedger (outcome RESOLVED). All mock fake providers replaced with real RoutedModelGateway and ModelRouter in evaluation scenarios; 1-turn bounded route hint lifecycle proven across 3 turns; no persistent routing mutations; zero cloud fallback; no-alternate deployment retention; stale evaluation guard; cancellation before route B; routing mismatch negative comparator. Documentation integrity restored: critic path corrected to `runtime-critic.ts`, verified 13 harness test categories (12 evaluation categories + negative test suite), 111 deterministic scenarios pass across two runs with deep strict equality. Full monorepo regressions clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals (100%). Sprint 4B ✅ CLOSED PERMANENTLY.
- Next: Sprint 4C — Checkpoints / Recovery → NEXT
