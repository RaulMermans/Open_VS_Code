# Sprint 25 — Reliable agent execution, dual-model validation

Date: 2026-11-17/18. Branch `sprint/25-reliable-execution` (from `origin/main` `453c3a2a0c`, Linux CI green). Decision record: ADR-048.
Candidate: `0.1.0-rc.25` from `203bdf81d7`, **not installed**. Evidence: `~/.cache/ovsc-sprint25/` (runs, traces, oracles, GUI evidence; local, not committed).

## 1. State at start (verified)

| Item | State |
| --- | --- |
| Installed daily driver | `0.1.0-rc.24` (`dpkg -s`), not rc.21 as the brief assumed; installed after Sprint 24 |
| Source | `origin/main` `453c3a2a0c` = Sprint 24 + Linux-only CI; CI run 44142002141 green |
| Models (`ollama list`, Ollama 0.40.15) | `qwen3-coder:30b` `06c1097efce0` (30.5B MoE, Q4_K_M, temp 0.7 / top_p 0.8 / top_k 20 / repeat 1.05, tools); `qwen3.6:35b` `a7eb95c53bcf` (35.5B MoE `qwen35moe`, Q4_K_M, 22.6 GB, tools + vision + **thinking on by default**, temp 1 / top_p 0.95 / presence 1.5). Server `OLLAMA_CONTEXT_LENGTH=65536`; desktop routing declares 32768. Host RAM 61 GB |
| App chat model preference | `qwen3.6:35b` |

## 2. HALO VC-02 root cause

The original instruction was recovered from the installed app's conversation store (`c-432e645462dbabbf`, run `session-1794940660160`). The app keeps no per-tool trace, so model inputs and observations of the original run are **not recoverable**; the diagnosis below is from a **reproduction** with the exact instruction on rc.24 code in a disposable copy of the same workspace (`~/Desktop/halo-control`, a snapshot without Git or `node_modules`).

Reproduction: Qwen3-Coder 3/3 and Qwen3.6 3/3 end `NON_PROGRESS: list_directory was refused 4 times`; Coder reproduces the original message byte for byte. The original runs were most likely served by Qwen3-Coder (the Qwen3.6 blob was written at 19:35, after the first failing conversation at 18:56); not proven.

Causes, earliest first (all verified in the reproduction traces and source):
1. **Routing.** "AGENTS.md" in the brief made it `RULES_QUERY` ("read AGENTS.md" strategy), and every named `.md`, including files the brief said to *read*, became a required edit ("Create or update AGENTS.md, CLAUDE.md, ...").
2. **Duplicate lookups refused** (`DENIED`) without the earlier result, each counting toward the 4-refusal stop.
3. **Observations rendered newest first**: the prompt ended with the oldest result (the first listing). Found only after 1-2 were fixed (1/6 HALO passes), when models still repeated the call whose result closed the prompt.
4. Truncation flags dropped from listings/searches (contributing; not triggered by HALO).
5. **Environment-blocked verification treated as a code failure**: `pnpm build` failed because Corepack tried to download pnpm in the no-network sandbox, and the evaluator asked to "propose a corrective mutation"; the model then re-read the same file until stopped.

Context-budget omission (brief weakness B) was **not** a cause here: 0-1 items omitted per turn, never the listing.

## 3. Changes (23 files, +1057/-60)

| Commit | Change |
| --- | --- |
| `ce74401570` | Objective-first routing: `RULES_QUERY` only without a change request; multi-part briefs → `IMPLEMENTATION`; paths in "read/inspect/review ..." clauses are context (`task-profile.ts`, `tool-contract.ts`) |
| `8c3a80e25b` | Task-scoped observation registry: repeated lookups answered `ALREADY_OBSERVED` (completed, not refused), re-reads compared, cleared on any workspace change, bounded; truncation stated; observed index for evicted results (`runner.ts`, `observations.ts`, `compiler.ts`, `list-directory.ts`, `read-only-registry.ts`) |
| `84ee5b0dd0` | P1: repeated `rename_symbol`/`find_symbol` on an already-renamed name → `ALREADY_SATISFIED` while the file still shows it |
| `6d864ef27c` | Observations presented chronologically (selection still newest-first) |
| `203bdf81d7` | Blocked verification → `EXECUTION_ERROR` + `ENVIRONMENT:` diagnosis; no revision demand; not re-run or re-approved; truthful `VERIFICATION_UNAVAILABLE` end (`verification-registry.ts`, `l0-deterministic.ts`, `runner.ts`) |
| `a3f93ded06`, `6b2dd92be4` | Eval harness: `--trace`; route the chosen model exactly like the desktop. **The Sprint 21-24 harness silently served `qwen2.5-coder:7b` for any model outside the Qwen-Coder families**; Sprint 21-24 results (Coder only) are unaffected |

Open-source: SWE-agent `3ea751c087f3` (MIT), search feedback; Gemini CLI `4fa64e71b9b4` (Apache-2.0), loop-detection design; Aider `5dc9490bb35f` (Apache-2.0), RepoMap reviewed, not ported (file discovery was not the limiting factor); Anthropic tool/context-engineering articles. No upstream code copied, no new dependencies.

Deterministic tests: 36 new (observation registry incl. traversal/denial/failure non-caching, routing on multi-paragraph briefs, truncation, index, chronology and budget pressure, completed renames incl. same-named symbol and changed workspace, environment classifier incl. real failures staying `FAIL`), 5 updated to the new contract. agent-core 1205/0, ide-adapter 7/0, vscode-integration 339/0, typecheck and lint clean.

## 4. Evaluation (live, headless bridge = desktop path; 10-min wall clock per task)

Oracles were frozen before any run on them (`halo-oracle.py` and `tasks/build_tasks.py` hashed; every task oracle verified to fail on its base and pass on a reference solution). Runs whose served model did not match the request are excluded (the first Qwen3.6 batch, see §3).

### HALO VC-02 (exact instruction, disposable copies; oracle: no lookup loop, ≥3 source files read, AGENTS/CLAUDE untouched, no false claim)

| Runtime | Qwen3-Coder 30B | Qwen3.6 35B |
| --- | --- | --- |
| rc.24 (`453c3a2a0c`) | 0/3 (3× refused-lookup stop, 0 source files read) | 0/3 (3× refused-lookup stop) |
| Fixes 1-2 only (`8c3a80e25b`) | 0/3 | 1/3 |
| **Candidate (`203bdf81d7`)** | **2/3** | **3/3** |

No candidate run completes VC-02 itself (multi-phase sprint, systemd inspection outside the workspace, no installed dependencies): all end `NON_PROGRESS` after exploring (3-8 source files, e.g. `apps/halo-core/src/version.ts`) when the model starts re-reading. The failing Coder run (r1) made an **incorrect** change: `version.ts` reads `git rev-parse HEAD` at runtime (the brief forbids this) and hard-codes `provenanceStatus: 'trusted'`; the run ended FAILED and claimed nothing. No run touched AGENTS.md/CLAUDE.md or claimed a deployment.

### Six unseen tasks (Eyes_Without_A_Face TS/React ×4, Clipping_agents Python ×2; hidden oracles)

| Task | Coder cand r1/r2 | Qwen3.6 cand r1/r2 | Coder rc.24 | Qwen3.6 rc.24 |
| --- | --- | --- | --- | --- |
| t1 cross-file bug (email normalization) | fail / fail | **PASS / PASS** | fail | PASS |
| t2 multi-file feature (NDJSON import) | fail / fail | fail / fail (timeout) | fail (timeout) | fail (timeout) |
| t3 TS refactor (rename across .ts/.tsx) | fail / fail | fail / fail | — | — |
| t4 regression diagnosis | PASS / fail | **PASS / PASS** | fail | PASS |
| p5 Python bug fix | fail / PASS | **PASS / PASS** (unverified, see below) | — | — |
| p6 failing-test repair | fail / fail | fail / **PASS** | fail | PASS (timeout after the fix) |
| **Total** | **2/12** | **7/12** (3/6, 4/6) | 0/4 | 3/4 |

| Config | False completions | NON_PROGRESS | Invalid tool calls | Median s/task | Median s/model turn | Approvals |
| --- | --- | --- | --- | --- | --- | --- |
| Coder, candidate | 0 | 10/12 | 0 | 56 | 3.4 | 33 |
| Qwen3.6, candidate | 0 | 2/12 | 0 | 268 | 22.2 | 42 |

Uncertainty: 2 repetitions per cell; one pass or fail moves a task's rate by 50 points. The subset comparison with rc.24 is 1 run per cell.

Reading: the candidate removes the HALO loop for both models. On these unseen tasks it does **not** measurably beat rc.24 for Qwen3.6 (subset 2/4 and 3/4 vs 3/4); Qwen3.6 is far stronger than Qwen3-Coder on both runtimes. Qwen3-Coder mostly ignores `ALREADY_OBSERVED` and repeats the identical call until the bound stops it (now in ~20 s instead of looping).

Defects seen on unseen tasks (held out; reported, not tuned):
- **Python verification**: discovery runs `python3` from PATH and refuses the workspace `.venv` (ADR-046 policy), so pytest projects with a venv are always "blocked"; p5 passes the oracle but ends `VERIFICATION_UNAVAILABLE`. Correctly reported, never claimed verified.
- **t3**: `rename_symbol` refused by the mutation size budget ("Added lines 341 exceeds budget 200") for a 4-file rename touching a 939-line file.
- **Qwen3.6 latency**: 2 runs hit the 180 s per-request limit (`MODEL_ERROR`), t2 timed out 4/4 at 10 min.
- **Unrequested change**: Qwen3.6 added a `"test"` script to `package.json` in 5 TypeScript runs (both runtimes) to make verification runnable. Inside the workspace and approved through the normal review; not requested.

Not done: the compiled-user vs native-tool-message comparison (not run); no model settings were changed.

## 5. Packaged GUI (unpacked rc.25 `.deb`, CDP-driven, never installed)

Critical acceptance: **18/20**. All safety scenarios pass (ASK/PLAN read-only, approve, reject, injection, dangerous command, traversal, verify, no silent edit, profile isolation, sandbox, stale continue, upgrade, rollback). `UX-MODELS` and `LIFE-FIRST` fail as on rc.23/rc.24 (blank first-launch panel; pre-existing). `LIFE-ROLLBACK` first failed for a missing rc.11 package in the new worktree; passed once supplied.

| Scenario | Model (status line) | Result |
| --- | --- | --- |
| A. HALO VC-02, exact instruction, disposable copy | Qwen3.6 | **FAIL** (1 run): `NON_PROGRESS`, `list_directory` repeated 6×; no files changed; build verification "could not be started"; the app flagged the reply's unsupported claim. Headless 3/3 for the same configuration |
| B. NDJSON multi-file feature (unseen in GUI) | Qwen3.6 | **FAIL** oracle (unit + typecheck): 5 files changed, 12 approvals, 17 min; run ended `VERIFICATION_UNAVAILABLE` after the model's own `package.json` `test` script made verification need pnpm |
| B2. Regression diagnosis t4 (run headless before, never in the GUI) | Qwen3.6 | **Correct fix, oracle PASS** (one line, identical to the reference; 656 unit tests + hidden tests + typecheck). The run itself ended `MODEL_ERROR` (one request > 180 s) before verification and reported "Task not completed. Verification was not executed." |
| C. Model switching through the picker | both | **PASS**: with all models unloaded, choosing `qwen3.6:35b` → status "Ready · qwen3.6:35b" → Ollama loaded `qwen3.6:35b` for the next request; the default `qwen3-coder:30b` likewise. **Defect**: a change made while the panel is still syncing its model list on startup is dropped (`syncingModels`) while the picker keeps showing it; only the status line is truthful. The lab driver sent before the change landed; it now waits for the status line |
| D. Interrupt and resume | Qwen3-Coder | `CODE-CONTINUE` PASS, `CODE-CONTINUE-RESTART` PASS, `CODE-CONTINUE-STALE` PASS (critical set); `CODE-CONTINUE-COMPLETE` FAIL (independent tests fail after completion; model) |
| E. Safety | — | all safety scenarios in the critical set PASS (above) |

Screenshots, transcripts and diffs: `~/.cache/ovsc-sprint25/gui-evidence/` (local; contain local paths, not published).

## 6. Release

| Item | Value |
| --- | --- |
| Candidate | `0.1.0-rc.25`, source `203bdf81d744dd0b27400a498a27f0040e80d7b7` (+ this report) |
| `.deb` SHA-256 | `2a4ac171090cc00ed1c6237e3bf41b191674c3faa80e817ee65b6336fe2a90de` |
| tarball SHA-256 | `8e62b2b4398a81973cfcad43c2bd78ee3fdd90133f5e61bcf26ee905f9623734` |
| bundled `extension.js` | `4f82167a663a4af430dd875226a6a38b35ae46e3cf9b95396e13d46cab3831bf` |
| CI | not run on the candidate (commits are local; push not authorized). Last green: `453c3a2a0c` |
| Rollback | rc.24 `.deb` `fd911e10b6a2...eb8b` verified, copied to `~/.cache/ovsc-sprint25/rollback/`; installed rc.24 untouched |

## 7. Recommendation: CONDITIONAL GO for rc.25 as the next candidate; not eligible for installation yet

Met: the HALO refused-lookup loop is gone and repeated lookups are no longer failures (headless HALO 0/6 → 5/6); routing handles implementation briefs; earlier results stay reachable; 0 invalid tool calls; 0 false completions in 50 headless and 3 GUI task runs; no AGENTS/CLAUDE or out-of-workspace writes; safety acceptance unchanged (18/20, same two pre-existing failures).

Not met:
1. Linux CI has not run on the candidate (local commits; push needs your authorization).
2. Unseen tasks on the best configuration (Qwen3.6): 3/6 and 4/6. The ≥4/6 bar is met in one of two repetitions.
3. Packaged GUI: no run *completed* a development task end to end. B2 produced an independently verified correct fix, but the run ended on a model timeout. GUI HALO failed (1 run).
4. Qwen3.6 added an unrequested `test` script to `package.json` in 5 TypeScript runs (approved, inside the workspace).
5. Symbol intelligence: unit suite intact; a 4-file rename was refused by the mutation size budget (t3). S24B was not re-run.

Installation: rc.25 fixes the failure the daily driver (rc.24) hit on HALO and has no new safety finding, but conditions 1-3 should hold first. Rollback: `sudo dpkg -i ~/.cache/ovsc-sprint25/rollback/open-vs-code_0.1.0-rc.24_amd64.deb` (hash verified).

Model: **Qwen3.6 35B for coding** on measured success (unseen 7/12 vs 2/12; HALO 3/3 vs 2/3; Qwen3-Coder ignores `ALREADY_OBSERVED`), at ~6.5× the latency per model turn (22 s vs 3.4 s median) with occasional >180 s requests. It is already your app selection. The product default stays `qwen3-coder:30b` until the 180 s request limit (or thinking mode) is settled in a separate, measured change.

## 8. Next step

**Make verification runnable in real workspaces.** It ended more candidate runs than any model error: every Python run (the workspace `.venv` is refused by policy, so pytest is "not installed"), the HALO snapshot and GUI B (pnpm through Corepack in the no-network sandbox), and the `package.json` edits models make to get a test command. A decision on trusted workspace interpreters and package managers in the sandbox (ADR-046) is the single most useful change for everyday coding.
