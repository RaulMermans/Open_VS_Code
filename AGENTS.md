# Agent Operating Guide

## Workflow

For every task:

1. Read `PROJECT.md`.
2. Read `PLAN.md`.
3. Read only the Markdown relevant to the task.
4. Inspect the existing implementation before editing.
5. Search the repository before creating abstractions.
6. Make the smallest coherent diff.
7. Test the change.
8. Inspect the diff.
9. Update project state when a meaningful decision or status changes.

## Context discipline

- Markdown files are the durable project brain; consult them before assuming behavior.
- Do not load every Markdown file automatically. Search headings and keywords first.
- Prefer targeted paths, symbols, snippets, and line ranges over whole-file reads.
- Do not repeatedly reread unchanged large files.
- Summarize stale tool output in project Markdown instead of carrying it indefinitely.
- Keep each task and session focused and token-efficient.

## Reuse first

Before implementing a major feature:

1. Consult `REFERENCE_MAP.md`.
2. Inspect the most relevant upstream implementation.
3. Classify the candidate as `KEEP`, `ADAPT`, `EXTRACT`, `REFERENCE_ONLY`, or `BUILD`.
4. Record consequential reuse and licensing decisions.

Never copy code without checking its license, dependencies, coupling, maintenance, portability, and attribution requirements.

## Safety

- Never expose secrets.
- Never run destructive commands without explicit approval.
- Do not push, deploy, delete branches, rewrite history, or alter system configuration unless authorized.
- Keep work inside this repository, except isolated read-only upstream research.
- Prefer reversible changes and Git checkpoints.

## Engineering hygiene

- Keep one authoritative implementation per concern.
- Do not add duplicate compatibility paths without an explicit reason.
- Keep dead experiments out of canonical directories.
- Justify every dependency.
- Add tests for behavior changes.
- Record architecture changes in an ADR.

