# Sprint 1C Plan

## Current milestone

Sprint 1C - Editor-independent agent-core foundation.

## Objective

Build deterministic, dependency-light coding-agent foundations without integrating an editor, Kilo, a real model runtime, shell execution, or mutation tools.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-010 | Minimal TypeScript workspace | - | Node scripts run tests, typecheck, lint, and build without new dependencies. | Complete |
| T-011 | Core contracts | T-010 | Model, context, tool, agent, and editor boundaries compile without vendor/editor coupling. | Complete |
| T-012 | OpenAI-compatible local provider | T-011 | Local HTTP tests cover construction, parsing, cancellation, timeout, and failures. | Complete |
| T-013 | Deterministic context budget | T-011 | Required overflow is explicit; optional fitting and deduplication are deterministic. | Complete |
| T-014 | Markdown discovery | T-013 | Canonical discovery and targeted bounded reads stay inside the repository. | Complete |
| T-015 | Progressive Skills loader | T-014 | Discovery reads metadata only; full instructions require explicit selection. | Complete |
| T-016 | Safe read-only tools | T-014 | Read/list/search/find are bounded and repository-contained. | Complete |
| T-017 | Permission engine | T-011 | Baseline, mode narrowing, unknown defaults, and hard denies are deterministic. | Complete |
| T-018 | Agent state/events | T-011 | Immutable valid transitions, failures, cancellation, and terminal states are tested. | Complete |
| T-019 | Minimal context compiler | T-013, T-015 | Required instructions lead, selected Skill only is loaded, code is bounded, and provenance remains. | Complete |
| T-020 | Sprint verification/hygiene | T-010..T-019 | Full verification ladder and diff audit pass; project memory reflects reality. | Complete |

## Deferred

Kilo/editor integration, real model runtimes, streaming, autonomous loops, mutation tools, terminal/Git execution, MCP, multi-agent, worktrees, and deployment remain outside Sprint 1C.
