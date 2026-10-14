# ADR-030: Structured Engineering Loop & Fresh-Context Review

## Status
Accepted (Sprint 5B). Feature-flagged **off** by default (`workflow.enabled`) until the HALO same-model A/B benchmark is recorded. Guide: [`docs/workflows/ENGINEERING_LOOP.md`](../workflows/ENGINEERING_LOOP.md).

## Context
The V1 agent runs a mutating task as one `AgentRunner` session. Small local models degrade as that session accumulates context: planning chatter, failed hypotheses, tool output, and the model's own justifications all stay in the window. The same session that wrote a patch is also the only one that judges it, so it inherits its own blind spots.

ECC (`affaan-m/ECC`, MIT) uses many specialised agents, including a reviewer with a strict "pre-report gate". We adopt two of its review principles: findings must cite exact evidence, and zero findings is a valid result. We do not adopt its multi-agent scale or Claude-specific orchestration. Classification: **REFERENCE_ONLY**; no code or text was copied.

## Decision
1. **One sequential orchestrator, not agents.** `EngineeringWorkflow` (`packages/agent-core/src/workflow/`) runs PLAN → IMPLEMENT → TEST → REVIEW → VERIFY → COMPLETE over the existing `AgentRunner`, PermissionGate (`classifyPermission`), `VerificationEngine`, skills runtime and `CheckpointStore`. Any stage may end BLOCKED or CANCELLED. There are no planner, implementer or reviewer services, no DAG, no parallelism and no worktrees.
2. **Eligibility.** The workflow runs only when the flag is on, the mode is BUILD or DEBUG, the workspace is trusted, and the instruction is not read-only. Everything else uses the unchanged direct path.
3. **A fresh session per model stage.** PLAN, IMPLEMENT and REVIEW each get a new `AgentRunner` session. Its instruction is rebuilt from persisted, bounded artifacts. No stage receives `recentTurns`, another stage's transcript, observations or reasoning.
4. **Capability envelopes narrow; the gate decides.**
   - `ToolRegistry.restrict` hides tools outside the stage envelope.
   - `stagePermission` returns DENY outside the envelope, and otherwise exactly the base gate's answer for the stage mode (PLAN → `PLAN`, REVIEW → `REVIEW`, others → `BUILD`).
   - Writes and checks still pause for confirmation. Being in a stage never counts as approval.
5. **Deterministic TEST and VERIFY.**
   - Both run only repository-defined commands, through `discoverVerificationCommand` + `VerificationEngine`, behind the `WorkflowVerifier` port. The workflow core contains no `npm`.
   - VERIFY also checks diff integrity: current hashes must equal the reviewed `afterHash`.
   - COMPLETE requires `READY`. VERIFY never mutates.
6. **Fresh-context review.** REVIEW's envelope is an explicit allow-list:
   - task;
   - acceptance criteria;
   - plan;
   - changed files;
   - bounded diff;
   - test evidence;
   - constraints.

   Findings must name a changed file and quote evidence found verbatim in the diff or in that file. Ungrounded findings are dropped and counted. `NO_FINDINGS` is valid.
7. **Bounded repair.**
   - Failed tests get at most 2 IMPLEMENT repairs.
   - BLOCKER/HIGH findings get at most 2 IMPLEMENT → TEST → fresh REVIEW cycles. After that the result is `BLOCKED_REVIEW`.
   - A stage re-runs at most once after an invalid artifact or a model failure.
   - MEDIUM, LOW and NOTE findings do not block.
8. **Verification ownership.** IMPLEMENT sessions carry `task.metadata.verificationOwner = "workflow"`, so the runner's post-mutation "verification required" rule defers to the mandatory TEST and VERIFY stages. The direct path is unchanged.
9. **Persistence reuses recovery.** State is stored as `WORKFLOW_STAGE` checkpoints, which are the existing atomic, checksummed records with an optional bounded `workflow` field. Restore never re-runs completed stages and never treats an unanswered confirmation as approved.
10. **Evidence truth.**
    - There is one `StageRecord` per executed attempt, holding model calls, peak context tokens, tools used, and skill selected/injected (from the final compiled context).
    - Nothing is synthesised for stages that did not run.
    - No prompts, transcripts, reasoning, full file contents or secrets are stored. `<think>`-style blocks are stripped.
11. **Feature flag.** `CreateAgentRuntimeOptions.workflow.enabled` (CLI `--workflow` / `OPEN_VS_CODE_WORKFLOW=1`, VS Code `open-vs-code.workflow.enabled`), default `false`.

## Consequences
- The workflow costs more calls and approvals. On the deterministic simulation it used 25 model calls against 17 for the direct path, about 1.9× the prompt tokens, and 19 approvals against 12. In exchange, on those fixtures, it caught both injected defects (one through TEST, one through REVIEW, where the tests passed but the authorization boundary was removed) and was correct on 5/5 tasks against 4/5. These are simulation results; the real-model delta is **DEFERRED_TO_HALO**.
- A stage's peak context is larger than a tiny direct task's, because each stage envelope carries the plan, criteria and diff. It is much smaller than one window holding every stage at once. The point is to keep irrelevant history out, not to minimise every request.
- Grounding cannot detect severity inflation. A verbatim-quoted style nit labelled BLOCKER still blocks (eval probe "D-inflated") and costs one repair cycle. Real reviewer calibration is measured on HALO.
- Skills whose `required_tools` include `run_verification` (`tdd`, `refactor-with-guards`, `verification`) are not selectable inside the IMPLEMENT or REVIEW envelopes. TEST and VERIFY cover their verification structurally.
- A pending runner confirmation does not survive a restart: that stage restarts with a fresh session, and the user is asked again.
- Out of scope, by design: non-progress detection and replanning (Sprint 5C), learning from findings (5D), and multi-agent, parallel, PR, worktree or cloud orchestration.
