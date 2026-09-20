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

Sprint 3D — Controlled Terminal UX ✅ CLOSED

- Phase A (Sprint 2): Core capabilities, Project Memory, Skills, MCP, Provider Routing.
- Phase B (Sprint 3A-3B): IDE Adapter and Chat UX.
- Phase C (Sprint 3C): Diff Review Safety & Closure.
- Phase D (Sprint 3D): Controlled Terminal UX & Review Boundary. 100% deterministic test evaluations passed.
- Next: Sprint 3E — Autocomplete → NEXT
