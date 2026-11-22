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
- Sprint 14B.1 replaced the single "last command is a test" line. A command is classified from its script name or command text, and only a review whose run id matches the turn is used. A coding completion with file changes and no matching command says `Verification was not executed.`
- Rejection stays `Change rejected — no files modified.` A rejected review path is named as not applied. Earlier applied files are listed only when the result actually contains them.
- Cancellation stays `Task cancelled.` Model text that claims success is not shown.

## Activity

`summarizeActivities` keeps one line per activity kind inside a task. Titles name the work and, when the events carry paths, the file count: Exploring repository — N files inspected, Reading files — N files, Implementing changes — N files. A model wait is Thinking until it finishes, then Model replied. Planning changes appears only when the activity is marked from a PLAN-mode task. A failed event keeps the group failed. The technical list is a `<details>` element that starts closed, and it keeps every event label and the run id.

## Sprint 14B.1

Status: **PARTIALLY_VERIFIED**. The presentation contract is tested, and `qwen3-coder:30b` was called through `OpenAICompatibleProvider`. The new package is not installed, so the installed GUI journeys were not run.

### Evidence isolation

`ChatController` passed the whole conversation review ledger into `formatTerminalTaskMessage`. A later answer could list files and checks from an earlier run. Each review is now stamped with the task id from `task.started`, or with a per-turn stamp when that event has not arrived. The terminal message keeps reviews whose `runId` matches that turn. Older rows remain in the ledger and in the earlier message.

### Verification wording

The last finished command is no longer labeled "Tests passed" by default. `scriptName`, then the command text, selects test, lint, typecheck, or other. Rejected, cancelled, and interrupted commands use those words. A coding run with file changes and no command says `Verification was not executed.` If the model text asserts a passed check or an edit that the current run did not record, the prose stays and a line beginning `Unsupported claim:` is added.

### Live local model

Endpoint `http://127.0.0.1:11434/v1`, model `qwen3-coder:30b`, `OPEN_VS_CODE_REAL_INFERENCE=1`. One `complete()` call per prompt. No stream and no second summary call. Sample file `/tmp/ovsc-14b1-workspace/src/add.ts` SHA-256 `721b1ec135c3e5f35a70a1ce66ef194a57156fd42a40ec5537a37a18b49e9862` was unchanged.

| Interaction | Result |
| :--- | :--- |
| English explanation, no code requested | Prose, no code fence. `finishReason` `stop`. About 23 s on the cold call. |
| Spanish explanation | Answer in Spanish, no code fence. |
| Explain `src/add.ts` from the prompt | Describes the exported `add` function. No edit claim. |
| Follow-up about a non-number argument | Uses the prior answer and the file. Describes JavaScript coercion. |
| Failing expectation `add(1, 2)` equals 4 | Says the function returns 3 and the expectation is wrong. Does not claim a test ran. |
| Plan a rename, do not edit | Plan in headings. Says no file is modified. The file hash stayed the same. |
| Ask for an edit without supplying the file | Asks for the file. Does not invent a diff. |
| Same reply passed through a rejected mutation | `Change rejected — no files modified.` Names `src/add.ts` as not applied. |
| Same reply passed through a failed `npm test` | Keeps the reply, adds `Unsupported claim`, `Changed: src/add.ts`, and `Tests failed.` This row is the formatter, not a disk write. |
| Abort after 400 ms | `ModelProviderError`: `Model request was cancelled`. |
| `127.0.0.1:9` | `ModelProviderError` `NETWORK_ERROR` in 1 ms. |

### Package

The first build used `OPEN_VS_CODE_ALLOW_DIRTY_PACKAGE=1` because the tree was uncommitted. That `.deb` file was in `apps/desktop/dist` when the workspace directory was removed. The extracted payload survived in `/tmp/ovsc-rc10-inspect` and was repacked. Treat the rebuilt file hash as the hash of the recovered archive, and the first build hash as the hash measured before the directory disappeared.

- Version: `0.1.0-rc.10`
- First Debian SHA-256, measured before the workspace directory was removed: `a628c60b44108c0af4271d1bc2b891c503c84b67064489f432833afa1b0d106a`. That file is gone.
- Recovered Debian, rebuilt from the extracted payload: `apps/desktop/dist/open-vs-code_0.1.0-rc.10_amd64.deb` SHA-256 `f594e75b418256caaa1c53458dfbf7f20fdb9e9c2ea0cd9b498768b037d53280`. The container hash differs because the archive was rebuilt. The bundled extension inside the extract is still `0.1.0-rc.10`.
- First payload archive SHA-256: `8f24071881a0fc532af50ecf10972130a42088c9808eb6a437b48a437fc25690`
- Bundled extension in the extracted payload: `open-vs-code.vscode-integration` `0.1.0-rc.10`
- Source commit at build time: `2bdbd7e67a3c212a21a0f887646265cbc7bd30e6`
- `gitDirty` at build time: true
- Installed package, unchanged: `0.1.0-rc.9` from `bb07b1481d`, extension `0.1.0-rc.9`
- The rc.9 `.deb` that was beside the new package was removed with the workspace directory. Rollback is a reinstall of that package if a copy is still available to the operator, or the installed system if it has not been replaced.
- Config and conversation copy: `~/open-vs-code-backups/pre-0.1.0-rc.10-2026-11-08` (15 files). The live profile was not modified.

Before the directory was removed, `npm run typecheck` and `npm run lint` passed. Desktop smoke passed 12 and skipped 3 non-Linux cases. Linux smoke passed 6.

### Installed GUI

Not run. `sudo -n` reports that interactive authentication is required, so `dpkg -i` was not attempted.

The unpackaged `0.1.0-rc.10` binary aborted:

`The SUID sandbox helper binary was found, but is not configured correctly.`

`chrome-sandbox` in that directory is mode `4755` and owned by the desktop user. No `--no-sandbox` launch was used. No installed-window screenshots were captured.

Launcher identity on the installed system: `/usr/share/applications/open-vs-code.desktop` names Open VS Code, `Exec=open-vs-code %F`, `Icon=open-vs-code`, `StartupWMClass=open-vs-code`. The same fields are in the rc.10 payload. Pass/fail of the new window icon and dock match remains unchecked.

## Release and rollback

Installed `0.1.0-rc.9` is unchanged. Conversation files were copied, not migrated.

Installing rc.10 still requires root after a package file is present:

```text
sudo dpkg -i apps/desktop/dist/open-vs-code_0.1.0-rc.10_amd64.deb
```

The installed rc.9 package is the rollback target until that command succeeds. The backup directory is a copy. Restoring it is a manual overwrite of the matching files under `~/.config/Open VS Code` and is not required to keep the installed package.

## Known limitations

- Installed GUI screenshots and a live `qwen3-coder:30b` walkthrough inside the installed window were not produced. The provider checks above are not that walkthrough.
- The workspace directory disappeared after the package build. The source was restored from `sprint/14-daily-driver-stabilization` at `2bdbd7e67a` and these edits were applied again. The original dirty package file is gone.
- The model can still ignore the response guidance. The plan reply used headings. The verified block does not rewrite the prose.
- `Unsupported claim` used to match "tests pass" in a reply about future work. Sprint 14B.2 limits that note to a past report such as "tests passed".
- Activity groups are presentation. They are not a new progress protocol.
- A wider editor-column conversation is not implemented.
- Streaming is deferred.

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

## Sprint 14B.2

Status: **PARTIALLY_VERIFIED**. The source corrections and the clean `0.1.0-rc.11` package are verified. The package is not installed, so the installed GUI and the live model walkthrough inside that window were not run. The sprint is not complete.

`taskReviews` now always uses `reviewsForRun`. A turn with no run id, and a review whose run id does not match, cannot supply files or checks for the verified block. Paths on the current `appliedMutations` result are still listed, because they belong to the runner result rather than the conversation ledger.

The unsupported-claim note matches a past report (`tests passed`, `lint passed`, `typecheck passed`, `checks passed`). It does not match `tests pass` or `tests will pass`.

Targeted tests after the change: `sprint-14b-conversation-ux.test.ts`, `sprint-7a-chat-ux.test.ts`, and `sprint-7c-sessions.test.ts`, 60 pass and 0 fail. Source commit `9d8ab96c06451f40c4d5cacaf9c6b85070d267cd`.

### Clean package

Built with `npm run package` from that commit. `OPEN_VS_CODE_ALLOW_DIRTY_PACKAGE` was unset. `git status` was clean and the release stamp records `gitDirty: false` and `sourceClean: true`.

- Product version: `0.1.0-rc.11`
- Source SHA: `9d8ab96c06451f40c4d5cacaf9c6b85070d267cd`
- Debian: `apps/desktop/dist/open-vs-code_0.1.0-rc.11_amd64.deb`
- Debian SHA-256: `36a7b49b22f7a2215f2db4f296b463a5e6df868e8ac847ec1a7d8cc793d64541`
- Payload archive SHA-256: `ea5f9f628bfcf23d19dd014899e273f05b682455688131ad7404ea4fe206ef2b`
- Bundled extension: `open-vs-code.vscode-integration` `0.1.0-rc.11`
- Upstream shell: VSCodium `1.135.06055`, commit `5a73682ca091082675b10c9dc3f348c1d824d94f`
- The bundled `extension.js` calls `reviewsForRun` for every outcome and returns no reviews when the run id is missing. Its claim pattern matches `passed` and `succeeded`, not a bare `pass`.

### Installation

Not performed. `sudo` on this machine needs the owner's password, and this sprint does not bypass that. After the owner installs it:

```text
sudo dpkg -i "apps/desktop/dist/open-vs-code_0.1.0-rc.11_amd64.deb"
```

Do not add `--no-sandbox`. The package `postinst` sets `chrome-sandbox` to `root:root` mode `4755`.

### Rollback

Installed desktop is still `0.1.0-rc.9`, commit `bb07b1481d5465cb9e1b88589da17fa21a6f609d`, extension `0.1.0-rc.9`, `chrome-sandbox` `4755 root:root`.

The original rc.9 `.deb` is not on disk. A rollback package was rebuilt from the installed files, and every regular file under `usr/` matches `/var/lib/dpkg/info/open-vs-code.md5sums` (2545 files, 0 mismatches). The container hash is the hash of that rebuild, not of the original archive.

- Rollback deb: `~/open-vs-code-backups/rollback-0.1.0-rc.9-2026-11-08/open-vs-code_0.1.0-rc.9_amd64.deb`
- Rollback SHA-256: `b9b312ac965b0f5ce9bb9fbdb4338d9ffddb73e72bea98001cc6b9fb39fac297`

```text
sudo dpkg -i ~/open-vs-code-backups/rollback-0.1.0-rc.9-2026-11-08/open-vs-code_0.1.0-rc.9_amd64.deb
```

Profile copy, taken before any candidate install and without replacing earlier backups: `~/open-vs-code-backups/pre-0.1.0-rc.11-2026-11-08/Open VS Code` (188 files). The earlier `pre-0.1.0-rc.10-2026-11-08` copy was left in place. The live profile was not modified.

### Installed GUI

Not run. There are no new screenshots and no new in-window `qwen3-coder:30b` session. Provider checks from Sprint 14B.1 are not this acceptance.

## Earlier presentation evidence

The checks below are the first Sprint 14B presentation pass. They are not the 14B.1 or 14B.2 release record. The sections above replace the earlier statement that no package had been cut and that `0.1.0-rc.8` was still the installed desktop.

Mocked at that pass:

- `packages/vscode-integration/tests/sprint-14b-conversation-ux.test.ts`: 5 pass
- `packages/vscode-integration/tests/sprint-7a-chat-ux.test.ts`: 27 pass
- `packages/vscode-integration/tests/sprint-7a-webview-runtime.test.ts`: 1 pass
- `packages/vscode-integration/tests/sprint-7b-terminal-diff.test.ts`, `chat-ux.test.ts`, `sprint-7c-sessions.test.ts`: 47 pass
- `packages/agent-core/tests/agent/response-guidance.test.ts` and `coding-reliability-11a1.test.ts`: 36 pass
- `tsc --noEmit` in `vscode-integration` and `agent-core`: pass
- `oxlint --deny-warnings` on the agent-core response guidance and runner: pass
