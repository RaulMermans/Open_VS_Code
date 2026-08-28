# ADR 012: Bounded Autonomous Repair Loops

## Status
Accepted

## Context
When AI agents apply code mutations (ADR 011), they must verify those mutations using tests, linters, or typecheckers to ensure correctness. If verification fails, the agent should attempt to repair the code. However, without strict constraints, autonomous repair can lead to:
- Infinite loops of failing tests and hallucinated fixes.
- Unauthorized execution of arbitrary verification commands.
- Budget exhaustion (token limits, turn limits).
- Bypassing the user's permission gate (auto-approving mutations to fix tests).

We need a framework to safely execute verification and orchestrated repair without violating the single, human-gated approval system.

## Decision
We will implement a `BoundedRepairLifecycle` orchestrated by a strict state machine (`RepairOrchestrator`).

1. **Narrow Verification Scripts**: We will restrict verification to explicitly discovered scripts (e.g., `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`). The exact command, `package.json` hash, and working directory are frozen into a `PreparedVerification` object. Arbitrary terminal commands are denied.
2. **Deterministic Evaluation**: Verification outputs (STDOUT/STDERR) are bounded to prevent context overflow and passed to a deterministic `FailureClassification` engine to map specific failure signatures into targeted repair prompts.
3. **Budget Enforcement**: The repair loop is constrained by four strict budgets: `maxRepairAttempts`, `maxMutations`, `maxVerificationRuns`, and `maxTotalAgentTurns`. Exceeding any budget immediately terminates the orchestrator with an explicit failure status.
4. **Non-Progress Detection**: Re-encountering an exact previously seen failure signature terminates the loop early (`REPAIR_NON_PROGRESS`).
5. **No Internal Auto-Approval**: The orchestrator must never auto-approve its own mutations. When the inner agent generates a `PreparedMutation` or `PreparedVerification`, the orchestrator transitions to `AWAITING_MUTATION_APPROVAL` or `AWAITING_VERIFICATION_APPROVAL`, bubbling the exact `ReviewableExecution` payload up to the caller (user). The orchestrator only proceeds when explicitly `resume("APPROVE")` is called.

## Consequences
- **Positive**: Strict user control is preserved. Agents cannot autonomously rewrite the repository in the background. Token and time budgets are rigidly enforced, preventing runaways. Verification attacks (altering the test script before execution) are blocked by snapshot hashing.
- **Negative**: The user must explicitly approve both the mutation and the subsequent verification run, which requires multiple interactions per repair attempt. (UI/UX optimizations can batch these approvals later, provided the explicit permission contract remains intact).
