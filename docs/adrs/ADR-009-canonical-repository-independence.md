# ADR-009: Canonical Repository Independence from Kilo

## Status

Accepted (2026-08-26, Sprint 1F)

## Context

In Sprint 1, the repository was initialized by importing the external open-source Kilo Code repository (`91a337e31c`) to explore potential reuse of IDE extensions and CLI components. During Sprints 1A through 1E, we built a fully decoupled, independent, and hermetically tested agent core (`packages/agent-core`) along with model gateways, protocol normalizers, context budgeting, and empirical local open-weight benchmark evaluation frameworks.

However, the canonical working tree still retained ~9,000 tracked upstream Kilo files across 35 unused packages (including cloud backends, remote telemetry, JetBrains plugins, and Bun workspace scripts). This introduced:
1. Significant cognitive noise and confusion over project identity.
2. Toolchain coupling to Bun-specific paths and Kilo root scripts.
3. High token overhead and risk of accidental dependency leaks during automated development.

## Decision

We establish **Canonical Repository Independence**:
1. **Repository Identity**: This repository is our own canonical local-first AI coding agent project.
2. **Kilo Classification**: Kilo Code is designated an external open-source reference and future potential source of selected reusable IDE infrastructure (`REFERENCE_ONLY` / `ADAPT`), not the canonical product codebase.
3. **Working Tree Separation**: All unneeded upstream Kilo source trees, packages, and obsolete configurations are removed from the canonical working tree.
4. **Toolchain Independence**: The repository is standardized on a standard Node 24 / npm workspace with direct, explicit devDependencies (`typescript`, `oxlint`, `@types/node`).
5. **Historical Provenance Preservation**: The full historical Kilo tree and provenance are safely preserved in Git history and permanently checkpointed via tag `baseline/pre-kilo-separation`.
6. **Licensing Compliance**: All upstream licenses, notices, and attribution obligations are formally maintained in `THIRD_PARTY_NOTICES.md` and `REFERENCE_MAP.md`.

## Consequences

- The canonical working tree is reduced by >98% (from ~9,476 files to ~150 files), providing immediate clarity and zero-baggage navigation.
- The build and test loop is 100% reproducible via standard `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- No cloud, telemetry, or proprietary model dependencies remain in the working tree.
- Future IDE or extension work will import or adapt upstream code intentionally through explicit, audited boundaries rather than inheriting monorepo baggage.
