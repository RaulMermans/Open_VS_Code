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
STATUS: IMPLEMENTATION_COMPLETE — SUPERSEDED BY SPRINT 4E.2

Sprint 4E.2 — Configuration Truth & End-to-End Real Model Closure
STATUS: IMPLEMENTATION_COMPLETE — SUPERSEDED BY SPRINT 4E.3

Sprint 4E.3 — Evidence Integrity & Adaptive Routing Closure
STATUS: IMPLEMENTATION_COMPLETE — REAL_HOST_EVIDENCE_BLOCKED (Awaiting authorized host execution)
  - AgentRunner Single Authority: `AgentRunner` is the authoritative component for recording agent model outcomes into `ModelPerformanceLedger`. `createAgentRuntime` injects the production ledger into primary `AgentRunner` and repair loop instances.
  - Bridge Evidence Cleanup: Removed synthetic performance metric calculations (`verificationSuccess = true`, `toolCallSuccess = toolCalls.length > 0`, `repairCycles = 0`) from `bridge.ts`. Bridge responsibility reduced to persisting the ledger upon task completion.
  - Paused Confirmation Invariant: Performance outcomes are strictly prohibited from being recorded during `WAITING_FOR_CONFIRMATION` or `PAUSED` states. Confirmation pause is not a failure. Outcomes record exactly once upon terminal completion (`COMPLETED`, `FAILED`, `CANCELLED`).
  - Truthful Outcome Semantics:
    * `verificationSuccess`: Evaluated from real verification tool executions (`run_known_test`, `run_verification`) and runtime evaluation scores; non-mutating read-only tasks default truthfully to completion status.
    * `toolCallSuccess`: True only if all executed tool calls reached `COMPLETED`; mere invocation does not constitute success.
    * `repairCycles`: Measures actual continuation attempts and verification failures rather than synthetic zero.
    * `timeoutOccurred` & `cancellationOccurred`: Accurately classified from genuine runtime cause.
  - Autocomplete Accounting & Latency: Exactly one outcome sample recorded per request. Acceptance finalizes pending shown suggestions without double-counting; unaccepted suggestions finalize upon replacement or disposal; captures empty, stale, and cancelled requests. Measured latency uses `performance.now()`. Persisted via debounced flushing and service disposal flush.
  - Ledger Initialization & Concurrency: Awaits ledger loading before constructing routers and awaiting gateway readiness. Read-merge-write with temporary files and rename guarantees agent and autocomplete never clobber each other's profiles in shared workspace ledger stores.
  - Benchmark Pinned Routing & Provenance: Adaptive routing explicitly disabled in benchmark harness (`disableAdaptiveRouting()`). Route provenance observed from runtime decisions (`RoutedModelGateway.lastDecision`). Structural syntax validation (`validateStructuralSyntax` / `structurallyValid`).
  - Secure API Key Handling: Added `apiKeyEnv` across schema, config loader, provider factories, and health checks to resolve authentication headers from environment variables without plaintext storage.
  - Comprehensive Test Matrix: 50/50 tests pass in `sprint-4e-closure-eval.test.ts` (including 18 Sprint 4E.3 closure tests); full monorepo regressions clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals (100%), 111 runtime evals (100%), 50 recovery evals (100%), 100 performance scenarios (100%).
Sprint 4E.4 — Evidence Semantics, Persistence Safety & Final Closure (IMPLEMENTATION COMPLETE — REAL HOST EVIDENCE BLOCKED)
  - Corrected Agent Success Semantics: `AgentRunner` records `runtimeCompleted = isCompleted` and `qualitySuccess = runtimeCompleted && verificationSuccess && toolCallSuccess`, recording `success: qualitySuccess` so tasks with failed verifications or broken tool calls are never classified as success.
  - Transparent Adaptive Routing Formula: `ModelPerformanceLedger.getRoutingAdjustments()` uses explicit weighted formula: `qualityScore = 0.50 * successRate + 0.30 * verificationRate + 0.20 * toolRate - repairPenalty - timeoutPenalty`, bounded to `[-maxAdjustment, +maxAdjustment]` with hysteresis and sample floor.
  - Safe Schema Migration: Bumped `LEDGER_SCHEMA_VERSION = 2`. Incompatible legacy v1 ledgers are safely reset to prevent mixing inconsistent success metrics while leaving user workspace configuration intact.
  - Serialized Concurrent Persistence: Per-path async write queue (`persistQueuesByPath`) combined with in-memory delta merging (`#deltas`) and temp-file rename prevents concurrent writes or same-profile multi-instance updates from losing updates.
  - Single Initialization Contract: Unified around `.ready` promise and single initial `#loadPromise`; late loads never overwrite in-memory metrics.
  - Durable Autocomplete Shutdown: Awaited asynchronous disposal across `AutocompleteService.dispose()`, `AutocompleteController.dispose()`, and `extension.deactivate()`, flushing pending shown outcomes and debounced writes to disk before shutdown.
  - Truthful Autocomplete Failure Accounting: Selected deployment provider failures record explicit failure evidence in ledger.
  - Env-Only Credential Boundary: Literal `apiKey` completely removed from `ProviderDescriptor`, `models.schema.json`, and loader; `apiKeyEnv` is the only supported credential mechanism. Auth headers propagate to both inference requests and health probes (`/v1/models`) without leaking secrets.
  - Comprehensive Test Matrix: 69/69 tests pass in `sprint-4e-closure-eval.test.ts` (including 19 Sprint 4E.4 closure tests); full monorepo regressions clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 coding evals (100%), 111 runtime evals (100%), 50 recovery evals (100%), 100 performance scenarios (100%).
  - Real-Host Benchmark Preflight: Preflight acceptance verifies authorization, endpoint reachability, /v1/models response, model availability, warmup inference, and clean git worktree. If any precondition fails, emits BLOCKED_WITH_EVIDENCE without running measured tasks.
  - Status: Sprint 4E.4 IMPLEMENTATION COMPLETE — REAL HOST EVIDENCE BLOCKED: Local model qwen2.5-coder:7b not installed on host Ollama server (0 served models).

Sprint 4F — Code-OSS / VSCodium Desktop Packaging & V1 Candidate ✅ COMPLETE
  - Status: SPRINT 4F COMPLETE — OPEN VS CODE V1 DESKTOP CANDIDATE (Remaining Gate: HALO Target-Host Release Acceptance Only).
  - Desktop Shell Decision (ADR-028): Audited upstream Code-OSS vs VSCodium across 10 evaluation criteria (reproducibility, licensing, telemetry, branding, extension bundling, update mechanism, marketplace behavior, macOS packaging, portability, maintenance). Selected pinned VSCodium distribution (`1.135.06055`, VS Code `1.135.0`, commit `5a73682ca091082675b10c9dc3f348c1d824d94f`, MIT license).
  - Extension-First Invariant Preserved: Maintained strict separation: Desktop Shell -> bundled extension -> IDE adapter -> agent core -> local/external model endpoint. Zero AI logic in editor source tree.
  - Packaging Workspace (`apps/desktop`): Pinned, repeatable packaging process with `@open-vs-code/desktop` package, `upstream.json` with SHA-256 integrity verification (`61ff9ebc3ac5563c63a0a9e1b479822647e7f2c3303b0629f15fefe9e291f7cc`), deterministic download caching in `apps/desktop/.cache`, staging in `apps/desktop/staging`, and distribution in `apps/desktop/dist`.
  - Branding & Identity: Configured product name "Open VS Code", bundle identifier `com.openvscode.desktop`, isolated data directory `.open-vs-code-desktop`, disabled crash reporting and telemetry permanently (`enableTelemetry: false`). Renamed macOS Electron helper bundles to match CFBundleName (`Open VS Code Helper.app`, `(GPU).app`, `(Plugin).app`, `(Renderer).app`).
  - Deterministic Bundling: Packaged `@open-vs-code/vscode-integration` directly into `Contents/Resources/app/extensions/open-vs-code.vscode-integration/` (with backward-compatibility symlink `open-vs-code`), registered in `product.json` `builtInExtensions`, enabling automatic discovery on first launch with zero marketplace dependency.
  - Real Desktop Runtime Acceptance (Category C): Implemented and verified `npm run desktop:accept` (3/3 passing): (1) real packaged GUI process launches, reaches healthy running state, and shuts down cleanly via SIGTERM; (2) real VSCodium extension host discovers bundled extension, activates it via `ext.activate()`, and registers all 10 `open-vs-code.*` commands; (3) distributable archive extracts cleanly and satisfies strict codesigning verification.
  - Packaged Smoke & Integration Tests (Categories A, B, D): 13/13 automated smoke tests in `apps/desktop/smoke/desktop-smoke.test.ts` pass, including Category D packaged integration crossing extension boundaries for autocomplete (`AutocompleteController` -> `AutocompleteService` -> Production Gateway -> `ModelRouter` -> `LocalFimProvider` -> `/v1/completions`) and chat turns (`ChatController` -> `AgentSessionBridge` -> `AgentRuntime` -> `/v1/chat/completions`) against mock fixture with zero cloud fallback.
  - Code Signing & Verification Truth: Packaging strictly verifies codesign using `codesign --verify --deep --strict`. Truthfully reports "Ad-hoc signed and verified (Local V1 Candidate)". Never claims Apple Developer ID notarization.
  - HALO Architecture Reconciliation: Authoritative dual-path topology documented in `docs/deployment/HALO_ACCEPTANCE.md`: ADR-020 HALO Core capability path (`/inference/capability/chat`) for agent chat/reasoning when `inferenceBackend = "halo"`; ADR-027 direct OpenAI-compatible FIM path (`/v1/completions`) hosted on HALO. Target platform documented truthfully as AMD Halo host with runtime/model placeholders. Zero model weights on development Mac.

Sprint 5A — Portable Skills Runtime (V1.1) — SPRINT 5A COMPLETE — PORTABLE SKILLS RUNTIME VERIFIED (deterministic) · REAL-MODEL SKILL DELTA DEFERRED TO HALO
  - Closure check (in Sprint 5B): skill evidence now distinguishes SELECTED → LOADED → INJECTED. `SkillInjectionTracker` reconciles evidence with the final compiled context (`injectionStatus`, `injectedSkills`, `injectedSkillTokens`), and the CLI, IDE and "Show active skill" report a skill only if it reached the model. 4 tests in `skill-injection-truth.test.ts`, including the audit case: preliminary budget passes, final compile drops the skill, reported `OMITTED_BY_FINAL_BUDGET`.
  - Contract: strict `SKILL.md` (YAML-subset frontmatter, seven required sections), JSON Schema `config/schemas/skill.schema.json`, validator `agent-core/src/skills/schema.ts` (ADR-029).
  - Sources: five curated built-ins (`bug-triage`, `tdd`, `refactor-with-guards`, `security-review`, `verification`) in `packages/agent-core/skills/builtins`, plus trusted-workspace `.open-vs-code/skills`. A workspace override must validate and narrow the built-in.
  - Runtime: `SkillRegistry` builds a metadata-only index and lazily loads each body once. `selectSkill` (deterministic; "no skill" is valid; ties abstain) checks mode, registered tools and PermissionGate capabilities. Default 1 skill, hard cap 2 via `composes_with`. Guidance is optional context ranked after active code.
  - Flag: `skills.enabled` (default off; CLI `--skills`, VS Code `open-vs-code.skills.enabled`). Off keeps the frozen ADR-014 path byte-for-byte.
  - Evidence: 38 skill-runtime tests plus 1 CLI and 2 extension tests. Selection eval 38/40 (95.0%): no-skill 9/9, wrong skill 0, 1 false positive, 1 false negative. Context: eager 2530 tokens vs lazy average 332.1 tokens (−86.9%; −81.8% including the 128-token index).
  - Desktop: built-ins ship in the packaged extension. **List Available Skills** and **Show Active Skill** are registered in the real VSCodium extension host (12 commands).
  - HALO A/B: DEFERRED_TO_HALO (no real-model baseline exists yet).

Sprint 5B — Structured Engineering Loop & Fresh-Context Review (V1.1) ✅ COMPLETE (deterministic) · REAL-MODEL WORKFLOW DELTA DEFERRED TO HALO
  - Design (ADR-030, `docs/workflows/ENGINEERING_LOOP.md`): one sequential `EngineeringWorkflow` (PLAN → IMPLEMENT → TEST → REVIEW → VERIFY → COMPLETE, any → BLOCKED/CANCELLED) over the existing AgentRunner, PermissionGate, VerificationEngine, skills runtime and CheckpointStore.
  - Model stages: each PLAN, IMPLEMENT and REVIEW gets a fresh runner session with a stage tool envelope (`ToolRegistry.restrict` + `stagePermission`, which narrows only).
  - Deterministic stages: TEST and VERIFY run only repository-defined checks; VERIFY also checks diff integrity.
  - Fresh review: an allow-listed envelope; findings must quote the diff or a changed file; `NO_FINDINGS` is valid.
  - Repair: at most 2 test repairs and 2 review repairs, then BLOCKED.
  - Persistence: `WORKFLOW_STAGE` checkpoints, with restore that never re-runs completed stages. Cancellation is terminal.
  - Flag: `workflow.enabled` (default off; CLI `--workflow`, VS Code `open-vs-code.workflow.enabled`).
  - Evidence:
    - 27 workflow tests (all 30 required behaviours plus the `IMPLEMENTER_PRIVATE_CONTEXT_SENTINEL` fresh-context proof, with negative controls), 2 CLI tests and 2 bridge tests;
    - `npm run eval:workflow`: eligibility 14/14;
    - A/B on simulated fixtures: direct 4/5 correct and 1/2 injected defects caught, against workflow 5/5 and 2/2, at 25 vs 17 model calls, about 1.9× the prompt tokens and 19 vs 12 approvals;
    - reviewer-bias pipeline: true-positive rate 100%, false-positive rate 33.3% (the inflated-severity probe), severity correctness 80%.
  - Runner change: IMPLEMENT sessions mark `verificationOwner: "workflow"`, so post-mutation verification is owned by the mandatory TEST/VERIFY stages (the direct path is unchanged).
  - HALO A/B: DEFERRED_TO_HALO.
  - Closure (verified in Sprint 5C): workflow persistence passes through `sanitizeWorkflowState`, which reuses the canonical redactor (test `C-0A`), and REVIEW receives the true net diff, not the mutation history (regression `C-0B`). SPRINT 5B COMPLETE — STRUCTURED ENGINEERING LOOP & FRESH-CONTEXT REVIEW VERIFIED.

Sprint 5C — Non-Progress Detection & Bounded Recovery (V1.1) ✅ COMPLETE (deterministic) · REAL-MODEL NON-PROGRESS DELTA DEFERRED TO HALO
  - Design (ADR-031, `docs/workflows/NON_PROGRESS_RECOVERY.md`): new `packages/agent-core/src/progress/`.
    - Deterministic `ProgressSnapshot` and `compareSnapshots`: ADVANCED / CHANGED / STALLED / REGRESSED / UNKNOWN.
    - `ProgressMonitor`, an observer that only requests CONTINUE / DIAGNOSE / BLOCK.
    - `classifyStall` (10 classes), one read-only discriminating check, `NonProgressRecoveryPlan`, and a structured `BLOCKED_NON_PROGRESS` report.
  - Workflow: observes START, MUTATION, TEST, REVIEW and VERIFY. One recovery per workflow draws from the existing repair budget. It uses a compact, allow-listed recovery context; the plan, earlier repairs and transcripts are excluded. Restart-safe.
  - Direct path: `DirectProgressGuard` in `AgentRunner` catches repeated (also non-consecutive) actions, repeated errors, no-op writes, context burn and turn exhaustion without evidence. It gets one recovery turn with deduplicated observations.
  - Flag: `progressMonitor.enabled` (default off; CLI `--progress-monitor`, VS Code `open-vs-code.progressMonitor.enabled`).
  - Evidence:
    - 51 new tests: 6 closure, 23 monitor/unit, 14 workflow integration, 8 direct path;
    - `npm run eval:progress` (A = off, B = on, same simulated model):
      - known loops 5/5 detected, false stalls 0/4, classification 5/5;
      - 13 model calls, 13 tool/check calls and 3,327 prompt tokens saved, with 0 model calls added by diagnostics;
      - recovery success 1/4 attempts (simulated implementer).
  - Defects found: the failure normalizer missed node:test's `# duration_ms`, so identical failures had different fingerprints (fixed; P-04b); the 5B guide's skills table wrongly listed `bug-triage` as selectable in IMPLEMENT (corrected).
  - HALO A/B: DEFERRED_TO_HALO.

Sprint 5D — Bounded Memory-to-Skill Learning & V1.1 Benchmark Closure ✅ COMPLETE (deterministic) · REAL-MODEL V1.1 BENCHMARK — DEFERRED_TO_HALO
  - 5C closure: progress epochs in `DirectProgressGuard` and `ProgressMonitor`, so there is no inherited repetition count after measurable progress (EP-01–EP-07, `eval:progress` fixture J). `SPRINT 5C COMPLETE — NON-PROGRESS DETECTION & BOUNDED RECOVERY VERIFIED`.
  - Design (ADR-032, `docs/learning/LEARNING_SYSTEM.md`): new `packages/agent-core/src/learning/`. It provides deterministic extraction, evidence thresholds (1 → OBSERVED, 2 → CANDIDATE, 3 independent → skill proposal), project/reusable scope, dedupe, rejection fingerprints, staleness, skill candidates validated with the 5A schema and a capability ceiling, an explicit approval gate, and approved-only retrieval within 10% of the context.
  - Surfaces:
    - CLI `--learning` and `learning list|show|approve|reject|decide`;
    - IDE bridge `learning.enabled`;
    - VS Code `open-vs-code.learning.enabled` and *Review Learning Candidates*.
  - Evidence: `npm run eval:learning` 10/10 fixtures, classification 16/18, dedupe 45/45, 0 false promotions, 0/6 malicious trusted, 9/9 escalations rejected, stored tokens −87.2% vs an estimated transcript. 654/654 tests. `docs/evals/V1_1_BENCHMARK.md`.
  - Final closure (candidate sanitization): every skill-candidate field passes one boundary, `normalizeSkillCandidate`, before persistence. Secrets, hidden reasoning, authority overrides and executable markup are rejected (not redacted). Frontmatter gets the same scan as the body, and rejection evidence is a code, never content (C-01–C-21). 665/665 tests; all evals and desktop package/smoke/accept unchanged and green.
  - Final hardening (raw candidate input bounding): `submitCandidate` used to `JSON.stringify` the raw untrusted object to derive the candidate id before the boundary ran. Raw input is now structurally bounded first (≤ 64 top-level keys, counted without reading values; list length and string type checked before traversal; nested objects rejected), and the id derives only from the bounded canonical draft or the rejection stub's code and ids (C-22–C-24). 668/668 tests; eval metrics unchanged; full ladder and desktop accept green.

Sprint 7A — Agent Experience & Chat UX — SPRINT_7A_PARTIALLY_VERIFIED
  - Presentation-only Webview polish on the existing ChatController bridge (ADR-018). No second agent engine. ContextCompiler remains prompt authority; PermissionGate remains side-effect authority.
  - Header (mode, backend/model, truthful connection, New), composer (Enter/Shift+Enter/Escape, duplicate-submit guard), explicit file/selection descriptors (`@` search, trust/sensitive/ignored unavailable states), incremental transcript rendering, activity timeline from real AgentEvents, confirmation double-click lock, retainContextWhenHidden.
  - HALO is never shown Ready without a health check. No model downloader, cloud fallback, or token streaming.
  - Evidence: `packages/vscode-integration` 45/45 tests including new `sprint-7a-*.test.ts`. V1.1 flags remain default-off.
  - Record: `docs/sprints/SPRINT_7A_AGENT_EXPERIENCE.md`.
  - Blocked here: live VSCodium GUI/theme walkthrough; `tsc --noEmit` idle hang for this package (ship path is esbuild).
  - Closed in 7B: the hang was the iCloud-evicted checkout; two hidden type errors fixed; packaged desktop smoke 13/13, accept 3/3.

Sprint 7B — Terminal, Diff Review & Developer Workflow — SPRINT_7B_PARTIALLY_VERIFIED
  - Presentation and review-path hardening over the existing ChatController / TerminalReviewController / DiffReviewController. No agent-core change, no new execution or permission path, no new dependency.
  - Command card, change approval details, "Changes & commands" ledger, native Output panel / Git change / Source Control, draft-only retry.
  - Fixes: monotonic terminal status; `terminal.cancel` only for a RUNNING id; conflicting confirmation refused; orphaned confirmation released as REJECT at turn end; output posts stop at the bound.
  - Evidence: `tests/sprint-7b-terminal-diff.test.ts` (17 tests, all 7 safety mutants killed); full repo gate and packaged desktop green.
  - Open: human live-GUI checklist; per-hunk approval (needs MutationEngine partial apply); agent-core `resolveRepositoryPath` absolute-path-through-symlink false rejection (fails closed).
  - Record: `docs/sprints/SPRINT_7B_TERMINAL_DIFF_EXPERIENCE.md`.
  - Closed in 7C: the symlink false rejection (fixed with tests) and the security flake (PID-file race in the test harnesses, fixed).

Sprint 7C — Persistent Conversations, Workspace Sessions & Recovery UX — SPRINT_7C_PARTIALLY_VERIFIED
  - ADR-033. `ConversationStore` holds display history only, in `ExtensionContext.storageUri`, separate from agent memory (`sessions.jsonl`) and checkpoints.
    - Atomic exclusive-temp + rename writes, checksums, quarantine, per-record workspace identity, one sanitization boundary (redaction, bounds, relative paths).
    - Bounds: 50 conversations, 100 messages, 200k characters, 512 KiB per record.
  - Chat: create, switch, rename, archive, confirmed delete, filter, continue-in-new-conversation (≤ 6 inherited turns), native "Show Conversation History".
    - Switching is refused during an active task.
    - Restore shows unfinished work as interrupted and restores no approval.
  - Read-only recovery view: `inspectRunRecovery` (agent-core) over `buildRecoveryPlan(runId, { persistReconciliation: false })`. Executable resume is not offered.
  - Fixes: `resolveRepositoryPath` re-roots absolute paths spelled through a symlinked workspace root. Process-tree test harnesses publish PIDs atomically and clean up on failure.
  - Evidence: `tests/sprint-7c-sessions.test.ts` (28), `recovery-inspection.test.ts` (8), `path-safety-symlink.test.ts` (4). All 16 safety mutants were killed. Packaged restart acceptance is `desktop:accept` test 4.
  - Open: human live-GUI checklist (themes, VoiceOver); executable resume from the editor.
  - Record: `docs/sprints/SPRINT_7C_SESSIONS_WORKSPACE_CONTINUITY.md`.

Sprint 7D — IDE Responsiveness, Performance & UX Hardening — SPRINT_7D_PARTIALLY_VERIFIED
  - Baseline first (`npm run eval:ide-performance`, `desktop:accept` test 5 in the packaged app), interleaved before/after runs; results in `evals/results/sprint-7d/`.
  - Fixed:
    - identical editor context posted full state;
    - every agent event re-sent the transcript (`transcript: "unchanged"`);
    - the webview rebuilt unchanged sections, lost approval focus and yanked scroll;
    - status labels were not updated;
    - pending model rows escaped the 50-row bound;
    - autocomplete copied the whole document twice per keystroke;
    - a late cancel cancelled a newer request;
    - the byte-cap loop re-serialised the record per dropped message;
    - redactor gaps (quoted JSON keys, URL credentials, more token formats).
  - Tradeoff: about 1.5 ms more CPU per full history save or read for the wider redaction.
  - Evidence: 38 new tests (`sprint-7d-performance.test.ts` 33, `redaction-formats.test.ts` 4, `desktop:accept` test 5); 25/26 mutants killed (1 equivalent).
  - Open: human GUI/VoiceOver checklist. On this near-full disk, filesystem-bound 4D agent-core tests intermittently time out on `main` too (0 failures in any run).
  - Record: `docs/sprints/SPRINT_7D_IDE_PERFORMANCE.md`.

Sprint 8A — MCP Integration 2.0: Modern Transports, Secure Connections & Tool Governance — SPRINT_8A_ACCEPTED
  - ADR-034. Modernization to official MCP protocol specifications (2026-07-28 stateless POST, 2025-11-25 Mcp-Session-Id, 2024-11-05 handshake).
  - Evaluated `@modelcontextprotocol/sdk` and maintained zero-dependency footprint via native WHATWG fetch/SSE `StreamableHttpMcpTransport`.
  - Comprehensive network guard (`McpNetworkGuard`): HTTPS default, loopback allowed, private IP/cloud metadata blocked, safe manual redirect validation.
  - Secret management: `SecretProvider` abstraction with VS Code `SecretStorage` bridge (`VsCodeSecretProvider`); zero credentials stored in plaintext.
  - Enhanced tool governance: `mcp_sensitive_data_transmission` and `mcp_external_destructive` mapped to CONFIRM in baseline and DENY in plan/ask/review; anti-tampering prevents server annotation lowering.
  - Bounded connection states: DISABLED, DISCONNECTED, CONNECTING, AUTH_REQUIRED, CONNECTED, DEGRADED, FAILED with bounded reconnect (max 3 retries).
  - 8 native VS Code commands for server and tool inspection/lifecycle management via QuickPicks without HALO or live LLM requirement.
  - Verification evidence: 37/37 deterministic modern matrix tests (including real local HTTP fixture server), 8/8 VS Code command tests, 13/13 desktop smoke, 5/5 real packaged desktop runtime acceptance, 0 linter errors, 0 TypeScript errors.
  - Record: `docs/sprints/SPRINT_8A_MCP_INTEGRATION_2.md`.

Sprint 8A.1 — MCP Protocol Conformance & Security Closure — SPRINT_8A1_ACCEPTED
  - ADR-034 Amendment. Closes all 7 protocol conformance and security gaps identified during independent audit of Sprint 8A:
    - Wire conformance: requests use `params._meta` (root-level `_meta` eliminated), required `io.modelcontextprotocol/protocolVersion` ("2026-07-28"), `io.modelcontextprotocol/clientCapabilities`, and `io.modelcontextprotocol/clientInfo`.
    - Routing headers: added mandatory `Mcp-Method` on all requests and `Mcp-Name` on `tools/call`. Suppressed `Mcp-Session-Id` header for stateless requests.
    - Connection-time DNS enforcement: built `createSafeLookupFunction` on `http.Agent`/`https.Agent` intercepting DNS lookups at socket creation time, preventing DNS rebinding attacks.
    - IP normalization: parses and validates alternate IP representations (octal, hex, dword, IPv4-mapped IPv6 `::ffff:...`, link-local, carrier-grade NAT, multicast, reserved).
    - Private deployment compatibility: explicit `TrustedNetworkPolicy` with default restrictive blocking and approved private host allowlisting.
    - Streaming response bounding: replaced `res.arrayBuffer()` with streaming chunk consumption, upfront `Content-Length` enforcement, and early socket destruction on `maxResponseBytes` breach.
    - Robust SSE parser: persists state across arbitrary network chunk boundaries, joins multiline `data:` events with newlines, safely strips trailing CRLF, and preserves multibyte UTF-8 code points.
    - Truthful authentication diagnostics: accurately distinguishes supported Bearer/SecretStorage/RFC 9728/RFC 8414/PKCE primitives from unsupported interactive OAuth browser flows.
    - Deterministic verification: 9/9 new tests in `mcp-conformance-security.test.ts` against `StrictMcpReferenceServer`, 52/52 agent-core MCP tests green, 8/8 vscode-integration MCP command tests green, 13/13 desktop smoke tests green, 5/5 real packaged desktop runtime acceptance tests green, 0 linter errors, 0 TypeScript errors.
  - Record: `docs/sprints/SPRINT_8A1_MCP_CONFORMANCE_SECURITY.md`.

Sprint 8B — Private Account Backend, Authentication & Persistent Integration Profiles — SPRINT_8B_ACCEPTED
  - ADR-035. Implemented private, administrator-controlled account backend and integration profile management:
    - Separately deployable `@open-vs-code/account-service` package with zero runtime dependencies beyond Node 22+ built-ins.
    - Private provisioning model: no public registration, one-time bootstrap CLI (`open-vs-code-admin bootstrap`), explicit roles (`ADMIN`, `USER`), account activation/disabling, administrative password resets, and structured audit logs.
    - Cryptographic security: Scrypt hashing (RFC 7914, $N=16384, r=8, p=1$), constant-time comparison, timing-equalized dummy verification preventing username enumeration, 32-byte opaque session tokens (`ovsc_sess_...`), verifier-only database persistence (SHA-256), and sliding-window rate limiting.
    - Persistence & migrations: embedded SQLite (`node:sqlite` on Node 22+ with robust CLI fallback), versioned schema migrations, foreign keys with `ON DELETE CASCADE`, and server-side ownership enforcement (`owner_user_id`).
    - Persistent integration registry: per-user MCP configuration registry with workspace policy enforcement (`integration_workspace_policies`); client secrets stay in VS Code `SecretStorage`, while future server-side secrets use an AES-256-GCM vault with external master keys.
    - Desktop integration surface: `DesktopAccountManager` in `@open-vs-code/vscode-integration` providing native QuickPick login/logout, profile inspection, and MCP configuration synchronization.
    - Offline & failure resilience: graceful fallback to `OFFLINE` and `STALE` without impeding local editing or local model inference; server-side writes fail closed.
    - Deterministic verification: 56/56 account-service tests green, 137/137 vscode-integration tests green, 13/13 desktop smoke tests green, 5/5 real packaged desktop runtime acceptance tests green, 0 linter errors, 0 TypeScript errors.
  - Record: `docs/sprints/SPRINT_8B_PRIVATE_ACCOUNTS.md`.

Sprint 8C — Visual Integration Manager, Account Profiles & MCP Lifecycle UX — SPRINT_8C_ACCEPTED
  - ADR-036. Implemented visual integration manager and lifecycle UX for MCP servers, portable skills, and account profiles:
    - Mandatory P0 Security Closure: deterministic account-switch isolation and reconciliation; remote plaintext HTTP rejection; URL embedded-credential rejection; token wiping on backend origin switch, 401, or account disablement; cross-origin and protocol downgrade redirect blocking; workspace-level policy enforcement; and SQLite runtime fail-closed guard (`UnsupportedDatabaseRuntimeError`).
    - Visual Integration Hub: Native VS Code webview UI (`ChatViewProvider`) with 5 primary sections: Profile, MCP Servers, Skills, Modes (non-interactive placeholder), and Diagnostics.
    - MCP Dashboard & 5-Step Add MCP Wizard: Real status monitoring, server management actions, and safe guided connection workflow without automated command execution.
    - Tool Inspection & Governance: Discovered tool inspector with JSON schema display, trusted local permission classification (`classifyMcpAction`), destructive and sensitive data warnings, and strict `PermissionGate` non-bypass invariants.
    - Portable Skills & Account Integration: Discovers built-in and workspace skills via `SkillRegistry`, surfaces diagnostics, and synchronizes account registrations without destroying local configurations.
    - Deterministic verification: 66/66 account-service tests green, 165/165 vscode-integration tests green (including 28 new visual manager tests), 13/13 desktop smoke tests green, 5/5 real packaged desktop runtime acceptance tests green. 0 lint errors, 0 TypeScript errors.
  - Record: `docs/sprints/SPRINT_8C_VISUAL_INTEGRATION_MANAGER.md`.

Sprint 8D — Custom Modes Engine, Mode Profiles & Account-Aware Execution — SPRINT_8D_ACCEPTED
  - ADR-037. Implemented a deterministic, extensible Custom Modes system without multiplying agent runtimes:
    - Core Invariant: "A custom mode is a configuration profile, not an independent agent." Preserved the 5 canonical base modes (`ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW`) and mapped every profile strictly to one base mode (`CustomModeProfile` → `ResolvedExecutionProfile` → `AgentSessionBridge` → `AgentRuntime`).
    - Declarative Manifest & Validation: Version 1 schema with fail-closed validation rejecting prototype pollution, unknown fields, credentials (`AKIA...`, `BEGIN PRIVATE KEY`, `ghp_...`, bearer tokens), non-canonical base modes, and oversized instructions.
    - Deterministic Resolution: Synthesized profile, base mode, workspace trust, account policies, installed skills, MCP tools, model router deployments, and global feature flags. Missing required dependencies block execution (`isReady: false`); optional missing dependencies emit diagnostics; tool allowlists compute intersection without expansion; model preferences resolve to available deployments or fall back.
    - Permission Authority & Immutability: Custom profiles cannot expand authority beyond base mode, workspace trust, or `PermissionGate`. Active tasks freeze the resolved profile snapshot; mid-turn mode switches and pending confirmation inheritance across mode boundaries are strictly blocked.
    - Persistence Scopes & Reconciliation: Account profiles stored via `@open-vs-code/account-service` Migration 2 (`mode_profiles` table) with user isolation and audit logging (`mode.created`, `mode.updated`, `mode.deleted`). Workspace profiles stored in `.open-vs-code/modes.json`. Workspace profiles override account profiles sharing an ID with diagnostic notice.
    - Visual Modes Management UI: Replaced inactive Sprint 8C placeholder with a complete Webview interface (overview cards, 9-step wizard, deep mode inspector, duplicate, toggle, delete). Extended chat dropdown with `<optgroup label="Custom Profiles">` and live readiness status badge chips. Fully backward compatible conversation persistence.
    - Starter Profiles: Built-in `architecture-review` (REVIEW), `reverse-engineering-analysis` (PLAN), and `design-exploration` (PLAN).
    - Deterministic Verification: 679/679 agent-core tests green (27 new), 73/73 account-service tests green (7 new), 183/183 vscode-integration tests green (18 new), 14/14 runtime evals green, 40/40 skills evals green, 19/19 workflow evals green, 13/13 desktop smoke green, 5/5 packaged desktop acceptance green. 0 lint errors, 0 TypeScript errors.
  - Record: `docs/sprints/SPRINT_8D_CUSTOM_MODES.md`.

Sprint 8D.1 — Custom Modes End-to-End Execution & Integration Closure — SPRINT_8D1_ACCEPTED
  - ADR-037 amended. Closed the end-to-end execution boundary between Custom Modes and runtime components (`AgentSessionBridge`, `AgentRuntime`, `PermissionGate`, tools):
    - Authoritative Production Capability Snapshot: Replaced empty mock capability arrays with a single runtime-grounded snapshot (`IntegrationManagerController.getProductionCapabilitySnapshot()`) deriving live workspace trust, authenticated account session state, active account/workspace policies, registered tools, enabled skills, connected MCP servers, and available local model deployments.
    - Unified MCP Catalog Ownership: Reused long-lived `McpCatalog` from `McpService` directly in `AgentRuntime`, eliminating redundant subprocesses while enforcing mode and user authorization boundaries.
    - Concrete Tool Allowlists: Mapped tool names to real action categories (`KNOWN_REPOSITORY_TOOL_ACTIONS`), computing effective tools via intersection with base mode permissions.
    - Strict Base-Mode Enforcement: Guaranteed `resolvedProfile.baseMode === executionMode` at runtime boundary; failed closed on unready, disabled, or unauthenticated profiles.
    - Profile Execution Effects: Bound `effectiveModelId` to `RoutedModelGateway`, respected `effectiveWorkflow` in workflow gate, injected required skills into model context compilation, and injected custom instructions into project instructions.
    - Real-Time Account Invalidation: Attached account state listener in `ChatController` to cancel active turns on account logout/switch; purged account-owned MCP servers immediately.
    - Comprehensive Verification: 20/20 end-to-end integration scenarios passing (`custom-modes-e2e.test.ts`), 203/203 vscode-integration tests, 706/706 agent-core tests, 73/73 account-service tests, 14/14 desktop smoke tests (including packaged desktop custom mode execution contract test), and 5/5 real desktop acceptance tests. 0 lint errors, 0 TypeScript errors.
  - Record: `docs/sprints/SPRINT_8D1_CUSTOM_MODES_RUNTIME_CLOSURE.md`.

Sprint 8E — Capability Packs: Declarative Packaging, Dependency Resolution & Governed Installation — SPRINT_8E_ACCEPTED
  - ADR-038. Implemented declarative packaging, deterministic dependency resolution, and governed installation of Capability Packs without multiplying agent runtimes:
    - Core Architecture Invariant: A Capability Pack is a declarative bundle of references to existing capabilities, not a secondary agent loop or permission authority. Execution flows through `ModeResolver` into the existing `AgentSessionBridge`, `AgentRuntime`, and `PermissionGate`.
    - Governed Lifecycle Operations: Implemented 10 distinct operations (Import, Validate, Preview, Install, Enable, Activate, Disable, Update, Remove, Rollback). Strictly enforced `Import != Install != Enable != Execute`. Prohibited arbitrary execution directives (`npm`, `npx`, shell, docker).
    - Untrusted Input Defense: Schema `open-vs-code/capability-pack@v1` with validation against SemVer syntax, SHA-256 integrity digests, prototype pollution, path traversal, embedded credentials, executable directives, and base mode permission ceilings.
    - Deterministic Dependency Resolution (`PackResolver`): Resolves readiness across Custom Modes, Skills, MCP live connections and tools, model preferences, and workspace trust into 7 structured states (`READY`, `INSTALLED_INACTIVE`, `MISSING_DEPENDENCIES`, `INCOMPATIBLE`, `BLOCKED_BY_POLICY`, `UNTRUSTED`, `INVALID`). Fails closed on disconnected or missing dependencies.
    - Dual-Scope Persistence & Scope Reconciliation: Account packs stored in SQLite database (`capability_packs` table with foreign key cascades, user isolation, and audit logging) via `AccountService`; workspace packs stored in `.open-vs-code/packs.json`. Workspace overrides Account on collision. Account logout immediately purges account packs from active runtime while preserving workspace packs.
    - Visual Integration Hub UX: Extended Visual Integration Manager with a 6th navigation tab ("Capability Packs") providing card browsing, status chips (Installed, Enabled, Ready, Running, Blocked), manifest import wizard, deep inspector with dependency graph and effective permissions, update, rollback, and removal.
    - Canonical Starter Packs: Built-in Reference Pack A (`repo-architecture-review`, read-only REVIEW base mode) and Reference Pack B (`mcp-research-demo`, PLAN base mode requiring local MCP server).
    - Comprehensive Verification: 56 new tests across core (22), account service (10), and vscode-integration (24); 1,038 total passing tests monorepo-wide (728 core, 83 account service, 227 vscode-integration). 100% clean typecheck and linting (0 warnings, 0 errors). All evals passed (`eval:runtime` 14/14, `eval:skills` 38/40, `eval:workflow` 14/14, `desktop:smoke` 14/14, `desktop:accept` 5/5 real Electron GUI tests).
  - Record: `docs/sprints/SPRINT_8E_CAPABILITY_PACKS.md`.

Sprint 8E.1 — Capability Packs Integrity, Isolation & Runtime Closure — SPRINT_8E1_ACCEPTED
  - ADR-038 amended. Closed verified gaps in manifest integrity, account mode cleanup, cross-device restoration, and SemVer parsing:
    - Canonical manifest serialization and strict SHA-256 integrity validation.
    - Ephemeral in-memory account pack mode registration with immediate purge and turn cancellation upon logout/switch.
    - Cross-device multi-client synchronization and mode restoration.
    - Strict SemVer range parsing and atomic storage with corruption recovery.
    - Verified across 12 comprehensive end-to-end integration scenarios (`capability-packs-e2e.test.ts`).
  - Record: `docs/sprints/SPRINT_8E1_CAPABILITY_PACKS_CLOSURE.md`.

Sprint 9A — Governed Playwright Browser Runtime & Agent Tool Integration — SPRINT_9A_ACCEPTED
  - ADR-039. Implemented secure, locally executable browser automation capability integrated directly into existing Agent Runtime:
    - Zero Secondary Agent Brains: Browser tools execute via canonical pipeline (`Custom Mode -> AgentSessionBridge -> AgentRuntime -> PermissionGate -> Governed Browser Tool Adapter -> BrowserSessionManager -> Playwright Chromium -> Structured Browser Result`).
    - Technology Selection: Evaluated `microsoft/playwright-mcp` and `microsoft/playwright-cli`; implemented governed direct session management wrapping pinned `playwright-core` with compact MCP-compatible tool signatures, process tree tracking, and granular network route interception.
    - Mandatory Preflight Account Pack Reconciliation: Reconciled authoritative server packs against ephemeral account mode profiles in `ModeService`, pruning orphaned profiles, invalidating active mode selections when revoked, preserving workspace modes, and preventing revoked execution.
    - Governed Browser Tools (7): `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_close`.
    - Token Efficiency: Byte-bounded accessibility snapshots (32KB default limit) and element references (`refId`) with automatic invalidation upon navigation/reload (`[STALE_ELEMENT_REFERENCE]`).
    - Strict Permission Classification: Low-risk inspection (`browser_inspection`, ALLOW), interaction (`browser_interaction`, CONFIRM in BUILD), sensitive fields (`browser_sensitive`, masked review), and destructive actions (`browser_destructive`, CONFIRM/DENY). High-risk tools (arbitrary `eval`, CDP, cookie exports) strictly excluded.
    - Network Guard & SSRF Protection: Origin allowlisting, link-local blocking (`169.254.0.0/16`), private subnet blocking (`10.0.0.0/8`, etc.), cloud metadata blocking (`metadata.google.internal`), and `file://` protocol rejection enforced via `isBrowserUrlPermitted()` and `page.route` interception.
    - Browser Provisioning Diagnostics: Scans environment overrides, Playwright cache, and system paths. Fails closed with `NOT_CONFIGURED` without running uncontrolled `npx/npm` auto-downloads from inside the agent.
    - Starter Profile & Pack: `Browser QA — Local Development` (`browser-qa-local-dev`, base mode `PLAN`) and `Browser QA — Local Development Pack` (`browser-qa-local-dev-pack`) with SHA-256 integrity verification.
    - Comprehensive Verification: 31 high-value scenarios passing across runtime lifecycle, security and policy gates, and end-to-end integration with real local Chromium execution.
  - Record: `docs/sprints/SPRINT_9A_PLAYWRIGHT_BROWSER_RUNTIME.md`.

Sprint 9A.1 — Browser Security, Permission Integrity & Desktop Runtime Closure — SPRINT_9A1_ACCEPTED
  - ADR-039 amended. Closed verified security, network, permission, and integration gaps prior to Sprint 9B:
    - P0 Chromium Isolation: Removed unconditional `--no-sandbox` and `--disable-setuid-sandbox` from browser launches; added platform sandbox verification (`verifyEffectiveSandboxSupport()`); fails closed with `SANDBOX_UNAVAILABLE` rather than silently disabling isolation; ephemeral isolated profile storage in `.browser-profile/<sessionId>`.
    - P0 Network Boundary: Replaced page-scoped filtering with `BrowserContext`-wide interception covering popups and secondary pages; blocked Service Workers by default (`serviceWorkers: "block"`); redirect-chain tracking against `maxRedirects`; DNS rebinding defenses (`verifyHostDnsSafety`); exact localhost origin/port matching without wildcards; WebSocket restrictions.
    - P0 Sensitive Observations: Masked passwords, tokens, and keys in snapshots (`[hasValue]` with undefined contents); implemented `redactSensitiveText` for console buffers, URLs, and errors; byte limits enforced.
    - P0 Real Permission Classification: Dynamic effective action promotion (`classifyAction` on `ToolRegistration` and `effectiveAction` on `PreparedToolCall`); `AgentRunner` evaluates `effectiveAction` before `PermissionGate`; introduced `browser_side_effect` for form submissions/purchases/mutations; stale target revalidation in `prepareForReview.apply()`.
    - P1 Desktop Integration: Governed `BrowserSessionManager` wired into VS Code extension composition root (`extension.ts`), passed via `AgentSessionBridge` to `AgentRuntime`; account logout/switch cleanup via `accountManager.onStateChange`; clean disposal on `deactivate()`.
    - P1 Browser QA Profiles: Bifurcated into read-only inspection profile `browser-qa-local-dev` (`PLAN`) and interactive profile `browser-qa-interactive-local-dev` (`BUILD`) with canonical packs.
    - Reference Stability & Cancellation: Relative `nth-of-type` selector calculation; session DOM `data-ovsc-ref`; `window.stop()` on navigation abort; process tree cleanup.
    - Verified across 20 comprehensive independent acceptance scenarios (`browser-acceptance-9a1.test.ts`), 10 security tests (`browser-security.test.ts`), and full monorepo lint and typecheck.
  - Record: `docs/sprints/SPRINT_9A1_BROWSER_SECURITY_RUNTIME_CLOSURE.md`.

Sprint 9A.2 — Browser Security Proof, Network Isolation & Runtime Reliability — SPRINT_9A2_ACCEPTED
  - ADR-039 Addendum 13, `docs/SECURITY_MODEL.md`, and `ARCHITECTURE.md` amended. Closed independent inspection defects and established real Chromium process and network evidence for Sprint 9A.1 security claims:
    - P0 Connection-Level Network Enforcement & DNS Rebinding Protection: Enforced `verifyHostDnsSafety()` before `route.continue()` across requests, redirect chains, and `routeWebSocket()`, backed by per-session `BrowserEgressProxy` (`proxy: { server, bypass: "<-loopback>" }`) with `createPinnedLookup()` IP pinning at socket dial time (`http.request`, `https.request`, HTTP `Upgrade`, and TLS `CONNECT`). Default-port canonicalization enforced in `matchOrigin()`. Prohibited private RFC1918, link-local, loopback rebind, IPv6 ULA/mapped, and cloud metadata destinations rejected with 0 upstream requests.
    - P0 Chromium Sandbox Runtime Verification: Enabled explicit `chromiumSandbox: true` across supported platforms; separated pre-launch OS capability checks (`verifyEffectiveSandboxSupport()` probing `sandbox-exec` on macOS and kernel userns/setuid on Linux) from post-launch OS process-table runtime proof (`EffectiveSandboxVerification` confirming live Seatbelt/seccomp helper processes and 0 `--no-sandbox` flags via `execProcessProbe`); recorded OS release, Chromium version, and executable path provenance; failed closed with `SANDBOX_UNAVAILABLE`.
    - P0 Cryptographic Target Binding & Live Approval Revalidation: Replaced CSS fallback selectors with strict `[data-ovsc-ref][data-ovsc-snap][data-ovsc-session]` attribute binding, pre-snapshot `data-ovsc-*` DOM stripping, SHA-256 `targetFingerprint` over live identity/side-effect attributes (`tag`, `role`, `name`, `inputType`, `href`, `formAction`, `parentSignature`), duplicate-ref rejection (`AMBIGUOUS_TARGET_REFERENCE`), and live risk reclassification inside `revalidateApproval()` wired into `browser_click` and `browser_fill` `prepareForReview.apply()`.
    - P1 Workspace & Account Session Isolation: Scoped `BrowserSessionManager` in `packages/vscode-integration/src/extension.ts` to `(normalizedWorkspace, effectiveAccountId, configKey)` with resource-scoped settings and `globalStorageUri` storage; automatic `invalidate()` on workspace switch, logout, account switch, config change, untrusted workspace, and `deactivate()`; verified zero Chromium launches on Integrations Hub render.
    - P1 Outside-Repository Profiles & 8-Surface Secret Redaction: Provisioned `0o700` ephemeral profiles outside project repositories (`os.tmpdir()/open-vs-code-browser-profiles/ovsc_<sessionId>` or extension `globalStorageUri`), rejected in-repo `storageDir` (`UNSAFE_PROFILE_PATH`), cleaned up profiles on close/failure/crash and via `cleanupOrphanedBrowserProfiles()`, masked sensitive DOM inputs during `screenshot()`, and scrubbed secrets across form values, URLs, titles, console messages, network diagnostics, screenshots, approval payloads, and error messages.
    - Real Chromium Adversarial Verification & Regression Gates: 20/20 real Chromium scenarios passing in `browser-acceptance-9a2.test.ts` (Chromium `156.0.0.0` on `darwin 25.5.0`), 2/2 VS Code workspace/account isolation tests in `browser-isolation-9a2.test.ts`, 1,157/1,157 monorepo tests (`84` account-service, `807` agent-core, `21` cli, `7` ide-adapter, `238` vscode-integration), 0 TypeScript errors, 0 oxlint warnings/errors, `eval:runtime` 14/14, `eval:skills` 38/40 (95.0%), `eval:workflow` 14/14, `desktop:smoke` 14/14, and `desktop:accept` 5/5 real packaged Electron GUI tests.
  - Record: `docs/sprints/SPRINT_9A2_BROWSER_SECURITY_PROOF.md`.

Sprint 9B — Integrated Visual Browser, Agent Activity & Observation UX — SPRINT_9B_ACCEPTED
  - ADR-040 (`docs/adrs/ADR-040-browser-panel-observation-ux.md`). Delivered a dedicated visual browser panel integrated into the desktop application:
    - Strict Execution vs Observation Separation: Visual browser functions strictly as a presentation layer observing the existing `BrowserSessionManager` for the active `(workspaceRoot, accountId, configKey)`. Opening the panel never launches Chromium or navigates.
    - Dedicated WebviewPanel: Registered `open-vs-code.openBrowserPanel` (`ViewColumn.Beside`) with active URL, page title, session identity, viewport metrics, provisioning diagnostics, and accessibility tree.
    - Bounded Outside-Workspace Ring Buffer: Serves screenshot previews via an isolated temporary directory (`os.tmpdir()/open-vs-code-browser-artifacts/`) with automatic FIFO eviction (up to 10 screenshots / 20MB max), coalesced 1–2 fps rate limiting, and instant capture suspension when hidden.
    - Bounded Event Timeline & Correlation: Records ordered lifecycle, navigation, tool, approval, policy denial, and crash events with origin attribution (`AGENT`, `USER`, `SYSTEM`) and correlated `taskId` and `confirmationId`. Zero secret/token leakage across URLs and titles.
    - Accessibility Inspector & Coordinate-Free Bounding Box Overlay: Renders element hierarchy with `refId`, role, interactive states, warnings, and non-interactive `pointer-events: none` bounding box overlay tied to the active viewport and snapshot. Disables actions upon DOM staleness.
    - Governed Manual Browser Controls: User operations (open, navigate, refresh, screenshot, inspect, click, fill, close) execute through `PermissionGate` and `classifyAction()`. Enforces network allowlists, workspace trust, read-only mode ceilings, and side-effect confirmation. Excludes arbitrary JavaScript `eval`, CDP, and cookie exports.
    - Sprint 9C & 9D Observation Contracts: Supports baseline pinning, before/after side-by-side comparison, computed typography/spacing inspection, non-claim animation probe (`motionQualityClaimAllowed: false`), and opt-in observation journal categorizing Observed Facts, Inferred Behavior, and Unknown Details.
    - Comprehensive Verification: 30 new unit and security tests in `browser-observation-9b.test.ts`, `browser-panel-9b.test.ts`, and `browser-panel-security-9b.test.ts`; 9 real Chromium performance and observation tests in `browser-panel-real-chromium-9b.test.ts`; Category C packaged desktop acceptance test 6 passing in real Electron host; all evals green (`eval:runtime` 14/14, `eval:skills` 38/40, `eval:workflow` 14/14).
  - Record: `docs/sprints/SPRINT_9B_VISUAL_BROWSER_EXPERIENCE.md`.

Sprint 9C — Advanced Design & Motion — Specialized Skills, Visual Engineering & Quality Evaluation — SPRINT_9C_ACCEPTED
  - ADR-041 (`docs/adrs/ADR-041-advanced-design-motion.md`). Transformed Open VS Code into an advanced frontend design and motion engineering system:
    - Single Authoritative Runtime & Declarative Capability Pack: Packaged `advanced-design-motion-pack@1.0.0` conformant to `open-vs-code/capability-pack@v1` and custom mode `advanced-design-motion` in BUILD mode. Rejects autonomous multi-agent swarms in favor of sequential, checkpointed workflow stages.
    - 8 Progressive Disclosure Skills (<1,000 tokens each): Authored built-in skills `design-direction`, `ux-information-architecture`, `design-system-engineering`, `frontend-composition`, `motion-engineering`, `visual-qa`, `accessibility-review`, and `design-polish` loaded dynamically per workflow stage to prevent context prompt bloat.
    - Structured DesignBrief Contract & Durable Design Artifacts: Canonical `DesignBrief` validation, non-destructive `DESIGN.md` / `PRODUCT.md` documentation generation, token derivation, and production CSS variable export with dark/light themes and `@media (prefers-reduced-motion: reduce)` zero-duration transitions.
    - Bounded 5-Stage Sequential Workflow Engine: `DesignWorkflowEngine` executing Stage A (Discover & Shape), Stage B (Design System), Stage C (Frontend Implementation), Stage D (Motion Engineering), and Stage E (Visual QA & Refinement). Enforces a hard bounded improvement loop of maximum 3 iterations in Stage E.
    - Zero-Dependency Pure TypeScript Visual Comparison Engine: Complete PNG chunk parser/encoder using Node native `node:zlib` (0 external dependencies like `sharp` or `canvas`), perceptual Euclidean color-distance diffing, bounding box clustering of changed regions, and semantic classification (`layout_shift`, `color_mismatch`, `element_missing`, `text_change`, `minor_anti_aliasing`).
    - Objective In-Browser Measured Motion Evaluation: In-page `requestAnimationFrame` temporal sampling, frame jitter/FPS calculation, jank detection (>50ms frame gap), Web Animations API keyframe inspection, layout thrashing property detection (`top`, `left`, `width`, `height`, etc.), and strict gating on `motionQualityClaimAllowed` (requiring avg FPS >= 50, 0 jank, 0 thrashing).
    - Independent Hybrid Visual QA Evaluator: Deterministic checks (WCAG 2.1 AA 4.5:1 / 3.0:1 contrast ratios, DOM overflow, focus rings, accessible names, image alts, console errors) and ergonomic heuristics (typographic reading measure 45–85 chars/line, CTA hierarchy).
    - Real Chromium & Browser Panel Integration: Real Chromium test suite verifying in-browser rAF sampling and animation keyframe inspection; VS Code Webview Browser Panel rendering diff clusters, motion telemetry, and Visual QA findings.
    - Comprehensive Verification: 1,238 / 1,238 monorepo tests passing, 0 lint warnings/errors, 0 typecheck errors across all 5 workspaces, eval:skills 95.0% accuracy with 91.0% context reduction, desktop smoke 14/14, desktop accept 6/6.
  - Record: `docs/sprints/SPRINT_9C_ADVANCED_DESIGN_MOTION.md`.

Sprint 9C.1 — Advanced Design Runtime Integration & Evidence Integrity — SPRINT_9C1_ACCEPTED
  - ADR-041 Addendum (`docs/adrs/ADR-041-advanced-design-motion.md`). Closed verified production gaps from Sprint 9C:
    - P0 Governed Runtime Integration (`GovernedDesignWorkflow`): Wired directly into `createAgentRuntime` and `AgentSessionBridge` as the single authoritative sequential design runner. Preserves existing single-runtime architecture, checkpointing, and permission gates without secondary agents or parallel loops.
    - P0 Genuine Implementation & Repair: Eliminated synthetic echo returns in Stage C and Stage D. Workflows generate and update concrete frontend files (`index.html`, `styles.css`, `app.js`) via `MutationEngine.applyPreparedMutation()` gated behind `IdeHost.requestConfirmation`. Stage E executes bounded iterative repair (max 3 loops) re-evaluating actual browser state after approved mutations.
    - P0 Evidence-Backed Browser Observation & Contrast Integrity: Replaced fabricated static values (`#ffffff`, `#2563eb`, 1280px) in `BrowserPanelController.#handleRunVisualQa()` with actual browser state observed via `BrowserSessionManager.observeVisualQaState()`. Contrast ratio calculation returns `null` for indeterminate/unparseable colors and emits warnings instead of fabricating 21:1 passes. Clarified that automated checks do not guarantee manual WCAG AA compliance.
    - P1 Objective 5-Verdict Motion Evaluation: Prohibits motion quality claims unless active animations ran during observation. Evaluates across 5 discrete verdicts (`measured_passing`, `measured_failing`, `no_animation_detected`, `unsupported_measurement`, `insufficient_evidence`). Tests reduced-motion under explicit `prefers-reduced-motion: reduce` emulation.
    - P1 Hardened Pure-TypeScript PNG Processing: Added strict input/output bounds (`MAX_PNG_INPUT_SIZE` = 25MB, `MAX_PNG_DECOMPRESSED_SIZE` = 64MB, `MAX_PNG_WIDTH` = 4096, `MAX_PNG_HEIGHT` = 4096, `MAX_PNG_TOTAL_PIXELS` = 8M), chunk CRC32 checksum verification, rejection of corrupt/truncated chunks, filter type checks, and Adam7 interlacing rejection.
    - P1 Upstream Provenance & Attribution: Corrected Anthropic Frontend Design license to Apache-2.0 per upstream repository; pinned exact reviewed commits (`2e4fa71`); updated capability pack commit to canonical `dfec7e473056ff9db724a14f432eedd60f7648cd`.
    - Real Executable Demonstrations: Replaced synthetic demo stubs with real executable scenarios: Demo A (Design from brief with disk mutations, Chromium render, and QA audit), Demo B (Improve flawed interface via bounded repair), and Demo C (Visual reference comparison with desktop/tablet/mobile screenshots and honest difference reporting).
    - Comprehensive Verification: 61/61 design tests passing in `packages/agent-core`, 11/11 runtime execution tests, 5/5 VS Code panel design tests, 11/11 Chromium visual/motion tests, all monorepo gates passing (`typecheck`, `lint`, `build`, `eval:runtime` 14/14, `eval:skills` 40/40, `eval:workflow` 14/14, `desktop:smoke` 14/14, `desktop:accept` 6/6).
  - Record: `docs/sprints/SPRINT_9C1_DESIGN_RUNTIME_EVIDENCE_CLOSURE.md`.

Sprint 9D — REA Reverse Engineering — Software Investigation, Evidence-Driven Reconstruction & Agent Specialization — SPRINT_9D_ACCEPTED
  - ADR-042 (`docs/adrs/ADR-042-rea-reverse-engineering.md`). Implemented a production-oriented Reverse Engineering Capability Pack and skill ecosystem built around the proven capabilities and methodology of the open-source Reverse Engineer Anything (REA) repository (version `6.8.0`, pinned commit `f95bdbce76fa538d9383a36c7dde0468078b42f4`):
    - Dual Capability Pack Architecture: Bifurcated into `rea-investigation-pack` (base mode: `REVIEW`) for read-only behavioral investigation, evidence collection, and specification synthesis; and `rea-reconstruction-pack` (base mode: `BUILD`) for governed clean-room code implementation, automated testing, and cryptographic obligation closure.
    - 4 Distinct Investigation Workflows: Deterministically routes targets into running web applications (URL-only black-box exploration with real Chromium via `BrowserSessionManager`), JavaScript / Electron applications (`analyze_javascript_application` and ASAR structure extraction via REA), native binaries (Mach-O, ELF, PE probing and external decompiler prerequisite diagnostics), or source repositories (standard repo tools first).
    - 8 Specialized Progressive Disclosure Built-in Skills: `rea-investigation-routing`, `browser-behavior-investigation`, `javascript-electron-analysis`, `native-artifact-analysis`, `feature-specification`, `evidence-reconciliation`, `reconstruction-planning`, and `reconstruction-verification` (all <850 tokens, passing `eval:skills`).
    - Real REA MCP Integration: Zero-phantom tool catalog (234 advertised tools) and 6 verified guided prompts (`investigate_feature`, `compare_application_versions`, `verify_reconstruction`, `audit_residual_unknowns`, `trace_crash`, `prepare_bounded_process_capture`) over stdio JSON-RPC with bounded timeouts and clean process management.
    - Epistemic Discipline & Obligation Ledgers: Categorizes all observations into `OBSERVED`, `INFERRED`, or `UNKNOWN`. Inferred hypotheses are never treated as facts. Reconstruction obligations transition deterministically from `characterized` to `verified` with test evidence snippets and SHA-256 closure digests.
    - 3 Real Executable Demonstrations: Demo A (URL-only black-box web app exploration, state transition capture, specification, and clean-room reconstruction with real Chromium), Demo B (Electron fixture static graph extraction and prompt guidance via real REA MCP), and Demo C (Version comparison, prompt guidance, obligation verification, and residual unknowns audit).
    - Known Design Debt Tracking: Formally documented 7 Sprint 9C.1 design limitations (DD-01 to DD-07) in `docs/KNOWN_DESIGN_DEBT.md`.
    - Comprehensive Monorepo Verification: 16/16 REA tests passing, 277/277 VS Code integration tests passing, all monorepo gates passing (`typecheck`, `lint`, `build`, `eval:runtime`, `eval:skills`, `eval:workflow`, `eval:progress`, `eval:learning`, `eval:performance`, `eval:recovery`, `desktop:smoke`, `desktop:accept`).
  - Record: `docs/sprints/SPRINT_9D_REA_REVERSE_ENGINEERING.md`.

Sprint 9D.1 — REA Production Integration, Governed Reconstruction & Evidence Integrity — SPRINT_9D1_ACCEPTED
  - ADR-042 Amendment (`docs/adrs/ADR-042-rea-reverse-engineering.md`). Closes all production, security, and verification defects identified in Sprint 9D review:
    - Authoritative Execution Pipeline (`GovernedReaWorkflow`): Integrated directly into `createAgentRuntime` and `AgentSessionBridge` without secondary agents or parallel loops. Preserves the strict pipeline: `ChatController -> Custom Mode & Capability Pack -> AgentSessionBridge -> AgentRuntime -> GovernedReaWorkflow -> PermissionGate -> Existing Tools & McpCatalog -> MutationEngine -> Verified Artifacts`.
    - Ungated Browser Interactions Eliminated: `InvestigationEngine` in `REVIEW` mode is strictly read-only (0 clicks, 0 fills). Interactive mode enforces `PermissionGate` risk classification and host confirmation via `IdeHost.requestConfirmation`. Destructive elements (`delete`, `remove`, `destroy`, `drop`, `reset`, `purge`) are automatically rejected.
    - Governed Filesystem Mutations: Removed direct `fs.mkdirSync` and `fs.writeFileSync`. All reconstruction writes route through canonical `MutationEngine.applyPreparedMutation()` subject to host approval. Adversarial checks verify path containment and rejection of `../../` traversals, absolute paths, and symlink escapes outside the workspace root.
    - Fabricated Verification Success Eliminated: When an independent test runner is absent, obligations remain strictly unverified (`verifiedObligationCount = 0`). A valid `ObligationVerificationRecord` must contain real fixture inputs, observed outputs, cryptographic digest, and pass/fail execution results. Fabricated "PASS" strings and SHA digests of unexecuted checks are eliminated.
    - Genuine Comparative Verification (`ComparativeWebVerifier`): Replaced superficial text-string checks with actual behavioral comparison between two isolated local applications (Reference App A vs Reconstructed App B). Deterministically compares routes, negative form validation, positive state changes, and sequential state transitions.
    - Shared McpCatalog Reuse: Refactored `ReaMcpService` to register directly with the authoritative `McpCatalog`. Eliminates duplicate background processes and shared process conflicts. Implemented category-based tool subsetting so models only receive tools appropriate for the target category.
    - Accurate Provenance & Portable Discovery: Replaced hardcoded Node paths and CLI counts with portable Node >= 22 discovery (`resolveNodeExecutable()`). Provider diagnostics (`Ghidra`, `Hopper`, `IDA`, `SQLite`) are probed dynamically and report truthful statuses (`ready`, `not_configured`, `unsupported`, `unknown`).
    - Real Acceptance Demonstrations & Governance Suite: All 3 end-to-end demonstrations (Demo A: Black-Box Web Reconstruction; Demo B: Electron/JS Static Investigation; Demo C: Version Comparison & Audit) and a 22-test REA Governance Closure test suite execute and pass with 100% fidelity.
    - Comprehensive Verification: 39/39 REA tests passing, 0 TypeScript errors, 0 linter warnings, all monorepo gates passing (`typecheck`, `lint`, `build`, `eval:runtime`, `eval:skills`, `eval:workflow`, `eval:progress`, `eval:learning`, `eval:recovery`, `desktop:smoke`, `desktop:accept`).
  - Record: `docs/sprints/SPRINT_9D1_REA_RUNTIME_EVIDENCE_CLOSURE.md`.

Sprint 10A.1 — Pre-HALO Production Readiness, Agent Execution Integrity & End-to-End Reliability — SPRINT_10A1_ACCEPTED
  - Audited, corrected, and validated existing architecture so specialized workflows (Advanced Design and REA Reconstruction) execute reliably, truthfully, and safely:
    - Single Authoritative Runtime: Preserved single AgentRuntime and execution pipeline.
    - Specialized Workflow Activation (DD-04): Resolved readinessStatus in ModeResolver; specialized modes fail closed with actionable diagnostics when open-vs-code.workflow.enabled is false. Added open-vs-code.enableWorkflow command.
    - Reconstruction Authorization & Confinement (DD-05): Defaulted mutation approval strictly to DENY when unapproved. Validated path containment and parent directory symlinks before directory creation. Automatic rollback of empty parent directories on mutation denial.
    - Truthful Visual QA & Telemetry (DD-03, DD-06, DD-07): Eliminated synthetic DOM/style fallbacks. Missing Chromium observations yield INSUFFICIENT_EVIDENCE with a blocker finding. Wired live stage telemetry.
    - Greenfield vs Incremental Mutations (DD-05): Implemented #prepareFileMutation inspecting existing workspace code; automatically prepares patches for existing files.
    - Real Model Reasoning in Design (DD-01, DD-02): Integrated provider.complete() into frontend composition (Stage C), motion engineering (Stage D), and iterative defect repair (Stage E).
    - Monorepo Verification & 5 User Journeys: 61/61 Design tests, 39/39 REA tests, 126/126 Modes/Tools tests, 33/33 Workflow tests, 149/149 Model tests, 14/14 Desktop Smoke tests, and 6/6 Real Desktop Acceptance tests pass 100%.
  - Record: `docs/sprints/SPRINT_10A1_PRE_HALO_PRODUCTION_READINESS.md`.

Sprint 10A.1B — Specialized Workflow Execution, Real Model Synthesis & Production Closure — SPRINT_10A1B_ACCEPTED
  - Corrective sprint closing audit findings after Sprint 10A.1:
    - P0 REA Reconstruction Authorization: Eliminated implicit authorization defaults in GovernedReaWorkflow. Reconstruction planning and file mutations strictly suspend for host-mediated confirmation (WAITING_FOR_CONFIRMATION) with cryptographic context binding and empty directory rollback on rejection.
    - P0 REA Model Synthesis: Connected GovernedReaWorkflow and ReconstructionEngine to active model provider. Prompt grounded in evidence-backed feature inventory, state transitions, visible business rules, form validations, and obligations. Verified distinct implementations on Form-Driven App A vs Tab-Nav App B.
    - P0 Design Honest Model Execution: Removed silent fallback from model errors to procedural templates; model failures fail closed as BLOCKED. Procedural fallbacks when provider is unconfigured are explicitly stamped with TEMPLATE_BASED_OUTPUT banners.
    - P1 Execution Telemetry Truthfulness: Replaced remaining static telemetry in GovernedReaWorkflow with live tracking (modelCalls = 0 when uncalled).
    - 10 Mandatory Negative Verification Tests: Passing 10/10 independent negative tests covering incorrect reconstructions, missing model, missing browser, missing REA binary, denied mutations, escaping paths, invalid outputs, stale approvals, cancelled workflows, and incomplete obligations.
    - Complete Monorepo Verification: 20/20 specialized closure tests, 934/934 agent-core tests, 0 typecheck errors, 0 lint warnings/errors across monorepo, all evals passing, and 14/14 desktop:smoke + 6/6 desktop:accept.
  - Record: `docs/sprints/SPRINT_10A1B_SPECIALIZED_EXECUTION_CLOSURE.md`.

Next:
1. Physical HALO hardware arrival & benchmark execution.
