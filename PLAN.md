Sprint 2A — Project Memory & Session Continuity
STATUS: COMPLETE

Sprint 2B — Skills & Prompt Primitives
STATUS: COMPLETE (Sprint 2B.2 Final Closure Patch Verified)

Sprint 2C — MCP Runtime Integration
STATUS: COMPLETE

Sprint 2D — Model / Provider Routing Architecture
STATUS: COMPLETE

Sprint 3A — IDE Adapter / Code-OSS Integration
STATUS: COMPLETE

Sprint 3B — Chat UX
STATUS: COMPLETE

Sprint 3C — Diff / Edit UX ✅ CLOSED
STATUS: COMPLETE

Sprint 3D — Controlled Terminal UX ✅ CLOSED PERMANENTLY
STATUS: COMPLETE
  Sprint 3D.1 — Terminal Runtime Truth ✅ CLOSED
    - verification.output live streaming: VerificationEngine → AgentRunner → ChatController → Webview
    - UTF-8 chunk boundary safety: StringDecoder in VerificationEngine and TerminalReviewController
    - Bounded prefix buffer (first 16 KB, not ring): truncateUtf8Buffer, stdoutTruncated/stderrTruncated flags
    - PREPARED state removed (dead state); 7 active states remain
    - Fail-closed validation: malformed prepared commands → immediate REJECT, no fallbacks
    - Bounded registry: maxReviews=50, maxTotalRetainedBytes=1MB, evict oldest completed only
    - Deterministic process group cleanup: cancellation and timeout proven by real E2E scenarios 53–55
    - Extension deactivation cleans up active subprocess: scenario 55
    - 59 terminal scenarios pass deterministically on Run 1 and Run 2
    - Full workspace: 318 tests pass, 0 TypeScript errors, build clean
  Sprint 3D.2 — Execution Identity & Deactivation Closure ✅ CLOSED
    - Canonical execution identity: PreparedVerification.verificationId passed directly end-to-end
    - No ID regeneration in production prepared verification workflow
    - Exact ID routing for verification.output without activeTerminal fallback
    - ConfirmationId remains distinct approval identity
    - Real extension deactivation kills active parent+child process tree without prior manual cancellation
    - Deactivation flushes terminal review registry to 0 reviews and 0 retained bytes
    - 79 terminal scenarios pass deterministically on Run 1 and Run 2
    - Full workspace: 318 tests pass, 0 TypeScript errors, build clean

  Sprint 3D.3 — Exact Lifecycle Event Routing & Review Isolation ✅ CLOSED PERMANENTLY
    - Canonical execution identity verificationId emitted across all verification lifecycle events: started, output, completed, failed, rejected
    - AgentRunner.#emit explicitly carries executionId: reviewable.id on all verification lifecycle events
    - Verification lifecycle payload interfaces in agent-core enforce required executionId: string
    - ChatController.requestConfirmation fails closed with REJECT when pc.verificationId is absent or empty whitespace (0 reviews, 0 spawns)
    - TerminalReviewController.registerPreparedCommand enforces required executionId: string (throws on missing/empty; zero fallback generation)
    - ChatController.handleAgentEvent routes verification.started, output, completed, failed, rejected strictly by executionId via registry lookup
    - Presentation state activeTerminal is never used as an event routing authority or fallback
    - Multi-review isolation: events for Review A cannot mutate Review B; background reviews cannot mutate or broadcast over activeTerminal
    - Safe lifecycle edge transitions: late completion after new chat turn does not resurrect activeTerminal; events after deactivation are safe no-ops
    - Reconciled Scenario 65 with live streaming and observable RUNNING status before subprocess completion
    - 97 terminal scenarios pass deterministically on Run 1 and Run 2
    - Full workspace: all tests pass, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice
    - Sprint 3D is PERMANENTLY CLOSED.

Sprint 3E & 3E.1 — Editor-Native Autocomplete & Production Wiring ✅ PERMANENTLY CLOSED
  - Autonomous separate execution path: zero dependency on AgentRunner, ToolRuntime, MutationEngine, VerificationEngine, MCP, or ProjectMemory
  - Production extension activation: registered on onStartupFinished, contributed toggle command, native registerInlineCompletionItemProvider for all documents ("*")
  - Safe zero-deployment behavior: defaults to safe empty routing configuration; unconfigured deployments yield quiet null without errors, popups, or cloud fallback
  - Dedicated AutocompleteService orchestrating context assembly, debounce, cancellation, stale safety, sanitization, and bounded telemetry
  - Real live editor stale guards: document version change alone, cursor movement alone, active document URI change alone, and newer request supersession each trigger stale discarded
  - In-flight request deduplication: deterministic editor and context hash key shares active promise without invoking provider a second time
  - Single-use acceptance telemetry: registry entries consumed upon first accept; double-accept and unknown IDs produce zero delta
  - Strict UTF-16 surrogate safety: prefix, suffix, total budget, output cap, and overlap sanitizer never produce orphaned surrogates
  - Editor-local context only: unsaved live editor buffer captured; zero Markdown brain or RAG disk reads; bounded budgets (prefix ~2,000 tokens, suffix ~1,000 tokens, total ceiling 3,500 tokens)
  - Sensitive file suppression: .env, *.pem, *.key skipped immediately with 0 provider calls
  - ModelRouter reused with dedicated taskClass: "autocomplete" and requiredCapabilities: ["autocomplete"]; chat-only models strictly rejected; zero cloud fallback
  - Full deactivation cleanup: disposes native provider, cancels in-flight tasks, and discards late results
  - 90 deterministic evaluation scenarios pass Run 1 and Run 2 with deep strict equality (zero failures)
  - Full workspace clean: all unit and E2E tests pass, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice

Sprint 4A — Security Hardening ✅ CLOSED PERMANENTLY
  - Adversarial threat model, authority map, and security model documented in docs/SECURITY_MODEL.md and ADR-023 (docs/adrs/ADR-023-system-security-boundaries.md)
  - Architecture updated with dedicated Security Boundary View in ARCHITECTURE.md
  - Symlink escape and path containment hardened: realpath-based containment across reads, writes, and non-existent create targets
  - Mutation TOCTOU hardening: applyPreparedMutation re-verifies path containment and rejects symlink targets at apply time
  - Webview protocol hardening: prototype pollution guard rejecting __proto__, constructor, and prototype own keys
  - Sensitive file matrix expanded: SSH private keys (id_rsa, id_ed25519) and credentials files added to suppression patterns
  - MCP runtime bounded: 64 KB maximum schema bytes and 16-level maximum nesting depth enforced
  - Subprocess isolation: shell:false enforced, minimal environment (PATH, NODE_ENV, npm_config_*), secrets isolated
  - Future Runtime Evals non-authority invariant established: evaluators are advisory only and cannot gain direct execution, mutation, or permission authority

Sprint 4A.1 — Security Evaluation Truth & Permanent Closure ✅ CLOSED
  - Strict runtime evidence contract: SecurityScenarioResult { id, category, description, actual, expected }
  - Elimination of all boolean proxy passes: zero `|| true`, zero `passed: true`, zero `safe: true`, zero synthetic assert.ok(true)
  - Assertions evaluate concrete runtime state via assert.deepStrictEqual(actual, expected) directly against live boundaries
  - Live production boundaries evaluated:
    * McpCatalog.discover() schema bounds and validation with in-memory transport injection
    * VerificationEngine.execute() subprocess environment isolation, secret redaction, and hash-mismatch stale base detection
    * Subprocess cancellation and process tree termination cleanup
    * AutocompleteController.provideInlineCompletionItems() malicious script/JSON completion handling and sensitive file skipping
    * resolveRepositoryPath / resolveWritePath path traversal, symlink escapes, and multi-root prefix containment
    * parseWebviewMessage prototype pollution rejection (__proto__, constructor, prototype) and message validation
    * SessionSummaryStorage corrupt JSONL fail-closed detection
  - Non-destructive normalization: strictly isolates OS temp paths ($TMP) and symbolic identifiers (durationMs, pid)
  - Absolute preservation of security decisions: allowed, error codes, spawnCount, orphanCount, secretExposed, and mutation isolation markers are NEVER discarded or normalized
  - Strict negative comparator tests: verified that assert.deepStrictEqual fails on mismatched allowed, spawnCount, orphanCount, secretExposed, or crossIdMutation
  - 91 comprehensive security evaluation scenarios pass deterministically on Run 1 and Run 2 (deep strict equality between runs)
  - Full workspace regressions: 18 test suites across all packages, 0 failures, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice

Sprint 4A.2 — Final Security Evidence Closure ✅ CLOSED PERMANENTLY
  - Webview DOM Rendering Execution Safety: Chat transcript, Controlled Terminal outputs, and Confirmation/Diff summaries verified to render untrusted input exclusively via textContent (container clearance using innerHTML = ''), with concrete runtime proof of 0 script executions, 0 event handler executions, and 0 unsafe navigations (javascript: links)
  - Canonical Extension Deactivation Lifecycle Cleanup: Real extension deactivate() lifecycle verified. VerificationEngine running process tree (tree-runner.cjs with child) and review registries are terminated and flushed cleanly on deactivate(), leaving 0 orphan processes, 0 review leaks, and safe no-op handling of late events
  - Real MCP Result Path & Tool Impersonation Non-Authority: Real TestMcpTransport and executeMcpCall path verified. Prompt injection and built-in tool impersonation payloads are strictly treated as inert string data with 0 permission classification mutations, 0 mutation engine invocations, and 0 tool escalations
  - Autocomplete Structural Isolation & Acceptance Safety: Structural isolation proven on AutocompleteController and AutocompleteService prototypes (0 execution/mutation authorities). Native acceptance triggers single-use telemetry consumption only, with zero process spawn or tool execution
  - Strict Negative Comparator Completeness: 10 distinct failure dimensions tested (allowed, spawnCount, orphanCount, secretExposed, crossIdMutation, scriptExecutionCount, eventHandlerExecutionCount, unsafeNavigationCount, permission, mutationsCount)
  - 97 comprehensive security evaluation scenarios pass deterministically on Run 1 and Run 2 (deep strict equality between runs)
  - Full workspace regressions: 357 tests pass across all packages, 0 failures, 0 TypeScript errors, 0 linter errors, clean build, clean git fsck, zero weight downloads
  - Sprint 4A / 4A.1 / 4A.2 is PERMANENTLY CLOSED.

Sprint 4A.3 — Closure Integrity Patch ✅ CLOSED PERMANENTLY
  - Node >=22.0.0 mandatory runtime verified under Node v22.23.2 and npm v10.9.8.
  - Production Webview rendering helpers extracted to `packages/vscode-integration/src/webview-render-helpers.ts` (`renderChatMessage`, `renderTerminalOutput`, `renderConfirmationSummary`) and imported by both production `ChatViewProvider` and tests (`webview.10`, `webview.11`, `webview.12`, `diff-core-e2e.test.ts`), eliminating parallel implementations.
  - Canonical extension lifecycle cleanup: `lifecycle.4` invokes the actual exported `extension.deactivate()` via `_testSeam`, which aborts the active VerificationEngine process tree (parent/child) and flushes all registries to 0; `lifecycle.6` proves late events delivered after `deactivate()` are safe no-ops and cannot resurrect registries (`stateRecreated: false`, `registryResurrectionCount: 0`).
  - Real Autocomplete authority audit & filesystem observation: synthetic counters replaced with real structural prototype audits (`structuralDependencies: []`), real workspace/target file change checks (`workspaceChanged: false`, `targetFileCreated: false`), zero child process sentinels (`childProcessSentinelCount: 0`), and single-use telemetry consumption delta (`acceptedTelemetryDelta: 1`).
  - 12 negative comparator tests verifying strict assertion failure on any field mismatch.
  - Non-contradictory SHA audit trail distinguishing starting SHA, implementation commit, documentation commit, and final HEAD.
  - 97 comprehensive security evaluation scenarios pass deterministically on Run 1 and Run 2 under Node 22 (deep strict equality between runs).
  - Sprint 4A / 4A.1 / 4A.2 / 4A.3 is PERMANENTLY CLOSED.

Sprint 4B — Runtime Evals & Adaptive Control ✅ CLOSED
  - Tiered runtime evaluation engine: L0 deterministic evaluator (< 1ms, zero token cost), L1 heuristic trajectory evaluator with action loop detection and penalty, L2 selective critic model with timeout race fallback to L1.
  - Non-authoritative invariant: Runtime evaluations advise/recommend (CONTINUE, SCHEDULE_VERIFICATION, INJECT_REVISION, TRIGGER_REPLAN, TERMINATE_RUN, PAUSE_HUMAN, RECOMMEND_MODEL, NO_OP), but never bypass security, auto-approve mutations, auto-approve commands, or escalate permissions.
  - Runtime evidence collector: Bounded action, tool, mutation, verification, route, security, and unresolved failure records with automatic secret redaction (API keys, bearer tokens, private keys) and output bounding.
  - Adaptive control policy: Deterministic mapping from evaluation signals and evidence to concrete runtime directives.
  - Audit trail & analytics: In-memory RuntimeEvalLedger with intervention state transition tracking (RESOLVED, IMPROVED, UNCHANGED, DEGRADED) and RuntimeEvalAnalytics for developer-facing summaries and repair loop metrics.
  - AgentRunner integration: Configurable runtimeEvals and adaptiveInterventions flags (both defaulting to true), allowing scripted benchmark traces to run cleanly with adaptiveInterventions: false while retaining evaluation metrics and evidence logging.
  - Strict evaluation test suite (npm run eval:runtime): 72 scenarios evaluated across 2 consecutive runs with assert.deepStrictEqual determinism, zero boolean proxies, and negative comparator failure tests.
  - Full workspace regressions: 336 unit tests pass, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals (100% task success rate, 100% safety, 100% multi-file).
  - ADR-024 (docs/adrs/ADR-024-runtime-evals-adaptive-control.md) recorded.
  - Sprint 4B is CLOSED.

### Sprint 4B.1: Adaptive Loop Integrity & Real Runtime-Eval Closure ✅ CLOSED
- **Objective**: Close live runtime loop gaps: enforce real E2E loops, stale evaluation version guards without caching, post-verification completion gating, fail-closed VERIFICATION_UNAVAILABLE when tests required, MUTATION_RESULT and TOOL_FAILURE active dispatch, REQUEST_MORE_CONTEXT bounded retrieval, CHANGE_MODEL hint forwarding, hard L0 dominance over L2 critic suggestions, distinct RUNTIME_EVAL terminationSource, and WAITING_FOR_CONFIRMATION transition on PAUSE_HUMAN.
- **Outcomes**:
  - 82 evaluation scenarios pass deterministically on Run 1 and Run 2 with deep strict equality.
  - Real execution loops tested across VERIFY, REVISE, REPLAN, STOP, and ASK_HUMAN without boolean proxies.
  - Zero regressions across full monorepo: 30/30 coding benchmarks pass (100%), all workspace unit tests pass, 0 typecheck errors, 0 linter errors.
  - Sprint 4B.1 is CLOSED.

### Sprint 4B.2: Adaptive Decision Completion & Permanent Runtime-Eval Closure ✅ CLOSED
- **Objective**: Complete remaining adaptive control decisions and enforce permanent runtime-eval closure:
  - Universal post-verification causality: all execution paths scheduling verification (MUTATION_RESULT, BEFORE_COMPLETION, or generic directives) dispatch verification, trigger a mandatory VERIFICATION_RESULT eval, record outcome in the ledger, and dispatch corrective directives (REVISE, REPLAN, ASK_HUMAN, STOP, CONTINUE).
  - Real bounded CHANGE_MODEL: ModelRouter and RoutedModelGateway consume a narrow ModelRouteHint (avoidDeploymentId, preferredCapabilities, preferredDeploymentId, reasonCode) with a bounded 1-turn lifetime, without direct provider construction or cloud fallback.
  - Real bounded REQUEST_MORE_CONTEXT: context inquiry observation, evidence collector update with incremented evidenceVersion, explicit re-evaluation, second directive consumption, and bounded context loop cap (MAX_CONSECUTIVE_CONTEXT_REQUESTS = 2).
  - Intervention outcome linking: recorded in RuntimeEvalLedger (RESOLVED, UNCHANGED, DEGRADED) for model changes, context requests, and verification outcomes across recommended, applied, and outcome layers.
- **Outcomes**:
  - 107 exact evaluation scenarios pass deterministically on Run 1 and Run 2 with deep strict equality.
  - Sprint 4B.2 is CLOSED.

### Sprint 4B.3: Integrated Route Proof & Documentation Integrity ✅ CLOSED PERMANENTLY
- **Objective**: Establish end-to-end integrated route proof with real production classes and ensure documentation truth:
  - Canonical integrated CHANGE_MODEL E2E: AgentRunner -> RoutedModelGateway -> ModelRouter -> Provider A -> RuntimeEvalEngine (L2 critic CHANGE_MODEL) -> AdaptiveControlPolicy (RECOMMEND_MODEL) -> ModelRouteHint -> AgentRunner Turn 2 -> RoutedModelGateway -> ModelRouter (consumes hint, chooses local-b) -> Provider B (returns response) -> route provenance -> RuntimeEvalLedger (outcome RESOLVED).
  - Production-component upgrades: Removed all fake provider mocks from routing scenarios (completion.14, completion.15). Real RoutedModelGateway, ModelRouter, and ScriptedModelProviders used end-to-end.
  - 1-turn bounded hint lifetime: Proved route hint consumes and clears, routing cleanly back to higher-priority deployment on Turn 3.
  - No persistent router rewrite: Router configuration deep-equality verified before and after adaptation.
  - No cloud fallback: Zero cloud/network provider calls; strictly local fallback behavior.
  - Robust edge regressions: No-alternate deployment retention (UNCHANGED outcome, finite completion), stale evaluation guard (CONTINUE, no hint), and cancellation before route B (0 provider B calls).
  - Documentation truth: Corrected critic source paths (`runtime-critic.ts`), verified 13 harness test categories (12 evaluation categories + negative test suite), updated scenario count to 111.
- **Outcomes**:
  - 111 exact evaluation scenarios pass deterministically on Run 1 and Run 2 with deep strict equality (zero boolean proxies, zero failures).
  - Strict negative comparator tests verify assertion failure on missing fields, score mismatch, decision mismatch, security flag mismatch, route hint mismatch, route deployment mismatch, loop observation mismatch, or outcome state mismatch.
  - Zero regressions across full monorepo: 30/30 deterministic coding benchmark cases pass (100%), 18/18 test suites pass, 0 typecheck errors, 0 linter errors.
  - Sprint 4B / 4B.1 / 4B.2 / 4B.3 is PERMANENTLY CLOSED.

Sprint 4C — Durable Checkpoints, Recovery & Safe Rollback ✅ CLOSED
  - Atomic Checkpoint Store: Atomic writes via temporary files and rename, SHA-256 integrity checksums, sequence tracking, atomic HEAD pointer, fail-closed schema versioning, retention pruning (maxCheckpoints = 50).
  - Write-Ahead Operation Journal: Append-only JSONL event log, deterministic idempotency keys (SHA-256(runId:evidenceVersion:kind:authorityId:intentHash)), deduplication to latest authoritative lifecycle status, retry lineage tracking.
  - Truthful File Observation & Mutation Reconciliation: Invariant that observed state dictates recovery — disk inspection against precondition and expected postcondition SHA-256 hashes (RECONCILED_APPLIED with write replay count = 0, RECONCILED_NOT_APPLIED, or AMBIGUOUS / BLOCKED_DIVERGENCE). Interrupted verifications yield INTERRUPTED and REVERIFY.
  - Separation of Authority: RecoveryController is strictly non-authoritative (diagnostic and planning only); rollbacks and mutations execute exclusively through MutationEngine under existing workspace containment boundaries.
  - Process Epoch Invalidation: Cryptographic processEpochId generated per process invocation; pending approvals and tokens from prior epochs are invalidated across process restarts (NEW_EPOCH_AUTHORITY_REQUIRED), preventing stale authorization attacks.
  - Bounded Recovery Artifact Store: Local preimage storage with strict bounds (8 MiB single file limit, 64 MiB run limit); preimages are strictly isolated from telemetry, analytics, prompts, and model payloads.
  - Storage Path Safety: Canonicalized containment verification with assertSafeStoragePath protecting against path traversal and symlink escape attacks across both root and candidate paths.
  - Real Process-Boundary Crash Tests (T-4840 / T-4841): Child Node processes simulate mid-write and pre-write crashes; verified that process B recovers without duplicate writes (writeReplayCount = 0) and invalidates approval tokens across process boundaries.
  - Strict Deterministic Evaluation Harness (npm run eval:recovery): 82 scenarios across 15 categories evaluated across 2 consecutive runs with assert.deepStrictEqual determinism and negative comparator tests.
  - ADR-025 (docs/adrs/ADR-025-checkpoints-recovery.md) recorded.

Sprint 4C.1 — Production Recovery Integration & Integrity Closure ✅ CLOSED PERMANENTLY
  - Canonical JSON Serialization: Recursive deterministic object key sorting and circular reference detection (`canonicalSerialize`) guaranteeing cross-platform deterministic SHA-256 checksums and journal idempotency keys.
  - Monotonic Checkpoint Sequences: CheckpointCoordinator seeds monotonically increasing sequence numbers from the latest on-disk checkpoint across restarts.
  - Production AgentRunner Write-Ahead Durability: Checkpoint coordinator integrated at all key lifecycle stages: `RUN_STARTED`, `BEFORE_MUTATION`, `AFTER_MUTATION`, `BEFORE_VERIFICATION`, `AFTER_VERIFICATION`, and `COMPLETED`.
  - Production Resumption (`AgentRunner.resumeFromRecovery`): Safely restores session state from durable checkpoints, reconciles operations, feeds recovery evidence into RuntimeEvalEngine, cleanly stops on `STOP`, safely pauses in `WAITING_FOR_CONFIRMATION` on `RECONFIRM` / `ASK_HUMAN`, and attaches `recoveryPlan`.
  - Canonical Rollback Routing: Mutation reversal strictly routes through MutationEngine with snapshot restoration via `registerSnapshot`, eliminating raw filesystem calls from rollback execution.
  - Zero Artificial Test Passes: Evaluated all 82 scenarios with concrete runtime observations; zero boolean proxies, zero simulated assertions.
  - 4/4 End-to-End Integration Tests: Complete E2E validation in `recovery-integration-e2e.test.ts`.
  - Full Monorepo Regressions Clean: 312 unit tests pass in agent-core, all workspace tests pass across cli, ide-adapter, and vscode-integration, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice.
  - Sprint 4C and 4C.1 are PERMANENTLY CLOSED.

Next:
Sprint 4D — Performance / Large Repositories → NEXT
