# Open-source engineering reference

Accessed 2026-11-09. Clones are read-only checkouts outside this repository:

`/home/raul-mermans/agent-reference-codebases/open-vs-code-v1/`

No third-party setup script was executed. No reference file was copied into this product. Zed and OpenHands were not cloned; they are large trees and were not required to decide the changes in this pass.

## Pins

| Repository | Commit | License | Date of commit |
| --- | --- | --- | --- |
| https://github.com/cline/cline | `4a4c26ffa10dd4ee93a19df0e0a63b2dc7ad5413` | Apache-2.0 | 2026-11-09 |
| https://github.com/anomalyco/opencode | `d4d8567da804fc9e913363f2b0f59b1002533e07` | MIT | 2026-11-09 |
| https://github.com/Kilo-Org/kilocode | `b6a49d01c10d7e26c42a8a14b3441b7a1856c04c` | MIT (also names an OpenCode copyright) | 2026-11-07 |
| https://github.com/Aider-AI/aider | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | Apache-2.0 (`LICENSE.txt`) | 2026-05-22 |

## What makes Cline feel like a coding agent

Cline separates a shared runtime from each client. Approval is a durable request, not a sentence in the transcript.

- `sdk/packages/core/src/runtime/tools/tool-approval.ts` writes a request file and polls a decision file. A missing approval channel returns `approved: false`. The model cannot approve itself.
- `apps/vscode/src/hosts/vscode/hostbridge/diff` is the editor-facing diff host. The chat does not apply the edit by rewriting the buffer on its own.
- `sdk/packages/ui/components/agent-approval-card.tsx` is a single approval card reused by clients.

Open VS Code already has the same split: `PermissionGate` and `MutationEngine` decide, and the webview only renders the review. That pattern should stay. Cline's file-polling approval channel is a desktop IPC choice, not a better policy engine.

Recommendation: **ADOPT PATTERN** for one visible approval card and a collapsed activity summary. **REJECT** copying the approval-file IPC. License if any UI structure is later adapted: Apache-2.0 notice required. Evidence needed before a UI change: a screenshot of the current card failing a real review, plus a unit test of the decision.

## What makes OpenCode's loop reliable

OpenCode's current runner is one step, not a second agent.

- `packages/core/src/session/runner/step.ts` starts a snapshot before tools run, publishes model events, and returns a tagged outcome: completed, retry, continue, compact, or output limit.
- `packages/core/src/session/runner/retry.ts` retries only errors the provider marks retryable, with an attempt count and a delay.
- `packages/core/src/permission.ts` defaults a missing agent ruleset to deny (`action: "*", effect: "deny"`). Permission is data, evaluated in the runtime.
- `packages/core/src/session/runner/to-llm-message.ts` turns stored session parts into provider messages, including tool results, instead of pasting a fresh prose summary every turn.

Open VS Code's `AgentRunner` already denies by default and checkpoints mutations. It does not send native `tool` messages back to the model; observations are recompiled into the next prompt. That can lose tool-call structure for a local model. Replacing the runner with OpenCode's Effect stack would import a different runtime, a server, and a large dependency set. That is not justified until a same-model benchmark shows the message shape, not the framework, is why tasks fail.

Recommendation: **BENCHMARK** native tool-result messages against the current observation compiler on the same `qwen3-coder:30b` digest. **REJECT** vendoring OpenCode. License if a later extraction is authorized: MIT, keep the copyright notice.

## How Kilo keeps the IDE responsive

Kilo at this commit is an OpenCode-derived monorepo plus a VS Code client.

- Shared session behavior lives under `packages/opencode` and `packages/core`.
- The IDE client is `packages/kilo-vscode`. `src/kilo-provider/session-stream-scheduler.ts` coalesces SSE `partUpdated` events (about 16 ms for the focused session, slower for background sessions) before `postMessage` into the webview.
- Diff review is a session component (`packages/session-ui/src/components/session-diff.ts`), not a second agent.

Open VS Code does not stream provider deltas, so a scheduler would have nothing to coalesce. The useful pattern is the boundary: the webview renders session state and does not own the tool loop. That boundary already exists (`ChatController` to `AgentSessionBridge` to `AgentRuntime`).

Recommendation: **ADAPT** only if real streaming is added. Until then, **REJECT** a local HTTP daemon. Kilo's MIT license still requires a notice for any copied scheduler. None was copied.

## Which Aider techniques help smaller local models

`aider/coders/editblock_coder.py` applies SEARCH/REPLACE blocks, dry-runs them, and returns the unmatched blocks to the model instead of claiming the edit landed. `aider/coders/editblock_fenced_prompts.py` shows the exact block format the model must emit.

Open VS Code already refuses a patch that does not match (`MutationEngine`, stale base, duplicate `export function`). The gap is not the absence of a patch applier. It is whether `qwen3-coder:30b` emits a matchable patch on the first try. That is a benchmark question, not a reason to replace `apply_patch`.

Recommendation: **BENCHMARK** Aider-style search/replace failure text against the current patch error observation. **REJECT** importing Aider. Apache-2.0 would require a notice if any prompt text is copied. Do not copy the prompt strings.

## ExTester and twinny

Also cloned read-only on 2026-11-09. Zed and OpenHands were not cloned.

| Repository | Commit | License |
| --- | --- | --- |
| https://github.com/redhat-developer/vscode-extension-tester | `0b065c839a22e1d3e8701985c82e5d2080bb3658` | Apache-2.0 |
| https://github.com/twinnydotdev/twinny | `e634dcad9578604960941377c4357393bed34b48` | MIT (Copyright 2023 Richard Macarthy) |

ExTester drives a webview by switching into its frame (`tests/test-project/src/test/webview/webviewView.test.ts`, `switchToFrame`). That is the same OOPIF boundary Playwright is losing on this machine. It is a candidate driver, not a fix we have run. Recommendation: **BENCHMARK** against the current lab before adopting it. Apache-2.0 if any helper is later copied.

twinny keeps fill-in-the-middle separate from chat (`src/webview/hooks/useProviders.ts`). Open VS Code already routes autocomplete on its own path. Recommendation: **ADOPT PATTERN** only as a reminder to keep those model choices independent. No twinny code was copied.

## Decision gate

## Decision gate

Do not replace `AgentRuntime`. The references confirm the architecture we already have: one loop, deterministic permission, patch validation, and a thin IDE client. The measured gap is GUI driving of the webview and an unrun same-model comparison against OpenCode, not a missing framework.
