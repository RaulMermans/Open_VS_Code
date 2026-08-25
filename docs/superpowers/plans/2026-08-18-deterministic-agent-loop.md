# Deterministic Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the editor-independent orchestration architecture with a deterministic, read-only, multi-turn agent loop driven by a scripted provider.

**Architecture:** Extend the authoritative model, tool, context, lifecycle, and permission contracts only where orchestration needs explicit data. Add a thin `AgentRunner` that recompiles bounded context each turn, routes every untrusted tool call through registry validation and permission policy, and returns compact results or resumable confirmation pauses. Keep the four existing repository tools as the only production capabilities.

**Tech Stack:** Node 24, TypeScript 5.8, Node built-in test runner, existing oxlint, Node standard library only.

**Execution status:** Complete on 2026-08-18. The final ladder passed 69 tests with clean typecheck, lint, build, Git whitespace, coupling, and artifact checks.

---

### Task 1: T-021/T-022/T-036 runner-facing model and result contracts

**Files:**
- Modify: `packages/agent-core/src/contracts/model.ts`
- Modify: `packages/agent-core/src/contracts/agent.ts`
- Create: `packages/agent-core/src/testing/scripted-model.ts`
- Test: `packages/agent-core/tests/agent/runner.test.ts`

- [x] Write tests for a scripted direct answer, ordered scripted responses, deliberate provider failure, request capture, and exhausted scripts; run them and confirm missing exports fail.
- [x] Add optional typed tool calls to `ModelResponse`, a deterministic scripted provider implementing `ModelProvider`, and compact `AgentResult`/failure/diagnostic contracts.
- [x] Re-run the focused tests and retain only the minimum provider behavior needed by the real contract.

### Task 2: T-023/T-024/T-026 tool registry and strict validation

**Files:**
- Modify: `packages/agent-core/src/contracts/tools.ts`
- Create: `packages/agent-core/src/tools/registry.ts`
- Create: `packages/agent-core/src/tools/read-only-registry.ts`
- Test: `packages/agent-core/tests/tools/registry.test.ts`

- [x] Write failing tests for registration, deterministic listing, concise model definitions, duplicate/unknown rejection, missing/wrong/extra arguments, and cancellation-aware invocation.
- [x] Implement one canonical registry holding separate public definitions, strict validators, permission action categories, and executors scoped to `{ workspaceRoot, signal }`.
- [x] Adapt `read_file`, `list_directory`, `search_text`, and `find_files` through that registry without adding mutation, terminal, Git, network, or host capabilities; rerun focused tests.

### Task 3: T-027/T-028 bounded observations and recompilation

**Files:**
- Create: `packages/agent-core/src/agent/observations.ts`
- Modify: `packages/agent-core/src/context/compiler.ts`
- Test: `packages/agent-core/tests/agent/observations.test.ts`
- Modify: `packages/agent-core/tests/context/compiler.test.ts`

- [x] Write failing tests for success/error provenance, byte bounding with explicit truncation, deterministic recent-first ordering, duplicate observation removal, stale omission, and required-context overflow.
- [x] Implement bounded structured observations and extend the compiler with a small recent-observation window mapped to optional context items.
- [x] Re-run focused tests and verify project instructions, current task, and a selected Skill remain required and precede optional observations.

### Task 4: T-025/T-029/T-030/T-031/T-032 lifecycle integration

**Files:**
- Modify: `packages/agent-core/src/agent/events.ts`
- Modify: `packages/agent-core/src/agent/state.ts`
- Modify: `packages/agent-core/tests/agent/state.test.ts`
- Create: `packages/agent-core/src/agent/runner.ts`
- Test: `packages/agent-core/tests/agent/runner.test.ts`

- [x] Write failing exact-trace tests for direct completion, one/multiple tools, recoverable invalid/tool failures, model failure, DENY, CONFIRM pause/approve/reject, cancellation, max turns, non-progress, and terminal resume rejection.
- [x] Extend the authoritative reducer with confirmation and explicit guard events, keeping all terminal transitions immutable.
- [x] Implement the thin runner: compile, request model, validate, classify permission, execute, bound observation, recompile, and repeat under `maxTurns` and repeated-call thresholds.
- [x] Ensure `AbortSignal` reaches provider and executor, cancellation is never mislabeled, confirmation never executes before approval, and event payloads remain compact; rerun focused tests.

### Task 5: T-033/T-034/T-035 deterministic fixture scenarios

**Files:**
- Create: `packages/agent-core/tests/fixtures/agent-scenarios/auth-flow/**`
- Create: `packages/agent-core/tests/fixtures/agent-scenarios/failing-test/**`
- Create: `packages/agent-core/tests/fixtures/agent-scenarios/tiny-repository/**`
- Create: `packages/agent-core/tests/agent/fixture-scenarios.test.ts`

- [x] Write three failing scripted flows whose final scripted step asserts the preceding real tool observations contain fixture evidence before returning an answer.
- [x] Add the smallest fixture files for authentication explanation, failing-test diagnosis, and repository summary.
- [x] Add a synthetic in-test confirmation tool and failure tools; verify approval, rejection, no pre-approval execution, recovery, containment, and bounded outputs.

### Task 6: Public surface, reuse record, documentation, and T-037 gates

**Files:**
- Modify: `packages/agent-core/src/index.ts`
- Modify: `ARCHITECTURE.md`
- Modify: `PLAN.md`
- Modify: `SCRATCHPAD.md`
- Modify: `DECISIONS.md` only if a decision status changes
- Modify: `REFERENCE_MAP.md`

- [x] Export the runner, registry, observations, and scripted provider; record Kilo's tool runtime as `REFERENCE_ONLY` for this sprint because its host/framework capabilities violate the package boundary.
- [x] Update project memory with only implemented Sprint 1D facts, limitations, verification evidence, and the exact Sprint 1E text.
- [x] Run the complete package `test`, `typecheck`, `lint`, and `build` gates with the bundled Node runtime, then `git diff --check`.
- [x] Search the package for postponed coupling (`vscode`, `kilo`, local-runtime names, `mcp`, child-process/shell execution, and Git mutation), inspect every match, inspect the full diff/status, and leave no generated artifacts.
