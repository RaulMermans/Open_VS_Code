# Sprint 31 — MVP convergence

STATUS: `IN_PROGRESS`. Installed desktop remains `open-vs-code 0.1.0-rc.25`. This branch was not pushed, merged, or installed.

## Source

- Authoritative head: `origin/main` `ff29fa4038` (merge of `repair/30-automated-program-repair`). Local `main` in the primary checkout was 150 commits behind and was not moved.
- Worktree: `/home/raul-mermans/.cache/ovsc-sprint31/wt`, branch `sprint/31-mvp-convergence`.
- Dependencies: `npm ci --offline --ignore-scripts` in that worktree. `@open-vs-code/*` links resolve inside the worktree.
- Model present: `qwen3.6:35b` id `a7eb95c53bcf` (`ollama list`), family `qwen35moe`, 35.5B, Q4_K_M.

## Architecture

Path A. Native Agent Core stays the only executor. Aider and Qwen Code were not run. Sprint 30 already showed the scripted patch path works and that two live replays could edit `service.ts` without exporting the class the test imports. A second engine was not justified before that localization existed.

## Change

`diagnoseUnresolvedSymbols` already explained missing ESM exports. It did not understand Vitest's `The instanceof assertion needs a constructor but undefined was given`, which names the test line and not the symbol. The diagnosis now reads that line, follows the import, and for a workspace package compares the package entry with the existing definition. When the entry omits the class, the report says to re-export it and not to edit the test. A failure summary whose only stacks are test files says the same. No HALO-specific branch.

## Evidence

- Scripted repair control (`repair-control.test.ts`): one `apply_patch`, second verification, `COMPLETED`. A "tests passed" reply after a failing run is not `COMPLETED`. 2/2.
- New fixture: `@acme/models` entry exports `ConfigError` while `QualificationError` exists in `errors.ts`. The report names the entry, the definition, and the re-export instruction.
- Frozen i1 workspace (read-only): the same report names `ModelQualificationError` from `@halo/models`, `packages/models/src/index.ts` omitting it, and the definition at `packages/models/src/errors.ts:8`.
- `symbol-diagnosis`, `verification-summary`, and `repair-control` tests: 9/9. oxlint `--deny-warnings` on the touched files: clean.

## Not run

- A live `qwen3.6:35b` repair from the frozen checkpoint. The new text has not been shown to the model.
- Aider, Qwen Code, the 10 unseen tasks, three clean HALO qualifications, and a desktop package from this SHA.

## Release

- Technical MVP candidate: **NO**. The editor package was not rebuilt.
- Supervised-testing: **NO-GO**. No new HALO qualification.
- Daily-driver: **NO-GO**. Installed package remains `0.1.0-rc.25`.

Next action: one live repair from a clean copy of frozen i1, on this SHA, with the same model and the same independent Vitest file. Do not edit that test. If the model re-exports the class and the five failures remain, the next defect is the alias check in `InferenceService`, not the export.
