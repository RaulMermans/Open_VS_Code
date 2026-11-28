# Benchmark policy: fictional repositories only

Status: BINDING from 2026-11-28 (owner amendment). It supersedes earlier instructions that allowed benchmarks on existing repositories. Only the owner can change it.

## Scope

Every coding, application-development, sprint-execution, recovery, stress and comparative benchmark runs on **fictional, purpose-built repositories**. Open VS Code is the system under test, never the project being developed in a benchmark. Its own implementation and regression testing are unaffected.

Out of scope for any benchmark, including through a worktree, clone or copy, and including inspection to construct a benchmark: REEPROV, OpsTwin, AAO, HALO Control, IRIS OS, GEO/AEO Auditor, Open VS Code itself as a target, and any other personal, professional or actively maintained repository. Fictional fixtures must not copy proprietary code or be derived from those projects.

Using Open VS Code on real projects is a separate adoption decision that needs explicit owner authorization after qualification. Passing benchmarks never starts real-project work automatically.

## Environment

- Benchmark root: `~/ovsc-benchmarks` (override with `OPEN_VS_CODE_BENCHMARK_ROOT`), outside every active development directory.
- Each fictional repository has its own git history, a reproducible baseline commit, and `.ovsc-benchmark.json` with `"fictional": true` at its root.
- Each run gets a fresh clone under the system temp directory. The GUI benchmark driver (`apps/desktop/acceptance/src/dogfood.ts`) refuses a workspace without the marker or with a git origin outside the benchmark root (`assertBenchmarkWorkspace`).
- The agent works inside the existing command sandbox (workspace-only filesystem, no network for verification commands) and the lab's approval policy (operations must resolve inside the workspace).
- Hidden evaluators and reference implementations live under `~/ovsc-benchmarks/evaluators` (mode 0700), never inside a run workspace, and run as a separate step after the agent finishes.
- Generated software is never deployed. It is launched only locally, for evaluation.

## Tracks

| Track | Content |
|---|---|
| A — Greenfield | Taskflow, Ledger, Logsmith, Slotwise, Sentinel, Circuit: a product brief, an empty or minimal scaffold, a hidden black-box evaluator |
| B — Brownfield sprint | Stockroom, RelayDesk, Tracekit, Gatekeeper, Orchestrix, Devsmith: established repositories (modules, storage, API, frontend, tests, CI, AGENTS.md, architecture, roadmap, debt, injected defects) and a sprint prompt |
| C — Multi-sprint | One application over five sprints (foundation, core, expansion, reliability, release); each sprint starts from the accepted output of the previous one, with a separate known-good reference baseline per sprint |

Execution profiles: 30, 60, 90 and 120 minutes, within resource and safety limits.

## Definitive runs

A definitive benchmark result comes only from the **installed** production Open VS Code on the EVO X3 with real local inference, followed by independent evaluation and a local launch of the generated software. Candidate or development-host runs validate the harness and are labelled as such.

## Scoring

Completion quality, measured by hidden evaluators and independent launch, not duration, tool count or code volume. Report unauthorized operations, false completions and safety events separately.

The deliverable is an evidence-backed recommendation of which classes of real engineering tasks Open VS Code is qualified to perform.

## History

The Sprint 23, 24 and 33B real-repository runs (REEPROV) predate this policy. They are withdrawn as qualification evidence and are kept only as historical records.
