# Architecture

## Provisional component map

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
   |-- MCP
   |
Model Gateway
   |
Local Model Providers
```

The boundaries are provisional; the dependency direction is not. `agent-core` must be runnable independently of VS Code. IDE APIs belong behind adapter interfaces, and model-specific behavior belongs behind the model gateway.

## Cross-cutting constraints

- Project knowledge and decisions live primarily in Markdown.
- Repository context is progressively disclosed under an explicit token budget.
- Provider adapters may target Ollama, llama.cpp, vLLM, LM Studio, or generic local OpenAI-compatible endpoints without changing agent-core contracts.
- Product code begins only after upstream reuse evidence supports the baseline choice.

See `docs/adrs/` for the provisional decisions and their revisit triggers.

## Sprint 1 baseline recommendation

Use a controlled Kilo fork: its VS Code package already connects through a local backend boundary to an editor-independent agent runtime. Keep that architecture while isolating cloud, telemetry, remote-session, marketplace, and deferred multi-agent features. The evidence and alternatives are recorded in `docs/research/starting-strategy.md`.
