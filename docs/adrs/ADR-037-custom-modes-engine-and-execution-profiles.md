# ADR-037: Custom Modes Engine, Mode Profiles & Account-Aware Execution

- **Status**: Accepted
- **Date**: 2026-10-25
- **Sprint**: 8D
- **Preceded by**: ADR-018 (Chat UX Layer), ADR-023 (System Security Boundaries), ADR-029 (Portable Skills Runtime), ADR-030 (Structured Engineering Loop), ADR-033 (Persistent Conversation History), ADR-034 (MCP Modern Transports & Governance), ADR-035 (Private Accounts & Integration Profiles), ADR-036 (Visual Integration Manager & MCP Lifecycle UX)

---

## 1. Context

Open VS Code provides five canonical execution modes: `ASK`, `PLAN`, `BUILD`, `DEBUG`, and `REVIEW`. These modes define distinct permission ceilings and operational envelopes enforced by the `PermissionGate` and `AgentRuntime`.

Developers frequently express a desire to specialize agent behavior for specific domain workflows—such as architecture analysis, reverse engineering, UI design exploration, or focused security audits. However, naive approaches in other agent frameworks introduce severe architectural and security hazards:
1. **Proliferation of Autonomous Agent Runtimes**: Spawning independent agent sub-frameworks for each role, multiplying surface area, divergence, and unvetted prompt engineering.
2. **Permission Boundary Degradation**: Allowing user-authored or remote agent "personalities" to bypass confirmation dialogs, approve their own mutations, execute arbitrary shell fragments, or reclassify dangerous tools as safe.
3. **Execution Ambiguity & Drift**: Modifying prompt instructions or tool access mid-task, leading to unpredictable agent state and impossible debugging.
4. **Credential & Code Injection**: Storing credentials or executable scripts inside mode configurations that are loaded from untrusted repositories.
5. **Account & Workspace Confusion**: Leaking custom configurations between users on multi-user systems or unauthenticated environments.

---

## 2. Core Architectural Decision: Profile, Not Agent

**A custom mode is a configuration profile, not an independent agent.**

We preserve the existing five canonical execution modes in `AgentMode`. We do not extend the `AgentMode` enum for each custom role. Instead, we introduce a deterministic resolution pipeline:

```text
CustomModeProfile (Manifest / Declaration)
       │
       ▼
ModeResolver (Deterministic Snapshot Evaluation)
       │
       ▼
ResolvedExecutionProfile (Immutable Runtime Contract)
       │
       ▼
AgentSessionBridge (Existing Session Orchestrator)
       │
       ▼
AgentRuntime (Existing Single Authoritative Agent Loop)
```

Every custom profile maps to **exactly one** canonical base `AgentMode`:
- `Architecture Review` → `REVIEW`
- `Reverse Engineering — Analysis` → `PLAN`
- `Design Exploration` → `PLAN`
- `Feature Implementation` → `BUILD`
- `Security Investigation` → `REVIEW`

---

## 3. Custom Mode Profile Manifest & Strict Validation

Custom mode profiles are declarative, versioned configurations (`version: 1`). Arbitrary executable code, shell scripts, or provider credentials inside manifests are strictly prohibited.

### A. Manifest Schema (`CustomModeProfile`)
- `id`: Stable kebab-case or alphanumeric identifier (1–64 characters).
- `name`: Human-readable display name (1–100 characters).
- `description`: Summary of mode purpose (1–500 characters).
- `baseMode`: Canonical `AgentMode` (`ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW`).
- `icon`: Safe icon identifier (e.g., `symbol-structure`, `search`, `palette`).
- `version`: Positive integer schema version (currently `1`).
- `source`: Provenance classification (`builtin`, `account`, `workspace`).
- `customInstructions`: Optional bounded guidance text (max 8,000 characters).
- `requiredSkills`: Array of skill IDs that must be available for execution.
- `optionalSkills`: Array of skill IDs loaded if available.
- `requiredMcpServers`: Array of MCP server identifiers that must be connected.
- `optionalMcpServers`: Array of MCP server identifiers loaded if connected.
- `toolAllowlist`: Optional explicit allowlist of permitted tool names.
- `preferredModel`: Optional preferred model deployment ID.
- `workflowPreference`: Workflow compatibility (`direct`, `workflow`, `either`).
- `accountScope`: Account isolation scope (`user`, `team`, `system`).
- `createdAt` / `updatedAt`: ISO 8601 timestamps.

### B. Fail-Closed Validation Rules (`validateModeProfile`)
- Unknown fields are strictly rejected.
- Prototype pollution vectors (`__proto__`, `constructor`, `prototype`) are rejected.
- String properties are bounded against memory exhaustion attacks.
- Credentials and private keys (e.g., `AKIA...`, `BEGIN PRIVATE KEY`, `ghp_...`, bearer tokens) in instruction fields are rejected.
- Non-canonical base modes are rejected.
- Malformed profiles fail closed with actionable diagnostic errors.

---

## 4. Deterministic Profile Resolution (`ModeResolver`)

A `CustomModeProfile` cannot be executed directly. It must be deterministically resolved by `resolveExecutionProfile()` before any task commences.

The resolver synthesizes ten distinct inputs:
1. Candidate profile
2. Canonical base mode
3. Workspace trust state
4. Current account identity and policy
5. Installed skills in `SkillRegistry`
6. Registered MCP servers in `McpCatalog`
7. Available runtime tools
8. Registered model deployments in `ModelRouter`
9. Global feature flags (e.g., workflow eligibility)
10. Runtime permission policy (`PermissionGate`)

### Resolution Invariants
- **Missing Required Skill**: Profile resolves as `isReady: false` with a blocking diagnostic.
- **Missing Optional Skill**: Skipped with an informational diagnostic; execution remains ready.
- **Disconnected Required MCP**: Profile resolves as `isReady: false` with a blocking diagnostic.
- **Disconnected Optional MCP**: Skipped with an informational diagnostic.
- **Tool Allowlist Restriction**: Permitted tools are computed as the intersection of base mode tools and the profile allowlist. A profile can narrow available tools, but never expand them.
- **Model Preference**: Validated against available deployments. If unavailable or invalid, explicitly recorded with fallback to the active default model; never triggers implicit weight downloads or unauthorized cloud calls.
- **Workspace Trust**: Untrusted workspaces block mutating modes (`BUILD`), restrict write tools, and block untrusted workspace-defined profiles.
- **Deterministic Readiness**: `isReady` is `true` if and only if zero blocking diagnostics exist. An unready profile cannot start an agent task.

---

## 5. Non-Bypassable Permission Authority

A custom mode profile is strictly a configuration and prompt guidance mechanism. It possesses **zero** authority to override security checks:
1. **Base Mode Ceiling**: A profile based on `REVIEW`, `PLAN`, or `ASK` can **never** execute workspace mutations, even if its prompt requests file creation or patching.
2. **PermissionGate Authority**: All tool invocations and side effects continue to be governed by `PermissionGate`. Profile instructions cannot auto-approve mutations, suppress user confirmation dialogs, or alter risk classifications (`mcp_external_destructive`, `workspace_mutation`).
3. **No Credential Escalation**: An account administrator or custom profile cannot elevate agent execution permissions beyond workspace policy.
4. **Prompt Invariant**: Custom instructions are injected exclusively into `projectInstructions` within `AgentRuntime`. The Webview never directly constructs model system prompts.

---

## 6. Execution Immutability & Mid-Task Guards

1. **Frozen Execution Snapshot**: Once a task begins, the `ResolvedExecutionProfile` is deeply frozen for that run.
2. **Active Task Guard**: Changing active modes or updating profile definitions while `activeTurn: true` is strictly prohibited. The UI and `ChatController` reject mode switch requests during active execution.
3. **Approval Isolation**: Pending user confirmations cannot be transferred or inherited across mode transitions.

---

## 7. Dual Persistence Scopes & Reconciliation

Mode profiles are persisted across two distinct scopes:

### A. Account Profiles (Cloud / Backend Scope)
- Stored in `@open-vs-code/account-service` database (`mode_profiles` table).
- Isolated by `owner_user_id` with foreign key cascade.
- Synchronized to the desktop client upon login.
- Fully purged from active desktop memory upon logout or account switch.
- Structured audit logging tracks `mode.created`, `mode.updated`, and `mode.deleted`.

### B. Workspace Profiles (Local / Repository Scope)
- Stored locally in `.open-vs-code/modes.json`.
- Trackable in Git for team sharing.
- Constrained by workspace path containment and workspace trust.
- Cannot execute or contain arbitrary scripts.

### C. Conflict Precedence
- When a workspace profile and an account profile share the same `id`, the **workspace profile takes precedence** for tasks in that workspace, emitting an informational diagnostic noting the local override.
- Built-in starter profiles cannot be overwritten or deleted.

---

## 8. Visual Modes Management UI

The inactive Modes placeholder introduced in Sprint 8C is replaced with a dedicated management interface in the Webview:
- **Modes Overview**: Lists all built-in, account, and workspace modes with provenance badges, base mode indicators, readiness chips, and enablement toggles.
- **9-Step Mode Creation & Editing Wizard**:
  1. Identity & Scope (ID, name, description, icon, scope)
  2. Base Mode Selection (`ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW`)
  3. Skills Selection (required vs optional)
  4. MCP & Tool Allowlist (server selection and tool filtering)
  5. Preferred Model Configuration
  6. Workflow Preference
  7. Custom Instructions & Bounded Guidance
  8. Effective Permissions Review
  9. Save & Activation
- **Mode Inspector**: Displays effective tools, dependencies, and validation diagnostics.
- **Actions**: Create, edit, duplicate, toggle, delete, and set active mode.

---

## 9. Canonical Starter Profiles

Three built-in starter profiles demonstrate the architecture:
1. `architecture-review`:
   - Base mode: `REVIEW`
   - Allowed tools: `read_file`, `list_directory`, `search_text`, `find_files`
   - Zero mutation authority. Focuses on codebase structure, dependency boundaries, and architectural conformance.
2. `reverse-engineering-analysis`:
   - Base mode: `PLAN`
   - Allowed tools: Read-only repository tools.
   - Evidence-grounded reconstruction planning without copying proprietary source code or claiming non-existent integrations.
3. `design-exploration`:
   - Base mode: `PLAN`
   - Allowed tools: Read-only repository tools.
   - Structural UI and layout analysis referencing design tokens without mutating repository code.

---

## 10. Backward Compatibility

- Existing chat conversations and session history continue to load seamlessly.
- Conversations recorded with canonical `AgentMode` retain full compatibility.
- New conversations record optional `customModeId`; schema validation gracefully defaults missing profile IDs to canonical base modes.

---

## 11. Sprint 8D.1 Runtime Closure & Production Invariants

Sprint 8D.1 completes the execution boundary between mode management and the runtime engine:
1. **Authoritative Capability Snapshot**: Capability resolution is performed via `IntegrationManagerController.getProductionCapabilitySnapshot()` deriving truth from live workspace trust, authenticated account session state, active account/workspace policies, installed skills, connected MCP servers, and available local model deployments.
2. **Unified MCP Catalog Lifetime**: `AgentRuntime` accepts an authoritative `mcpCatalog` reference from `McpService`, preventing duplicate process spawning and ensuring account-registered servers participate in execution.
3. **Accurate Tool Allowlists**: Tool names are mapped to real action categories (`KNOWN_REPOSITORY_TOOL_ACTIONS`), with effective tools computed as:
   $$\text{Effective Tools} = \text{Registered Tools} \cap \text{Base Mode Permissions} \cap \text{Profile Allowlist}$$
   An omitted allowlist preserves permitted base tools; an explicit empty allowlist (`[]`) permits zero tools.
4. **Base-Mode & Identity Guards**: `resolvedProfile.baseMode === executionMode` is strictly enforced at runtime entry; mismatched or unready profiles fail closed.
5. **Real-Time Account Isolation**: Account logout or switching immediately cancels active turns and invalidates account-dependent tool authority.

