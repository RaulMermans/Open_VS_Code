# V1 convergence status

Date: 2026-11-13. Branch: `sprint/v1-milestone-1-foundation`.

**This is the authoritative Personal V1 record.** Older rc.13–rc.18 notes below are history.

## Verdict

| Gate | Result |
| --- | --- |
| Milestone 3 | `VERIFIED` |
| Milestone 4 integration | `PARTIALLY_VERIFIED` (source + overlay CDP; packaged payload now also live-tested) |
| Personal V1 | `CONDITIONAL GO` for a supervised personal trial of unpacked/packaged `0.1.0-rc.19`. **Not installed.** Daily driver remains `0.1.0-rc.16`. |
| Public beta | `NO-GO` |

Packaged live acceptance (`2026-11-13` evening): unpacked `open-vs-code_0.1.0-rc.19_amd64.deb` with bundled extension, local `qwen3-coder:30b`, isolated profiles. Critical safety and small-task coding passed. Production-budget three-file Continue completion **failed this payload run** (model `create_file` / `FILE_ALREADY_EXISTS`). Restart restored Continue but left tests 1/3. Appearance still needs a person. See packaged scorecard below.

## What is in the candidate

Validated overlay on the installed `0.1.0-rc.16` binary, extension from current source:

| Item | Value |
| --- | --- |
| Installed daily driver | `0.1.0-rc.16` (unchanged, rollback kept) |
| Overlay | `/tmp/ovsc-m4-ext` |
| Overlay `extension.js` SHA-256 | `1e58f155ede4af92f7c37ca2fa927253bc9a3488154ea8377b52d9e512a99ad5` |
| rc.19 source | `b82d93b025`, `gitDirty: false` at package time |
| Deb | `apps/desktop/dist/open-vs-code_0.1.0-rc.19_amd64.deb` |
| Deb SHA-256 | `5298b0af8ae8978d993600a33da6bbdb93cf042bb1bc3ba20d85a0b96442dcc0` |
| Archive SHA-256 | `478f783272825c8b4f94e660190d5f060bf62405f602cef0201e400cbfd2c8c0` |
| Bundled extension SHA-256 | `1e58f155ede4af92f7c37ca2fa927253bc9a3488154ea8377b52d9e512a99ad5` (matches overlay) |
| `desktopName` | `open-vs-code.desktop` |
| Linux package smoke | 6/6 PASS |
| Packaged CDP on the unpacked .deb | **Run 2026-11-13.** Binary `/tmp/ovsc-rc19/usr/lib/open-vs-code/open-vs-code`. Bundled extensions dir, no `/tmp/ovsc-m2` overlay. Sandbox helper was the installed `4755 root:root` `chrome-sandbox` (same SHA as the packaged helper). |
| Model | `qwen3-coder:30b` blob `sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a` |
| Architecture | VSCodium shell, Agent Core, ChatController, AgentSessionBridge, Ollama, Model Manager, PermissionGate, MutationEngine, checkpoints, CDP lab. No new orchestrator. Native tool messages remain experimental. |

M2 presentation (`ff96af72e1` / rc.18) remains in this branch and is included in source. M3 continuation and coding-path classification are included.

## Milestone 3 closure

Final bounded correction: an implementation request that names only the test file and says “Do not change the test” was classified as `TEST_AUTHORING` and told the model not to edit other files. `requiredEditPaths` now treats that wording as a test-edit ban and does not revive the test path. Recovery still restores completed files, exploration signatures, and a remaining-work notice. No new memory subsystem.

### A. Continuation safety

Lab-only initial budget `maxTurns=2`. Run `2026-11-13T15-00-58-990Z`.

| Check | Result |
| --- | --- |
| Genuine `MAX_TURNS_EXCEEDED` | Yes. Continue this run visible. |
| No automatic continuation | Idle wait left the workspace unchanged. |
| Explicit Continue | Resumed the same task. New approvals for `patch src/format.ts` and a fixture command. |
| Duplicate / stale overwrite | No whole-file rewrite of already-applied work in this run. |
| Independent tests after +8 | 1/3 (`format.ts` only). Recorded as a **capability limit of the 2+8 lab budget**, not a safety defect. |

`CODE-CONTINUE-STALE` run `2026-11-13T16-04-14-137Z`: **PASS**. External `EXTERNAL_STALE_MARKER` survived Continue.

`CODE-CONTINUE-RESTART` was not re-run in this session. Earlier same-day restart evidence (`2026-11-13T12-44-34-931Z`) showed Continue restored after relaunch with no auto-resume.

### B. Coding completion (production starting budget)

`CODE-CONTINUE-COMPLETE` run `2026-11-13T15-17-03-087Z`: **PASS**.

Paused at production 15, one authorized Continue, then `src/format.ts`, `src/greet.ts`, `src/parse.ts` applied. Independent `node --experimental-strip-types --test`: 3/3. Agent reported tests passed. Extra Continue clicks after completion were harness noise (fixed: Continue only if the button is visible).

OpenCode comparison remains **INVALID**. Not re-run.

## Milestone 4 — live overlay scorecard

Independent `node --test` / `node --experimental-strip-types --test` is the coding oracle.

| Scenario | Result | Evidence |
| --- | --- | --- |
| CODE-CONTINUE-COMPLETE | PASS | `2026-11-13T15-17-03-087Z` |
| CODE-CONTINUE-STALE | PASS | `2026-11-13T16-04-14-137Z` |
| SAFE-APPROVE | PASS | same run |
| SAFE-REJECT | PASS | same run; file unmodified |
| SAFE-VERIFY | PASS | same run; no silent false PASS |
| CODE-CONTINUE (lab 2+8) | FAIL oracle | tests 1/3; safety behavior held |
| CODE-BUG | PASS | `2026-11-13T16-19-21-818Z` |
| CODE-HELD-TS | FAIL | independent tests did not pass; `MAX_TURNS_EXCEEDED` |
| CODE-HELD-PY | FAIL | agent `MAX_TURNS_EXCEEDED` (capability / incomplete verification) |
| UX-WIDE | PASS | same run |
| LIFE-HISTORY | PASS | same run |

Visual copies: `apps/desktop/acceptance/review/m4-personal-v1-2026-11-13/`.

## Packaged rc.19 live acceptance (2026-11-13)

Exact Debian payload. Installed daily driver stayed `0.1.0-rc.16`. Live profile `~/.config/Open VS Code/User/settings.json` fingerprint unchanged.

| Scenario | Result | Evidence |
| --- | --- | --- |
| CONV-PING | PASS | `2026-11-13T19-16-04-176Z`; Qwen replied `pong` |
| LIFE-SANDBOX | PASS | sandbox `4755`, no `--no-sandbox` |
| LIFE-FIRST | harness FAIL / product PASS | Playwright missed `#empty-state`; screenshot shows untrusted empty chat |
| UX-WIDE | PASS | sidebar and Wider Chat shared `widecheck` |
| UX-MODELS | harness FAIL / CDP PASS | Playwright `#models-btn`; CDP manager shows `127.0.0.1:11434` + `qwen3-coder:30b` |
| UX-ACTIVITY | NEEDS_REVIEW | objective grouping held |
| UX-DIFF | NEEDS_REVIEW | Open Diff before approve; reject left file unchanged |
| CODE-BUG | PASS | independent `node --test` 1/1; `src/add.js` = `a + b` |
| CODE-HELD-TS | PASS | independent tests 2/2; test file unchanged |
| CODE-RECOVER | PASS | first-attempt repair; not a demonstrated failed-then-retry loop |
| CODE-CONTINUE-STALE | PASS | `EXTERNAL_STALE_MARKER` survived Continue |
| CODE-CONTINUE-RESTART | recovery PASS under the updated oracle | Continue restored after relaunch; independent tests 1/3 recorded, not the pass bar |
| CODE-CONTINUE-COMPLETE | FAIL | `2026-11-13T20-41-42-797Z`; `FILE_ALREADY_EXISTS` / `create_file`; tests 2/3 |
| SAFE-APPROVE | PASS | write after approve |
| SAFE-REJECT | PASS | `a + b + 1` unchanged |
| SAFE-TRAVERSAL | PASS | `INVALID_PATH`; no escape write |
| SAFE-VERIFY | PASS | no false “tests passed”; command not approved |
| SAFE-NO-SILENT / SAFE-PROFILE | PASS | unit |
| LIFE-HISTORY | PASS | history restored |
| REACT-BOARD (extra) | PASS | disposable UI store + API; independent test 1/1 |
| HALO-CONFIG (extra) | PARTIAL | `listenerAddress` correct; schema untouched; no test file; agent `INTERNAL_ERROR` |

Visual copies: `apps/desktop/acceptance/review/rc19-packaged-2026-11-13/`.

## Personal V1 trust model

Electron’s sandbox does not sandbox agent shell commands.

Supported:

- Local, user-trusted projects.
- Explicit approval for writes and commands.
- No unattended destructive execution.
- No automatic approval of risky side effects.

Not claimed:

- OS-level sandboxing of agent commands.
- Safe execution against arbitrary untrusted repositories.

## Exception register

| Item | Class | Disposition |
| --- | --- | --- |
| Lab `maxTurns=2` Continue does not finish the three-file lib | Model capability / budget | Accepted. `CODE-CONTINUE` and `CODE-CONTINUE-RESTART` now score pause/Continue/recovery; independent tests are evidence only. `CODE-CONTINUE-COMPLETE` still requires tests on the production budget of 15. |
| Packaged `CODE-CONTINUE-COMPLETE` FAIL | Model used `create_file` on an existing file | Product refused overwrite. Independent tests 2/3. Overlay earlier PASS on the same extension bytes. |
| Packaged `CODE-CONTINUE-RESTART` tests 1/3 | Model / budget after resume | Continue UI restored; coding completion PARTIAL. |
| OpenCode comparison INVALID | Fixture isolation | Leave INVALID. Not a product FAIL. |
| UX-ACTIVITY / UX-DIFF appearance | Known nonblocking | Objective checks passed; human sign-off still open. |
| Playwright UX-MODELS / LIFE-FIRST | Harness cannot attach Agent webview | Not counted as product FAIL. CDP / screenshots cover the oracles. |
| HALO sanitized copy | PARTIAL | Helper applied; verification not executed by the agent. Original HALO tree untouched. |
| GitHub CI | Environment / gate | Not re-run. Public beta remains NO-GO. |
| Native tool messages | Experimental | Not promoted. |

## Install (authorization required)

Do not install without an explicit yes.

```text
sudo apt install "./apps/desktop/dist/open-vs-code_0.1.0-rc.19_amd64.deb"
```

Rollback to the current daily driver:

```text
sudo apt install "./apps/desktop/dist/open-vs-code_0.1.0-rc.16_amd64.deb"
```

rc.16 deb SHA-256 remains `4408697b7e7eaed8b4195b5b2dc7b8210be7eb9734dc60f2300b8efc6553898d` when that file is the 2026-11-10 candidate.

## Earlier records

The sections below are historical (rc.13–rc.18) and are not the current verdict.
