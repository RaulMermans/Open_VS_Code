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
   |-- metadata-first Skills discovery and explicit loading
   |-- bounded read/list/search/find repository tools
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

Every lifecycle transition passes through the authoritative state reducer and event stream. Results expose compact status, turn, context, tool-call, confirmation, and event diagnostics rather than an unbounded internal transcript. Recent observations are deduplicated and capped before the context compiler fits them as optional context; project instructions, the task, and an explicitly selected Skill remain required.

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
