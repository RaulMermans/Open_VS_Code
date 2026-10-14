# ADR-031: Non-Progress Detection & Bounded Recovery

## Status
Accepted (Sprint 5C). Feature-flagged **off** by default (`progressMonitor.enabled`) until the HALO same-model A/B benchmark is recorded. Guide: [`docs/workflows/NON_PROGRESS_RECOVERY.md`](../workflows/NON_PROGRESS_RECOVERY.md).

## Context
Small local models often repeat a failed action: the same edit, test run or tool call, phrased slightly differently each time. Before this sprint, two bounds limited the waste:

- the direct runner's guard, which stops after 3 *consecutive* identical tool calls with identical results;
- the workflow's repair limits (ADR-030).

Neither bound noticed that a run had stopped making progress, so neither diagnosed anything before the next retry. A non-consecutive cycle (A, B, A, B) ran until the turn limit. A repair that left the exact failing assertion unchanged was simply retried.

ECC's `agent-introspection-debugging` skill (`affaan-m/ECC` @ `b92f181`, MIT) describes a capture → classify → one discriminating check → retry loop. We adopt that sequence and its rule "run one direct check before retrying". We do not adopt its agent fleet, loop operator, or self-generated skills. Classification: **REFERENCE_ONLY**; no code or text was copied.

## Decision
1. **Progress is observable state, never model judgement.** `ProgressSnapshot` holds:
   - the stage;
   - the fingerprint and count of failing checks;
   - the fingerprint and count of blocking findings;
   - net-diff and per-file hashes;
   - the verification verdict;
   - tool and error fingerprints.

   It holds no prompts, reasoning, file contents or secrets. More tokens, a longer explanation, or rerunning the same command never counts as progress.
2. **Explicit deltas.** `compareSnapshots` compares like with like (the same observation point) and returns:
   - ADVANCED: fewer failing checks or blockers, a better verification verdict, or a stage advance;
   - CHANGED: different evidence with no improvement yet, e.g. a meaningful diff;
   - STALLED;
   - REGRESSED;
   - UNKNOWN: first observation.

   A regression dominates. A crossed stagnation threshold is never masked by a stage advance.
3. **ProgressMonitor observes; it never acts.** It updates per-dimension repeat counters and emits signals: repeated tool action, repeated error, test, diff, repair-loop and review stagnation, and context burn. It can only *request* CONTINUE, DIAGNOSE or BLOCK. The workflow engine (or `AgentRunner`) stays the authority for stages, and the PermissionGate stays the authority for permissions.
4. **Small, internal thresholds.** The same fingerprint seen 2 times in a row is a stall, and 3 non-improving repair cycles are a stall. Thresholds must be integers ≥ 2. They are not user-facing settings and are not tuned per fixture.
5. **Central invariant.** When a stall is detected, the authority:
   1. stops the retry loop;
   2. captures bounded failure facts;
   3. classifies them deterministically (`classifyStall`, 10 classes);
   4. runs **one** discriminating, read-only check;
   5. allows **one** bounded recovery retry, or ends `BLOCKED_NON_PROGRESS`.

   The check runs at most once per run. If the same stall follows the recovery, the result is BLOCKED.
6. **One retry budget, no multiplication.**
   - The workflow recovery draws from the existing `maxTestRepairs` / `maxReviewRepairs` budget; it replaces the next ordinary repair rather than adding one.
   - `MAX_NON_PROGRESS_RECOVERIES = 1` per workflow and per runner session.
   - A stage session that stops on an unrecoverable stall blocks the workflow; it is not retried as an ordinary stage failure.
   - No transient model-retry layer exists, and none was added.
7. **Not every class is retryable.** PERMISSION_BLOCK, ENVIRONMENT_FAILURE, EXTERNAL_BLOCKER, STATE_MISMATCH and UNKNOWN escalate without a retry, because a retry cannot start a database, approve an action, or resolve ambiguity. External hosts are never probed; the endpoint check connects only to loopback.
8. **Compact recovery context.** The recovery IMPLEMENT instruction is rebuilt from an allow-list:
   - task;
   - acceptance criteria;
   - the latest failing evidence;
   - the diagnostic result;
   - the last meaningful action;
   - workspace hashes.

   It excludes the plan, the memory digest, earlier repair reasons, summaries and any transcript. On the direct path, repeated observations are dropped and one recovery directive is appended.
9. **Skills stay truthful and permission-safe.** The recovery pass requests `skill:bug-triage`. The built-in declares the `verify` capability, which IMPLEMENT does not have, so it is rejected with `CAPABILITY_DENIED` rather than widening the envelope, and the evidence never claims it was applied.
10. **Persistence and privacy.** Progress state (counters, assessments, plan, report) lives in `WorkflowState.progress`. It is persisted through the sanitized workflow boundary, `sanitizeWorkflowState`, which reuses the canonical `redactRuntimeEvalSecrets`. Restarts restore the counters and the consumed recovery attempt. "Recovered" is recorded only when the run then demonstrably advances or completes.
11. **Feature flag.** `CreateAgentRuntimeOptions.progressMonitor.enabled` (CLI `--progress-monitor` / `OPEN_VS_CODE_PROGRESS_MONITOR=1`, VS Code `open-vs-code.progressMonitor.enabled`) defaults to `false`. When it is off, both paths behave exactly as in Sprint 5B.

Sprint 5B closure, recorded here because 5C depends on it:

- Every `WorkflowState` is sanitized before any store sees it.
- REVIEW receives the true **net diff** (workflow start → current workspace), and findings are grounded only in that diff and the current file content. The mutation history stays internal and is never labelled as the final diff.

## Consequences
- On the deterministic fixtures:
  - 5/5 known loops were detected, with 0/4 false stalls and 5/5 correct classifications.
  - Arm B used 13 fewer model calls, 13 fewer tool/check calls, and 3,327 fewer prompt tokens than arm A.
  - All of the savings come from early escalation (environment blocker) and the direct-path cycle. Workflow-path recoveries save no calls, because a recovery replaces a repair, and each costs about 250–350 extra prompt tokens.
- The simulated implementer is no smarter in recovery mode, so recovery *success* (1/4 attempts) measures the machinery, not a real model. The real-model delta is DEFERRED_TO_HALO.
- After a restart, a file's workflow-start content is no longer in memory. REVIEW then shows the file's current content, labelled as such, instead of a possibly stale diff.
- Persisted task text is redacted. A restored workflow therefore rebuilds stage envelopes from the redacted task, which keeps the intent but drops the secret value.
- Out of scope: automatic skill generation or promotion (5D), background or autonomous loops, multi-agent recovery, cloud escalation, model downloads, and automatic commits.
