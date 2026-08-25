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

`packages/agent-core` is the first executable implementation of the editor-independent core. It is a Node/TypeScript package with no runtime dependencies and no imports from the imported Kilo packages.

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
   `-- resumable, read-only AgentRunner
```

The repository tool layer is read-only. Realpath-based containment is authoritative for filesystem access, generated directories are ignored during traversal by default, and explicitly requested files remain readable when they are inside the workspace. No terminal, Git, write, delete, or real model-runtime capability exists in this package.

## Deterministic agent loop

`AgentRunner` composes existing boundaries without implementing their concerns:

```text
task -> compile bounded context -> model
     -> validate tool call -> permission policy
     -> execute registered read-only tool -> bound observation
     -> recompile context -> model -> final answer
```

The registry separates model-visible definitions from executors and strictly validates untrusted arguments before permission evaluation or execution. `ALLOW` executes, `DENY` produces a structured observation without execution, and `CONFIRM` returns a paused result that can resume with explicit approval or rejection. Tool failures are recoverable observations; model failures, required-context overflow, cancellation, maximum turns, and deterministic non-progress guards are distinct terminal outcomes.

Every lifecycle transition passes through the authoritative state reducer and event stream. Results expose compact status, turn, context, tool-call, confirmation, and event diagnostics rather than an unbounded internal transcript. Recent observations are deduplicated and capped before the context compiler fits them as optional context; project instructions, the task, and an explicitly selected Skill remain required.

## Cross-cutting constraints

- Project knowledge and decisions live primarily in Markdown.
- Repository context is progressively disclosed under an explicit token budget.
- Provider adapters may target local backends without changing agent-core contracts; only a generic OpenAI-compatible HTTP adapter exists today.
- The scripted provider is the orchestration regression oracle; it is not a model runtime.
- Product code begins only after upstream reuse evidence supports the baseline choice.

See `docs/adrs/` for the provisional decisions and their revisit triggers.

## Deferred imported baseline

The audited Kilo baseline remains in repository history for provenance and possible future reuse, but Kilo integration is explicitly postponed. Its registry boundaries informed Sprint 1D at a `REFERENCE_ONLY` level; no Kilo, Effect, plugin, MCP, shell, network, or host code was copied into `agent-core`.
