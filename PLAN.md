# Sprint 1J Plan — Deterministic Autonomous Repair Loop

## Current milestone

Sprint 1J — Connect investigation, mutation, and verification into a bounded repair lifecycle with human approval gates.

## Objective

Deliver a closed-loop repair orchestrator that investigates verification failures, synthesizes repairs, prepares them for exact approval, applies them, and re-verifies them—strictly constrained by mutation budgets, agent turn budgets, and user approval workflows.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-190 | Repair workflow contract | Sprint 1I | Define RepairResult and RepairStatus interfaces tracking loops, turns, and failures. | Complete |
| T-191 | Deterministic verification output | Sprint 1I | Map raw execute results -> unified FailureClassification type. | Complete |
| T-192 | Failure -> Investigation prompts | T-191 | Compile categorized verification failures into investigation contexts. | Complete |
| T-193 | `RepairOrchestrator` state machine | T-190..192 | Implement `BoundedRepairLifecycle` (run/resume) preventing infinite loops. | Complete |
| T-194 | Verify repair bounded loop | T-193 | Verify the single workflow boundary. Reject any internal auto-approval behaviors. | Complete |
| T-195 | Exact mutation integration | T-194 | Require `ReviewableExecution` (prepared diff/verification) to be bubbled to caller. | Complete |
| T-196 | Scripted repair infrastructure | Sprint 1I | End-to-end `repair-workflow.test.ts` testing timeouts, bounds, and rejections. | Complete |
| T-197 | Documentation truth cleanup | T-196 | Update PLAN.md, SCRATCHPAD.md, ARCHITECTURE.md with repair loop constraints. | Complete |
| T-227 | Real total-agent-turn accounting | T-193 | Enforce `maxTotalAgentTurns` globally across all attempts. | Complete |
| T-229 | Correct mutation accounting | T-193 | Increment `mutationsApplied` only if mutation actually applies. | Complete |
| T-230 | Applied-result provenance | T-193 | Record preparedMutation metadata upon successful mutation. | Complete |
| T-231..238 | Real-Component E2E Tests | T-196 | Deterministic tests for repair loop with real ToolRegistry/MutationEngine. | Complete |
| T-239 | Verification-run accounting | T-193 | Count actual runs (distinguish verificationsPrepared/Approved from actual Runs). | Complete |
| T-240..243 | Documentation cleanup | T-239 | Update PLAN.md, ADRs, and repo docs. | Complete |

## Next sprint

Sprint 1K — Terminal/Command Capabilities and Sandboxing.
