# Sprint 5C — Non-Progress Detection & Recovery Evaluation (deterministic)

Real-model non-progress delta: **DEFERRED_TO_HALO**. The model is a deterministic local simulation. It behaves the same in both arms; a compact recovery context does not make it smarter. So these numbers measure the detector and the bounded recovery machinery, not how a real model responds to them. Thresholds are the shipped defaults (2 repeats, window 3), and they were not tuned per fixture.

A = progress monitor disabled (Sprint 5B behaviour) · B = enabled.

## Recorded changes after the first run

- The first run missed fixture E and caught A only through the 3-cycle window, not on the second identical failure. The cause was a product gap: the failure normalizer did not strip node:test's own TAP footer (`# duration_ms 12.345`), so identical failures got different fingerprints. The normalizer now strips duration fields, and unit test P-04b covers it. Thresholds were not changed.
- Fixture G had a fixture bug: its patch target `a + b` also matched `add()`, so the patch failed in both arms. G now uses a genuine one-character fix (`a - a` → `a - b`).

## Fixtures

- **A** (workflow, expected LOOP, LOGIC_FAILURE): genuine loop: the same failing test after every edit
- **B** (workflow, expected PROGRESS): slow progress: each repair removes one failing test
- **D** (workflow, expected LOOP, ENVIRONMENT_FAILURE): environmental blocker: the database endpoint is down
- **E** (workflow, expected LOOP, LOGIC_FAILURE): wrong hypothesis: the code changes but the exact failure remains, then a real fix
- **F** (workflow, expected LOOP, LOGIC_FAILURE): review loop: the same HIGH finding survives every repair
- **G** (workflow, expected PROGRESS): meaningful tiny fix: a one-character change fixes the test
- **C** (direct, expected PROGRESS): transient tool failure: one failed read, then success
- **H** (direct, expected LOOP, CONTEXT_DEGRADATION): direct A/B/A/B read cycle (invisible to a consecutive-repeat guard)
- **I** (direct, expected PROGRESS): direct productive investigation across three files

## Detection (arm B)

| Metric | Value |
| --- | --- |
| Known loops detected | 5/5 (100.0%) |
| False stalls on fixtures with measurable progress | 0/4 (0.0%) |
| Failure classification accuracy (detected loops) | 5/5 (100.0%) |
| Misses | none |

## Recovery (arm B)

| Metric | Value |
| --- | --- |
| Stalls detected | 5 |
| Stalls correctly classified | 5 |
| Diagnostic checks run | 5 |
| Recovery attempts | 4 |
| Recovered (state then demonstrably progressed) | 1 (25.0% of attempts) |
| Blocked after the bounded retry | 3 |
| Escalated without retry (environment/permission/state) | 1 |
| Unnecessary recoveries (on progress fixtures) | 0 (0.0%) |

## Efficiency (A vs B, all fixtures)

| Metric | A (off) | B (on) | Δ |
| --- | --- | --- | --- |
| Model calls | 68 | 55 | -13 |
| Tool + check calls | 60 | 47 | -13 |
| Prompt tokens (estimated) | 25001 | 21673 | -3328 |
| Average model turns before a blocker | 9.75 | 6.5 | -3.25 |

- Repeated model calls avoided: 13.
- Repeated tool/check calls avoided: 13.
- Diagnostic checks added: 5. They are deterministic and read-only; model calls added by diagnostics: 0.
- Net token difference (B − A): -3328.

## Per fixture

| Fixture | Path | Expected | Arm | Outcome | Stall | Signals | Class | Recovery | Recovery outcome | Model calls | Tool+check calls | Prompt tokens | Turns |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | workflow | LOOP | A | BLOCKED:TEST_REPAIR_LIMIT | no | - | - | no | - | 7 | 6 | 2627 | 7 |
| A | workflow | LOOP | B | BLOCKED:BLOCKED_NON_PROGRESS | yes | TEST_STAGNATION | LOGIC_FAILURE | yes | NOT_RECOVERED | 7 | 6 | 2975 | 7 |
| B | workflow | PROGRESS | A | COMPLETE | no | - | - | no | - | 8 | 8 | 3276 | 8 |
| B | workflow | PROGRESS | B | COMPLETE | no | - | - | no | - | 8 | 8 | 3276 | 8 |
| D | workflow | LOOP | A | BLOCKED:TEST_REPAIR_LIMIT | no | - | - | no | - | 7 | 6 | 2610 | 7 |
| D | workflow | LOOP | B | BLOCKED:BLOCKED_NON_PROGRESS | yes | TEST_STAGNATION | ENVIRONMENT_FAILURE | no | ESCALATED | 5 | 4 | 1782 | 5 |
| E | workflow | LOOP | A | COMPLETE | no | - | - | no | - | 8 | 8 | 3256 | 8 |
| E | workflow | LOOP | B | COMPLETE | yes | TEST_STAGNATION | LOGIC_FAILURE | yes | RECOVERED | 8 | 8 | 3604 | 8 |
| F | workflow | LOOP | A | BLOCKED:BLOCKED_REVIEW | no | - | - | no | - | 10 | 6 | 4454 | 10 |
| F | workflow | LOOP | B | BLOCKED:BLOCKED_NON_PROGRESS | yes | REVIEW_STAGNATION | LOGIC_FAILURE | yes | NOT_RECOVERED | 10 | 6 | 4706 | 10 |
| G | workflow | PROGRESS | A | COMPLETE | no | - | - | no | - | 6 | 6 | 2419 | 6 |
| G | workflow | PROGRESS | B | COMPLETE | no | - | - | no | - | 6 | 6 | 2419 | 6 |
| C | direct | PROGRESS | A | COMPLETED | no | - | - | no | - | 3 | 2 | 611 | 3 |
| C | direct | PROGRESS | B | COMPLETED | no | - | - | no | - | 3 | 2 | 611 | 3 |
| H | direct | LOOP | A | FAILED:MAX_TURNS_EXCEEDED | no | - | - | no | - | 15 | 15 | 4662 | 15 |
| H | direct | LOOP | B | FAILED:NON_PROGRESS | yes | REPEATED_TOOL_ACTION | CONTEXT_DEGRADATION | yes | NOT_RECOVERED | 4 | 4 | 1214 | 4 |
| I | direct | PROGRESS | A | COMPLETED | no | - | - | no | - | 4 | 3 | 1086 | 4 |
| I | direct | PROGRESS | B | COMPLETED | no | - | - | no | - | 4 | 3 | 1086 | 4 |
