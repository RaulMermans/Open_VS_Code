# V1 architecture audit

Date: 2026-11-09. Source revision at audit start: `c1d8bc0ee14b46d7b87d5d65bb70c609ffb13a8b` on `main`. Work continued on `sprint/v1-product-convergence`. Installed package: `open-vs-code 0.1.0-rc.12` at `/usr/bin/open-vs-code`. That package was not replaced.

This note records defects that the source shows. It does not propose a new runtime.

## Inventory

| Concern | Authoritative code | Notes |
| --- | --- | --- |
| Desktop shell | `apps/desktop` | VSCodium package. Sandbox helper stays setuid. The lab launches `/usr/lib/open-vs-code/open-vs-code`. |
| Extension | `packages/vscode-integration/src/extension.ts` | Activates the chat view, model routing, autocomplete. |
| Chat webview | `packages/vscode-integration/src/chat-view-provider.ts` | Composer `#composer`, send `#send-btn`, modes Ask / Plan / Agent. |
| Controller | `packages/vscode-integration/src/chat-controller.ts` | Owns view state and maps agent events to activity rows. |
| Bridge | IDE adapter plus `AgentSessionBridge` | One path into the runtime. |
| Runtime | `packages/agent-core/src/agent/runner.ts`, `runtime.ts` | Single `AgentRunner`. Observations are recompiled into the next model request. |
| Model protocol | `packages/agent-core/src/model/protocol.ts`, `openai-compatible.ts` | OpenAI-compatible Ollama endpoint. No streaming. |
| Tools and permissions | `packages/agent-core/src/tools/` | Read-only tools, `MutationEngine`, `PermissionGate`. |
| Acceptance | `apps/desktop/acceptance/` | 46 scenarios. Live GUI driver is the open defect. |

## Defect 1 — Protocol markers were treated as prose

`separateUnparsedProtocolEnvelope` used to cut the assistant text at `</function>`, `</tool_call>`, or `<parameter=`. A real answer that quotes those characters lost the rest of the sentence. Opening envelopes (`<tool_call` and `<function=name>`) are still removed when they were not parsed as a call. Quoted closing tags stay.

Qwen-family replies also wrap private reasoning in `<think>` blocks, and Ollama can send `reasoning_content` beside the answer. The chat path stored that text as the answer. Workflow code already stripped it. The model normalizer did not.

Correction in `protocol.ts`: drop only an opening tool envelope; strip hidden reasoning outside fenced code; record `reasoningPresent` without copying the private text. 25 protocol tests pass, including the new cases. This code is **not** in the installed rc.12 binary.

## Defect 2 — The acceptance driver touches the webview OOPIF

Live evidence from 2026-11-09, installed rc.12, isolated temp profiles:

- A read through Electron `webFrameMain.executeJavaScript` can see `#composer` after the webview has loaded (`composer-ready` in `apps/desktop/acceptance/evidence/2026-11-09T20-19-25-238Z/CONV-PING/webview-lifecycle.jsonl`).
- The next script on that frame closes the Playwright connection. The log shows `Debugger ending` and then `window-closed` for `workbench.html`, about 10–20 ms later.
- Sending as the first script, while `index.html` is still attaching, also closes the window (`2026-11-09T20-22-56-154Z`).
- Playwright `contentFrame()` was removed from the success path. The close still happens. The failure is the shared DevTools connection plus the `vscode-webview://` frame, not only the locator API.

`CONV-PING` on 2026-11-09 remains **FAIL / tooling**. The other 45 scenarios were **NOT_RUN** in these launches. NOT_RUN is not a pass.

The lab now has a guest script (`apps/desktop/acceptance/src/guest-bridge.ts`) that can fill, click, and wait for a reply inside one page script. A fake DOM test covers that script. A live send that returns the model's reply was **not** achieved. Further GUI retries on this same failure were stopped.

## Defect 3 — No same-model comparison with OpenCode yet

OpenCode's runner (`packages/core/src/session/runner/step.ts` at `d4d8567da8`) keeps native tool results and retries only retryable provider errors. Our runner recompiles observations. Which one completes more coding tasks on this machine's `qwen3-coder:30b` is unmeasured. See `docs/evals/V1_CODING_BENCHMARK.md`.

## What is not a defect

- A second agent, a local HTTP daemon, or a new orchestration framework. Cline, OpenCode, and Kilo all keep one execution loop and put permission in deterministic code. We already do that.
- Electron's Chromium sandbox is not a sandbox for agent shell commands. Command limits stay in `PermissionGate` and the verification engine. Do not describe tool execution as sandboxed.

## Acceptance for the protocol correction

`npm --workspace=@open-vs-code/agent-core exec -- node --import tsx/esm --test tests/model/protocol.test.ts` — 25 pass on 2026-11-09.

Installed-GUI proof still requires a package built from this branch and an explicit install. Neither was done.
