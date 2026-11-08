# Sprint 14B — Conversational Agent Experience V2

Status: **PARTIALLY_VERIFIED**. Deterministic presentation tests cover the new answer and activity contracts. The installed desktop GUI has not been exercised against Ollama and `qwen3-coder:30b` for this sprint, so the sprint is not complete.

Architecture preserved:

```text
VS Code Webview → ChatController → AgentSessionBridge → Agent Runtime → Provider/Tools
```

No second agent, no permission bypass, no cloud fallback, and no simulated token stream.

## UX audit

Inspected the Sprint 7A chat path before editing: `chat-controller.ts`, `chat-ux-model.ts`, `chat-protocol.ts`, `chat-view-provider.ts`, `webview-render-helpers.ts`, `ModelProvider.complete`, and `AgentRunner.#completeTask`.

| Area | Finding | This sprint |
| :--- | :--- | :--- |
| Final answer | `session.finalAnswer` is the model text, or a runner verdict when the model text is empty. `formatTerminalTaskMessage` showed that text, with a fixed rejection and failure prefix. | Kept the model text. Appended a verified block only from `appliedMutations` and review rows. |
| Language and prose | The runner told the model to answer directly, and to quote observed names. It did not ask for the user's language or to avoid code-only replies. | Added `CONVERSATIONAL_RESPONSE_GUIDANCE` to the existing operating guidelines. |
| Activity | Every retained event was a timeline row, expanded while the turn was running. | Grouped titles from those same events. Raw labels stay in a collapsed "Technical details" list. |
| Composer | Ask / Plan / Agent, local model select, attachments, Send, Stop, and New already exist. ASK writes are denied in `classifyPermission`. | Left the composer backend in place. Empty and disconnected copy is clearer. Narrow panels stack the controls. |
| Changes and tests | The review ledger already tracks mutations and commands. The assistant message could repeat an unverified model claim. | The assistant message now adds files and test status from those records. |
| Streaming | `ModelProvider.complete` returns one `ModelResponse`. The capability flag `streaming` is not a stream method. The bridge emits lifecycle events, not text deltas. | Deferred. See below. |
| Wider conversation | The agent is a secondary-sidebar webview. `open-vs-code.newConversation` already focuses it. | A second editor-column webview would fork the same controller's single webview post target. Widening the sidebar remains the supported layout. |

## Response contract

`packages/agent-core/src/agent/response-guidance.ts` is interpolated into the existing guidance instruction. It asks the model to:

- reply in the language of the latest user message
- explain in short prose and use a code fence only when it helps
- separate findings, recommendations, actions, and verification
- stay concise unless the task is complex
- claim a file, edit, or test only when that fact is in the observations

There is no second summarization call. Coding tools, ASK denial, PLAN approval, and BUILD confirmation are unchanged.

## Verified outcome

`formatTerminalTaskMessage` still owns the status line.

- A completed conversational answer is shown as the model wrote it.
- Applied paths come from `appliedMutations` and mutation reviews whose status is `applied`.
- The test line comes from the last command review: passed, failed, timed out, cancelled, not run, or not finished.
- A coding completion with files and no command review says `Tests were not run.`
- Rejection stays `Change rejected — no files modified.` A rejected review path is named as not applied. Earlier applied files are listed only when the result actually contains them.
- Cancellation stays `Task cancelled.` Model text that claims success is not shown.

## Activity

`summarizeActivities` folds consecutive events into the titles Understanding the request, Exploring the codebase, Reading relevant files, Planning changes, Editing files, Waiting for approval, Running checks, Reviewing results, and Completed / Failed / Cancelled / Blocked. A failed event keeps the group failed. Counts are the number of real events in the group. The technical list is a `<details>` element that starts closed.

## Streaming feasibility

True incremental assistant text is not available on the current contracts.

Required later, as a separate sprint:

1. `ModelProvider` grows a streaming method that yields text deltas and still resolves to one `ModelResponse`.
2. OpenAI-compatible and HALO providers implement it without a cloud fallback.
3. The runner emits `model.delta` events carrying only assistant prose, never raw tool-call fragments.
4. The bridge forwards those events on the existing callback.
5. The webview appends deltas for the active turn and replaces them with `finalAnswer` when the turn settles.
6. `AbortSignal` cancellation discards a partial delta that never became `finalAnswer`.

Until those exist, the timeline's "Planning changes" / "Reviewing results" row is the waiting state. The UI must not invent tokens.

## Release and rollback

No package was cut. Installed `0.1.0-rc.8` is unchanged. Conversation files and `models.json` are not migrated.

Rollback is a source revert of this sprint. There is no storage rewrite to undo.

To ship later: build the desktop package from this tree, install it beside rc.8, and run the installed GUI journeys before replacing the daily driver.

## Verification evidence

Mocked, this session:

- `packages/vscode-integration/tests/sprint-14b-conversation-ux.test.ts`: 5 pass
- `packages/vscode-integration/tests/sprint-7a-chat-ux.test.ts`: 27 pass
- `packages/vscode-integration/tests/sprint-7a-webview-runtime.test.ts`: 1 pass
- `packages/vscode-integration/tests/sprint-7b-terminal-diff.test.ts`, `chat-ux.test.ts`, `sprint-7c-sessions.test.ts`: 47 pass
- `packages/agent-core/tests/agent/response-guidance.test.ts` and `coding-reliability-11a1.test.ts`: 36 pass
- `tsc --noEmit` in `vscode-integration` and `agent-core`: pass
- `oxlint --deny-warnings` on the agent-core response guidance and runner: pass

Not evidence of the installed UI:

- Desktop smoke reads the already packaged extension under `apps/desktop/dist`. This diff is not in that package, so smoke was not used as acceptance.
- `/usr/bin/open-vs-code` is installed and `DISPLAY` is set. It was not launched, because it does not contain this source.

## Known limitations

- Installed GUI screenshots and a live `qwen3-coder:30b` walkthrough were not produced here.
- The model can still ignore the response guidance. The verified block does not rewrite the prose.
- Activity groups are presentation. They are not a new progress protocol.
- A wider editor-column conversation is not implemented.
- Streaming is deferred.
