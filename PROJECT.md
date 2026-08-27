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

Sprint 1I — Controlled Verification Runtime. Status: **complete**.

- 174 deterministic tests passing.
- Phase A (Sprint 1H.1): Prepared-Diff Approval Safety Fix applied to mutations.
- Phase B (Sprint 1I): Safe verification engine (TEST, TYPECHECK, LINT, BUILD) with workspace containment, output bounding (16KB), and strict timeouts.
- Zero arbitrary shell command tools. Verification strictly reads `package.json` presets.
- ASK/PLAN/REVIEW modes deny mutations; ASK/PLAN deny verification.
- No model weights on development machine.
