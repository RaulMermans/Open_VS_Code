# ADR-006: Progressive disclosure and token budgeting

**Status:** Provisional

## Context

Local models have constrained context, latency, and memory. Loading an entire repository or all skills reduces answer quality and wastes compute.

## Decision

Discover context from compact metadata, then retrieve targeted files, symbols, sections, or skills under an explicit token budget.

## Rationale

Progressive disclosure preserves room for reasoning and output while making local inference faster and more predictable.

## Consequences

- Context selection and provenance become first-class components.
- Retrieval misses must be observable and correctable.
- Summaries require invalidation when source material changes.

## Alternatives

- Always load the full repository.
- Depend on a custom vector database from the start.
- Leave context selection entirely to the user.

## Revisit triggers

Measured tasks show targeted retrieval consistently omits necessary context, or new model/runtime constraints materially change the trade-off.

