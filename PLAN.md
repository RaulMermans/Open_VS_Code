# Sprint 1G Plan — Open-Weight Agent Reliability & Grounded Execution

## Current milestone

Sprint 1G — Improve the read-only open-weight coding agent from the initial 37.5% grounded-completion baseline to $\ge 65\%$ (achieved **75.0%** overall, **100%** on held-out split) using Qwen2.5-Coder-7B via local Ollama without write tools, terminal execution, larger models, or proprietary fallbacks.

## Objective

Make investigation disciplined, tool selection targeted, turn allocation smarter, and premature answers impossible—improving local open-weight model performance through evidence-driven orchestration while maintaining strict scope boundaries and repository hygiene.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-070A | Duplicate Evals Cleanup | Sprint 1F | Single canonical `/evals/results` location; `run-benchmark-cli.ts` resolved via import.meta.url; regression test in hygiene suite. | Complete |
| T-070B | CI Cloud Weights Prevention | T-070A | Deleted `.github/workflows/agent-eval.yml` to prevent unneeded heavy model downloads on CI compute while preserving deterministic CI. | Complete |
| T-070C | Clean Preflight Checkpoint | T-070B | 91 deterministic tests passing, clean typecheck, lint, build. | Complete |
| T-072 | Benchmark Freeze & Split Integrity | T-070C | Fixed 24-case corpus frozen into 20 Development / 4 Held-Out cases; evaluation runner supports split filtering (`--dev`, `--held-out`, `--all`). | Complete |
| T-073 | Task Investigation Profiles | T-072 | Deterministic `TaskProfile` classifier (`task-profile.ts`) matching 10 task categories with tailored strategies and turn budgets. | Complete |
| T-074 | Deterministic Tool-Selection Guidance | T-073 | Profile-specific tool narrowing (`allowedTools`) reducing schema confusion on 7B models. Correct Tool Selection: **95.8%**. | Complete |
| T-075 | Evidence Requirements | T-073 | Explicit `EvidenceRequirement` models per task category. | Complete |
| T-076 | Evidence Ledger | T-075 | Immutably tracks tool calls, observations, file reads, searches, directory listings, and requirement satisfaction (`evidence.ts`). | Complete |
| T-077 | Premature-Answer Gate | T-076 | Rejects 0-tool completion when mandatory evidence is unsatisfied, injecting structured `[EVIDENCE REQUIRED]` feedback. Premature Completions: **0.0%**. | Complete |
| T-078 | Evidence-Sufficient Completion Guidance | T-076 | Prompt suffix injected when evidence is satisfied, commanding immediate grounded completion without burning excess turns. | Complete |
| T-079 | Adaptive Turn Budgets | T-073 | Profile-driven turn budgets (4–6 turns) preventing premature `MAX_TURNS` failures on complex multi-file tasks. | Complete |
| T-080 | Tool Narrowing | T-074 | Open-weight model schema limited to top 3 relevant tools per task profile. | Complete |
| T-081 | Context Ordering for OSS Models | T-078 | Recency-optimized prompt structure placing critical completion instructions at the prompt end. | Complete |
| T-082 | Observation Compression | T-076 | Markdown-formatted observation content without JSON serialization overhead (`observations.ts`). | Complete |
| T-083 | Bounded Recovery Policy | T-077 | Non-progress tracking with basename matching preventing repetitive tool loops. | Complete |
| T-084 | Run Dev Benchmark Iterations | T-073..T-083 | Measured progressive improvement from 20.0% -> 45.0% -> 50.0% -> 55.0% -> 70.0% across 20 dev cases. | Complete |
| T-085 | Dev Evaluation & Verification | T-084 | Dev split grounded pass rate achieved: **70.0%** (14/20 tasks). | Complete |
| T-086 | Held-Out Benchmark Run | T-085 | Evaluated 4 held-out cases with zero prompt tuning/contamination: **100.0%** (4/4 tasks passed). | Complete |
| T-087 | Failure Taxonomy v2 | T-086 | Documented 11 explicit failure categories in `FailureRootCause` and evaluated in benchmark runner. | Complete |
| T-088 | Model Ceiling Determination | T-086 | Documented in model card: 7B limits for deep call graph tracking across 4+ files without scratchpad. | Complete |
| T-089 | Update Model Card | T-088 | Updated `docs/models/qwen2.5-coder-7b.md` with complete Sprint 1G benchmark results and guidance. | Complete |
| T-090 | Deterministic Unit Tests | T-073..T-083 | Added `task-profile.test.ts` and `evidence.test.ts`; 103 deterministic tests passing cleanly (100%). | Complete |
| T-091 | Final Sprint 1G Verification | T-090 | Full build, lint, typecheck, unit test suite, and benchmark reports verified. | Complete |

## Next sprint

Sprint 2A — Bounded Workspace Editing & Safe Mutation: Introduce strictly scoped file-patching and verification loops while maintaining immutable session history, permission boundaries, and open-weight model reliability.
