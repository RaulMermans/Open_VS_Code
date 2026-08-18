# Sprint 1 Plan

## Current milestone

Sprint 1 - Reuse-first baseline.

## Objective

Establish a clean canonical repository based on proven open-source AI coding infrastructure, with architecture and operating rules documented and no accidental legacy or cloud baggage.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-001 | Project control files | - | Required control files and directories exist; Git is initialized. | Complete |
| T-002 | Reusable skills | T-001 | `repo-intake`, `upstream-audit`, and `change-with-tests` have focused `SKILL.md` files. | Complete |
| T-003 | Kilo repository audit | T-002 | Current revision is inspected outside canonical code; major areas are classified with exact source paths. | Complete |
| T-004 | Secondary-reference audit | T-003 | Only gaps relevant to the baseline decision are investigated and recorded with evidence. | Complete |
| T-005 | Reuse architecture decision | T-003, T-004 | Options A-D are evaluated across maintainability, local-first fit, modularity, licensing, and upstream burden; one is recommended. | Complete: controlled Kilo fork |
| T-006 | Canonical baseline import/fork | T-005 | Chosen baseline is imported with provenance and license obligations preserved. | Ready; not started |
| T-007 | Upstream smoke verification | T-006 | Documented upstream install/build/test smoke checks pass or failures are recorded. | Blocked by T-006 |
| T-008 | Isolate unwanted cloud coupling | T-007 | Cloud/account/telemetry surfaces are inventoried and isolated with tests, without broad rewrites. | Blocked by T-007 |
| T-009 | Known-good checkpoint | T-008 | Tests pass, intentional changes are documented, and a reviewable Git checkpoint exists. | Blocked by T-008 |

T-006 onward must not start until T-005 is supported by the audits.
