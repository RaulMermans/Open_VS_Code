# HALO Control handoff from Open VS Code Sprint 32

Scope: the smallest HALO-side contracts Open VS Code needs before HALO can serve Agent mode, or run an A/B against Direct Ollama. Nothing here was changed on the HALO host. Observed 2026-11-25 with read-only, unauthenticated GETs against `127.0.0.1:4310` and with `git` on `~/Documents/Codex/HALO/repos/halo-control-vc07bq`.

## What is deployed

| Item | Observed |
| --- | --- |
| Core release | `halo-core-0.1.0+ccd05e504ffd.f0c9dc21b156`, source `ccd05e5`, clean |
| VC-07B tool protocol | merged at `edb6393`; `ccd05e5` is its ancestor, so **not deployed** |
| `/inference/status` | `streaming: false`, `tools: false`, provider `openai-compatible` → llama-server `:8092` |
| Registered models | `x3-qwen3-4b-vulkan` (coding, reasoning, general), `x3-qwen3-14b-vulkan` (reasoning, general); both 8K context |
| Routes | coding, reasoning, general → `x3-qwen3-4b-vulkan` |
| Runtime observation | `/infrastructure/model-runtimes`: llama.cpp Vulkan b12144, phase `model_advertised`, artifact SHA-256s |
| Admission | `/inference/admission`: max 1 active, 8 queued, `directRuntimeHttp: uncontrolled_if_credential_known` |
| Hardware | `/hardware`: CPU and RAM only; `gpu.status: unavailable`, `haloHardwareVerified: false` |
| Request schemas | `.strict()`: a capability chat that carries `tools` is rejected as an invalid request |

## Consequences for Open VS Code

- Agent and Debug cannot run through HALO today. On the capability route, deployed Core rejects the tool payload, and the user sees "HALO rejected the inference request." On the explicit-model route, Open VS Code used to drop tools silently; Sprint 32 now refuses write tools there before any request.
- Open VS Code's principal coding models (`qwen3.6:35b`, `qwen3-coder:30b`) are served by Ollama and are not registered in HALO. HALO does not observe Ollama, so HALO telemetry says nothing about the inference Open VS Code actually runs. Every Direct Ollama request bypasses HALO admission.
- An identical-digest A/B (Phase D) is therefore impossible without HALO changes: same GGUF, same quantization, same context on both paths.

## Minimal HALO work, in order

1. **Deploy VC-07B** (`edb6393` or later) so `/inference/status` reports `tools: true` and `/inference/capability/chat` accepts `tools`, `toolChoice`, assistant `toolCalls`, and `role: "tool"` messages with `toolCallId`. Open VS Code already sends this shape (`HaloProvider`, `halo-tool-cycle.test.ts`).
2. **Register one coding model that Open VS Code also serves directly**, for example `qwen3-coder:30b` (digest `06c1097efce0…`) through an Ollama-backed runtime, with a context of at least 32K. 8K is too small for the agent's compiled context.
3. **Report usage and identity on every response**: `modelId`, the runtime digest or GGUF SHA-256, `usage.inputTokens` and `usage.outputTokens`.
4. **Cancellation contract**: state whether closing the HTTP request aborts the runtime generation and frees the admission slot. Open VS Code aborts with `AbortSignal`.
5. **Optional, read-only**: Ollama residency (`/api/ps` equivalent) and GPU memory in `/hardware`, so HALO can be the place to look for "is the model loaded and is there room".

Streaming is not required for Agent mode qualification. Open VS Code's agent path does not stream today.

## Open VS Code qualification once 1–3 exist

Run `packages/agent-core/tests/model/halo-tool-cycle.test.ts` against a live Core (replace the stub server), then the S32 benchmark subset through `HaloProvider` with the same model and digest as the Direct Ollama run. HALO becomes eligible for Agent mode only if its independently verified S32 results match Direct Ollama.

## Update (2026-11-26)

Item 1 is done: the deployed Core is `ceee13f` and `/inference/status` reports `tools: true`. Open VS Code's VC-07B-Q branch sends tools on both the capability and the model-pinned route. Items 2–5 are unchanged.

## Update (2026-11-27, Sprint 33)

Re-observed with read-only, unauthenticated GETs against `127.0.0.1:4310`. Nothing on the HALO host was changed.

| Requirement | Observed | State |
|---|---|---|
| Tool calls (item 1) | `/inference/status` `tools: true` | done |
| Coding model Open VS Code also serves (item 2) | `/models`: only `x3-qwen3-4b-vulkan` and `x3-qwen3-14b-vulkan`, 8,192-token context; every route (coding, reasoning, general) → the 4B | open |
| Ollama visibility (item 5) | `/infrastructure/model-runtimes` lists only the llama.cpp Vulkan 4B runtime | open |
| Identity on responses (item 3) | the runtime lists the GGUF SHA-256; `/inference/admission` `runtimeIdentity` fields are all `null` | partial |
| Cancellation (item 4) | not documented | open |
| Admission limits | `maxOutputTokens: 512`, `maxInputChars: 32000`, `executionTimeoutMs: 90000`, `maxActiveRequests: 1` | new blocker: an agent turn needs more output than 512 tokens and more input than 32K characters, and S35 tasks run for minutes |
| Hardware | GPU now reported (`gfx1151`, temperature), `haloHardwareVerified: true`; GPU memory bytes still `null` | improved |
| Streaming | `false` | not required |

A same-model Direct-vs-HALO comparison is still impossible: HALO serves none of `qwen3-coder:30b` or `qwen3.6:35b`. Even a registered model would be cut off by the 512-token output cap and the 32K-character input cap.

Smallest next HALO step: register `qwen3-coder:30b` (Ollama digest `06c1097efce0…`) through an Ollama-backed runtime with at least a 32K context, and give a coding workload class admission limits of at least 4,096 output tokens, at least 128K input characters and at least a 10-minute execution timeout. Then Open VS Code runs S35 through `HaloProvider` and compares it with the Direct Ollama results on the same digest.

Direct Ollama remains the only Agent transport. HALO stays optional (ADR-051).
