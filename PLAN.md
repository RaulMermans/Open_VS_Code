# Sprint 1I Plan — Controlled Verification Runtime

## Current milestone

Sprint 1I — Implement a safe, bounded verification engine (Phase B) and resolve the prepared-diff approval mutation loop (Phase A).

## Objective

Make investigation disciplined, tool selection targeted, turn allocation smarter, and premature answers impossible—improving local open-weight model performance through evidence-driven orchestration while maintaining strict scope boundaries and repository hygiene.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-154 | Exact verification script freeze | Sprint 1H | Store packageJsonPath, packageJsonHash, scriptName, scriptBody in PreparedVerification. | Complete |
| T-155 | Stale verification protection | T-154 | Re-read package.json hash in engine. Halts with STALE_VERIFICATION if modified. | Complete |
| T-156 | Exact approval binding | T-154 | Bind execution approval structurally to unique verification ID tracking. | Complete |
| T-157 | Correct workspace containment | Sprint 1H | Use canonical path-containment helper for execution cwd validation. | Complete |
| T-158 | Process-tree termination | Sprint 1H | Implement cross-platform process tree termination (SIGKILL group / taskkill) on timeout/cancel. | Complete |
| T-159 | Environment policy review | Sprint 1H | Ensure only essential env (PATH, NODE_ENV, npm_config_*) are preserved during spawn. | Complete |
| T-160 | Phase A Verification Tests | T-154..159 | Add deterministic test coverage for all new verification constraints. | Complete |
| T-161 | Documentation truth cleanup | T-160 | Update PLAN.md, SCRATCHPAD.md, ARCHITECTURE.md, README.md and canonical Node 22+ policy. | Complete |

## Next sprint

Sprint 1J — Deterministic Autonomous Repair Loop: Connect investigation, mutation, and verification into a bounded repair lifecycle with human approval gates. Includes building the repair workflow contract, budgets, failure classification, failure->investigation mapping, and running scripted deterministic benchmarks.
