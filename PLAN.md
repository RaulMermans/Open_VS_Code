# Sprint 1D Plan

## Current milestone

Sprint 1D - Deterministic read-only agent loop with scripted models.

## Objective

Compose the Sprint 1C foundation into one deterministic multi-turn agent loop without integrating an editor, Kilo, a real model runtime, shell execution, or mutation tools.

## Task graph

| ID | Task | Depends on | Acceptance criteria | Status |
| --- | --- | --- | --- | --- |
| T-021 | Agent Runner | T-011..T-019 | Thin orchestration composes context, model, tools, permissions, state, and events. | Complete |
| T-022 | Scripted Model Provider | T-011 | Ordered responses, request-aware steps, failures, and exhaustion use the real provider contract. | Complete |
| T-023 | Tool Registry | T-016 | Canonical unique registration, model definitions, lookup, and invocation remain executor-separated. | Complete |
| T-024 | Model-visible Tool Definitions | T-023 | Only compact, mode-allowed definitions are exposed without machine paths or implementations. | Complete |
| T-025 | Permission Gate Integration | T-017, T-023 | ALLOW executes, DENY cannot execute, and CONFIRM pauses for explicit resume. | Complete |
| T-026 | Tool Call Validation | T-023 | Unknown, malformed, wrong-type, missing, and extra arguments fail before execution. | Complete |
| T-027 | Observation Model | T-016, T-023 | Results and errors retain provenance and explicit truncation under byte limits. | Complete |
| T-028 | Multi-turn Context Compilation | T-019, T-027 | Each model turn recompiles required context plus recent deduplicated observations. | Complete |
| T-029 | Turn Limits | T-021 | Maximum turns terminate with `MAX_TURNS_EXCEEDED`. | Complete |
| T-030 | Non-progress Detection | T-021 | Repeated identical call/result pairs terminate at a deterministic threshold. | Complete |
| T-031 | Cancellation | T-021 | Abort signals reach provider and tools and terminate as `CANCELLED`. | Complete |
| T-032 | Event Trace | T-018, T-021 | Normal, paused, recovery, and failure paths emit deterministic structured events. | Complete |
| T-033 | Read-only Fixture Scenarios | T-021..T-032 | Authentication, failing-test, and tiny-repository answers require real fixture observations. | Complete |
| T-034 | Confirmation Flow | T-025 | Synthetic confirmation proves pause, approval, rejection, and no premature execution. | Complete |
| T-035 | Failure Scenarios | T-021..T-032 | Model/tool failure, invalid calls, deny, overflow, limits, cancellation, and containment are covered. | Complete |
| T-036 | Agent Result Contract | T-021 | Results contain bounded status, state, turns, events, context, tool, and confirmation diagnostics. | Complete |
| T-037 | Full Verification + Hygiene | T-021..T-036 | Tests, typecheck, lint, build, diff, coupling search, and documentation pass. | Complete |

## Deferred

Kilo/editor integration, real model runtimes, streaming, mutation tools, terminal/Git execution, MCP, multi-agent, worktrees, and deployment remain outside Sprint 1D.

## Next sprint

Sprint 1E — Real Local Model Connection: connect the proven deterministic agent loop to one real local OpenAI-compatible model endpoint, benchmark tool-call reliability and context behavior, and preserve the scripted model as the regression oracle.
