# ADR-026 — Large-Repository Performance & Hardening

**Status:** ACCEPTED  
**Sprint:** 4D — Performance & Large Repositories  
**Date:** 2026-09-25

---

## Context

Prior sprints (Sprint 2A through 4C) established a robust, security-hardened, and crash-recoverable local agent architecture:
- Project Memory and Skills (Sprint 2A, 2B)
- Safe tool registries and MCP runtime (Sprint 2C)
- Deterministic model provider routing (Sprint 2D)
- Multi-mode editor UX: Chat, Diff/Edit, Controlled Terminal, Autocomplete (Sprint 3A-3E)
- Security boundaries, containment, and least-privilege controls (Sprint 4A)
- Continuous runtime evaluations and adaptive control loops (Sprint 4B)
- Durable write-ahead checkpoints, write-ahead journaling, and fail-closed rollback (Sprint 4C)

However, prior to Sprint 4D, several system assumptions relied on small to medium repositories:
1. Workspace discovery walked whole repositories recursively on demand.
2. Search traversed candidate files by loading whole files into memory.
3. Long-running sessions and repeated errors accumulated unbounded telemetry and ledger entries.
4. Recovery journals and checkpoint directories were parsed and deserialized in full on every lookup.
5. Large diff presentations and large terminal output streams risked unbounded memory retention.
6. File operations lacked bounded concurrency ceilings and explicit cancellation handling.

Sprint 4D hardens the entire system against large repositories (25,000+ files) by establishing strict architectural bounds, progressive disclosure, lightweight indexing, and compaction—without weakening any security, durability, or runtime-eval invariants.

---

## Architectural Principles & Invariants

```
LARGE REPOSITORY
      ↓
Incremental Discovery (ignore rules, no content bytes read during metadata discovery)
      ↓
Bounded Repository Index (lightweight metadata: path, size, mtime, binary/large flags)
      ↓
Targeted Retrieval & Search (result cap, file diversity cap, snippet ceiling, payload ceiling)
      ↓
Bounded Context Compiler (independent of repository size; strict token/char budget)
      ↓
Agent Execution (bounded concurrency semaphore, cancellation via AbortSignal)
      ↓
Bounded Runtime Evidence (compaction of repetitive failures, secret redaction)
      ↓
Bounded Durable Recovery (secondary rebuildable index; authoritative durable source of truth)
```

### 1. Incremental Discovery & Default Ignore Policy
- `RepositoryDiscovery` discovers workspace files using bounded concurrency (`AsyncSemaphore`) and canonical ignore rules (`.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.cache`, `.turbo`, `.checkpoints`).
- **Discovery reads zero file content bytes**: only filesystem metadata (`stat`) is examined during discovery.
- Incremental updates (`recordFileChange`, `recordFileDelete`) update in-memory metadata without requiring full repository scans.
- Files exceeding `LARGE_FILE_THRESHOLD_BYTES` (128 KB) and binary file extensions/null bytes are classified during metadata generation and excluded from naive broad scans.

### 2. Search Bounds & Diversity
- `RepositorySearch` enforces strict caps:
  - `maxResults` (default 50)
  - `maxMatchesPerFile` (default 5) to prevent a single generated/large file from monopolizing search results
  - `maxSnippetChars` (default 300)
  - `maxTotalPayloadBytes` (default 32 KB)
- Skips binary and overly large files from full-content text scanning.
- Supports cancellation via standard `AbortSignal`.

### 3. Context Compiler Invariant
- **Context size depends strictly on the task, never on the repository size.**
- `compileContext` enforces strict token budgets via `fitContext`.
- Bounded file reading (`readRepositoryFile`) supports targeted line ranges (`startLine`, `endLine`) allowing slices of large files to be read safely without loading entire datasets.

### 4. Bounded LRU Cache & Invalidation
- `BoundedLruCache` enforces both `maxEntries` and `maxBytes` ceilings.
- Deterministic LRU eviction occurs whenever entries or retained bytes exceed configured thresholds.
- Safe invalidation: mutating or deleting a file purges the cache key immediately.

### 5. Runtime Eval Scalability & Evidence Compaction
- Runtime evaluations run continuously across every action.
- Repetitive identical tool failures are compacted in `RuntimeEvidenceCollector`: structured signatures aggregate count, timestamps, and representative bounded snippets rather than accumulating duplicate megabyte payloads.
- L0 deterministic and L1 heuristic evaluators retain full adaptive-control fidelity (REVISE, REPLAN, STOP, etc.) over compacted evidence without information loss.

### 6. Durable Recovery Performance Without Authority Degradation
- The durable write-ahead journal (`operations.jsonl`) and checkpoint files (`cp_*.json`) remain the **sole authoritative sources of truth**.
- Secondary in-memory lookup indexes (`#indexCache` in `OperationJournal` and `#metadataIndex` in `CheckpointStore`) accelerate lookups.
- Indexes are strictly non-authoritative and safely rebuildable at any time from disk without data loss, duplicate writes, or reconciliation divergence.

### 7. Large Diff & Terminal Stream Ceilings
- Diff generation in `MutationEngine` bounds unified diffs to `maxDiffBytes` with explicit truncation markers, preserving patch approval identity.
- Terminal streams and subprocess verification enforce strict buffer ceilings (16 KB) with clean UTF-8 truncation boundaries, avoiding multi-megabyte memory accumulation.

### 8. Concurrency & Lifecycle Hygiene
- Fan-out operations are throttled via `AsyncSemaphore`.
- All disposable resources, abort signals, and controllers release cleanly upon extension/session disposal.

---

## Consequences

- **Responsiveness**: Operations across small, medium, and large repositories complete with bounded latency.
- **Memory Predictability**: Process memory stabilizes and does not scale linearly with repository size.
- **Fail-Closed Durability**: Rollback, recovery, and security boundaries remain completely uncompromising.
- **No Premature Databases**: All optimizations are implemented with inspectable, native TypeScript/Node.js primitives without external database dependencies.
