# ADR-045: Deterministic edit location, verifier registry and bounded refusals

Status: Accepted (Sprint 21, 2026-11-16)

## Context

A 30-task live evaluation of the desktop chat path (`AgentSessionBridge → createAgentRuntime → AgentRunner`, `qwen3-coder:30b`, desktop routing defaults) on the Sprint 20 source showed that most failures were produced by the runtime, not by the model's reasoning:

1. **Write cap.** The chat runtime builds one `MutationEngine` per request. ADR-011 budgets are per step, but the chat runner never reset the step counter, so a task could apply at most three writes. Later edits failed with `BUDGET_EXCEEDED`.
2. **Unbounded refusals.** Refusals issued before a tool executes (for example "the last test run already failed, change the code first") bypassed the non-progress guard. With the unlimited daily-driver turn budget, one baseline task issued 140 identical refused `run_verification` calls until the harness stopped it.
3. **Unactionable import refusals.** The import guard rejected `from "./format"` without the working specifier. The hint that existed never fired because duplicate read paths defeated its uniqueness check. Separately, extensionless imports were refused even in tsc/bundler projects where they are valid.
4. **No Python verifier.** Without `package.json` and Node tests, `run_verification` could not run, so correct Python edits ended as `NON_PROGRESS`.
5. **Patch misses.** `PATCH_MISMATCH` said only "not found", so the model spent turns re-reading files.

## Decision

Keep the existing Agent Core, PermissionGate, MutationEngine, checkpoints and IDE adapter. No new orchestrator. Move the five behaviors above into deterministic code:

- **Edit location** (`locatePatch`, pure function in `mutation-engine.ts`): exact unique match; else a unique line window whose indentation differs by one uniform offset (replacement re-indented, CRLF preserved); else a typed `PATCH_MISMATCH` carrying at most 24 numbered closest lines and an "already applied?" note. Ambiguity and uneven indentation are refused, never guessed. The prepared diff, approval, stale-base check and budgets are unchanged.
- **Import resolution** (`relativeImportProblems` in `runner.ts`, one authority for `create_file` and `apply_patch`): a specifier that resolves to a real file is accepted when the project toolchain resolves it (tsconfig without TS-extension imports), and refused with the exact working specifier when the project runs native Node ESM or type stripping.
- **Verifier registry** (`verification-discovery.ts`): `package.json` scripts; Node test files; then Python — `manage.py test` (Django), `python3 -m pytest -q` only when the repository configures pytest, otherwise `python3 -m unittest discover`. Interpreters come from `PATH` and are refused if they resolve inside the workspace. "Zero tests ran" is never PASS. No verifier → `VERIFICATION_UNAVAILABLE`, never PASS.
- **Refusal bound** (`#recordRefusal` in `runner.ts`): the same refusal (tool, category, message) four times without a workspace state change (applied mutation or new verification run) stops the run as `NON_PROGRESS` with a truthful summary. Reads do not reset it. Runtime-initiated verification does not count.
- **Per-step budget** (`mutationStep` runner dependency): the runner resets the engine's step counter before each model response, as ADR-011 intended.

## Consequences

- Multi-file tasks are no longer capped at three writes. The per-step budget still applies inside one response.
- No task can loop on an identical refusal; the unlimited turn budget no longer implies unbounded work.
- Valid bundler-style TypeScript imports are no longer refused.
- Python repositories get real verification; the structured workflow path (off by default) still constructs runners without `mutationStep` and keeps the old per-task write cap. Recorded as a limitation.
- Whitespace-normalized matching could, in principle, apply an edit to a block that differs from the model's intent only in indentation. It is limited to a unique window with uniform offset, and the human still approves the exact diff.

## References

Aider `editblock_coder.py` (`5dc9490`), OpenCode `edit.ts` (`0354362`), SWE-agent edit tools (`3ea751c`), Agentless (`5ce5888`). Concepts only; see `docs/research/SPRINT_21_REFERENCE_MAPPING.md`.
