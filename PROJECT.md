# Project

## North star

> A private, local-first AI coding environment combining Cursor-like editor UX with Claude-Code-like agent workflows, optimized for open-weight models running on the user's own hardware.

## Product frame

- Initial user: single local user.
- Archetype: experimental -> MVP -> personal production tool.
- Strategy: reuse proven open-source infrastructure before building replacements.

## Primary constraints

- Local-first and private by default.
- Minimal or no recurring inference cost.
- No mandatory cloud backend.
- Strong UX with token-efficient local inference.
- Editor-independent agent core and provider-neutral model access.
- Maintainable upstream and licensing strategy.

## Early non-goals

- Training models.
- Building an editor engine or inference runtime.
- Multi-agent orchestration.
- Cloud accounts, billing, or enterprise collaboration.
- Custom vector-database infrastructure.
- Rebuilding standard IDE infrastructure.

## Current sprint

Sprint 1H — Safe Mutation Layer. Status: **complete**.

- 161 deterministic tests passing.
- Safe `apply_patch` and `create_file` tools behind CONFIRM permission gates.
- Atomic writes, rollback, stale-base detection, symlink-escape prevention.
- ASK/PLAN/REVIEW modes deny all mutations; BUILD/DEBUG require confirmation.
- No model weights on development machine; inference deferred to target machine.
