# Non-Progress Detection & Bounded Recovery

Sprint 5C, [ADR-031](../adrs/ADR-031-non-progress-detection-and-recovery.md). Code: `packages/agent-core/src/progress/`, integrated into `workflow/engine.ts` and `agent/runner.ts`.

This feature stops a local model from spending turns repeating a failed action. When it detects a stall, it diagnoses the failure once, allows one bounded recovery, and otherwise stops as BLOCKED with a reason and a next step.

## Turning it on

| Surface | Setting |
| --- | --- |
| CLI | `--progress-monitor` or `OPEN_VS_CODE_PROGRESS_MONITOR=1` |
| VS Code | `open-vs-code.progressMonitor.enabled` |
| API | `createAgentRuntime({ progressMonitor: { enabled: true, onProgress } })` |

It is off by default. When it is off, the direct runner and the workflow behave exactly as in Sprint 5B. When it is on, it protects both paths.

## Definition of progress

Progress is measured from observable state only. A `ProgressSnapshot` holds:

- the stage and observation point;
- the failing-check fingerprint and count;
- the blocking-finding fingerprint and count;
- the net-diff fingerprint and per-file hashes;
- the verification verdict and failed-check count;
- tool and error fingerprints.

| Counts as progress | Never counts as progress |
| --- | --- |
| fewer failing tests/checks | the same command run again |
| fewer blocking findings, or a blocker resolved | the same error printed again |
| verification `NOT_READY` → `READY`, or fewer failed checks | a write that leaves the content unchanged |
| a stage advance past the furthest stage reached | a rephrased explanation or longer reasoning |
| a meaningful workspace diff (even one character) | more tokens or another model message with no state change |
| new evidence (a new successful tool result) | |

`compareSnapshots` returns one of these deltas:

| Delta | Meaning |
| --- | --- |
| ADVANCED | success improved |
| CHANGED | evidence changed but success did not improve yet |
| STALLED | nothing changed |
| REGRESSED | more failures or blockers, or `READY` → `NOT_READY` |
| UNKNOWN | first observation |

## Progress epochs (Sprint 5D closure)

Repetition counters belong to a **progress epoch**. Measurable progress opens a new epoch, so an old action or error seen again after real progress starts from one instead of inheriting a stale count.

| Path | Opens a new epoch | Resets |
| --- | --- | --- |
| Direct (`DirectProgressGuard`) | fewer failed checks in a recognised test summary; new evidence after the bounded recovery | all action and error repeat counters |
| Direct | a write that changes workspace content | counters of *successful* actions only; a failure that survives the change still counts ("the repair did not help") |
| Workflow (`ProgressMonitor`) | every ADVANCED observation (fewer failures or blockers, better verification, stage advance) | the cross-point error counter; per-point test, review and diff counters already key on their own fingerprints |

A first-time read is evidence but not an epoch boundary, so an A/B/A/B read cycle is still caught. Epochs never reset global safety state: the consumed recovery attempt, cancellation, permission decisions, turn limits and the durable evidence set.

Regressions:

- `tests/progress/epochs.test.ts` EP-01 to EP-07;
- `eval:progress` fixture J (stall → recovery → new evidence → old read reused → COMPLETED; before epochs, `FAILED:NON_PROGRESS`).

## Signals and thresholds

| Signal | Trigger | Default |
| --- | --- | --- |
| `REPEATED_TOOL_ACTION` | same tool + normalized args + same result | 2 |
| `REPEATED_ERROR` | same tool error fingerprint after a different attempt | 2 |
| `TEST_STAGNATION` | the same failing-check fingerprint after a repair | 2 |
| `DIFF_STAGNATION` | an implementation pass leaves the net diff (or file hash) unchanged | 2 (the start state seeds the count) |
| `REVIEW_STAGNATION` | the same BLOCKER/HIGH finding (file + evidence quote) after a repair | 2 |
| `REPAIR_LOOP_STAGNATION` | repair cycles that change failures without reducing them | window 3 |
| `CONTEXT_BURN` | tool-using turns with no new evidence; also reported at turn exhaustion | window 3 |

Thresholds are internal (`ProgressThresholds`, integers ≥ 2) and are not user settings. Token count alone is never a stop signal.

## Fingerprints

`normalizeFailureOutput` is the single normalizer. It is also used by the workflow's `CheckOutcome.fingerprint`. It strips:

- ANSI codes;
- ISO and clock timestamps;
- durations, including node:test's `# duration_ms`;
- temp paths;
- request, trace and UUID ids;
- loopback ports;
- stack-frame `file:line:col` numbers;
- hex addresses and pids.

It keeps assertion text, expected and actual values, test names and counts, so a different assertion keeps a different fingerprint. Tool fingerprints use sorted keys and redact secrets before hashing.

## Failure classes and the discriminating check

The rules are evaluated in order; the first match wins.

| Class | Evidence | One check | Retry? |
| --- | --- | --- | --- |
| PERMISSION_BLOCK | denied/rejected permission, `EACCES` | inspect the recorded permission outcome | no |
| EXTERNAL_BLOCKER | 429, rate limit, `ENOTFOUND`, a non-loopback host | classify the endpoint (never probed) | no |
| ENVIRONMENT_FAILURE | `ECONNREFUSED` on loopback, a missing command or module, `EXECUTION_ERROR`, timeout | probe the loopback endpoint once (1s TCP) or check that the files exist | no |
| TOOL_FAILURE | invalid arguments, unknown tool, preparation error | tool availability and required arguments | yes |
| MODEL_FAILURE | unusable model output | rebuild a compact context | yes |
| CONTEXT_DEGRADATION | repeated identical actions, context burn or pressure | rebuild a compact context and drop repeated observations | yes |
| STATE_MISMATCH | diff stagnation, or files changed outside the run | re-hash the changed files against the recorded state | no |
| LOGIC_FAILURE | test, review or repair-loop stagnation with a healthy environment | inspect the exact failing assertion, or check that the quoted code is still present | yes |
| VERIFICATION_FAILURE | a failed verification check | — | yes |
| UNKNOWN | nothing matched, or the check was inconclusive | — | no |

`classifyStall` (stall root cause) is separate from `agent/failure-classification.ts` (which kind of check failed, used by the direct repair loop).

## Recovery state machine

```text
STALL DETECTED (monitor signal)
  → engine stops the retry loop
  → capture bounded failure facts
  → classifyStall
  → run ONE discriminating check (deterministic, read-only; at most once per run)
  → buildRecoveryPlan → retryAllowed?
       yes → consume the attempt and persist it → ONE bounded recovery pass
             → progress?  yes → resume ("RECOVERED" only once state advances or completes)
                          no  → BLOCKED_NON_PROGRESS
       no  → BLOCKED_NON_PROGRESS (escalate)
```

## Retry bounds

| Retry kind | Bound | Owner |
| --- | --- | --- |
| Ordinary test repair | `maxTestRepairs` (2) | workflow |
| Ordinary review repair | `maxReviewRepairs` (2) | workflow |
| Stage re-run after an invalid artifact or model failure | `maxStageRetries` (1) | workflow |
| Non-progress recovery | 1 per workflow and per runner session; **draws from the repair budget above** | engine / runner |
| Transient infrastructure / model retry | none exists | — |

A recovery replaces the next ordinary repair; it never adds one. A stage session that stops with `BLOCKED_NON_PROGRESS` ends the workflow and is not retried as a stage failure. In the eval, a workflow with `maxTestRepairs: 10` still stops after 3 TEST runs.

## Recovery context (token strategy)

The workflow's recovery IMPLEMENT instruction (`IMPLEMENT (recovery)`) is rebuilt from an allow-list:

- task;
- acceptance criteria;
- signal, class, hypothesis, check, observation and corrective action;
- current stage;
- last meaningful action;
- latest evidence and its fingerprint;
- workspace hashes.

It excludes the approved plan (an earlier hypothesis), the memory digest, earlier repair reasons, implementation summaries, transcripts and reasoning. The `FAILED_CONTEXT_SENTINEL` test (NP-W-09) proves stale dialogue, plan risks, summaries and `<think>` text never reach it.

On the direct path, recovery drops exact-repeat observations (`dedupeObservations`) and appends one bounded `NON_PROGRESS_RECOVERY` directive.

The recovery pass requests `skill:bug-triage`. In the IMPLEMENT envelope the built-in is rejected (`CAPABILITY_DENIED`: it declares `verify`, and IMPLEMENT has no `run_known_test`). The evidence reports that truthfully; the envelope is not widened.

## Workflow integration

| Observation point | Where |
| --- | --- |
| START | workflow creation (seeds the diff counter) |
| MUTATION | after each IMPLEMENT pass, with net changes refreshed from the workspace |
| TEST | after each TEST stage |
| REVIEW | after each fresh review |
| VERIFY | after VERIFY (evidence only; VERIFY never retries) |
| tool results | inside each stage session, through the runner's direct guard |

The engine is still the only component that transitions stages (`assertTransition`), so a recovery is an ordinary guarded `TEST→IMPLEMENT` or `REVIEW→IMPLEMENT` repair.

## Direct-path integration

`AgentRunner({ progressMonitor: { enabled: true } })` adds `DirectProgressGuard`. It catches:

- repeated actions, including non-consecutive cycles;
- repeated errors across different arguments;
- no-op writes;
- tool turns without new evidence;
- turn exhaustion without new evidence, reported as a bounded blocker while the failure reason stays `MAX_TURNS_EXCEEDED`.

The guard never forces the PLAN→IMPLEMENT workflow onto direct execution. The existing 3-repeat `NON_PROGRESS_GUARD` remains.

## Persistence and privacy

`WorkflowState.progress` holds:

- monitor counters and the last snapshot per point (hashes and counts);
- up to 12 assessments;
- stall signals;
- `recoveryCount`, `recoveryAttempted` and `diagnosticRun`;
- the recovery plan, `recoveryPass` and `recoveryOutcome`;
- the final `BLOCKED_NON_PROGRESS` report;
- an evidence-only `patternCandidate`.

All of it is written through `sanitizeWorkflowState` (redaction via the canonical `redactRuntimeEvalSecrets`, reasoning stripped, every string bounded). No raw logs, prompts, reasoning or secrets are persisted. After a restart, the counters and the consumed attempt are restored, so a crash cannot buy another retry (NP-W-11).

Cancellation supersedes recovery: no diagnostic check or retry starts after an abort, and nothing continues in the background.

## User-facing output

```text
No progress detected
Diagnosing repeated test failure…

Blocked after bounded recovery

Reason: the same failing check remained after a repair (3×)
Failure class: LOGIC_FAILURE
Last evidence: TEST `npm run test` → FAIL …
Diagnostic: inspect the exact failing assertion … → unchanged failing assertion: …
Recommended next action: Inspect the failing assertion and the changed code; …
```

Fingerprints, internal counters and telemetry are never shown.

## Measurement

`npm run eval:progress` writes `evals/results/sprint-5c-progress-eval.{json,md}`. It runs fixtures A–G from the brief plus three direct-path fixtures, each with the monitor off (A) and on (B), using the same simulated model. The run fails if a known loop is missed or a fixture with measurable progress is stopped.

## Limitations

- The model is simulated and behaves identically in both arms, so recovery success measures the machinery, not a real model. The real-model delta is DEFERRED_TO_HALO.
- After a restart, workflow-start file content is not in memory. REVIEW then shows the current content, labelled as such, instead of a net diff.
- Persisted task text is redacted, so a restored workflow uses the redacted task.
- Failing-test counts are parsed for node:test/TAP, Jest/Vitest, Mocha and pytest only. Other runners count one failure per failed check.
- Stall patterns are emitted as evidence (`patternCandidate`) only. Nothing is learned or written automatically; that decision belongs to Sprint 5D.
