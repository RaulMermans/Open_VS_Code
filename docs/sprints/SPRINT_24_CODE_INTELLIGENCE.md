# Sprint 24 — Native code intelligence and cross-file refactoring

Date: 2026-11-16/17. Branch `sprint/24-code-intelligence` (from `42526ff15c`). Decision record: ADR-047.
Candidate: `0.1.0-rc.24` from `b5736d4507`, **not installed**. Evidence: `apps/desktop/acceptance/review/sprint-24/`.

## 1. State at start

| Item | State |
| --- | --- |
| Installed daily driver | `0.1.0-rc.21` (unchanged throughout; `dpkg -l`) |
| Latest candidate | `0.1.0-rc.23` (Sprint 23, not installed) |
| Source | `sprint/v1-milestone-1-foundation` at `42526ff15c`, clean; `origin/main` differed only by 20 PR merge commits (no content) |
| Concurrent work | A Kilo agent worktree exists; not touched |
| Language-service integration | None |
| Model | `qwen3-coder:30b`, digest `06c1097efce0…`, Q4_K_M, 30.5B MoE; Ollama defaults temperature 0.7, top_p 0.8, top_k 20, repeat_penalty 1.05; context window 32768 (desktop routing); turn limits unchanged |

Incidents: the machine rebooted mid-sprint and `/tmp` was lost (first worktree, first A/B, the Sprint 23 Reeprov clone). Commits survived; work moved to `~/.cache/ovsc-sprint24/`, the A/B restarted from scratch, and a new disposable Reeprov clone was made with `git clone` plus a copy of `node_modules` (the original checkout was only read). The original Reeprov checkout still has the three modified fixture files from the Sprint 23 incident; left alone.

## 2. What was built (ADR-047)

- `CodeIntelligenceProvider` (agent-core): definitions, references, rename **proposal**, document text.
  - IDE: `vscode.executeDefinitionProvider` / `executeReferenceProvider` / `executeDocumentRenameProvider`. The WorkspaceEdit is converted, never applied; file operations (`_allEntries()`, verified against VS Code tag 1.135.0) are refused; an uninspectable edit fails closed. `useAliasesForRenames: false` product default.
  - Headless: TypeScript LanguageService (tests, live evaluation). Not bundled in the extension.
- `find_symbol` (read): definition, kind, references with snippets, 25 per page.
- `rename_symbol` (write): one review for the whole rename; each file through `MutationEngine.prepareRewrite`; preflight of every hash before the first write; rollback of written files if a later write fails; coverage check against the language service before review; 25-file cap.
- Runner: per-file preimages and pre-/postconditions for grouped edits; exclusions per file; one mutation outcome per file; hand renames redirected to `rename_symbol`; `create_file`-as-patch keeps its real before-text (this also fixes a pre-existing missing preimage).
- Not built: Git-change regression localization and a broader context package (brief §5). ts-morph not added (its rename is the same LanguageService call).

## 3. Tests

agent-core 1159 pass, including 18 new tests against the real TypeScript service: definition, cross-module references, paging, exported rename with imports/re-export/call sites, unrelated same-named function untouched, alias renamed locally, ambiguity, monorepo with an unresolved import, outside-workspace refusal, file changed after prepare, dirty editor buffer, mid-group write failure with rollback, resource operations, unavailable service, overlapping edits, runner approve/reject, partial-project retry/refusal, hand-rename redirect including `create_file`. vscode-integration 339 (4 new: WorkspaceEdit conversion), desktop 26/26, typecheck and lint clean.

## 4. Live Qwen evaluation (headless bridge, same path as the desktop; 6-minute wall clock per task)

Independent oracles: strict `tsc` from the repository's TypeScript, structural checks that unrelated same-named symbols survive, behavior checks. Every oracle was checked to fail on the fixture and pass after a correct rename before any run.

| Set | Baseline tools | With symbol tools |
| --- | --- | --- |
| S24 (6 unseen + d07), first run | 2/7 | **1/7** (tool barely used; model renamed by hand first) |
| **S24B (6 held out, written after the fix, before any run)** | **2/6** | **5/6** |
| S24 + d07 re-run after the fix (not held out) | — | 7/7 |

S24B detail: runs that said "completed" with wrong code: baseline 2 (t02, t06; plus s02 in S24), with tools 0 (none in S24 either). Out-of-scope edit: baseline 1 (t06 edited a barrel marked unchanged), with tools 0. Median task time 270 s → 32 s; tool calls 407 → 238; repeated identical exploration 260 → 132; write approvals 51 → 24; command approvals 21 → 10. One timeout with tools (t04: after a successful rename the model called `rename_symbol` again with the old name, read "does not appear" as failure and hand-edited `slugifyPath`).

Measured on `566ba2d821`. Later commits change only the redirect's target parsing (verified to resolve the same target for all 13 task phrasings), the coverage check (all 6 S24B renames re-verified) and the `create_file` path.

## 5. Reeprov R1 (disposable clone; independent `vitest`, `tsc --noEmit`, hidden oracle)

Base verified: 2065 tests pass, `tsc` clean, oracle fails.

| Run | Code | `tsc` | Oracle | Run outcome |
| --- | --- | --- | --- | --- |
| Headless baseline | `format.ts` only | FAIL (`HealthOverview.tsx` imports `statusTone`) | FAIL | NON_PROGRESS |
| Headless tools, `1b361e3a83` | unchanged | pass | FAIL | redirect named the wrong target (`SCORE_THRESHOLDS`); fixed in `3e8caade2f` |
| Headless tools, `3e8caade2f` | `format.ts` only | FAIL | FAIL | redirect missed ("into an" read as the target); fixed in `c19d20e16a` |
| Headless tools, `c19d20e16a` | both files | pass | **PASS** | NON_PROGRESS (agent's own checkpoint files fail Reeprov's private-path audit test; §7) |
| GUI rc.24 `c19d20e16a` | `format.ts` only | FAIL | FAIL | hand rename via `create_file` not redirected; fixed in `723448dd59` |
| GUI rc.24 `723448dd59` ×2 | `format.ts` only | FAIL | FAIL | rename group covered `format.ts` only (VS Code project still loading, unresolved import accepted); fixed in `b5736d4507` |
| **GUI rc.24 `b5736d4507` run 1** | both files | pass | **PASS** | **"Task completed", tests and typecheck passed** (true) |
| GUI rc.24 `b5736d4507` run 2 | `format.ts` consistent | pass | FAIL | NON_PROGRESS: model re-sent the hand rename 4 times instead of calling `rename_symbol` |

R1 passes its independent oracle headless and in the packaged GUI, but only after four fixes that R1 itself exposed, and the final GUI result is 1 of 2. Visible suites pass on the code in every run once the agent's `.open-vs-code/` directory is excluded. No run changed an unrelated `statusTone` helper; no false completion.

Small rename fixture (no tsconfig) in the packaged GUI: before the coverage check 2/3 test-passing (one partial rename, reported as not completed); after it 3/3. Headless 3/3.

## 6. Packaged GUI and production status

- Candidate `0.1.0-rc.24` from `b5736d4507` (clean tree). `.deb` SHA-256 `fd911e10b6a2472036f7fa2a6a6f93c122819ff81e2d609410372dafb3d2eb8b`; tarball `37a9868477f3aab9ca6cfcc55cae601542e10539892b8a168cdaacec6e000808`; bundled `extension.js` `4f669b49a9e5488a163e98b083641a8923c52ad118ec643927805193686e3058`. Extracted with `dpkg-deb -x` and driven through `OPEN_VS_CODE_ACCEPTANCE_BINARY`; never installed. rc.11 rollback package present.
- Critical CDP acceptance (20 scenarios) on the final rc.24: **18/20**. All safety scenarios pass (approve, reject, injection, dangerous command, traversal, verify, profile isolation, sandbox, stale continue). `UX-MODELS` and `LIFE-FIRST` fail identically on the rc.23 package (blank Open VS Code panel on first launch; pre-existing). Scorecards: `review/sprint-24/lab-critical-rc24-final.md`, `lab-rerun-rc24-rc23.md`.

| Level | Status |
| --- | --- |
| Unit verified | YES |
| Language-service integration verified | YES (real TypeScript LanguageService; VS Code providers in the packaged app) |
| Real-model verified | YES (S24B 5/6 vs 2/6) |
| Packaged-GUI verified | PARTIAL (R1 1/2; small rename 3/3) |
| Installed-production verified | NOT_RUN (installation not authorized) |

## 7. Remaining limitations

1. The model sometimes ignores the redirect and re-sends the hand rename until the run stops (GUI R1 run 2). The run stays truthful and the code consistent.
2. After a successful rename, a repeated `rename_symbol` on the old name reports "does not appear"; the model reads that as failure and resumes hand-editing (t04, and NON_PROGRESS on correct code in S24 s02/s05/s06).
3. Open VS Code's checkpoint store (`.open-vs-code/recovery`) writes absolute home paths inside the user's repository; Reeprov's private-path audit test fails on them. Pre-existing.
4. Packaged-GUI display: the activity line counts 1 file for a 2-file rename, and a grouped row shows the group's line totals.
5. Headless provider: one TypeScript project per tsconfig. VS Code provider coverage depends on the server's project; it is now verified rather than assumed, at the cost of up to ~6 s of retries while a project loads.
6. Blank first-launch panel in `UX-MODELS` / `LIFE-FIRST` (identical on rc.23).
7. Regression localization (R2) not built or measured.

## 8. Recommendation

CONDITIONAL GO for rc.24 as the next candidate, not yet as an installed update: a measured gain on held-out refactors (5/6 vs 2/6, no completed-but-wrong runs, ~8× faster median) and no unsafe or false-success behavior observed; packaged-GUI R1 is 1/2.

Next priority: make a completed rename recognized as completed. Remember renames applied in the session and answer a repeated `rename_symbol`/`find_symbol` on the old name with "already renamed to X in these files; run the tests", then measure on a fresh held-out set and R1 in the GUI with at least 3 repeats.
