# ADR-008: Two-Tiered Continuous Integration and Model Evaluation Strategy

## Status

Accepted

## Context

The agent core architecture has two distinct testing paradigms:
1. **Deterministic Regression Testing**: Fast, strict, hermetic tests using the scripted/mock model provider to verify permissions, state transitions, context compilation, loop detection, and tool invocation.
2. **Open-Weight Model Evaluation**: Non-deterministic, runtime-dependent evaluations that benchmark live model intelligence, tool selection, argument accuracy, and observation reasoning against real local inference servers (e.g. Ollama, llama.cpp, vLLM).

Coupling live inference to every commit PR check causes slow builds (> 5 minutes), flakiness from hardware variability, and unnecessary GPU/CPU consumption. Conversely, running only unit tests risks silent regressions in real-model tool driving and prompt compatibility.

## Decision

We establish a **Two-Tiered CI Architecture**:

### Tier 1: Fast Deterministic CI (`agent-core-ci.yml`)
- **Trigger**: Every commit push and pull request touching `packages/agent-core`.
- **Target**: Multi-platform matrix (`ubuntu-latest`, `macos-latest`, `windows-latest`) on Node LTS (22) and Node Current (24).
- **Execution Budget**: Sub-30-second target.
- **Gates**:
  1. Strict TypeScript typechecking (`tsc --noEmit` under `exactOptionalPropertyTypes`).
  2. Rust-based linting (`oxlint` with `--deny-warnings`).
  3. Deterministic unit test suite (90+ tests) with zero live model or network dependencies.
  4. Codebase hygiene & zero-baggage verification (`hygiene.test.ts` scanning for forbidden imports or cloud leaks).
  5. Formatting and whitespace verification (`git diff --check`).

### Tier 2: Model Evaluation & Benchmark Workflow (`agent-eval.yml`)
- **Trigger**: On-demand (`workflow_dispatch` with model selection) and scheduled weekly runs.
- **Environment**: Automated Ollama setup pulling target open-weight models (e.g. `qwen2.5-coder:7b`).
- **Gates**:
  1. Diagnostic capability probe (`probeBackend`).
  2. Real model smoke suite (chat, tool schema, argument validation, multi-turn continuation).
  3. Full 24-task read-only benchmark across 10 categories.
  4. Context scaling analysis (2k vs 8k vs 32k).
  5. Automated publication of markdown reports to GitHub Step Summary and downloadable build artifacts.

## Consequences

- Pull requests receive instant, 100% deterministic verification without flakiness.
- Real model evaluations remain easily triggerable for benchmarking new open-weight model releases.
- Zero reliance on external paid API keys in CI.
