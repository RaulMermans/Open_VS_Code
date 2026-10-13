# Architecture

## Component map

```text
IDE / UI
   |
IDE Adapter
   |
Agent Core
   |-- Context Engine
   |-- Context Compiler
   |-- Tool Runtime
   |-- Session State
   |-- Memory
   |-- Skills
   |
Model Gateway
   |
Local Model Providers
```

The dependency direction is fixed. `agent-core` must be runnable independently of VS Code. IDE APIs belong behind adapter interfaces, and model-specific behavior belongs behind the model gateway.

## Implemented agent core

`packages/agent-core` is the first executable implementation of the editor-independent core. It is a Node 22+ TypeScript package with no runtime dependencies and no imports from the imported Kilo packages.

```text
contracts
   |-- model capabilities and messages
   |-- context items and budgets
   |-- generic tools and permissions
   |-- agent tasks, modes, state, and events
   `-- editor adapter boundary

deterministic infrastructure
   |-- generic OpenAI-compatible HTTP provider
   |-- context ranking, deduplication, and fitting
   |-- canonical Markdown discovery and targeted reads
   |-- deterministic fallback chains (ModelRouter)
   |-- bounded project memory extraction (ProjectMemorySnapshot)
   |-- bounded cross-session memory (SessionSummaryStorage)
   |-- metadata-first Skills discovery and explicit loading
   |-- bounded read/list/search/find repository tools
   |-- Model Context Protocol (MCP) tool discovery and deterministic selection
   |-- native stdio JSON-RPC MCP client
   |-- mode-aware permission classification
   |-- immutable lifecycle transitions
   |-- minimal context compiler
   |-- strict tool registry and bounded observations
   |-- scripted provider for deterministic regression tests
   |-- safe mutation layer (apply_patch, create_file)
   |-- bounded verification layer (TEST, TYPECHECK, LINT, BUILD)
   |-- resumable AgentRunner with confirmation flow
   `-- resumable RepairOrchestrator with human-gated loops

mutation lifecycle
   |-- contracts (MutationRequest, PreparedMutation, MutationResult, MutationSnapshot)
   |-- write-path safety with symlink-escape detection
   |-- sensitive-path policy (.git, node_modules, .env, keys)
   |-- search/replace patch with ambiguity rejection
   |-- expected-base hash verification (stale-state detection)
   |-- deterministic unified diff generation
   |-- per-step mutation budgets (files, lines, bytes)
   |-- atomic writes (temp file + rename)
   |-- pre-mutation snapshots with rollback
   `-- bounded model-facing observations
```

The repository tool layer is read-only. The mutation layer provides `apply_patch` and `create_file` operations behind strict validation, permission gates (CONFIRM in BUILD/DEBUG, DENY in ASK/PLAN/REVIEW), and atomic write boundaries. Both layers use realpath-based containment as authoritative for filesystem access. No terminal, Git, delete, or real model-runtime capability exists in this package.

## Deterministic agent loop

`AgentRunner` composes existing boundaries without implementing their concerns:

```text
task -> compile bounded context -> model
     -> validate tool call -> permission policy
     -> execute registered tool -> bound observation
     -> recompile context -> model -> final answer

mutation flow (apply_patch / create_file):
     -> validate path safety + policy + budget
     -> read current state + verify expected base hash
     -> prepare mutation + generate diff
     -> permission gate (CONFIRM) -> PAUSE FOR APPROVAL
     -> apply atomically (temp + rename)
     -> verify result hash -> record snapshot -> return bounded observation
     -> rollback available if file unchanged since mutation

verification flow (run_verification):
     -> narrow discovery of scripts (TEST, TYPECHECK, LINT, BUILD)
     -> prepare verification -> hash package.json to prevent arbitrary execution
     -> permission gate (CONFIRM) -> PAUSE FOR APPROVAL
     -> execute securely with CWD containment, timeout, single-use identity
     -> bound STDOUT/STDERR output -> return bounded observation

repair flow:
     -> evaluate verification result -> classify failure
     -> map failure to targeted prompt
     -> create repair runner with turn/mutation budgets
     -> propose mutation -> PAUSE FOR MUTATION APPROVAL
     -> propose verification -> PAUSE FOR VERIFICATION APPROVAL
     -> evaluate repair state -> terminate if budgets exceeded or loop detected
```

The registry separates model-visible definitions from executors and strictly validates untrusted arguments before permission evaluation or execution. `ALLOW` executes, `DENY` produces a structured observation without execution, and `CONFIRM` returns a paused result that can resume with explicit approval or rejection. Tool failures are recoverable observations; model failures, required-context overflow, cancellation, maximum turns, and deterministic non-progress guards are distinct terminal outcomes.

Every lifecycle transition passes through the authoritative state reducer and event stream. Results expose compact status, turn, context, tool-call, confirmation, and event diagnostics rather than an unbounded internal transcript. Recent observations are deduplicated and capped before the context compiler fits them as optional context; project instructions and the task remain required. Legacy ADR-014 skills (flag off) remain required context; Portable Skills Runtime guidance (ADR-029, flag on) is optional context ranked after active code, so it can be omitted but never displaces required items.

## Development machine policy

This repository is developed on a machine that is **not the final inference target**. Model weights (GGUF, Safetensors, CKPT) must never be committed or downloaded to this machine. The `ollama` runtime may remain installed for tooling, but no models should be pulled. Historical benchmark results and model cards remain as small evidence artifacts. Real-model validation is deferred to the target inference machine.

## Cross-cutting constraints

- Project knowledge and decisions live primarily in Markdown.
- Repository context is progressively disclosed under an explicit token budget.
- Provider adapters may target local backends without changing agent-core contracts; only a generic OpenAI-compatible HTTP adapter exists today.
- The scripted provider is the orchestration regression oracle; it is not a model runtime.
- Product code begins only after upstream reuse evidence supports the baseline choice.

See `docs/adrs/` for the provisional decisions and their revisit triggers.

## Deferred imported baseline

The audited Kilo baseline remains in repository history for provenance and possible future reuse, but Kilo integration is explicitly postponed. Its registry boundaries informed Sprint 1D at a `REFERENCE_ONLY` level; no Kilo, Effect, plugin, MCP, shell, network, or host code was copied into `agent-core`.

## CLI Architecture

```text
                    CLI
                     │
      ┌──────────────┼──────────────┐
      │              │              │
 ASK / PLAN       BUILD          DEBUG
 / REVIEW           │              │
      │              │              │
 AgentRunner     AgentRunner   RepairOrchestrator
      │              │              │
      └──────────────┴──────┬───────┘
                            │
                   ReviewableExecution
                    ├──────────────┐
                    │              │
              MutationEngine  VerificationEngine
                    │              │
              HUMAN APPROVAL  HUMAN APPROVAL
```


## Model Routing
Uses a `models.json` config and a deterministic `ModelRouter` wrapped by a `RoutedModelGateway` in production. Routing is based dynamically on `AgentMode` with no LLM dependency in the routing decision.

## Controlled Terminal UX & Review Boundary (Sprint 3D / 3D.1 / 3D.2 / 3D.3 ✅ CLOSED PERMANENTLY)

```text
 VerificationEngine (SOLE Execution Authority)
   │  spawn(executable, args, { shell: false, detached: true })
   │  onOutput(chunk) ──────────────────────────────────────────┐
   │  StringDecoder(utf-8) — chunk boundary safe               │
   ▼                                                            │
 AgentRunner                                                    │
   │  verification.started (executionId)                        │
   │  verification.output event (executionId) ◄─────────────────┘
   │  verification.completed (executionId)
   ▼
 ChatController
   │  handleAgentEvent(exact executionId routing) → appendOutput
   │  requestConfirmation — fail-closed validation (no fallbacks)
   ▼
 TerminalReviewController (Bounded Prefix Buffer, Registry)
   │  maxOutputBytes: 16 KB / stream (prefix, not ring)
   │  maxReviews: 50, maxTotalRetainedBytes: 1 MB
   │  Evicts oldest completed entries; never evicts active
   │  Enforces executionId: string (zero fallback generation)
   ▼
 IDE Webview (Presentation Only — textContent, XSS-immune)
   │ (terminal.respond / cancel / toggle / copy)
```

- **Execution Authority**: Subprocess spawning remains strictly in `VerificationEngine`. The IDE host, `ChatController`, `TerminalReviewController`, and Webview have zero spawn authority.
- **Safety Invariant**: Strictly `shell: false`. No arbitrary command execution, no command chaining, no `bash -c` evaluation.
- **Human Approval**: Mandatory explicit confirmation gate (`CONFIRM`). No auto-approval. Fail-closed: malformed prepared commands (including missing or empty `verificationId`) resolve immediately to `REJECT` with no fallback substitution.
- **Live Output Streaming**: `VerificationEngine` delivers stdout/stderr chunks via `onOutput` callback; `AgentRunner` emits `verification.output` events with explicit `executionId`; `ChatController` routes them strictly by exact ID into `TerminalReviewController.appendOutput`. Webview renders with `textContent` (XSS-immune).
- **Bounded Prefix Buffer**: Each stream retains the first 16 KB (configurable). `truncateUtf8Buffer` prevents split multi-byte sequences at limits. `stdoutTruncated` / `stderrTruncated` flags signal overflow. This is a **prefix** buffer, not a ring buffer.
- **7 Active Lifecycle States**: `WAITING_APPROVAL`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `REJECTED`. The dead `PREPARED` state has been removed.
- **Bounded Registry**: `TerminalReviewController` enforces `maxReviews` and `maxTotalRetainedBytes` limits by evicting the oldest completed entry when either limit is exceeded.
- **Deterministic Process Tree Cleanup**: Cancellation and timeout both kill parent and all descendants via `process.kill(-child.pid, ...)` on POSIX. Proof by real E2E scenarios 53–55.
- **Canonical Execution Identity (Sprint 3D.2 & 3D.3)**: `PreparedVerification.verificationId` is passed directly as `executionId` across all stages (`confirmation` → `TerminalReview` → `verification.started` → `verification.output` → `verification.completed` → `terminal.updated`). Output and lifecycle events route strictly by execution identity with zero fallback to `activeTerminal`.
- **Exact Lifecycle Event Routing & Review Isolation (Sprint 3D.3)**:
  - `verification.started`, `verification.output`, `verification.completed`, `verification.failed`, and `verification.rejected` route strictly by `payload.executionId`.
  - `TerminalReviewController.registerPreparedCommand` requires explicit, non-empty `executionId` (no silent ID generation).
  - Multi-review isolation: events for Review A never mutate Review B. Mismatched or forged IDs are safe no-ops.
  - Active review protection: `state.activeTerminal` is only synchronized when its `executionId` matches the incoming event. Background review output does not trigger `terminal.updated` broadcasts for the active review.
  - Turn & deactivation safety: stale completion events after a new chat turn do not resurrect `activeTerminal`; late events after extension deactivation are safe no-ops.
- **Extension Deactivation Closure (Sprint 3D.2)**: Extension `deactivate()` triggers `chatController.cancelTurn()`, cleanly propagating the `AbortSignal` to kill the subprocess tree, clearing the terminal review registry to 0 entries, and preventing post-deactivation events or resurrection.
- **Zero Model Calls**: Presentation actions (expand, toggle, copy, cancel, reject) trigger zero LLM calls.

### Editor-Native Autocomplete Architecture (Sprint 3E & 3E.1 ✅ PERMANENTLY CLOSED)

```text
VS Code Native Inline Completion API (registerInlineCompletionItemProvider)
  │  - Activated on onStartupFinished in production extension
  │  - Registered unconditionally for all documents ("*")
  │  - Contributes toggle command (open-vs-code.toggleAutocomplete)
  │
  ▼
AutocompleteController (packages/vscode-integration)
  │  - Captures live unsaved editor buffer (snapshot)
  │  - Maps VS Code CancellationToken to AbortSignal
  │  - Evaluates live editor state supplier (URI, version, line, character)
  │  - Returns native vscode.InlineCompletionItem
  │  - Attaches single-use acceptance telemetry command (open-vs-code.autocompleteAccepted)
  │  - Full disposal cleanup on extension deactivation
  ▼
AutocompleteService (packages/agent-core)
  │  - Injectable debounce scheduler (100ms default)
  │  - Request superseding (typing cancels pending debounce)
  │  - In-flight cancellation (propagates AbortSignal to provider)
  │  - Deterministic in-flight request deduplication via editor context hash (shares promise)
  │  - Live editor stale-result guards (document URI, version, cursor line/char, supersession)
  │  - Single-use acceptance registry (consumed upon first accept)
  │  - Output sanitization (code fences, prefix echo, suffix overlap, output cap)
  │  - Session-bounded local telemetry (zero source text)
  ▼
AutocompleteContextBuilder (packages/agent-core)
  │  - Editor-local context only (zero ProjectMemory / RAG / Markdown brain reads)
  │  - Bounded prefix (~2,000 tokens / 8,000 chars, nearest-to-cursor preserved)
  │  - Bounded suffix (~1,000 tokens / 4,000 chars, earliest preserved)
  │  - Total ceiling: 3,500 tokens / 14,000 chars; max output: 256 tokens / 1,024 chars
  │  - Sensitive file protection (.env, *.pem, *.key skipped without model invocation)
  │  - Strict UTF-16 surrogate-pair boundary safety (no orphaned surrogates)
  ▼
AutocompleteGateway (packages/agent-core)
  │  - Separate from RoutedModelGateway / AgentRunner
  │  - Safe zero-deployment production factory (createProductionAutocompleteGateway)
  │  - Uses ModelRouter with taskClass: "autocomplete" and requiredCapabilities: ["autocomplete"]
  │  - Quiet empty completion on RouteUnavailableError (zero error popups / crashes)
  ▼
ModelRouter (Deterministic capability-based candidate selection)
  │  - Rejects chat-only deployments lacking "autocomplete" capability
  │  - Zero cloud fallback; quiet empty completion on NO_COMPATIBLE_ROUTE
  ▼
AutocompleteProvider (packages/agent-core)
  │  - Local FIM-capable model provider (ScriptedAutocompleteProvider in tests)
  │  - Provider-specific FIM token formatting isolated inside provider adapter
```

- **Architectural Isolation**: Autocomplete has **zero** dependency on `AgentRunner`, `ToolRuntime`, `MutationEngine`, `VerificationEngine`, `MCP`, or `ProjectMemory`.
- **Insertion Authority**: The user's editor acceptance action is the sole insertion authority; suggestions are rendered exclusively via native VS Code ghost text.
- **Zero Cloud Fallback**: If no compatible local route exists, autocomplete yields an empty result silently without user-facing errors or cloud requests.
- **Stale-Result Resilience**: Independent live editor guards verify document URI, document version, cursor line, and cursor character before displaying suggestions.
- **Deduplication**: Identical editor contexts during debounce or in-flight inference share execution, bounding provider calls to exactly 1.

---

## Security Boundary View (Sprint 4A ✅ CLOSED)

All untrusted inputs flow through a validation/policy layer before reaching canonical authority owners.
**UI and future Runtime Evals have no direct write, process, or permission authority.**

```text
UNTRUSTED INPUTS
  │  model responses • MCP results • workspace files • webview messages
  │  provider HTTP payloads • persisted state • environment values
  │  relative paths from tools/models • filenames • URIs
  │
  ▼
VALIDATION / POLICY LAYER
  │  parseWebviewMessage   — runtime validation + prototype-pollution guard
  │  classifyPermission    — HARD_DENIES non-overridable; mode-aware policy
  │  resolveRepositoryPath — realpath-based symlink + traversal containment
  │  resolveWritePath      — realpath parent check for non-existent targets
  │  normalizeWireResponse — provider response schema validation
  │  redactSecrets         — session persistence secret scrubbing
  │  MCP schema bounds     — 64 KB size limit; 16-level depth limit
  │  confirmation ID check — length limits; single-use consumed-set
  │
  ├─ reads   → read-only tools   (path-contained via resolveRepositoryPath)
  │
  ├─ writes  → MutationEngine    (consumed-set + base-hash TOCTOU + realpath)
  │
  ├─ process → VerificationEngine (consumed-set + shell:false + cwd-contained
  │                                + minimal env + killProcessTree on exit)
  │
  ├─ MCP    → McpCatalog +        (namespaced canonical names; schema bounds;
  │           createMcpTool        result 50 KB cap; text evidence only;
  │           Registration         shell:false; minimal env; process cleanup)
  │
  └─ model  → provider adapters   (OpenAI-compatible / Halo / scripted;
                                   validated responses; no cloud fallback;
                                   credential not logged)

UI (WebviewViewProvider / ChatViewProvider):
  → PRESENTATION AND INPUT ONLY
  → No direct write, process, MCP, or permission authority
  → All inbound messages through parseWebviewMessage

RuntimeEvalEngine (Sprint 4B ✅ CLOSED):
  → ADVISORY / RECOMMENDATION ONLY
  → Recommends: CONTINUE | REVISE | REPLAN | VERIFY |
               CHANGE_MODEL | REQUEST_MORE_CONTEXT | STOP | ASK_HUMAN
  → MUST NOT directly: approve mutations, approve executions,
                        change permissions, invoke MCP, write files,
                        disable security rules
```

### Authority Summary

| Domain | Canonical Owner | Non-Owners |
|---|---|---|
| Read authority | `read-only-registry.ts` tools | All other components |
| Write authority | `MutationEngine` | UI, model, MCP, runtime evals |
| Process authority | `VerificationEngine` | UI, model, MCP, runtime evals |
| Approval authority | `permissions.ts` + `ChatController` | Model, MCP, runtime evals |
| MCP execution | `McpCatalog` + `createMcpToolRegistration` | Model, UI, runtime evals |
| Model routing | `ModelRouter` / `RoutedModelGateway` | All other components |
| UI | Presentation + validated input only | — |
| Runtime evals | Advisory recommendations only | Cannot own any authority domain |

See [ADR-023](docs/adrs/ADR-023-system-security-boundaries.md) for full decision rationale.
See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for the operational security overview.

---

## Runtime Evaluation & Adaptive Control Architecture (Sprint 4B ✅ CLOSED)

```text
Agent Execution Cycle: ACT -> OBSERVE -> EVALUATE -> DECIDE -> ADAPT -> ACT AGAIN

+-------------------------------------------------------------------------------+
| AgentRunner Loop (packages/agent-core)                                        |
|  - Checkpoints: MUTATION_RESULT, TOOL_FAILURE, BEFORE_COMPLETION,             |
|                 VERIFICATION_RESULT                                           |
|  - Aggregates runtime evidence via RuntimeEvidenceCollector                   |
+-------------------------------------------------------------------------------+
                                      │
                                      ▼
+-------------------------------------------------------------------------------+
| RuntimeEvidenceCollector                                                      |
|  - Bounded action, tool, mutation, verification, route, security records      |
|  - Redacts sensitive secrets (API keys, tokens, private keys)                 |
|  - Tracks unresolved defects and failure hashes                               |
+-------------------------------------------------------------------------------+
                                      │
                                      ▼
+-------------------------------------------------------------------------------+
| RuntimeEvalEngine (Tiered Multi-Level Evaluation)                             |
|  ├─ Level 0 (L0): Deterministic Rule-Based Evaluator (< 1ms, zero token cost)  |
|  ├─ Level 1 (L1): Heuristic Trajectory & Cycle Evaluator (Action loop penalty) |
|  └─ Level 2 (L2): Selective Critic Escalation (Timed race, fallback to L1)     |
+-------------------------------------------------------------------------------+
                                      │
                                      ▼
+-------------------------------------------------------------------------------+
| AdaptiveControlPolicy                                                         |
|  - Maps eval scores, signals, and evidence to AdaptiveDirective:             |
|    • CONTINUE             → Normal execution                                  |
|    • SCHEDULE_VERIFICATION→ Mandatory verification before completion/mutation |
|    • INJECT_REVISION      → Targeted corrective revision observation          |
|    • TRIGGER_REPLAN       → Replan strategy observation                       |
|    • TERMINATE_RUN        → Clean exit with NON_PROGRESS                      |
|    • PAUSE_HUMAN          → Pause for user confirmation (ask_human)           |
|    • RECOMMEND_MODEL /    → Narrow 1-turn ModelRouteHint for ModelRouter      |
|      CHANGE_MODEL                                                             |
|    • REQUEST_MORE_CONTEXT → Context inquiry, explicit re-eval, 2-turn loop cap|
+-------------------------------------------------------------------------------+
                                      │
                                      ▼
+-------------------------------------------------------------------------------+
| RuntimeEvalLedger & Analytics                                                 |
|  - Immutable in-memory audit log of all evaluations, directives, outcomes     |
|  - Universal post-verification causality & intervention outcome linking       |
|    (RESOLVED, IMPROVED, UNCHANGED, DEGRADED)                                  |
|  - Multi-layer tracking: recommended, applied, and outcome metrics            |
|  - Generates developer summaries and repair success metrics                   |
+-------------------------------------------------------------------------------+
```

- **Non-Authoritative Invariant**: Evaluations only recommend directives; mutations, commands, and security decisions remain gated by `MutationEngine`, `VerificationEngine`, and `classifyPermission`.
- **Universal Post-Verification Causality**: All paths scheduling verification dispatch verifications, evaluate at `VERIFICATION_RESULT`, link outcomes in the ledger, and dispatch corrective directives.
- **Bounded Adaptations**: Model route hints are bounded to a 1-turn lifetime; context requests are bounded to `MAX_CONSECUTIVE_CONTEXT_REQUESTS = 2`.
- **111 Deterministic Scenarios**: Verified by `npm run eval:runtime` across 2 consecutive runs with strict comparator assertion tests.
- **Full Backward Compatibility**: Scripted benchmarks operate cleanly with `adaptiveInterventions: false` without losing evaluation metrics.
See [ADR-024](docs/adrs/ADR-024-runtime-evals-adaptive-control.md) for full architectural specification.

## Durable Checkpoints, Recovery & Safe Rollback (Sprint 4C)

Sprint 4C adds durable write-ahead journaling, atomic checkpointing, and deterministic recovery to survive abrupt process crashes, application restarts, and workspace divergence without duplicate writes or bypassed security.

```text
+-------------------------------------------------------------------------------+
| CheckpointCoordinator                                                         |
|  - Central orchestrator initialized per agent runner                          |
|  - Captures semantic checkpoints at state transitions                         |
|  - Write-ahead prepares operations before filesystem or external calls        |
+-------------------------------------------------------------------------------+
       │                       │                       │
       ▼                       ▼                       ▼
+---------------+       +---------------+       +-------------------------------+
| Checkpoint    |       | Operation     |       | RecoveryArtifactStore         |
| Store         |       | Journal       |       |  - Preimage storage           |
|  - Atomic     |       |  - Append-only|       |  - 8 MiB single file limit    |
|    .tmp+rename|       |    JSONL      |       |  - 64 MiB run limit           |
|  - SHA-256    |       |  - Idempotency|       |  - Zero leak to analytics/ctx |
|    checksum   |       |    keys       |       +-------------------------------+
|  - Retention  |       |  - Status     |                       ▲
|    pruning    |       |    updates    |                       │
+---------------+       +---------------+                       │
       │                       │                                │
       └───────────────────────┼────────────────────────────────┘
                               ▼
+-------------------------------------------------------------------------------+
| RecoveryController                                                            |
|  - Non-authoritative planning and inspection component                        |
|  - Reconciles journal operations against observed filesystem SHA-256 hashes   |
|  - Generates truthful RecoveryPlan (RESUME, REVERIFY, RECONFIRM, ASK_HUMAN,   |
|    STOP)                                                                      |
|  - Evaluates rollback candidates and delegates reverse mutations through      |
|    MutationEngine                                                             |
+-------------------------------------------------------------------------------+
```

### Rollback Durability Lifecycle (Sprint 4C.4)

```text
Rollback request
   ↓
Durability dependencies available?
   ├ NO → FAIL CLOSED
   ↓ YES
Read operation history
   ├ FAIL → FAIL CLOSED
   ↓
PREPARED
   ↓
STARTED
   ↓
MutationEngine (reverse write)
   ↓
COMPLETED
   ↓
ROLLBACK_COMPLETED checkpoint
   ↓
DURABLE SUCCESS

If failure after MutationEngine:
RECOVERY REQUIRED
→ NO REPLAY
→ reconcile on restart.
```

- **Observed State Dictates Recovery**: Mutation reconciliation directly inspects disk files against precondition and expected postcondition SHA-256 hashes (`RECONCILED_APPLIED` with write replay count = 0, `RECONCILED_NOT_APPLIED`, or `AMBIGUOUS`). Interrupted verifications are never assumed to have passed (`INTERRUPTED` yielding `REVERIFY`). Completed verifications survive restart without being misclassified.
- **Fail-Closed Durability Gates**: Pre-mutation, pre-verification, and pre-rollback journal/checkpoint persistence errors immediately halt execution before side-effects with `INTERNAL_ERROR` (`DURABILITY_UNAVAILABLE`). `resumeFromRecovery()` fails closed on `RECOVERY_RECONCILED` checkpoint persistence failure (`RECOVERY_PERSISTENCE_FAILED`). If `recordFailed()` persistence fails after an operation is `STARTED`, execution fails closed immediately and the journal remains conservatively `STARTED`. Post-mutation or post-rollback completion checkpoint failures fail closed (`RECOVERY_REQUIRED`, 0 duplicate writes).
- **First-Class Write-Ahead Rollback Journaling**: Rollback operations are first-class journal entries (`ROLLBACK_MUTATION`) with authority `"mutation-engine"`. Rollback adheres strictly to the 6-phase write-ahead lifecycle (`Dependencies -> History -> PREPARED -> STARTED -> MutationEngine -> COMPLETED -> Checkpoint`), suppresses duplicate reverse writes with 0 calls when disk is already restored, and fails with `DIVERGED` if disk state changed.
- **Repair Runner Propagation**: `RepairOrchestrator` propagates `CheckpointCoordinator` to all sub-runners, guaranteeing full operation journaling for automated repairs.
- **Separation of Authorities**: `RecoveryController` and `RollbackManager` are strictly non-authoritative for disk mutations; they never perform direct workspace filesystem writes. Rollbacks route exclusively through `MutationEngine`, and verifications route through `VerificationEngine`.
- **Process Epoch Protection**: Every process invocation instantiates a unique `processEpochId`. Stale approvals from prior epochs are invalidated across process restarts (`NEW_EPOCH_AUTHORITY_REQUIRED`), preventing unauthorized execution.
- **Fail-Closed Path Safety**: All storage operations are checked against `assertSafeStoragePath` ensuring strict workspace containment and symlink escape rejection.
- **Two-Run Determinism & Process-Boundary Crashes**: 117 scenarios across 21 categories verified by `npm run eval:recovery` with deep equality, 18 negative comparator tests, and real process-boundary crash tests (`T-4840`, `T-4841`, `T-5114`-`T-5117`, `T-5200`-`T-5222`).
See [ADR-025](docs/adrs/ADR-025-checkpoints-recovery.md) for full architectural specification.

## Large-Repository Performance Architecture (Sprint 4D, 4D.1 & 4D.2 ✅ CLOSED PERMANENTLY)

```text
Workspace (25,000+ files)
   ↓
Incremental Discovery (RepositoryDiscovery + AsyncSemaphore + ignore policy + zero content reads)
   ↓
Bounded Repository Index (lightweight metadata: path, size, mtime, binary/large flags)
   ↓
Targeted Search (RepositorySearch: bounded worker pool, peakActive <= maxConcurrency, peakQueued <= maxQueued, searchCoalesced)
   ↓
Streaming Line Reads (readRepositoryFile: chunk-by-chunk line scanner, 8KB binary check, UTF-8 byte ceiling via truncateUtf8ToBytes, no whole-file read)
   ↓
Bounded Context Compiler (fitContext: task-dependent tokens, independent of repo scale)
   ↓
Agent Runtime (AsyncSemaphore with maxQueued and cancel_oldest / reject_new, AbortSignal cancellation)
   ↓
Runtime Eval (continuous evaluation with repetitive failure compaction preserving all 8 decisions, large-read output bounding)
   ↓
Bounded Durable Recovery (OperationJournal FileHandle.sync() append + fail-closed read integrity + CheckpointStore with rebuildable in-memory indexes)
```

- **Incremental Discovery & Zero-Content Byte Indexing**: `RepositoryDiscovery` discovers files without reading contents during discovery (strictly verified across 25,000+ files: `contentBytesRead = 0`, 58 directories visited). Canonical ignores (`.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.cache`, `.checkpoints`) skip generated trees. Directory entries and discovered files are canonically sorted lexicographically, ensuring deterministic discovery ordering. Single file additions, modifications, or deletions update metadata incrementally without full repository rebuilds, and `processEventStorm` coalesces rapid bursts.
- **Production Bounded Concurrency & Targeted Search**: `RepositorySearch` operates via a bounded worker pool feeding tasks through `AsyncSemaphore`, strictly capping `peakActive <= maxConcurrency` and `peakQueued <= maxQueued`. Matches are committed in candidate index order for deterministic results. Caps total matches, restricts matches per individual file (diversity cap), bounds snippet lengths, and enforces a payload ceiling (default 32 KB), while automatically bypassing binary and giant files from broad scans. Identical queries are deduplicated via `searchCoalesced()`, and rapid query storms are handled via `SearchCoordinator.searchLatest()`.
- **Bounded Streaming File Reads & UTF-8 Byte Safety**: `readRepositoryFile` uses a chunk-streaming line reader (`open("r")`, `StringDecoder("utf8")`, chunk-by-chunk line scanner) with 8KB null-byte binary detection, UTF-8 byte ceilings via `truncateUtf8ToBytes`, CRLF stripping, and immediate EOF upon reaching `endLine` or byte ceiling, completely eliminating whole-file buffer allocations and proving `bytesReadFromFile << totalFileBytes` (e.g. reading 65,536 bytes from an actual 5,000,000-byte fixture) without isolated surrogates or replacement characters (`\uFFFD`). Exposes truthful IO telemetry: `fileSizeBytes`, `bytesReadFromFile`, `chunksRead`, `returnedBytes`, `wholeFileBuffered: false`, `truncated`.
- **Bounded Concurrency & Waiting Queue (`AsyncSemaphore`)**: Bounds concurrent executions to `maxConcurrency` and waiting queue to `maxQueued`. Supports `reject_new` (throws `SemaphoreQueueFullError`) and `cancel_oldest` overflow policies, with clean `AbortSignal` queued cancellation that never consumes running slots or leaks listeners.
- **Context Token Ceiling**: `compileContext` and `fitContext` ensure prompt context tokens depend strictly on the task instructions and retrieved items, not repository file counts.
- **Bounded LRU Cache**: `BoundedLruCache` bounds cached content by both entry count and retained bytes with deterministic LRU eviction and key invalidation upon file modification.
- **Runtime Eval Compaction & Output Bounding**: `RuntimeEvidenceCollector` compacts repeated identical failures into structured summary records with counts and bounded error signatures, and bounds large tool outputs (such as 5MB reads) to <= 400 characters, maintaining continuous adaptive-control accuracy across all 8 decisions (`CONTINUE`, `VERIFY`, `REVISE`, `REPLAN`, `STOP`, `ASK_HUMAN`, `REQUEST_MORE_CONTEXT`, `CHANGE_MODEL`) without accumulating unbounded raw evidence.
- **Physical Sync Durability & Fail-Closed Read Integrity**: `OperationJournal` writes entries using `FileHandle.appendFile()` followed by `FileHandle.sync()`, with fail-closed rollback truncation on sync failure. Reads enforce fail-closed integrity: absent journals map to empty history (`[]`), while unreadable journals (`EACCES`, `EIO`) and malformed lines throw `JOURNAL_CORRUPT` and fail closed. Schema validation strictly rejects invalid records. Secondary in-memory lookup caches (`#indexCache`, `#metadataIndex`) are strictly non-authoritative and safely rebuildable; corrupt disk records can never be rescued by an index.
- **Bounded Presentation Limits**: Diff generation and terminal review streams adhere strictly to byte ceilings (16 KB buffer with clean UTF-8 truncation boundaries), preventing unbounded memory retention.
- **Concurrency & Cancellation**: Operations throttle fan-out with `AsyncSemaphore` and halt cleanly upon `AbortSignal` triggering without orphaned background workers.
See [ADR-026](docs/adrs/ADR-026-large-repository-performance.md) for full architectural specification.

## Real OSS Models, Production FIM & Evidence-Driven Routing (Sprint 4E ✅ CLOSED PERMANENTLY)

```text
USER TASK / EDITOR CURSOR
   ↓
ModelRouter (security, context-fit, capability filtering: chat, tools, fim, autocomplete)
   ↓
Bounded Adaptive Score Adjustment (ModelPerformanceLedger: rolling EMA latencies, success rates, hysteresis threshold, min samples)
   ↓
Selected Local Model Deployment (OpenAI-compatible local endpoint or LocalFimProvider)
   ↓
Local Self-Hosted Inference Runtime (Ollama / vLLM / llama.cpp server; gated by OPEN_VS_CODE_REAL_INFERENCE=1)
   ↓
Agent Runtime / Autocomplete Service (ghost text display, accept / reject, tool calls, verifications)
   ↓
Runtime Eval Feedback (continuous runtime eval checkpoints + autocomplete lifecycle outcomes)
   ↓
ModelPerformanceLedger Persistence (.open-vs-code/model-performance.json, bounded, metrics-only, zero source code)
   ↓
Future Routing Improves (evidence-driven priority adjustments, bounded ±maxAdjustment, anti-flapping hysteresis)
```

- **Inference Host Authorization Gate (`InferenceGate`)**: Real local inference is strictly gated behind `OPEN_VS_CODE_REAL_INFERENCE=1`. The application never infers authorization from local processes or GPU availability, never auto-downloads weights (`*.gguf`, `*.safetensors` protected in `.gitignore`), and cleanly yields `BLOCKED_WITH_EVIDENCE` when the designated inference host is unavailable.
- **Production FIM Provider (`LocalFimProvider`)**: Speaks `POST /v1/completions` directly to self-hosted models with provider-isolated token formatting strategies (`qwen`, `starcoder`, `deepseek`, `prefix-suffix-middle`, `raw-prefix`). Strips model-specific stop tokens, enforces `maxOutputTokens`, propagates `AbortSignal`, and isolates all FIM token syntax inside the adapter.
- **Single Authority & Bounded Model Performance Ledger (`ModelPerformanceLedger`)**: `AgentRunner` is the single authoritative recorder of agent model outcomes on terminal states (`COMPLETED`, `FAILED`, `CANCELLED`; never on `PAUSED`). Tracks per-deployment, per-task-class metrics (`sampleCount`, `successCount`, `failureCount`, `verificationSuccessCount`, `toolCallSuccessCount`, `totalRepairCycles`, `timeoutCount`, `cancellationCount`, `emaLatencyMs`, and autocomplete shown/accepted/cancelled/empty/stale counts). Never stores source code, completions, prompts, or secrets. Bounded by `maxProfiles` with serialized per-path async queuing (`persistQueuesByPath`), in-memory delta merging (`#deltas`), atomic temp-file rename, schema versioning (v2 reset), and single initialization ownership (`.ready`).
- **Truthful Evidence Semantics (Sprint 4E.4)**: `AgentRunner.#result()` strictly distinguishes `runtimeCompleted` (normal terminal exit) from `qualitySuccess = runtimeCompleted && verificationSuccess && toolCallSuccess`, ensuring failed verifications and broken tool calls cannot be recorded as successes.
- **Evidence-Driven Adaptive Routing**: `ModelRouter` integrates with `ModelPerformanceLedger` to apply bounded routing adjustments (`±maxAdjustment`) using a deterministic formula (`qualityScore = 0.50 * successRate + 0.30 * verificationRate + 0.20 * toolRate - repairPenalty - timeoutPenalty`) with hysteresis (`hysteresisThreshold`) and a sample floor (`minimumSamples`). Reverts strictly to static configured priority when disabled (e.g. during real-model benchmark runs) or below threshold.
- **Durable Shutdown & Env-Only Credentials**: Autocomplete disposal (`AutocompleteService.dispose()`, `AutocompleteController.dispose()`, and `extension.deactivate()`) is asynchronous and awaited, ensuring pending suggestions and debounce writes reach disk before process termination. Credential security is env-only (`apiKeyEnv`), eliminating plaintext `apiKey` from contracts and configurations.
- **Two Separate Evaluation Paths**: Deterministic CI integration suite (`runModelIntegrationEvaluation()`, 64 scenarios, no models required, part of `npm test`) vs. real local model benchmarking (`runRealModelBenchmark()`, gated, invoked exclusively via `npm run eval:models`).
See [ADR-027](docs/adrs/ADR-027-real-local-models-and-adaptive-routing.md) for full architectural specification.

## Desktop Shell Distribution & Packaging Layer (Sprint 4F ✅ COMPLETE)

```text
┌─────────────────────────────────────────────────────────────┐
│       Open VS Code Desktop Application (apps/desktop)       │
│  - Branded standalone distribution (pinned VSCodium shell)   │
│  - Bundled extension auto-activation                         │
│  - Strict privacy defaults (telemetry permanently disabled) │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│      VS Code Integration (packages/vscode-integration)      │
│  - Chat Webview & Diff Review Controllers                   │
│  - Inline Autocomplete (registerInlineCompletionItemProvider)│
│  - Controlled Terminal Execution (VerificationEngine)       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              IDE Adapter (packages/ide-adapter)             │
│  - VS Code API bridge to agent-core                         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 packages/agent-core                         │
│  - Context Engine, Token Budgeting, Permission Gate         │
│  - Model Router, Mutation Engine, Verification Engine       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│         Self-Hosted Inference Host (Local or External)      │
│   - Local: Ollama / llama.cpp / vLLM (e.g. qwen2.5-coder)   │
│   - Target Inference Host: HALO                             │
│   * NOTE: No model weights are bundled in the desktop app   │
└─────────────────────────────────────────────────────────────┘
```

- **Extension-First Invariant**: The desktop shell is an unmodified, pinned distribution of upstream VSCodium (`1.135.06055`, VS Code `1.135.0`). No agent reasoning, prompt formatting, context compiling, model routing, or benchmark logic resides inside the editor source tree. All AI functionality is bundled as a standard extension (`@open-vs-code/vscode-integration`) located in `Contents/Resources/app/extensions/open-vs-code`.
- **Deterministic Packaging Workspace (`apps/desktop`)**:
  - `upstream.json`: Pinning distribution (`vscodium`), version (`1.135.06055`), commit (`5a73682ca091082675b10c9dc3f348c1d824d94f`), and expected SHA-256 archive checksum.
  - `branding/product.json`: Configures identity as "Open VS Code", bundle ID `com.openvscode.desktop`, isolates user configuration to `.open-vs-code-desktop`, and permanently disables telemetry (`enableTelemetry: false`).
  - `scripts/prepare.ts`: Deterministic archive fetch, SHA-256 checksum verification, caching in `apps/desktop/cache`, and extraction to `apps/desktop/staging`.
  - `scripts/package.ts`: Stages the bundle in isolated `/tmp` workspace to prevent macOS Desktop extended-attribute pollution, merges product metadata and `Info.plist`, installs the compiled extension bundle, strips extended attributes (`xattr -cr`), ad-hoc codesigns (`codesign --force --deep --sign -`), links launcher `bin/open-vs-code`, and packages `apps/desktop/dist/Open VS Code.app` and `apps/desktop/dist/Open-VS-Code-darwin-arm64-0.1.0.tar.gz`.
- **First-Run Behavior & Offline Resilience**:
  - Missing `.open-vs-code/models.json` or an unreachable inference endpoint does NOT break the editor.
  - Commands `open-vs-code.createStarterConfig` and `open-vs-code.openModelConfig` allow the developer to scaffold a starter configuration instantly.
  - Chat controller and autocomplete controller fail gracefully with explanatory messages rather than unhandled errors.
- **External HALO Readiness**:
  - Open VS Code is packaged without model weights.
  - Points to self-hosted inference runtimes (local or external OpenAI-compatible endpoints) strictly via user-controlled `.open-vs-code/models.json`.
  - The HALO target inference host acceptance runbook is detailed in `docs/deployment/HALO_ACCEPTANCE.md`.
See [ADR-028](docs/adrs/ADR-028-desktop-shell-and-packaging-strategy.md) for full architectural specification.

## Portable Skills Runtime (Sprint 5A, ADR-029)

Editor-independent, in `packages/agent-core/src/skills/`. It is feature-flagged off by default (`skills.enabled`); when off, the frozen ADR-014 `.agents/skills` path runs unchanged.

```text
createAgentRuntime(skills.enabled)
  └─ SkillRegistry.discover        built-in (agent-core/skills/builtins) + workspace (.open-vs-code/skills, trusted only)
       ├─ size + frontmatter prefix only → strict schema (skills/schema.ts) → SkillIndexEntry
       └─ precedence: workspace override must validate AND narrow the built-in
  └─ prepareSkillGuidance
       ├─ selectSkill               mode ∩ registered tools ∩ classifyPermission(capability) → trigger/description score → threshold, tie ⇒ none
       ├─ registry.loadBody(id)     lazy, cached, re-contained, re-validated (metadata unchanged, sections, safety)
       ├─ fitSkillGuidance          min(context_budget, 15% available, headroom); drop whole sections; core must fit
       └─ SkillEvidence             ids / versions / reason codes / token counts only
  └─ AgentRunnerInput.skillGuidance → compileContext → optional "skill" item (after active-code)
```

Authority is unchanged: the tool registry, `classifyPermission`, the confirmation flow, `RoutedModelGateway` and the HALO provider do not read skill data. Built-in skills ship as Markdown inside the extension (`dist/skills/builtins`) and the packaged desktop app. Surfaces: the CLI `--skills` flag and JSON `skillEvidence`; the VS Code setting `open-vs-code.skills.enabled`; the commands **List Available Skills** and **Show Active Skill**; and a `Skill: <id>` output line.
