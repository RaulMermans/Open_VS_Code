# Sprint 1F Plan — Canonical Repository Independence & Clean Toolchain

## Current milestone

Sprint 1F — Establish an independently buildable, clearly owned canonical repository containing exclusively our product and intentionally retained attribution/reference material, while preserving Kilo history and provenance safely in Git.

## Objective

Separate the canonical working tree from imported Kilo monorepo baggage, transition from Bun/Turbo to a minimal reproducible Node 24 / npm toolchain, update root identity and documentation, eliminate upstream coupling, and prove standalone clean-install reproducibility.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-058 | Pre-separation Checkpoint | Sprint 1E | Tag `baseline/pre-kilo-separation` created at commit `b1e3802bfb` preserving complete upstream history. | Complete |
| T-059 | Ownership Inventory Audit | T-058 | `docs/research/repository-ownership-audit.md` classifies all 9,476 tracked files across 6 explicit ownership categories. | Complete |
| T-060 | Independent Agent Toolchain | T-059 | Minimal Node 24 / npm workspace; removed `.bun` path coupling and Kilo package catalogs. | Complete |
| T-061 | Root Project Identity | T-060 | Root `package.json` reflects `@open-vs-code` identity with standard test/typecheck/lint/build scripts. | Complete |
| T-062 | Authoritative Project README | T-061 | Truthful `README.md` documenting architecture, current status, empirical benchmark baseline, and philosophy. | Complete |
| T-063 | Upstream Attribution & Notices | T-059 | `THIRD_PARTY_NOTICES.md` and updated `REFERENCE_MAP.md` preserve legal attribution for Kilo, Cline, Continue. | Complete |
| T-064 | Remove Upstream Kilo Packages | T-060, T-063 | All 35 unneeded upstream Kilo packages removed from `packages/*`, leaving only `packages/agent-core`. | Complete |
| T-065 | Clean Upstream Configuration | T-064 | Removed obsolete `.kilo`, `.opencode`, `.changeset`, `.husky`, `script/`, `translations/`, `patches/`, `nix/`. | Complete |
| T-066 | Minimal Multi-OS CI | T-060, T-065 | Clean `.github/workflows/ci.yml` matrix (Ubuntu, macOS, Windows on Node 22 & 24) running full verification. | Complete |
| T-067 | Preserve Evaluation Evidence | T-064 | `evals/results/` benchmark data, model card, and harness preserved intact. | Complete |
| T-068 | Stale Reference Audit | T-064..T-067 | `git grep -i "kilo"` verified: 0 production/runtime imports, matches only in attribution/ADRs/research. | Complete |
| T-069 | Architecture Decision (ADR-009) | T-059..T-068 | `ADR-009-canonical-repository-independence.md` created and recorded in `DECISIONS.md`. | Complete |
| T-070 | Clean-Install & Build Verification | T-060..T-069 | 90 deterministic unit tests pass, typecheck clean, lint clean, build clean, `package-lock.json` validated. | Complete |
| T-071 | Final Sprint 1F Checkpoint | T-058..T-070 | Clean working tree checkpoint committed; tracked files reduced from 9,476 to ~144. | Complete |

## Next sprint

Sprint 1G — OSS Agent Reliability: improve the real open-weight read-only agent from the 37.5% grounded-completion baseline through evidence-first investigation, targeted tool selection, adaptive turn budgeting, and benchmark-driven orchestration improvements before granting file-write capability.
