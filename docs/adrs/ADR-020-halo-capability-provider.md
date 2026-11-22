# ADR-020: HALO capability provider

## Status

Accepted. VC-07 amends the request shape: an optional HALO model ID may use `POST /inference/chat`. Tool calling and streaming remain unqualified.

## Decision

Open VS Code has two explicit inference backends:

- `standalone-local` preserves its existing workspace-local provider routing (Direct Ollama default).
- `halo` adapts the existing `ModelProvider` boundary to local HALO Core at `http://127.0.0.1:4310` by default.

HALO requests use `POST /inference/capability/chat` unless `open-vs-code.halo.modelId` is set, in which case they use `POST /inference/chat` with that registry ID. Bearer authentication, a bounded timeout, and the Open VS Code application credential apply. The credential is stored in VS Code SecretStorage through `Open VS Code: Set HALO Application Token`; `HALO_APP_TOKEN_OPEN_VSCODE` is only a development fallback.

The mapping is deterministic: ASK and BUILD use `coding`; PLAN, DEBUG, and REVIEW use `reasoning`.

HALO currently supports non-streaming chat only. The adapter returns one truthful completion at the existing provider boundary; it does not simulate chunks. Tool schemas are not sent on the HALO wire. OpenAI `tool_calls` in a HALO body are rejected. Cancellation aborts the HTTP request, but does not claim to stop upstream generation. Uncertain HALO completion is never replayed on standalone-local.

## Consequences

Selecting HALO never falls back to standalone local inference. HALO failures are converted to safe, bounded provider errors. The existing editor mutation preparation, diff review, approval gates, and safe tool execution are unchanged.

Embeddings are not integrated because the current Open VS Code execution path does not invoke embeddings.
