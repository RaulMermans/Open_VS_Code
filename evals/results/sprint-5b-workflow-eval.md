# Sprint 5B — Structured Engineering Loop Evaluation (deterministic)

Real-model workflow delta: **DEFERRED_TO_HALO**. The model here is a deterministic local simulation that plays a fallible implementer and a scripted reviewer; TEST/VERIFY run each fixture's real `npm test` checker through VerificationEngine. Approvals are granted by the harness.

## Recorded fixture changes (made after the first run)

- E13 exposed a product bug, not a fixture problem: `do not modify behaviour` was classified read-only. The eligibility pattern now requires a file/code object.
- T4: the workspace gained `tests/.gitkeep`; MutationEngine (unchanged) refuses `create_file` under a missing parent directory.
- T5: the ground-truth checker wrongly rejected the intended fix (it contains `return true` for reader+list); it now checks reader+list is allowed and the admin check is kept.
- Direct arm: the simulated implementer ignored failing-verification feedback; it now applies its next attempt after a failure, mirroring the workflow's repair pass. Its defect detection is measured from `verification.completed` FAIL events.

## Eligibility

14/14 correct.

| Case | Expected | Eligible | Reason |
| --- | --- | --- | --- |
| E01 | true | true | ELIGIBLE |
| E02 | true | true | ELIGIBLE |
| E03 | true | true | ELIGIBLE |
| E04 | true | true | ELIGIBLE |
| E05 | true | true | ELIGIBLE |
| E06 | false | false | READ_ONLY_REQUEST |
| E07 | false | false | MODE_NOT_MUTATING |
| E08 | false | false | MODE_NOT_MUTATING |
| E09 | false | false | MODE_NOT_MUTATING |
| E10 | false | false | READ_ONLY_REQUEST |
| E11 | false | false | READ_ONLY_REQUEST |
| E12 | false | false | UNTRUSTED_WORKSPACE |
| E13 | true | true | ELIGIBLE |
| E14 | false | false | READ_ONLY_REQUEST |

## Direct vs structured (mutating tasks)

| Arm | Correct | Verified | Defects caught | Model calls | Prompt tokens | Peak context | Repair cycles | Approvals | Latency ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A direct (workflow off) | 4/5 | 5/5 | 1/2 | 17 | 5206 | 470 | 1 | 12 | 947 |
| B structured (workflow on) | 5/5 | 5/5 | 2/2 | 25 | 10069 | 642 | 2 | 19 | 1684 |

| Fixture | Kind | Arm | Outcome | Correct | Verification runs | Defect caught | Model calls | Prompt tokens | Peak context | Repairs | Approvals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | feature | direct | COMPLETED | yes | 1 | - | 3 | 781 | 288 | 0 | 2 |
| T1 | feature | workflow | COMPLETE | yes | 2 | - | 4 | 1540 | 606 | 0 | 3 |
| T2 | bugfix | direct | COMPLETED | yes | 2 | yes | 5 | 2061 | 470 | 1 | 4 |
| T2 | bugfix | workflow | COMPLETE | yes | 3 | yes | 6 | 2315 | 599 | 1 | 5 |
| T3 | refactor | direct | COMPLETED | yes | 1 | - | 3 | 808 | 300 | 0 | 2 |
| T3 | refactor | workflow | COMPLETE | yes | 2 | - | 4 | 1649 | 642 | 0 | 3 |
| T4 | test-addition | direct | COMPLETED | yes | 1 | - | 3 | 794 | 286 | 0 | 2 |
| T4 | test-addition | workflow | COMPLETE | yes | 2 | - | 4 | 1555 | 604 | 0 | 3 |
| T5 | security | direct | COMPLETED | no | 1 | - | 3 | 762 | 280 | 0 | 2 |
| T5 | security | workflow | COMPLETE | yes | 3 | yes | 7 | 3010 | 625 | 1 | 5 |
| T6 | read-only | direct | COMPLETED | yes | 0 | - | 1 | 118 | 110 | 0 | 0 |
| T6 | read-only | workflow | BYPASS:READ_ONLY_REQUEST | yes | 0 | - | 1 | 118 | 110 | 0 | 0 |

## Stage context (structured arm, peak estimated tokens per stage)

| Fixture | PLAN | IMPLEMENT | TEST | REVIEW | VERIFY | Structured peak | Monolithic estimate (lower bound) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | 230 | 395 | 0 | 606 | 0 | 606 | 1231 |
| T2 | 234 | 427 | 0 | 599 | 0 | 599 | 1647 |
| T3 | 239 | 432 | 0 | 642 | 0 | 642 | 1313 |
| T4 | 233 | 394 | 0 | 604 | 0 | 604 | 1231 |
| T5 | 217 | 479 | 0 | 625 | 0 | 625 | 2322 |

## Reviewer bias (pipeline, scripted reviewer)

True-positive rate 100.0% · false-positive rate 33.3% · severity correctness 80.0%

| Case | Description | Real defect | Blocked | Kept | Dropped ungrounded | Severity | Expected | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | Correct implementation; reviewer emits generic ungrounded advice | false | false | 0 | 1 | none | none | COMPLETE |
| B | Diff introduces a clear regression (subtract returns b - a) | true | true | 1 | 0 | blocking | blocking | COMPLETE |
| C | Tests pass but the authorization boundary is removed | true | true | 1 | 0 | blocking | blocking | COMPLETE |
| D | Harmless stylistic oddity reported at LOW | false | false | 1 | 0 | non-blocking | non-blocking | COMPLETE |
| D-inflated | Same stylistic oddity, reviewer inflates it to BLOCKER (pipeline probe) | false | true | 1 | 0 | blocking | non-blocking | COMPLETE |
