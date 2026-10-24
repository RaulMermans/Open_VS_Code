# Sprint 7B — Terminal, Diff Review & Developer Workflow Experience

Status: **SPRINT_7B_PARTIALLY_VERIFIED**. All automated gates are green, including packaged VSCodium smoke (13/13) and runtime acceptance (3/3). A human walkthrough of the live webview has not been done: light/dark/high-contrast theme pixels and screen-reader output. No HALO host is required.

Baseline: GitHub `main` `18d1fcc806683bc1685564125dfca4621517dc2f` (Sprint 7A, PR #36).
Branch: `sprint/7b-terminal-diff-experience`.

Architecture preserved:

```text
Webview → ChatController → AgentSessionBridge → AgentRunner → PermissionGate → MutationEngine / VerificationEngine
```

The webview still only displays state and posts validated messages. The only way to approve anything is still to resolve the pending `requestConfirmation` promise with the exact `confirmationId`. After that, `AgentRunner` applies the change through `MutationEngine`, which re-checks the hash at apply time, or runs it through `VerificationEngine` (`shell: false`, bounded, process-tree kill). No new execution path, permission system, diff engine or terminal engine was added.

---

## 1. Sprint 7A verification closure

| 7A open item | Finding | Result |
| :--- | :--- | :--- |
| `vscode-integration` `tsc --noEmit` "hang" | **Environmental.** 7A ran in `~/Desktop/GitHub/Open_VS_Code`, which is iCloud-synced. Its files are "dataless" placeholders, so reads block with no CPU use. That matches the "idle, no file list, ~0% CPU" symptom. In a fresh clone outside iCloud, `tsc --noEmit --extendedDiagnostics` finished in **1.84 s**: 319 files, 178 MB, check time 1.16 s. No TypeScript or module-resolution fault. | Not a code defect |
| Hidden type errors | The completed check found **two real errors** that 7A shipped: `chat-ux-model.ts:420` (`label` could be `undefined` when an attachment has no `kind`) and `webview-render-helpers.ts:144` (indexed access did not narrow the `MessageSegment` union). Both were fixed without suppressions. | **Fixed**; `npm run typecheck` exits 0 for all workspaces (whole repo ≈ 7 s) |
| Deterministic regression suite | Before any 7B change: agent-core 617, cli 21, ide-adapter 7, vscode-integration 45, all passing. (The 7A record had the cli and ide-adapter counts swapped.) | Green |
| Packaged VSCodium | `npm run desktop:prepare` downloaded the pinned VSCodium `1.135.06055` and verified its SHA-256. `npm run desktop:package` produced an ad-hoc-signed `Open VS Code.app` and a 236 MB archive. The 7A blocker was a missing local cache plus the iCloud path, **not an application failure**. | Packaging works here |
| Desktop smoke / acceptance on the 7A baseline | `desktop:smoke` **13/13**, `desktop:accept` **3/3**: packaged GUI launch and clean SIGTERM shutdown, extension-host activation with all commands registered, archive extraction and strict codesign check. | Green |
| Live theme / keyboard walkthrough | Automation cannot read the webview DOM inside the packaged app. A human pass is still needed; see the checklist in §9. | Still manual |

Prerequisites for whoever reruns this: Node ≥ 22. Run from a non-iCloud checkout. Unset `ELECTRON_*`/`VSCODE_*` when launching from a VS Code terminal. Have about 1.5 GB free for the VSCodium staging.

---

## 2. Infrastructure audit

| Component | Already functional | Missing from the UI before 7B | 7B decision |
| :--- | :--- | :--- | :--- |
| `VerificationEngine` (agent-core) | `shell: false`, minimal env, timeout, abort → `killProcessTree`, 64 KB output bounds, package.json hash and script-body re-check at execution, single-use ids | `STALE_VERIFICATION` was shown as a plain "Failed" | **KEEP**, unchanged |
| `MutationEngine` (agent-core) | Exact single-occurrence patch, base SHA-256, apply-time hash and realpath re-validation (`STALE_BASE`), single-use apply | Line counts and hashes were in `reviewPayload` but never displayed | **KEEP**, unchanged |
| `AgentRunner` / PermissionGate | Two-phase prepare → confirm → apply; one pending decision at a time; `*.prepared/approved/rejected/applied/failed` events | n/a | **KEEP**, unchanged |
| `TerminalReviewController` | Exact executionId routing, UTF-8-safe 16 KB per-stream bound, bounded registry | No start time; late or forged completion could overwrite CANCELLED; output hidden while running | **ADAPT** |
| `DiffReviewController` | `TextDocumentContentProvider` + native `vscode.diff`, bounded registry, per-mutation status | Status never reached the UI; a change disappeared once decided | **KEEP**; status now flows through one transition helper |
| `ChatController` | Exact confirmation ids, in-flight lock, dirty-file block, cancel semantics | No change list; second concurrent request orphaned the first; `terminal.cancel` with any id aborted the turn; one post per output chunk even after the bound | **ADAPT** |
| Recovery / checkpoints (agent-core) | Journal + checkpoints; recovery never replays an applied write | n/a | **KEEP**, unchanged. The UI only shows recorded outcomes |
| Native VS Code facilities | `vscode.diff`, Output channels, Git extension `git.openChange`, `workbench.view.scm` | Not used except `vscode.diff` | **ADOPT** the API calls; no editor code copied |

Per-hunk review: each `MutationEngine` mutation is one exact search/replace on one file, so it yields exactly one contiguous hunk, and the engine applies a prepared mutation as one hashed unit. **Per-file approval is the per-mutation approval that already exists. Per-hunk approval is not implemented,** and the UI does not claim it. Doing it safely would need partial-apply support in `MutationEngine` with its own hash contract.

---

## 3. Implemented terminal features

Card (`renderTerminalOutput`):

- Command line, then separate **Executable**, **Arguments** (quoted when they contain spaces or quotes, or are empty), **Directory**, **Source** (provenance), **Script** (the exact `package.json` script body that will run) and **Time limit**.
- Status badge (`role="status"`): Waiting for approval, Running, Passed, Failed, Timed out, Cancelled, or Rejected — not run.
- **Elapsed time** while running, from a host-recorded `startedAt` and a one-second ticker that stops when the command finishes. After the run: exit code, signal, duration, or "Stopped after the N s limit".
- **Streaming output** is shown by default once a command runs. Same-structure updates replace only the output text node. The card is rebuilt only when its status or flags change.
- **Truncation warning per stream**, shown even when output is collapsed: "Output truncated: only the first 16 KB of stdout was kept."
- Actions: Show/Hide output, Copy command, Copy output, **Output panel** (writes the bounded transcript to the native *Open VS Code: Commands* output channel), Cancel (running only), and **Ask to retry**. Ask to retry only drafts a message in the composer. Nothing runs until a new turn's command is approved again.

Host hardening:

- Terminal status is **monotonic**. Once finished (including REJECTED/CANCELLED), a late, duplicate or forged `verification.started`/`completed` cannot change it. A user-cancelled entry may still receive the engine's exit details once, but stays CANCELLED.
- `terminal.cancel` aborts the turn only if that exact executionId is **RUNNING**. Unknown, finished or awaiting-approval ids are ignored.
- `terminal.updated` is posted only when retained output or its bounds change. After the cap, 10,000 more chunks produced no posts.
- `STALE_VERIFICATION` and `EXECUTION_ERROR` results get a plain-language detail in the ledger.

Unchanged by design: the agent cannot run arbitrary shell commands. Commands still come only from `discoverVerificationCommand` (TEST/TYPECHECK/LINT/BUILD) and are spawned by `VerificationEngine`. **No broader terminal permission contract was introduced.** A visible native terminal was evaluated and not adopted (§8).

## 4. Implemented diff / review features

- **Approval card for a change:** the file (or "New file"), **+added −removed** from the engine's own counts, and **Base sha256 xxxxxxxxxxxx — re-checked before writing**. Actions: Open Diff (native `vscode.diff`, pending change only), **Open File** (existing files only), Reject, Approve.
- **Blocked approval:** if the target has unsaved editor changes, the card shows an `role="alert"` reason in place, as well as the notification.
- **"Changes & commands" ledger** (per conversation, ≤ 20 rows, `<details>`/`<summary>`). One row per proposed change and per command. Statuses: Awaiting review, Applied, Rejected, Cancelled, Stale — not applied, Failed, Running, Passed, Timed out.
  - Each command row records which applied changes it checks. Each change row shows "Checked by `<command>`: passed/failed". A rejected or cancelled command links nothing.
  - Stale and failed rows carry a short explanation from the engine's error code (e.g. "The file changed after the agent prepared this edit (content hash mismatch). Nothing was written."). Raw exception text and paths are never shown. Unknown codes fall back to a generic sentence.
  - Row actions: **Changes** for applied rows (Git `git.openChange` working-tree diff, falling back to opening the file), Open for the rest, and **Output** for commands. When anything was applied, a **Source Control** button opens `workbench.view.scm`.
  - `review.openChange` carries only a mutation id. The host resolves the path from its own record and checks containment, so the webview never chooses a filesystem path.
- **Honest end states:** a turn ending while a change is undecided marks it *Cancelled — Turn ended before a decision — nothing was written* and releases the orphaned decision as REJECT. An approved change with no `mutation.applied` is marked *Failed — Approved, but the engine reported no applied result*. Cancel marks pending rows *Interrupted*. New conversation clears the ledger. Events from a finished turn are dropped.
- **Conflicting requests:** a second confirmation request while one is pending is refused (REJECT) instead of replacing it. Previously the first promise was orphaned and its turn hung.

One transition point: `ChatController.setMutationStatus` updates `DiffReviewController` and the ledger row together. Command rows are re-derived from `TerminalReviewController` on every state push, so there is no second source of command status.

## 5. Developer workflow path

| Step | What the user sees | Source of truth |
| :--- | :--- | :--- |
| Agent inspects | Activity timeline (7A) from real `tool.*`/`model.*` events | `AgentEvent`s |
| Agent proposes a change | Approval card + ledger row *Awaiting review* | `reviewPayload` from `MutationEngine.prepare*` |
| User reviews | Native diff, Open File, line delta, base hash | `DiffReviewController` |
| User approves / rejects | Row → Applied / Rejected / Stale / Failed | `mutation.*` events |
| Agent requests verification | Command card with exact executable/args/cwd/script | `PreparedVerification` |
| Approved command runs | Running + elapsed + streaming output; Cancel | `verification.*` events, `TerminalReviewController` |
| Result | Passed/Failed/Timed out + exit + duration; change rows show "Checked by …" | `verification.completed` |
| Agent reports | Final assistant/system message (7A); ledger summary line | `AgentResult` |

---

## 6. Files changed

| File | Change |
| :--- | :--- |
| `packages/vscode-integration/src/review-model.ts` | **Added.** Status mapping, failure wording, output signature, ledger bound |
| `packages/vscode-integration/src/chat-controller.ts` | Ledger, single mutation-status transition, conflict refusal, orphan release, cancel guard, post coalescing, Output panel, Git/SCM open |
| `packages/vscode-integration/src/chat-protocol.ts` | `MutationSummaryDto`, `ReviewRecordDto`, terminal DTO fields; `terminal.copyOutput`, `terminal.openOutput`, `review.openChange`, `ui.openSourceControl` |
| `packages/vscode-integration/src/terminal-review-controller.ts` | `startedAt`, monotonic status, guarded completion, `copyOutput`, `formatTerminalTranscript` |
| `packages/vscode-integration/src/webview-render-helpers.ts` | Rewritten terminal card, mutation details, focus handling, ledger renderer, runtime list |
| `packages/vscode-integration/src/chat-view-provider.ts` | Ledger container, CSS, elapsed ticker, retry draft |
| `packages/vscode-integration/src/chat-ux-model.ts` | 7A type fix (attachment label fallback) |
| `packages/vscode-integration/tests/sprint-7b-terminal-diff.test.ts` | **Added.** 17 tests (§7) |
| `docs/sprints/SPRINT_7B_TERMINAL_DIFF_EXPERIENCE.md` | This record |
| `docs/sprints/SPRINT_7A_AGENT_EXPERIENCE.md`, `docs/sprints/README.md`, `PROJECT.md`, `PLAN.md`, `REFERENCE_MAP.md`, `docs/adrs/ADR-018-chat-ux-layer.md`, `docs/SECURITY_MODEL.md` | Closure findings, status, references, message surface |

No new dependencies. No agent-core changes.

---

## 7. Tests and outcomes

New: `packages/vscode-integration/tests/sprint-7b-terminal-diff.test.ts`. It uses the existing seams (mocked `vscode` module, scripted `bridgeFactory`, mock DOM), the real `VerificationEngine` and `MutationEngine`, and an esbuild-bundled runtime.

| # | Requirement | Test |
| :- | :--- | :--- |
| 1 | Proposed command rendering | Executable, quoted args, cwd, source, script body, limit |
| 2 | Exact command/cwd | Pending DTO equals the prepared command byte for byte |
| 3 | Approval and rejection | RUNNING + `startedAt` + visible output; REJECTED shows "not run" and offers no output |
| 4 | Duplicate approval suppression | 50 interleaved APPROVE/REJECT messages → one resolution; conflicting second request → REJECT, first still decidable |
| 5 | Cancellation during execution | Forged/premature cancel ignored; real cancel aborts; late PASS cannot overwrite CANCELLED; duplicate completion ignored |
| 6 | Timeout and child cleanup | Real engine, parent + grandchild processes: TIMEOUT and user-cancel both leave **no surviving PID** |
| 7 | Streaming and truncation | 1 KB cap, 10,000 multibyte chunks: < 30 posts, no split UTF-8, per-stream warning, forged id never shown |
| 8 | Mutation preview and rejection | Path, +3 −1, base hash, native diff opens, reject clears diff content |
| 9 | Stale diff | STALE row with plain-language detail (no raw message); no diff after resolution; opens the file |
| 10 | File hash mismatch | Real `MutationEngine`: disk edit after prepare → `STALE_BASE`, user's file untouched, row Stale |
| 11 | Multiple independent records | 3 changes + 1 command: separate outcomes, verification links only to applied changes, Git and fallback open, Output panel, copy |
| 12 | Error and recovery states | Orphaned decision released as REJECT; approved-unconfirmed → Failed; cancel → Interrupted; no event replay after reset; no raw error text |
| 12b | Dirty editor | Visible `role="alert"` reason, approval held |
| 13 | Keyboard accessibility | Focus moves once to Open Diff/Reject, never to Approve/Run; every button labelled; output is a focusable `<pre>` without `aria-live`; ledger is `<details>` |
| 14 | Long-output performance | 2000 streamed chunks → 0 new elements; unchanged ledger not rebuilt |
| 15 | No permission escalation | Unknown/forged/overlong/polluted messages rejected; `review.openChange` drops a smuggled `path`; no message other than the exact confirmation id decides |
| 16 | Bundled runtime | esbuild bundle of the helpers evaluated without module scope; untrusted output stays text |

**Adversarial check of the tests.** Each 7B safety fix was removed in turn and the suite re-run. All 7 mutants failed at least one test: conflict refusal, cancel guard, monotonic completion, monotonic status, post coalescing, orphan release, and raw-error suppression. The orphan-release mutant first survived; the test was tightened to assert the orphaned promise settles REJECT.

Gate on the final branch (Node 22.23.2, 2026-10-24, clean clone outside iCloud):

| Check | Result |
| :--- | :--- |
| `npm run typecheck` | exit 0 — all workspaces, 6.0 s |
| `npm run lint` | exit 0 — oxlint `--deny-warnings` (agent-core, cli, vscode-integration incl. new test) |
| `npm test` | **707 / 707** — agent-core 617, cli 21, ide-adapter 7, vscode-integration **62** (45 existing + 17 new) |
| `npm run build` | exit 0 — `dist/extension.js` 872.3 kb |
| `npm run desktop:package` | exit 0 — ad-hoc signed and strictly verified; archive SHA-256 `1db20ccb…44219b`, bundling the final branch code |
| `npm run desktop:smoke` | **13 / 13** |
| `npm run desktop:accept` | **3 / 3** (real packaged GUI launch/shutdown, extension activation and command registration, archive + codesign) |

Flakiness note: one of 21 full `vscode-integration` runs during development reported 6 failures in the Sprint 4A.2 security suite. It ran straight after `tsc`, and its details were not captured. Twenty further runs (10 full-suite, 6 security-only, 4 full) passed. It is recorded here as **unreproduced**, not dismissed. The suite spawns real process trees with PID files, so load-dependent timing is the likely cause.

Scripted providers and fixtures only. No live inference. No HALO host.

## 8. Performance

Mock DOM (Node 22, M-series Mac). This shows relative cost, not Chromium layout.

| Path | Result |
| :--- | :--- |
| 2000 streamed chunks, in-place card update | **2.4–5.7 ms, 21 elements total** |
| Same, rebuilding the card per chunk (old behaviour) | 13.7–22.2 ms, 42,000 elements |
| Ledger, 20 rows, first render | ~1.1 ms, 143 elements |
| Ledger, 1000 unchanged syncs | ~10.5 ms, **0 elements** (signature skip also preserves keyboard focus) |
| Host posts after the 16 KB cap | 0 per extra chunk |
| Retained output | ≤ 16 KB per stream per command; ≤ 1 MB across commands; ≤ 50 commands (unchanged bounds) |
| Ledger | ≤ 20 rows; undecided and running rows evicted last |

## 9. Safety assertions

Preserved and tested: exact confirmation identity; cancellation rejects the pending decision; workspace trust (7A); path containment for every open (host-resolved, `sanitizeRelativePath` + root prefix); stale mutation rejection at apply time (`STALE_BASE`); stale verification rejection (`STALE_VERIFICATION`); bounded output; process-tree cleanup on timeout and cancel; no cloud fallback; no autonomous approval. The retry button drafts text only. Copy/Output act on host-retained, already-bounded output for an existing execution id only.

Live GUI checklist still to do, by a person, in the packaged app:

1. Light, dark and high-contrast themes: badge contrast, row marks, focus outlines.
2. Tab through an approval card: focus starts on Open Diff (or Reject for commands); Enter/Space activate; Approve is never focused by default.
3. VoiceOver: the status badge is announced; streaming output does not flood; ledger summary expands with Space.
4. Narrow sidebar: action buttons wrap; the command box scrolls instead of overflowing.

## 10. Upstream references

No third-party code was copied. These are uses of public APIs of the pinned editor, not code reuse.

| Repository | License | Pinned version | Facility evaluated | Decision | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| https://github.com/microsoft/vscode | MIT | VS Code `1.135.0`, commit `5a73682ca091082675b10c9dc3f348c1d824d94f` (via VSCodium) | `vscode.diff` + `TextDocumentContentProvider` | **KEEP** (already used) | Tests 8–9; desktop accept |
| | | | `window.createOutputChannel` | **ADOPT** for bounded transcripts | Test 11 |
| | | | Built-in Git extension `git.openChange`; `workbench.view.scm` | **ADOPT** with fallback to open file | Test 11 (both paths) |
| | | | `window.createTerminal` / `Pseudoterminal` / shell integration | **REFERENCE_ONLY**. A read-only Pseudoterminal mirror was considered. Not adopted: a visible shell invites "run it here", the Output channel already gives native, searchable output, and real terminal execution would need a new permission contract | n/a |
| https://github.com/VSCodium/vscodium | MIT | `1.135.06055` (ADR-028, `apps/desktop/upstream.json`) | Packaged host for the extension | **KEEP**, unchanged | `desktop:smoke` 13/13, `desktop:accept` 3/3 |
| Cursor (product) | Proprietary | n/a | Compact change list and inline command card | Inspiration only | No code or assets |

## 11. Remaining limitations

- Live packaged-GUI theme, screen-reader and keyboard walkthrough (§9) is not done.
- Per-hunk approval is not implemented (see §2).
- After a change is applied, its pre-change diff content is released. "Changes" uses Git's working-tree diff, which also includes the user's own uncommitted edits to that file. Without Git it opens the file.
- Only the latest command has a full card. Earlier commands are ledger rows with Output, which opens the native panel.
- Ledger and output live only in the extension host. They do not survive a window reload (Sprint 7C is persistent sessions).
- **agent-core finding (not fixed, out of scope):** `resolveRepositoryPath` realpaths the root, but its first containment check compares an *absolute* requested path lexically. A workspace opened through a symlinked path (e.g. macOS `/var/…` temp dirs, or a symlinked project folder) therefore fails verification with `OUTSIDE_WORKSPACE` when `cwd = workspaceRoot`. It fails closed (safe direction). Fix it in agent-core with path-safety tests: realpath an absolute candidate before the lexical check.
- One unreproduced security-suite flake (§7).

## 12. Verdict

**SPRINT_7B_PARTIALLY_VERIFIED.** All automated checks pass on the final branch, including the packaged desktop. Only the human GUI checklist above is outstanding. Not merged; awaiting authorization.
