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

CANDIDATE_RC28_PLACEHOLDER

## MVP coding benchmark (S32)

`packages/ide-adapter/evals/coding-tasks-s32.ts`, frozen at `cd86f3b` before any model run (SHA-256 `ba854248e2cb5bf4…`). Ten disposable Git repositories: explain (Ask), bugfix, small feature, write tests, failed-test repair, cross-file rename with a same-named distractor, multi-file TypeScript, Python regression, React-style frontend change (no React runtime is installed offline, so components use a local `h()`/`render()`), and a cache feature with integration and tests. Each has an allowed-change list, files that must stay byte-identical, visible tests the agent can run, and a hidden oracle run from outside the workspace. Test-writing is judged by four mutants of the implementation. `--check-references` proves each oracle rejects the untouched fixture and accepts a hand reference (10/10; the hand references are not agent results). The check caught one fixture defect before freezing (hidden `tsc` on `test/` without Node types).

The runner drives the desktop path (`AgentSessionBridge.runTask → createAgentRuntime`, the desktop's chat routing, TypeScript code intelligence on, 10-minute budget, all approvals granted and counted). It refuses to start when the model is missing or a workspace package resolves outside the checkout, and records the benchmark hash, model digest and source head. Pass = visible tests pass + hidden oracle passes + no out-of-scope change + protected files unchanged (Ask: hidden answer checks + no change).

### Results

BENCHMARK_TABLE_PLACEHOLDER

### Failure classification (first causal error)

FAILURE_CLASS_PLACEHOLDER

### Where the time goes

Both models spend 97–98% of task wall-clock waiting for the model (qwen3.6 baseline: 1,429 s of 1,477 s; qwen3-coder: 1,454 s of 1,484 s). Estimated compiled prompts are small (about 0.7K–10K tokens, except one 48K-token runaway). Verification runs take 0.25–0.4 s each in bubblewrap. Context building, tool execution and verification are not the bottleneck; generation is. For qwen3.6 that is mostly reasoning output: the two-call bugfix took 23 s against 7 s for qwen3-coder. The runaways (qwen3.6 s32-05, qwen3-coder s32-06/09/10) spent their time on repeated turns after the work was done or while thrashing, not on long prompts. Reasoning was not disabled; no evidence yet says correctness would survive it.

## Model comparison and Auto

MODEL_PLACEHOLDER

## HALO

Read-only inspection of the deployed Core (`127.0.0.1:4310`, release `halo-core-0.1.0+ccd05e504ffd`) and of the HALO repositories. Details and the handoff are in `docs/deployment/HALO_SPRINT32_HANDOFF.md`.

- Works today: health, `/inference/status`, `/models`, `/routes`, `/infrastructure/model-runtimes` (runtime phase, port, artifact SHA-256s), `/inference/admission` (1 active / 8 queued, occupancy), `/hardware` (CPU and RAM; GPU `unavailable`). Open VS Code's Check HALO Connection uses health, status, access and model.
- Not deployed: the VC-07B tool protocol (`edb6393`). Deployed `/inference/status` says `tools: false`; request schemas are strict, so a tool-carrying capability request is rejected.
- Not managed by HALO: Open VS Code's coding models. HALO registers only Qwen3 4B and 14B on llama.cpp Vulkan with 8K context. HALO does not observe Ollama, so every Direct Ollama request bypasses HALO admission and HALO telemetry says nothing about it.
- Phase D (identical-digest A/B) was not run: no model is served by both paths. It needs HALO changes that were not authorized.
- Fixed in Open VS Code (`30baf40`): with `open-vs-code.halo.modelId` set, HaloProvider silently dropped every tool, so Agent and Debug ran a model that could never edit. Write tools are now refused before any request; read-only Ask keeps working as VC-07 Gate C verified. The connection check treated a Core that advertises tools as a failure; it now reports tool support truthfully and says when HALO is Ask-only.
- HALO is not eligible for Agent mode. HALO provides no measured infrastructure benefit to Open VS Code today.

## Runtime fixes from observed failures

RUNTIME_FIX_PLACEHOLDER

## Not run or not established

- Autocomplete quality (responsiveness, relevance, interference with agent inference) was not measured; the provider path is unchanged.
- GUI cancellation (SAFE-CANCEL), model picker persistence (LIFE-MODEL), the actionable missing-model error (UX-ERROR) and composer keys (UX-KEYS) stayed blocked on the Playwright path.
- Aider/Qwen Code harness comparison: not repeated. Sprint 31's single Aider run stands; native failures in S32 are not tool-protocol failures that another harness would obviously fix.
- HALO qualification 3/3: not run. The specification audit from Sprint 31 stands; no new evidence changes it, and the brief puts it behind the model comparison and ordinary coding.
- No large model was downloaded. No HALO service, system setting or installed package was changed.

## Release decisions

RELEASE_PLACEHOLDER
