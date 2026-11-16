# Sprint 21 — Reliable coding engineering and production acceptance

Date: 2026-11-16. Branch `sprint/v1-milestone-1-foundation`. Candidate `0.1.0-rc.20` from `fa532f0197`, `.deb` SHA-256 `dc31878db39dc150e6682e1d177c99895bd7e09eb8ec76911c6f2c17f2eb3d30`, bundled `extension.js` `3b5357452108e08f2c00def72312a8d981b1b9ca54584bd490013ebbdb026e60`.

## 1. Current state at start

| Item | Found |
| --- | --- |
| HEAD | `2532a39e7d`, tracked tree clean |
| CI | `npm run typecheck` failed (3 `runner.ts` contract errors, 15 test/eval typing errors). 15 deterministic tests failed. Lint failed. |
| Installed package | `open-vs-code 0.1.0-rc.19` (status doc said rc.16 — stale) |
| Installed extension | `dpkg -V` checksum mismatch: `extension.js` overwritten by root 2026-11-14 07:30 (`a01b8ad3…`), not the packaged `1e58f155…`. Production ran an untracked overlay. |
| Model | `qwen3-coder:30b`, Q4_K_M, digest `06c1097efce0…`, Ollama 0.40.15, `OLLAMA_CONTEXT_LENGTH=65536` |

## 2. Root causes (from live traces, not guesses)

Measured with a new 30-task harness that drives the desktop's own path: `AgentSessionBridge.runTask → createAgentRuntime` with the routing the extension builds (`buildStarterRoutingConfig`), workflow/progress/learning off as shipped. Oracles are independent: harness-run tests, a hidden oracle executed outside the workspace, git status and byte checks.

| # | Defect | Evidence (baseline A) |
| --- | --- | --- |
| 1 | Chat tasks capped at **3 applied writes**: ADR-011 per-step budget never reset on the chat path | `Max files per step (3) exceeded` in d07/h07; Sprint 20 "stalls on the third file" |
| 2 | **Unbounded refusal loops**: pre-execution refusals bypassed every non-progress guard | d04: 140 refused `run_verification`; 4 wall-clock timeouts |
| 3 | **Unactionable import refusal**: hint suppressed by duplicate read paths; valid bundler TS imports refused | d03: 20× `These imports do not exist: ./format`, 3/27 patches applied, 128 turns |
| 4 | **No Python verifier** | d05/h04/h07/h13/h14: `Failed to read package.json` |
| 5 | **PATCH_MISMATCH without context** | 39% patch applicability |
| 6 | **Completion gate demanded edits to every named path**; created files not counted for "Create X" | d04 (B): tests passed at turn 5, churned to 141 turns; d02 INCOMPLETE |

## 3. Changes (ADR-045)

Deterministic, inside existing Agent Core / MutationEngine / PermissionGate. No new framework, no turn-limit increase.

- `locatePatch` (exact → unique uniform-indent window → typed miss with numbered closest lines).
- One relative-import resolver with the exact working specifier.
- Python verifier registry (Django `manage.py test`, configured pytest, unittest); zero tests never PASS.
- Refusal bound: same refusal 4× without workspace change → truthful `NON_PROGRESS`, emitted after the refused call finishes (a first version crashed the run; caught by repeats, fixed with a regression test).
- Per-step mutation budget reset per model response.
- Completion gate: a passing post-edit run satisfies named-but-unneeded paths (listed in the summary); explicit create requests count created files.
- CI: contract fix, test typings, 15 failing tests fixed at cause (non-existent verification output args are containment-checked; `ALREADY_SATISFIED` accepted by REA; silent identical failures hash again). A vacuous safety assertion now tests real write outcomes.

Deterministic additions: `patch-location`, `verification-python`, `repeated-refusal`, `mutation-step-budget`, `completion-gate` tests plus import-resolver cases.

## 4. Live evaluation (same model digest, same 30 tasks, 6-minute wall clock, unlimited turns as shipped)

Results: `evals/results/sprint-21-coding-{A,B,RC}-ALL.json`. Summarize with `packages/ide-adapter/evals/summarize-coding-eval.ts`.

| Metric | A baseline `2532a39e7d` | B `a3b72571fb` | RC `390eb1ec06` | **RC2 = rc.20 `fa532f0197`** |
| --- | --- | --- | --- | --- |
| Correct (independent oracle + visible tests + scope), 30 | 22 | 25 | 26 | **27 (90%)** |
| Held-out correct, 22 | 17 | 18 | 20 | **21 (95%)** |
| Completed truthfully (status COMPLETED) | 15 | 18 | 24 | **25** |
| False completions | 0 | 0 | 0 | **0** |
| Wall-clock timeouts (unbounded loops) | 4 | 1 | 1 | **0** |
| Runner crashes | 0 | 0 | 2 of 6 repeats (`AgentTransitionError`, fixed in `fa532f0197`) | **0** |
| Patch applicability | 39% | 73% | 78% | **88%** |
| Median turns / seconds | 18 / 42 | 8 / 18 | 6 / 15 | **5 / 13** |
| Refused + failed tool calls | 578 | 76 | 54 | **42** |

Flaky-task repeats on rc.20 (3 each): three-file d03 **3/3**, rename d07 2/3, missing-export d04 1/3 (every failure stopped truthfully as `NON_PROGRESS`, no crash).

Remaining failure modes on rc.20: cross-file rename/export repair (model renames one side and stalls; the run now stops in seconds instead of looping), and one scope deviation (after refused traversal, the model proposes an in-workspace substitute file, approved by the eval host). Safety boundary: path escape refused in every run; nothing written outside a workspace; rejected writes left files unchanged; stale external edits preserved; prompt-injected file never created.

Held-out tasks (22) were never traced and were not used to tune code. DEV traces drove every fix.

## 5. Isolation investigation

- Docker: installed, socket root-only; adding the user to `docker` is root-equivalent and was not done.
- **bubblewrap works unprivileged on the X3**: workspace bind mount, `--unshare-all` (Ollama unreachable inside), `$HOME` invisible, cleared env, tmpfs `/tmp`; 3/3 probes passed. Recommended next step: opt-in sandboxed verification. Not wired in; host execution unchanged.
- Electron's sandbox does not sandbox agent commands. Personal V1 remains a trusted-project tool with explicit approvals.

## 6. Not run / limitations

- Comparison C (mini-SWE-agent/Aider): NOT_RUN. Their execution model is an unrestricted shell.
- Whole-file edit-format A/B: NOT_RUN.
- Structured workflow path (off by default) still lacks the per-step reset.
- Cross-file rename/move refactors remain the weakest category (model capability; d07, h08).
- `--test-force-exit` occasionally truncates a child's TAP output (tests vanish, not fail). Harness issue, classified, not fixed.
- One scope deviation class: after a refused traversal the model may propose an in-workspace substitute file; it goes through normal diff approval.

## 7. Production acceptance

- Pre-install, exact rc.20 extension bytes in the installed (byte-identical) setuid shell: 15/18 PASS, all critical safety PASS. CODE-CONTINUE-COMPLETE, CODE-HELD-TS and CODE-HELD-PY, which failed on rc.19, PASS.
- Installed via `pkexec apt-get install` after user authorization. `dpkg -V` clean.
- Installed production lab: 13/13 PASS. Launcher start on the real profile: Ollama reachable, history and model preferences preserved.
- Verdict: **GO — supervised Personal V1.** Rollback: see `docs/releases/V1_CONVERGENCE_STATUS.md`.
