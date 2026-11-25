# ADR-020: HALO capability provider

## Status

Accepted. VC-07 amends the request shape: an optional HALO model ID may use `POST /inference/chat`. VC-07B adds structured tool transport (HALO ADR-044); VC-07B-Q makes it apply to both endpoints (see below). Streaming remains unqualified, and no model is physically tool-qualified yet.

## Decision

Open VS Code has two explicit inference backends:

- `standalone-local` preserves its existing workspace-local provider routing (Direct Ollama default).
- `halo` adapts the existing `ModelProvider` boundary to local HALO Core at `http://127.0.0.1:4310` by default.

HALO requests use `POST /inference/capability/chat` unless `open-vs-code.halo.modelId` is set, in which case they use `POST /inference/chat` with that registry ID. Bearer authentication, a bounded timeout, and the Open VS Code application credential apply. The credential is stored in VS Code SecretStorage through `Open VS Code: Set HALO Application Token`; `HALO_APP_TOKEN_OPEN_VSCODE` is only a development fallback.

The mapping is deterministic: ASK and BUILD use `coding`; PLAN, DEBUG, and REVIEW use `reasoning`.

HALO currently supports non-streaming chat only. The adapter returns one truthful completion at the existing provider boundary; it does not simulate chunks. OpenAI `tool_calls` at the top level of a HALO body are rejected.

**Tools (VC-07B, amended VC-07B-Q).** Tool definitions travel with the request on both `POST /inference/capability/chat` and `POST /inference/chat`. The VC-07/VC-07B merge had dropped them on the model-pinned path, so a pinned model never saw any tools. HALO decides per model whether tools are allowed (`metadata.toolCalling`) and refuses explicitly otherwise. Open VS Code never downgrades silently to a text-only request. Returned tool calls must carry a unique ID and JSON-object arguments. Replayed history never invents missing arguments. `inspectHaloConnection` reports `toolTransport` (Core provider support) and `modelToolCalling` (the selected model's operator opt-in) separately. Neither one means the model is qualified. With `native-tool-messages`, runner notices (`coding_gate`, `evidence_gate`) are sent as user messages, never as assistant tool calls the model did not make. Cancellation aborts the HTTP request, but does not claim to stop upstream generation. Uncertain HALO completion is never replayed on standalone-local.

## Consequences

Selecting HALO never falls back to standalone local inference. HALO failures are converted to safe, bounded provider errors. The existing editor mutation preparation, diff review, approval gates, and safe tool execution are unchanged.

Embeddings are not integrated because the current Open VS Code execution path does not invoke embeddings.
