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
| Seed skills | 13 |
| Eager baseline (all framed bodies) | 8026 |
| Metadata index | 394 |
| Average selected-skill body | 511.0 |
| Average lazy prompt cost per task | 332.1 |
| Average lazy cost incl. index | 726.1 |
| Tokens avoided per task | 7693.9 |
| Reduction | 95.9% |
| Reduction incl. index | 91.0% |

Per skill: `accessibility-review` 709, `bug-triage` 559, `design-direction` 720, `design-polish` 727, `design-system-engineering` 704, `frontend-composition` 649, `motion-engineering` 702, `refactor-with-guards` 493, `security-review` 542, `tdd` 483, `ux-information-architecture` 619, `verification` 453, `visual-qa` 666.

Token counts use the runtime estimator (`ceil(chars / 4)`), the same one the context budget enforces.
