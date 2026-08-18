# ADR-003: Editor-independent agent core

**Status:** Accepted

## Context

The agent must support tests, headless execution, and possible future editor hosts without inheriting VS Code coupling.

## Decision

`agent-core` must be runnable without `vscode.*`. Editor services are supplied through explicit interfaces and adapters.

## Rationale

Dependency inversion improves portability, testability, and the option to reuse a mature core across IDE and CLI surfaces.

## Consequences

- Adapter contracts must be designed deliberately.
- UI convenience APIs cannot leak into core packages.
- Some upstream code may need extraction rather than direct reuse.

## Alternatives

- Make the VS Code extension the application core.
- Duplicate agent logic per host.

## Revisit triggers

Evidence shows the abstraction cost outweighs credible non-VS-Code use cases, with no loss of testability.
