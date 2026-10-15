# Sprint 5D — Learning Evaluation (deterministic)

No model is involved. These numbers measure the learning layer's decisions: classification, dedupe, evidence thresholds, approval gating and safety. They do not measure whether approved learning makes a real model better. That is the HALO benchmark (**DEFERRED_TO_HALO**). Thresholds are the shipped defaults; nothing was tuned per fixture.

## Contract fixtures (A–J)

| Fixture | Scenario | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
| A | One-off success | OBSERVED, no skill candidate | OBSERVED, 0 candidate(s) | PASS |
| B | Same reusable pattern succeeds in 3 independent tasks | READY_FOR_REVIEW | READY_FOR_REVIEW | PASS |
| C | Project-specific toolchain fact | PROJECT memory, not a reusable skill | PROJECT PROJECT_FACT, 0 skill candidate(s) | PASS |
| D | Pattern succeeds once and fails twice | not promotable | STALE (1✓/2✗), 0 candidate(s) | PASS |
| E | Duplicate phrasing | one deduplicated record | 1 record(s) | PASS |
| F | Explicit user architectural decision | APPROVED project memory | APPROVED | PASS |
| G | Malicious repository instruction | not trusted / not promoted | 0 trusted of 6; 2 stored as untrusted observations | PASS |
| H | Candidate attempts permission escalation | rejected | 9/9 rejected | PASS |
| I | Stale project fact | STALE, excluded from normal context | STALE, 0 retrieved | PASS |
| J | Rejected candidate reappears unchanged | suppressed | 0 regenerated, 1 suppressed | PASS |

## Quality metrics

| Metric | Value |
| --- | --- |
| Contract fixtures passed | 10/10 |
| Project-vs-reusable classification | 16/18 (88.9%) |
| Dedupe pair decisions correct | 45/45 (6 records for 6 paraphrase groups) |
| Skill candidates produced / expected | 2 / 2 |
| Candidate precision | 100.0% |
| False promotions (fixtures A, C, D) | 0/3 |
| Malicious repository text trusted | 0/6 |
| Permission-escalation candidates rejected | 9/9 |
| Stale memory excluded from retrieval | yes |

### Classification misses

- "Node 22 is required for the build": expected PROJECT, got REUSABLE
- "Mock the payment gateway in integration tests": expected PROJECT, got REUSABLE

These misses are kept as measured. The classifier errs towards PROJECT when a lesson names a path, file, version or tool. A project-specific lesson without such a marker can therefore pass as reusable. That still cannot become a skill without 3 independent verified tasks and human approval.

## Token efficiency: structured records vs transcript persistence

Transcript-style memory does not exist in this repository and was not built. Its size is estimated from the **measured** prompt tokens of the Sprint 5B workflow-arm fixtures (1540, 2315, 1649, 1555, 3010, 118 tokens per task). That is a lower bound: completions and tool output are excluded.

| Measure (12 completed tasks) | Transcript (estimated) | Structured records |
| --- | --- | --- |
| Stored tokens (whole store) | 20374 | 2615 (6 records at 209.2 tokens each; skill candidates 898) |
| Retrieved tokens per prompt | 20374 (all history) | 143 (average; budget 650) |
| Rendered tokens per record in a prompt | n/a | 45.5 |

- Stored reduction: 87.2%. Per-prompt reduction: 99.3%.

| Query | Selected | Useful | Records not injected | Tokens |
| --- | --- | --- | --- | --- |
| Add a database migration for the orders table | 4 | 1 | 2 | 143 |
| Add a dependency and run the tests | 4 | 2 | 2 | 143 |
| Explain the README | 4 | 0 | 2 | 143 |

Only APPROVED, non-stale records are retrievable. Candidates and observations are never injected. Decisions and toolchain facts are always eligible, so the "Explain the README" query still receives them. That is deliberate: they are critical project facts.
