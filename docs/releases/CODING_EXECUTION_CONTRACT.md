# Coding execution contract

Status: contract corrected in the working tree. Personal V1 remains blocked.

`origin/main` at review: `6cfc28195329b429338560b5b4527b02e3137926`.
Local branch `product/personal-v1-production-completion` contains that tree plus this contract fix. No package was installed. No model was downloaded.

## Lifecycle owner

`AgentRunner` owns task status, completion, and verification for ordinary Build and Debug coding tasks.

`RepairOrchestrator` still starts only after that runner records `VERIFICATION_FAILED`. It does not own the original task, and it does not ask for the same approved test again. `integrateRepairOutcome` keeps the original task id and events.

`AgentSessionBridge` drives approval and hands a failed verification to repair. It does not decide that a coding task succeeded.

## Completion

A behavior-changing coding task is complete only when all of these are true:

- The requested implementation file was applied, not only a test file.
- Every explicitly named path was applied.
- Required verification ran after that edit and passed.
- The user did not reject or cancel the task.

A test-only edit, a passing test with no implementation change, a failed test, a missing test run, a rejection, a cancellation, a tool failure, or an exhausted turn budget does not complete the task.

If the implementation edit is outstanding, the runner keeps edit tools available and does not tell the model to stop. If the edit is applied and tests are still required, it asks for verification and still allows tool calls. Repository evidence does not replace either step.

When the coding goal is already met, a missing investigation-evidence requirement does not force another model turn.

Applied paths come from `AgentResult.appliedMutations` or `mutation.applied` event payloads. The final answer is not parsed.

## What stayed

| Subsystem | Decision |
|---|---|
| AgentRuntime, AgentRunner, PermissionGate, MutationEngine | KEEP. One runtime, one mutation engine. |
| Exact `apply_patch` and `create_file` | KEEP. Still the user-facing edit tools. Approval, workspace confinement, preimage hashes, stale detection, diffs, and the journal are unchanged. |
| RepairOrchestrator | KEEP, after failed verification only. |
| REA, Design, skills, MCP, memory, browser, capability packs | KEEP. Not part of the default coding failure, and not removed. |
| Local model picker and Ollama gateway | KEEP. Not revalidated in the installed GUI in this change. |

No second edit tool was added. A live comparison of whole-file replacement against exact search/replace was not run, so the edit format did not change.

## Measured local check

Machine model: installed `qwen2.5-coder:7b` only. No download. Harness: `scripts/personal-v1-local-benchmark.ts` through the bridge, with approvals automatic. This is not the GUI.

First three-task run, before created-file guarding:

| Task | Status | Independent check |
|---|---|---|
| original-format-note | `COMPLETED` with `failureReason: INTERNAL_ERROR` | failed. The model created `src/tests`. `src/format-note.mjs` was unchanged. False completion. |
| original-add | `FAILED` / `NON_PROGRESS` | failed. Search only. |
| reject-greet | `FAILED` / `REJECTED` | file unchanged. |

That false completion is why a new file, including a file named `tests`, does not satisfy an existing-implementation change.

Second format-note run, after that guard: `FAILED` / `MAX_TURNS_EXCEEDED`. Independent check failed. Source unchanged. `falsePositive: false`. The model called tools for 15 turns and did not land a patch. This does not replace the 10-task bar.

## Still blocked

- The 8/10 unseen local-model bar and the two original regressions are not re-established by this contract fix alone.
- The installed Debian package predates this tree.
- The seven installed-GUI journeys were not run.
- Monorepo lint, full test, eval, and desktop gates were not all run for this change.
