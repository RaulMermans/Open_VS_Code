# Sprint 31 — qualification specification audit

The frozen evaluator `qualify-oracle.py` was not modified. This audit is separate from it. Historical run scores are unchanged.

## Sources

- Brief: the qualification-only instruction. Set `HALO_INFERENCE_QUALIFY_MODEL_ID=x3-qwen3-4b-vulkan`. The registered model resolves to runtime alias `qwen3-4b-q4km`. Add project-module tests for the seven named cases. Do not treat a different loaded model as equivalent.
- Frozen tests: `packages/inference/test/modelQualification.test.ts`, hash `a720192c09dde28c75ec56599b38391799b19e810117886294e9d1c2bc21bea6`.
- Implementation at the frozen checkpoint: `InferenceService.resolveModel` checks that the id exists, is enabled, and has the capability. It does not read `HALO_INFERENCE_QUALIFY_MODEL_ID` and does not throw `ModelQualificationError`.
- `config/models.json` registers only `development/example-*` refs. It has neither `x3-qwen3-4b-vulkan` nor `qwen3-4b-q4km`.
- `ModelQualificationError` is defined in `packages/models/src/errors.ts` and is absent from `src/index.ts` and from `dist/index.js`. `@halo/models` loads `dist`.

## What the frozen tests actually assert

None of the chat cases set `HALO_INFERENCE_QUALIFY_MODEL_ID`. The only mention of `x3-qwen3-4b-vulkan` is an object-literal equality check, not a call into HALO config.

| Case | modelRef | Asserted result |
| --- | --- | --- |
| Expected alias advertised | `qwen3-4b-q4km` | `chat` resolves |
| Expected alias missing | `some-other-alias` | `ModelQualificationError`, code `ALIAS_RESOLUTION_MISMATCH` |
| Wrong alias | `wrong-alias-q4km` | same error |
| HTTP availability without readiness | `qwen3-4b-vulkan` | same error |
| Provider unavailable, matching alias | `qwen3-4b-q4km` | provider failure, or the qualification error |
| Auth failure, matching alias | `qwen3-4b-q4km` | same |
| No upstream generation | `wrong-alias-q4km` | `provider.chat` is not called |

A comment says qualification passes when the env var equals `modelRef`. The passing `modelRef` is `qwen3-4b-q4km`. The brief's env value is `x3-qwen3-4b-vulkan`. Those strings are not equal, and the test treats `qwen3-4b-vulkan` as a mismatch.

## What must stay unaffected

`service.test.ts` calls `chat` with `runtime/coder` and `runtime/embedder`, and expects `MODEL_DISABLED` / `MODEL_CAPABILITY_MISMATCH` for the other fixtures. `media.test.ts` uses `runtime/vision-video` and `runtime/vision-image`. None of these set the qualify env var. A check that rejects every `modelRef` other than `qwen3-4b-q4km` fails these tests.

## Oracle gap

`qualify-oracle.py` returns `SUCCESS` when a changed test file mentions `qwen3-4b-q4km` or `QUALIFY_MODEL_ID`, imports `@halo/` or a relative path, and Vitest passes on those files only. It does not run `service.test.ts` or `media.test.ts`. It does not check that `x3-qwen3-4b-vulkan` resolves to `qwen3-4b-q4km`. It does not check that generation is skipped. A green oracle is not the brief, and it is not the full inference suite.

## Reference patches, not the contract

- The hand patch rejects a bare alias other than `qwen3-4b-q4km` and leaves refs that contain `/` on the old path. Inference Vitest was 27/27. It never reads the env var, so it does not implement the brief. It is not the specification.
- Aider 0.86.2 defaulted the env var to `qwen3-4b-q4km` and rejected every other `modelRef`. After a separate `tsc`, the qualification file was 8/8 and the inference package was 13 failed / 14 passed. The `runtime/` tests regressed.

## Contract used for the repair experiment

FAIL_TO_PASS is the frozen qualification file: export the error, rebuild `dist`, reject the three mismatched refs before `provider.chat`, and let `qwen3-4b-q4km` reach the provider.

PASS_TO_PASS is the existing inference tests, including every `runtime/` ref.

The brief's env-id-to-alias step remains unimplemented by both the tests and the oracle. A repair is not accepted on the oracle alone.
