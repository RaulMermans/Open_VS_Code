# Sprint 7A — Cursor-like Agent Experience & Chat UX

Status: **SPRINT_7A_PARTIALLY_VERIFIED** (deterministic extension-host tests green; live VSCodium GUI/theme walkthrough blocked in this environment; no HALO host required).

Baseline: GitHub `main` `3d685ba1fe9071ab52448af82c2f343630c8a5d5`.
Branch: `sprint/7a-agent-experience`.

Architecture preserved:

```text
VS Code Webview → ChatController → AgentSessionBridge → Agent Runtime → Provider/Tools
```

The presentation layer is not a second agent engine. `ContextCompiler` remains the authority over prompt contents. `PermissionGate` remains the authority over side effects.

---

## Baseline UX audit

Inspected: `chat-view-provider.ts`, `chat-controller.ts`, `chat-protocol.ts`, `webview-render-helpers.ts`, `diff-review-controller.ts`, `terminal-review-controller.ts`, `extension.ts`, `packages/ide-adapter`, `packages/agent-core`, existing chat/diff/terminal/security tests.

| Area | Classification |
| :--- | :--- |
| ASK/PLAN/BUILD/DEBUG/REVIEW mode selector | Already implemented and sufficient; header chrome improved |
| Send / cancel / duplicate-submit guard | Already implemented; composer loading/cancel UX improved |
| Confirmation ID matching, stale-result rejection, cancel-during-approval | Already implemented and sufficient; double-click lock added in the Webview |
| DiffReviewController + TerminalReviewController | Already implemented and sufficient; command/cwd made more visible |
| Strict CSP, `parseWebviewMessage`, `textContent` rendering | Already implemented and sufficient |
| Transcript bounds (100 messages / 200k chars) and activity bound (50) | Already implemented and sufficient; tests added |
| `retainContextWhenHidden` | Missing and in scope — added |
| Header: mode + backend identity + connection state + New conversation | Implemented but needed UX improvement — done |
| Distinct user/assistant messages, code fences, copy, file refs | Missing / thin — done |
| Explicit file/selection attachments with `@` search | Missing and in scope — done (descriptors only) |
| Honest activity timeline from real agent events | Thin labels — mapped from actual events, no fake progress |
| Incremental transcript rendering | Missing — `syncTranscript` now skips unchanged nodes |
| Truthful connection/HALO status | Missing — `deriveConnectionStatus`; HALO never Ready without health check |
| Token-by-token model streaming | Missing but deferred (provider/bridge contracts are event-based) |
| Persistent multi-session storage | Missing but deferred (Sprint 7C) |
| MCP/Skills marketplace, Custom Modes, Capability Packs, Design/RE modes, browser | Missing but deferred |

---

## Implemented changes

### Header
Mode selector, connection status (backend · model · Ready/Running/Disconnected/Unavailable/Not configured/… ), New conversation. Connection control opens model config or runs a health check. HALO is never shown Ready unless `haloHealthChecked && haloReachable`.

### Conversation
Distinct user/assistant/system styles via VS Code theme variables. Code fences render as `textContent` with Copy. Backticked file paths open through `ui.openFile`. Tool activity is a compact timeline from real `AgentEvent`s. Failed/cancelled messages are labeled for assistive tech (`aria-label`, `role="log"`).

### Composer
Multiline textarea. Enter sends, Shift+Enter newline, Escape cancels. Disabled while a turn is active. Duplicate sends blocked in the Webview (`sendInFlight`) and host (`activeTurn`). Explicit attachments shown as removable chips. `@query` searches workspace files; selecting a hit attaches a descriptor and strips the `@` token.

### Context (Phase C)
UI selects and describes context. Attachments never carry file bytes. `formatAttachmentInstruction` tells the agent to read via tools. `ContextCompiler` still compiles the prompt. Sensitive paths (`.env`, keys), ignored trees (`node_modules`, `.git`, `dist`, …), untrusted workspaces, and path escapes are marked unavailable. Max 8 attachments.

### Execution visibility (Phase D)
`activityFromAgentEvent` maps real events only. Unknown events produce no row. No progress percentages. Pending activities are completed or cancelled with the turn. Timeline shows at most 20 recent rows.

### Approvals (Phase E)
Existing confirmation identity, dirty-file block, and terminal exact-ID routing kept. Webview locks Approve/Reject after the first click. Stale `ui.openDiff` (wrong mutationId) is ignored. Cancellation rejects the pending confirmation and marks activities cancelled.

### Connection (Phase F)
Standalone local vs HALO vs missing/invalid config vs unreachable vs bad credentials vs missing model vs timeout. Actionable navigation to Create/Open Model Config or Check HALO Connection. No model downloader, no cloud fallback, no HALO-online claim without a probe.

### Performance / a11y / security
- Incremental transcript: unchanged messages keep their DOM nodes.
- Injected Webview runtime concatenates helper `toString()` sources (`webviewRenderRuntime`) so sibling closures (`setText`, `fillMessageBody`, `MAX_CODE_CHARS`) exist in the script tag.
- CSP unchanged: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-…'`.
- Untrusted output still assigned with `textContent` only.
- Visible `:focus-visible`, `sr-only` labels, `aria-live` on connection and transcript.

---

## Files modified

| File | Change |
| :--- | :--- |
| `packages/vscode-integration/src/chat-ux-model.ts` | **Added.** Path/search sanitization, connection derivation, activity mapping, attachment descriptors |
| `packages/vscode-integration/src/chat-protocol.ts` | Attachments, connection DTO, context/file/config Webview messages |
| `packages/vscode-integration/src/webview-render-helpers.ts` | Code/file segments, incremental `syncTranscript`, timeline, chips, connection, confirmation lock, `webviewRenderRuntime` |
| `packages/vscode-integration/src/chat-view-provider.ts` | Header/composer/timeline CSS+HTML, keyboard, `@` picker, injected runtime |
| `packages/vscode-integration/src/chat-controller.ts` | Attachments, connection, activity, confirmation in-flight, dispose, optional IdeHost methods |
| `packages/vscode-integration/src/extension.ts` | `retainContextWhenHidden`; IdeHost search/pick/open/connection; guarded `dispose` |
| `packages/vscode-integration/tests/sprint-7a-chat-ux.test.ts` | **Added.** Contract tests 1–14 |
| `packages/vscode-integration/tests/sprint-7a-webview-runtime.test.ts` | **Added.** Bundled runtime eval |
| `packages/vscode-integration/tests/extension.test.ts` | Mock `getConfiguration` / `findFiles` / `Uri` |
| `packages/vscode-integration/tests/security-eval.test.ts` | webview.10 asserts `.message-body` `textContent` |
| `docs/sprints/SPRINT_7A_AGENT_EXPERIENCE.md` | This record |
| `docs/sprints/README.md`, `PROJECT.md`, `PLAN.md`, `README.md`, `docs/adrs/ADR-018-chat-ux-layer.md`, `ARCHITECTURE.md` | Status pointers |

---

## UX behavior and interaction contracts

1. **Modes.** Changing the selector sends `chat.setMode`. ASK/PLAN/BUILD/DEBUG/REVIEW remain the only values `parseWebviewMessage` accepts.
2. **Send.** Empty text is ignored. `activeTurn` or `sendInFlight` drops duplicates. Enter sends; Shift+Enter inserts a newline.
3. **Cancel.** `chat.cancel` aborts the turn, rejects a pending confirmation, cancels pending activities, and invalidates that confirmation id.
4. **Attachments.** Descriptors only. Instruction appendix is not file content. Unavailable chips stay visible and are not opened.
5. **Search.** `@` / `@ File` uses `vscode.workspace.findFiles` with ignore globs, max 20 hits, query ≤ 80 chars. Paths must be relative and sanitizable.
6. **Open file.** Host sanitizes the path, contains it under the workspace root, then `openTextDocument`.
7. **Approvals.** Exact `confirmationId`. Second click is a no-op. Stale ids are ignored. `ui.openDiff` only for the live `pendingConfirmation.mutationId`.
8. **Terminal.** Card shows exact command, cwd, provenance, timeout. Execution remains `VerificationEngine` with `shell: false`.
9. **Connection.** Ready for HALO only after a successful health check. Standalone local is Ready only after a completed turn in this session (`endpointVerified`). Missing config is honest and points at Create Starter Model Configuration.
10. **Streaming.** Not implemented. The timeline reports `Waiting for the model` from `model.requested` until `model.completed` / failure.

---

## Upstream inspiration / reuse ledger

Visual inspiration only. **No Cursor proprietary code or assets were reused.**

| Source | URL | License | Version / commit | Purpose | What was reused | Verification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Cursor (product UX) | https://cursor.com | Proprietary | n/a | Keyboard-first composer, distinct transcript roles, compact activity, explicit @-file mentions | Inspiration only — layout and interaction ideas | Compared against existing Open VS Code chat; no source copied |
| VS Code Copilot Chat | https://github.com/microsoft/vscode-copilot-chat | MIT | Archived 2026-05 (see `REFERENCE_MAP.md`) | Webview chat + agent session presentation | REFERENCE_ONLY — already recorded; not copied this sprint | Re-read map entry; kept ADR-018 presentation-only boundary |
| VS Code theme / a11y tokens | https://github.com/microsoft/vscode | MIT | Editor 1.90+ API used by the extension | `--vscode-*` colors, `focusBorder`, live region conventions | Token names only, via `vscode` API types | CSS uses documented CSS variables; no editor source copied |
| VSCodium desktop shell | https://github.com/VSCodium/vscodium | MIT | Pinned in ADR-028 (`1.135.06055`) | Host for the bundled extension | Unchanged this sprint | Not rebuilt for 7A unit tests |

No new npm UI libraries. No additional runtime dependencies.

---

## Tests and verification

New tests (`packages/vscode-integration/tests/sprint-7a-*.test.ts`):

1. Mode selection, send, cancel, duplicate submission
2. File attach / remove / search / open
3. Workspace trust → unavailable
4. Tool activity from real events; disconnected error classification
5. Confirmation identity, stale rejection, cancel during approval
6. Terminal command/cwd + stale `openDiff`
7. Untrusted HTML/code remains `textContent`
8. Transcript/activity bounds
9. Keyboard Enter vs Shift+Enter
10. Webview listener dispose
11. Incremental render (0 created / 0 updated on unchanged 80-message sync)
12. Bundled `webviewRenderRuntime()` parses fences without executing markup

Regression: `npm test` at repo root, Node 22.23.2, 2026-10-24:

| Workspace | Result |
| :--- | :--- |
| `@open-vs-code/agent-core` | 617 pass / 0 fail |
| `@open-vs-code/ide-adapter` | 21 pass / 0 fail |
| `@open-vs-code/cli` | 7 pass / 0 fail |
| `@open-vs-code/vscode-integration` | 45 pass / 0 fail |

`npm run lint`: agent-core and cli oxlint `--deny-warnings` pass. vscode-integration has no package lint script.

`npm run build` (`packages/vscode-integration`): esbuild `dist/extension.js` 843 kb, exit 0.

`npm run typecheck`: `tsc --noEmit` for vscode-integration and agent-core stayed idle in this environment (no file list, ~0% CPU). Ship path for the extension is esbuild.

`npm run desktop:smoke`: 4/13 pass, 9 fail because `apps/desktop/dist/Open VS Code.app` is not present (no cached VSCodium staging). `desktop:accept` was not run for the same reason. This is an environment packaging gap, not a chat-runtime regression.

Scripted providers / fixtures only. No live inference. No HALO host. `npm ci` was not re-run; the existing workspace install was used.

---

## Performance findings

Measured in the mock DOM used by `sprint-7a-chat-ux.test.ts` (Node 22.23.2, 2026-10-24). This is representative of the `syncTranscript` path, not a VS Code GPU/layout profile.

| Path | Result |
| :--- | :--- |
| First render of 80 fenced messages | 80 nodes created |
| Second sync of the same 80 messages | **0 created, 0 updated** (signature skip) |
| Incremental append of 1 message onto 99, repeated 15× | **&lt; 20 extra nodes**; test duration 9–22 ms |
| Host transcript bound | ≤ 100 messages, ≤ 200_000 content chars |
| Host activity bound | ≤ 50 entries; view shows last 20 |
| Attachments | ≤ 8 |
| Code fence body | truncated at 100_000 chars |

Full Chromium/VS Code heap traces were not taken (GUI blocked). Token streaming was not added, so there is no per-token DOM churn.

---

## Known limitations

- Live VSCodium webview (light/dark theme pixels, screen reader, real keyboard focus in the packaged app) was not walked in this environment.
- `tsc --noEmit` for `@open-vs-code/vscode-integration` did not finish (process idle). Ship path is esbuild (`npm run build` in that package). Other workspaces typecheck independently.
- Token-by-token assistant streaming is deferred.
- `@` search is substring `findFiles`, not a fuzzy workspace index.
- Standalone-local Ready is session-local (`endpointVerified` after a completed turn), not a background `/v1/models` poll (avoids unapproved network calls).
- Composer draft persistence uses `webview.setState` only; multi-session storage is Sprint 7C.
- V1.1 flags (`skills`, `workflow`, `progressMonitor`, `learning`) remain default-off.

---

## Deferred functionality

- HALO real-model acceptance and V1.1 benchmark
- Capability Pack Registry, Custom Modes, MCP/skill marketplace
- Browser/Playwright integration, Design Mode, Reverse Engineering Mode
- Persistent multi-session chat (Sprint 7C)
- Token streaming once the provider/bridge emit incremental text events
- New agents, memory architecture, cloud fallback, VSCodium fork

---

## Next-sprint recommendations

1. **Sprint 7B (optional polish):** live GUI checklist on the packaged desktop (theme, NVDA/VoiceOver smoke, composer focus after panel restore).
2. **Streaming follow-up:** add an explicit `model.delta` (or equivalent) to the provider contract; until then keep event-based progress.
3. **Sprint 7C:** durable conversation list and restore, still bounded, still not a second memory engine.
4. Keep MCP/Skills/Modes/Capability Packs as additive header/slots — the 7A chrome leaves room without implementing them.

---

## Verification closure (Sprint 7B, 2026-10-24)

Closed in Sprint 7B from a fresh clone outside iCloud. Full detail: `docs/sprints/SPRINT_7B_TERMINAL_DIFF_EXPERIENCE.md` §1.

- **Typecheck "hang" — environmental.** This record was produced in an iCloud-synced checkout whose files were evicted ("dataless"), so reads blocked at ~0% CPU. Off iCloud, `tsc --noEmit` for this package completes in 1.84 s (319 files).
- **Two type errors this sprint shipped were hidden by the hang** and are now fixed: `chat-ux-model.ts` attachment label could be `undefined`; `webview-render-helpers.ts` segment union was not narrowed. `npm run typecheck` passes for all workspaces.
- **Packaged desktop works.** `desktop:prepare` + `desktop:package` succeed; `desktop:smoke` 13/13 and `desktop:accept` 3/3 on the 7A baseline. The "missing app bundle" above was a missing local cache, not an application failure.
- Correction: the regression table above swaps two counts. `@open-vs-code/cli` has 21 tests and `@open-vs-code/ide-adapter` has 7.
- Still open: human live-GUI theme / screen-reader walkthrough.
