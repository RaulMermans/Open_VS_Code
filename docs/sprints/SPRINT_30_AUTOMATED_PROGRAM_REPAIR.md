# Sprint 30 — Automated program repair

STATUS: `IN_PROGRESS`. Daily driver remains installed `open-vs-code 0.1.0-rc.25`. This branch was not installed, pushed, or merged.

## Baseline

- Evaluation base: `repair/28-halo-qualify` at `cc346f01ae4e3ed2255d91ff311851c7852a5f2c`. This branch starts there.
- The open checkout `sprint/v1-milestone-1-foundation` is one commit ahead of its origin (`0d333457bd`) and was not moved.
- Model on this machine: `qwen3.6:35b`, Ollama id `a7eb95c53bcf` (unchanged from the recorded digest).
- Oracle: `packages/ide-adapter/evals/halo-oracle.py`, SHA-256 `a8513253e1e6f7a272293252238750e9a8021c807d6d2ef3d074113e35af46fb`.
- GitHub Actions on `main` after PR #105: run `44879130170` failed lint. `packages/agent-core` `src/agent/runner.ts` nested `isProductSource` was an oxlint warning under `--deny-warnings`. That function is now module scope. Ubuntu Node 22 and 24 were the failing jobs. The last green `main` run in the recent list was `44731946582` (PR #103).
- Installed package: `0.1.0-rc.25`. Rollback packages remain under `~/open-vs-code-backups`. rc.25 was not replaced.

## What i1 actually did

Recorded run `i1` (reconstructed in `evals/repair/qualification-i1-checkpoint.json`; conversation not restored):

- 33 turns, 58 tool calls, cancelled at 1,440,005 ms.
- Applied `packages/models/src/errors.ts` and created the qualification test. Vitest: 3 passed, 5 failed.
- After the failure, `run_verification` was denied until an edit (the loop was waiting on a change). `read_file` still ran. The model did not apply a further edit before the clock ran out.
- The revision prompt did not contain `AssertionError` or `ModelQualificationError`. It contained the head of stdout (`better-sqlite3` rebuild lines) and `[STDOUT TRUNCATED]`.
- Five earlier `apply_patch` denials told the model to create the test before patching more source. That sentence is not in `cc346f01ae`. It is a property of the run's runtime, not of this commit.

Disproven for `i1`: the stop was not "two failures classified as pre-existing" (there was one verification), and edit tools were not removed after the failure.

## Change

See ADR-050. Deterministic checks:

- Long stdout keeps the trailing `AssertionError` and `FAIL` line.
- The qualification-shaped Vitest text becomes two assertion groups and names the test file. The sqlite path is not the summary.
- Pre-existing requires a failing run before the first edit. A pass-then-fail is a regression. Two post-edit failures stay repairable. A changed assertion is a different failure.
- Scripted control: failed test, one `apply_patch`, second verification, `COMPLETED`. A "tests passed" reply after a failing run is not `COMPLETED`.
- Agent-core lint with `--deny-warnings` is clean, including the previous `isProductSource` warning.

## Production loop (`qwen3.6:35b`)

The worktree `node_modules` entry was a symlink into the repair28 tree, so `@open-vs-code/*` resolved there. Replays 1–3, including the add-bug runs, executed that older runtime. They are not evidence for this branch. Live runs after that use a local `node_modules` whose `@open-vs-code` links point at this worktree. That overlay is untracked.

Prompt, unchanged: the existing `packages/inference/test/modelQualification.test.ts` fails; fix the implementation; do not change that test or `package.json`; run the tests after a fix. Workspace copy of frozen `ws/i1`. Budget 12 minutes. Oracle: vitest on that file only.

Replay 4 (`/tmp/ovsc-r30-loop/out/halo-r4.json`, `be6abc47ae`): CANCELLED at 720s, 14 turns. The test command was `@halo/inference` `vitest run`, not the root `pnpm -r` script. The revision quoted `AssertionError: promise resolved … instead of rejecting` and the qualification test names. `service.ts` counted as the requested edit. The two patches added an unused import and an unused `HALO_INFERENCE_QUALIFY_MODEL_ID` constant. The identical-failure replan fired as the clock expired. Independent vitest: 5 failed, 3 passed.

Replay 5 (`halo-r5.json`): CANCELLED at 720s, 15 turns, three applied patches on `service.ts`. The last patch throws `ModelQualificationError` only when that env var is set and `modelRef` differs. The frozen tests never set the env var, so chat still resolves. The diagnosis also says `The instanceof assertion needs a constructor but undefined was given` at the test's `ModelQualificationError` import. The model did not export that class. Independent vitest: 5 failed, 3 passed. The test file was not edited.

## Not run

- Aider and Qwen Code.
- A second candidate patch.
- The eight frozen generalization tasks.
- Three isolated HALO qualifications from a clean baseline, full HALO VC-02, and packaged GUI acceptance.

## Verdict

- Repair mechanism: **NO-GO**. The scripted control passes, and a live replay now sees the qualification assertions and can edit `service.ts`. Two valid replays left the same 5 failures. The model did not export `ModelQualificationError` or make the mismatch check run for these tests.
- Supervised testing: **NO-GO**. No isolated HALO success.
- Daily-driver: **NO-GO**. Installed package remains `0.1.0-rc.25`.

Next action: do not repeat this 12-minute prompt on the same runtime. A further sample needs a mechanism the last two traces did not already exercise. Do not edit the frozen test to make the run pass.
