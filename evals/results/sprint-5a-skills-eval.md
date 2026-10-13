# Sprint 5A — Skill Runtime Evaluation (deterministic)

Real-model skill delta: **DEFERRED_TO_HALO** (no HALO baseline recorded; no model executed).

## Selection

| Metric | Value |
| --- | --- |
| Cases | 40 |
| Correct | 38 (95.0%) |
| Positive cases correct | 21/22 |
| No-skill accuracy | 9/9 (100.0%) |
| False positives (skill selected where none was acceptable) | 1 |
| Wrong skill selected | 0 |
| False negatives (no skill where one was required) | 1 |

Misses:

- S03 (positive, DEBUG): selected `none`, acceptable `bug-triage`
- S34 (ambiguous, BUILD): selected `refactor-with-guards`, acceptable `bug-triage` / `none`

## Context efficiency

| Metric | Tokens |
| --- | --- |
| Seed skills | 5 |
| Eager baseline (all framed bodies) | 2530 |
| Metadata index | 128 |
| Average selected-skill body | 511.0 |
| Average lazy prompt cost per task | 332.1 |
| Average lazy cost incl. index | 460.1 |
| Tokens avoided per task | 2197.9 |
| Reduction | 86.9% |
| Reduction incl. index | 81.8% |

Per skill: `bug-triage` 559, `refactor-with-guards` 493, `security-review` 542, `tdd` 483, `verification` 453.

Token counts use the runtime estimator (`ceil(chars / 4)`), the same one the context budget enforces.
