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

Sprint 4C.1 — Production Recovery Integration & Integrity Closure ✅ CLOSED
  - Canonical JSON Serialization: Recursive deterministic object key sorting and circular reference detection (`canonicalSerialize`) guaranteeing cross-platform deterministic SHA-256 checksums and journal idempotency keys.
  - Monotonic Checkpoint Sequences: CheckpointCoordinator seeds monotonically increasing sequence numbers from the latest on-disk checkpoint across restarts.
  - Production AgentRunner Write-Ahead Durability: Checkpoint coordinator integrated at all key lifecycle stages: `RUN_STARTED`, `BEFORE_MUTATION`, `AFTER_MUTATION`, `BEFORE_VERIFICATION`, `AFTER_VERIFICATION`, and `COMPLETED`.
  - Production Resumption (`AgentRunner.resumeFromRecovery`): Safely restores session state from durable checkpoints, reconciles operations, feeds recovery evidence into RuntimeEvalEngine, cleanly stops on `STOP`, safely pauses in `WAITING_FOR_CONFIRMATION` on `RECONFIRM` / `ASK_HUMAN`, and attaches `recoveryPlan`.
  - Canonical Rollback Routing: Mutation reversal strictly routes through MutationEngine with snapshot restoration via `registerSnapshot`, eliminating raw filesystem calls from rollback execution.
  - Zero Artificial Test Passes: Evaluated all 82 scenarios with concrete runtime observations; zero boolean proxies, zero simulated assertions.
  - 4/4 End-to-End Integration Tests: Complete E2E validation in `recovery-integration-e2e.test.ts`.
  - Full Monorepo Regressions Clean: 312 unit tests pass in agent-core, all workspace tests pass across cli, ide-adapter, and vscode-integration, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice.

Sprint 4C.2 — Fail-Closed Durability & Recovery Evidence Closure ✅ CLOSED PERMANENTLY
  - Fail-Closed Durability Gates: Pre-mutation & pre-verification journal/checkpoint persistence errors immediately halt execution before side-effects with `INTERNAL_ERROR` (`DURABILITY_UNAVAILABLE`). Post-mutation persistence failure records error, halts execution, but does not replay writes or attempt unverified rollbacks. Task completion checkpoint failure transitions task status to `FAILED` with `INTERNAL_ERROR`.
  - Repair Runner Durability Wiring: `RepairOrchestrator` propagates `checkpointCoordinator` to sub-runners, ensuring repair workflows enforce durable write-ahead operation journaling.
  - Strict Evidence Truth: `RecoveryScenarioDefinition` completely decoupled from evaluation results — callers cannot supply `passed: boolean`; pass/fail derived strictly via `node:util` `isDeepStrictEqual(actual, expected)`. All boolean proxies and synthetic stubs (e.g. `REC-ROL-05`, `REC-ROL-06`, `REC-RET-04`) eliminated.
  - Real Process-Boundary Rollback Crash Proof (`T-4842` in `crash-process-e2e.test.ts`): Child process writes rollback file to disk and is forcefully terminated (`process.exit(1)`) prior to recording journal completion; recovery process inspects workspace, confirms file matches pre-mutation preimage, and reconciles to `RECONCILED_NOT_APPLIED` with `writeReplayCount = 0`.
  - 90 Deterministic Scenarios across 17 Categories: Evaluated by `npm run eval:recovery` across two independent runs with 0 failures, 100% deep strict equality, and 8 negative comparator tests.
  - Full Monorepo Regressions Clean: 315 tests pass in agent-core, all workspace tests pass across cli, ide-adapter, and vscode-integration, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice (100%), 111 runtime evals.
  - Sprint 4C / 4C.1 / 4C.2 is PERMANENTLY CLOSED.

Sprint 4C.3 — Recovery Resume & Rollback Durability Closure ✅ CLOSED PERMANENTLY
  - Fail-Closed Recovery Resume Gate: `AgentRunner.resumeFromRecovery()` strictly halts execution fail-closed with `INTERNAL_ERROR` and emits `task.failed` (`RECOVERY_PERSISTENCE_FAILED`) if recording `RECOVERY_RECONCILED` checkpoint persistence fails.
  - `recordFailed()` Persistence Fail-Closed Invariant: Across approval execution, tool runs, scheduled verifications, and auto-verifications, failure to persist `recordFailed` after an operation is `STARTED` halts execution immediately with `INTERNAL_ERROR` and `RECOVERY_PERSISTENCE_FAILED`.
  - First-Class Write-Ahead Rollback Journaling (`ROLLBACK_MUTATION`): Rollback is a first-class journaled operation with authority `"mutation-engine"`. Executes strictly via `recordPrepared -> recordStarted -> MutationEngine.rollback/apply -> recordCompleted -> Checkpoint`. Duplicate completed rollback suppression produces zero reverse writes when disk is already restored, and yields `DIVERGED` if the file was modified after mutation.
  - Real Process Crash E2E Tests (`T-5114`-`T-5117` in `crash-process-e2e.test.ts`): Crash after reverse write reconciles `ROLLBACK_MUTATION` to `RECONCILED_APPLIED` with 0 duplicate writes; crash before write reconciles to `RECONCILED_NOT_APPLIED` with 0 replay writes.
  - Positive Real AgentRunner Verification Durability (`T-5119`-`T-5120`): Strict write-ahead sequence (`VERIFICATION_PREPARED -> VERIFICATION_STARTED -> BEFORE_VERIFICATION -> VerificationEngine -> VERIFICATION_COMPLETED -> AFTER_VERIFICATION`) with completed verifications surviving restart as `COMPLETED`.
  - 110 Deterministic Scenarios across 19 Categories: Evaluated by `npm run eval:recovery` across two independent runs with 0 failures, 100% deep strict equality, and 13 negative comparator tests.
  - Full Monorepo Regressions Clean: 334 tests pass in agent-core, all workspace tests pass across cli, ide-adapter, and vscode-integration, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice (100%), 111 runtime evals.
  - Sprint 4C / 4C.1 / 4C.2 / 4C.3 is PERMANENTLY CLOSED.

Sprint 4C.4 — Rollback Durability Final Seal ✅ CLOSED PERMANENTLY
  - Mandatory Durability Dependencies: `RollbackManager` strictly requires `operationJournal` and `checkpointStore` in `RollbackManagerOptions`. Non-durable rollback mode is completely eliminated. Missing dependencies fail closed with `status: "FAILED"`, `durabilityFailure: true`, 0 reverse writes, and 0 disk mutations (`T-5200`-`T-5202`).
  - Fail-Closed Journal History Read: Removed `.catch(() => [])` silent swallow from `getAllOperations(runId)`. Unreadable history fails closed with `status: "FAILED"`, `durabilityFailure: true`, 0 reverse `MutationEngine` calls, 0 PREPARED operations, and 0 workspace changes (`T-5203`-`T-5204`).
  - 6-Phase Durable Success Lifecycle: `Rollback requested -> Durability dependencies confirmed -> Journal history read successfully -> Rollback PREPARED durable -> Rollback STARTED durable -> MutationEngine reverse mutation -> Rollback COMPLETED durable -> ROLLBACK_COMPLETED checkpoint durable -> Only then report durable rollback success`.
  - Post-Write Checkpoint Persistence Failure Semantics: Reverse write and `recordCompleted` succeed on disk, but `saveCheckpoint` for `ROLLBACK_COMPLETED` throws -> removed `.catch(() => {})`, returns `status: "RECOVERY_REQUIRED"`, `recoveryRequired: true`, `durabilityFailure: true`, `durableSuccess: false`, `success: false`. Zero same-process replay; restart reconciliation truthfully resolves state (`T-5209`-`T-5210`).
  - `recordFailed()` Persistence Failure Semantics: Reverse write fails and `recordFailed()` persistence throws -> removed `.catch(() => {})`, returns `status: "RECOVERY_REQUIRED"` and `error: "RECOVERY_PERSISTENCE_FAILED: ..."`. Operation remains conservatively `STARTED` in the journal, zero same-process replay is attempted, and restart reconciliation marks it `NOT_APPLIED` (`T-5212`-`T-5213`).
  - Exactly-Once Reconciliation & Duplicate Write Prevention: Completed rollback replays with 0 reverse writes; `STARTED` + restored state reconciles to `RECONCILED_APPLIED` with 0 duplicate writes; `STARTED` + not-restored state reconciles to `RECONCILED_NOT_APPLIED` with 0 replay; `STARTED` + divergent state triggers `BLOCKED_DIVERGENCE` / `DIVERGED` with 0 reverse writes (`T-5214`-`T-5217`).
  - 117 Deterministic Scenarios across 21 Categories: Evaluated by `npm run eval:recovery` across two independent runs with 0 failures, 100% deep strict equality, and 18 negative comparator tests.
  - Full Monorepo Regressions Clean: All unit and E2E tests pass, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice (100%), 111 runtime evals.
  - Sprint 4C / 4C.1 / 4C.2 / 4C.3 / 4C.4 is PERMANENTLY CLOSED.

Sprint 4D & 4D.1 — Performance Truth, Real Scale & Backpressure Closure ✅ CLOSED
  - Real Large Scale Fixtures: Deterministic synthetic repository generator creating 25,005 indexable source files across 25 modules + 1,500 ignored/build tree files.
  - Zero-Content Byte Repository Discovery: Discovery walks directory trees using iterative BFS with bounded concurrency (`AsyncSemaphore`), enforces canonical ignore policies, sorts directory entries and files for 100% determinism across runs, and reads strictly 0 content bytes (`contentBytesRead = 0`).
  - Incremental File Metadata Updates: Single file additions, modifications, and deletions update the in-memory metadata index without full repository scans.
  - Rapid Event Storm Coalescing: `processEventStorm` coalesces rapid bursts of file change events by path within a 50ms window.
  - Production Bounded Concurrency in Search: `RepositorySearch` operates with a bounded worker pool feeding tasks through `AsyncSemaphore`, maintaining `peakActive <= maxConcurrency` and `peakQueued <= maxQueued`. Matches are committed in candidate index order for deterministic results.
  - Query Coalescing & Supersession: Identical concurrent queries are deduplicated via `searchCoalesced()`; rapid query storms are handled via `SearchCoordinator.searchLatest()`, cleanly aborting stale searches.
  - Truly Bounded Streaming File Reads: `readRepositoryFile` uses a chunk-streaming line reader (`open("r")`, `StringDecoder("utf8")`, chunk scanner) with 8KB null-byte binary detection, per-line byte ceilings, CRLF stripping, and immediate EOF upon reaching `endLine`, completely eliminating whole-file buffer allocations and proving `bytesReadFromFile << totalFileBytes`.
  - Bounded Waiting Queue in Semaphore: `AsyncSemaphore` bounds active tasks to `maxConcurrency` and waiting tasks to `maxQueued`, supporting `reject_new` (throws `SemaphoreQueueFullError`) and `cancel_oldest` overflow policies, with clean `AbortSignal` queued cancellation that never consumes running slots or leaks listeners.
  - Physical Sync Durability: `OperationJournal` writes entries using `FileHandle.appendFile()` followed by `FileHandle.sync()`, with fail-closed rollback truncation back to pre-append length on sync failure.
  - Scalable Runtime Eval Compaction: Repetitive failures compact into structured summary records with counts and error signatures; deterministic L0 and heuristic L1 evaluations maintain full adaptive-control fidelity across all 8 decisions (`CONTINUE`, `VERIFY`, `REVISE`, `REPLAN`, `STOP`, `ASK_HUMAN`, `REQUEST_MORE_CONTEXT`, `CHANGE_MODEL`) without accumulating unbounded raw evidence.
  - Rebuildable Secondary Recovery Indexes: `OperationJournal` and `CheckpointStore` maintain secondary in-memory metadata lookup caches (`#indexCache`, `#metadataIndex`) that accelerate lookups without weakening the durable append log or checkpoint JSON files as the sole authoritative sources of truth.
  - Zero Fake Passes: 48 placeholder/generator scenarios completely removed. Evaluated with 77 concrete, 100% measured scenarios across 10 categories.
  - Determinism & Negative Comparators: 100% deep strict equality between Run 1 and Run 2 across all 77 scenarios with 0 failures; 12 strict negative comparator tests verifying invalid scales, fake passes, cap overflows, whole-file reads, and durability violations fail.
  - Full Monorepo Regressions Clean: Verified under Node v22.23.2. All unit and E2E tests pass across agent-core, cli, ide-adapter, and vscode-integration; 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice (100%), 111 runtime evals, 117 recovery evals, 97 security evals.

Sprint 4D.2 — Journal Integrity, UTF-8 Bounds & Reporting Truth ✅ CLOSED PERMANENTLY
  - Fail-Closed Journal Read Semantics: `OperationJournal.getAllOperations(runId)` distinguishes between genuine absence (`ENOENT` returns `[]`) and read failures (`EACCES`, `EIO`, etc.), throwing `JOURNAL_READ_FAILURE` so callers (e.g. `RollbackManager`) fail closed with 0 reverse writes, 0 mutations, and 0 side effects (`T-6200`, `T-6203`, `T-6205`).
  - Malformed Journal Line Fail-Closed: Removed silent swallow of malformed JSON lines; malformed non-empty records throw `JOURNAL_CORRUPT` without partial replay or rollback side effects (`T-6201`, `T-6204`).
  - Runtime Schema Validation: Strict validation (`assertValidOperationRecord`) on all persisted journal records rejecting missing or invalid IDs, status, kind, schemaVersion, or processEpochId (`T-6202`).
  - Secondary Index Non-Authority: Secondary index lookup cache `#indexCache` is non-authoritative; authoritative disk log is always verified; corrupt on-disk journal cannot be rescued by the secondary index (`T-6207`).
  - Preserved Append-Sync Durability: Verified write-ahead sequence (`PREPARED` -> `STARTED` before side effect), sync failure fail closed, and 0 post-failure side effects (`T-6206`).
  - True UTF-8 Byte Ceiling Semantics: Exported `truncateUtf8ToBytes(text, maxBytes)` calculating byte length via `Buffer.byteLength(text, "utf8")` rather than UTF-16 code unit `.length`, preventing split multibyte sequences and isolated surrogate pairs (`T-6208`-`T-6210`). Tested across ASCII, accented text, CJK, emoji, and mixed scripts (`T-6211`-`T-6215`).
  - Real Deterministic 5MB Fixture & Measured I/O: Generated 5,000,000-byte fixture (`huge_dataset.txt`, 50,000 lines * 100 bytes) at LARGE scale; streaming ranged read (lines 100-120) reads exactly 1 chunk (65,536 bytes) and returns 2,099 bytes with 0 whole-file buffers; returned telemetry (`bytesReadFromFile`, `chunksRead`, `returnedBytes`, `wholeFileBuffered`) verified (`T-6216`-`T-6218`).
  - Bounded Runtime Evidence Retention: Large file read outputs bounded to <= 400 chars in `RuntimeEvidenceCollector` (`PERF-EVAL-12`), preventing raw full-file retention while preserving all 8 adaptive control decisions.
  - Measured Discovery Truth: Measured exactly 58 directories visited for 25,005 files across 50 modules (`mod_00`..`mod_49`) + 1,500 ignored files (26,505 total generated files).
  - Concrete Scenario & Negative Comparator Expansion: Performance harness expanded to 89 concrete, 100% measured scenarios (added `PERF-READ-13`..`PERF-READ-18`, `PERF-EVAL-12`, `PERF-JOURN-09`..`PERF-JOURN-12`, `PERF-REPORT-01`), 0 placeholder passes, 20 strict negative comparators (tasks 13-20 covering unreadable journals, corrupt lines, UTF-8 byte breaches, isolated surrogates, fake 5MB claims, unmeasured I/O, unmeasured directory counts, and report SHA mismatch) passing deterministically across two runs (`T-6219`-`T-6223`).
  - Authoritative Reporting Validation: Created `validate-final-report.test.ts` ensuring `FINAL_REPORT.txt` matches live runtime evidence and passes `npm test` (`T-6224`).
  - Full Monorepo Regressions Clean: Verified under Node v22.23.2. All unit and E2E tests pass across agent-core, cli, ide-adapter, and vscode-integration; 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice (100%), 97 security evals, 111 runtime evals, 117 recovery evals, 89 performance evals.
  - Sprint 4D, 4D.1, and 4D.2 are PERMANENTLY CLOSED.

Sprint 4D.3 — Measurement Integrity & Hard-Bound Closure ✅ CLOSED PERMANENTLY
  - Binary Detection I/O Audit (T-6300/T-6301/T-6302): Eliminated the separate 8 KB offset-zero binary sample read. Full-file path: binary check reuses the already-read `contentBuf` (no extra read). Ranged path: binary check uses first `min(bytesRead, 8192)` bytes of the first streaming chunk (no extra read). `bytesReadFromFile` now counts ALL and ONLY `handle.read()` calls — verified `bytesReadFromFile = chunksRead * 65536` for single-chunk ranged reads (PERF-READ-19, PERF-READ-20).
  - Hard `maxBytes` Ceiling Including Marker (T-6305/T-6306/T-6307/T-6308/T-6309): Introduced `dataBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_BYTES)` (12 bytes) reserving marker space before data is accumulated. `Buffer.byteLength(returnedContent, "utf8") <= maxBytes` is now always guaranteed, including the marker. Tiny budgets `maxBytes < 12`: returns empty content with `truncated=true`. Verified with ASCII, CJK, emoji, and mixed Unicode content at truncation boundaries (T-6305..T-6308, PERF-READ-21..PERF-READ-24).
  - Journal Cache Trust Explicit (T-6315/T-6316/T-6317/T-6318/T-6319): Added `#corruptedRuns = new Set<string>()` to `OperationJournal`. `getAllOperations()` registers JOURNAL_CORRUPT runs in the set and clears their cache. `getOperation()` throws immediately for known-corrupt runs even if warm cache exists — stale cache cannot bypass a corruption. `rebuildIndex()` clears both cache and corruption set. Verified: warm-cache legitimate serve (T-6315/T-6317), restart re-validation from disk (T-6318), and known-corruption cache bypass prevention (T-6319). New tests: PERF-JOURN-13/14/15.
  - Measured Report Pipeline (T-6310/T-6311/T-6312): Exported `PerformanceEvaluationSummary` interface from harness; `runPerformanceEvaluation()` returns `summary` field. `validate-final-report.test.ts` now calls `runPerformanceEvaluation()` and validates FINAL_REPORT.txt claims against measured summary values — no hardcoded constants. Two negative tests verify tampered metric values fail detection. New scenarios: PERF-REPORT-02, PERF-REPORT-03.
  - Total harness scenarios: 100 (89 from 4D.2 + 11 new in 4D.3). 0 failures across two runs.
  - Full Monorepo Regressions Clean: Verified under Node v22.23.2. All unit and E2E tests pass; 0 TypeScript errors, 0 linter errors, clean build. Journal integrity suite: 12/12 (9 + 3 new), UTF-8 bounds suite: 10/10 (7 + 3 new).
  - Sprint 4D / 4D.1 / 4D.2 / 4D.3 are PERMANENTLY CLOSED.

Sprint 4E.1 — Real Inference Production Wiring & Evidence Closure
STATUS: IMPLEMENTATION_COMPLETE — REAL_HOST_EVIDENCE_BLOCKED (Awaiting authorized host execution)
  - Canonical OpenAI-Compatible Endpoint Resolution Contract: Implemented `resolveCanonicalEndpoints` in `packages/agent-core/src/model/canonical-endpoint.ts`. Deterministically resolves `/v1/chat/completions`, `/v1/completions`, `/v1/models`, and base `/v1` from host roots or `/v1` paths with/without trailing slashes. Eliminates `/v1/v1` duplication. Rejects query strings (`QUERY_NOT_ALLOWED`), fragments (`FRAGMENT_NOT_ALLOWED`), and invalid protocols (`INVALID_PROTOCOL`).
  - Strict Local-First & Zero Cloud Fallback Policy: Rejects known proprietary cloud hosts (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, etc.) with `EndpointPolicyError` (`PROPRIETARY_CLOUD_FORBIDDEN`). Allows self-hosted endpoints on user machines.
  - Production Inference Authorization Boundary: Enforces `OPEN_VS_CODE_REAL_INFERENCE=1` across production callers (`OpenAICompatibleProvider`, `LocalFimProvider`). Mock fetch remains permitted as a deterministic test seam without weakening security.
  - Explicit FIM Strategy Configuration & Validation: Model descriptors and deployments declare `fimStrategy` (`qwen`, `starcoder`, `deepseek`, `prefix-suffix-middle`, `raw-prefix`). Validated via `validateRoutingConfig`; invalid strategies throw `ConfigValidationError`.
  - Production Autocomplete Gateway Wiring: `createProductionAutocompleteGateway` dynamically creates real `LocalFimProvider` instances for eligible local autocomplete deployments. Zero scripted providers in production. Wires real `EndpointHealthChecker` and `ModelPerformanceLedger`.
  - Production Agent Runtime Wiring: `createAgentRuntime` replaces hardcoded static health checks with real `EndpointHealthChecker` probing configured endpoints, and wires workspace-scoped `ModelPerformanceLedger` (`.open-vs-code/model-performance-ledger.json`).
  - Model Authority Boundary & Robustness: Model responses cannot modify routing configurations or elevate permissions. Malformed JSON, HTTP errors, timeouts, and cancellations fail safely.
  - Privacy-Preserving Performance Ledger: Aggregates metrics only; never stores source code, prompts, completions, diffs, or secrets. Corrupt or schema-mismatched files reset safely.
  - Real Model Benchmark Harness Refactor: Refactored `runAgentBenchmark` to exercise genuine production stack (`AgentRunner` -> `RoutedModelGateway` -> `ModelRouter` -> local provider -> bounded tools -> evidence) against temporary repository fixtures with sanitized privacy-safe telemetry.
  - Deterministic Evaluation Suites:
    * 64 deterministic integration scenarios in `model-integration-eval.ts` pass twice with 100% deep strict equality.
    * 19 comprehensive closure scenarios in `sprint-4e-closure-eval.test.ts` pass with zero failures.
  - Remaining Host Evidence Requirements: Real host inference execution with `OPEN_VS_CODE_REAL_INFERENCE=1` on designated machine with active Ollama/vLLM/llama.cpp server generating live JSON and Markdown benchmark reports.

Next:
Execute real-model benchmark on authorized inference host, then proceed to Sprint 4F (Code-OSS / VSCodium Desktop Packaging).

