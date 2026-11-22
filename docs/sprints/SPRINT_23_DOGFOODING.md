# Sprint 23 — Cross-file refactors and real-project dogfooding

Date: 2026-11-16. Installed daily driver: `0.1.0-rc.21` (unchanged). Candidate: `0.1.0-rc.23` from `794b2f9426`, `.deb` SHA-256 `7c5030b5792350024f7aef99280488c2d65251d1865195ada46bcfd733ff3242`, bundled `extension.js` `379491575ba757b4a7edaab0e4cf412b5100ce6fd7672184d9f211dc960258e2`. **Not installed** (the brief requires a prepared, uninstalled candidate).

## 1. Source of truth

| Item | State |
| --- | --- |
| Installed | `0.1.0-rc.21`, `dpkg -V` clean |
| Branch | `sprint/v1-milestone-1-foundation`, local commits not pushed; `origin/main` differs only by PR merge commits |
| GitHub CI | Last runs on `main` red (they predate the Sprint 21 CI fix, which is unpushed) |
| Concurrent work | Another agent edited `verification-discovery.ts` and `verification-python.test.ts` (uncommitted) during this sprint; left untouched and excluded from every commit. Commits were gated in a clean worktree at HEAD. |

## 2. Method

Five previously untested tasks on disposable clones of a real repository (Reeprov: Next.js/React + vitest, 2,065 tests; and its stdlib Python client, 10 tests). Driven through the real Electron GUI over CDP (`apps/desktop/acceptance/src/dogfood.ts`): one natural instruction typed in the composer, approvals clicked only for operations inside the clone, no help to the agent. Judged afterwards by independent evidence: full test suite, `tsc --noEmit`, a hidden oracle, and git diff. Seeded regressions were committed in the clone only.

| Id | Category | Instruction (abridged) |
| --- | --- | --- |
| R1 | Interface refactor | Extract `SCORE_THRESHOLDS`, rename `statusTone` → `scoreTone` across importers; leave same-named local helpers |
| R2 | Cross-file bug, failing tests | "Scanner tests started failing after a recent change; fix the source" (inverted guard in `secretPatterns.ts`) |
| R3 | Feature across modules | `formatDuration` helper, use it in `RunSummaryView.tsx`, add unit tests |
| P1 | Feature needing repo understanding | Configurable retry backoff (`backoff_base`, env `REEPROV_BACKOFF_BASE`) + test |
| P2 | Failing-test diagnosis | Client tests fail; fix the library (inverted float formatting guard) |

## 3. Results

| Task | rc.21 (installed) | rc.22 | rc.23 |
| --- | --- | --- | --- |
| R1 | FAIL — renamed but importer stale; tests passed, typecheck failed, **reported "Task completed"** | FAIL — rename never done, reported applied | FAIL — rename done, importer stale; typecheck blocks completion, **honest NON_PROGRESS** |
| R2 | FAIL — re-ran failing tests without editing | INVALID — Ollama service stopped externally mid-run | FAIL — never localized the regression |
| R3 | INVALID — harness interference (I reset the clone mid-run) | FAIL — helper imported but unused, no tests | Code correct (tests, typecheck, oracle) **but requested tests missing**; completion correctly refused |
| P1 | FAIL — 0 edits (re-read loop) | FAIL — timed out, 0 edits, 36 identical reads | **PASS** (oracle, tests); run did not finish cleanly before the 15-minute limit |
| P2 | FAIL | FAIL — special-cased `1.0` to pass the test | FAIL — same test-gaming fix |

Pilot target 4/5 is **not met** (rc.23: 1 fully correct, 1 correct code with a missing requested part). No unauthorized writes or commands (every write and command went through approval inside the clone). No false verification PASS. No unbounded loops (every run either finished, stopped as NON_PROGRESS, or hit the external 15-minute dogfood limit).

## 4. First causal failures and fixes

| Failure (task) | Class | Fix (commit) | Evidence after |
| --- | --- | --- | --- |
| Partial rename leaves stale references; model guesses (DEV d07/d04) | Runtime feedback | Unresolved-name diagnosis on failed runs (`21f225c1f8`) | Alone: no gain (1/6) — model re-ran tests |
| Model re-requests a failed test instead of editing (DEV d04, R2) | Runtime control | Edit-only tools while a failure waits on an edit (`b38c62ffa4`, `bded38fb90`) | DEV refactors 4/6 (from 3/6) |
| Tests pass, importer broken, "Task completed" (R1) | Verification selection | Project `typecheck` script required after TS edits (`eba8c54323`) | rc.23 R1 no longer claims success |
| src-layout Python package cannot import itself (P1/P2 setup) | Verifier | `PYTHONPATH=src`, workspace-contained only (`e243cd43a5`) | Reeprov client tests run under the agent |
| Outcome card said "Task completed." on a failed run (R2 screenshot) | UI truthfulness | Card titled "Task not completed." (`a51a4e05e6`) | Regression test |
| Ollama restart → one HTTP 500 ended an 8-minute task (R2 rc.22) | Robustness | Two bounded retries on network/429/5xx (`d28cdc7575`) | Provider tests |
| Half of the request ignored, success claimed (R1/R3 rc.22) | Model + gate | Request checks: rename, requested tests, named-but-unused imports (`f442e4a6a1`) | rc.23 R3 completion correctly refused |
| 800-line file cut by observation limit; 36 identical reads (P1) | Agent-computer interface | 250-line windowed `read_file` with continuation (`545d9cc2f1`) | rc.23 P1 PASS |

Remaining dominant failure: **incomplete instruction-following** — the model stops one step short (stale importer, missing tests) or games a failing test. Two corrective attempts were spent on this root cause; it is reported as the blocker rather than patched further.

## 5. Security and isolation (Phase 4)

bubblewrap sandbox (ADR-046) plus, new this sprint, a user cgroup scope: memory 4 GiB with no swap, 512 tasks. Real tests: memory hog killed (exit 137), fork storm capped, cancellation stops the tree, no network, private HOME, workspace-only writes, inherited secrets cleared. `required` mode fails closed; `auto` labels unsandboxed runs on the approval card. Prepared environment is limited to a workspace-contained `PYTHONPATH`.

## 6. Incidents during the sprint (all mine or environmental; recorded for honesty)

- I ran `vitest run` once in the user's original Reeprov checkout to time the suite; it regenerated three tracked fixture files. Restoring them was blocked by the safety classifier; the user was given the exact `git restore` command.
- I reset the shared clone while a background task used it, invalidating R3 on rc.21.
- Ollama was stopped and restarted by something else at 18:29:38, invalidating R2 on rc.22.
- One intermediate commit (`b38c62ffa4`) had a failing test (gate not enforced in that command); fixed in `bded38fb90`.

## 7. Next priority

Localization for regressions (R2/P2): give the model the files changed by recent commits when tests fail (Agentless-style localization), then expand to 20 held-out real tasks before any broader reliability claim.
