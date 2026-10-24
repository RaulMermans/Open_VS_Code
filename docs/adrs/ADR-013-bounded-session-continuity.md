# ADR 013: Bounded Session Continuity

## Status
Accepted

## Context
When an agent operates in distinct CLI modes (ASK, PLAN, BUILD, DEBUG) or across separate CLI invocations, it lacks memory of prior actions unless the full unbounded transcript is provided. Supplying full transcripts scales linearly with session count and rapidly blows out context windows, resulting in irrelevant distractors, high latency, and memory corruption. We need a way to preserve continuity between tasks (like BUILD then DEBUG) without providing the unbounded conversation transcript.

## Decision
We implement **Bounded Session Continuity** via `SessionSummaryStorage` and `MemoryRetriever`.
1. **Atomic Log:** Every completed or failed session writes a bounded JSON summary to `.open-vs-code/sessions.jsonl`.
2. **Hard Bounds:** The system enforces strict deterministic storage limits: max session bytes (16 KB), total storage bytes (512 KB), retained sessions (50), and restored sessions (5). A separate retrieval budget restricts total memory injection.
3. **Freshness Strategy:** Canonical Markdown files (`PLAN.md`, `AGENTS.md`, etc.) are reread from disk on each memory load/session bootstrap. There is no parsed-memory cache and no SHA-256 hash invalidation—current source is authoritative on every load.
4. **Current Authority:** Historical session context never overrides authoritative current facts. Stale directive fields (like `nextAction`) are prevented from competing with current authority. Historical sessions are strictly subordinate to current canonical Markdown. If a historical session duplicates or conflicts with current canonical Markdown, it is suppressed deterministically via fingerprinting during retrieval. No semantic LLM judge is used for conflicts.
5. **Validation and Corruption Safety:** `SessionSummary` entries are validated before retrieval. Incomplete legacy entries are either safely normalized or rejected. Malformed JSONL entries are isolated on read. Unresolved file corruption causes future writes to fail closed (refusal to append), preserving the original file state. Crucially, this memory corruption blocks memory writes but does not invalidate the outcome of a successful coding task.
6. **Redaction:** Secrets (passwords, tokens, keys, and authorization credentials) are fully regex-redacted across all free-form fields (`task`, `nextAction`, `verification`, `decisions`, `unresolvedIssues`) before appending to ensure no sensitive credentials bleed into memory across sessions.
7. **No Full Transcripts:** The internal event stream is strictly discarded between sessions; only the deterministic, structured `SessionSummary` bridges the gap.
8. **Local-First / No Vector Database:** Memory remains strictly local-first. We use local JSONL storage only. There is no vector database, no pgvector, and no embeddings.

## Consequences
* **Pros:** Strict token budgets are respected. Current Markdown is always the source of truth. Corruption cannot silently wipe out history.
* **Cons:** Granular, step-by-step reasoning details are lost between sessions.

## Sprint 7C note — not conversation history

Sprint 7C added visible, per-workspace conversation history (ADR-033). It is a separate store in VS Code's workspace storage. It never reads or writes `.open-vs-code/sessions.jsonl`. `SessionSummaryStorage` remains the only bounded agent-memory continuity mechanism, and its bounds, freshness and authority rules above are unchanged.
