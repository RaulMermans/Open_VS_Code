# ADR-020: HALO capability provider

## Status

Accepted for Sprint 9 local implementation.

## Decision

Open VS Code has two explicit inference backends:

- `standalone-local` preserves its existing workspace-local provider routing.
- `halo` adapts the existing `ModelProvider` boundary to local HALO Core at `http://127.0.0.1:4310` by default.

HALO requests use `POST /inference/capability/chat`, bearer authentication, a bounded timeout, and the configured application credential. The credential is stored in VS Code SecretStorage through `Open VS Code: Set HALO Application Token`; `HALO_APP_TOKEN_OPEN_VSCODE` is only a development fallback.

The mapping is deterministic: ASK and BUILD use `coding`; PLAN, DEBUG, and REVIEW use `reasoning`. Open VS Code never sends a model or runtime reference when the HALO backend is selected.

HALO currently supports non-streaming chat only. The adapter returns one truthful completion at the existing provider boundary; it does not simulate chunks. Cancellation aborts the HTTP request, but does not claim to stop upstream generation.

## Consequences

Selecting HALO never falls back to standalone local inference. HALO failures are converted to safe, bounded provider errors. The existing editor mutation preparation, diff review, approval gates, and safe tool execution are unchanged.

Embeddings are not integrated because the current Open VS Code execution path does not invoke embeddings.
