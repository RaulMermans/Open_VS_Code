# Sprint 31 — MVP convergence

STATUS: `IN_PROGRESS`. Installed desktop remains `open-vs-code 0.1.0-rc.25`. This branch is on origin. It was not merged or installed.

## Source

- Authoritative head: `origin/main` `ff29fa4038` (merge of `repair/30-automated-program-repair`). Local `main` in the primary checkout was 150 commits behind and was not moved.
- Worktree: `/home/raul-mermans/.cache/ovsc-sprint31/wt`, branch `sprint/31-mvp-convergence`.
- Dependencies: `npm ci --offline --ignore-scripts` in that worktree. `@open-vs-code/*` links resolve inside the worktree.
- Model present: `qwen3.6:35b` id `a7eb95c53bcf` (`ollama list`), family `qwen35moe`, 35.5B, Q4_K_M.

## Architecture

Path A. Native Agent Core stays the executor. Aider 0.86.2 was run once as a comparison, not installed into the product. Qwen Code was not run. The comparison did not justify a second engine: Aider wrote the alias check and still failed the inference suite.

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

## Live Qwen repairs (`qwen3.6:35b` `a7eb95c53bcf`)

Same prompt as Sprint 30. 12-minute cap. Code intelligence on. Writes and tests inside the copy were auto-approved. The frozen tree, the test file (`a720192c09dde28c…`), and `0.1.0-rc.25` were not changed.

Attempt 1, before the rebuild (`/tmp/ovsc-s31-live`, `CANCELLED`, 720s, 13 turns, 24 tools): the model re-exported `ModelQualificationError` from `src/index.ts` on the second patch and added an unused import in `service.ts`. It read `dist/index.js` and did not build it. Verification stayed 5 failed / 22 passed. The dist sentence was in the 16KB observation (it starts about 2KB into the diagnosis, so the 2.5KB trace clip hides it).

Attempt 2, with a stale `tsc` rebuild before TEST (`/tmp/ovsc-s31-live2`, `CANCELLED`, 720s, 13 turns, 21 tools): the diagnosis began `Rebuilt @halo/models because dist/index.js was older than src.` The export landed in `dist`. Independent Vitest: **4 failed / 23 passed**. The missing constructor is gone. `chat` still returns for a bad alias, so generation is not blocked. The test file was not edited. Existing inference tests stayed passing.

## Aider comparison

Aider 0.86.2 (Apache-2.0, installed with `uv tool` outside this repo) on `/tmp/ovsc-s31-aider/ws`, a clean copy of frozen i1. Model `ollama_chat/qwen3.6:35b`, digest `a7eb95c53bcf96b4bdd008d0fab4a5dac88047d9c1a7a9ab88ed453423fbd87c`. Same prompt. The test file was read-only. Baseline before the run: **5 failed / 3 passed**. Wall clock 16:36:54–16:44:30 (about 7.5 minutes). Four Vitest runs, each under 0.5s. Aider stopped at its 3-reflection limit. The 20-minute cap was not hit.

Edits: re-export `ModelQualificationError` from `packages/models/src/index.ts`, and in `service.ts` throw `ModelQualificationError` (`ALIAS_RESOLUTION_MISMATCH`) when `model.modelRef` differs from `HALO_INFERENCE_QUALIFY_MODEL_ID`, defaulting that variable to `qwen3-4b-q4km`. `errors.ts` matches the frozen file. The test hash stayed `a720192c09dde28c…`. Aider also appended `.aider*` to `.gitignore`. It did not run `tsc`.

Aider's own last test result: **4 failed / 4 passed**. The throw runs, but the test import of `ModelQualificationError` is still undefined because `dist/index.js` was not rebuilt.

Independent `tsc -p packages/models` after Aider stopped, then Vitest: the qualification file is **8 passed**. The inference package is **13 failed / 14 passed**. The new failures are `service.test.ts` (2) and `media.test.ts` (11): those tests use `runtime/…` refs, and the default qualify id rejects them before the old checks. The frozen tree and `0.1.0-rc.25` were not changed.

## Not run

- A third native live attempt and Qwen Code. Aider wrote a broader alias check than the native runs, and that check fails the existing inference tests.
- The 10 unseen tasks, three clean HALO qualifications, and a desktop package from this SHA.

## Release

- Technical MVP candidate: **NO**. Native live repair is 4 failed / 23 passed. Aider's patch, after a separate `tsc`, passes the qualification file and fails the inference package 13 / 14.
- Supervised-testing: **NO-GO**. The 3/3 agent gate was not run.
- Daily-driver: **NO-GO**. Installed package remains `0.1.0-rc.25`.
