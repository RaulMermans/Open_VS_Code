# Sprint 11A.1 — Real-Model Coding Reliability

Status: `SPRINT_11A1_PARTIALLY_VERIFIED`

Branch: `sprint/11a1-real-coding-reliability`
Baseline: `9ed4743fe2d4a096f46db7025ec1d0d9a6508a26` (`origin/main`, merge of PR #61). The merge tree matches the Sprint 11A head `f34684a91e5289cb73d0fce9149889acf2b95364`. The worktree was clean before this branch.

## Root causes

The two Sprint 11A edit failures were not a missing agent or a broken model adapter.

1. **Wrong tool, weak correction.** `qwen2.5-coder:7b` called `create_file` on a file that already existed, and `modify_file`, which is not registered. The runtime returned the raw engine text (`Cannot create file that already exists`, `Unknown tool`) without naming `apply_patch`.
2. **False completion.** After that rejection, a passing test run was treated as success. `BEFORE_COMPLETION` allows completion when no mutation was applied, so an empty model answer became `COMPLETED` while the source was unchanged. Reproduced on the baseline runner before this change.
3. **Edit tasks were told to stop using tools.** Once repository evidence was satisfied, the prompt said not to call more tools. An edit that still had no applied patch needs `apply_patch` or `create_file` after the reads.

The provider wire format was not the boundary. The same false completion happens with a scripted provider.

## What changed

- Tool descriptions for `apply_patch` and `create_file` state which one modifies an existing file and which one creates a new file. `modify_file` is not registered and is not offered.
- When those tools are exposed, the turn guidance says paths are workspace-relative, edits wait for approval, and a test run does not write files.
- Unknown tool, existing-file create, and absolute or traversal paths return one corrective observation. The same contract error a second time stops as `INCOMPLETE`.
- BUILD and DEBUG instructions that ask for a code change cannot finish as `COMPLETED` unless a relevant mutation was applied. Named files must be among the applied paths. A user rejection is `REJECTED`. A required test that did not pass is not success. Ask, Plan, and Review stay read-only.
- An empty final answer is replaced with a short evidence summary. The chat failure line includes that summary.
- A later applied edit clears the earlier tool-contract failure so a recovered patch is not blocked by the failed `create_file`.

No new agent, router, tool, or alias was added.

## Real local model

Provider: Ollama at `http://127.0.0.1:11434`.
Model: `qwen2.5-coder:7b` (Q4_K_M, digest `dae161e27b0e`).
Route: `qwen-chat` / `ollama-local`, label `Qwen 2.5 Coder 7B · qwen2.5-coder:7b`.
No other model is installed. Nothing was downloaded. No cloud fallback.

The tasks ran through `AgentSessionBridge` and `createAgentRuntime` with `OPEN_VS_CODE_REAL_INFERENCE=1`. Approvals in that harness were granted. This is not the GUI.

| Task | Result | File on disk | Notes |
|---|---|---|---|
| Original: reject empty title or body in `formatNote`, update tests, run tests | `FAILED` / `NON_PROGRESS` (~2.1 s, 3 model calls) | unchanged | Repeated `search_text`. No patch. Summary says no files changed. |
| Original: fix `add(2, 3) === 5` | `FAILED` / `NON_PROGRESS` (~7.5 s, 9 model calls) | still subtracts | Did not call `modify_file`. Did not apply a patch. |
| Unseen: change `hi` to `hello` in `src/greet.mjs` and run tests | `COMPLETED` (~4.7 s, 6 model calls) | `return \`hello ${name}\`` | `apply_patch` was prepared, approved, and applied, then verification was prepared. |
| Unseen: change prefix `NOTE` to `ITEM` in the source and the test | `FAILED` / `NON_PROGRESS` (~8.3 s, 8 model calls) | source says `ITEM`; the test still expects `NOTE` | One approved patch. Later patches were ambiguous or missed. Summary says verification did not run after the edit. |
| Unseen: fix `isEven(2)` | `COMPLETED` (~9.7 s, 10 model calls) | `return value % 2 === 0` | Approved `apply_patch`, then verification was prepared. |

An earlier run of the format-note task did call `apply_patch` and was rejected for an ambiguous search, then hit the turn budget. The 7B model can emit the canonical tool. It does not do so reliably on the original tasks. Token counts are not on `AgentResult`.

When BUILD or DEBUG approves `run_verification`, the bridge hands the turn to `RepairOrchestrator`. That result can be `COMPLETED` with an empty `finalAnswer` even though the runner summary exists. The greet and even successes show this.

## Debian package

Built package, not rebuilt in this sprint:

- `apps/desktop/dist/open-vs-code_0.1.0_amd64.deb`
- Built 2026-11-06 14:23 (before these reliability edits)
- SHA-256 `eed10471274cb3c06d1f3214e405a2dc4b6e7f3b60d8c3aa5232442e535f54b1`
- Size 178,233,424 bytes
- Payload SHA-256 `bb7942a428c4a11197e94e62797164a6dcaf4f2eab7503a5328e9cfbaf2c5d8d`
- `postinst` sets `chrome-sandbox` to `root:root` mode `4755`
- The packaged launcher does not pass `--no-sandbox`

Installed package is still the older tree: `/usr/lib/open-vs-code/codium` and `chrome-sandbox` are dated 2026-09-09. The installed helper is `4755 root:root`. This sprint did not run a privileged install. GUI acceptance is **NOT_VERIFIED**. A headless bridge run is not a substitute.

## Tests

`npm run typecheck` passed for all workspaces.

`npm test` in `@open-vs-code/agent-core`: 996 passed, 2 failed, 3 skipped. The failures are the existing ones:

- `FINAL_REPORT.txt` does not contain `Node: v22.23.4`. This machine is Node v22.23.4. The report is a historical snapshot, so the test was not edited and the report was not rewritten.
- The REA governance test cannot find the Reverse Engineer Anything entry script (`REA_NOT_INSTALLED`). That is an unavailable local integration, not a passing live integration.

New coverage is `packages/agent-core/tests/agent/coding-reliability-11a1.test.ts` (19 tests). Workflow stages that set `verificationOwner: "workflow"` keep their own completion decision.

The repo-wide lint, build, eval, and desktop gates were not re-run in this session.

## Remaining limits

- `qwen2.5-coder:7b` still fails the two original edit tasks. No second local model is available for comparison.
- Repeated identical `search_text` calls still stop the run under the existing non-progress guard.
- The repair handoff can drop the execution summary.
- The new `.deb` is not the installed application, and it does not contain this sprint's runner changes.
- Sprint 11B should not start from a model-picker until an installed build of this branch has been used for one approved edit and test in the GUI.
