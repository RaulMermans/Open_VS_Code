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

## Update (2026-11-26, VC-07B-Q)

The deployed HALO Core (`ceee13f`) now advertises `tools: true`. VC-07B-Q sends tools on the model-pinned route as well and replaces this ADR's write-tool refusal and `toolsSupported` flag with `toolTransport` (Core protocol support) and `modelToolCalling` (operator opt-in per model). Neither is model qualification: Direct Ollama remains the default Agent transport until HALO-routed coding tasks pass with the same independent oracles (see `scripts/vc07bq-coding-task.mjs`).

## Update (2026-11-27, Sprint 33): Auto prefers `qwen3-coder`

The revisit condition above was met. On the held-out S33 and S34 sets (same runtime commit per pair, two runs each), `qwen3-coder:30b` passed 31/40 and `qwen3.6:35b` 30/40, with no false completions from either. `qwen3-coder` took 1,414 s in total against 5,449 s (about 4× faster) and was faster on every task. No held-out task passed with `qwen3.6` and failed with `qwen3-coder`. `qwen3.6` failed all four COMPLEX runs and `qwen3-coder` failed three. The S32 advantage for `qwen3.6` (9/10 against 6/10 after fixes, one run each) was on a development set and did not repeat on held-out tasks.

- **Auto now lists `qwen3-coder` before `qwen3.6`**, and the model picker orders them the same way. ModelRouter still falls back to `qwen3.6` when `qwen3-coder` is unavailable.
- **No automatic escalation to `qwen3.6`.** No task category showed a measured `qwen3.6` advantage on held-out data. Add one only when a category shows that advantage.
- A stored manual model choice is unchanged. A stored Auto preference now resolves to `qwen3-coder` first. The fresh-install chat default was already `qwen3-coder:30b`.
- S35 (new held-out set) is the confirming measurement.

## Update (2026-11-27, Sprint 33B): S35 does not confirm the Auto order

S35 was the confirming measurement. It did not confirm. Same runtime (`f5428c2`), two runs each: `qwen3-coder:30b` 5/10 and 5/10, `qwen3.6:35b` 8/10 and 7/10. `qwen3-coder` lost on explain (decoy constant, incomplete caller answer) and on the bugfix edge case, where `qwen3.6` passed every run. `qwen3-coder` stayed about 4× faster (26–32 s per correct task against 87–116 s). Across S33–S35 held-out runs the totals are 41/60 for `qwen3-coder` and 45/60 for `qwen3.6`.

Neither model meets the release gate, so neither is a qualified Auto choice for coding. The Auto order is unchanged in this sprint: switching it trades a 4× latency cost for a gain measured on one set, and it is a product decision, not a qualification result. Decision owner: the product owner. The no-escalation rule stands. See `docs/evals/S35_BENCHMARK.md`.
