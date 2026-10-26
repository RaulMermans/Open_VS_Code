# SPRINT 8E REPORT
## Capability Packs — Declarative Packaging, Dependency Resolution & Governed Installation

- **Sprint**: 8E (Capability Packs)
- **Status**: Complete & Verified
- **Verdict**: `SPRINT_8E_ACCEPTED`
- **Branch**: `sprint/8e-capability-packs`
- **Starting Canonical Main**: `f7cc1c88b6c70158e90d399f57624467af96099e` (Sprint 8D.1 merged via PR #45)
- **ADR Reference**: `docs/adrs/ADR-038-capability-packs-architecture.md`

---

## 1. Executive Summary

Sprint 8E introduces the **Capability Packs** architecture for Open VS Code: a declarative packaging, dependency resolution, and governed installation subsystem that allows developers and teams to combine Custom Modes, portable Skills, MCP tools, workflow configurations, model capability preferences, and evaluation requirements into portable, versioned bundles.

### Core Achievements
1. **Single Authoritative Runtime Invariant**: A Capability Pack is a declarative bundle of references, not a secondary agent loop or parallel execution authority. Pack execution flows directly through `ModeResolver` into the existing `AgentSessionBridge`, `AgentRuntime`, and `PermissionGate`.
2. **Governed Lifecycle & Separation Rules**: Implemented 10 distinct, non-conflated lifecycle operations: *Import*, *Validate*, *Preview*, *Install*, *Enable*, *Activate*, *Disable*, *Update*, *Remove*, and *Rollback*. Enforced the fundamental security invariants:
   $$\text{Import} \neq \text{Install} \neq \text{Enable} \neq \text{Execute}$$
   Importing never runs commands, installs binaries, or contacts networks; installing stores records with `enabled: false`; enabling registers eligibility without granting ambient execution authority; and all tool actions remain governed by `PermissionGate`.
3. **Defense-in-Depth Manifest Validation**: Pack manifests are treated as untrusted external inputs. Manifests conform to schema `open-vs-code/capability-pack@v1` and are validated against SemVer syntax, cryptographic SHA-256 integrity digests, prototype pollution vectors (`__proto__`, `constructor`, `prototype`), path traversal sequences (`../`), embedded credentials (API keys, AWS secrets, private keys), and prohibited executable directives (`runCommand`, `postinstall`, `shell`, `exec`, `script`, `command`, `spawn`).
4. **Deterministic Fail-Closed Dependency Resolution (`PackResolver`)**: Resolves readiness across Custom Modes, Skills, MCP servers, MCP tools, model families, and workspace trust boundaries into 7 structured states (`READY`, `INSTALLED_INACTIVE`, `MISSING_DEPENDENCIES`, `INCOMPATIBLE`, `BLOCKED_BY_POLICY`, `UNTRUSTED`, `INVALID`). Never marks a pack `READY` if a required MCP server is disconnected or a required capability is missing.
5. **Dual-Scope Persistence & Account Isolation**:
   - **Account Packs**: Persisted in the authenticated user's private SQLite database (`capability_packs` table with foreign key cascades, user isolation, and audit logging) via `AccountService` and REST API endpoints.
   - **Workspace Packs**: Persisted locally in `.open-vs-code/packs.json`, Git-committable for reproducible team collaboration, subject to workspace trust.
   - **Precedence & Logout Cleanup**: Workspace configurations take precedence over Account configurations on ID collision. On logout or account switch, account-derived packs are instantly flushed from the active runtime and mode registry; workspace packs remain unaffected.
6. **Visual Integration Hub UX**: Extended the Visual Integration Manager with a 6th navigation tab ("Capability Packs"). Provides installed pack browsing, status badges (*Installed*, *Enabled*, *Ready*, *Running*, *Blocked*), manifest import wizard, detailed pack inspector, dependency graph breakdown, effective permissions, and update/rollback controls.
7. **Two Controlled Reference Packs**:
   - **Repository Architecture Review Pack (`repo-architecture-review`)**: Usable, read-only pack based on `REVIEW` base mode with repository inspection tools and evidence-backed reporting. Zero mutations permitted.
   - **MCP-Enabled Research Demonstration Pack (`mcp-research-demo`)**: Demonstrates declarative MCP tool requirements (`mcp_fixture_server_echo`), live connection readiness checks, and fail-closed blocking when the server is disconnected.
8. **Comprehensive Regression Suite & Gate Closure**:
   - 56 new unit, integration, and end-to-end tests covering all pack requirements.
   - 1,038 total passing tests across the monorepo (728 in `agent-core`, 83 in `account-service`, 227 in `vscode-integration`).
   - 100% clean typecheck across all 6 workspaces, 100% clean linting (0 errors, 0 warnings), 100% clean build.
   - Full regression evaluations passed: `eval:runtime` (14/14, 111 scenarios), `eval:skills` (38/40, 86.9% token reduction), `eval:workflow` (14/14, 5/5), `desktop:smoke` (14/14), `desktop:accept` (5/5 real Electron GUI tests).

---

## 2. Architecture & Security Invariants

### 2.1 The Execution Pipeline

A Capability Pack does not introduce a new agent loop. The entire lifecycle resolves deterministically into the existing execution stack:

```text
┌────────────────────────────────────────────────────────┐
│             Capability Pack Manifest (.json)           │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│   validatePackManifest (Untrusted Input Scanning)      │
│   - Schema version: open-vs-code/capability-pack@v1    │
│   - SemVer validation & SHA-256 integrity digest       │
│   - Prototype pollution prevention                     │
│   - Credential leakage & path traversal rejection      │
│   - Prohibited executable directive rejection          │
│   - Base mode permission ceiling enforcement           │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│     PackResolver (Deterministic Dependency Evaluation) │
│   - Custom Mode existence & schema                     │
│   - SkillRegistry check (required & optional)          │
│   - McpService & McpCatalog live connection & tools    │
│   - Preferred model family satisfiability              │
│   - Workspace trust verification                       │
│   - Policy gate checks                                 │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│   Installation Registry & Scope Resolution             │
│   - Workspace Scope: .open-vs-code/packs.json          │
│   - Account Scope: SQLite capability_packs table       │
│   - Precedence: Workspace overrides Account on match   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│   Custom Mode Activation (ModeService / ModeResolver)  │
│   - Registers underlying CustomModeProfile             │
│   - Sets active mode ID upon user selection            │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│         AgentSessionBridge (Existing Orchestrator)     │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│         AgentRuntime & PermissionGate (Supreme Authority)│
└────────────────────────────────────────────────────────┘
```

### 2.2 Security Ceilings and Prohibited Behaviors
- **No Package Scripts**: Never executes `npm install`, `npx`, shell commands, child processes, or container workflows during any lifecycle operation.
- **Permission Ceilings**: A pack referencing a `REVIEW` or `ASK` base mode cannot request mutating permissions (`canExecuteCommands: true` or `mutationAuthority: true`). Manifest validation rejects such manifests at import time.
- **Fail-Closed MCP Binding**: If a pack requires an MCP server that is disconnected or unregistered, its readiness status resolves to `MISSING_DEPENDENCIES`, and execution is blocked before any prompt or model call is generated.
- **Fail-Safe Integrity**: If an `integrity` hash is specified in the manifest, the validation engine calculates the SHA-256 digest of the manifest payload; any tampering immediately fails with `INVALID`.

---

## 3. Implementation Details

### 3.1 Package Contracts & Validation (`@open-vs-code/agent-core`)
- `packages/agent-core/src/packs/contracts.ts`:
  - `CapabilityPackManifest`: Schema definition with publisher metadata, source repository, version constraints, referenced custom mode, skills, MCP dependencies, model preferences, workflow preferences, evaluations, and permissions.
  - `InstalledCapabilityPack`: Scope-tagged record (`workspace` vs `account`), installation timestamps, enabled state, current version, and rollback metadata (`previousVersion`, `previousManifest`).
  - `PackReadinessResult`: Status enum and diagnostics.
- `packages/agent-core/src/packs/validation.ts`:
  - `validatePackManifest`: Validates schema, SemVer, URL structures, base mode constraints, and cryptographic integrity. Rejects prototype pollution (`__proto__`, `constructor`, `prototype`), path traversal (`../`), embedded credentials (`AKIA...`, private keys), and execution directives (`runCommand`, `postinstall`, `shell`, `exec`, `spawn`).
- `packages/agent-core/src/packs/resolver.ts`:
  - `resolvePackReadiness`: Deterministically evaluates pack dependencies against the runtime capability snapshot. Returns `READY`, `INSTALLED_INACTIVE`, `MISSING_DEPENDENCIES`, `INCOMPATIBLE`, `BLOCKED_BY_POLICY`, `UNTRUSTED`, or `INVALID`.
- `packages/agent-core/src/packs/starter-packs.ts`:
  - Canonical implementations of Reference Pack A (`repo-architecture-review`) and Reference Pack B (`mcp-research-demo`).

### 3.2 Database & Server-Side Persistence (`@open-vs-code/account-service`)
- `packages/account-service/src/db/migrations.ts`:
  - Migration 3: Creates `capability_packs` table with foreign key cascade on `owner_user_id`, unique constraint on `(owner_user_id, pack_id)`, and performance index.
- `packages/account-service/src/db/repositories/pack-repository.ts`:
  - SQLite repository implementing CRUD operations, version tracking, rollback storage, and user isolation.
- `packages/account-service/src/pack/pack-service.ts`:
  - Service implementing 10 lifecycle operations, permission checks, audit logging (`pack.installed`, `pack.updated`, `pack.enabled`, `pack.disabled`, `pack.rolled_back`, `pack.removed`), and validation.
- `packages/account-service/src/server/http-server.ts`:
  - REST endpoints at `/api/v1/packs` (`GET`, `POST`, `GET /:id`, `PATCH /:id`, `PUT /:id`, `POST /:id/rollback`, `DELETE /:id`).
- `packages/account-service/src/client/account-client.ts`:
  - Typed client methods for remote pack operations with strict loopback/TLS security checks.

### 3.3 VS Code Desktop Integration (`@open-vs-code/vscode-integration`)
- `packages/vscode-integration/src/packs/capability-pack-service.ts`:
  - Manages dual-scope pack registry (Workspace `.open-vs-code/packs.json` and Account synchronization).
  - Handles import, preview, install, enable, activate, disable, update, remove, and rollback.
  - Registers pack custom modes with `ModeService`.
  - Cleans up account packs upon logout while preserving workspace packs.
- `packages/vscode-integration/src/account/account-manager.ts`:
  - Hooked login/logout events to `CapabilityPackService.syncFromAccount()` and `cleanupAccountPacks()`.
- `packages/vscode-integration/src/integrations/integration-manager-controller.ts`:
  - Added 6th navigation tab (`packs`).
  - Added controller endpoints: `inspectPack`, `installPack`, `enablePack`, `disablePack`, `activatePack`, `updatePack`, `rollbackPack`, `removePack`, `importPackFromContent`.
- `packages/vscode-integration/src/webview-render-helpers.ts`:
  - `renderPacksSection`: Renders accessible pack cards, status chips (*Installed*, *Enabled*, *Ready*, *Running*, *Blocked*), and action toolbars.
  - `renderPackInspector`: Renders detailed tabs for pack metadata, dependency graph, permissions, and rollback controls.
- `packages/vscode-integration/src/chat-protocol.ts`:
  - Added strongly-typed Webview messages for pack operations with prototype pollution defense.

---

## 4. End-to-End Acceptance Scorecard (8/8 Scenarios)

The comprehensive end-to-end integration test suite (`packages/vscode-integration/tests/capability-packs-e2e.test.ts`) verifies the entire pipeline:

| # | Acceptance Scenario | Expected Behavior | Result |
|---|---|---|---|
| **1** | Reference Pack A: Read-Only Tool Execution | Executes permitted read tools (`read_file`, `search_text`) through `AgentSessionBridge` into `AgentRuntime`. Zero mutation permitted. | **PASS** (892ms) |
| **2** | Reference Pack A: Mutating Tool Blocked | Attempted `create_file` blocked and denied under `REVIEW` base mode by `PermissionGate`. | **PASS** (807ms) |
| **3** | Reference Pack B: MCP Fail-Closed Enforcement | Fails closed with `MISSING_DEPENDENCIES` when `fixture_server` is disconnected; resolves to `READY` and executes `echo` tool when connected. | **PASS** (856ms) |
| **4** | Custom Pack Lifecycle Separation | Install does NOT enable (`enabled: false`); Enable does NOT execute (requires explicit mode activation). | **PASS** (438ms) |
| **5** | Malicious Manifest Rejection | Rejects manifests with path traversal (`../`), execution directives (`postinstall`), and embedded credentials (`AKIA...`). | **PASS** (3.8ms) |
| **6** | Pack Upgrade & Rollback | Updating pack preserves `previousVersion` and `previousManifest`; rollback successfully restores prior state. | **PASS** (44.3ms) |
| **7** | Logout Cleanup & Scope Isolation | Logout flushes account packs and deregisters custom modes; workspace packs remain active. | **PASS** (116ms) |
| **8** | Corrupt Registry Recovery | Malformed or corrupt `.open-vs-code/packs.json` is handled gracefully without crashing or corrupting runtime. | **PASS** (27.0ms) |

---

## 5. Verification & Test Counts

### 5.1 Test Suites Summary
| Package | Test Suites | Total Tests | Passing | Failing |
|---|---|---|---|---|
| `@open-vs-code/agent-core` | 53 | 728 | 728 | 0 |
| `@open-vs-code/account-service` | 13 | 83 | 83 | 0 |
| `@open-vs-code/vscode-integration` | 35 | 227 | 227 | 0 |
| **Monorepo Total** | **101** | **1,038** | **1,038** | **0** |

*Note: 56 new tests were added in Sprint 8E (22 in `agent-core`, 10 in `account-service`, 24 in `vscode-integration`).*

### 5.2 Regression Gates Verification
- **Typecheck** (`npm run typecheck`): 100% clean across all 6 workspaces.
- **Lint** (`npm run lint`): 100% clean (0 errors, 0 warnings across all files).
- **Build** (`npm run build`): 100% clean build.
- **Runtime Evals** (`npm run eval:runtime`): 14/14 tests, 111 scenarios passed.
- **Skills Evals** (`npm run eval:skills`): 38/40 selection accuracy (95.0%), 86.9% token reduction.
- **Workflow Evals** (`npm run eval:workflow`): 14/14 eligibility correct, 5/5 structured arm passed.
- **Desktop Smoke** (`npm run desktop:smoke`): 14/14 tests passed.
- **Desktop Acceptance** (`npm run desktop:accept`): 5/5 real Electron GUI tests passed.

---

## 6. Upstream Reference Ledger

In accordance with project operating rules, six upstream open-source repositories and systems were researched and classified:

| Source | License | Audited Commit / Tag | Mechanism Studied | Classification & Adoption | Rejected Alternatives |
|---|---|---|---|---|---|
| **Roo Code** (`RooCodeInc/Roo-Code`) | Apache-2.0 | `v3.8.0` (`7b1d402`) | Custom mode persistence, prompt enhancements, tool group assignments, and roomode export/import formats. | **REFERENCE_ONLY**: Studied declarative mode sharing and tool group assignment. Adapted strict declarative manifest without arbitrary instruction overrides. | Rejected: Roo Code's dynamic prompt interpolation without validation, unbounded tool group toggles, and lack of deterministic dependency resolution. |
| **Roo Code Documentation** (`RooCodeInc/Roo-Code-Docs`) | CC-BY-4.0 | `58c97da` | Custom mode configuration documentation, mode schema, tool restrictions, and sharing workflows. | **REFERENCE_ONLY**: Referenced documentation structure for custom mode schemas and user-facing lifecycle clarity. | Rejected: Community prompt sharing without integrity checks or permission bounds. |
| **Cline** (`cline/cline`) | Apache-2.0 | `40c5d99031fe` | Agent loop, custom modes, MCP client integrations, and permission approval checkpoints. | **ADAPT / REFERENCE_ONLY**: Adapted strict separation between mode profile and agent loop (`CustomModeProfile → ModeResolver → AgentRuntime`). Reused single authoritative runtime invariant. | Rejected: Spawning independent agent loops per mode or allowing custom modes to bypass user confirmation gates. |
| **Cline Skills** (`cline/skills`) | Apache-2.0 | `62cfbc9` | Declarative skill definitions, directory layout, prompt injection patterns, and tool bindings. | **REFERENCE_ONLY**: Analyzed skill packaging format and metadata requirements. Unified Skill references into Capability Pack manifests without copying third-party skill definitions. | Rejected: Arbitrary script execution hooks during skill installation; all skills in Open VS Code remain static, inspected markdown definitions. |
| **Anthropic Skills** (`anthropics/skills`) | Apache-2.0 / MIT | `2e4fa71` | Modular agent prompt engineering, skill invocation protocols, evaluation fixtures, and task benchmarks. | **REFERENCE_ONLY**: Studied benchmark tasks, structured evaluation criteria, and capability scoping. Adapted evaluation requirements into `CapabilityPackManifest.evaluations`. | Rejected: Unconstrained tool permissions and remote prompt fetching without pinned SHA-256 integrity digests. |
| **Model Context Protocol TypeScript SDK** (`modelcontextprotocol/typescript-sdk`) | MIT | v1.32.2 / v2.4.0 | MCP JSON-RPC protocol framing, stdio/SSE/Streamable HTTP transports, client capabilities, and server lifecycle. | **REFERENCE_ONLY**: Studied transport specifications and protocol handshake invariants. Implemented dependency-free native transports in `@open-vs-code/agent-core` (ADR-015, ADR-034). | Rejected: Direct npm dependency bundling of `@modelcontextprotocol/sdk` due to transitive dependency bloat and coupling. |

---

## 7. Conclusion & Next Steps

Sprint 8E successfully establishes a robust, secure, and governed Capability Packs system for Open VS Code. By strictly adhering to the principle that **a pack is a declarative bundle of references, not an independent agent runtime**, and enforcing the separation of **Import != Install != Enable != Execute**, Open VS Code ensures that agent extensibility never compromises user security, sandbox boundaries, or `PermissionGate` authority.

Next steps for subsequent sprints:
1. Support for team-shared capability pack catalogs over authenticated enterprise HTTP backends.
2. Capability Pack signing and cryptographic publisher verification.
3. Specialized Design Exploration and Reverse Engineering capability starter packs.
