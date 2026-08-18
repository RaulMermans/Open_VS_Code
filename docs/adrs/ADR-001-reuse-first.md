# ADR-001: Reuse-first development

**Status:** Provisional

## Context

Mature open-source AI coding systems already solve parts of the agent, editor, context, tool, and model-provider stack. Rebuilding them would slow validation and create avoidable maintenance.

## Decision

Inspect relevant upstreams before implementing a major subsystem. Classify reuse as `KEEP`, `ADAPT`, `EXTRACT`, `REFERENCE_ONLY`, `REJECT`, or, when no suitable source exists, `BUILD`.

## Rationale

Evidence-led reuse shortens the path to a reliable product while keeping licensing, coupling, and upstream maintenance visible.

## Consequences

- Feature work includes an upstream audit cost.
- Provenance and license obligations must be preserved.
- Canonical code must not become an unreviewed upstream dump.

## Alternatives

- Build every subsystem from scratch.
- Fork the first plausible project without selective evaluation.

## Revisit triggers

Repeated upstream integration costs exceed implementation cost, or no upstream meets privacy, portability, or architecture constraints.

