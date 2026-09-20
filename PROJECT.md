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

Sprint 3D ✅ CLOSED PERMANENTLY (Sprint 3D.1 — Terminal Runtime Truth, Sprint 3D.2 — Execution Identity & Deactivation Closure completed)

- Phase A (Sprint 2): Core capabilities, Project Memory, Skills, MCP, Provider Routing.
- Phase B (Sprint 3A-3B): IDE Adapter and Chat UX.
- Phase C (Sprint 3C): Diff Review Safety & Closure.
- Phase D (Sprint 3D): Controlled Terminal UX & Review Boundary. 100% deterministic test evaluations passed.
- Phase D.1 (Sprint 3D.1): Terminal Runtime Truth. Live output streaming, UTF-8 safety, bounded prefix buffer, PREPARED state removal, fail-closed validation, bounded registry, deterministic process group cleanup proofs. 59 terminal scenarios, 318 total tests pass. ✅ CLOSED.
- Phase D.2 (Sprint 3D.2): Execution Identity & Deactivation Closure. Canonical execution identity preserved end-to-end (verificationId = executionId), exact ID routing without fallback, real deactivation process tree termination without prior manual cancel, post-deactivation registry flush. 79 terminal scenarios, 318 total tests pass. ✅ CLOSED PERMANENTLY.
- Next: Sprint 3E — Autocomplete → NEXT
