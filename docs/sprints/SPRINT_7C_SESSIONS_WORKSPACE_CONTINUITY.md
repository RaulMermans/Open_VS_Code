# Sprint 7C — Persistent Conversations, Workspace Sessions & Recovery UX

Status: **SPRINT_7C_PARTIALLY_VERIFIED**. Acceptance criteria 1–9 are met by automated evidence, including a real packaged-VSCodium restart test. A person has not yet walked through the live GUI: theme pixels and VoiceOver output (§10). No HALO host or live model was used; inference is mocked or absent.

Baseline: GitHub `main` `30e3c790f06b4d9976f6e326f870ca513c55b045` (Sprint 7B, PR #37).
Branch: `sprint/7c-sessions-workspace-continuity`.

Architecture preserved:

```text
Webview → ChatController → AgentSessionBridge → AgentRunner → PermissionGate → MutationEngine / VerificationEngine
                │
                └─ ConversationStore (display history only, VS Code workspace storage)
                └─ inspectRunRecovery (read-only, Agent Core checkpoints + journal)
```

No new execution path, permission path, memory engine or dependency.

---

## 1. Architecture decisions (ADR-033)

| Concern | Authority | Changed in 7C |
| :--- | :--- | :--- |
| What the chat shows across restarts | **`ConversationStore`** (new, `vscode-integration`) | Added |
| Agent memory between tasks | `SessionSummaryStorage` → `.open-vs-code/sessions.jsonl` (ADR-013) | Untouched; never read or written by 7C |
| Execution durability | `CheckpointStore` + `OperationJournal` (ADR-025) | Untouched |
| Interrupted-run classification | `RecoveryController.buildRecoveryPlan` (ADR-025) | Gained `persistReconciliation: false` for read-only use; default unchanged |
| Side effects | PermissionGate → `MutationEngine` / `VerificationEngine` | Untouched |

Decisions:

- **Location.** History lives in `ExtensionContext.storageUri/conversations/`. That directory is editor-owned and per-workspace, outside the repository, and never committed. With no folder open, history is off and the UI says so.
- **Workspace identity.** `w-` + 24 hex characters of the SHA-256 of the realpath'd workspace root, so a symlinked alias is the same workspace. It is written into every record and the index, and checked on every read.
- **Switching during an active task is refused.** It is not supported through isolated execution ownership. Today the controller holds one live bridge, one resolver and one terminal registry, so moving a running task between conversations would mean detaching it. Refusal is the safe choice the brief allows, and the running task is never cancelled or moved.
- **Executable resume is not offered** (§4).

## 2. Persistence schema (v1)

`conversations/<id>.json`:

```jsonc
{
  "schemaVersion": 1,
  "id": "c-0123456789abcdef",          // only this form is accepted anywhere
  "workspaceId": "w-…24 hex…",
  "title": "Fix login on Safari",      // ≤ 80 chars, one line, redacted
  "titleSource": "auto" | "user",
  "createdAt": 1729760000000, "updatedAt": 1729760050000,   // updatedAt strictly increasing per window
  "mode": "ASK|PLAN|BUILD|DEBUG|REVIEW",
  "messages": [ { "id", "role": "user|assistant|system", "content", "timestamp", "status"?, "attachments"?, "inherited"? } ],
  "attachments": [ { "kind", "label", "path"? /* workspace-relative */, "truncated"?, "unavailable"?, "reason"? } ],
  "reviews": [ /* "Changes & commands" rows: id, kind, status, path?, line counts, hashes, command, exit, detail */ ],
  "lastStatus": "idle|running|completed|failed|cancelled|interrupted",
  "runIds": ["session-1729760000000"],  // ≤ 10, links to Agent Core runs
  "archived": false,
  "checksum": "sha256(canonicalSerialize(record without checksum))"
}
```

`conversations/index.json` holds `{ schemaVersion, workspaceId, conversations: Summary[], checksum }`. It is a cache: each load reconciles it with the record files and rebuilds it when needed.

**Never stored:** credentials or tokens, pending confirmations or resolvers, tool output, terminal output, diff content, hidden reasoning, workspace file contents, runtime objects. The activity timeline isn't stored either, to avoid keeping tool traces.

| Bound | Value |
| :--- | :--- |
| Conversations per workspace | 50 (least recently updated evicted; the open one is protected) |
| Messages / characters per conversation | 100 / 200,000 (newest kept) |
| Characters per message | 50,000 (same as the send limit) |
| Bytes per record | 512 KiB (oldest messages dropped first) |
| Ledger rows / run ids / attachments | 20 / 10 / 20 |
| Quarantined files kept | 5 |

**Write path:** a per-store serialized queue → exclusive (`wx`, mode 0600) temp file with a unique name → `fsync` → atomic `rename`. **Read path:** plain-directory check → regular-file `lstat` → `open(O_NOFOLLOW)` → size cap → JSON → schema → workspace → id → checksum → the same `sanitizeConversation` boundary as on save. Secrets are redacted with Agent Core's `redactRuntimeEvalSecrets`.

## 3. Lifecycle

`lastStatus` transitions, all performed by `ChatController`:

| From | Event | To | Saved? |
| :--- | :--- | :--- | :--- |
| (new) | first user message sent | `running` | yes (record created) |
| any | send | `running` | yes |
| `running` | `task.started` | `running` (+ run id) | yes |
| `running` | confirmation requested | `running` (ledger row only, never the decision) | yes |
| `running` | change/command outcome | `running` | yes |
| `running` | result COMPLETED / FAILED / CANCELLED | `completed` / `failed` / `cancelled` | yes |
| `running` | thrown error / no workspace | `failed` | yes |
| `running` | "New" + user chooses Cancel | `cancelled` | yes |
| `running` | editor closes or crashes | stays `running` on disk | — |
| `running` (on disk) | next start / open | shown as **`interrupted`**; pending/running ledger rows → `interrupted` with an explanation | no rewrite until the next save |

Operations:

- **Create.** "New" or *Open VS Code: New Conversation*. A conversation is not saved until it has a message of its own.
- **Open/switch.** From the picker or *Open VS Code: Show Conversation History* (native quick pick). Refused, with an explanation, while a task or decision is active.
- **Rename.** F2 or Rename in the picker; an empty title reverts to the derived one.
- **Archive/Unarchive.** Reversible; archived conversations are hidden unless "Show archived" is on.
- **Delete.** Native modal confirmation that says files, checkpoints and agent memory are not changed. Refused for the open conversation while it runs.
- **Restart.** The most recent non-archived conversation reopens. No task starts and no approval is restored.
- **Continue in a new conversation.** Copies ≤ 6 earlier user/assistant turns (≤ 8,000 characters) marked "from an earlier conversation". They reach the runtime only as prior `recentTurns`, never as the instruction or as system text. The new conversation is saved once the user writes in it.

## 4. Recovery boundaries

The recovery view (title-bar "Recovery" for interrupted, failed or cancelled conversations, and in the picker) is **read-only**. `inspectRunRecovery` (agent-core):

- refuses unsafe run ids before touching disk;
- returns `NO_RECORD` for unknown runs and creates nothing;
- builds the plan through `buildRecoveryPlan(runId, { persistReconciliation: false })`, so the disposition comes from the one planner and journal and checkpoint bytes stay identical;
- reports states, codes, the latest checkpoint's reason, phase, status and process epoch, ≤ 20 operation summaries (journal → observed status), and ≤ 20 workspace-relative paths;
- always returns `executableResume: false`.

| View state | Meaning |
| :--- | :--- |
| `NO_RUN` / `NO_RECORD` | No run recorded / no checkpoint or journal remains |
| `COMPLETED` | Nothing waiting |
| `STOPPED` | Failed or stopped; Agent Core forbids automatic retry |
| `INTERRUPTED` | Between steps; no unfinished operation |
| `REVERIFY` | A change was found applied, or a check was interrupted; re-run checks |
| `RECONFIRM` | Was waiting for approval; that approval ended with the run and nothing was applied by it |
| `MANUAL_INSPECTION` | Diverged or ambiguous (e.g. an interrupted MCP side effect); inspect the listed files |
| `UNREADABLE` | Corrupt records; the code is shown, never the content |

The view separates three things a user might mean by "recover":

1. **Conversation display.** Restored. Restoring runs nothing and grants no approval.
2. **New task with this context.** A button that starts a new conversation with inherited turns. Every change and command needs a new approval.
3. **Resume the interrupted run.** *Not available from the editor.* `AgentRunner.resumeFromRecovery` exists, but no runtime surface reaches it from the editor, and doing it safely needs a UI re-authorization contract (ADR-033 §5). There is deliberately no resume button.

## 5. UX

- **Title bar** under the header. It shows the active conversation's title, plus a status badge (Interrupted/Failed/Cancelled) and a Recovery button when relevant.
- **History panel** (toggle `History`, `aria-expanded`/`aria-controls`):
  - Filter box over title, first-message preview and mode; "Show archived" toggle.
  - Items most recent first: title, relative time, mode, message count, status, and Current/Archived markers. The active item has `aria-current="true"` and a focus-border accent.
  - Actions per item: Rename (inline field), Continue, Archive/Unarchive, Delete, Recovery.
  - Empty and error states: no workspace, no conversations yet, no filter match, only archived, and damaged files set aside or newer-version files left untouched.
- **Keyboard:** ↓ from the filter enters the list. ↑/↓/Home/End move between items, Enter opens, F2 renames (Enter saves, Escape cancels), Delete asks the host (modal), and Escape closes the panel and returns focus to the History button. Opening a conversation closes the panel and focuses the composer.
- **Themes:** only `--vscode-*` tokens (list hover and selection, input, badge, validation-warning, focus border). No new colours.
- **Restored ledger:** command rows with no live output hide "Output"; applied changes still open through Git or the file (host-resolved, containment-checked).
- **Native:** *Open VS Code: Show Conversation History* (quick pick with match-on-detail) and *Open VS Code: New Conversation*.

## 6. Files changed

| File | Change |
| :--- | :--- |
| `packages/vscode-integration/src/conversation-store.ts` | **Added.** Store, sanitization boundary, restore projection |
| `packages/vscode-integration/src/chat-controller.ts` | Store wiring, lifecycle saves, open/rename/archive/delete/continue/inspect, busy refusal, monotonic save time |
| `packages/vscode-integration/src/chat-protocol.ts` | Conversation/recovery DTOs, `interrupted` ledger status, `outputAvailable`, 7 validated messages |
| `packages/vscode-integration/src/webview-render-helpers.ts` | Title bar, history panel, recovery panel, inherited-message label, restored-row actions |
| `packages/vscode-integration/src/chat-view-provider.ts` | History panel markup, CSS (theme tokens), page-script wiring |
| `packages/vscode-integration/src/extension.ts` | Store bound to `storageUri`; two commands; flush on deactivate (after the synchronous cleanup) |
| `packages/vscode-integration/package.json` | Two contributed commands |
| `packages/agent-core/src/recovery/recovery-inspection.ts` | **Added.** Read-only inspection |
| `packages/agent-core/src/recovery/recovery-controller.ts`, `recovery/index.ts` | `persistReconciliation` option; export |
| `packages/agent-core/src/tools/path-safety.ts` | Symlinked-root re-rooting (§9) |
| Tests | `vscode-integration/tests/sprint-7c-sessions.test.ts` (**added**, 29), `tests/helpers/process-tree.ts` (**added**), `agent-core/tests/recovery/recovery-inspection.test.ts` (**added**, 8), `agent-core/tests/tools/path-safety-symlink.test.ts` (**added**, 4), PID-race fix in `security-eval`, `terminal-core-e2e`, `sprint-7b-terminal-diff`; `apps/desktop/smoke/desktop-runtime-acceptance.test.ts` (test 4 + 2 commands) |
| Docs | This record, ADR-033 (**added**), ADR-013/018/025 notes, `DECISIONS.md` (both), `PROJECT.md`, `PLAN.md`, `REFERENCE_MAP.md`, `docs/SECURITY_MODEL.md`, `docs/sprints/README.md`, 7B record note |

## 7. Tests and evidence

Requirement → test (`S` = `sprint-7c-sessions.test.ts`, `R` = `recovery-inspection.test.ts`, `P` = `path-safety-symlink.test.ts`):

| Requirement | Evidence |
| :--- | :--- |
| Multiple independent conversations | S1, S12 |
| Switching and reopening | S12, S15 |
| Editor restart simulation | S2, S12, S13, S14; **packaged:** `desktop:accept` test 4 |
| Workspace isolation | S3 (foreign records never listed, read or modified; alias = same id; id contains no path) |
| Title and metadata | S4, S12 |
| Storage corruption | S5 (torn, tampered, wrong-id, garbage index; quarantine bounded), S19b |
| Capacity and retention | S6 (count with protected active, messages, characters, bytes) |
| Secret redaction | S7 (OpenAI-style, GitHub, AWS, JWT, password, private key; title too) |
| Invalid schema versions | S8 (newer left byte-identical; 0 and "1" set aside) |
| Concurrent writes | S9 (40 writes + renames across two stores: no temp files, no torn record) |
| Path traversal and symlink escape | S10, S11 (outside link, in-root link, smuggled record symlink), R2, R8 |
| Pending approval isolation | S13 (switch refused mid-decision, task not aborted, saved record holds no confirmation, old id resolves nothing after restart), S18 |
| Interrupted execution display | S2, S14, S14b (real journal → REVERIFY, journal unchanged), R3–R7 |
| No side-effect replay | S15 (open/inspect/continue start no turn and no confirmation), S14b, R3 |
| Keyboard and UI state | S20–S22, **S25 (the real generated page script run against a fake DOM)** |
| Bundled webview runtime | S23 |
| Separation from agent memory | S11b |
| Ordering determinism | S12b |
| Symlinked workspace verification | P1–P4 |
| Existing 7A/7B behaviour | Full suite unchanged and green |

**Adversarial check.** Each 7C safety mechanism was removed in turn and the suites re-run. **All 16 mutants were killed:** busy refusal, interrupted-on-restore, pending-row restore, redaction, store id check, storage-directory plain check, checksum, workspace id, newer-schema untouched, retention, ledger save at request, monotonic save time, seed bound, restored-row output hiding, inspection read-only, symlink re-rooting. Two first survived:

- The storage check: `lstat` already reports a symlink as a non-directory, so that mutant was equivalent. A mutant removing the whole check was then killed by a new in-root-link case.
- The monotonic timestamp: it was only caught on unlucky timing. A frozen-clock test now kills it deterministically.

A separate mutant of the page script (panel never un-hidden) was killed by S25.

Gate on the final branch (Node 22.23.2, macOS arm64, clean clone outside iCloud):

| Check | Result |
| :--- | :--- |
| `npm test` | **748 / 748**: agent-core 629 (617 + 12 new), cli 21, ide-adapter 7, vscode-integration **91** (62 + 29 new) |
| `npm run typecheck` | exit 0, all workspaces |
| `npm run lint` | exit 0. `npm run lint` covers agent-core and cli only. vscode-integration has no lint script and 67 findings that predate this sprint; the 7C files lint clean with `--deny-warnings`, and the 7C diff adds no finding |
| `npm run build` | exit 0; `dist/extension.js` 943.7 kb |
| `npm run desktop:package` | exit 0, ad-hoc signed and strictly verified; archive SHA-256 `5d5b809c38b982af889661125d8ac87893984325f34b0426dfd490002b9ba1d3`; the bundled `extension.js` is byte-identical to the final build |
| `npm run desktop:smoke` | **13 / 13** |
| `npm run desktop:accept` | **4 / 4**: GUI launch and shutdown, extension activation with all 15 commands registered, archive and codesign, **packaged restart restores the saved conversation** |
| vscode-integration repeated | 10 consecutive full `vscode-integration` runs: **10 / 10 green** (91 / 91 each) |

**Packaged restart test** (`desktop:accept` test 4) launches the real packaged app twice with one profile and workspace. Phase 1 drives the live `ChatController` through the module's existing `_testSeam`: it sends a message (the turn fails with *No model configuration found*, as expected), renames the conversation and flushes. The test checks that the record is in `User/workspaceStorage/<hash>/open-vs-code.vscode-integration/conversations/` and not in the workspace. Phase 2, a new process, checks that the same conversation reopens with identical messages, title and status, `activeTurn: false`, and no pending confirmation. Its first run failed on a test defect: a missing key versus `status: undefined` after the JSON round trip. That was fixed by normalising the field, not by relaxing the comparison.

## 8. Sprint 7B security-flake investigation

| Item | Finding |
| :--- | :--- |
| Test names | `Security Evaluation — Sprint 4A.2` in `packages/vscode-integration/tests/security-eval.test.ts`. The file reports **7 tests**: a parent plus subtests Comparator, Run 1, Run 2, Determinism, All pass, Count. "6 failures" is exactly every test except the comparator check. That happens only when **both Run 1 and Run 2 throw**: `rec()` asserts inline, and the later subtests read `run1!`/`run2!`. |
| Execution conditions | One of 21 runs in 7B, straight after `tsc`. Its output was not captured. |
| Shared resources and global state | Both runs share one process: the extension module's globals (`_testSeam` controllers, abort controller), `process.env` (scenarios set and delete secrets), and live process trees from two scenarios (`terminal.13`, `lifecycle.4`). On failure, neither scenario aborted its tree or reset the injected controllers, so a failed Run 1 left a running parent and child (30 s timeout) and extension globals behind for Run 2. |
| Process lifecycle factor (root cause) | The children published their PIDs with `fs.writeFileSync(pidFile, pid)`, which **creates the file before writing it**. The harness polled `existsSync` and then `parseInt(readFileSync(…))`. If it read inside that window it got `NaN`; `process.kill(NaN, 0)` throws, so `aliveBefore = false` and the scenario failed. In the 7B harness `Number("") === 0`, and `process.kill(0, 0)` signals the process group, so it reports "alive"; the later death wait then times out. |
| Reproduction | 6 runs under 3× CPU oversubscription (33 busy loops on 11 cores) passed, each still finishing in about 0.5 s: plain CPU load does not open the window enough. **Deterministic reproduction of the mechanism:** a child that creates the file, is descheduled (150 ms) and then writes, read with the harness's own polling, records `{"pid":null,"aliveBefore":false}`. Atomic publication records the real PID. |
| Root cause | **Established for the mechanism, not proven for the original incident**, whose output was lost. It is the only timing-sensitive defect found that can fail one scenario in both runs. A failed Run 1 also leaks a live tree and globals into Run 2, which explains the 6-failure signature. Other candidates were examined and excluded: the `deactivate()` disposal check (`disposed` is set synchronously), environment mutation (balanced in `finally`), and stdout bounds (deterministic). |
| Fix | `tests/helpers/process-tree.ts`: children publish PIDs atomically (temp file + rename). The harness waits **by deadline** until the file holds a positive integer. Process death is awaited up to 5 s instead of 1.25 s; the assertion is unchanged: both must die. Failure paths now always abort and `SIGKILL` their tree and reset injected extension controllers. Applied to `security-eval` (2 scenarios), `terminal-core-e2e` (3) and the 7B suite (1). **No assertion was weakened**; every expected value is unchanged. |
| Product code | Not involved. `VerificationEngine` and the process-tree kill were never at fault. |

## 9. Symlinked-workspace verification

**Fixed.** `resolveRepositoryPath` realpath'd the root but checked an *absolute* request lexically against that canonical root. A workspace opened through a symlink (macOS `/var` → `/private/var`, or a symlinked project folder) therefore rejected `cwd = workspaceRoot` with `OUTSIDE_WORKSPACE`.

The fix: when an absolute request is not inside the canonical root but is lexically inside the *given* root, re-root it onto the canonical root. The realpath containment check that follows is still the authority.

Regression tests P1–P4:

- Paths through the symlink resolve. The canonical and relative spellings still work.
- `..` traversal, sibling-prefix (`link-evil`), outside absolute paths, an inner symlink pointing outside, and the parent directory are all still rejected.
- `VerificationEngine` runs with `cwd` = the symlinked root (previously `EXECUTION_ERROR … outside workspace`). A `cwd` outside still fails closed.

Without the fix, P1 and P3 fail.

## 10. Accessibility and live GUI checklist

Automated: S20–S22 and S25 cover the panel's keyboard model, focus return, `aria-expanded`/`aria-controls`/`aria-current`, labelled buttons, empty states and a re-render that creates no elements (so focus survives state pushes).

**Not done, and not claimed:** a person has not run the packaged app to check light, dark and high-contrast pixels, VoiceOver announcements of the title bar, status badge and history items, or narrow-sidebar wrapping. No suitable assistive-technology session was available to this run. The 7B checklist items (approval-card focus, ledger, command box) also remain open.

To do in the packaged app:

1. History panel in light, dark and high-contrast: active-item accent, archived italics, focus outlines, warning badge contrast.
2. Keyboard: History → filter → ↓ into list → F2 rename → Escape → Delete (modal) → Escape closes with focus back on History.
3. VoiceOver: History button expanded/collapsed state; items read as "title, time · mode · n messages · status"; the recovery panel's status badge is announced.
4. Narrow sidebar: item actions wrap; the recovery panel scrolls.

## 11. Performance observations

Mock DOM, Node 22, M-series Mac. These show relative cost, not Chromium layout.

| Path | Result (5 runs) |
| :--- | :--- |
| 100 history-panel renders, 50 items, filtered | 4.1–18.7 ms total |
| Unchanged history re-render | 0 elements created (signature skip, keeps focus) |
| Store index load, 50 full records | 0.6–0.9 ms (reads only `index.json`) |
| Full record read (100 messages, 196 KB) | 1.8–2.5 ms |
| Largest record on disk | ≤ 512 KiB by construction |
| Worst-case disk use | 50 × 512 KiB ≈ 25 MiB per workspace, plus ≤ 5 quarantined files |
| Saves per turn | about 3–6 (start, run id, each approval or outcome, end), serialized; none on the streaming-output path |

## 12. Upstream references

No third-party code was copied.

| Repository | License | Version | What was examined | Classification | Integration |
| :--- | :--- | :--- | :--- | :--- | :--- |
| https://github.com/cline/cline | Apache-2.0 | `40c5d99031fe1128189c5b52e40638d2b7787754` (2026-10-24), read-only via the GitHub API | `apps/vscode/src/sdk/sdk-task-history.ts`, `sdk-task-resume.ts` | **REFERENCE_ONLY** (inspiration) | Confirms the shape chosen: a recency-sorted metadata index separate from per-conversation records, and "resume" as a new session seeded from the saved transcript (no action replay). Open VS Code adds workspace identity, checksums, quarantine and redaction |
| https://github.com/microsoft/vscode | MIT | VS Code `1.135.0`, commit `5a73682c…` via VSCodium | `ExtensionContext.storageUri`, `window.showQuickPick`, modal `showWarningMessage` | **ADOPT** (public API use, not code reuse) | S11b, S17; `desktop:accept` tests 2 and 4 |
| https://github.com/VSCodium/vscodium | MIT | `1.135.06055` | Packaged host | **KEEP** | `desktop:smoke`, `desktop:accept` |
| In-repo `CheckpointStore`, `SessionSummaryStorage`, `redactRuntimeEvalSecrets`, `canonicalSerialize` | project | this branch | Atomic write and checksum pattern; redaction; canonical serialization | **REUSE** (imported, not duplicated) | S5, S7 |
| Cursor (product) | Proprietary | n/a | Conversation list feel | Inspiration only | No code or assets |

## 13. Remaining risks and limitations

- Live GUI theme, VoiceOver and narrow-layout checks (§10).
- Executable resume of an interrupted run is not available from the editor (§4).
- Two windows on the same workspace: VS Code normally prevents this. If it happened, record writes stay atomic and the index is last-writer-wins and self-healing; the windows do not live-sync.
- Redaction is pattern-based. A secret in an unrecognised format could be saved. Records stay local (mode 0600, outside the repository), and deleting a conversation removes its file.
- Restored conversations show `[REDACTED]` where the live session showed a matched secret.
- The activity timeline and terminal output are not restored by design. Earlier command rows offer no Output after a restart.
- `npm run lint` does not cover `vscode-integration`, which has pre-existing findings (not introduced here).
- Per-hunk approval is still not implemented (7B §2).

## 14. Verdict

**SPRINT_7C_PARTIALLY_VERIFIED.**

- Criteria 1–9 hold: create/switch/reopen, restart survival (packaged), workspace isolation, bounded and corruption-safe storage, no approval or side-effect replay, Agent Core memory and checkpoints still authoritative, regressions green, desktop integration green, flake investigated and fixed.
- Criterion 10 is reported accurately above: the human live-GUI checklist is open.
- Not merged; awaiting authorization.
