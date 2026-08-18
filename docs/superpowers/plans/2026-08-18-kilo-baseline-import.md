# Kilo Baseline Import and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Kilo Code commit `91a337e31cd7675d680aeb13c92870b8f81bdf36`, verify its untouched baseline, map runtime/cloud coupling, and preserve a known-good checkpoint if the evidence supports one.

**Architecture:** Preserve the existing research/control commit as the first parent, then merge the exact Kilo commit as unrelated upstream history so provenance remains inspectable. Treat source and lockfiles as immutable during baseline validation; record commands, failures, runtime observations, and source-path evidence in project Markdown. Do not begin cloud isolation or product changes.

**Tech Stack:** Git, Bun (upstream-pinned version), TypeScript monorepo, Turbo, VS Code extension tooling, PowerShell on Windows.

---

### Task 1: Research-foundation checkpoint

**Files:**
- Create: `docs/superpowers/plans/2026-08-18-kilo-baseline-import.md`
- Verify: `AGENTS.md`, `PROJECT.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `PLAN.md`, `SCRATCHPAD.md`, `REFERENCE_MAP.md`, `docs/research/*.md`, `docs/adrs/*.md`

- [ ] Inspect `git status --short --branch`, branch, remotes, `core.longpaths`, and existing tracked/untracked files.
- [ ] Confirm the untracked tree contains only the documented research/control layer and local reusable skills.
- [ ] Inspect the staged diff with `git diff --cached --stat` and `git diff --cached --check`.
- [ ] Create the initial commit with message `chore: establish local AI IDE research foundation`, using a transparent command-scoped local author if no Git identity is configured.
- [ ] Record the resulting research-foundation SHA.

### Task 2: Pinned upstream import

**Files:**
- Preserve: Kilo upstream tree at commit `91a337e31cd7675d680aeb13c92870b8f81bdf36`
- Modify only if necessary for checkout: repository-scoped `.git/config`

- [ ] Add remote `upstream` with URL `https://github.com/Kilo-Org/kilocode.git`; do not create `origin`.
- [ ] Set repository-scoped `core.longpaths=true` before materializing the upstream tree.
- [ ] Fetch the exact approved SHA and verify the commit object resolves to the same 40-character SHA.
- [ ] Inspect the upstream root tree for collisions with the research/control paths.
- [ ] Merge the pinned commit with unrelated histories, preserving both parent histories and resolving only documentation/control-layer collisions in favor of an additive result.
- [ ] Verify `HEAD`, merge parents, upstream ancestry, clean status, root `LICENSE`, and `packages/kilo-vscode/THIRD_PARTY_LICENSES/continue.txt`.

### Task 3: Authoritative toolchain discovery and installation

**Files:**
- Inspect: `README.md`, `CONTRIBUTING.md`, `package.json`, `bun.lock`, `turbo.json`, `bunfig.toml`, `.github/workflows/*.yml`, and relevant package manifests/docs
- Create/modify later: `docs/research/runtime-cloud-map.md`, sprint evidence record, root state Markdown

- [ ] Extract the exact `packageManager`, workspace, install, lint, typecheck, test, build, extension, and development-host commands from the pinned source.
- [ ] Record Git, Node, Bun, pnpm, and VS Code availability/version; locate the previously identified bundled Node if ordinary `PATH` lacks it.
- [ ] If Bun is absent, install or provision exactly the upstream-pinned Bun version using the least invasive supported method and record it.
- [ ] Run the upstream dependency-install command unchanged and record exit code plus material warnings.
- [ ] If installation fails, reproduce once, classify it as `ENVIRONMENT`, `UPSTREAM`, `WINDOWS_COMPATIBILITY`, `NETWORK`, `DEPENDENCY`, or `UNKNOWN`, and repair only the environment when evidence supports that repair.

### Task 4: Untouched verification ladder

**Files:**
- Do not modify upstream manifests, lockfiles, source, prompts, providers, UI, or tests
- Record: verification evidence in sprint/project Markdown

- [ ] Run the authoritative architecture/lint gate and capture the exit code.
- [ ] Run the authoritative typecheck gate and capture the exit code.
- [ ] Run the documented package-scoped unit tests for the canonical runtime/core/extension surfaces and capture exact scope.
- [ ] Run supported integration tests and distinguish skipped environment-dependent suites.
- [ ] Run the full build and isolated extension build/package commands.
- [ ] Run CLI/server tests or smoke commands used by the canonical runtime.
- [ ] Reproduce and classify every failure before considering any compatibility patch; keep any unavoidable patch separate from untouched results.

### Task 5: Extension and agent/runtime smoke

**Files:**
- Create: a disposable fixture outside canonical source or under an ignored temporary path
- Inspect: extension development documentation, extension tests, activation events, command declarations, backend launch code

- [ ] Determine the supported Extension Development Host command from source/docs.
- [ ] Launch the real extension using the supported method and inspect activation, UI load, command registration, chat surface, settings/provider UI, console errors, and required configuration.
- [ ] In a tiny disposable workspace, test file read, search, reasoning, and—only when safely supported—one harmless edit/diff, terminal/test execution, and checkpoint behavior.
- [ ] Do not add secrets or require a paid API; document any login, cloud, model, or display blocker precisely.

### Task 6: Local-provider and runtime-network evidence

**Files:**
- Create: `docs/research/runtime-cloud-map.md`
- Inspect: provider UI/config, provider abstraction, request implementation, extension startup, telemetry/account/gateway/marketplace/session/hosted-agent/update paths

- [ ] Trace Ollama, LM Studio, generic OpenAI-compatible, and any other existing local-provider flow from UI/config through request implementation and agent runtime.
- [ ] Observe process/network behavior during cold startup, AI UI/provider settings, chat, local-provider use when possible, agent tools, and autocomplete initialization.
- [ ] Classify observed endpoints by trigger, component, requirement, purpose, and future disposition without capturing secrets.
- [ ] Create the cloud-coupling inventory with exact source paths and the critical path `VS Code -> extension host -> agent runtime -> tool runtime -> provider abstraction -> local provider -> local endpoint`.

### Task 7: Project state and known-good checkpoint

**Files:**
- Modify: `PLAN.md`
- Modify: `SCRATCHPAD.md`
- Modify if evidence changes it: `REFERENCE_MAP.md`, `DECISIONS.md`, `PROJECT.md`, `ARCHITECTURE.md`
- Create/update: sprint evidence record and `docs/research/runtime-cloud-map.md`

- [ ] Classify the baseline as `GREEN`, `GREEN_WITH_KNOWN_UPSTREAM_ISSUES`, `BLOCKED_ENVIRONMENT`, `BLOCKED_UPSTREAM`, or `UNKNOWN` from the recorded evidence.
- [ ] Update only project truths and task statuses established by this sprint; explicitly keep T-008 unstarted.
- [ ] Inspect the documentation diff and create a separate evidence/checkpoint commit.
- [ ] If and only if the baseline is sufficiently green, create annotated tag `baseline/kilo-91a337e-known-good` at the verified checkpoint.
- [ ] Run fresh proof commands for Git status/history/ancestry, selected passing gates, licenses, upstream SHA, and tag state before reporting completion.

