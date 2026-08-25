# ADR-007: Real Open-Weight Model Protocol Normalization and Local Gateway

## Status

Accepted

## Context

The agent core requires integration with real local and self-hosted open-source/open-weight models (e.g. Qwen 2.5 Coder, Llama) served via OpenAI-compatible REST endpoints (e.g. Ollama, llama.cpp, vLLM). Local inference backends exhibit minor wire format differences, such as:
- Tool call arguments provided as JSON strings vs pre-parsed objects
- Content provided as `null`, empty string, or embedding JSON tool calls
- Omitted tool call IDs
- Non-standard usage metadata or missing usage envelopes
- Legacy `function_call` envelopes

The `AgentRunner` and upstream orchestration must remain editor-independent and decoupled from runtime-specific quirks.

## Decision

1. **Strict Normalization Boundary**: All wire responses pass through `normalizeWireResponse` before reaching `AgentRunner`. The runner consumes only canonical `ModelResponse` objects.
2. **Safe Tool Argument Parsing**: Stringified JSON arguments are safely parsed. Unparseable JSON or schema mismatches are preserved as structured error objects, allowing `ToolRegistry.prepare` and the runner to emit typed `tool.rejected` observations without throwing or performing unsafe partial execution.
3. **Model & Backend Capability Contracts**: Providers declare explicit capabilities (`chat`, `tools`, `parallel_tool_calls`, `context_window`, `usage_reporting`) to prevent hardcoded model assumptions.
4. **Preserved Deterministic Oracle**: The scripted model provider remains the fast deterministic CI regression oracle, strictly separated from live local model evaluations.
5. **No Proprietary Fallback**: The architecture does not fall back to proprietary APIs (Claude, OpenAI, Gemini) when local models underperform, preserving privacy, zero inference cost, and local-first sovereignty.

## Consequences

- Local backends (Ollama, llama.cpp, vLLM) integrate cleanly via the standard `OpenAICompatibleProvider`.
- Wire protocol changes are localized to `src/model/protocol.ts` and covered by protocol fixtures.
- The deterministic test suite runs in ~300ms without dependencies on live inference servers.
