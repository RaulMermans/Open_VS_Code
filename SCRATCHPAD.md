# Scratchpad

- Current task: validate the completed Sprint 1 research/control-layer checkpoint.
- Findings: Kilo `91a337e` is the recommended controlled-fork baseline; its VS Code host already uses a separate CLI/backend. Cloud, telemetry, remote sessions, marketplace, indexing, and Agent Manager need early isolation.
- Commands: environment/Git/version inspection; `git init -b main`; shallow upstream clones; targeted `git ls-tree`, `git show`, and `git grep` audits.
- Blockers: ordinary shell `PATH` lacks Node, though bundled Node 24.19.0 is available; Kilo's Windows checkout hit long-path/index issues, so commit-object reads were used.
- Relevant paths: `docs/research/kilo-audit.md`, `docs/research/secondary-audit.md`, `docs/research/starting-strategy.md`.
- Next action: T-006, import/fork the pinned Kilo baseline with history and license/provenance intact; do not prune before an upstream smoke.
