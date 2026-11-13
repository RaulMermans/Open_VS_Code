# V1 convergence status

Date: 2026-11-13. Branch: `sprint/v1-milestone-1-foundation`.

**This is the authoritative Personal V1 record.** Older rc.13–rc.18 notes below are history.

## Verdict

| Gate | Result |
| --- | --- |
| Milestone 3 | `VERIFIED` |
| Milestone 4 integration | `PARTIALLY_VERIFIED` (source + overlay CDP; Debian candidate follows the source commit) |
| Personal V1 | `GO` for an installable candidate after the rc.19 package is built from the recorded commit. **Not installed.** Daily driver remains `0.1.0-rc.16`. |
| Public beta | `NO-GO` |

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
| Packaged CDP on the unpacked .deb | **Not run.** Overlay CDP used the same extension bytes on the installed rc.16 binary. |
| Model | `qwen3-coder:30b` |
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
| Lab `maxTurns=2` Continue does not finish the three-file lib | Model capability / budget | Accepted. Production 15+Continue completed the same fixture. |
| OpenCode comparison INVALID | Fixture isolation | Leave INVALID. Not a product FAIL. |
| UX-ACTIVITY / UX-DIFF appearance | Known nonblocking | Objective checks passed on rc.18; human sign-off still open. |
| React frontend + TypeScript monorepo disposable apps | Not run this session | Not claimed. |
| CODE-HELD-TS / CODE-HELD-PY this overlay | Model capability | FAIL this session. Previous overlay had HELD-TS PASS. Not treated as a critical integrity defect. |
| `CODE-CONTINUE-RESTART` this session | Not run | Prior restart evidence retained. |
| GitHub CI | Environment / gate | Not re-run. Public beta remains NO-GO. |
| Packaged CDP on the unpacked rc.19 .deb | Not run | Extension bytes match the overlay that passed CDP. Full packaged-payload CDP is the remaining install-prep check if desired. |
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
