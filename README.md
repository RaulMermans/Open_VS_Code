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
| **Repository Intelligence** | ✅ Complete | Read-only tools (`read_file`, `list_directory`, `search_text`, `find_files`) with bounds and ignore hygiene. |
| **Context Compiler & Memory**| ✅ Complete | Progressive disclosure, dynamic token budgeting, and Markdown project memory (`PROJECT.md`, `PLAN.md`, `ARCHITECTURE.md`). |
| **Permission Engine** | ✅ Complete | Action table validation, read-only enforcement, mode switching. |
| **Agent Reasoning Reliability**| ✅ Complete | Evidence-driven orchestration: task profiling, tool narrowing, evidence ledger, premature-answer gate. |
| **Bounded MCP Support** | ✅ Complete | Native stdio transport, dynamic token-budgeted tool selection, and deterministic risk mapping. |
| **Safe Workspace Mutation** | ✅ Complete | Autonomous reasoning with human-gated side effects. Reversible edits, deterministic patches, exact base-hash verification, and atomic writes. |
| **Controlled Verification** | ✅ Complete | Autonomous reasoning with human-gated side effects. Exact verification discovery (TEST, TYPECHECK, LINT), and stale-base guards. |
| **Bounded Repair** | ✅ Complete | Gated loop orchestration, exact package-script review, human-gated verification approval, timeouts, and multi-attempt repair limits. |
| **Interactive CLI** | ✅ Complete | Standalone terminal interface. |
| **Project Memory** | ✅ Complete | Bounded Markdown-first context injection and cross-session persistence. |
| **Skills & Primitives** | ✅ Complete | Reusable metadata-first procedural playbooks (e.g., Bug Triage, Refactoring) with progressive token disclosure. |
| **IDE Integration** | ✅ Complete | Full VS Code / Code-OSS extension integration (`@open-vs-code/vscode-integration`) with native inline completions, chat webview, diff review, and terminal execution. |
| **Local Model Runtime & FIM** | ✅ Complete | Canonical OpenAI-compatible endpoint contracts (`/v1`), explicit FIM prompt templating, local endpoint health probing, and privacy-preserving adaptive performance ledger. |
| **Real Inference Safety Gate**| ✅ Complete | Explicit operator authorization (`OPEN_VS_CODE_REAL_INFERENCE=1`) preventing unauthorized inference, weight downloads, or proprietary cloud leaks. |

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
│                                 │  - search_text        │   │
│                                 │  - find_files       │   │
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

### Target Inference Machine / Optional Live Evaluation

* Node.js `>= 22.0.0`
* npm `>= 10.0.0`
* Local OpenAI-compatible inference server: [Ollama](https://ollama.ai) (`ollama serve` with `ollama pull qwen2.5-coder:7b`) or [vLLM](https://github.com/vllm-project/vllm) / [llama.cpp](https://github.com/ggerganov/llama.cpp).
* Explicit operator authorization: `export OPEN_VS_CODE_REAL_INFERENCE=1`

### Local Model Configuration (`.open-vs-code/models.json`)

To configure self-hosted local models for coding and editor autocomplete (see canonical example in [`config/examples/models.local.example.json`](config/examples/models.local.example.json)):

```json
{
  "$schema": "../config/schemas/models.schema.json",
  "providers": [
    {
      "id": "ollama-local",
      "kind": "openai_compatible_local",
      "baseUrl": "http://127.0.0.1:11434"
    }
  ],
  "models": [
    {
      "id": "qwen2.5-coder-7b",
      "displayName": "Qwen 2.5 Coder 7B",
      "family": "qwen",
      "contextWindow": 32768,
      "capabilities": ["toolUse", "coding", "autocomplete", "fim"],
      "specialization": "coding",
      "fimStrategy": "qwen",
      "provenance": "Qwen2.5-Coder-7B-Instruct (Apache 2.0)"
    }
  ],
  "deployments": [
    {
      "id": "qwen-chat",
      "providerId": "ollama-local",
      "modelId": "qwen2.5-coder-7b",
      "modelName": "qwen2.5-coder:7b",
      "enabled": true,
      "priority": 10
    },
    {
      "id": "qwen-fim",
      "providerId": "ollama-local",
      "modelId": "qwen2.5-coder-7b",
      "modelName": "qwen2.5-coder:7b",
      "enabled": true,
      "priority": 10,
      "fimStrategy": "qwen"
    }
  ],
  "routes": {
    "coding": ["qwen-chat"],
    "autocomplete": ["qwen-fim"],
    "default": ["qwen-chat"]
  }
}
```

Key invariants:
- **No Automatic Model Downloads**: Models must be provisioned beforehand by the developer; Open VS Code never automatically pulls weights.
- **Explicit FIM Formatting**: Models declare `fimStrategy` (`qwen`, `starcoder`, `deepseek`, `prefix-suffix-middle`, or `raw-prefix`).
- **Endpoint Health Probing**: Endpoints are periodically checked via lightweight `/v1/models` requests with bounded TTL caching.
- **Privacy-Preserving Adaptive Routing**: Outcome metrics are tracked locally in `.open-vs-code/model-performance-ledger.json` without storing code or prompts.
- **Zero Cloud Fallback**: Proprietary cloud endpoints (`api.openai.com`, `api.anthropic.com`, etc.) are forbidden and rejected immediately.

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
# Run deterministic tests (unit & integration)
npm test

# Run strict TypeScript typecheck
npm run typecheck

# Run linter
npm run lint

# Build packages
npm run build
```

### Live Open-Weight Model Benchmark (Requires Authorization)

```bash
# 1. Start local model server (e.g. Ollama)
ollama serve

# 2. Authorize real local inference and run benchmark
export OPEN_VS_CODE_REAL_INFERENCE=1
npm run eval:models
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

## Features

Interactive CLI ✅
ASK ✅
PLAN ✅
BUILD ✅
DEBUG ✅
REVIEW ✅
Human-gated mutation ✅
Human-gated verification ✅
Bounded repair ✅
Project Memory ✅
Skills & Prompt Primitives ✅
30-case deterministic evaluation ✅

Canonical tools: read_file, list_directory, search_text, find_files.
