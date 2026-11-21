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

## Not run

- Real `qwen3.6:35b` repair from the i1 workspace (E1 repeat and E2).
- Aider and Qwen Code (E4).
- A second candidate patch (E5).
- The eight frozen generalization tasks (E6).
- Isolated HALO end-to-end, full HALO VC-02, and packaged GUI acceptance.

Those wait on one native replay that receives this summary. Three scripted successes are not three model successes.

## Verdict

- Repair mechanism: **NO-GO**. The control passes and the i1 feedback defect is fixed in code. An unrelated real-model repair is not measured yet.
- Supervised testing: **NO-GO**.
- Daily-driver: **NO-GO**.

Next action: one isolated replay of the failed qualification workspace on this SHA with `qwen3.6:35b`, and record whether the first edit after verification touches the implementation the summary names.
