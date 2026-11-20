# Sprint 26 — Reliable coding, task completion and native Auto mode: status report

Branch: `sprint/26-reliable-coding-auto`. Decision at the time of writing: **NO-GO**.

This report separates what is built and tested from what is measured on live models, and from what is not done. Nothing here was pushed to `main`, installed or deployed.

## 1. Decision

**NO-GO.** The HALO VC-02 acceptance task (the sprint's hard gate, 3 of 3 runs) has never passed on substance. The best live run met 4 of 5 required outcomes. The one run the original oracle scored SUCCESS did not survive an independent check (§4). Several original Sprint 26 deliverables were not started (§6).

## 2. What changed (all general; none is specific to HALO)

| Area | Change | Evidence |
|---|---|---|
| Re-read loop | A re-read of a file that fell out of the model's context now returns the file again instead of "its result is already above". The token budget, not a fixed 6, decides how many recent tool results are shown. | HALO went from 0/5 with no edits to 2–4/5. Regression test fails without the fix. |
| Reasoning cap | Agent-turn output cap is overridable (`OPEN_VS_CODE_AGENT_MAX_TOKENS`); 6,144 tokens cut off long reasoning (4 turns ≈ 333 of 520 model-seconds in t2). 10,240 stopped the stalls in the runs measured. Default unchanged. | 0 of 64 model calls capped at 10,240. |
| Diff budget | A same-length edit (a rename with distant uses) is counted and shown as per-change hunks, not one span. | t3 rep 2: 4-refusal stall → pass in 29 s. |
| Imports | A bundler suffix (`?url`, `?raw`) is not part of the file an import must resolve to. | Test. |
| Early checks | After a test file is written or changed, and after an exported type changes, the tests / typecheck run at once (also after an approved edit), not only at completion. | Test fails without the change. |
| Work units | A long task pauses at a time boundary (supervised: three 10-minute units) with edits, observations and the outcome report kept, and continues only if the last unit made an edit or met a requirement. The 10-minute benchmark cap is unchanged. | Ran for real in HALO (2–3 units). |
| Completion gate | The "not done yet" nudge is bounded per stretch without an edit, names the cases the brief's own test list asks for, and says so when the model claims an edit the workspace does not show. | Tests. |
| Pre-approval checks | Rejects: `await` in a non-async function; a JS/TS test that imports nothing from the project; a new JSON `...Id` reference no JSON file defines (once, then allowed). | Tests. |
| Declined edit | In a multi-outcome brief one declined edit is recorded and the run continues; a single-edit task still stops. | Test fails without the change. |
| Path faults | The same path fault twice in one turn is one mistake (it used to end the run after one turn); the correction names the workspace root. | Test. |
| Verification | A test failure identical before and after the agent's edits is reported as pre-existing; the model is told not to chase it and the ledger does not mark outcomes FAILED for it. The verification sandbox task cap is 2,048, up from 512 (measured: 512 fails, 2,048 passes for a pnpm monorepo; the fork-storm test still holds). | Controlled experiment + tests. |
| Safety | Edits to dependency manifests and lockfiles carry a warning in the approval prompt and are never auto-approved in the eval harness. | Test. |
| Native Auto model | Merged (`a2ccdc5b79`): Qwen3.6 first, Qwen3-Coder as fallback, never the 7B autocomplete model. | 4 routing tests. |

**CI-affecting change:** `--test-force-exit` was removed from all five packages' test scripts. It ended the process before late results were reported: the agent-core test count varied between 1,221 and 1,247 on identical code. Without it every suite exits on its own in under 35 s and reports identically. Earlier "0 failed" figures in this sprint were less airtight for that reason.

## 3. Deterministic results (final tree)

| Package | Tests | Failed |
|---|---|---|
| agent-core | 1,254 (4 skipped) | 0 |
| vscode-integration | 343 | 0 |
| account-service | 84 | 0 |
| cli | 21 | 0 |
| ide-adapter | 8 | 0 |
| HALO oracle self-test | 21 controls | 0 |

## 4. HALO VC-02 (live, Qwen3.6 35B, up to three 10-minute units, the brief and checks unchanged)

Five required outcomes are judged by the **frozen original oracle**. Three problems with it were found during the loop and are reported **beside** it, never instead of it:

1. It judges identity tests by file name, so tests written in `app.test.ts` or `buildMetadata.test.ts` were missed.
2. It requires `config/routes.json` to change although the brief says production configuration stays staged.
3. It reads tests but never runs them.

An **audited** verdict adds substance checks: routes resolve to defined models; tests exercise project code; identity tests are judged by content. It was frozen at commit `cd198935cd` (oracle hash `c85a3f45663e2e92`), and runs before that commit were measured while it was still being defined, so they do not count towards GO. After the first frozen-audit SUCCESS looked wrong, one further check was added in `bba4349e42`: the test files the agent *created* are executed in a network-less sandbox and must pass. That check can only lower a verdict, never raise one, and it was added after seeing a result, so it is stated here rather than hidden.

| Stage | Runs | Original oracle | Audited |
|---|---|---|---|
| Before the loop fixes | 2 | FAILURE 0/5, no edits | — |
| After context / cap fixes | ~14 | PARTIAL 2–4/5; some FAILURE (a syntax error, an `.env.example` edit, a `package.json` edit) | PARTIAL |
| Reasoning off | 3 | 0/5 to 2/5 | — |
| Dependencies installed, frozen audit | 3 valid | PARTIAL 1/5, PARTIAL 2/5, **SUCCESS 5/5** | PARTIAL, PARTIAL, **PARTIAL** |

The SUCCESS (`s26c3b` rep 3) was checked by hand and with the executed-test audit: `modelQualification.test.ts` reads `apps/config/model-qualification.json` (wrong path) and fails to load, and one test in `buildIdentity.test.ts` fails. The agent wrote those tests and then ran out of time before running them. That finding led to the early test run in §2.

Honest reading: the loop bugs that kept the agent from editing are fixed, and it now usually reaches 3–4 of 5 outcomes. It has not produced a working, verified result, and run-to-run variance is large (the same code scored 4/5 and 1/5).

## 5. Task benchmark (Sprint 25 task set, 10-minute cap, 2 reps)

| Runtime | Pass |
|---|---|
| Sprint 25 | 7/12 |
| Sprint 26 (before the final fixes) | 9/12 |
| Reasoning off (separate, not combined) | 5/6 and 4/6 |

The 9/12 predates most fixes above and was not re-run on the final tree. These are the Sprint 25 tasks, not unseen ones, and 75% is below the 8/10 gate. t2 still times out at 10 minutes (about 50 s per model turn).

Measured on this host: decode ≈ 68 tokens/s. `reasoning_effort=low` did not bound thinking; `none` answers in about 2 s. Reasoning off is fast on small tasks but stalls or stops early on long briefs.

## 6. Not done

- Benchmark re-run on the final tree, and the separate extended-session benchmark.
- Unseen coding tasks (the 8/10 gate).
- Auto versus manual comparison on live tasks (routing is covered by unit tests only).
- Fault injection: two scenarios added (provider timeout after an approved write; stale file). Crash after write, interrupted verification, restart and duplicate mutation are covered by existing `tests/recovery`. Context compaction is covered by the re-read tests; a missing dependency by the environment-blocked verification path.
- Packaged Linux build and GUI acceptance with screenshots and hashes.
- Open-source reuse review (SWE-agent, Gemini CLI, Aider, OpenCode); none was adopted.
- Updating the canonical docs and ADRs.

## 7. Known defects and risks

- HALO substance: the model routes `general` to a model id it does not register, writes tests that cannot load, or runs out of its three units. The pre-approval checks target the first two; they have not been shown to fix them.
- The HALO base has 8 failing tests before any edit (a native SQLite binding cannot be built offline on this Node). They are reported as pre-existing.
- Ollama restarted twice and the host rebooted once during the sprint; four runs were invalid and are excluded.
- Eval-only knobs (`OPEN_VS_CODE_REASONING_EFFORT`, `OPEN_VS_CODE_AGENT_MAX_TOKENS`) are environment variables read by the provider and are not exposed as settings.
- The benchmark and HALO harness scripts and run artifacts live outside the repository (`~/.cache/ovsc-sprint25`, `~/.cache/ovsc-sprint26`).

## 8. What would turn this into GO

1. HALO: at least 3 of 3 consecutive runs scored SUCCESS by the frozen original oracle and by the audited verdict (including executed tests).
2. At least 8 of 10 on a newly frozen set of unseen tasks, with Auto compared against manual Qwen3.6.
3. The packaged Linux build passes GUI acceptance, with hashes and screenshots.
4. Full suites green on the final tree (met today).

Next highest-priority improvement: make the agent run and fix its own new tests inside the time it has (the early test run is in; it has not yet been measured on a live HALO run).
