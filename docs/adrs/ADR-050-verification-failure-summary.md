# ADR-050: Verification keeps the failure, not the toolchain noise

Status: Accepted for the repair runtime on `repair/30-automated-program-repair`. Not a release approval.

## Context

Isolated HALO qualification run `i1` (`qwen3.6:35b`, id `a7eb95c53bcf`) wrote `packages/inference/test/modelQualification.test.ts`, ran Vitest, and got 3 passed and 5 failed. The run then cancelled at the time budget. The revision the model actually received quoted a truncated `better-sqlite3` rebuild path. The assertion text was later in stdout than the 16KB prefix the engine kept.

A second, separate rule treated two identical failing runs with an edit between them as pre-existing, including when both runs happened after the task had already started editing. Run `i1` had only one verification, so that rule did not decide `i1`. It would have stopped a later repair of the same failure.

## Decision

1. Verification stdout and stderr keep the **tail** of the stream, still capped at 16KB, and still mark truncation. Reporters print failures last.
2. A failed run gets a compact summary parsed from that text: counts, failure groups, locations, and implicated files. The summary is the diagnosis the model sees first, and it is the text the runtime-eval revision quotes. The project's test command is not changed and no JSON reporter is injected. Vitest's JSON reporter was not used because the approved command is the project's own script.
3. A failure is pre-existing only when a failing verification ran **before** this task's first applied edit and the same tests still fail the same way. No such baseline means unknown provenance. Two identical failures after editing has started stay repairable. The same test title with a different assertion is not the same failure.
4. A failing verification still cannot be recorded as a verified completion.

Symbol diagnosis for unresolved imports is unchanged and is appended after the summary.

## Consequences

The scripted control (a known patch after a real failing `node` test) completes once. A claim of success after a failing test does not. Real-model repair of the HALO fixture was not re-run in this change. Candidate-patch search, Aider, and Qwen Code were not started: the measured defect was the missing failure text, and that comparison waits on one native replay that can see the summary.
