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

## Controlled Terminal UX & Review Boundary (Sprint 3D / 3D.1)

```text
 VerificationEngine (SOLE Execution Authority)
   │  spawn(executable, args, { shell: false, detached: true })
   │  onOutput(chunk) ──────────────────────────────────────────┐
   │  StringDecoder(utf-8) — chunk boundary safe               │
   ▼                                                            │
 AgentRunner                                                    │
   │  verification.output event ◄───────────────────────────────┘
   ▼
 ChatController
   │  handleAgentEvent("verification.output") → appendOutput
   │  requestConfirmation — fail-closed validation (no fallbacks)
   ▼
 TerminalReviewController (Bounded Prefix Buffer, Registry)
   │  maxOutputBytes: 16 KB / stream (prefix, not ring)
   │  maxReviews: 50, maxTotalRetainedBytes: 1 MB
   │  Evicts oldest completed entries; never evicts active
   ▼
 IDE Webview (Presentation Only — textContent, XSS-immune)
   │ (terminal.respond / cancel / toggle / copy)
```

- **Execution Authority**: Subprocess spawning remains strictly in `VerificationEngine`. The IDE host, `ChatController`, `TerminalReviewController`, and Webview have zero spawn authority.
- **Safety Invariant**: Strictly `shell: false`. No arbitrary command execution, no command chaining, no `bash -c` evaluation.
- **Human Approval**: Mandatory explicit confirmation gate (`CONFIRM`). No auto-approval. Fail-closed: malformed prepared commands resolve immediately to `REJECT` with no fallback substitution.
- **Live Output Streaming**: `VerificationEngine` delivers stdout/stderr chunks via `onOutput` callback; `AgentRunner` emits `verification.output` events; `ChatController` pipes them into `TerminalReviewController.appendOutput`. Webview renders with `textContent` (XSS-immune).
- **Bounded Prefix Buffer**: Each stream retains the first 16 KB (configurable). `truncateUtf8Buffer` prevents split multi-byte sequences at limits. `stdoutTruncated` / `stderrTruncated` flags signal overflow. This is a **prefix** buffer, not a ring buffer.
- **7 Active Lifecycle States**: `WAITING_APPROVAL`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `REJECTED`. The dead `PREPARED` state has been removed.
- **Bounded Registry**: `TerminalReviewController` enforces `maxReviews` and `maxTotalRetainedBytes` limits by evicting the oldest completed entry when either limit is exceeded.
- **Deterministic Process Tree Cleanup**: Cancellation and timeout both kill parent and all descendants via `process.kill(-child.pid, ...)` on POSIX. Proof by real E2E scenarios 53–55.
- **Canonical Execution Identity (Sprint 3D.2)**: `PreparedVerification.verificationId` is passed directly as `executionId` across all stages (`confirmation` → `TerminalReview` → `verification.output` → `verification.completed` → `terminal.updated`). Output events route strictly by execution identity with zero fallback to `activeTerminal`.
- **Extension Deactivation Closure (Sprint 3D.2)**: Extension `deactivate()` triggers `chatController.cancelTurn()`, cleanly propagating the `AbortSignal` to kill the subprocess tree, clearing the terminal review registry, and preventing post-deactivation events or resurrection.
- **Zero Model Calls**: Presentation actions (expand, toggle, copy, cancel, reject) trigger zero LLM calls.

