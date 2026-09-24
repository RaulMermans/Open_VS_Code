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
- **Append-only storage:** Never rewritten in place; updates append a new entry with the updated status (`PREPARED -> STARTED -> COMPLETED | FAILED | INTERRUPTED`).
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

