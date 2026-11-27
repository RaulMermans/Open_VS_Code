# S35 held-out coding benchmark

Status: FROZEN on 2026-11-27, before any model run. Written in Sprint 33 after the stale-Continue (`245cff1`), cancellation-lab, caller-grounding (`b0600d1`, `82b8ed5`) and Auto-order (`985889f`) changes. S32, S33 and S34 are known development and regression sets. S35 is the unseen set for Sprint 33.

## Tasks

| # | Id | Category | Mode | What it tests |
|---|---|---|---|---|
| 1 | `s35-01-explain` | EXPLAIN | Ask | Lockout threshold, duration and reset, spread over two files, with a decoy 30-minute constant |
| 2 | `s35-02-callers` | EXPLAIN | Agent | Callers of `sendReceipt`. One caller imports it under an alias, and an unrelated same-named function exists elsewhere |
| 3 | `s35-03-bugfix` | BUGFIX | Agent | `paginate` off-by-one plus the empty-list page count (JS) |
| 4 | `s35-04-multifile` | MULTI_FILE | Agent | A `priority` field through the type, factory, sort and formatter, with typecheck (TS) |
| 5 | `s35-05-repair-test` | FAILED_TEST_REPAIR | Agent | Failing `parseDuration` test. The other parser behaviour must be kept, and `format.ts` must not change |
| 6 | `s35-06-rename` | REFACTOR | Agent | `formatPrice` → `formatMoney`. A private same-named function in `src/legacy/report.ts` must stay |
| 7 | `s35-07-python` | PYTHON | Agent | `slugify` from written rules (ASCII folding, max length) |
| 8 | `s35-08-frontend` | REACT_STYLE | Agent | Pager status text, disabled buttons, guarded clicks |
| 9 | `s35-09-history` | FEATURE (state) | Agent | Browser-style back/forward history with a limit (TS) |
| 10 | `s35-10-complex` | COMPLEX | Agent | Expiring LRU cache with stats and RangeErrors (TS) |

Every behaviour a hidden oracle checks is stated in the instruction or visible in the fixture.

## Frozen run settings

```text
OPEN_VS_CODE_REAL_INFERENCE=1 OPEN_VS_CODE_EVAL_MODEL=<model> \
  node --import tsx packages/ide-adapter/evals/run-coding-eval.ts \
  --label s35-<model> --split S35 --code-intel --timeout-min 10 --repeat 2
```

- **Models:** `qwen3-coder:30b` (`06c1097efce0…`) and `qwen3.6:35b` (`a7eb95c53bcf…`), with digests recorded in each result file. Auto now resolves to `qwen3-coder:30b` first (ADR-051), so it is not run separately unless the router picks a different model.
- **Repeats:** two independent runs per model. Add a third only when the two runs disagree on a task.
- **Constant across runs:** the runtime commit, fixtures, permissions (the harness approves every in-scope write and command) and these rules.
- **Allowed operations:** each task lists `allowedChanges`. A change to any other path is an unauthorized write, and the run fails. `unchanged` files must be byte-identical.

## Scoring

- **Correct outcome:** the hidden oracle passes, the visible tests pass, no unauthorized write occurs, and the `unchanged` files are intact. For explain tasks, every `answerOracle` pattern must match.
- **False completion:** the run reports success but the outcome is not correct.
- **Measured per run:** correctness, duration, inference time, model calls, prompt tokens, approvals and the tool sequence. Correctness and latency are reported separately.
- **Release target:** at least 8/10 independently verified tasks in each run, not only on average. A failed run is reported, not hidden by the mean.
- **No retroactive change.** If S35 is used to tune the runtime after it is scored, it becomes a known regression set, and a fresh held-out set is needed before claiming the unseen-task gate.

## Validation (before any model run)

- `run-coding-eval.ts --check-references --split S35`: 10/10 OK. Every oracle fails on the untouched fixture, every reference passes, and no reference writes out of scope. Explain tasks are checked against a plausible wrong answer (`untreated` in `s35-reference.ts`) that the answer oracle must reject.
- `s35-mutants.ts`: 15 plausible wrong implementations, 14 rejected and 1 correct variant accepted. The first version of the task 10 oracle missed "expired entries are dropped before the LRU entry". That oracle was fixed before freezing.

## Hashes

| File | SHA-256 |
|---|---|
| `packages/ide-adapter/evals/coding-tasks-s35.ts` (tasks, fixtures, hidden oracles) | `44bb9167cc506b36834ada2bfc2822a520799ba25cfe274bbaf45b15544b2f80` |
| `packages/ide-adapter/evals/s35-reference.ts` | `2defaa7b796ae14139e22710b5196f638a053f52e774cffd591edd189281f6ec` |
| `packages/ide-adapter/evals/s35-mutants.ts` | `80fec4846fd10fe166e6f94d29aa1383c3eea5365f444ed97385e0ff2b93c009` |

The runner records the task file's hash as `benchmarkSha256` in every S35 result. A result with a different hash is not an S35 result.

## Isolation

The agent receives only the instruction and the fixture files. The hidden oracles, the references and the mutants run outside the agent's workspace after the run, and the agent's tools cannot reach them.
