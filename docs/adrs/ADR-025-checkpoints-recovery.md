# ADR-025 — Durable Checkpoints, Recovery & Safe Rollback

**Status:** ACCEPTED  
**Sprint:** 4C — Checkpoints / Recovery  
**Date:** 2026-09-23

---

## Context

Prior sprints established a hardened local coding agent architecture:
- Project Memory and skills (Sprint 2A, 2B)
- Safe tool registries and MCP runtime (Sprint 2C)
- Deterministic model provider routing (Sprint 2D)
- Multi-mode editor UX: Chat, Diff/Edit, Controlled Terminal, Autocomplete (Sprint 3A-3E)
- System-wide security boundaries and least-privilege controls (Sprint 4A)
- Runtime evaluations and adaptive control loops (Sprint 4B)

Prior to Sprint 4C, the agent runtime lived entirely within the transient memory of the Node.js host process. If the process crashed, VS Code restarted, power was lost, or the user interrupted an execution turn:
1. In-flight mutation state was lost.
2. In-flight verification state could not be differentiated from completed or unstarted verifications.
3. Pending human confirmations could be bypassed or replayed erroneously upon restart.
4. Attempting to blindly "resume" could cause duplicate file edits, broken patches, or silent file corruption.
5. Inability to roll back interrupted mutations left the user workspace in an inconsistent, non-compiling state.

Sprint 4C introduces **Durable Checkpoints, Operation Journaling, and Safe Recovery** so that an agent can withstand abrupt termination and process restarts without duplicate writes, stale authorization tokens, or compromised security.

---

## Decision

### 1. Core Invariant: Observed State Dictates Recovery

Recovery algorithms must **never guess or assume unobserved results**.

```
+-------------------------------------------------------------------------+
|                  TRUTHFUL RECONCILIATION INVARIANT                       |
|                                                                         |
|  1. A mutation is RECONCILED_APPLIED only if the disk file exists       |
|     with the EXACT expected postcondition SHA-256 hash.                 |
|                                                                         |
|  2. A mutation is RECONCILED_NOT_APPLIED if the disk file exists with   |
|     the EXACT expected precondition SHA-256 hash (or is absent for      |
|     creation).                                                          |
|                                                                         |
|  3. Any discrepancy where the disk file exists with an unexpected hash  |
|     or is missing when expected yields AMBIGUOUS / BLOCKED_DIVERGENCE,  |
|     halting automated recovery and requiring ASK_HUMAN disposition.     |
|                                                                         |
|  4. Verification processes interrupted mid-flight cannot be assumed to   |
|     have passed; they are classified as INTERRUPTED and yield REVERIFY. |
+-------------------------------------------------------------------------+
```

### 2. Authority Separation: RecoveryController is NOT a Write Authority

In strict accordance with ADR-023 §10 and ADR-024 §1:
- `RecoveryController` is an **inspection, classification, and planning component**.
- It creates a structured, deterministic `RecoveryPlan`.
- It **never** mutates files directly, spawns shell processes, or grants permissions.
- All file restorations during rollback route strictly through `MutationEngine` under existing workspace boundaries.
- All subsequent verification commands route strictly through `VerificationEngine` under existing security boundaries.

### 3. Process Epoch Invalidation: Defense Against Stale Approvals

To prevent replaying approvals across application restarts:
1. Every process invocation generates a unique `processEpochId` via cryptographic entropy (`crypto.randomUUID()`).
2. Checkpoints record the `processEpochId` active when the checkpoint was saved.
3. When `RecoveryController` builds a recovery plan:
   - If the checkpoint's `processEpochId !== currentEpoch`, any pending confirmation (`WAITING_FOR_CONFIRMATION` or unexecuted approved mutation) is declared **invalidated**.
   - The recovery plan assigns disposition `RECONFIRM` and sets required approval to `NEW_EPOCH_AUTHORITY_REQUIRED`.
   - The agent runner refuses to execute unexecuted mutations without explicit re-authorization from the user in the new process session.

### 4. Write-Ahead Operation Journal

All stateful operations (mutations, verifications, MCP interactions) write an intent record to an append-only JSONL log before touching workspace files or external processes:
- **Append-only storage with Physical Sync:** Never rewritten in place; updates append a new entry with the updated status (`PREPARED -> STARTED -> COMPLETED | FAILED | INTERRUPTED`). Appends use `fs.promises.open("a")`, `handle.appendFile()`, and explicit `handle.sync()` before closing.
- **Fail-Closed Truncation Rollback:** If physical disk synchronization (`handle.sync()`) fails, the journal handle truncates the file back to its pre-append length, preventing corrupt, unpersisted partial lines from remaining in the log.
- **Deterministic Idempotency Key:** Computed as `SHA-256(runId:evidenceVersion:kind:authorityId:intentHash)`.
- **Deduplication:** When querying journal operations for a run, entries are deduplicated by `operationId`, preserving the latest authoritative lifecycle status.
- **Lineage Tracking:** Retried operations link to the failed/interrupted operation via `replacesOperationId`, providing an audit trail.

### 5. Atomic Checkpoint Store

Checkpoints represent durable semantic snapshots taken at key agent state transitions (`RUN_STARTED`, `BEFORE_MUTATION`, `AFTER_MUTATION`, `BEFORE_VERIFICATION`, `AFTER_VERIFICATION`, `BEFORE_PAUSE`, `COMPLETED`, `FAILED`):
- **Atomic Persistence:** Written to a temporary file (`.tmp.<random>`) in the recovery directory and atomically renamed to `cp_<sequence>_<checkpointId>.json`.
- **Integrity Verification:** Every checkpoint contains a SHA-256 checksum over its canonical JSON representation. Upon reading, corrupted, partially written, or tampered records fail integrity verification.
- **Fail-Closed Versioning:** If a checkpoint's `schemaVersion > CHECKPOINT_SCHEMA_VERSION`, reading fails closed with `UNSUPPORTED_CHECKPOINT_VERSION`.
- **Bounded Retention:** Checkpoints are pruned to retain at most `maxCheckpoints` (default 50) per run, preventing disk bloat.
- **Atomic HEAD Pointer:** A symbolic `HEAD` file atomically points to the latest valid checkpoint sequence.

### 6. Bounded Recovery Artifact Store

To support safe rollback of file modifications and deletions:
- **Preimage Capture:** Before applying a mutation that modifies or deletes an existing file, the original file bytes are captured in `.open-vs-code/recovery/runs/<runId>/artifacts/preimages/<opId>`.
- **Strict Size Limits:**
  - Single file bound: `maxIndividualPreimageBytes = 8 MiB`.
  - Run total bound: `maxArtifactBytesPerRun = 64 MiB`.
  - Exceeding bounds fails closed without storing corrupt partial preimages.
- **Privacy & Hygiene:** Preimages are stored exclusively in local storage; they are never included in telemetry, analytics, prompt contexts, or model payload messages.

### 7. Safe Rollback Semantics

When reverting interrupted or failed mutations:
- **CREATE mutations:** If the created file exists on disk with the expected postcondition hash, rollback removes the file.
- **MODIFY mutations:** Rollback retrieves the exact preimage and applies a reverse patch via `MutationEngine`, verifying the before/after hashes.
- **DELETE mutations:** Rollback retrieves the captured preimage and recreates the file via `MutationEngine`.
- **TOCTOU Protection:** Prior to applying any rollback write, the current file on disk is re-observed. If the file has diverged (e.g. edited by user in the interim), rollback for that file is marked `DIVERGED` and aborted.

### 8. Storage Path Safety & Symlink Protection

All checkpoint, journal, and artifact storage paths are validated via `assertSafeStoragePath(allowedRoot, targetPath)`:
- Target paths must be strictly contained within `allowedRoot`.
- Both existing and non-existent parent paths are canonicalized against OS-level symlinks (such as macOS `/var` -> `/private/var`).
- Existing paths and intermediate directories are inspected with `fs.lstat()`. Any symlink pointing outside `allowedRoot` throws `SYMLINK_ESCAPE` and is rejected immediately.

---

## Recovery Lifecycle Matrix

| Observed Disk State | Journal Status | Reconciled Status | Recovery Disposition | Action Taken |
|---|---|---|---|---|
| Disk matches postcondition | STARTED / PREPARED | `RECONCILED_APPLIED` | `REVERIFY` | Write replay count = 0; verify state |
| Disk matches precondition | STARTED / PREPARED | `RECONCILED_NOT_APPLIED` | `RESUME` | Safe to execute original mutation |
| Disk differs from both | Any | `AMBIGUOUS` | `ASK_HUMAN` | Halt automated recovery; human choice |
| Verification in-flight | STARTED | `INTERRUPTED` | `REVERIFY` | Re-run verification in new process |
| Verification finished | COMPLETED | `COMPLETED` | `RESUME` | Truthful pass preserved; continue |
| Pending approval | WAITING_FOR_CONFIRMATION | N/A | `RECONFIRM` | Invalidate stale token; request fresh human approval |
| Run paused by user | PAUSED | N/A | `ASK_HUMAN` | Respect pause reason; do not auto-resume |
| Run completed | COMPLETED | `COMPLETED` | `STOP` | Task finished; side-effect delta = 0 |
| Run security failed | FAILED | `FAILED` | `STOP` | Security denial permanent; no auto-retry |

---

## Verification & Determinism

Sprint 4C is verified through a rigorous evaluation harness (`packages/agent-core/tests/recovery/recovery-evaluation-harness.ts`):
1. **82 Scenarios** covering 15 functional categories (Checkpoint Integrity, Operation Journal, Mutation Reconciliation, Verification Recovery, Approval Invalidation, Workspace Divergence, Rollback Safety, Retry Lineage, Pause Completion, Runtime Eval Integration, Storage Security, Bounded Retention, MCP Recovery, Model Recovery, Analytics Hygiene).
2. **Two-Run Determinism:** The harness runs twice independently across clean temporary environments. All 82 scenarios must pass with 0 failures, and strict deep equality is asserted between Run 1 and Run 2 results.
3. **Negative Comparator Verification:** Verifies that intentional discrepancies in divergence class, disposition, replay count, and rollback status trigger strict assertion errors.
4. **Real Process-Boundary Crash Tests (T-4840 / T-4841):** Child Node processes simulate mid-write and pre-write crashes, verifying that process B recovers without duplicate writes and invalidates approval tokens across process boundaries.

---

## Sprint 4C.1 — Production Recovery Integration & Integrity Closure

To complete the production integration and close Sprint 4C permanently:
1. **Stable Canonical Serialization (`canonical-serializer.ts`):** Recursive object key sorting and circular reference detection guarantee byte-for-byte deterministic SHA-256 checkpoint checksums and journal intent hashes across engines and runtimes.
2. **Monotonic Checkpoint Sequence Tracking:** `CheckpointCoordinator` maintains monotonic per-run sequence numbers seeded from latest on-disk checkpoint sequence across restarts.
3. **Canonical AgentRunner Write-Ahead Durability:** Checkpoints persisted at all semantic lifecycle boundaries:
   - `RUN_STARTED` at session start
   - `BEFORE_MUTATION` before executing file mutations
   - `AFTER_MUTATION` immediately after mutation applied
   - `BEFORE_VERIFICATION` before executing test/command verifications
   - `AFTER_VERIFICATION` immediately after verification outcome recorded
   - `COMPLETED` upon task conclusion
4. **`AgentRunner.resumeFromRecovery`:**
   - Evaluates on-disk checkpoints, reconciles workspace operations, builds `RecoveryPlan`, feeds evidence to `RuntimeEvalEngine`.
   - On `STOP`: terminates cleanly without side effects.
   - On `RECONFIRM` / `ASK_HUMAN`: pauses safely in `WAITING_FOR_CONFIRMATION` without automatic approval replay.
   - Attaches `recoveryPlan` and emits `recovery.resumed` / `recovery.paused` events.
5. **MutationEngine Rollback Authority:**
   - All rollback operations (patch reversal, create deletion, delete re-creation) execute exclusively through `MutationEngine`.
   - Added `registerSnapshot` to allow restoring snapshots from artifact store.
6. **Zero Artificial Passes:**
   - Audited every scenario in `recovery-evaluation-harness.ts`, replacing all synthetic passes with verifiable runtime assertions.
   - Strict comparator asserts zero discrepancies across two independent runs.

---

## Sprint 4C.2 — Fail-Closed Durability & Recovery Evidence Closure

Sprint 4C.2 established fail-closed durability gates and strict evidence truth:
1. **Fail-Closed Durability Gates in `AgentRunner` (`runner.ts`):** Pre-mutation and pre-verification persistence checks.
2. **Durability Propagation to Repair Runners:** `RepairOrchestrator` wires `checkpointCoordinator` to repair runners.
3. **Strict Evidence Truth in Recovery Evaluations:** `passed` strictly derived at evaluation time using `node:util.isDeepStrictEqual`.
4. **Real Process-Boundary Rollback Crash Tests (`crash-process-e2e.test.ts`):** Proving zero duplicate writes across process terminations.
5. **Evaluation Suite Expansion:** 90 scenarios across 17 categories.

---

## Sprint 4C.3 — Recovery Resume & Rollback Durability Closure

Sprint 4C.3 permanently seals and closes Sprint 4C with complete durability invariants across recovery resume, rollback journaling, and verification persistence:

1. **`resumeFromRecovery()` Fail-Closed Persistence Gate:**
   - In `AgentRunner.resumeFromRecovery()`, recording the `RECOVERY_RECONCILED` checkpoint is strictly gated. If persistence fails (e.g. disk corruption, full volume), resume halts immediately without side effects, failing closed with `INTERNAL_ERROR` and emitting `task.failed` with `RECOVERY_PERSISTENCE_FAILED`.
   - All dispositions (`RESUME`, `REVERIFY`, `ASK_HUMAN`, `CONTINUE`) respect this gate: model calls and engine invocations are strictly 0.

2. **`recordFailed()` Durability Fail-Closed Invariant:**
   - Across `executePendingApproval`, `executeTool`, `executeScheduledVerification`, and `#runAutoVerification`: once an operation is `STARTED`, if execution fails and subsequent persistence of `recordFailed` fails, the runner treats this as a critical durability fault and fails closed immediately with `RECOVERY_PERSISTENCE_FAILED` and `failureReason: "INTERNAL_ERROR"`.

3. **First-Class Write-Ahead Rollback Operations (`ROLLBACK_MUTATION`):**
   - Rollback is no longer an out-of-band mutation; it is a first-class journaled operation with kind `"ROLLBACK_MUTATION"` and authority `"mutation-engine"`.
   - Follows the complete write-ahead lifecycle: `recordPrepared -> recordStarted -> MutationEngine.rollback/apply -> recordCompleted -> ROLLBACK_COMPLETED checkpoint`.
   - Incorporates deterministic idempotency keys (`computeOperationIdempotencyKey`).
   - Duplicate completed rollbacks are suppressed with 0 reverse writes when disk is already restored, and yield `DIVERGED` if the file has diverged from expected postconditions.

4. **Real Rollback Process Crash Verification (`T-5114` - `T-5117` in `crash-process-e2e.test.ts`):**
   - E2E child process persists forward mutation `COMPLETED`, prepares and starts `ROLLBACK_MUTATION`, applies reverse write, and crashes before `recordCompleted`.
   - Parent recovery process inspects workspace, reconciles `ROLLBACK_MUTATION` to `RECONCILED_APPLIED`, and avoids duplicate reverse writes.
   - Pre-write rollback crash reconciles to `RECONCILED_NOT_APPLIED` without automatic replay.

5. **Canonical Verification Durability & Restart Survivability (`T-5119` - `T-5122`):**
   - `AgentRunner` executes verification following strict write-ahead sequence: `VERIFICATION_PREPARED -> VERIFICATION_STARTED -> BEFORE_VERIFICATION -> VerificationEngine -> VERIFICATION_COMPLETED -> AFTER_VERIFICATION`.
   - Survives restart: completed verifications remain `COMPLETED` and are never misclassified as `INTERRUPTED`.
   - Failure of `recordStarted` blocks `VerificationEngine` and fails closed.

6. **Expanded Deterministic Evaluation Suite (110 Scenarios Across 19 Categories):**
   - `recovery-evaluation-harness.ts` expanded to **110 scenarios** across 19 categories (adding `ROLLBACK_DURABILITY`, `VERIFICATION_DURABILITY`, and `RECOVERY_FAIL_CLOSED`).
   - Evaluates with 100% pass rate and 100% two-run determinism using strict deep equality comparator with zero fake passes.
   - Negative comparator suite expanded to 13 negative tests asserting discrepancies in rollback reconciliation, replay counts, persistence failures, verification durability, and side-effect counts.

7. **Sprint 4C.3 Verification:**
   - Evaluated with 100% pass rate and 100% two-run determinism using strict deep equality comparator with zero fake passes.
   - Negative comparator suite expanded to 13 negative tests asserting discrepancies in rollback reconciliation, replay counts, persistence failures, verification durability, and side-effect counts.

---

## Sprint 4C.4 — Rollback Durability Final Seal & Permanent Closure

Sprint 4C.4 seals rollback durability so that rollback operations provide the exact same fail-closed write-ahead durability, persistence guarantees, and restart reconciliation as forward mutations.

1. **Required Durability Dependencies & Elimination of Non-Durable Mode:**
   - In `RollbackManager` (`rollback.ts`), `operationJournal` and `checkpointStore` are mandatory dependencies in `RollbackManagerOptions`.
   - Non-durable rollback mode is completely eliminated.
   - If durability dependencies are missing or uninitialized, `executeRollback` fails closed immediately (`status: "FAILED"`, `durabilityFailure: true`) with 0 reverse `MutationEngine` invocations and 0 disk writes (`T-5200` - `T-5202`).

2. **Fail-Closed Journal History Read:**
   - Removed `.catch(() => [])` silent fallback when querying operation journal history (`getAllOperations(runId)`).
   - If journal history lookup fails (e.g. disk corruption, parse error), rollback fails closed immediately (`status: "FAILED"`, `durabilityFailure: true`) with 0 reverse `MutationEngine` calls, 0 PREPARED operations recorded, and 0 workspace modifications (`T-5203` - `T-5204`).

3. **6-Phase Durable Success Lifecycle:**
   - Every durable rollback strictly follows the sequence:
     `Rollback requested -> Durability dependencies confirmed -> Journal history read successfully -> Rollback PREPARED durable -> Rollback STARTED durable -> MutationEngine reverse mutation -> Rollback COMPLETED durable -> ROLLBACK_COMPLETED checkpoint durable -> Only then report durable rollback success`.
   - Any failure prior to reverse mutation halts execution with 0 reverse `MutationEngine` calls.

4. **Post-Write Checkpoint Persistence Failure Semantics:**
   - If the reverse mutation write succeeds on disk and `recordCompleted` succeeds, but `saveCheckpoint` for `ROLLBACK_COMPLETED` throws:
     Removed `.catch(() => {})`. The rollback manager returns `status: "RECOVERY_REQUIRED"`, `recoveryRequired: true`, `durabilityFailure: true`, `durableSuccess: false`, `success: false`.
     No same-process replay is attempted. Truthful restart reconciliation resolves state (`T-5209` - `T-5210`).

5. **`recordFailed()` Persistence Failure Semantics:**
   - If reverse mutation write fails and `recordFailed()` persistence also fails:
     Removed `.catch(() => {})`. Rollback fails closed with `status: "RECOVERY_REQUIRED"` and `error: "RECOVERY_PERSISTENCE_FAILED: ..."`.
     The journal entry remains conservatively `STARTED` rather than falsely `FAILED`. Execution halts immediately (0 new side effects), and restart reconciliation safely marks the operation `NOT_APPLIED` without automatic replay (`T-5212` - `T-5213`).

6. **Exactly-Once Reconciliation & Duplicate Write Prevention:**
   - Completed rollback operations replay with 0 reverse calls.
   - `STARTED` + restored state reconciles to `RECONCILED_APPLIED` with 0 duplicate reverse calls.
   - `STARTED` + not-restored state reconciles to `RECONCILED_NOT_APPLIED` with 0 automatic replay.
   - `STARTED` + modified state triggers `BLOCKED_DIVERGENCE` / `DIVERGED` with 0 reverse calls.

7. **Strict Analytics & Evidence Truth:**
   - `RollbackMetrics` tracks `rollbackAttempts`, `rollbackSuccesses`, `rollbackFailures`, `rollbackDurabilityFailures`, `rollbackReconciledApplied`, `rollbackReconciledNotApplied`, `rollbackDuplicateWritesPrevented`.
   - Zero raw preimage data is leaked into telemetry, logs, or analytics.

8. **Expanded Deterministic Evaluation Suite (117 Scenarios Across 21 Categories):**
   - `recovery-evaluation-harness.ts` expanded to **117 scenarios** across 21 categories (adding Category 20: `ROLLBACK_DURABILITY_SEAL` covering scenarios 111–117).
   - Evaluates with 100% pass rate and 100% two-run determinism using strict deep equality comparator with zero fake passes.
   - Negative comparator suite expanded to 18 negative tests asserting discrepancies across all rollback durability failure modes.

9. **Sprint 4C Permanent Closure:**
   - Sprint 4C, 4C.1, 4C.2, 4C.3, and 4C.4 are PERMANENTLY CLOSED.
   - Roadmap canonically advances to Sprint 4D — Performance & Large Repositories.
