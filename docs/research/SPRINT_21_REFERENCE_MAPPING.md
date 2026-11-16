# Sprint 21 — reference implementations inspected

Date: 2026-11-16. Read-only shallow clones in a session scratch directory. No scripts from these repositories were executed. No code was copied; every change below is an independent TypeScript implementation inside the existing MutationEngine, runner and verification registry.

| Reference | Commit inspected | License | Files read | Concept used | Classification |
| --- | --- | --- | --- | --- | --- |
| [Aider](https://github.com/Aider-AI/aider) | `5dc9490bb35f` (2026-05-22) | Apache-2.0 | `aider/coders/editblock_coder.py` (`replace_most_similar_chunk`, `perfect_or_whitespace`, `replace_part_with_missing_leading_whitespace`, failure report) | Exact match first, then a match that differs only by a uniform leading-whitespace offset with the replacement re-indented; on failure, show the closest real lines and say when the replacement text is already present | REFERENCE_ONLY (concept) |
| [OpenCode](https://github.com/anomalyco/opencode) | `0354362b857b` (2026-11-16) | MIT | `packages/core/src/tool/plugin/edit.ts` | Uniqueness is mandatory; CRLF endings are matched and preserved; trailing-whitespace tolerance; typed "not found / multiple matches" failures | REFERENCE_ONLY |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | `3ea751c087f3` (2026-07-16) | MIT | `tools/windowed_edit_linting/bin/edit`, `tools/edit_anthropic/bin/str_replace_editor` | Tool feedback written for the model (show the window, reject edits that introduce syntax errors and explain why) | REFERENCE_ONLY; lint-on-edit not adopted this sprint (no failure in the data was a syntax error) |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | `04d809ceab9d` (2026-09-03) | MIT | README and agent loop | Minimal bash-only baseline | Not run: its tools are an arbitrary shell, which the Personal V1 trust model does not allow unattended. Comparison C is NOT_RUN. |
| [Agentless](https://github.com/OpenAutoCoder/Agentless) | `5ce5888b9f14` (2024-12-22) | MIT | README, repair/validation stages | Localization → repair → validation as fixed stages; validation owned by the pipeline, not the model | REFERENCE_ONLY; informed runtime-owned verification and the refusal bound |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | docs only | MIT | Docker sandbox documentation | Disposable workspace, narrow mounts, no credentials, no host socket | Investigation only (see SPRINT_21 doc, isolation) |

## Where each concept landed

- `locatePatch` in `packages/agent-core/src/tools/mutation-engine.ts`: exact unique match → unique line window with a *uniform* indentation offset (Aider) → typed `PATCH_MISMATCH` with the closest numbered lines (Aider "did you mean") and an "already present" note. Stricter than Aider: the fallback must be unique, and uneven indentation drift is refused instead of guessed.
- CRLF preservation and mandatory uniqueness follow OpenCode's contract.
- Runtime-owned verification and the bounded refusal stop follow Agentless's principle that validation is a pipeline step and repeated identical outcomes are not progress.

## Not adopted

- Fuzzy edit-distance matching (Aider has it disabled; it can silently change the wrong code).
- `replaceAll` (OpenCode). No observed failure needed it; renames are done per file.
- Whole-file rewrite as the default edit format. With the locator and the other runtime fixes, search/replace patch applicability rose from 39% (A) to 73% (B) on the same 30 tasks and model. A separate whole-file A/B was **not run** this sprint, so no claim is made about it.
