# Decision Index

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-001](docs/adrs/ADR-001-reuse-first.md) | Reuse-first development | Provisional |
| [ADR-002](docs/adrs/ADR-002-extension-product-first.md) | Extension/product layer before deep Code-OSS changes | Provisional |
| [ADR-003](docs/adrs/ADR-003-editor-independent-agent-core.md) | Editor-independent agent core | Accepted |
| [ADR-004](docs/adrs/ADR-004-provider-agnostic-model-gateway.md) | Provider-agnostic model gateway | Accepted |
| [ADR-005](docs/adrs/ADR-005-markdown-first-memory.md) | Markdown-first project memory | Accepted |
| [ADR-006](docs/adrs/ADR-006-progressive-disclosure.md) | Progressive disclosure and token budgeting | Accepted |
| [ADR-007](docs/adrs/ADR-007-local-model-normalization.md) | Local open-weight model normalization and gateway | Accepted |
| [ADR-008](docs/adrs/ADR-008-ci-and-evaluation-strategy.md) | Two-tiered CI and open-weight model evaluation strategy | Accepted |
| [ADR-009](docs/adrs/ADR-009-canonical-repository-independence.md) | Canonical repository independence from Kilo | Accepted |
| [ADR-010](docs/adrs/ADR-010-evidence-driven-agent-orchestration.md) | Evidence-driven agent orchestration for open-weight models | Accepted |
| [ADR-011](docs/adrs/ADR-011-safe-mutation-layer.md) | Safe mutation layer | Accepted |
| [ADR-012](docs/adrs/ADR-012-bounded-repair-loops.md) | Bounded autonomous repair loops | Accepted |
| [ADR-013](docs/adrs/ADR-013-bounded-session-continuity.md) | Markdown-First Project Memory & Bounded Session Continuity | Accepted |
| [ADR-014](docs/adrs/ADR-014-metadata-first-skills.md) | Metadata-First Skills & Prompt Primitives | Accepted |
| [ADR-015](docs/adrs/ADR-015-bounded-mcp-integration.md) | Bounded MCP Integration | Accepted |
| [ADR-016](docs/adrs/ADR-016-deterministic-model-provider-routing.md) | Deterministic Model / Provider Routing Architecture | Accepted |
| [ADR-017](docs/adrs/ADR-017-ide-host-adapter-boundary.md) | IDE Host Adapter Boundary | Accepted |
| [ADR-018](docs/adrs/ADR-018-chat-ux-layer.md) | Chat UX Layer | Accepted |
| [ADR-019](docs/adrs/ADR-019-diff-edit-review-boundary.md) | Diff / Edit Review Boundary | Accepted |
| [ADR-020](docs/adrs/ADR-020-halo-capability-provider.md) | HALO Capability Provider | Accepted |
| [ADR-021](docs/adrs/ADR-021-controlled-terminal-execution.md) | Controlled Terminal UX and Presentation Boundary | Accepted |
| [ADR-022](docs/adrs/ADR-022-editor-native-autocomplete.md) | Editor-Native Autocomplete | Accepted |
| [ADR-023](docs/adrs/ADR-023-system-security-boundaries.md) | System-Wide Security Boundaries | Accepted |
| [ADR-024](docs/adrs/ADR-024-runtime-evals-adaptive-control.md) | Runtime Evaluations & Adaptive Control | Accepted |
| [ADR-025](docs/adrs/ADR-025-checkpoints-recovery.md) | Durable Checkpoints, Recovery & Safe Rollback | Accepted |
| [ADR-026](docs/adrs/ADR-026-large-repository-performance.md) | Large-Repository Performance & Hardening | Accepted |
| [ADR-027](docs/adrs/ADR-027-real-local-models-and-adaptive-routing.md) | Real Local Models, Canonical Endpoints & Adaptive Routing | Accepted |
| [ADR-028](docs/adrs/ADR-028-desktop-shell-and-packaging-strategy.md) | Desktop Shell and Packaging Strategy (Code-OSS vs VSCodium) | Accepted |

Decision status changes belong in the ADR and this index.

Sprint 1's implementation recommendation is documented separately at `docs/research/starting-strategy.md`; it does not make the provisional ADRs permanent.
Sprint 2C complete. MCP Runtime fully integrated and proven.

- **Sprint 2D.1**: ADR-016 integrated into production execution path via `RoutedModelGateway`.
- **Sprint 3A**: IDE Adapter / Code-OSS Integration Foundation complete.
- **Sprint 3B**: Chat UX Layer complete (ADR-018).
- **Sprint 3C**: Diff / Edit UX Review Boundary complete (ADR-019).
- **Sprint 3D**: Controlled Terminal UX & Presentation Boundary complete (ADR-021).
- **Sprint 3E**: Editor-Native Autocomplete complete (ADR-022).
- **Sprint 4A**: System-Wide Security Hardening complete (ADR-023).
- **Sprint 4B**: Runtime Evaluations & Adaptive Control complete (ADR-024).
- **Sprint 4C**: Durable Checkpoints, Recovery & Safe Rollback complete (ADR-025).
- **Sprint 4D**: Large-Repository Performance & Hardening complete (ADR-026).
- **Sprint 4E / 4E.1 / 4E.2**: Real Local Models, Production FIM & Evidence Closure (ADR-027) — Implementation Complete (Real-Host Evidence Blocked).
- **Sprint 4F**: Desktop Shell and Packaging Strategy (ADR-028) — Accepted.
