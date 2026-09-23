# ADR-024 — Runtime Evaluations & Adaptive Control

**Status:** ACCEPTED  
**Sprint:** 4B — Runtime Evals & Adaptive Control  
**Date:** 2026-09-23

---

## Context

Previous sprints built the foundations of the local coding agent:
- Project Memory and skill selection (Sprint 2A, 2B)
- Safe tool registries and MCP runtime (Sprint 2C)
- Deterministic model routing without cloud leaks (Sprint 2D)
- Multi-mode UX: Chat, Diff/Edit, Controlled Terminal, Autocomplete (Sprint 3A-3E)
- System-wide security hardening and trust boundaries (Sprint 4A)

Prior to Sprint 4B, the execution loop was largely open-loop: an agent received a prompt, invoked tools, received tool observations, and continued until the model generated a text completion or hit turn limits. If a tool failed repeatedly, a verification command failed unnoticed, or code was mutated without subsequent test execution, the runner lacked an autonomous evaluation and adaptive steer mechanism.

Sprint 4B implements a continuous closed-loop runtime evaluation architecture:
`ACT -> OBSERVE -> EVALUATE -> DECIDE -> ADAPT -> ACT AGAIN`

Crucially, as established in ADR-023 §10, **Runtime evaluations must never possess execution or mutation authority.**

---

## Decision

### 1. Core Invariant: Non-Authoritative Evaluation

Runtime evaluations are strictly **advisory and diagnostic**.

| Action Type | Runtime Eval Authority | Canonical Enforcer |
|---|---|---|
| Mutate files | ❌ Forbidden (Cannot mutate or approve) | `MutationEngine` + Human Confirmation |
| Execute processes | ❌ Forbidden (Cannot run shell/commands) | `VerificationEngine` + Human Confirmation |
| Bypass permissions | ❌ Forbidden (Cannot elevate or bypass) | `classifyPermission` / Security Boundary |
| Skip security gates | ❌ Forbidden (Cannot override DENY) | `AgentRunner` + Security Boundary |
| Recommend revision / replan | ✅ Permitted (Advisory observation) | `AgentRunner` turn injection |
| Schedule verification | ✅ Permitted (Prepares verification) | Gated by `run_known_test` permission policy |
| Stop runaway execution | ✅ Permitted (Signals non-progress stop) | `AgentRunner` abort / non-progress exit |
| Request human escalation | ✅ Permitted (Pauses for human) | `AgentRunner` confirmation pause |

An evaluation score of `1.0` or a decision of `"CONTINUE"` creates **zero security permissions**. A decision of `"REVISE"` or `"STOP"` provides corrective steering observations to the agent loop but cannot perform mutations or execute unauthorized code.

### 2. Multi-Level Evaluation Hierarchy

To maintain token discipline, zero cloud cost, and deterministic execution speed, evaluations follow a tiered hierarchy:

```
+-------------------------------------------------------------+
| Level 0 (L0): Deterministic Rule-Based Evaluator            |
| - Zero inference tokens, 100% deterministic, < 1ms latency  |
| - Validates verification status, tool outcomes, cycle checks |
+-------------------------------------------------------------+
                              | (If L0 passes or needs heuristic check)
                              v
+-------------------------------------------------------------+
| Level 1 (L1): Heuristic State & Trajectory Evaluator        |
| - Fast heuristic analysis of progress, efficiency, signals  |
| - Loop detection via signature history, action cycles       |
+-------------------------------------------------------------+
                              | (Only if repeated defect >= 2 or ambiguous)
                              v
+-------------------------------------------------------------+
| Level 2 (L2): Selective Runtime Critic                      |
| - Local open-weight critic model (or ScriptedRuntimeCritic) |
| - Bounded prompt context, strict schema validation          |
| - Timeout racing: falls back to L1 if budget/time exceeded  |
+-------------------------------------------------------------+
```

1. **L0 Deterministic Evaluator**: Evaluates deterministic conditions such as:
   - Verification failures following code mutations (`COMPLETION_BLOCKED_BY_TEST_FAILURE`)
   - Unverified code modifications (`UNVERIFIED_CODE_MODIFICATION`)
   - Clean verified completions (`VERIFIED_COMPLETION`)
   - Read-only task completions (`READ_ONLY_COMPLETION`)
2. **L1 Heuristic Evaluator**: Evaluates weighted trajectory scores:
   - Progress, completion confidence, verification coverage, plan adherence, execution efficiency, logical consistency, safety authority.
   - Action loop detection using deterministic action signature history (`ACTION_CYCLE_DETECTED`).
3. **L2 Selective Critic**: Escalated only when necessary (e.g. repeated failures >= 2, or ambiguous progress). Racially bounded by `criticTimeoutMs` (default 5000ms), falling back safely to L1 heuristic results upon timeout.

### 3. Checkpoints & Lifecycle Hooks

Evaluations are triggered at 4 explicit checkpoints in `AgentRunner`:
- `MUTATION_RESULT`: Immediately following a successful mutation apply.
- `TOOL_FAILURE`: When a tool call is rejected, denied by security, or encounters a runtime error.
- `VERIFICATION_RESULT`: Following execution of test, typecheck, or lint verifications.
- `BEFORE_COMPLETION`: When the model indicates task completion with a final answer, prior to finalizing.

### 4. Adaptive Control Directives

`AdaptiveControlPolicy` maps evaluation results and evidence state into actionable directives across 8 distinct decisions:

| Decision | Primary Directive Action | Description |
|---|---|---|
| `CONTINUE` | `CONTINUE` | No intervention needed; proceed with normal execution. |
| `VERIFY` | `SCHEDULE_VERIFICATION` | Prepares a test verification before allowing completion. |
| `REVISE` | `INJECT_REVISION` | Injects a targeted revision observation with defect context. |
| `REPLAN` | `TRIGGER_REPLAN` | Injects a replan observation prompting a pivot in strategy. |
| `STOP` | `TERMINATE_RUN` | Halts execution cleanly with `NON_PROGRESS`. |
| `ASK_HUMAN` | `PAUSE_HUMAN` | Pauses runner with `WAITING_FOR_CONFIRMATION` for user guidance. |
| `CHANGE_MODEL` | `RECOMMEND_MODEL` / `CHANGE_MODEL` | Injects narrow `ModelRouteHint` (`avoidDeploymentId`, `preferredCapabilities`, `preferredDeploymentId`, `reasonCode`) with bounded 1-turn lifetime into `ModelRouter` without direct provider reconstruction or cloud fallback. |
| `REQUEST_MORE_CONTEXT` | `REQUEST_MORE_CONTEXT` | Injects targeted context inquiry observation, updates evidence collector with incremented `evidenceVersion`, runs explicit re-evaluation, consumes second directive, and caps loops at `MAX_CONSECUTIVE_CONTEXT_REQUESTS = 2`. |

### 5. Universal Post-Verification Causality

All execution paths scheduling verification (whether originating at `BEFORE_COMPLETION`, `MUTATION_RESULT`, or via generic adaptive directive) adhere to strict post-verification causality:
1. The prepared verification is dispatched via `VerificationEngine`.
2. The verification outcome immediately triggers a mandatory `VERIFICATION_RESULT` checkpoint evaluation.
3. The evaluation outcome is recorded in the `RuntimeEvalLedger` and linked to the originating intervention ID.
4. The post-verification directive (`REVISE`, `REPLAN`, `ASK_HUMAN`, `STOP`, `CONTINUE`) is consumed and dispatched by the runner loop.

### 6. Bounded Evidence Collection & Secret Redaction

`RuntimeEvidenceCollector` aggregates structured evidence throughout the run:
- Maximum bounds on collections: recent actions (10), tool outcomes (20), mutations (10), verifications (10), route signals (10), security signals (10), unresolved failures (10).
- Automatic secret redaction: all string inputs (arguments, outputs, errors) are scanned for API keys (`sk-[a-zA-Z0-9_-]{8,}`, bearer tokens, private keys) and redacted to `[REDACTED_SECRET]`.
- Output summaries are bounded (200 characters) to prevent token bloat.
- Incremental `evidenceVersion` ensures cache invalidation when new context or evidence is gathered.

### 7. Audit Trail, Outcome Linking & Ledger

`RuntimeEvalLedger` maintains an immutable in-memory ledger of all evaluation results, associated checkpoints, directives, interventions, and subsequent intervention outcomes (`RESOLVED`, `IMPROVED`, `UNCHANGED`, `DEGRADED`).
- Outcomes are explicitly linked to originating eval/intervention IDs across model changes, context requests, and verification cycles.
- `RuntimeEvalAnalytics` computes key operational metrics:
  - Total evaluation counts and decision distributions across `recommended`, `applied`, and `outcome` layers.
  - Repair loop success rates (`passes / (passes + failures)`).
  - Critic invocation counts and execution efficiency.
  - Developer-facing summary formatting for diagnostic visibility.

### 8. AgentRunner Integration & Configuration

`AgentRunnerDependencies` includes optional controls:
- `evalEngine`: Custom `RuntimeEvalEngine` (defaults to standard multi-level engine).
- `evalPolicy`: Custom `AdaptiveControlPolicy`.
- `evalLedger`: Custom `RuntimeEvalLedger`.
- `verificationEngine`: Optional engine for scheduled verification execution.
- `runtimeEvals?: boolean`: Controls whether runtime evals are active (defaults to `true`).
- `adaptiveInterventions?: boolean`: Controls whether adaptive directives inject observations or interrupts (defaults to `true`). Callers running fixed scripted benchmark traces (e.g. `coding-runner.ts`) can set `adaptiveInterventions: false` while retaining evaluation metrics and evidence logging.

---

## Verification & Proof

1. **Deterministic Test Suite (`npm run eval:runtime`)**:
   - 10 test categories, 107 exact scenarios evaluated across 2 consecutive runs.
   - 100% pass rate.
   - Determinism assertion: `assert.deepStrictEqual(run1, run2)`.
   - Strict negative comparator tests verify that any missing field, mismatched score, mismatched decision, altered security flag, routing hint mismatch, loop observation mismatch, or outcome state mismatch immediately fails the suite.
2. **Deterministic Coding Benchmark (`npm run eval:coding`)**:
   - 30/30 cases passing (100.0% task success rate, 100.0% safety success rate, 100.0% multi-file success rate).
3. **Monorepo Quality Gate**:
   - `npm test`: 18/18 test suites passing across all packages (0 failures).
   - `npm run typecheck`: 0 TypeScript errors across all 4 packages (`exactOptionalPropertyTypes: true`).
   - `npm run lint`: 0 warnings, 0 errors via `oxlint`.
   - `npm run build`: Clean builds across all packages.
