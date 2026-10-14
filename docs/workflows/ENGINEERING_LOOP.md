# Structured Engineering Loop

Sprint 5B, [ADR-030](../adrs/ADR-030-structured-engineering-loop.md). Code: `packages/agent-core/src/workflow/`.

The loop runs a mutating coding task through explicit stages instead of one long agent session:

```text
PLAN → IMPLEMENT → TEST → REVIEW → VERIFY → COMPLETE
          ▲          │        │
          └──────────┴────────┘   bounded repair (failed tests, BLOCKER/HIGH findings)

any stage → BLOCKED | CANCELLED        (WAITING_FOR_CONFIRMATION is a pause, not a stage)
```

It is one sequential orchestrator over the existing runtime, not a set of agents. Each model stage is a fresh `AgentRunner` session. Each stage gets its own tool envelope and an instruction rebuilt from persisted artifacts.

## Turning it on

| Surface | Setting |
| --- | --- |
| Runtime | `createAgentRuntime({ workflow: { enabled: true } })` → `runtime.workflow` |
| CLI | `--workflow` or `OPEN_VS_CODE_WORKFLOW=1` |
| VS Code | `open-vs-code.workflow.enabled` |

The flag is off by default, and stays off until the HALO same-model A/B is recorded. When it is off, or the task is not eligible, `runtime.workflow` is `undefined`. The direct runner path then runs exactly as before.

## Eligibility

`assessWorkflowEligibility` is deterministic. A task enters the loop only if all of these hold:

- the flag is on;
- the mode is `BUILD` or `DEBUG`;
- the workspace is trusted;
- the instruction is not read-only.

Read-only means it starts with *explain/describe/what/why/how does/where/which/show me/list/find*. It also covers "review only", "do not change/modify any files/code", and "read-only".

These never enter the loop: ASK/PLAN/REVIEW modes, questions, navigation, review-only requests, and autocomplete (autocomplete is a separate path).

## Stages

| Stage | Kind | Mode for PermissionGate | Tool envelope | Produces |
| --- | --- | --- | --- | --- |
| PLAN | model | `PLAN` | read, search, markdown | `PlanArtifact` (goal, files, steps, tests, risks, acceptance criteria) |
| IMPLEMENT | model | `BUILD` | read, search, `write_file`, `delete_file`, `terminal_command` | `ChangedFile[]` (path, hashes, ±lines, bounded diff, pass number) + bounded summary |
| TEST | deterministic | `BUILD` | `run_known_test` | `TestEvidence` (commands, outcomes, failure fingerprints, bounded excerpts) |
| REVIEW | model, **fresh context** | `REVIEW` | read, search, markdown | `ReviewEvidence` (verdict, grounded findings, counts) |
| VERIFY | deterministic | `BUILD` | `run_known_test` | `VerificationEvidence` (`READY` / `NOT_READY` / `BLOCKED`, diff integrity) |

### Capability envelopes

An envelope does two things:

- **It narrows the registry.** `ToolRegistry.restrict(actions)` builds a registry holding only the tools whose action is in the envelope.
- **It wraps the PermissionGate.** `stagePermission` returns `DENY` outside the envelope. Inside the envelope it returns exactly what `classifyPermission` says for the stage mode.

An envelope can never return a more permissive answer than the base gate (test `W-27`). Writes still pause for confirmation. TEST and VERIFY ask the gate whether `run_known_test` is allowed in `BUILD`:

- `CONFIRM` (the default): the workflow pauses with the exact discovered commands.
- `DENY`: the workflow ends `BLOCKED` (`VERIFICATION_DENIED`).

Being a member of a stage is never approval. Review and verification never approve anything after the fact.

### Transitions

`transitionViolation` / `assertTransition` are pure functions.

| From → To | Requires |
| --- | --- |
| PLAN → IMPLEMENT | plan with a goal, at least one step and at least one acceptance criterion |
| IMPLEMENT → TEST | at least one applied change, no pending confirmation |
| TEST → REVIEW | a test attempt that passed |
| TEST → IMPLEMENT | a failed attempt, test repairs remaining |
| REVIEW → VERIFY | a review ran for this pass, with no BLOCKER/HIGH finding |
| REVIEW → IMPLEMENT | a blocking finding, review repairs remaining |
| VERIFY → COMPLETE | verdict `READY` |

Any non-terminal stage may go to `BLOCKED` or `CANCELLED`. Every other edge throws `WorkflowTransitionError`; for example, TEST → COMPLETE and REVIEW → COMPLETE both throw. The engine also refuses to complete on `NOT_READY` before any transition is attempted, as a second layer of defence.

## Context and artifact handoff

State is persisted; context is reconstructed for each stage:

- No stage receives `recentTurns`, another stage's transcript, tool observations or reasoning.
- PLAN gets the task and a bounded memory digest (≤ 1,500 chars).
- IMPLEMENT gets the task, the acceptance criteria and the plan. It also gets the memory digest, the list of files already changed, and, on a repair pass, a bounded **repair reason**: either the failing test excerpt or the blocking findings.

Artifact bounds (`ARTIFACT_LIMITS`):

| Artifact | Bound |
| --- | --- |
| Plan fields | 400 chars each |
| Plan lists | 12 items each |
| Diff per file | 4,000 chars |
| Combined review diff | 12,000 chars |
| Output excerpt | 1,200 chars (tail) |
| Review findings | 12, each field ≤ 400 chars |
| Implementation summary | 600 chars |

`<think>`, `<thinking>` and `<reasoning>` blocks are stripped before any artifact is parsed or stored.

## Fresh-context review

`reviewInstruction` builds the REVIEW envelope from an explicit allow-list:

- original task;
- acceptance criteria;
- approved plan;
- changed-file list;
- the bounded **net diff**: workflow start state → current workspace;
- test evidence;
- constraints (project decisions).

The net diff (`NetChange`, computed by `computeNetChange`) comes from each file's content at workflow start (captured before its first approved change) and its current workspace content. A file whose net change is empty is omitted. The internal mutation history (`ChangedFile[]`) is kept for recovery and evidence but is never shown as the final diff. Findings are grounded only in the net diff and the current content of net-changed files, so a finding that quotes obsolete intermediate code is rejected as ungrounded. Regression `C-0B`: a bug introduced, failed in TEST and repaired cannot block REVIEW. After a restart the start content is no longer in memory. A file changed once then shows that one change's diff; a file changed several times shows its current content, labelled as such, never a stale diff.

The REVIEW session starts at turn 1 with a single user message. It can read changed files and their callers with the read-only tools.

The envelope excludes, by construction:

- implementation dialogue and reasoning;
- the implementer's summary (its self-justification);
- tool observations;
- earlier reviews' output;
- chat history.

Test `W-FRESH` plants `IMPLEMENTER_PRIVATE_CONTEXT_SENTINEL` in five places: the implementer's dialogue, its reasoning metadata, a `<think>` block, a file it reads, and its final summary. The sentinel is also planted in the chat history. The test proves the implementer saw it and the reviewer did not. A negative control, which adds the summary to the envelope, makes the test fail.

### Review contract and false-positive discipline

The reviewer returns `{"verdict": "NO_FINDINGS"}` or `{"verdict": "FINDINGS", "findings": [...]}`. Each finding carries `id`, `severity` (`BLOCKER | HIGH | MEDIUM | LOW | NOTE`), `file`, `location`, `claim`, `evidence` and `recommendedAction`.

The workflow keeps a finding only if all of the following hold:

- its severity is known;
- its file is one of the changed files;
- its `evidence` is a verbatim quote, whitespace-normalised and at least 4 characters, found in the diff or in that file's current content.

Generic advice with no quotable source is dropped and counted as `rejectedUngrounded`. `NO_FINDINGS` is a first-class result, and the prompt says so explicitly.

This applies ECC's "pre-report gate" pattern (reference only; nothing copied): a finding must cite exact evidence, and zero findings is a valid review.

## Repair policy

| Trigger | Response | Limit (default) | When exhausted |
| --- | --- | --- | --- |
| Failed TEST | IMPLEMENT repair → TEST | `maxTestRepairs = 2` | `BLOCKED` · `TEST_REPAIR_LIMIT` |
| BLOCKER/HIGH finding | IMPLEMENT repair → TEST → **new** fresh REVIEW | `maxReviewRepairs = 2` | `BLOCKED` · `BLOCKED_REVIEW` |
| Invalid plan / unparseable review / model failure | re-run the stage | `maxStageRetries = 1` | `BLOCKED` · `PLAN_INVALID` / `REVIEW_UNPARSEABLE` / `STAGE_FAILED` |
| IMPLEMENT applied nothing | — | — | `BLOCKED` · `NO_CHANGES` / `REPAIR_PRODUCED_NO_CHANGES` |
| VERIFY `NOT_READY` | none: VERIFY never mutates | — | `BLOCKED` · `VERIFY_NOT_READY` |

MEDIUM, LOW and NOTE findings are reported but do not block.

Sprint 5C adds optional non-progress detection on top of these limits (`progressMonitor.enabled`, ADR-031, [`NON_PROGRESS_RECOVERY.md`](NON_PROGRESS_RECOVERY.md)). On a stall it runs one discriminating check and allows one bounded recovery pass. That pass draws from the same repair budget, then the workflow ends `BLOCKED` · `BLOCKED_NON_PROGRESS`. With the flag off, this table is the whole policy.

## Verification

TEST and VERIFY use the canonical `discoverVerificationCommand` + `VerificationEngine` through the `WorkflowVerifier` adapter. Commands come only from the repository's own configuration, and each run is frozen and stale-checked by package-file hash. The workflow core contains no `npm` knowledge.

| Stage | Checks |
| --- | --- |
| TEST | `TEST` |
| VERIFY | each of `TYPECHECK`, `LINT`, `BUILD`, `TEST` that the repository defines |

VERIFY also checks **diff integrity**: every changed file's current SHA-256 must equal the last reviewed `afterHash`. Otherwise the result is `DIVERGED`, which means `NOT_READY`.

If the repository defines no test command, the result is `BLOCKED` (`NO_TEST_COMMAND`); the workflow never invents commands.

During IMPLEMENT the runner's own "verify before completing" rule is delegated to the workflow. The workflow sets `task.metadata.verificationOwner = "workflow"`, because its mandatory TEST and VERIFY stages own verification. The direct path keeps the fail-closed rule unchanged.

## Skills (ADR-029)

Each model stage selects at most one skill. Selection uses the stage's mode and the stage's tool envelope, and keys on the original task text. A skill's `required_tools` contract is enforced as written, so with the five built-ins:

| Stage | Selectable built-ins | Not selectable, and why |
| --- | --- | --- |
| PLAN | none | no built-in allows `PLAN` mode |
| IMPLEMENT | none | `bug-triage` declares the `verify` capability, and IMPLEMENT has no `run_known_test` (`CAPABILITY_DENIED`); `tdd` and `refactor-with-guards` require `run_verification`, which the workflow reserves for TEST/VERIFY |
| REVIEW | `security-review` | `verification` requires `run_verification` |

(Corrected in Sprint 5C. This table first listed `bug-triage` as selectable in IMPLEMENT; the selector rejects it there, as the Sprint 5C recovery test NP-W-12 shows.) The envelopes are not widened to admit those skills. Their verification steps are done structurally by the TEST and VERIFY stages. A future stage-aware skill variant would need its own ADR-029 contract change.

Stage evidence records `selectedSkill`, `skillInjection` and `skillInjected`. These values come from the final compiled context (`SkillInjectionTracker`), so a skill dropped by the final budget is never reported as applied.

## Resume, restart and cancellation

- Every transition, pause and terminal state is saved as a `WORKFLOW_STAGE` checkpoint under run `workflow-<id>`. The existing atomic, checksummed `CheckpointStore` holds it (`CheckpointWorkflowStore`). There is no second persistence system.
- `EngineeringWorkflow.restore(deps, id)` resumes at the persisted stage and never re-runs completed stages. Pending confirmations are handled as follows:
  - A pending verification approval is **re-requested**.
  - A pending runner confirmation (its session died with the process) is closed as `INTERRUPTED_BY_RESTART`, and the stage restarts with a fresh session. Nothing is replayed or assumed approved.
- `cancel()`, or the caller's `AbortSignal`, makes the workflow terminal as `CANCELLED`. No later stage, review, verification or transition happens; `run()` and `resume()` return `CANCELLED` without doing any work.

## Evidence

`WorkflowState` holds bounded operational facts only:

- ids, the stage, completed stages, artifacts, retry counts and blocker;
- one `StageRecord` per executed stage attempt: start/end, status, mode, model calls, peak context tokens, tools used, skill and injection state, outcome.

Records exist only for stages that ran, so there is never a synthetic "review passed". It never stores prompts, transcripts, reasoning or full file contents (`beforeContent`/`proposedContent` are dropped). Workflow-start file contents used for the net diff stay in memory only.

**Persistence boundary.** Every state is passed through `sanitizeWorkflowState` (`workflow/persistence.ts`) before any `WorkflowStateStore` sees it. The sanitizer:

- applies the canonical `redactRuntimeEvalSecrets` to every free-text string (task, summary, diffs, test excerpts, finding claim/evidence/action, repair reason, blocker detail, progress evidence);
- strips reasoning blocks;
- bounds each string to 12,000 characters;
- leaves hashes, ids and timestamps untouched.

The in-memory state is not modified. A restored workflow therefore rebuilds its envelopes from the redacted task text. Regression `C-0A` writes literal secrets into every field and checks that no checkpoint file contains one.

Progress shown to the user is limited to stage transitions (`Stage: REVIEW`, `Skill: security-review`).

## Measurement

`npm run eval:workflow` writes `evals/results/sprint-5b-workflow-eval.{json,md}`. It covers:

- eligibility;
- six task fixtures, whose `npm test` checkers really run;
- a direct vs structured A/B;
- per-stage context tokens;
- reviewer-bias cases A–D plus an inflated-severity probe.

The model is a deterministic local simulation. The real-model delta is **DEFERRED_TO_HALO**.
