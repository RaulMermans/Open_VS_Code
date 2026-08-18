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

## Implemented agent-core foundation

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
   `-- minimal context compiler
```

The repository tool layer is read-only. Realpath-based containment is authoritative for filesystem access, generated directories are ignored during traversal by default, and explicitly requested files remain readable when they are inside the workspace. No terminal, Git, write, delete, autonomous loop, or model-runtime capability exists in this package.

## Cross-cutting constraints

- Project knowledge and decisions live primarily in Markdown.
- Repository context is progressively disclosed under an explicit token budget.
- Provider adapters may target local backends without changing agent-core contracts; only a generic OpenAI-compatible HTTP adapter exists today.
- Product code begins only after upstream reuse evidence supports the baseline choice.

See `docs/adrs/` for the provisional decisions and their revisit triggers.

## Deferred imported baseline

The audited Kilo baseline remains in repository history for provenance and possible future reuse, but Kilo integration is explicitly postponed. The new `packages/agent-core` implementation does not depend on or modify that runtime.
