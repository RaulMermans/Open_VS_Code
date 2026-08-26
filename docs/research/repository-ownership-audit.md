# Repository Ownership Inventory Audit

Date: 2026-08-26
Milestone: Sprint 1F (T-059)
Pre-separation Checkpoint: `baseline/pre-kilo-separation` (`b1e3802bfb`)
Upstream Baseline: Kilo Code `91a337e31c` (MIT)

---

## 1. Classification Scheme

Every path and package in the imported repository is classified into one of the following categories:

* **`OUR_PRODUCT`**: Original, project-owned software code implementing our local-first AI coding agent.
* **`OUR_PROJECT_MEMORY`**: Project governance, architecture specifications, sprint plans, decision records, research notes, and agent skills.
* **`OUR_EVAL`**: Benchmark harnesses, quantitative evaluation datasets, mock repositories, and empirical model cards.
* **`ATTRIBUTION_REFERENCE`**: Third-party notices, upstream audit documents, and reference mappings retained for legal and historical compliance.
* **`SHARED_BUT_CONFIGURED_FOR_US`**: Build manifests, linters, toolchain configurations, and CI pipelines tailored specifically for our product.
* **`UPSTREAM_KILO`**: Imported Kilo Code and OpenCode application packages, cloud services, telemetry, JetBrains/VSCode UI, build scripts, translations, and obsolete configurations.

---

## 2. Package Inventory (`packages/*`)

| Package Directory | Classification | Files | Description & Action |
| :--- | :--- | :--- | :--- |
| `packages/agent-core` | **`OUR_PRODUCT`** | 98 | **RETAIN**. Pure TypeScript, editor-independent agent core (runner, context compiler, protocol normalizer, model gateway, permission engine, read-only tools). |
| `packages/client` | `UPSTREAM_KILO` | 21 | **REMOVE**. Kilo web/API client. |
| `packages/codemode` | `UPSTREAM_KILO` | 41 | **REMOVE**. Kilo codemode execution runtime. |
| `packages/containers` | `UPSTREAM_KILO` | 9 | **REMOVE**. Kilo cloud container integration. |
| `packages/core` | `UPSTREAM_KILO` | 541 | **REMOVE**. Legacy Kilo/OpenCode core runtime (Effect-coupled). |
| `packages/effect-drizzle-sqlite` | `UPSTREAM_KILO` | 26 | **REMOVE**. Effect Drizzle SQLite wrapper. |
| `packages/effect-sqlite-node` | `UPSTREAM_KILO` | 4 | **REMOVE**. Effect SQLite Node native wrapper. |
| `packages/extensions` | `UPSTREAM_KILO` | 2 | **REMOVE**. Kilo extension loader. |
| `packages/http-recorder` | `UPSTREAM_KILO` | 24 | **REMOVE**. HTTP recording test harness. |
| `packages/httpapi-codegen` | `UPSTREAM_KILO` | 16 | **REMOVE**. HTTP API code generation. |
| `packages/kilo-console` | `UPSTREAM_KILO` | 95 | **REMOVE**. Kilo web console application. |
| `packages/kilo-docs` | `UPSTREAM_KILO` | 904 | **REMOVE**. Kilo website documentation. |
| `packages/kilo-gateway` | `UPSTREAM_KILO` | 56 | **REMOVE**. Kilo cloud proxy gateway. |
| `packages/kilo-i18n` | `UPSTREAM_KILO` | 22 | **REMOVE**. Kilo localization package. |
| `packages/kilo-indexing` | `UPSTREAM_KILO` | 121 | **REMOVE**. Kilo codebase indexing service. |
| `packages/kilo-jetbrains` | `UPSTREAM_KILO` | 741 | **REMOVE**. Kilo JetBrains IDE plugin. |
| `packages/kilo-memory` | `UPSTREAM_KILO` | 66 | **REMOVE**. Kilo SQLite-based memory system. |
| `packages/kilo-sandbox` | `UPSTREAM_KILO` | 28 | **REMOVE**. Kilo remote sandbox client. |
| `packages/kilo-telemetry` | `UPSTREAM_KILO` | 10 | **REMOVE**. Kilo telemetry collection. |
| `packages/kilo-ui` | `UPSTREAM_KILO` | 242 | **REMOVE**. Kilo UI components. |
| `packages/kilo-vscode` | `UPSTREAM_KILO` | 1517 | **REMOVE**. Kilo VS Code extension (Effect/cloud coupled). |
| `packages/kilo-web-ui` | `UPSTREAM_KILO` | 156 | **REMOVE**. Kilo web UI views. |
| `packages/llm` | `UPSTREAM_KILO` | 153 | **REMOVE**. Legacy Kilo LLM provider abstraction. |
| `packages/opencode` | `UPSTREAM_KILO` | 1706 | **REMOVE**. Kilo OpenCode CLI and backend. |
| `packages/plugin` | `UPSTREAM_KILO` | 42 | **REMOVE**. Kilo plugin SDK. |
| `packages/plugin-atomic-chat` | `UPSTREAM_KILO` | 27 | **REMOVE**. Atomic chat plugin. |
| `packages/protocol` | `UPSTREAM_KILO` | 26 | **REMOVE**. Kilo IPC protocol definitions. |
| `packages/schema` | `UPSTREAM_KILO` | 76 | **REMOVE**. Kilo JSON schema generators. |
| `packages/script` | `UPSTREAM_KILO` | 5 | **REMOVE**. Internal package script utilities. |
| `packages/sdk` | `UPSTREAM_KILO` | 49 | **REMOVE**. Kilo TypeScript SDK. |
| `packages/sdk-next` | `UPSTREAM_KILO` | 9 | **REMOVE**. Experimental SDK. |
| `packages/server` | `UPSTREAM_KILO` | 34 | **REMOVE**. Kilo backend server. |
| `packages/session-ui` | `UPSTREAM_KILO` | 116 | **REMOVE**. Session webview UI. |
| `packages/storybook` | `UPSTREAM_KILO` | 28 | **REMOVE**. Storybook preview harness. |
| `packages/tui` | `UPSTREAM_KILO` | 259 | **REMOVE**. Kilo terminal UI. |
| `packages/ui` | `UPSTREAM_KILO` | 1774 | **REMOVE**. Shared UI component library. |

---

## 3. Root Documentation & Project Memory

| Path | Classification | Action |
| :--- | :--- | :--- |
| `PROJECT.md` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Product vision, north star, and constraints. |
| `ARCHITECTURE.md` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Agent core architecture and invariants. |
| `AGENTS.md` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Agent operating guide and context discipline rules. |
| `PLAN.md` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Active sprint roadmap. |
| `DECISIONS.md` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Architecture Decision Records index. |
| `SCRATCHPAD.md` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Current implementation scratchpad and milestone notes. |
| `REFERENCE_MAP.md` | **`ATTRIBUTION_REFERENCE`** | **RETAIN & UPDATE**. External open-source references and ecosystem discovery. |
| `README.md` | `SHARED_BUT_CONFIGURED_FOR_US` | **REPLACE**. Replace Kilo README with authoritative project README. |
| `LICENSE` | `SHARED_BUT_CONFIGURED_FOR_US` | **RETAIN/UPDATE**. Standard MIT License for our project. |
| `THIRD_PARTY_NOTICES.md` | **`ATTRIBUTION_REFERENCE`** | **NEW**. Formal attribution for Kilo Code (`91a337e`), Cline, Continue. |
| `CODE_OF_CONDUCT.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo specific conduct document. |
| `CONTRIBUTING.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo specific contributing guide. |
| `CONTEXT.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo repository context document. |
| `PRIVACY.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo privacy document. |
| `RELEASING.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo release guide. |
| `REVIEW.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo code review guide. |
| `SECURITY.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo security vulnerability policy. |
| `TESTING.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo testing documentation. |

---

## 4. Documentation Directory (`docs/*`)

| Path | Classification | Action |
| :--- | :--- | :--- |
| `docs/adrs/*` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. ADR-001 through ADR-009. |
| `docs/models/*` | **`OUR_EVAL`** | **RETAIN**. `qwen2.5-coder-7b.md` model card. |
| `docs/research/*` | **`ATTRIBUTION_REFERENCE`** | **RETAIN**. `kilo-audit.md`, `secondary-audit.md`, `starting-strategy.md`, and this ownership audit. |
| `docs/superpowers/*` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Execution plan history. |
| `docs/architecture/*` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Architecture reference. |
| `docs/sprints/*` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. Sprint documentation index. |
| `docs/jetbrains-vscode-settings-parity.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo settings parity research. |

---

## 5. Evaluation Suites & Skills (`evals/*`, `.agents/*`)

| Path | Classification | Action |
| :--- | :--- | :--- |
| `evals/results/*` | **`OUR_EVAL`** | **RETAIN**. Empirical benchmark JSON/Markdown evidence for Qwen2.5-Coder-7B. |
| `.agents/skills/*` | **`OUR_PROJECT_MEMORY`** | **RETAIN**. `repo-intake`, `upstream-audit`, `change-with-tests`. |

---

## 6. Build Infrastructure, Toolchain, and Upstream Artifacts

| Path | Classification | Action |
| :--- | :--- | :--- |
| `package.json` | `SHARED_BUT_CONFIGURED_FOR_US` | **REPLACE**. Minimal npm workspace root manifest. |
| `package-lock.json` | `SHARED_BUT_CONFIGURED_FOR_US` | **NEW**. Clean npm lockfile for Node 24 toolchain. |
| `.gitignore` | `SHARED_BUT_CONFIGURED_FOR_US` | **RETAIN/UPDATE**. Standard gitignore for node/dist/evals. |
| `.oxlintrc.json` | `SHARED_BUT_CONFIGURED_FOR_US` | **RETAIN**. Linter configuration. |
| `.editorconfig` | `SHARED_BUT_CONFIGURED_FOR_US` | **RETAIN**. Formatting configuration. |
| `.github/workflows/ci.yml` | `SHARED_BUT_CONFIGURED_FOR_US` | **NEW**. Minimal unified multi-OS CI workflow. |
| `.github/workflows/agent-eval.yml` | `SHARED_BUT_CONFIGURED_FOR_US` | **RETAIN**. On-demand Ollama model benchmark workflow. |
| `.github/workflows/*` (30 files) | `UPSTREAM_KILO` | **REMOVE**. Kilo CI, release, and packaging workflows. |
| `.github/actions/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo bun setup action. |
| `.github/CODEOWNERS` | `UPSTREAM_KILO` | **REMOVE**. Kilo codeowners. |
| `.github/ISSUE_TEMPLATE/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo issue templates. |
| `.github/codeql/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo codeql queries. |
| `.github/docs-sync/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo doc sync scripts. |
| `.github/publish-python-sdk.yml` | `UPSTREAM_KILO` | **REMOVE**. Kilo Python SDK publisher. |
| `.github/pull_request_template.md` | `UPSTREAM_KILO` | **REMOVE**. Kilo PR template. |
| `script/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo build/test/release scripts. |
| `translations/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo README translations. |
| `patches/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo bun package patches. |
| `nix/*`, `flake.nix`, `flake.lock` | `UPSTREAM_KILO` | **REMOVE**. Kilo Nix configuration. |
| `specs/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo internal design specs. |
| `plans/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo legacy plans. |
| `artifacts/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo legacy artifacts. |
| `bin/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo launcher binaries. |
| `github/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo GitHub assets. |
| `perf/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo performance traces. |
| `.changeset/*` | `UPSTREAM_KILO` | **REMOVE**. Changesets for Kilo release management. |
| `.husky/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo pre-commit hooks. |
| `.kilo/*`, `.kilocode/*` | `UPSTREAM_KILO` | **REMOVE**. Kilo runtime state. |
| `.opencode/*`, `.opencode-version` | `UPSTREAM_KILO` | **REMOVE**. OpenCode runtime state. |
| `kilocode-2.code-workspace` | `UPSTREAM_KILO` | **REMOVE**. Kilo VS Code workspace configuration. |
| `bunfig.toml`, `bun.lock` | `UPSTREAM_KILO` | **REMOVE**. Kilo Bun lockfile and config. |
| `turbo.json` | `UPSTREAM_KILO` | **REMOVE**. Turbo monorepo config. |
| `install`, `logo.png` | `UPSTREAM_KILO` | **REMOVE**. Kilo installer script and logo. |
| `.dockerignore`, `.envrc`, `.gitleaksignore` | `UPSTREAM_KILO` | **REMOVE**. Kilo deployment/env files. |
