# ADR 013: Bounded Session Continuity

## Status
Accepted

## Context
When an agent operates in distinct CLI modes (ASK, PLAN, BUILD, DEBUG) or across separate CLI invocations, it lacks memory of prior actions unless the full unbounded transcript is provided. Supplying full transcripts scales linearly with session count and rapidly blows out context windows, resulting in irrelevant distractors, high latency, and memory corruption. We need a way to preserve continuity between tasks (like BUILD then DEBUG) without providing the unbounded conversation transcript.

## Decision
We implement **Bounded Session Continuity** via `SessionSummaryStorage` and `MemoryRetriever`.
1. **Atomic Log:** Every completed or failed session writes a bounded JSON summary to `.open-vs-code/sessions.jsonl`.
2. **Redaction:** Secrets (passwords, tokens, keys) are regex-redacted before appending to ensure no sensitive credentials bleed into memory across sessions.
3. **Retrieval Selection:** Before context compilation, the `MemoryRetriever` ranks past sessions by term overlap with the current task instruction and mode relevance. Only the top N bounded summaries (up to 5) that fit within the global token budget (e.g., 15000 tokens) are injected into the agent's context.
4. **Markdown Primacy:** Session continuity never overrides explicitly provided canonical markdown rules or constraints. `ProjectMemorySnapshot` ensures `PLAN.md` and active tasks have priority (Tier 1) over historical summaries (Tier 3).
5. **No Full Transcripts:** The internal event stream is strictly discarded between sessions; only the deterministic, structured `SessionSummary` bridges the gap.

## Consequences
* **Pros:** Strict token budgets are respected across sessions. Irrelevant history is ignored. Long-lived projects won't hit context limits due to transcript accumulation.
* **Cons:** Granular, step-by-step reasoning details are lost between sessions. If a user asks "why did you specifically write line 45 in the last session?", the agent won't know unless it can deduce it from the codebase or the high-level summary.
