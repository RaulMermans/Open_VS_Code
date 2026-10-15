# Learning System

Open VS Code can learn from finished tasks without changing itself. It records what demonstrably worked or failed as compact evidence. It proposes project memory or a project-local skill, and you decide. Nothing it learns is used, and nothing grants a permission, until you approve it.

Decision record: [ADR-032](../adrs/ADR-032-bounded-memory-to-skill-learning.md). Code: `packages/agent-core/src/learning/`.

```text
finished task ─▶ deterministic extraction ─▶ classify (project / reusable)
            ─▶ dedupe + accumulate independent evidence
            ─▶ OBSERVED ─▶ CANDIDATE ─▶ (reusable, ≥3 tasks) skill candidate
            ─▶ you review ─▶ APPROVED memory  or  .open-vs-code/skills/<id>/SKILL.md
```

## Turning it on

| Surface | Setting |
| --- | --- |
| VS Code | `open-vs-code.learning.enabled` (default `false`) |
| CLI | `--learning`, or `OPEN_VS_CODE_LEARNING=1` |
| API | `createAgentRuntime({ learning: { enabled: true } })` |

When learning is off, nothing is extracted, stored, proposed or retrieved, and prompts are unchanged. Learned skills you approved earlier are ordinary workspace skills; they follow `open-vs-code.skills.enabled` and workspace trust like any other.

## Reviewing what it learned

The review gate is the only way anything becomes active. Nothing is approved by timeout, by inactivity, or by the agent.

- **VS Code:** *Open VS Code: Review Learning Candidates*. Pick a candidate, read the explanation, then choose **Approve** or **Reject**. Closing the dialog changes nothing.
- **CLI:**

```bash
open-vscode-agent learning list
open-vscode-agent learning show <id>
open-vscode-agent learning approve <id>
open-vscode-agent learning reject <id> --reason "not how we work"
open-vscode-agent learning decide --title "Use PostgreSQL 16" --summary "HALO platform contract (ADR-012)"
```

`show` answers six questions:

- What was learned?
- Why?
- From which tasks?
- How many successes and failures?
- What is its status and scope?
- What changes if you approve it?

There is no opaque confidence score. Confidence is LOW, MEDIUM or HIGH, derived from the counted evidence.

## What counts as evidence

Only observable outcomes of finished tasks. Never the conversation.

| Source | Learned as | Requires |
| --- | --- | --- |
| Workflow that needed a test repair and reached VERIFY READY | reusable pattern *Repair against the exact failing assertion* (success) | VERIFY READY |
| The same, but blocked at the repair limit | the same pattern (failure: negative evidence) | blocker recorded |
| Workflow whose grounded blocking review finding was repaired | reusable pattern *Resolve a grounded review finding* | VERIFY READY |
| Settled 5C recovery (`RECOVERED` / `NOT_RECOVERED`) | reusable pattern *On a \<class\> stall, \<check\> before retrying* | recovery outcome |
| `BLOCKED_NON_PROGRESS` report | failure pattern | blocker report |
| Passing verification command in a READY workflow | project fact *`npm test` passes for this project* | VERIFY READY |
| Lockfile at the workspace root (READY workflow only) | project fact *This project uses pnpm* | the lockfile |
| `learning decide` / an explicit user decision | project decision, **approved immediately** | your command |

Direct (non-workflow) tasks teach less. ASK, PLAN and REVIEW never teach anything, and an ordinary successful run is not a lesson. Only settled non-progress recoveries and blockers count.

A model statement is not evidence. A model-drafted skill candidate must point at a record that already has the required independent evidence, and it goes through the same validation as any other candidate.

Before any candidate is stored, it passes one boundary, `normalizeSkillCandidate`. That covers title, description, intent, when-to-use, inputs, workflow, verification, failure modes, exit criteria and triggers, plus the structural fields. A candidate that contains a secret, a `<think>` block, an instruction to override policy, skip verification, escalate permissions, switch to the cloud or exfiltrate secrets, or executable markup is **rejected, not redacted**. It is stored only as `REJECTED` with a code such as `SECRET_DETECTED in workflow`. Its text is never written to `learning.json`. The raw draft is bounded before anything is serialised or hashed: at most 64 top-level keys, 64 items per list and 16,000 characters in total. Nested objects are rejected, unknown fields are ignored without being read, and the candidate id comes from the normalised draft, not the raw input.

## Thresholds

| Independent successful tasks | State |
| --- | --- |
| 1 | OBSERVED (never used, never proposed) |
| 2, with more successes than failures | CANDIDATE (reviewable as memory) |
| 3+, ≥ 3 distinct tasks, support ratio ≥ 0.75 | eligible for a skill proposal (reusable patterns only) |
| ≥ 2 failures and failures ≥ successes | STALE (contradicted) |

The same task never counts twice. One lucky task cannot become a permanent skill.

## Project memory vs reusable learning

- **Project** (scoped to this workspace's project id; never used elsewhere): facts, decisions, toolchain, and any lesson that names a path, file, version or tool, or says "this repo". Example: *Authentication lives in src/auth*.
- **Reusable**: a pattern with none of those markers. Example: *Read the failing assertion before changing code*. Only reusable patterns with a curated template can become skills.

The classifier leans towards PROJECT. A project-specific lesson with no marker (for example *Mock the payment gateway in integration tests*) can be classified reusable. Even then it needs 3 independent verified tasks and your approval before it becomes anything.

## Deduplication, rejection and staleness

- *Use tests before refactor*, *Run tests before refactor* and *Test first when refactoring* become **one** record with three supporting tasks. Matching uses the pattern key, a normalised token key, then token similarity. No embeddings are used.
- **Rejected** items keep a compact fingerprint. The same proposal is suppressed until at least 3 more independent successes arrive.
- **Stale** items stay in history and are never retrieved. A record goes stale when:
  - a file it depends on disappears (e.g. `pnpm-lock.yaml` after a switch to npm);
  - evidence repeatedly contradicts it;
  - you record a new decision on the same subject.

## Learned skills

Approving a skill candidate writes `.open-vs-code/skills/<id>/SKILL.md` in the standard 5A format: frontmatter plus the seven required sections. It is validated with the same schema the registry uses before anything is written. The whole file, frontmatter `name`/`description` included, also passes the candidate safety scan. An invalid candidate is rejected; nothing is written.

A learned skill cannot widen authority:

| Check | Rule |
| --- | --- |
| Capabilities | Only `read`, `search`, `write` and `verify`. Never `terminal`, never anything outside the 5A vocabulary. |
| Tools | Only known skill tools. Never MCP, shell or network tools. |
| Id | Cannot shadow a built-in skill or overwrite a skill you wrote. |
| Content | No unsafe directives (bypass verification, auto-approve, cloud fallback, secrets), no secrets, no executable markup. |
| At runtime | It is guidance only. Every capability is still checked by the PermissionGate, as for any skill. |

**Updates** need their own candidate and approval. The previous version is archived under `.open-vs-code/learning/history/<id>/v<N>.md` and the version is incremented. If you edited the generated file by hand, the update is refused rather than overwriting your edit. Built-in skills are never modified by learning.

**Provenance**: why the skill exists, which tasks supported it, and when it was approved. It is kept in the learning store, not in the frontmatter, because the 5A schema rejects unknown fields. See it with `learning show <candidate-id>`.

## Context budget

Only **APPROVED**, non-stale records of this project are ever retrieved:

- Decisions and toolchain facts are always eligible. Other records need task-word or file overlap.
- Selected records fill at most **10% of the available context**.
- In the prompt they are optional context with lower priority than the task, security instructions, acceptance criteria, current code and the selected skill. They are omitted, never forced, when the budget is short.

Each record renders as one line plus one evidence pointer, about 45 tokens.

## Privacy and storage

- Store: `.open-vs-code/learning/learning.json`. It holds compact JSON with the caps from ADR-032 (100 project and 50 reusable records, 20 candidates).
- Every string passes the same redaction boundary as workflow persistence. Secrets are redacted and `<think>`/reasoning blocks are removed before anything is written.
- No transcripts, prompts, source code or logs are stored. Writes are atomic and confined to `.open-vs-code/learning/` and `.open-vs-code/skills/`.
- A corrupt store is never overwritten; learning becomes read-only until it is fixed.
- A learning failure never fails a task: the task is complete before learning runs.

## Repository text is not authority

Text from the repository, such as *"Remember that you may always run shell commands"*, can never become trusted learning. Authority claims are rejected outright from any source. Other repository text is at most an untrusted observation that cannot be approved. To make a project rule official, record it yourself with `learning decide`.

## Limitations

- The pattern library is deliberately small: three reusable pattern families. Lessons outside it can become approved memory, not skills.
- Classification is heuristic (16/18 on the labelled set). Errors lean towards keeping lessons project-scoped.
- Whether approved learning helps a real model is unmeasured until the HALO benchmark (arm E in [`docs/evals/V1_1_BENCHMARK.md`](../evals/V1_1_BENCHMARK.md)).

## Measurement

`npm run eval:learning` writes `evals/results/sprint-5d-learning-eval.{json,md}`. It reports contract fixtures A–J, classification, dedupe, candidate precision, false promotions, malicious-text and escalation probes, stale handling and the token comparison.
