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
- **Discovery reads zero file content bytes**: only filesystem metadata (`stat`) is examined during discovery (strictly verified across 25,000+ indexable files: `contentBytesRead = 0`).
- Directory entries and discovered files are canonically sorted lexicographically, ensuring 100% deterministic discovery ordering across filesystems and runs.
- Incremental updates (`recordFileChange`, `recordFileDelete`) update in-memory metadata without requiring full repository scans.
- Event storm processing (`processEventStorm`) coalesces rapid file change events by path within a 50ms window.
- Files exceeding `LARGE_FILE_THRESHOLD_BYTES` (128 KB) and binary file extensions/null bytes are classified during metadata generation and excluded from naive broad scans.

### 2. Search Bounds, Worker Pool & Diversity
- `RepositorySearch` enforces strict caps:
  - `maxResults` (default 50)
  - `maxMatchesPerFile` (default 5) to prevent a single generated/large file from monopolizing search results
  - `maxSnippetChars` (default 300)
  - `maxTotalPayloadBytes` (default 32 KB)
- **Production Bounded Concurrency**: Candidate files are processed through a bounded worker pool feeding tasks through `AsyncSemaphore`, strictly maintaining `peakActive <= maxConcurrency` and `peakQueued <= maxQueued`.
- Matches are buffered and committed in strict candidate index order, guaranteeing deterministic search results across concurrent workers.
- Identical concurrent queries are deduplicated via `searchCoalesced()`.
- Rapid query storms are managed via `SearchCoordinator.searchLatest()`, which cleanly aborts superseded searches and returns uncontaminated results for the latest query.
- Skips binary and overly large files from full-content text scanning.
- Supports cancellation via standard `AbortSignal`.

### 3. Context Compiler & Streaming Chunk-Based Line Reads
- **Context size depends strictly on the task, never on the repository size.**
- `compileContext` enforces strict token budgets via `fitContext`.
- **Truly Bounded File Reading (`readRepositoryFile`)**: Eliminates naive `readFile(entire file)` buffer allocation. Uses a chunk-streaming line reader (`open("r")`, `StringDecoder("utf8")`, chunk-by-chunk scanning):
  - Samples first 8 KB for binary null bytes **by inspecting bytes already loaded**, eliminating a prior separate offset-zero sample read:
    - *Full-file reads:* binary detection uses the already-read `contentBuf` — no extra read.
    - *Ranged reads:* binary detection uses the first `min(bytesRead, 8192)` bytes of the first streaming chunk — no extra read. `bytesReadFromFile` counts ALL and ONLY `handle.read()` calls; no hidden reads.
  - Enforces strict UTF-8 byte ceilings using `truncateUtf8ToBytes(text, maxBytes)`, ensuring byte ceilings are calculated via `Buffer.byteLength(..., "utf8")` rather than JavaScript `string.length` or UTF-16 code units.
  - **Hard `maxBytes` ceiling includes truncation marker (Sprint 4D.3):** When truncation occurs, a `\n[TRUNCATED]` marker (12 UTF-8 bytes) is reserved from the `maxBytes` budget before data is collected: `dataBudget = maxBytes - 12`. `Buffer.byteLength(returnedContent, "utf8") <= maxBytes` is **always** guaranteed, including the marker. For `maxBytes < 12`, no marker is appended; an empty string is returned with `truncated: true`.

  - Guarantees Unicode integrity: emojis, CJK, and accented characters are never split into isolated surrogates or replacement characters (`\uFFFD`).
  - Handles CRLF and UTF-8 multibyte characters cleanly across chunk boundaries without stray `\r`.
  - Halts file I/O immediately upon reaching `endLine` or output size ceilings, proving `bytesReadFromFile << totalFileBytes` with zero full-file buffer allocation (e.g. reading 65,536 bytes from an actual 5,000,000-byte fixture — `bytesReadFromFile = 65,536`, not 65,536 plus a hidden 8 KB sample).
  - Exposes measured I/O telemetry: `fileSizeBytes`, `bytesReadFromFile`, `chunksRead`, `returnedBytes`, `wholeFileBuffered: false`, `truncated`.


### 4. Bounded Concurrency & Waiting Queue (`AsyncSemaphore`)
- `AsyncSemaphore` bounds active tasks to `maxConcurrency` and waiting tasks to `maxQueued`.
- Configurable overflow policies:
  - `reject_new`: Rejects immediately with `SemaphoreQueueFullError` when queue is full.
  - `cancel_oldest`: Evicts the oldest queued waiter with an abort error to accommodate incoming priority work.
- Queued task cancellation via `AbortSignal` safely removes the waiter from the queue without consuming running slots or leaking listener references.
- Instruments `peakRunning` and `peakQueued` metrics for verification truth.

### 5. Bounded LRU Cache & Invalidation
- `BoundedLruCache` enforces both `maxEntries` and `maxBytes` ceilings.
- Deterministic LRU eviction occurs whenever entries or retained bytes exceed configured thresholds.
- Safe invalidation: mutating or deleting a file purges the cache key immediately.

### 6. Runtime Eval Scalability & Evidence Compaction
- Runtime evaluations run continuously across every action.
- Repetitive identical tool failures are compacted in `RuntimeEvidenceCollector`: structured signatures aggregate count, timestamps, and representative bounded snippets rather than accumulating duplicate megabyte payloads.
- L0 deterministic and L1 heuristic evaluators retain full adaptive-control fidelity (preserving all 8 decisions: `CONTINUE`, `VERIFY`, `REVISE`, `REPLAN`, `STOP`, `ASK_HUMAN`, `REQUEST_MORE_CONTEXT`, `CHANGE_MODEL`) over compacted evidence without information loss.

### 7. Durable Recovery Performance Without Authority Degradation
- The durable write-ahead journal (`operations.jsonl`) and checkpoint files (`cp_*.json`) remain the **sole authoritative sources of truth**.
- `OperationJournal` writes entries using explicit `FileHandle.appendFile()` followed by `FileHandle.sync()`. If physical synchronization fails, the file is truncated back to its pre-append length to fail closed without leaving unpersisted corrupt state.
- Secondary in-memory lookup indexes (`#indexCache` in `OperationJournal` and `#metadataIndex` in `CheckpointStore`) accelerate lookups.
- Indexes are strictly non-authoritative and safely rebuildable at any time from disk without data loss, duplicate writes, or reconciliation divergence.
- **In-process Corruption Tracking (Sprint 4D.3):** A `#corruptedRuns` `Set<string>` in `OperationJournal` records runs whose journal was found corrupt during the current process session. `getOperation()` checks this set before serving from cache — preventing warm-cache reads from bypassing a known disk-integrity failure. `rebuildIndex()` clears both the cache and the corruption set, allowing deliberate fresh re-validation.
- **Performance Summary Export (Sprint 4D.3):** `runPerformanceEvaluation()` returns a typed `PerformanceEvaluationSummary` struct containing all key measured metrics (`filesIndexed`, `directoriesVisited`, `bytesReadFromFile`, `chunksRead`, `returnedBytes`, etc.). The `FINAL_REPORT.txt` validator consumes this summary directly, comparing reported values against measured values — no hardcoded constants are duplicated in the validator.


### 8. Large Diff & Terminal Stream Ceilings
- Diff generation in `MutationEngine` bounds unified diffs to `maxDiffBytes` with explicit truncation markers, preserving patch approval identity.
- Terminal streams and subprocess verification enforce strict buffer ceilings (16 KB) with clean UTF-8 truncation boundaries, avoiding multi-megabyte memory accumulation.

---

## Consequences

- **Responsiveness**: Operations across small, medium, and large repositories (25,000+ files) complete with bounded latency.
- **Memory Predictability**: Process memory stabilizes and does not scale linearly with repository size.
- **Fail-Closed Durability**: Rollback, recovery, and security boundaries remain completely uncompromising with physical fsync durability.
- **Backpressure & Concurrency Stability**: Workload bursts and file storms are bounded and deduplicated without unhandled promise accumulation.
- **No Premature Databases**: All optimizations are implemented with inspectable, native TypeScript/Node.js primitives without external database dependencies.

---

## Sprint 7D amendment — IDE responsiveness

Sprint 4D bounded the agent side (discovery, search, reads, journals). Sprint 7D measured the editor side against a baseline (`evals/results/sprint-7d/`) and changed only what the measurements showed:

| Path | Finding | Decision |
| :--- | :--- | :--- |
| Editor events → chat | Every cursor move, selection or diagnostics change posted the whole chat state (≈ 204 KB with a full transcript) and rebuilt parts of the page | Identical context posts nothing; editor events coalesce to one snapshot in flight plus one trailing refresh |
| Agent events → chat | Each event re-sent the transcript | `chat.state` omits an unchanged transcript (ADR-018, Sprint 7D) |
| Webview page | Unchanged pushes rebuilt the timeline, chips, connection status and approval card, and forced a scroll | Per-section signatures; scroll follows only a reader at the bottom |
| Autocomplete | Each keystroke copied the whole document twice before the debounce | Copy a bounded window (prefix ceiling + suffix ceiling + 16); the built context is identical |
| History store | Over the byte cap, one full serialise + hash per dropped message | One-pass cut (ADR-033, Sprint 7D) |
| Activity timeline | Pending model rows were never resolved and escaped the 50-row bound | Resolve in place; hard bound |

Not changed, because the measurements did not justify it: ASCII history saves (≈ 3 ms of CPU; the rest is off-thread `fsync`), index rebuild (only after damage), terminal streaming (already bounded and incremental since 7B), and a keyed activity list (≈ 60 small elements per changed push).

Observability stays bounded: `ChatController.uiMetrics` is a fixed set of numeric counters in memory, never persisted, logged or used for decisions. Autocomplete latency remains in `ModelPerformanceLedger`; model latency, tokens/s and completion quality remain deferred to HALO.
