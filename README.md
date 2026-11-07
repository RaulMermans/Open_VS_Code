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
| **Portable Skills Runtime (V1.1)** | ✅ Deterministically verified · flag off | Strict `SKILL.md` contract, five curated built-ins plus trusted-workspace `.open-vs-code/skills`, metadata-only index, at most one lazily loaded skill, PermissionGate-checked capabilities. Off by default (`open-vs-code.skills.enabled`, CLI `--skills`) until the HALO A/B is measured. See [`docs/skills/SKILLS.md`](docs/skills/SKILLS.md). |
| **Structured Engineering Loop (V1.1)** | ✅ Deterministically verified · flag off | PLAN → IMPLEMENT → TEST → fresh-context REVIEW → VERIFY for eligible Build/Debug tasks. Fresh session and narrowing tool envelope per stage, evidence-grounded review, bounded repair, VERIFY READY required, resumable and cancellable. Enable with `--workflow` / `open-vs-code.workflow.enabled` (ADR-030, `docs/workflows/ENGINEERING_LOOP.md`). |
| **Non-Progress Detection & Recovery (V1.1)** | ✅ Deterministically verified · flag off | Deterministic progress snapshots (failing checks, blockers, net diff, tool and error fingerprints) detect repeated failures, edits and tool calls on the direct and workflow paths. On a stall it runs one read-only diagnostic check and allows one bounded recovery, which draws from the existing repair budget; otherwise it stops as `BLOCKED_NON_PROGRESS` with the reason and a recommended next step. It never grants permissions. Enable with `--progress-monitor` / `open-vs-code.progressMonitor.enabled` (ADR-031, `docs/workflows/NON_PROGRESS_RECOVERY.md`). |
| **IDE Integration** | ✅ Complete | Full VS Code / Code-OSS extension integration (`@open-vs-code/vscode-integration`) with native inline completions, chat webview, diff review, and terminal execution. Sprint 7A polishes the chat Webview (header, composer, explicit context descriptors, honest activity/connection) without changing the agent runtime; see [`docs/sprints/SPRINT_7A_AGENT_EXPERIENCE.md`](docs/sprints/SPRINT_7A_AGENT_EXPERIENCE.md). |
| **Local Model Runtime & FIM** | ✅ Complete | Canonical OpenAI-compatible endpoint contracts (`/v1`), explicit FIM prompt templating, local endpoint health probing, and privacy-preserving adaptive performance ledger. |
| **Real Inference Safety Gate**| ✅ Complete | Explicit operator authorization (`OPEN_VS_CODE_REAL_INFERENCE=1`) preventing unauthorized inference, weight downloads, or proprietary cloud leaks. |
| **Desktop Application & Packaging** | ✅ Complete | Branded, installable Open VS Code desktop app (`apps/desktop`) built on pinned VSCodium, bundling `@open-vs-code/vscode-integration` with zero telemetry. |
| **Private Account Service** | ✅ Complete | Lightweight, separately deployable Node 22+ service (`@open-vs-code/account-service`) for private identity, Scrypt authentication, opaque session tokens, SQLite persistence, and persistent MCP integration registry. |
| **Visual Integration Hub** | ✅ Complete | Interactive webview hub for managing MCP connections, 5-step connection wizard, tool schema inspection, and portable skills discovery. |
| **Custom Modes Engine** | ✅ Complete | Extensible configuration profiles (`CustomModeProfile` → `ResolvedExecutionProfile` → `AgentRuntime`) mapping strictly to canonical base modes (`ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW`), fail-closed validation, immutable task execution, 9-step creation wizard, and dual persistence scopes (account & workspace). |
| **Capability Packs** | ✅ Complete | Declarative packaging, dependency resolution, and governed installation of reusable bundles (Custom Modes, Skills, MCP tools, workflows, model preferences). Strict 10-step lifecycle (`Import != Install != Enable != Execute`), untrusted manifest defense, deterministic `PackResolver`, dual-scope persistence (account SQLite + workspace packs.json), and Visual Integration Manager hub integration. |
| **Governed Playwright Browser Runtime** | ✅ Complete | Locally executable browser automation capability integrated directly into the Agent Runtime via 7 compact, MCP-compatible governed tools (`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_close`). Ephemeral isolated contexts, process tree cleanup, byte-bounded accessibility snapshots, stale reference rejection, network route guard blocking SSRF/metadata endpoints, and deterministic provisioning diagnostics without automated `npx/npm` downloads (ADR-039). |
| **Integrated Visual Browser & Observation UX** | ✅ Complete | Visual browser panel for observing agent Playwright sessions beside the editor. Strict execution/observation separation, outside-workspace screenshot preview ring buffer (10 files / 20MB max), bounded event timeline with task/approval correlation, accessibility element inspector with coordinate-free bounding-box overlay, governed manual controls via `PermissionGate`, and Sprint 9C/9D observation contracts (ADR-040). |
| **Advanced Design & Motion Capability Pack** | ✅ Complete | Specialized frontend design, motion engineering, and visual quality evaluation. Includes `advanced-design-motion-pack` and custom mode in BUILD mode, 8 progressive disclosure skills (<1,000 tokens each), structured `DesignBrief` contract and CSS variable exporter with reduced-motion support, bounded 5-stage sequential workflow engine (Stages A–E, max 3 iterations in Stage E), zero-dependency pure TypeScript PNG diffing with `node:zlib`, real in-browser measured motion evaluation (rAF sampling, Web Animations API audit, layout-thrashing detection, `motionQualityClaimAllowed` gating), and independent deterministic Visual QA evaluator (WCAG 2.1 AA, DOM overflow, focus rings, accessible names) (ADR-041). |
| **REA Reverse Engineering & Reconstruction** | ✅ Complete | Grounded software reverse engineering and clean-room reconstruction based on the methodology and tooling of Reverse Engineer Anything (REA v6.8.0). Includes dual capability packs (`rea-investigation-pack` in REVIEW mode, `rea-reconstruction-pack` in BUILD mode), 4 target workflows (running web apps via real Chromium, JS/Electron apps via REA, native binaries, and source repos), 8 progressive disclosure skills (<850 tokens each), stdio MCP integration with 234 tools and 6 guided prompts, epistemic status classification (`OBSERVED`, `INFERRED`, `UNKNOWN`), deterministic reconstruction obligation ledgers, and cryptographic closure verification (ADR-042). Sprint 9D.1 hardened governance: `GovernedReaWorkflow` integrated directly into `createAgentRuntime`, `ComparativeWebVerifier` dual-application parity proofs, canonical `MutationEngine` path containment with host confirmation, zero-fabrication verification records (`ObligationVerificationRecord`), and shared `McpCatalog` lifecycle. |



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
┌─────────────────────────────────────────────────────────────┐
│       Open VS Code Desktop Application (apps/desktop)       │
│  - Branded standalone distribution (pinned VSCodium shell)   │
│  - Bundled extension auto-activation                         │
│  - Strict privacy defaults (telemetry permanently disabled) │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│      VS Code Integration (packages/vscode-integration)      │
│  - Chat Webview & Diff Review Controllers                   │
│  - Inline Autocomplete (registerInlineCompletionItemProvider)│
│  - Controlled Terminal Execution (VerificationEngine)       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              IDE Adapter (packages/ide-adapter)             │
│  - VS Code API bridge to agent-core                         │
└──────────────────────────────┬──────────────────────────────┘
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
│  - OpenAI-compatible HTTP client (/v1)                      │
│  - Protocol Normalizer (fences, tool_call tags, fixups)     │
│  - Diagnostic Capability Probe                              │
│  - Zero proprietary cloud fallback                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│         Self-Hosted Inference Host (Local or External)      │
│   - Local: Ollama / llama.cpp / vLLM (e.g. qwen2.5-coder)   │
│   - Target Inference Host: HALO                             │
│   * NOTE: No model weights are bundled in the desktop app   │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Getting Started

### Packaging & Running the Desktop Application

The repository includes a self-contained, reproducible packaging system in `apps/desktop`:

```bash
# 1. Fetch & verify pinned upstream shell (VSCodium 1.135.06055, SHA-256 verified)
npm run desktop:prepare

# 2. Build the bundled Open VS Code extension
npm run desktop:build

# 3. Assemble and package Open VS Code.app
npm run desktop:package

# 4. Run automated desktop packaging smoke tests
npm run desktop:smoke
```

The packaged application is produced at:
- `apps/desktop/dist/Open VS Code.app` (macOS application bundle)
- `apps/desktop/dist/Open-VS-Code-darwin-arm64-0.1.0.tar.gz` (redistributable archive)

To install on macOS:
```bash
cp -R "apps/desktop/dist/Open VS Code.app" /Applications/
open -a "Open VS Code"
```

Or run the CLI directly:
```bash
apps/desktop/dist/Open\ VS\ Code.app/Contents/Resources/app/bin/open-vs-code
```

On Linux x64 the same packaging commands produce `apps/desktop/dist/open-vs-code_<version>_amd64.deb`. The current candidate is `0.1.0-rc.4`. Install that package as root, then launch **Open VS Code** from the applications menu or with `open-vs-code /path/to/repo`. The launcher authorizes the workspace's configured local endpoint and does not disable the Electron sandbox. User data lives in `~/.config/Open VS Code`. Rollback and the Personal V1 evidence are in [`docs/releases/PERSONAL_V1_ACCEPTANCE.md`](docs/releases/PERSONAL_V1_ACCEPTANCE.md).

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

# Skill selection accuracy and context-efficiency benchmark (deterministic, no model)
npm run eval:skills

# Structured Engineering Loop evaluation: eligibility, direct vs workflow A/B, reviewer bias (deterministic, simulated local model)
npm run eval:workflow

# Non-progress detection & recovery evaluation: loop detection, false stalls, recovery, efficiency A/B (deterministic)
npm run eval:progress

# Learning evaluation: classification, dedupe, false promotions, malicious/escalation probes, token impact (deterministic, no model)
npm run eval:learning
```

Consolidated V1.1 deterministic benchmark and the HALO real-model benchmark contract: [`docs/evals/V1_1_BENCHMARK.md`](docs/evals/V1_1_BENCHMARK.md).

### Live Open-Weight Model Benchmark (Requires Authorization)

```bash
# 1. Start local model server (e.g. Ollama)
ollama serve

# 2. Authorize real local inference and run benchmark
export OPEN_VS_CODE_REAL_INFERENCE=1
npm run eval:models
```

### Private Account Backend & Admin CLI (`packages/account-service`)

The repository includes a private, administrator-controlled account service for maintaining personal identities and persistent MCP integration configurations:

```bash
# 1. Start account service on loopback (default: http://127.0.0.1:4040)
export ACCOUNT_DB_PATH="$HOME/.open-vs-code/accounts.db"
npx tsx packages/account-service/src/admin/admin-cli.ts serve --port 4040

# 2. Bootstrap initial administrator (safe, one-time bootstrap; prompt for password)
npx tsx packages/account-service/src/admin/admin-cli.ts bootstrap --username admin --role ADMIN

# 3. Create regular user accounts as administrator
npx tsx packages/account-service/src/admin/admin-cli.ts create-user --username developer --role USER
```

In Open VS Code Desktop, configure `open-vs-code.account.serverUrl` to `http://127.0.0.1:4040` and execute `Open VS Code: Log In to Account` from the Command Palette.

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
Portable Skills Runtime (flag off, real-model delta deferred to HALO) ✅
Structured Engineering Loop (flag off, real-model delta deferred to HALO) ✅
Non-progress detection & bounded recovery (flag off, real-model delta deferred to HALO) ✅
Bounded memory-to-skill learning with human approval (flag off; [guide](docs/learning/LEARNING_SYSTEM.md)) ✅
30-case deterministic evaluation ✅

Canonical tools: read_file, list_directory, search_text, find_files.
