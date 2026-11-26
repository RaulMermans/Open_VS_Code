# Sprint 32 — Product convergence, managed inference and functional MVP

STATUS: `IN_PROGRESS` — technical MVP candidate built and exercised; supervised-testing and daily-driver NO-GO.

## Starting state (revalidated 2026-11-25)

| Claim in the brief | Observed |
| --- | --- |
| Installed app is rc.25 | **rc.26** is installed (`dpkg`). PLAN.md said rc.27 was the production target; rc.27 was packaged (`673a8f1`, `.deb` SHA-256 `2793295b…`) but never installed. |
| Sprint 31 and later branches unmerged | All sprint branches (`sprint/31-mvp-convergence`, `repair/30`, `vc-07b`) are already in `main`. Local `main` is one commit (the rc.27 version bump) ahead of `origin/main`. |
| `main` is green | **No.** `tsc` failed in agent-core (5 `exactOptionalPropertyTypes` errors) and one registry test failed (a tool description over 100 chars). Fixed in `1a3ffbb`. |
| Qwen3.6 35B is the principal model | Installed: `qwen3.6:35b` (`a7eb95c53bcf`, qwen35moe, 35.5B, Q4_K_M, thinking + tools), `qwen3-coder:30b` (`06c1097efce0`, qwen3moe, 30.5B, Q4_K_M, tools), `qwen2.5-coder:7b` (FIM, autocomplete), `qwen3.5:4b`, `qwen3-embedding:0.6b`. Ollama 0.40.15, server `OLLAMA_CONTEXT_LENGTH=65536` (the app's descriptor says 32K; the `/v1` path cannot set `num_ctx`). 64 GiB VRAM carve-out; `qwen3-coder:30b` resident at 25.4 GB. |
| HALO adapter exists, protocol unproven | Confirmed, and deployed HALO cannot carry tool calls (see HALO below). |

Worktrees: `~/.cache/ovsc-sprint32/wt` (`sprint/32-product-convergence`, baseline) and `~/.cache/ovsc-sprint32/wt-fix` (`sprint/32-runtime-fixes`). `npm ci --offline --ignore-scripts`; every `@open-vs-code/*` link resolves inside its worktree. Installed app, user profile and HALO services were not changed.

## Desktop candidate

Baseline candidate: the existing rc.27 `.deb` (clean `673a8f1`). Outside the bundled extension it differs from installed rc.26 only in two build timestamps (`product.json` date, release stamp), so the lab ran the installed root-owned shell (`chrome-sandbox` 4755) with rc.27's built-in extensions (`--builtin-extensions-dir`, `extension.js` SHA-256 `3465ce99…`). Each launch had its own temp `--user-data-dir` and, after this sprint's fix, its own `--extensions-dir`.

Lab defects found and fixed before the GUI numbers below were taken (`1a3ffbb`, `2f5a619`):

- Lab launches loaded the user's own extensions (GitLens opened its Welcome page in a "fresh" profile). Each launch now gets an isolated `--extensions-dir`.
- The Playwright launcher ignored the candidate override, so LIFE-FIRST had silently tested the installed rc.26 extension.
- LIFE-FIRST used Playwright's Electron attach, which cannot see the Agent webview (`iframes.json` empty), and failed on a correct empty state. It now uses the CDP harness and records cold-start time.
- LIFE-ROLLBACK checked a hardcoded rc.11 path. It now checks an explicit `OPEN_VS_CODE_ROLLBACK_DEB`.

### rc.27 GUI acceptance (packaged app, CDP/Playwright lab, `qwen3-coder:30b`, run `2026-11-25T19-07-44-940Z`)

30 PASS, 1 NEEDS_REVIEW, 6 FAIL of 37 run.

- PASS — conversation: CONV-PING, CONV-MISSING. Coding: CODE-BUG, CODE-MULTI, CODE-REFACTOR, CODE-ADD-TEST, CODE-FIX-TEST, CODE-DEBUG, CODE-RECOVER, CODE-HELD-TS, CODE-HELD-PY, CODE-CONTINUE-STALE. Safety: SAFE-ASK-RO, SAFE-PLAN-RO, SAFE-APPROVE, SAFE-REJECT, SAFE-INJECT, SAFE-DANGEROUS, SAFE-TRAVERSAL, SAFE-STALE, SAFE-VERIFY, SAFE-NO-SILENT, SAFE-PROFILE. UX: UX-WIDE, UX-TRUST, UX-PROTOCOL. Lifecycle: LIFE-SANDBOX, LIFE-SECOND-REPO, LIFE-HISTORY, LIFE-CRASH, LIFE-UPGRADE, LIFE-ROLLBACK.
- NEEDS_REVIEW: UX-DIFF (objective checks met; a person has not signed the visual).
- FAIL, product: CONV-FILE-REF. Ask "Which file defines add?" answered "the search did not return any matching results". `search_text "add"` on the same fixture returns `src/add.js:1`, so the model searched with a query that matched nothing; the lab does not record tool arguments. Single occurrence; not reproduced.
- FAIL, lab tooling (Playwright path cannot drive the webview or quick input): SAFE-CANCEL, UX-MODELS, UX-ERROR, UX-KEYS, LIFE-MODEL. These are unverified in the GUI, not passed.
- Cold launch: three clean profiles opened to a usable composer, the untrusted-folder notice, and `Ready · qwen3-coder:30b` (screenshots `…19-06-47-149Z/LIFE-FIRST/cycle-0{1,2,3}`). The automated verdict was FAIL because of the Playwright defect above; the CDP rerun is recorded under rc.28 below.

### rc.28 candidate GUI acceptance (packaged extension `7c87d5a6…`, runs `2026-11-25T20-45-52-162Z` and `…20-46-02-961Z`)

Same lab, isolation fixes in place, `qwen3-coder:30b` (the lab's scenario model).

- LIFE-FIRST cold launch on three clean profiles over CDP: **3/3 PASS**, usable composer and empty-state copy after 3,042 / 3,002 / 2,921 ms.
- 34 scenarios: **33 PASS, 1 NEEDS_REVIEW (UX-DIFF), 0 FAIL.** Includes every coding scenario (CODE-BUG, MULTI, REFACTOR, ADD-TEST, FIX-TEST, DEBUG, RECOVER, HELD-TS, HELD-PY, CONTINUE-STALE), every critical safety scenario run (ASK-RO, PLAN-RO, APPROVE, REJECT, INJECT, DANGEROUS, TRAVERSAL, STALE, VERIFY, NO-SILENT, PROFILE), UX-WIDE, UX-TRUST, UX-PROTOCOL, and lifecycle (SANDBOX, SECOND-REPO, HISTORY, CRASH, UPGRADE, ROLLBACK). CONV-FILE-REF, which failed once on rc.27, passed.
- Not run on rc.28 because they cannot drive the webview on the Playwright path (they failed as tooling on rc.27): SAFE-CANCEL, UX-MODELS, UX-ERROR, UX-KEYS, LIFE-MODEL. Cancellation, model persistence and the missing-model error therefore remain unverified in the packaged GUI.
- A person has not signed the UX-DIFF visual.

## MVP coding benchmark (S32)

`packages/ide-adapter/evals/coding-tasks-s32.ts`, frozen at `cd86f3b` before any model run (SHA-256 `ba854248e2cb5bf4…`). Ten disposable Git repositories: explain (Ask), bugfix, small feature, write tests, failed-test repair, cross-file rename with a same-named distractor, multi-file TypeScript, Python regression, React-style frontend change (no React runtime is installed offline, so components use a local `h()`/`render()`), and a cache feature with integration and tests. Each has an allowed-change list, files that must stay byte-identical, visible tests the agent can run, and a hidden oracle run from outside the workspace. Test-writing is judged by four mutants of the implementation. `--check-references` proves each oracle rejects the untouched fixture and accepts a hand reference (10/10; the hand references are not agent results). The check caught one fixture defect before freezing (hidden `tsc` on `test/` without Node types).

The runner drives the desktop path (`AgentSessionBridge.runTask → createAgentRuntime`, the desktop's chat routing, TypeScript code intelligence on, 10-minute budget, all approvals granted and counted). It refuses to start when the model is missing or a workspace package resolves outside the checkout, and records the benchmark hash, model digest and source head. Pass = visible tests pass + hidden oracle passes + no out-of-scope change + protected files unchanged (Ask: hidden answer checks + no change).

### Results

Pass counts code that passes the visible tests and the hidden oracle within scope. "Completed" counts runs whose own status was COMPLETED. No run in any column was a false completion (COMPLETED with failing visible tests).

| Task | qwen3.6 base | qwen3-coder base | qwen3.6 fixed | qwen3-coder fixed |
| --- | --- | --- | --- | --- |
| 01 explain (Ask) | FAIL (no numbers) | FAIL (said 100) | PASS | FAIL (said 100) |
| 02 bugfix | PASS 24 s | PASS 9 s | PASS 64 s | PASS 8 s |
| 03 feature (CSV) | PASS 55 s | PASS 13 s | PASS 55 s | PASS 9 s |
| 04 write tests | PASS 99 s | PASS 46 s | PASS 127 s | FAIL (hour mutant survives) |
| 05 failed-test repair | PASS, CANCELLED 600 s | PASS 63 s | PASS 47 s | PASS 12 s |
| 06 rename + distractor | PASS, reported FAILED | PASS, reported FAILED (298 s) | PASS 39 s | PASS 14 s |
| 07 multi-file TS | FAIL (tsc) | PASS 27 s | PASS 110 s | PASS 15 s |
| 08 Python regression | FAIL (accepts +12) | FAIL | FAIL (accepts +12) | FAIL (+49 as US) |
| 09 frontend | PASS 52 s | FAIL, CANCELLED 600 s | PASS 75 s | PASS 7 s |
| 10 cache feature | PASS 305 s | FAIL, NON_PROGRESS 392 s | PASS 292 s | FAIL, NON_PROGRESS 37 s |
| **Pass** | **7/10** | **6/10** | **9/10** | **6/10** |
| Completed | 8 | 7 | 10 | 9 |
| Total time | 1,477 s | 1,484 s | 925 s | 176 s |
| Model calls | 51 | 184 | 41 | 41 |
| Write / command approvals | 14 / 11 | 47 / 69 | 16 / 12 | 14 / 11 |

"base" is `2f5a619`; "fixed" is `1d467d1` (two runtime fixes below). Results: `evals/results/s32-*.json` and `s32fix-*.json`. Traces stay outside the repository (`~/.cache/ovsc-sprint32/traces/`).

S32 informed the two runtime fixes, so the "fixed" columns are not an unseen-task score. They show the fixes changed the two targeted outcomes and did not reduce correctness elsewhere. The daily-driver 8/10 gate needs a new held-out set written before the next run.

### Failure classification (first causal error)

| Run | Task | First causal error | Class |
| --- | --- | --- | --- |
| qwen3.6 base | 01 | Answered from three search snippets without opening the 16-line file that holds the limit | Missing context (model) |
| qwen3.6 base | 05 | Fix applied at 70 s and tests passed; the coding gate then required an edit to the test the user said not to change, and L0 kept REVISE on an "already applied" patch | Agent runtime (fixed) |
| qwen3.6 base | 06 | `rename_symbol` renamed everything correctly; the only path named was the protected distractor, so the gate demanded an edit to it and the run ended NON_PROGRESS | Agent runtime (fixed) |
| qwen3.6 base | 07 | `createOrder` took `currency: string`; tests pass under strip-types, hidden `tsc` fails; the agent's verification never typechecks | Incorrect implementation, not caught by verification |
| qwen3.6 base/fixed | 08 | Accepts `+12`. The instruction did not state a minimum length | Ambiguous requirement (benchmark) |
| qwen3-coder | 01 | Reported the unused `PROXY_RATE_LIMIT = 100` from `config.ts` as the limit, in both runs | Incorrect localization (model) |
| qwen3-coder fixed | 04 | Tests do not distinguish a wrong hour unit | Weak tests (model) |
| qwen3-coder | 08 | `+49 30 901820` (10 digits) normalized as a US number | Incorrect implementation (model) |
| qwen3-coder base | 09 | Filtered on `todo.completed`; the data model uses `todo.done`; 21 re-patches without re-reading | Missing context, thrashing (model) |
| qwen3-coder | 10 | Did not wire the cache into the service / wrote no cache tests; ended NON_PROGRESS truthfully | Incorrect implementation (model) |

Most frequent: model-side context and implementation errors (10 of the 12 failures across four runs); the other 2 are the ambiguous `+12` requirement. The two runtime defects caused the costliest outcomes (a 600 s run and a false failure after correct work) and are fixed. No failure came from tool-argument errors, stale builds, policy conflicts, truncation or approvals.

### Where the time goes

Both models spend 97–98% of task wall-clock waiting for the model (qwen3.6 baseline: 1,429 s of 1,477 s; qwen3-coder: 1,454 s of 1,484 s). Estimated compiled prompts are small (about 0.7K–10K tokens, except one 48K-token runaway). Verification runs take 0.25–0.4 s each in bubblewrap. Context building, tool execution and verification are not the bottleneck; generation is. For qwen3.6 that is mostly reasoning output: the two-call bugfix took 23 s against 7 s for qwen3-coder. The runaways (qwen3.6 s32-05, qwen3-coder s32-06/09/10) spent their time on repeated turns after the work was done or while thrashing, not on long prompts. Reasoning was not disabled; no evidence yet says correctness would survive it.

## Model comparison and Auto

| Model | Digest | Pass (2 runs) | Mean task time (fixed code) | Notes |
| --- | --- | --- | --- | --- |
| `qwen3.6:35b` | `a7eb95c53bcf` | **16/20** | 92 s | Never failed frontend or the cache feature. Slow: reasoning output dominates. |
| `qwen3-coder:30b` | `06c1097efce0` | 12/20 | 18 s | 5× faster; failed explain twice, Python twice, cache feature twice. |

Correctness decides. The evidence supports Auto's existing order (`qwen3.6` first, then `qwen3-coder`; `local-model-selection.ts`), so Auto was not changed. Manual selection still lets a user trade correctness for speed with `qwen3-coder:30b`, which remains the fresh-install manual default; changing that default is a product decision with a 5× latency cost and is left open. Autocomplete stays on `qwen2.5-coder:7b`. Two repetitions per model is a small sample: the per-task picture (which tasks each model misses) is more reliable than the totals.

No new model was researched or downloaded: two capable coding models were already installed, and the remaining failures are mostly reasoning, which a larger download would not be shown to fix without its own run.

## HALO

Read-only inspection of the deployed Core (`127.0.0.1:4310`, release `halo-core-0.1.0+ccd05e504ffd`) and of the HALO repositories. Details and the handoff are in `docs/deployment/HALO_SPRINT32_HANDOFF.md`.

- Works today: health, `/inference/status`, `/models`, `/routes`, `/infrastructure/model-runtimes` (runtime phase, port, artifact SHA-256s), `/inference/admission` (1 active / 8 queued, occupancy), `/hardware` (CPU and RAM; GPU `unavailable`). Open VS Code's Check HALO Connection uses health, status, access and model.
- Not deployed: the VC-07B tool protocol (`edb6393`). Deployed `/inference/status` says `tools: false`; request schemas are strict, so a tool-carrying capability request is rejected.
- Not managed by HALO: Open VS Code's coding models. HALO registers only Qwen3 4B and 14B on llama.cpp Vulkan with 8K context. HALO does not observe Ollama, so every Direct Ollama request bypasses HALO admission and HALO telemetry says nothing about it.
- Phase D (identical-digest A/B) was not run: no model is served by both paths. It needs HALO changes that were not authorized.
- Fixed in Open VS Code (`30baf40`): with `open-vs-code.halo.modelId` set, HaloProvider silently dropped every tool, so Agent and Debug ran a model that could never edit. Write tools are now refused before any request; read-only Ask keeps working as VC-07 Gate C verified. The connection check treated a Core that advertises tools as a failure; it now reports tool support truthfully and says when HALO is Ask-only.
- HALO is not eligible for Agent mode. HALO provides no measured infrastructure benefit to Open VS Code today.

## Runtime fixes from observed failures

Bounded loop: two hypotheses, one implementation each, both kept (`1d467d1`).

1. **Protected paths became the required edit.** `excludedEditPaths` only knew "do not edit PATH". "PATH fails… do not change **it**" and "PATH has its own helper; leave **that file** alone" left the protected file as the only named path, and the all-excluded fallback put it back. `protectedEditPaths` binds such a clause to the last path in its paragraph, and a protected path is never required. Tests use different wording from S32 (`completion-gate.test.ts`).
2. **Failed edits kept a verified workspace in REVISE.** After a passing verification with no later edit, an "already applied" `apply_patch` failure stayed in `unresolvedFailures`, and L0 answered REVISE at every completion attempt until the budget ran out. Failed edits and lookups changed nothing, so they no longer block verified completion; failed checks (for example a typecheck) still do (`verified-completion.test.ts`).

Effect on qwen3.6 S32: 05 from CANCELLED at 600 s to COMPLETED at 47 s; 06 from FAILED (after correct work) to COMPLETED at 39 s; total time 1,477 s → 925 s; model calls 51 → 41.

Also fixed this sprint: `main` typecheck and test (`1a3ffbb`), acceptance-lab isolation and harness defects (`1a3ffbb`, `2f5a619`), HALO tool refusal (`30baf40`).

Full suites on `1d467d1`: typecheck clean; agent-core 1,294 pass (the Real Chromium motion test failed once under benchmark GPU load and passed 3/3 idle), vscode-integration 343, account-service 84, cli 21, ide-adapter 26, desktop lab 8.

## S33 held-out benchmark on rc.28

`packages/ide-adapter/evals/coding-tasks-s33.ts`, written after the Sprint 32 fixes and frozen at `d3f863b` (SHA-256 `1a425cba380fc9cb…`) before any run; never used to tune. Same schema and categories as S32, new code, more Python (sentence count, mutant-judged tests, cross-file rename without a language-service rename, env-parsing regression). Every behaviour an oracle checks is stated in the instruction or fixture. `--check-references --split S33`: 10/10. The agent runtime is byte-identical to the rc.28 bundle (`git diff 6db8732 -- packages/agent-core packages/ide-adapter/src packages/vscode-integration` is empty). Two repetitions per model, 10-minute budget, code intelligence on.

| | qwen3.6:35b | qwen3-coder:30b |
| --- | --- | --- |
| Run 1 / run 2 (oracle pass) | 7/10, 9/10 | 7/10, 9/10 |
| Total (20 runs) | **16/20** | **16/20** |
| Clean (pass and COMPLETED) | 6/10, 8/10 | 6/10, 8/10 |
| False completions | 0 | 0 |
| Median task time | 93 s, 44 s | 19 s, 13 s |
| Total time (20 runs) | 2,365 s | 749 s |
| Write / command approvals | 43 / 22 | 53 / 33 |

Per task (both models): 02 bugfix, 04 write tests, 05 failed-test repair, 07 multi-file TS (with `tsc`), 08 Python regression and 09 frontend passed 4/4. 01 explain and 03 sentence count failed once per model. 10 limiter failed 4/4. 06 rename produced correct code 4/4 but always ended FAILED/INCOMPLETE.

Failures by first cause:

- **06 (4/4), agent runtime.** The rename-coverage requirement check counts every `calc_total` in the repository. It told the agent to rename it in `shop/legacy_reports.py`, which the instruction protects ("Do not edit shop/legacy_reports.py"), and in `tests/test_shop.py`'s import of that unrelated function. The permission layer correctly denied the edit, so correct work ended "Incomplete". Same family as S32-06 (a protected file treated as work to do), different mechanism: the coverage check does not use `protectedEditPaths`/`excludedEditPaths`. `rename_symbol` also reports "typescript language service found no definition" on a `.py` file and that failure feeds an extra REVISE.
- **10 (4/4), model.** Both models refill only inside `tryTake`, so the `available` getter returns stale tokens, against "refills continuously". qwen3.6 even wrote tests that call `tryTake(0)` to "trigger lazy refill".
- **01 (1/2 each), model.** qwen3.6 run 1 quoted the unused 10-second legacy delay; qwen3-coder run 1 named neither the function nor the numbers.
- **03 (1/2 each), model.** Trailing text without a terminator counted as 0 (qwen3.6); `"Hi!!! "` counted as two sentences (qwen3-coder).

What S33 says:

- **Daily-driver 8/10 unseen gate: met on average (8.0/10 per run for both models), not on every run** (7/10 in each model's first run). On the clean-outcome measure (pass and COMPLETED) both average 7/10, below the gate, entirely because of the 06 defect.
- **Model ranking does not hold.** On unseen tasks qwen3-coder matches qwen3.6 (16/20 each) at about 3× less time. Across S32 and S33 together: qwen3.6 32/40, qwen3-coder 28/40; the gap comes from S32. Auto's order (qwen3.6 first) is no longer clearly supported; correctness is tied on unseen work and qwen3-coder is much faster. Not changed in this pass.
- S33 is now observed. Any fix for the 06 defect must be judged on another held-out set.

## Rename fixes and the S34 held-out benchmark

**Fix 1, rename coverage (`2af8812`).** The S33-06 completeness check counted a protected file's same-named function, and imports from it, as unfinished rename work, and read an aliased import as unused. Protected paths and imports from them are now skipped; a real unrenamed caller is still reported (`requirement-checks.test.ts`, which fails on the old code).

**S34**, `packages/ide-adapter/evals/coding-tasks-s34.ts`, written after fix 1 and frozen at `75ea63d` (SHA-256 `a30d42f8051fa740…`) before any run. Ten new tasks: Ask (cache TTL and invalidation), truncate off-by-one, deep config merge, query-parser tests judged by five mutants, Python word-wrap repair, TypeScript rename with a vendored same-named export and an aliased import of it, multi-file note tags with `tsc`, Python CSV regression, React-style tabs, Python undo/redo with history and tests. `--check-references --split S34`: 10/10. Runtime `2af8812`, both models twice, 10-minute budget.

| | qwen3.6:35b | qwen3-coder:30b |
| --- | --- | --- |
| Run 1 / run 2 | 7/10, 7/10 | 8/10, 7/10 |
| Total | **14/20** | **15/20** |
| False completions | 0 | 0 |
| Median task time | 90 s, 115 s | 20 s, 11 s |
| Total time | 3,084 s | 665 s |

- **06 rename, 0/4 for both models: agent runtime.** `rename_symbol` refused because coverage treated `export function loadSettings` in the unrelated vendored module as an import it could not resolve, and `apply_patch` then refused the manual rename (RENAME_BY_PATCH). No model could rename. **Fix 2 (`5d1253e`):** an occurrence whose definition is itself, on a line that is not an import or re-export, is a different symbol's declaration; unresolved imports still block (`code-intelligence.test.ts`, which fails on the old code).
- **01 explain, 0/4 for both models.** Neither model opened a file: they answered from search snippets (qwen3-coder partially; qwen3.6 concluded the information did not exist after literal searches found nothing). Same cause as S32-01 and the GUI's CONV-FILE-REF. Not fixed.
- **10 undo/redo, 3 of 4 runs failed: model.** Wrong undo/redo state handling.
- Everything else passed in every run.

**Confirmation on the fixed runtime (`5d1253e`), observed tasks, not an unseen score:** S33-06 and S34-06, both models twice: **8/8 pass and COMPLETED** (S33-06 was 0/4 clean; S34-06 was 0/4). Results: `evals/results/confirm-*.json`.

Across the three held-out-style sets, unseen scores per run sit at 7–9/10 for both models. The 8/10 daily-driver gate is not reliably met. The remaining shared failure is Ask mode answering without reading files. On unseen tasks qwen3-coder matches qwen3.6 (31/40 vs 30/40 on S33+S34) at 3–5× less time.

## Ask reads before answering (`3d4e083`) and rc.29

Ask answers were built from single search-hit lines, or from a literal phrase search that matched nothing, without opening a file (S32-01, S34-01 0/4 for both models, the GUI's CONV-FILE-REF). The general evidence gate is off in production (`createAgentRuntime` sets `evidenceGate: false`), so a narrow rule was added instead: in Ask mode, an answer after a content lookup (`search_text`, `find_symbol`) with no `read_file` gets one READ BEFORE ANSWERING nudge naming the files the searches hit; a zero-hit `search_text` in a read-only turn says the search is literal and suggests identifiers, listing or reading. Listing questions, direct replies and other modes are unchanged (`read-before-answer.test.ts`). A first version that also covered Plan mode and listings broke three existing scripted tests and was narrowed.

Confirmation on observed explain tasks (not an unseen score), both models twice each:

| Task | before (base runs) | after |
| --- | --- | --- |
| S32-01 | qwen3.6 1/2, coder 0/2 | qwen3.6 2/2, coder 1/2 |
| S33-01 | qwen3.6 1/2, coder 1/2 | qwen3.6 2/2, coder 2/2 |
| S34-01 | 0/2, 0/2 ("no information" / partial) | 0/2, 0/2 |

On S34-01 all four answers now give the file, the 300-second TTL and `invalidateProducts`; they still omit the caller `updateProduct`, which the strict oracle requires. Results: `evals/results/confirm-ask-*.json`.

### rc.29 candidate

`0.1.0-rc.29` from clean `b6872ed`, `.deb` SHA-256 `20ad448a7c1f5cf0ec926b0a30f4c844b9c2f931fe2dde456eecee06e9608f5a`, archive `0d5df3185f26449f…`, bundled `extension.js` `2e753cc5ba33bbbb…`. Contains the rename and Ask fixes (checked by string in the bundle). Later commits on the branch change only docs and one test file. CI (Ubuntu, Node 22 and 24: typecheck, lint, tests, build) is green on the branch; the first push failed on two oxlint errors in `halo-tool-cycle.test.ts`, fixed in `c260184`.

Packaged GUI (runs `2026-11-26T15-21-22-438Z`, `…15-21-34-027Z`): cold launch 3/3 (2.9–3.2 s); 37 PASS, 1 NEEDS_REVIEW (UX-DIFF), 1 FAIL (CODE-CONTINUE-STALE). New passes over rc.28's set: CONV-EN, CONV-EXPLORE, CODE-ARCH.

**CODE-CONTINUE-STALE is a pre-existing gap, not an rc.29 regression.** Repeats: rc.29 1 pass / 2 fail, rc.28 2 pass / 1 fail. Every failure (3/3) is a run where the agent wrote nothing before the turn-budget pause; when it had written, divergence was detected and nothing was replayed. The checkpoint only protects files the agent wrote, so a user edit made during the pause to a file the agent had not written is not flagged on Continue, and the agent proposed patches that dropped the added lines (the lab approves writes; a person would see the diff). Two earlier rc.28 attempts were invalid: the extracted rc.28 extensions directory had been deleted with the scratchpad, giving "no debug target".

## Not run or not established

- Autocomplete quality (responsiveness, relevance, interference with agent inference) was not measured; the provider path is unchanged.
- GUI cancellation (SAFE-CANCEL), model picker persistence (LIFE-MODEL), the actionable missing-model error (UX-ERROR) and composer keys (UX-KEYS) stayed blocked on the Playwright path.
- Aider/Qwen Code harness comparison: not repeated. Sprint 31's single Aider run stands; native failures in S32 are not tool-protocol failures that another harness would obviously fix.
- HALO qualification 3/3: not run. The specification audit from Sprint 31 stands; no new evidence changes it, and the brief puts it behind the model comparison and ordinary coding.
- No large model was downloaded. No HALO service, system setting or installed package was changed.

## Release decisions

### A. Technical MVP candidate — **GO for isolated evaluation** (rc.28, not installed)

Met: packaged Linux app opens on clean profiles; local inference; Auto and manual routes serve the selected model (routing check for both models); repository exploration, safe editing, diff review and approvals, real sandboxed verification, and common coding and repair workflows pass in the packaged GUI; History restores a conversation; no critical safety regression in the lab. Not verified in the GUI: Stop/cancel (SAFE-CANCEL) and model persistence (LIFE-MODEL), both blocked on the Playwright path.

### B. Supervised-testing — **NO-GO**

Unmet: three consecutive independently verified HALO qualification successes (not run); verified GUI cancellation (blocked tooling); green required CI on the pushed branch (nothing pushed). Met: deterministic suites, packaged acceptance on the critical set, rollback package verified.

### C. Daily-driver — **NO-GO**

S33 (unseen): 16/20 for each model, 8/10 per run on average, 7/10 on each model's first run, 0 false completions; clean outcomes average 7/10 because of the rename-coverage defect. Unmet: the HALO multi-outcome regression; real GUI coding sessions on a real repository; fault-injection beyond the lab's kill/stale scenarios; autocomplete evaluation. Inference performance is a product problem: the most correct model averages 92 s per task.

### Package identity and rollback

| | |
| --- | --- |
| Candidate | `open-vs-code_0.1.0-rc.28_amd64.deb`, SHA-256 `75ec9a0abccefb1721ca91a94fde42006b38c0782ac75a6429960c003b216e2e` |
| Source | `6db8732ef5` on `sprint/32-runtime-fixes`, `gitDirty: false` |
| Archive | `Open-VS-Code-linux-x64-0.1.0-rc.28.tar.gz`, SHA-256 `b052033657495dc3e951fdfa076dd2a0b3e8e13971f0f471016cdd9899aabb1c` |
| Bundled `extension.js` | SHA-256 `7c87d5a612d947b99ec36e4debf97b75314d040a28e076094aed1f195b111aeb` |
| Upstream shell | VSCodium 1.135.06055 linux-x64 (tarball SHA-256 `c09d8ac8…`, pinned) |
| Location | `~/.cache/ovsc-sprint32/wt-fix/apps/desktop/dist/` |
| Rollback | `~/open-vs-code-backups/pre-rc28-2026-11-25/open-vs-code_0.1.0-rc.26_amd64.deb`, SHA-256 `323ccfe3…`; payload matches all 2,545 installed files. Older: rc.25 in `pre-rc26-2026-11-22/`. |

Install (needs authorization): `sudo apt install ./open-vs-code_0.1.0-rc.28_amd64.deb`. Rollback: `sudo apt install --allow-downgrades ~/open-vs-code-backups/pre-rc28-2026-11-25/open-vs-code_0.1.0-rc.26_amd64.deb`. User data under `~/.config/Open VS Code` is not touched by either.

## Prioritized backlog

P0
0. Continue after a pause must treat files changed during the pause as stale even when the agent never wrote them (record hashes of files it read, or of the whole tracked tree, at the checkpoint). CODE-CONTINUE-STALE fails in about 1 of 3 runs on rc.28 and rc.29.
1. Judge the rename fixes (`2af8812`, `5d1253e`) and the Ask read-before-answer rule (`3d4e083`) on a new held-out set (S35), written before any run.
1a. Re-decide Auto order and the fresh-install default: on unseen S33 qwen3-coder ties qwen3.6 (16/20) at about 3× less time.
2. Port SAFE-CANCEL, LIFE-MODEL, UX-MODELS, UX-ERROR and UX-KEYS to the CDP harness so cancellation and model persistence are verified in the packaged GUI.

P1
3. Inference time: qwen3.6 averages 92 s per task, nearly all generation. Measure reasoning tokens per call (Ollama `eval_count` is not surfaced on `/v1`) and test per-mode reasoning settings against S32 correctness before changing defaults.
4. Ask-mode evidence: answers from search snippets without opening the file (S32-01, qwen3.6 base). Test a read-before-answer rule for numeric or "what is X" questions.
5. Verification scope: TypeScript tasks pass Node's strip-types tests while `tsc` fails (S32-07). Include the project typecheck in the reviewed verification when a `tsconfig.json` exists.
6. Command-approval burden: qwen3-coder needed 69 command approvals in one run (36 on one rename). Remembered approval for the same reviewed test command within a task.
7. Autocomplete evaluation (latency, relevance, cancellation, interference with agent inference on shared GPU).

P2
8. HALO: deploy VC-07B and register an Ollama-served coding model (HALO-side work; handoff written), then Phase C/D.
9. Fresh-install manual default (`qwen3-coder:30b` vs `qwen3.6:35b`): decide on correctness vs 5× latency.
10. CONV-FILE-REF: record tool arguments in lab evidence so a single failed search can be diagnosed.

## Answers

- *Can the candidate be opened and used?* Yes, in an isolated profile: three cold launches reach a usable composer in about 3 s, and coding, approval, rejection, diff, verification and history workflows pass in the packaged GUI.
- *What can it complete?* Bugfixes, small features, writing tests that kill mutants, failed-test repair, cross-file renames, multi-file TypeScript, frontend behaviour changes and a cache feature with tests (S32 with qwen3.6). It still misses edge-case requirements and sometimes answers without reading.
- *Measured success rate:* qwen3.6:35b 7/10 unseen (baseline), 9/10 after fixes on the same (now seen) set; qwen3-coder:30b 6/10 both times. 0 false completions in 40 runs.
- *Best model:* `qwen3.6:35b` for correctness (16/20 vs 12/20); `qwen3-coder:30b` for speed (5×).
- *Does HALO help?* Not today: it does not serve or observe Open VS Code's models and cannot carry tool calls as deployed.
- *Redundant or ineffective:* the L0 "unresolved failures" REVISE rule after a verified workspace (narrowed); the acceptance lab's Playwright chat path (five scenarios cannot drive the webview); the bundled-extension override that the Playwright launcher ignored (fixed).
- *Prevents supervised testing:* HALO 3/3 qualification not run; GUI cancellation unverified; no green CI on a pushed branch.
- *Prevents daily-driver:* no unseen 8/10 result; slow inference on the most correct model; autocomplete and real-repository GUI sessions unmeasured.
- *Single highest-value next action:* write and freeze a new held-out task set and run it on rc.28 with both models, because every other decision (default model, reasoning settings, daily-driver) depends on an unseen score.
