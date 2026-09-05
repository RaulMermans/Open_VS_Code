---
name: change-with-tests
description: Implement one bounded repository change with verification and a reviewable diff. Use for features, fixes, refactors, configuration changes, or documentation behavior changes after project context and existing patterns have been inspected.
---

# Change With Tests

Keep the change small enough to understand, verify, and revert.

## Define the change

Before editing, state:

- target outcome and acceptance criteria;
- bounded file scope;
- existing pattern to reuse;
- test strategy and regression risk.

If the outcome requires a new architectural decision or dependency, stop and record the justification before implementation.

## Workflow

```text
read relevant Markdown
  -> inspect current code
  -> search existing patterns
  -> define minimal change
  -> implement
  -> test
  -> inspect diff
  -> update project memory if needed
```

1. Read `PROJECT.md`, `PLAN.md`, and only task-relevant project memory.
2. Inspect the implementation and nearby tests before changing it.
3. Search for an authoritative existing abstraction or pattern.
4. Add or update a focused test that demonstrates the requested behavior when executable behavior changes.
5. Implement the minimum coherent change.
6. Run the focused test, then the narrowest relevant broader checks.
7. Inspect the complete diff for accidental edits, secrets, dead paths, and architecture drift.
8. Update plans, ADRs, or operational notes only when status or durable knowledge changed.

## Handoff

Report the outcome, files changed, tests and results, regression risks, diff summary, and any remaining work. Never claim success without current verification output.

