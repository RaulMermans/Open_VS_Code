# Sprint 20 — Deterministic File Editing & Wrong-Tool Recovery

Date: 2026-11-14. Status: `IMPLEMENTED` with live Qwen evidence. Three-file engineering target (2/3) was **missed**: 1/3 after the import-extension correction.

## Root cause (from packaged rc.19 `CODE-CONTINUE-COMPLETE`)

The permission and mutation engines already refused `create_file` on an existing file (`FILE_EXISTS` → `FILE_ALREADY_EXISTS`). That was not an authorization bypass.

The packaged traces (`2026-11-13T20-42-10-227Z`, retry `2026-11-13T20-49-12-193Z`) show the remaining defect:

1. Qwen called `create_file` on files that already existed (`format.ts` / `greet.ts` / `parse.ts`).
2. The runtime rejected overwrite, but the observation did not include the current file contents or an exact `apply_patch` recipe.
3. The same invalid create was retried.
4. Later patches stuffed greet/parse implementations into `format.ts`.
5. Independent tests finished 0/3 then 1/3. The agent reported completion without the requested three-file implementation.

The production prompt still offered `create_file` even after those files had been observed. Task classification for this prompt names only `test/lib.test.ts` (then excludes it because of “Do not change the test”), so the model was not given a filesystem-backed existing-file strategy.

## Contract now enforced in code

| File condition | Runtime behavior |
|---|---|
| Target does not exist | `create_file` may prepare a new-file proposal |
| Target exists, content differs, unique preserving hunk | Convert to a validated `apply_patch` proposal (still requires approval). Never a whole-file overwrite. |
| Target exists, identical content | `ALREADY_SATISFIED`, no write |
| Target exists, snippet / ambiguous rewrite | `FILE_EXISTS` with bounded current contents and an exact `apply_patch` instruction |
| Stale file since prepare | `STALE_BASE`, filesystem unchanged |
| Patch search missing / ambiguous | Rejected with `PATCH_MISMATCH` / `PATCH_AMBIGUOUS` |
| Export added that belongs in another existing sibling | `WRONG_FILE`, no write |
| Same invalid create retried | One correction, then truthful `INCOMPLETE` stop |

Preserved: workspace containment, symlink checks, sensitive-path policy, mutation budgets, two-phase prepare, human approval, exact operation identities, stale-base checks, idempotent no-write results. Production turn cap is unchanged by this sprint.

## Tool-selection change

Before: `create_file` and `apply_patch` were both offered with “use create_file when the file does not exist”, without inspecting the workspace.

After: named paths and files already read this run are classified through `resolveWritePath`. Existing files are labeled `apply_patch` only. `create_file` remains for genuinely missing files.

## Files modified

- `packages/agent-core/src/tools/mutation-engine.ts`
- `packages/agent-core/src/tools/mutation-recovery.ts` (new)
- `packages/agent-core/src/tools/mutation-registry.ts`
- `packages/agent-core/src/agent/runner.ts`
- `packages/agent-core/src/agent/tool-contract.ts`
- `packages/agent-core/src/agent/task-profile.ts`
- `packages/agent-core/src/index.ts`
- `packages/agent-core/tests/tools/mutation.test.ts`
- `packages/agent-core/tests/tools/mutation-recovery.test.ts`
- `packages/agent-core/tests/agent/deterministic-file-editing.test.ts`
- `packages/agent-core/tests/evals/sprint-20-live-editing.ts`

## Live Qwen (`qwen3-coder:30b`)

AgentRunner on disposable Git fixtures. Auto-approve. Independent tests are the oracle. Production starting budget 15 plus one Continue (+8). Not mocked.

| Case | Agent | Independent tests | Notes |
|---|---|---|---|
| A existing-file edit | COMPLETED | PASS | `read_file` → `apply_patch` → verify |
| B wrong-tool create | COMPLETED | PASS | `create_file` FAILED, then `apply_patch` succeeded. File not overwritten. |
| D held-out TypeScript (`score.ts`/`bonus.ts`) | COMPLETED | PASS | Previously unseen pair |
| D held-out Python (`median.py`) | FAILED `MAX_TURNS_EXCEEDED` | PASS | First patch was correct; later patches failed. Agent did not complete truthfully as COMPLETED. Counted as code-correct, not a green agent completion. |
| C three-file round 1 (before import-extension tighten) | 0/3 | 0/3 | Recovery worked; remaining parse/import errors |
| C three-file round 2 (current source) | **1/3** | 1/3 | Repeat 1 PASS 3/3 tests. Repeat 2: parse unfinished. Repeat 3: `greet` called `formatName` without importing it. |

Evidence: `evals/results/sprint-20-live-editing-round1.json`, `evals/results/sprint-20-live-editing.json`.

CDP packaged lab was not rerun. This sprint does not install a Debian package. The live AgentRunner path is the same MutationEngine / PermissionGate used by the desktop.

## Remaining failure modes

- Three-file tasks still miss the 2/3 target. After recovery, Qwen often finishes two files and stalls on the third, or calls a sibling function without importing it.
- Repeated `run_verification` while an edit is still required is denied and burns turns.
- Safe create→patch conversion only runs when the proposed content preserves at least half of the existing nonempty lines and is not a whole-file replacement.
- CDP confirmation of this source still needs an authorized overlay.

## Next versioned candidate

Do not package or install yet. Land this source, then overlay it on rc.16/rc.19 for a CDP `CODE-CONTINUE-COMPLETE` triple run. Personal V1 coding GO still requires a better three-file distribution than 1/3.
