# Open VS Code / Local OSS Coding Agent

> A private, local-first AI coding agent architecture optimized for open-weight models running on local hardware.

[![Agent Core CI](https://github.com/RaulMermans/Open_VS_Code/actions/workflows/ci.yml/badge.svg)](https://github.com/RaulMermans/Open_VS_Code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: >=22.0.0](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](package.json)

---

## 1. What It Is

**Open VS Code** is an independent, local-first AI coding agent designed from the ground up to operate with open-weight coding models (such as Qwen 2.5 Coder) running entirely on the developer's local machine via Ollama, llama.cpp, or vLLM.

It decouples the agent's reasoning core, context engine, and permission boundaries from specific IDEs or proprietary cloud APIs, establishing a reproducible, verifiable foundation for local AI-assisted software engineering.

---

## 2. Current Status

| Capability | Status | Notes |
| :--- | :--- | :--- |
| **Editor-Independent Core** | ✅ Complete | Pure TypeScript `@open-vs-code/agent-core` with zero IDE or framework coupling. |
| **Deterministic Tool Loop** | ✅ Complete | Turn-budgeted, loop-detecting deterministic runner with event streams. |
| **Local Model Gateway** | ✅ Complete | OpenAI-compatible provider with wire protocol normalization (supports markdown fences, `<tool_call>`, synthetic IDs). |
| **Empirical Evaluation** | ✅ Complete | 24-task open-weight benchmark harness + deterministic unit tests. |
| **Repository Intelligence** | ✅ Complete | Read-only tools (`read_file`, `list_directory`, `grep_search`, `find_by_name`) with bounds and ignore hygiene. |
| **Context Compiler & Memory**| ✅ Complete | Progressive disclosure, dynamic token budgeting, and Markdown project memory (`PROJECT.md`, `PLAN.md`, `ARCHITECTURE.md`). |
| **Permission Engine** | ✅ Complete | Action table validation, read-only enforcement, mode switching. |
| **Agent Reasoning Reliability**| ✅ Complete | Evidence-driven orchestration: task profiling, tool narrowing, evidence ledger, premature-answer gate. |
| **Safe Workspace Mutation** | 🚧 In Progress | Reversible edits, diff review, permission gates, rollback. |
| **Interactive CLI** | ⏳ Planned | Standalone terminal interface. |
| **IDE Integration** | ⏳ Planned | VS Code / Code-OSS extension integration. |

---

## 3. Empirical Open-Weight Benchmark

We evaluate our agent directly against local open-weight models without proprietary fallbacks.

### Qwen 2.5 Coder 7B Instruct (Q4_K_M, 4.7 GB) via Ollama

#### Sprint 1E — Baseline

* **Full Suite Grounded Success**: `9 / 24` (37.5%)
* **Dev Split Success**: `7 / 20` (35.0%)
* **Held-out Split Success**: `2 / 4` (50.0%)

#### Sprint 1G — Evidence-Driven Orchestration

* **Full Suite Grounded Success**: `18 / 24` (75.0%)
* **Dev Split Success**: `14 / 20` (70.0%)
* **Held-out Split Success**: `4 / 4` (100.0%)
* **Premature Completion Rate**: `0 / 24` (0.0%)
* **Tool Syntax Validity**: `90.9%` (40 / 44 calls valid)
* **Correct Tool Selection**: `79.2%` (19 / 24 tasks)
* **Non-Progress Failures**: `4.2%` (1 / 24 tasks)

Detailed model card and analysis: [`docs/models/qwen2.5-coder-7b.md`](docs/models/qwen2.5-coder-7b.md).

---

## 4. Architecture

```text
User / Task Input
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                 packages/agent-core                         │
│                                                             │
│   ┌─────────────────────┐       ┌───────────────────────┐   │
│   │   Context Compiler  │       │  Markdown Memory      │   │
│   │  (Token Budgeting)  │◄─────►│ (PROJECT.md/PLAN.md)  │   │
│   └──────────┬──────────┘       └───────────────────────┘   │
│              │                                              │
│              ▼                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                  Agent Runner                       │   │
│   │    - Turn budgeting     - Loop detection            │   │
│   │    - State machine      - Event emitters            │   │
│   └──────────┬──────────────────────────▲───────────────┘   │
│              │                          │                   │
│              ▼                          │ Tool Output       │
│   ┌─────────────────────┐       ┌───────┴───────────────┐   │
│   │  Permission Engine  │       │  Read-Only Tools      │   │
│   │   (Action Matrix)   │──────►│  - read_file          │   │
│   └─────────────────────┘       │  - list_directory     │   │
│                                 │  - grep_search        │   │
│                                 │  - find_by_name       │   │
│                                 └───────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │ Normalized Wire Request
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Model Gateway                            │
│  - OpenAI-compatible HTTP client                            │
│  - Protocol Normalizer (fences, tool_call tags, fixups)     │
│  - Diagnostic Capability Probe                              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Local Open-Weight Model Engine                 │
│         (Ollama / llama.cpp / vLLM / Local AI)              │
│                 e.g. qwen2.5-coder:7b                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Getting Started

### Prerequisites

* Node.js `>= 22.0.0` (Node 24 recommended)
* npm `>= 10.0.0`
* Optional for live model evaluation: [Ollama](https://ollama.ai) with `ollama run qwen2.5-coder:7b`

### Installation

```bash
# Clone the repository
git clone https://github.com/RaulMermans/Open_VS_Code.git
cd Open_VS_Code

# Install dependencies
npm ci
```

### Verification & Testing

```bash
# Run deterministic tests
npm test

# Run strict TypeScript typecheck
npm run typecheck

# Run linter
npm run lint

# Build packages
npm run build
```

### Live Model Benchmark (Requires Ollama + Qwen)

```bash
npm run eval:model
```

---

## 6. Philosophy

1. **Local-First & Private**: The developer's code and reasoning never leave their machine. Zero required cloud services or accounts.
2. **Open-Weight First**: Built to maximize the effectiveness of accessible open models (Qwen, DeepSeek, Llama) rather than relying on massive closed APIs.
3. **Provider & Editor Independence**: The core agent engine is a self-contained module that can plug into any CLI, extension host, or web interface.
4. **Evidence-Driven Engineering**: Grounding assertions, deterministic regression suites, and empirical benchmarks guide every architectural change.

---

## 7. Upstream Inspiration & Attribution

This project is an independent clean-room implementation inspired by and referencing key open-source developments:
* **[Kilo Code](https://github.com/Kilo-Org/kilocode)**: Audited reference for IDE and extension architecture.
* **[Cline](https://github.com/cline/cline)**: Audited reference for autonomous tool loops and checkpoint strategies.
* **[Continue](https://github.com/continuedev/continue)**: Audited reference for context retrieval and provider abstractions.
* **[awesome-vibe-coding](https://github.com/filipecalegario/awesome-vibe-coding)**: Standing open-source discovery radar.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`REFERENCE_MAP.md`](REFERENCE_MAP.md) for full attribution.
