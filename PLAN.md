# Sprint 1J Plan — Deterministic Autonomous Repair Loop

## Current milestone

Sprint 2A — Project Memory & Session Continuity architecture.

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

Sprint 1K — Coding-Agent Evaluation        COMPLETE

## Sprint 1K: Canonical Deterministic Agent Evaluation [COMPLETED]

**Objective:** Build the canonical coding-agent evaluation system for the complete deterministic workflow so we can measure correctness, multi-file editing, test-driven repair, failure recovery, and safety boundaries prior to connecting open-weight models.

**Key Deliverables:**
- [x] Evaluation Schema: Define `CodingEvalCase` with tasks, budgets, test actions, and expected verification behaviors.
- [x] Evaluation Runner: Implement isolated `tmp` workspace creation, `AgentRunner` mocking, and automated assertion of `expectedBehavior`.
- [x] Test Fixtures: Curate 5 distinct cases (Single-file, Multi-file, Repair, Recovery, Safety) against `cli-tool-repo` and `mini-express-app`.
- [x] Full Verification: Run E2E suite natively validating 100% success on task and safety boundaries.

## Sprint 1K.1: Evaluation Corpus Expansion & Metric Integrity [COMPLETED]

**Objective:** Expand evaluation corpus to ~30 cases covering diverse scenarios and properly wire scoreboard metrics to authoritative runtime events.

**Key Deliverables:**
- [x] Extract usage metrics directly from `AgentResult.events`.
- [x] Expand `CODING_EVAL_CASES` to 30 deterministic scenarios covering bugs, type repair, features, safety.
- [x] Prove repeatability of 30 cases (100% success rate on task/safety).
- [x] Produce canonical baseline artifact.


## Sprint 1L: First Usable CLI Product [COMPLETED]

**Objective:** Turn the proven agent core into the first usable product interface with interactive headless approval loops.

**Key Deliverables:**
- [x] Create `@open-vs-code/cli` package layer.
- [x] Implement ASK, PLAN, BUILD, DEBUG, REVIEW commands.
- [x] Map event loop to simple rendering (no rich UI yet).
- [x] Support terminal prompt verification (y/N).
- [x] E2E automated test proving CLI behavior.


## Sprint 2A: Project Memory & Session Continuity [COMPLETED]

**Objective:** Prove that project/session memory remains authoritative, bounded, fresh, relevant, corruption-safe, truthful, path-safe, and token-efficient across separate CLI sessions—without loading the whole Markdown corpus or session history.

**Key Deliverables:**
- [x] ProjectMemorySnapshot: targeted markdown loading.
- [x] SessionSummary: bounded session tracking across executions.
- [x] MemorySelection & Retriever: Token-budgeted, deduplicated fact selection.
- [x] SessionStorage: Atomic writes and secret redaction.
- [x] ContextCompiler: Integrating memory bounds.
- [x] CLI session persistence and cross-session continuity.
- [x] Deterministic validation: E2E and 30/30 deterministic coding evaluation.

## Sprint 2B: Skills & Prompt Primitives (Next)

**Objective:** Formalize skill acquisition, capability discovery, and typed prompt templates for the agent.
