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

Every lifecycle transition passes through the authoritative state reducer and event stream. Results expose compact status, turn, context, tool-call, confirmation, and event diagnostics rather than an unbounded internal transcript. Recent observations are deduplicated and capped before the context compiler fits them as optional context; project instructions, the task, and multiple selected skills remain required up to the defined context budget. The SkillSelector deterministically manages skill inclusion to ensure the token budget is never exceeded.

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
