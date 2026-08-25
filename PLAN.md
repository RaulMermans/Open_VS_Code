# Sprint 1E Plan — Real Local Model Connection & Open-Source Benchmark

## Current milestone

Sprint 1E — Real local open-weight model integration, protocol normalization, and quantitative benchmark evaluation.

## Objective

Connect the proven deterministic agent architecture to real open-source/open-weight coding models running through local/self-hosted inference (Ollama / Qwen 2.5 Coder 7B), harden wire protocol compatibility, and quantitatively evaluate whether those models can reliably drive the read-only coding agent.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-038 | Real Protocol Normalization | T-021..T-037 | Wire decoder normalizes tool calls (single/multi), string/object args, null content, synthetic IDs, and legacy function calls. | Complete |
| T-039 | Protocol Fixture Test Suite | T-038 | 18 wire fixtures test every normalization edge case deterministically in unit tests. | Complete |
| T-040 | Backend Capabilities Contract | T-038 | Providers expose explicit capabilities (`chat`, `tools`, `parallel_tool_calls`, `context_window`, `usage_reporting`). | Complete |
| T-041 | Backend Diagnostics Probe | T-040 | `probeBackend` safely validates endpoint reachability, model availability, chat, tool calling, and usage reporting. | Complete |
| T-042 | Diagnostic Probe Tests | T-041 | Unit tests verify probe success against mock server and graceful failure on network/timeout errors. | Complete |
| T-043 | Local Backend Protocol Hardening | T-038..T-042 | Phase 1E-A gate passes with 88 passing deterministic unit tests and live Ollama probe verification. | Complete |
| T-044 | Model Runtime Setup | T-043 | Ollama runtime and `qwen2.5-coder:7b` (Apache 2.0, Q4_K_M, 4.7GB) operational locally on Apple Silicon. | Complete |
| T-045 | Hardware & Budget Assessment | T-044 | Apple M3 Pro 18GB memory budget validated with > 12 GB headroom during active inference. | Complete |
| T-046 | Real-Model Smoke Test Suite | T-044, T-045 | 4 smoke tests verify plain chat, tool schema comprehension, arguments validity, and observation continuation. | Complete |
| T-047 | Read-Only Evaluation Dataset | T-046 | 24 tasks across 10 categories with explicit grounding assertions and dev/held-out splits. | Complete |
| T-048 | Benchmark Execution Harness | T-047 | Evaluates tasks, records latency, tool syntax validity, correct tool selection, token estimates, and root cause breakdown. | Complete |
| T-049 | Grounding Verification | T-048 | Automated verification of repository evidence citation vs hallucinated assertions. | Complete |
| T-050 | Failure Taxonomy & Diagnostics | T-048 | Classifies failures across `MODEL_REASONING`, `TOOL_SELECTION`, `TOOL_ARGUMENTS`, `NON_PROGRESS`, `MAX_TURNS`, `BACKEND_RUNTIME`. | Complete |
| T-051 | Context Window Evaluation | T-048 | Compares 2,048 (Small), 8,192 (Medium), and 32,768 (Large) token bounds on latency and success. | Complete |
| T-052 | Baseline vs Normalized Comparison | T-038, T-048 | Proves raw backends outputting content-embedded JSON tool calls succeed via protocol normalizer. | Complete |
| T-053 | Evaluation Artifact Generation | T-048..T-051 | `evals/results/qwen2.5-coder-7b-benchmark.json` and Markdown report generated. | Complete |
| T-054 | Deterministic Regression Separation | T-022, T-048 | Scripted model tests remain fast (~300ms) and independent of live inference server. | Complete |
| T-055 | Orchestration Recommendations | T-048..T-053 | Quantitative recommendations for local model prompt formatting, tool schema, and turn bounds. | Complete |
| T-056 | Agent-Local Model Card | T-053, T-055 | `docs/models/qwen2.5-coder-7b.md` documented with strengths, failure modes, and recommended modes. | Complete |
| T-057 | Full Verification + Hygiene | T-038..T-056 | All 88 tests pass, typecheck clean, lint clean, build clean, git diff clean. | Complete |

## Next sprint

Sprint 1F — Controlled Workspace Mutation: introduce safe file writing tools (`write_file`, `edit_file`), strict write permission boundaries, pre-mutation backups, reversible checkpoints, and single-change mutation loops.
