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
- A package whose tests load `dist` gets an extra line: build after the re-export, because a source-only edit stays invisible.
- Symbol-diagnosis tests: 6/6. oxlint `--deny-warnings` on the touched diagnosis files: clean after the shadow rename.

## Disposable qualification repair

A copy of frozen i1 at `/tmp/ovsc-s31-q` (the frozen tree was not edited). Two source edits, then `tsc` for `@halo/models` because Vitest loads `dist`:

- `packages/models/src/index.ts` re-exports `ModelQualificationError`.
- `packages/inference/src/service.ts` throws `ModelQualificationError` (`ALIAS_RESOLUTION_MISMATCH`) before `provider.chat` when `modelRef` is a bare alias other than `qwen3-4b-q4km`. Refs that contain `/` stay on the old path, which is what `service.test.ts` and `media.test.ts` already call.

`packages/inference` Vitest: 27/27 (qualification 8/8, plus service, media, and the OpenAI-compatible provider). `qualify-oracle.py` on that copy: `SUCCESS` true. This was applied by hand, not by `qwen3.6:35b`.

The diagnosis now says when the package's loaded `dist` file omits the class, so a later model run is told to build. That sentence was not part of the hand patch.

## Not run

- A live `qwen3.6:35b` repair from the frozen checkpoint.
- Aider, Qwen Code, the 10 unseen tasks, three clean HALO qualifications from the agent, and a desktop package from this SHA.

## Release

- Technical MVP candidate: **NO**. The editor package was not rebuilt. The green qualification is a hand patch on a disposable copy.
- Supervised-testing: **NO-GO**. The 3/3 agent gate was not run.
- Daily-driver: **NO-GO**. Installed package remains `0.1.0-rc.25`.
