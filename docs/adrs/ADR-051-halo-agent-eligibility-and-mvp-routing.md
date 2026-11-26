# ADR-051: HALO Agent-mode eligibility and MVP model routing

Status: Accepted (Sprint 32, 2026-11-25)

## Context

Sprint 32 measured the product instead of adding mechanisms. Three findings constrain architecture:

1. Deployed HALO Core (`ccd05e5`) does not carry tool calls (`/inference/status` `tools: false`, strict schemas). The VC-07B protocol exists in HALO's repository but is not deployed. HALO serves only Qwen3 4B/14B at 8K context and does not observe Ollama.
2. With an explicit HALO `modelId`, Open VS Code dropped tool definitions silently, so Agent mode could run a model that cannot edit.
3. On the frozen S32 benchmark, `qwen3.6:35b` passed 16/20 and `qwen3-coder:30b` 12/20 across two runs each; `qwen3-coder` was about 5× faster.

## Decision

- **Direct Ollama remains the only Agent/Debug transport.** HALO remains optional and is Ask-only until a live Core passes the tool round-trip contract and S32 through `HaloProvider` matches Direct Ollama with the same model digest. The provider refuses write-capable tools on the explicit-model route before any request (`HALO_UNSUPPORTED_FEATURE`); there is no fallback to another provider.
- **Open VS Code does not duplicate HALO infrastructure.** It reads HALO status read-only and states plainly that Direct Ollama requests bypass HALO admission. The HALO-side contracts are listed in `docs/deployment/HALO_SPRINT32_HANDOFF.md`.
- **Auto keeps `qwen3.6` before `qwen3-coder`.** The order is now backed by S32 correctness, not names. Manual selection stays available; autocomplete stays on `qwen2.5-coder:7b`.
- **Native Agent Core stays the executor.** S32 failures were mostly model reasoning and two runtime completion defects (fixed), not tool-protocol failures an external harness would remove.

## Consequences

- Agent mode through HALO is unavailable today; users see an explicit refusal instead of a silently tool-less agent.
- A Phase D Direct-vs-HALO benchmark becomes possible only after HALO registers an Ollama-served coding model and deploys VC-07B.
- Revisit the Auto order when a new held-out set or a new model shows a different correctness ranking.
