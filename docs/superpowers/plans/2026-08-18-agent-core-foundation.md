# Agent Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable, editor-independent coding-agent foundation as deterministic TypeScript modules with bounded repository reads and comprehensive unit tests.

**Architecture:** Add a standalone `packages/agent-core` workspace package that imports only Node standard-library APIs. Keep contracts dependency-free, put transport and repository I/O behind explicit boundaries, and compose project instructions, one selected Skill, and code context only in the final context compiler.

**Tech Stack:** Node 24, TypeScript 5.8, Node built-in test runner, existing oxlint, npm-compatible package scripts.

**Execution status:** Complete on 2026-08-18. The final ladder passed 41 tests with clean typecheck, lint, build, and Git hygiene checks.

---

### Task 1: T-010 runtime and T-011 contracts

**Files:**
- Create: `packages/agent-core/package.json`
- Create: `packages/agent-core/tsconfig.json`
- Create: `packages/agent-core/src/contracts/{model,context,tools,agent,editor}.ts`
- Create: `packages/agent-core/tests/contracts/contracts.test.ts`

- [ ] Add package scripts `test`, `typecheck`, `lint`, and `build`, with no runtime dependencies.
- [ ] Write contract tests that instantiate every public contract, assert the five agent modes, and verify capability metadata can distinguish chat, reasoning, tools, FIM, embeddings, and streaming.
- [ ] Run `node --test packages/agent-core/tests/contracts/contracts.test.ts`; expect failure because contract modules do not exist.
- [ ] Add the minimal interfaces and readonly unions required by the test; do not import vendor or editor packages.
- [ ] Re-run the focused test; expect all contract tests to pass.

### Task 2: T-012 OpenAI-compatible provider

**Files:**
- Create: `packages/agent-core/src/model/{provider,openai-compatible}.ts`
- Create: `packages/agent-core/tests/model/openai-compatible.test.ts`

- [ ] Write local-HTTP tests for request shape, base URL normalization, model propagation, response parsing, timeout, cancellation, HTTP errors, malformed responses, and header redaction from errors.
- [ ] Run the focused test; expect failure because the provider module does not exist.
- [ ] Implement validated configuration and requests to `chat/completions` using injected/global `fetch`, a composed abort signal, bounded timeout, and typed errors.
- [ ] Re-run the focused test; expect all provider tests to pass.

### Task 3: T-013 deterministic context budget

**Files:**
- Create: `packages/agent-core/src/context/budget.ts`
- Create: `packages/agent-core/tests/context/budget.test.ts`

- [ ] Write tests for empty, tiny, exact-boundary, oversized-required, many-optional, duplicate, configurable priority, and negative-input cases.
- [ ] Run the focused test; expect failure because budget functions do not exist.
- [ ] Implement `estimateTokens`, `calculateBudget`, `rankContext`, and `fitContext` with stable deduplication and explicit required-context overflow.
- [ ] Re-run the focused test; expect all budget tests to pass.

### Task 4: T-014 Markdown discovery

**Files:**
- Create: `packages/agent-core/src/context/markdown.ts`
- Create: `packages/agent-core/tests/context/markdown.test.ts`
- Create: `packages/agent-core/tests/fixtures/markdown-project/*`

- [ ] Write fixture-backed tests for canonical discovery order, heading extraction, isolated section reads, keyword search, missing files, byte bounds, and repository escape rejection.
- [ ] Run the focused test; expect failure because Markdown utilities do not exist.
- [ ] Implement selective UTF-8 reads on top of a canonical workspace-path guard; never bulk-load files during discovery.
- [ ] Re-run the focused test; expect all Markdown tests to pass.

### Task 5: T-015 progressive Skills loader

**Files:**
- Create: `packages/agent-core/src/context/skills.ts`
- Create: `packages/agent-core/tests/context/skills.test.ts`
- Create: `packages/agent-core/tests/fixtures/skills-project/.agents/skills/*/SKILL.md`

- [ ] Write tests proving metadata-only discovery, explicit body loading, deterministic matching/order, malformed frontmatter rejection, missing files, and duplicate-name detection.
- [ ] Run the focused test; expect failure because the Skills loader does not exist.
- [ ] Implement a narrow YAML-frontmatter parser supporting required scalar `name` and `description` fields and delayed body reads through an injectable file reader.
- [ ] Re-run the focused test; expect all Skills tests to pass.

### Task 6: T-016 safe repository reads

**Files:**
- Create: `packages/agent-core/src/tools/{path-safety,read-file,list-directory,search-text,find-files}.ts`
- Create: `packages/agent-core/tests/tools/repository-tools.test.ts`
- Create: `packages/agent-core/tests/fixtures/simple-ts-project/*`

- [ ] Write tests for normal/nested reads, traversal, external absolute paths, missing/binary/oversized files, symlink escape where supported, huge directories, bounded search, ignored directories, and explicit ignored-file reads.
- [ ] Run the focused test; expect failure because repository tools do not exist.
- [ ] Implement realpath-based containment, byte/output/result limits, configurable ignore names, deterministic traversal, and explicit-file semantics without mutation or shell execution.
- [ ] Re-run the focused test; expect all repository-tool tests to pass.

### Task 7: T-017 permission policy

**Files:**
- Create: `packages/agent-core/src/tools/permissions.ts`
- Create: `packages/agent-core/tests/tools/permissions.test.ts`

- [ ] Write tests for the baseline action table, unknown-action safety, PLAN narrowing, BUILD overrides, and attempts to override hard denies.
- [ ] Run the focused test; expect failure because the permission engine does not exist.
- [ ] Implement action categories and `ALLOW | CONFIRM | DENY` classification with immutable hard-deny precedence.
- [ ] Re-run the focused test; expect all permission tests to pass.

### Task 8: T-018 agent state and events

**Files:**
- Create: `packages/agent-core/src/agent/{events,state}.ts`
- Create: `packages/agent-core/tests/agent/state.test.ts`

- [ ] Write deterministic-ID/time tests for normal lifecycle, model/tool failures, cancellation, invalid transitions, and terminal-state rejection.
- [ ] Run the focused test; expect failure because state modules do not exist.
- [ ] Implement an immutable transition reducer with explicit state/event compatibility and caller-supplied event metadata.
- [ ] Re-run the focused test; expect all lifecycle tests to pass.

### Task 9: T-019 minimal context compiler

**Files:**
- Create: `packages/agent-core/src/context/compiler.ts`
- Create: `packages/agent-core/src/index.ts`
- Create: `packages/agent-core/tests/context/compiler.test.ts`

- [ ] Write exact-output tests proving project instructions precede the task, only the selected Skill body is included, code is bounded, provenance is retained, duplicates are removed, and budget overflow is explicit.
- [ ] Run the focused test; expect failure because the compiler does not exist.
- [ ] Compose existing budget and context contracts without an LLM call or prompt mega-template, then export the public package surface.
- [ ] Re-run the focused test; expect all compiler tests to pass.

### Task 10: T-020 documentation and verification

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `PLAN.md`
- Modify: `SCRATCHPAD.md`
- Modify: `DECISIONS.md` and relevant ADR statuses only if implementation makes the decision actual

- [ ] Update project memory with only implemented architecture, completed task status, commands, limitations, and the exact next sprint.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` from `packages/agent-core`; expect exit code 0 for each.
- [ ] Run `git diff --check`; expect exit code 0.
- [ ] Inspect `git status --short`, `git diff --stat`, and the complete sprint diff for unrelated artifacts, vendor coupling, secrets, write-capable tools, terminal execution, or generated output.
