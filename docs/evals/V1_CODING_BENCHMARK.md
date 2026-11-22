# V1 coding benchmark

Date: 2026-11-09. Status: **NOT EXECUTED** as a head-to-head run.

## Model under test

Local Ollama, queried on this machine:

| Tag | Identity observed |
| --- | --- |
| `qwen3-coder:30b` | Family `qwen3moe`, 30.5B, `Q4_K_M`. Context length 262144. Manifest digest prefix `06c1097efce0431c204`. Weight blob `sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a`. |
| `qwen2.5-coder:7b` | Present. Not used for a new coding run in this session. |

Endpoint: `http://127.0.0.1:11434`. The chat template reported by `ollama show` is `{{ .Prompt }}`. Sampler lines in the modelfile: temperature 0.7, top_k 20, top_p 0.8, repeat_penalty 1.05.

## Comparison that was not run

OpenCode was not installed (`opencode` and `bun` are absent). Its installer was not executed. Cline and Kilo were not launched. No disposable fixture was given to more than one harness.

Because of that, this document does not claim that Open VS Code is faster, safer, or more accurate than OpenCode.

## What was verified instead

Protocol handling for the local model's wire format, without a live generation:

- 25 tests in `packages/agent-core/tests/model/protocol.test.ts` passed.
- Unfinished `<tool_call>` / `<function=name>` envelopes are removed from the answer.
- A sentence that only quotes `</function>` or `<parameter=` is kept.
- `<think>` reasoning is removed from the user-visible answer and is not copied into the error text. A fenced example of the tag is kept.

Those tests do not measure task success. They measure the harness behavior that previously leaked protocol into the transcript.

## Planned task set

When a comparison is run, use one digest, one endpoint, one context budget, and disposable repositories. Grade the worktree and the test command, not the model's last sentence.

1. Explain a repository.
2. Answer a follow-up that depends on that explanation.
3. Fix a single-file bug.
4. Fix a bug that spans two files.
5. Add a small feature.
6. Refactor without changing behavior.
7. Add a test for existing behavior.
8. Diagnose a failing test.
9. Report an unavailable tool without inventing a result.
10. Recover after a rejected edit.
11. Refuse an action the policy denies.
12. Say that verification failed when the test command failed.

Held-out tasks stay unused until this set has been run once. The release target of 90% is not a result. There is no percentage to report.

## Architectural decision

No runtime replacement. OpenCode's native tool messages and retry classification are the mechanisms to compare first, using the task set above. A framework swap is not justified by the unread source alone.
