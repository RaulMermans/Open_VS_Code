# ADR-010: Evidence-Driven Agent Orchestration for Open-Weight Models

## Status

Accepted

## Context

In Sprint 1E and 1F, baseline evaluations of Qwen2.5-Coder-7B (4-bit quant via local Ollama) against our 24-case read-only benchmark demonstrated an initial 37.5% grounded-completion rate. The primary failure modes of local 7B open-weight models were empirical:
1. **Premature Completion**: Generating direct answers based on training memory or parameter hallucinations before gathering repository evidence via tools.
2. **Tool Schema Distraction**: Supplying 4+ generic tools led to ambiguous tool selection and unnecessary directory traverses.
3. **Turn Budget Exhaustion (`MAX_TURNS`)**: The model would collect evidence but keep calling tools because it lacked clear completion signals upon gathering sufficient proof.

We needed to improve open-weight agent reliability to $\ge 65\%$ grounded completion without adding file write capabilities, terminal execution, larger models, proprietary fallbacks, or hidden retries.

## Decision

We introduce an evidence-first orchestration architecture in `@open-vs-code/agent-core`:

1. **Task Investigation Profiles (`TaskProfile`)**: Deterministic task classification mapping user instructions into 1 of 10 task categories with tailored investigation strategies, adaptive turn budgets (4–6 turns), and narrowed tool schemas (`allowedTools`) restricted to the top 2–3 relevant tools.
2. **Evidence Requirements & Evidence Ledger (`EvidenceLedger`)**: Explicit evidence requirement contracts immutably tracking file reads, searches, directory listings, and matching explicit file paths with basename resilience.
3. **Premature-Answer Gate**: If a model emits 0 tool calls when mandatory repository evidence is unsatisfied, the runner rejects completion (up to 2 continuations), providing structured `[EVIDENCE REQUIRED]` feedback.
4. **Recency Completion Guidance**: When evidence requirements are satisfied, a clear prompt suffix is placed at the end of the compiled prompt instructing the model to stop calling tools and provide its final grounded answer.
5. **Progress Hashing & Loop Prevention**: Normalized signature and content hashing prevents repetitive tool loops, terminating stalled tasks cleanly.

## Consequences

### Positive
- Overall grounded-completion rate on the fixed 24-task benchmark increased from **37.5% to 75.0%** (18/24 tasks).
- Dev Split pass rate reached **70.0%** (14/20 tasks).
- Held-Out Split pass rate reached **100.0%** (4/4 tasks with zero tuning contamination).
- Correct Tool Selection reached **95.8%**.
- Premature completions were eliminated (**0.0%**).
- 103 deterministic unit tests pass with zero network dependency.

### Negative / Trade-offs
- Task classification relies on regex heuristics which must be kept updated for new specialized query formats.
- Complex cross-file reasoning involving 4+ files without intermediate scratchpad remains at the parameter capability ceiling of 7B dense models.
