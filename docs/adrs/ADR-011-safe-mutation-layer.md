# ADR-011: Safe Mutation Layer

**Status**: Accepted  
**Date**: 2026-08-27  
**Sprint**: 1H — Safe Mutation Layer

## Context

The agent core had comprehensive read-only repository tools but no ability to modify files. To become a useful coding agent, it needs write capabilities. However, uncontrolled file mutation by an AI model is dangerous — it can corrupt files, escape the workspace, or make irreversible changes.

## Decision

We implement a safe mutation layer with two initial operations (`apply_patch`, `create_file`) behind strict boundaries:

1. **Prepare/apply separation** — Mutations are prepared (validated, diffed) before the permission gate, then applied only after explicit human approval.
2. **Atomic writes** — All file writes go through a temp file + rename pattern to prevent partial writes.
3. **Expected-base hash verification** — Before applying, the engine re-reads the file and verifies its SHA-256 matches the hash at preparation time. Stale-base detection prevents blind overwrites.
4. **Search/replace patching** — `apply_patch` uses exact search text matching (not line-based diff) with ambiguity rejection (search text must appear exactly once).
5. **Write-path safety** — Symlink-escape detection, workspace containment, and parent directory validation for new files.
6. **Sensitive-path policy** — `.git/`, `node_modules/`, `.env`, credential files are denied by default.
7. **Mutation budgets** — Per-step limits on files (3), added lines (200), removed lines (100), changed bytes (10K), new file size (8K), diff size (16K).
8. **Pre-mutation snapshots** — Full file content is captured before mutation, enabling rollback if the file hasn't been further modified.
9. **Mode-aware permissions** — ASK, PLAN, REVIEW modes deny all mutations. BUILD and DEBUG require CONFIRM (human approval). Write default is never ALLOW.
10. **Bounded observations** — Model sees only compact mutation results (path, operation, line counts, hash prefix), not full file contents.

## Alternatives Considered

- **Simple write_file(path, content)**: Rejected — no diff, no rollback, no stale-base protection.
- **Git-based patches**: Rejected — adds Git dependency, complex for single-change operations.
- **Line-based diff application**: Rejected — fragile with whitespace/encoding, harder for models to use correctly.

## Consequences

- Two new tool registrations (`apply_patch`, `create_file`) integrate through the existing ToolRegistry and AgentRunner confirmation flow.
- No new dependencies added. Uses only `node:fs`, `node:path`, `node:crypto`.
- No terminal, shell, or child_process capabilities added.
- `create_file` rejects if the target already exists — no silent overwrites.
- Real-model mutation validation is deferred to the target inference machine.

## Revisit Triggers

- Need for `delete_file`, `rename_file`, or `move_file` operations.
- Need for multi-file atomic transactions (currently limited to 3 files per step).
- Need for model to directly specify unified diff format instead of search/replace.
- Performance concerns with SHA-256 hashing on large files.
