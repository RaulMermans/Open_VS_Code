# Sprint 33B — Final runtime qualification, production deployment and real-world readiness

Date: 2026-11-27. Status: **BLOCKED at production installation.** rc.34 is built from clean `main`, CI-green and validated as a packaged candidate. Installing it needs interactive `sudo`, which the sprint agent cannot provide. Installed-production acceptance has therefore not run, and the sprint is not complete.

## 1. Starting state

| Item | Observed |
|---|---|
| Local checkout | `sprint/sandbox-memory-16g` at `673a8f1` (rc.27 era), 38 behind `origin/main`, 3 uncommitted files identical to `8369527` (already on `main`). Left untouched. |
| `origin/main` | `f5428c2` (Sprint 33 merged, PR #117), CI green |
| Installed | `0.1.0-rc.30`, `dpkg --verify` clean, bundled `extension.js` `539134376179bcfe…` |
| Latest `.deb` | rc.31 (`277dc8b1…`), built from `7dc5214`, never installed; it lacks the Sprint 33 caller-grounding and Auto changes |
| Rollback | rc.30 `.deb` `b27d4308…` on disk |
| Ollama | `qwen3-coder:30b` `06c1097efce0`, `qwen3.6:35b` `a7eb95c53bcf`, `qwen2.5-coder:7b`, `qwen3.5:4b`, `qwen3-embedding:0.6b`; no models loaded; no service memory limit; `OLLAMA_CONTEXT_LENGTH=65536` |
| HALO | core, control room and infrastructure daemon active; two llama-servers (`:8092`, `:8093`) |
| Resources | 61 GiB RAM (42 available), 8 GiB swap unused, GPU 64 GiB (UMA); sandbox slice `MemoryMax=32G`, `MemorySwapMax=0` |
| Host | rebooted 14:01 on kernel `7.0.0-44` (installed 2026-11-26) |
| Blockers carried in | stale-Continue ~1 in 3 (P0), S35 never run, HALO qualification contract defect |

## 2. Implementation

| Change | Kind | Commit |
|---|---|---|
| Stale-Continue lab: copies the recovery journal, checkpoints and write preimages; per-file hashes before the user edit, after it, final; classifies a lost edit A1 (stale write) or A2 (model proposal) | lab | `e6886ce`, `696950e` |
| AUTO-CODE lab scenario; case-insensitive model confirmation | lab | `7a8df18` |
| **Auto showed "Model unavailable" whenever Auto was selected** (`"auto"` compared with installed names, since `d55e08e`). Now unavailable only when no eligible model is installed | runtime | `44061ad` |
| **Pre-write import check forced `.ts` specifiers** in any TS project with one `--experimental-strip-types` script, contradicting its tsconfig (found by the pilot) | runtime | `0ee23e1834` |
| Autocomplete latency eval (30 opportunities, production FIM gateway) | eval | `ec48485` |
| HALO Qualification V2 proposal (not active), HALO handoff update | docs | `60354ea` |
| S35 results, ADR-051 update, AGENTS rule 10 | docs | `d058a62`, `e689712` |

Each runtime fix has a regression test that fails without it.

## 3. Deterministic verification

On `26e1a0b` (rc.32 source; rc.33/rc.34 add the two fixes above, covered by CI and agent-core/vscode-integration suites):

| Command | Result |
|---|---|
| `npm run lint`, `npm run build` | pass |
| `npm run test` | 1,800 tests: 1,796 pass, 4 skipped (optional REA host check), 0 fail |
| agent-core after the import fix | 1,318 tests: 1,314 pass, 4 skipped, 0 fail |
| `desktop:smoke` | 6/6 |
| `desktop:accept` | **2 fail** (environmental, see §10 D-04): Chromium on this host now uses the namespace sandbox instead of the setuid helper, for both the uninstalled rc.32 tree and the installed rc.30. Processes stay sandboxed (separate user/pid namespaces, seccomp mode 2, `--enable-sandbox`, no `--no-sandbox`). Tests not changed. |
| `eval:runtime` 14/14, `eval:recovery` 60/60, `eval:performance` 5/5, `eval:ide-performance` pass (the `failed: 1` is the intended unavailable-endpoint scenario) | mocked/deterministic |
| CI | green on `26e1a0b`, `3db5a99` (after rerun), `7c8c205` (first attempt). Node 24 real-Chromium tests time out on first launch intermittently (D-05). |

## 4. Model qualification (S35, frozen, unseen)

Hashes verified, references 10/10, mutants as frozen. Full table in `docs/evals/S35_BENCHMARK.md`.

| Model | Run 1 | Run 2 | False completions (spec) | Unauthorized | s per correct |
|---|---|---|---|---|---|
| qwen3-coder:30b | 5/10 | 5/10 | 5, 5 | 0 | 26, 32 |
| qwen3.6:35b | 8/10 | 7/10 | 2, 3 | 0 | 87, 116 |

**Gate not met by either model.** Failures are model reasoning and answer completeness, plus one completion gap (s35-04: the runtime has no type evidence when the project has no `typecheck` script, yet reports the edit applied). S35 informed no runtime change and remains unseen. ADR-051's Auto→Coder order is **not confirmed**; it is unchanged pending a product decision.

## 5. Auto and repository grounding

- Unit coverage: Auto order, health-based fallback only to qwen3.6, fail-closed without an eligible model, no fallback on cancel (`routing-e2e.test.ts`, `routing-production.test.ts`).
- Live (packaged candidate): AUTO-CODE on rc.32 **failed** ("Model unavailable · Auto"), the defect above; on rc.33 **passed**: status `Auto · qwen3-coder:30b`, `node --test` passes, test unchanged.
- Grounding on S35: callers task — qwen3.6 2/2, qwen3-coder 0/2 (found the files and the alias, omitted the calling functions); explain with a decoy constant — qwen3.6 2/2, qwen3-coder 1/3. Retrieval read the right files in every run; the misses are model reasoning.

## 6. Production deployment

```yaml
production:
  updated: false
  previous_version: 0.1.0-rc.30
  installed_version: 0.1.0-rc.30
  candidate_version: 0.1.0-rc.34
  source_commit: 7c8c205e990d9db0e87b485ac96d458d637aedd2
  ci_status: success (run 46068049229)
  package_path: ~/.cache/ovsc-sprint33b/open-vs-code_0.1.0-rc.34_amd64.deb
  package_sha256: 754efcc4f69d24759e0af8c887d3eecd1d820a1bdb368d7ea7dd40609a2d2deb
  candidate_extension_sha256: 9c79d2be3faeb1c523ea34fb4f69d6aeaf3406f9a03cea9e0185d9e0d7190137
  rollback_package: ~/open-vs-code-backups/pre-rc32-2026-11-27/open-vs-code_0.1.0-rc.30_amd64.deb (b27d4308…, matches installed files)
  rollback_command: sudo apt install --allow-downgrades ~/open-vs-code-backups/pre-rc32-2026-11-27/open-vs-code_0.1.0-rc.30_amd64.deb
  launch_verified: candidate only (lab, installed rc.30 shell with rc.32–34 extensions)
  production_acceptance_executed: false
  production_acceptance_result: BLOCKED — installation requires interactive sudo
```

Intermediate candidates rc.32 (`26e1a0b`, `adeddd2c…`) and rc.33 (`3db5a99`, `ff8f8a16…`) were built and never installed. User state (settings, global state, argv) is backed up beside the rollback `.deb`.

## 7. Live acceptance (packaged candidate, not installed production)

| Scenario | Candidate | Result |
|---|---|---|
| CODE-CONTINUE-STALE ×5 | rc.32 | **4/5.** Cycle 3 lost the user's edit in 2 files: **A2** (each write's preimage equals the user-edited content). A1 stale writes: 0 of 14 writes. |
| SAFE-CANCEL ×3 | rc.32 | 3/3; Stop acknowledged 112–113 ms; Ollama chat ended after Stop; no surviving subprocess |
| SAFE-CANCEL-APPROVAL ×3 | rc.32 | 3/3; 112–118 ms; workspace unchanged |
| AUTO-CODE | rc.32 / rc.33 | FAIL / PASS |

Not run on installed production: the full catalog, lifecycle, restart, recovery. The 5/5 stale-Continue gate (G03) is **not met**.

## 8. Real-repository pilot (REEPROV)

Disposable clone of `main` (`83afc49`) with a baseline commit adding one failing test (RP-01). Tasks frozen before execution (`TASKS.md` `a3e119fd…`). Agent: Open VS Code BUILD mode, `qwen3-coder:30b`, GUI harness; approvals in-scope only; no human code intervention.

| Task | rc.33 (attempt 1) | rc.34 (attempt 2, after the import fix) |
|---|---|---|
| RP-01 localized bug fix | NON_PROGRESS: import check forced `./fetchRepoTree.ts` (TS5097) | **Correct**: typecheck, lint, 2,057 tests pass; only `lib/github/fetchRepoFiles.ts` changed; 86 s; reviewable, ready to commit (review note: ignored files are no longer listed in the result) |
| RP-02 multi-file feature | NON_PROGRESS: same import defect | **Correct per the frozen oracle** (5/5 oracle tests, agent's 9 tests, typecheck, lint); agent reported not completed because the planted RP-01 test kept the full suite red (setup confound); 298 s |
| RP-03 cross-file refactor | Failed: call site left unrenamed | Failed: two call sites left unrenamed (TS2304); honest NON_PROGRESS; 461 s |

Unauthorized writes 0, false success claims 0, critical safety failures 0. REEPROV's test suite rewrites `rename-audit.json` and two canonical fixtures on every run (also in the clean clone); those are test side effects, not agent writes. Nothing was merged into REEPROV.

## 9. Resources

- Isolated autocomplete (`qwen2.5-coder:7b`): cold 7.3 s, median 733 ms, p95 2,138 ms, 30/30 answered, relevance proxy 25/30 (TS 10/12, TSX 6/6, Python 6/9, JS 3/3). Client-side abort settles in ≤ 2 ms. Targets (≤ 500 ms / ≤ 1.5 s) **not met**.
- During an Agent run (qwen3.6): median 862 ms, p95 2,577 ms; three models resident (51 GiB in Ollama), 31 GiB available; no errors, no OOM. One Agent task took 250 s of inference against ~105 s alone (n = 1).
- Deterministic suite during S35 inference: max RSS 0.6 GiB, no OOM. The only OOM kill was the sandbox test's deliberate 5 GiB hog in its 4 GiB scope.
- An IRIS process used Ollama (`/api/chat`) concurrently from ~21:20; timings after that are contended.
- Autocomplete is enabled by default and not suspended during Agent runs. **Not qualified.**

## 10. Remaining defects

| Id | Severity | Defect | Evidence | Next action |
|---|---|---|---|---|
| D-01 | High (P0 gate) | A2: after Continue the model can propose a patch that deletes a user edit made during the pause; it is shown as an ordinary diff, not as a conflict. 1/5 (rc.32), 1/5 (rc.31). | `evidence/2026-11-27T14-31-50-810Z/CODE-CONTINUE-STALE/cycle-03` | Record hashes of tracked files at the pause; at Continue, mark a patch to a file changed during the pause as a conflict in the review card. Re-run 5/5. |
| D-02 | High | Neither model meets the S35 gate | §4 | Product decision on Auto; model work, not runtime prompts |
| D-03 | Medium | Completion reported "applied" with no type evidence when the project has no `typecheck` script (s35-04) | S35 rows | Treat an exported-type change without a typecheck as unverified |
| D-04 | Medium | `desktop:accept` sandbox tests assume the setuid helper; this host now selects the namespace sandbox | `desktop:accept.log` | Product owner decides whether the oracle should check the sandbox property instead of the backend |
| D-05 | Low | CI Node 24: first Chromium launch intermittently exceeds 20 s | runs 46063056311, 46065815712 | Raise first-launch timeout or warm the browser in CI |
| D-06 | Low | Final message can say "Tests passed" and "Verification was not executed" together | stale cycle 01 `continue.json` | Single source for the outcome line |
| D-07 | Medium | Autocomplete misses latency targets and is on by default | §9 | Default off or suspend during Agent runs |
| D-08 | — | HALO cannot serve Agent mode; qualification contract defective | HALO handoff, V2 proposal | HALO-side work |

## 11. Release decision

```yaml
release_decision:
  standalone_technical_readiness: NO_GO
  formal_supervised_testing_gate: NO_GO
  real_repository_pilot: GO   # supervised, on the candidate; 2/3 correct, 0 unsafe events
  daily_driver: NO_GO
  halo_managed_inference: BLOCKED
  production_updated: false
  production_verified: false
  sprint_34_ready: true   # conditional: install rc.34 first and run the installed P0 set
```

- Standalone technical readiness NO-GO: D-01 (G03 not met) and D-02 (G06 not met).
- Formal gate NO-GO: same, plus the historical HALO qualification gate cannot be run honestly.
- Pilot GO: supervised real-repository work produced one commit-ready fix and one oracle-correct feature with no unsafe event; failures were reported honestly.
- Daily driver NO-GO: autocomplete unqualified, D-01, D-02.
- HALO BLOCKED: no shared coding model, 512-token output cap, 32K-character input cap.
- Sprint 34 ready, conditionally: Sprint 34 is supervised dogfooding, which the pilot supports, once rc.34 is installed and its installed P0 set passes.

## 12. Roadmap

- **Sprint 34 (dogfooding and shipping):** install rc.34; run installed P0 (stale ×5, cancel ×3 ×2, smoke, AUTO-CODE); fix D-01 and re-run 5/5; fix D-03; decide the Auto order; run dogfooding with fresh, non-confounded task baselines; commit RP-01 to REEPROV if the owner wants it.
- **Sprint 35 (personal V1 daily driver):** autocomplete default and scheduling (D-07), a new frozen held-out set after any model or runtime change, D-04 decision.
- **HALO (parallel):** handoff items 1–10 and the V2 qualification approval.

## 13. Final repository state

`main` `7c8c205` (PR #118, #119, #120 merged; CI green). This report is a docs-only follow-up. Installed production: `0.1.0-rc.30`. Evidence: `~/.cache/ovsc-sprint33b/` (S35 and autocomplete results, logs, pilot evidence) and `apps/desktop/acceptance/evidence/` in the sprint worktree.
