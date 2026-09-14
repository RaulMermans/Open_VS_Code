# ADR-019: Diff / Edit Review Boundary

## Context
We need a robust architectural boundary for file mutation reviews in the IDE, to separate the agent's proposed changes from actual filesystem application, and to ensure users can safely review, approve, reject, or cancel mutations in a deterministic and bounded way.

## Decision
- **PreparedMutation**: Acts as the sole source of proposal truth. It captures the exact before and proposed contents and their hashes.
- **MutationEngine**: Acts as the sole write authority. It handles applying the mutation atomically and refuses to apply if the underlying file has changed (stale base).
- **DiffReviewController**: Handles presentation only. It serves virtual documents (`open-vs-code-diff:`) for native `vscode.diff` rendering. It stores review states (e.g. `PREPARED`, `APPLIED`, `REJECTED`, `STALE`, `CANCELLED`) and handles terminal cleanup.
- **Strict contents**: Review cards and native diffs use the exact before/proposed content from `PreparedMutation`. No model calls or re-reads occur for viewing diffs.
- **Terminal Cleanup**: Reviews are kept bounded (max 20 count, 5 MB retained content). Upon a terminal state (`APPLIED`, `REJECTED`, `STALE`, `FAILED`, `CANCELLED`, or New Chat), the review is disposed and content is released.
- **Stale Refusal and Auto-Rebase**: If a file changes externally while a review is pending, `MutationEngine` will reject the application as `STALE`. We strictly do *not* automatically rebase patches or silently retry to avoid safety issues.
- **Dirty-Editor Policy**: Diffs cannot be approved if the target file has unsaved editor changes. We block approval to prevent conflicts.

## Consequences
- Guaranteed safety against stale changes and unauthorized side-effects.
- No model calls are wasted on diff viewing.
- The boundary clearly demarcates the end of Sprint 3C, setting up a solid foundation for Controlled Terminal UX in Sprint 3D.
