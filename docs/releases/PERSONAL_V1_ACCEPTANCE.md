# Personal V1 acceptance

Status: `PERSONAL_V1_BLOCKED`

The installed Linux application has not been shown to complete a real coding task. This record is the evidence for that decision. It is not a release.

## Git

- Branch: `product/personal-v1-production-completion`
- Starting commit: `68e80d1f2392a0737448e9ff9f74ab7a50f580d1` (`feat(agent): stop marking unapplied code edits as complete`)
- `git fetch origin` failed: `could not read Username for 'https://github.com': No such device or address`
- Local `origin/main` at the time of the branch was `9ed4743fe2d4a096f46db7025ec1d0d9a6508a26`
- The requested canonical main `3e58ebee606d6e457547712ef5f466f48f4b8a68` was not fetched. No reset or clean was run.
- Working tree was clean before this branch. No uncommitted work was discarded.
- Delivery commit: the commit on this branch whose parent is `68e80d1f2392a0737448e9ff9f74ab7a50f580d1`.

## What changed

Ordinary Build and Debug verification stays on the original `AgentRunner`. `RepairOrchestrator` starts only after that runner records `VERIFICATION_FAILED`, and it does not ask for the already-approved test again. `integrateRepairOutcome` keeps the original task id, events, tool calls, and applied paths. The CLI uses the same split.

A coding task that already has the required edit and a passing test completes instead of accepting another tool call or dying at the turn limit. A rejected edit on a coding task stops as `REJECTED` and does not write the file. Requests that say "change", "edit", "rename", or "replace" count as code changes in Build and Debug.

The chat header has a Model button. `Open VS Code: Select Local Model` lists models from the configured local Ollama endpoint, writes the chat and coding routes, and leaves the autocomplete route alone. A running task is not retargeted. There is no cloud fallback and no model download.

## Local model

- Machine: the current Linux host. Ollama at `http://127.0.0.1:11434`.
- Only installed model: `qwen2.5-coder:7b`, Q4_K_M, digest `dae161e27b0e`.
- No other model was downloaded.
- Every benchmark task routed to `local-chat` / `Qwen 2.5 Coder 7B · qwen2.5-coder:7b`.
- Harness: `scripts/personal-v1-local-benchmark.ts` through `AgentSessionBridge` and `createAgentRuntime`, with `OPEN_VS_CODE_REAL_INFERENCE=1`. Approvals were automatic. This is not the GUI.

Measured run, 2026-11-06, one pass. The same tasks vary between runs.

| Task | Group | Status | Independent check | Notes |
|---|---|---|---|---|
| original-format-note | original | `COMPLETED` | failed | Changed only `test/format-note.test.mjs`. Tests passed. The source still does not reject an empty title. False completion. |
| original-add | original | `FAILED` / `NON_PROGRESS` | failed | Repeated `search_text`. File still subtracts. |
| single-greet | unseen | `COMPLETED` | passed | `apply_patch` on `src/greet.mjs`, then verification. |
| single-even | unseen | `COMPLETED` | passed | `apply_patch` on `src/even.mjs`, then verification. |
| single-tax | unseen | `COMPLETED` | passed | Rate changed to `0.15`. |
| single-clamp | unseen | `FAILED` / `MAX_TURNS_EXCEEDED` | failed | Tests still failing. |
| single-shout | unseen | `FAILED` / `MAX_TURNS_EXCEEDED` | failed | Wrote an unrelated test file. Source unchanged. |
| debug-sum | unseen | `COMPLETED` | passed | Loop fix applied, tests passed. |
| debug-sign | unseen | `FAILED` / `NON_PROGRESS` | failed | Search only. |
| debug-join | unseen | `FAILED` / `NON_PROGRESS` | failed | Search only. |
| multi-prefix | unseen | `FAILED` / `NON_PROGRESS` | files matched, task did not | Both files changed. Verification did not run after the edit, so the task stayed incomplete. |
| multi-fullname | unseen | `FAILED` / `INCOMPLETE` | failed | Repeated `create_file` on an existing file, then stopped. |
| reject-greet | rejection | `FAILED` / `REJECTED` | file unchanged | One `apply_patch` rejected. No write. |

Unseen tasks completed and independently correct: 4/10. Required bar: 8/10. Original regressions: 0/2. False completion in this run: the format-note task. Unauthorized writes on the rejection task: 0.

Token counts are not on `AgentResult`. Latency for the completed unseen tasks was about 6–22 seconds.

## Checks that ran

- `tsc --noEmit` for `agent-core`, `ide-adapter`, `cli`, and `vscode-integration` passed before the final turn-limit edit. `agent-core` was typechecked again before the coding-reliability rerun.
- `packages/agent-core/tests/agent/coding-reliability-11a1.test.ts`: 21 passed.
- Repair workflow and repair integration tests: passed, including "failed verification repair does not ask to approve the same verification again".
- `packages/ide-adapter` `npm test`: passed after the bridge change.
- `packages/vscode-integration/tests/local-model-selection.test.ts`: 3 passed. Chat selection routes to the chosen served model. Autocomplete stays on `local-fim`.

Not run: `npm run lint`, `npm run build`, `npm test` for the whole monorepo, `eval:runtime`, `eval:workflow`, `eval:skills`, `eval:recovery`, `eval:performance`, `desktop:smoke`, `desktop:accept`. A skipped gate is not a pass.

## Package and GUI

- Installed package: `open-vs-code 0.1.0` amd64. It predates this branch.
- Existing artifact `apps/desktop/dist/open-vs-code_0.1.0_amd64.deb` is from 2026-11-06 14:23, before these edits. It was not rebuilt.
- Privileged install was not requested and was not run.
- Launch from the applications menu, repository open, chat, model switch, restart, and offline inference were not exercised in the installed app.

## Remaining blockers

1. `qwen2.5-coder:7b` does not meet the 8/10 unseen bar or the two original regressions. A stronger local coding model needs explicit approval before any download.
2. The format-note completion accepted a test-only edit. A completion that does not change the behavior the user asked for is still a false completion.
3. Build a Debian package from this branch, then install it only after approval.
4. Run the seven GUI journeys on that installed application.
5. Run the monorepo gates listed above on this branch.

## Rollback

Revert the delivery commit on `product/personal-v1-production-completion`. Its parent is `68e80d1f2392a0737448e9ff9f74ab7a50f580d1`. Do not reset the branch. No package was installed, so the installed application does not need a downgrade.

## Readiness

`PERSONAL_V1_BLOCKED`
