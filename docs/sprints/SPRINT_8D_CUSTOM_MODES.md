# SPRINT 8D REPORT
## Custom Modes Engine, Mode Profiles & Account-Aware Execution

- **Sprint**: 8D
- **Status**: Complete & Verified
- **Verdict**: `SPRINT_8D_ACCEPTED`
- **Branch**: `sprint/8d-custom-modes`
- **Base Commit**: `3cdd112fb46db709525b3a15f3cfadcf504c40cf`
- **ADR Reference**: `docs/adrs/ADR-037-custom-modes-engine-and-execution-profiles.md`

---

## 1. Executive Summary & Deliverables

Sprint 8D implements a complete, deterministic, and secure **Custom Modes Engine** for Open VS Code. It empowers developers to define specialized AI coding profiles combining existing agent behaviors, installed skills, registered MCP tools, model preferences, and permitted workflows—without multiplying agent runtimes or compromising the existing permission architecture.

### Key Deliverables

1. **Core Architecture Invariant**:
   - **"A custom mode is a configuration profile, not an independent agent."**
   - Retained the five canonical base execution modes: `ASK`, `PLAN`, `BUILD`, `DEBUG`, and `REVIEW`.
   - Execution pipeline:
     ```text
     CustomModeProfile → ModeResolver → ResolvedExecutionProfile → AgentSessionBridge → AgentRuntime
     ```
   - No proliferation of autonomous sub-agent loops; all tasks execute through the single authoritative `AgentRuntime`.

2. **Declarative Manifest & Fail-Closed Validation**:
   - Versioned declarative schema (`CustomModeProfile`, version 1).
   - Strict validation rejecting prototype pollution (`__proto__`, `constructor`, `prototype`), unknown fields, credentials (`AKIA...`, `BEGIN PRIVATE KEY`, `ghp_...`, bearer tokens), non-canonical base modes, and oversized custom instructions.
   - Malformed profiles fail closed immediately with descriptive diagnostics.

3. **Deterministic Resolution Pipeline (`ModeResolver`)**:
   - Synthesizes candidate profile, base mode, workspace trust, account policies, installed skills, MCP catalog, available tools, model deployments, and feature flags.
   - Outputs an immutable `ResolvedExecutionProfile`.
   - Handles missing dependencies deterministically:
     - Missing required skill or MCP server → profile is blocked (`isReady: false`).
     - Missing optional skill or MCP server → omitted with visible warning diagnostic (`isReady: true`).
     - Tool allowlists restrict available base mode tools via intersection; cannot expand access.
     - Model preferences resolve to available deployments or fall back with explicit diagnostics.
     - Untrusted workspaces block mutating modes (`BUILD`) and enforce read-only tool restrictions.

4. **Non-Bypassable Permission Authority**:
   - Custom profiles can only restrict or focus tools; they cannot elevate authority beyond the base mode, workspace trust, or `PermissionGate`.
   - Mode instructions are treated as configuration guidance, injected exclusively into `projectInstructions` within `AgentRuntime`. The Webview never directly constructs privileged system prompts.

5. **Execution Immutability & Mid-Task Protection**:
   - Active task freezes the resolved execution profile for the entire duration of the run.
   - Attempting to switch modes or modify active profiles while `activeTurn: true` is strictly blocked by both the UI and `ChatController`.
   - Pending confirmations are never transferred across mode boundaries.

6. **Account-Aware Persistence & Synchronization**:
   - **Account Profiles**: Persisted in `@open-vs-code/account-service` database via Migration 2 (`mode_profiles` table), isolated by `owner_user_id` with foreign key cascade, full CRUD API routes, client methods, and audit logging (`mode.created`, `mode.updated`, `mode.deleted`).
   - **Workspace Profiles**: Persisted locally in `.open-vs-code/modes.json` within workspace realpath bounds.
   - **Reconciliation & Precedence**: Synchronized cleanly on login, purged from desktop memory on logout/account switch. Workspace profiles override account profiles sharing the same identifier, accompanied by an explanatory diagnostic.

7. **Visual Modes Management UI**:
   - Replaced the inactive Sprint 8C placeholder with a complete management interface in the Webview.
   - **Modes List**: Cards displaying icon, name, base mode badge, provenance, enabled toggle, readiness status, and action buttons ("Set Active", "Edit", "Duplicate", "Delete", "Inspect").
   - **9-Step Mode Creation & Editing Wizard**:
     1. Identity & Scope (ID, Name, Description, Icon, Scope)
     2. Base Mode Selection (`ASK`, `PLAN`, `BUILD`, `DEBUG`, `REVIEW`)
     3. Skills Selection (Required vs. Optional)
     4. MCP & Tool Allowlist (Server Selection & Tool Filtering)
     5. Preferred Model Selection
     6. Workflow Preference Selection
     7. Custom Instructions & Bounded Guidance
     8. Effective Permissions Review
     9. Save & Activation
   - **Mode Inspector**: Deep inspection of effective tools, permission restrictions, dependencies, and diagnostics.

8. **Chat Mode Picker Integration & Backwards Compatibility**:
   - Chat dropdown extended with `<optgroup label="Custom Profiles">`.
   - Active profile badge chip (`✓ ModeName [BASE]` or `⚠️ ModeName [BASE]`) displaying execution readiness and underlying base mode.
   - `conversation-store.ts` migration and schema update recording `customModeId` while maintaining 100% backward compatibility with existing session history.

9. **Canonical Starter Profiles**:
   - Built-in, strictly validated starter profiles:
     - `architecture-review` (Base: `REVIEW`) — Read-only repository structure and architectural conformance.
     - `reverse-engineering-analysis` (Base: `PLAN`) — Evidence-backed reconstruction planning without code duplication.
     - `design-exploration` (Base: `PLAN`) — UI component and design token structural analysis.

---

## 2. Verification Evidence & Test Summary

All packages, type checks, linters, unit tests, integration tests, evaluation harnesses, and desktop packaging tests pass deterministically.

### Test Matrix

| Test Suite / Quality Gate | Scope | Result | Notes |
| :--- | :--- | :--- | :--- |
| **`npm run typecheck`** | Monorepo-wide | ✅ 0 errors | All packages compile cleanly under strict TypeScript. |
| **`npm run lint`** | Monorepo-wide | ✅ 0 errors / 0 warnings | Strict ESLint / Oxlint checks across all files. |
| **`agent-core` Unit Tests** | Modes engine & core | ✅ 679/679 pass | 27 new tests in `modes-engine.test.ts` covering validation, starter profiles, resolver, and runtime invariants. |
| **`account-service` Integration Tests** | Account backend & DB | ✅ 73/73 pass | 7 new integration tests in `mode-management.test.ts` testing CRUD, user isolation, cascade, and audit logging. |
| **`vscode-integration` Unit Tests** | Extension & UI | ✅ 183/183 pass | 18 new tests in `custom-modes.test.ts` testing storage, resolution, chat controller guards, and webview rendering. |
| **`eval:runtime`** | Agent reasoning | ✅ 14/14 pass | All runtime evals pass deterministically. |
| **`eval:skills`** | Skill discovery & budget | ✅ 40/40 pass | 86.9% token reduction achieved. |
| **`eval:workflow`** | Engineering loop | ✅ 19/19 pass | 14 eligibility checks + 5 structured workflow completions. |
| **`desktop:smoke`** | Desktop shell | ✅ 13/13 pass | Electron smoke tests pass cleanly. |
| **`desktop:accept`** | Packaged VSCodium | ✅ 5/5 pass | Real packaged desktop runtime acceptance verified. |

---

## 3. Architecture & Security Invariants Preserved

1. **No Runtime Duplication**:
   - Did not create a `CustomModeAgent` or alternative runtime loops.
   - Single authoritative `AgentRuntime` in `@open-vs-code/agent-core` handles all execution.
2. **Permission Boundary Invariant**:
   - `PermissionGate` is immutable.
   - A mode profile can never grant mutation authority to a read-only base mode (`ASK`, `PLAN`, `REVIEW`).
   - A mode profile cannot bypass human confirmation dialogs for mutations or destructive actions.
3. **Fail-Closed Validation**:
   - Unknown properties, prototype pollution, embedded secrets, or invalid base modes trigger immediate validation failures.
   - Unready execution profiles (`isReady: false`) are blocked at runtime before any model query or tool invocation occurs.
4. **Zero Unchanged State Re-Rendering**:
   - Webview render pipeline tracks mode and badge signatures (`lastModesSig`, `lastBadgeSig`), guaranteeing zero DOM node creation on unchanged state pushes and preserving Sprint 7D performance guarantees.
5. **Account Isolation**:
   - Custom modes stored in the private account service are strictly partitioned by `owner_user_id`.
   - Logging out or switching accounts cleanly wipes remote profile cache from local extension memory.
