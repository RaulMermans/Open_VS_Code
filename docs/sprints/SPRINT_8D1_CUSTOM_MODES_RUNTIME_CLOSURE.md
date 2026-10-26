# SPRINT 8D.1 REPORT
## Custom Modes End-to-End Execution & Integration Closure

- **Sprint**: 8D.1 (Corrective Runtime Closure)
- **Status**: Complete & Verified
- **Verdict**: `SPRINT_8D1_ACCEPTED`
- **Branch**: `sprint/8d1-custom-modes-runtime-closure`
- **Starting Canonical Main**: `f9eb234df0652f8c398f8388bab818afa382177b` (PR #44)
- **ADR Reference**: `docs/adrs/ADR-037-custom-modes-engine-and-execution-profiles.md`

---

## 1. Executive Summary

Sprint 8D.1 closes the critical integration and execution gap between the Custom Modes visual management layer (introduced in Sprint 8D) and the real execution engine. Prior to this sprint, custom mode selection presented readiness states based on empty capability arrays and hardcoded values, disconnected workspace MCP catalogs from account registrations, resolved tool allowlists via literal action-name assumptions rather than tool registrations, and lacked end-to-end wiring from Webview events through `AgentSessionBridge`, `AgentRuntime`, `PermissionGate`, and real tool execution.

Sprint 8D.1 provides complete runtime closure:
1. **Production Capability Snapshot**: Replaced empty mock capability arrays with a single authoritative, runtime-grounded snapshot reflecting actual workspace trust, active account identity and policies, real registered tools with their canonical action categories, discovered and enabled skills, connected MCP servers, and available local model deployments.
2. **Unified MCP Ownership & Runtime Execution**: Bridged `McpService` and `AgentRuntime` so that account-registered and workspace MCP servers are passed directly to `AgentRuntime` via an authoritative `McpCatalog` reference, avoiding redundant subprocess spawning while strictly enforcing user, workspace, and mode authorization policies.
3. **Accurate Tool Allowlists**: Mapped concrete tool names to real action classifications (`KNOWN_REPOSITORY_TOOL_ACTIONS`), computing effective tools as:
   $$\text{Effective Tools} = \text{Registered Tools} \cap \text{Base Mode Permissions} \cap \text{Profile Allowlist (when defined)}$$
   Omitted allowlists preserve permitted base tools; explicitly empty allowlists (`[]`) permit zero tools.
4. **Strict Base-Mode and Profile Identity Guards**: Enforced `resolvedProfile.baseMode === executionMode` at the execution boundary (`AgentSessionBridge` and `AgentRuntime`). Rejected execution when profiles are disabled, missing, belonging to unauthenticated accounts, or unready.
5. **Full Execution Profile Wiring**: Wired model preferences (`effectiveModelId`) directly to `RoutedModelGateway`, respected workflow preferences (`effectiveWorkflow`) against global feature gates, injected required skills into `AgentRuntime` and context compilation, and applied bounded custom instructions as untrusted project instructions.
6. **Account State Invalidation & Isolation**: Attached real-time account state change listeners in `ChatController` to cancel active turns on account logout or switch, while `DesktopAccountManager` unconditionally purges account-provenance MCP registrations.
7. **20/20 End-to-End Acceptance Scenarios**: Implemented a comprehensive integration test suite verifying every layer against real local MCP stdio servers, real SQLite account databases, actual file mutations, and scripted model providers.
8. **Packaged Desktop Integration**: Verified in `desktop-smoke.test.ts` (Test 14) and `desktop-runtime-acceptance.test.ts` that selecting custom profiles in the packaged desktop app applies the true execution contract (prompts and tool allowlists), not merely updating UI labels.

---

## 2. Root Cause Analysis & Corrective Actions

| Component | Defect Prior to Sprint 8D.1 | Corrective Action in Sprint 8D.1 |
|---|---|---|
| **Capability Snapshot** | `ChatController` passed hardcoded `{ isWorkspaceTrusted: true, availableTools: [], ... }` | Implemented `IntegrationManagerController.getProductionCapabilitySnapshot()` deriving truth from `vscode.workspace`, `DesktopAccountManager`, `McpService`, `SkillRegistry`, and `loadRoutingConfigSync()`. |
| **MCP Execution Boundary** | `AgentRuntime` created its own local `McpCatalog` independently of `McpService`, ignoring account-owned MCP servers. | Updated `AgentSessionBridge` and `createAgentRuntime` to accept an external long-lived `mcpCatalog` from `McpService`, avoiding duplicate catalog instances or server processes. |
| **Tool Allowlist Logic** | Assumed every tool name mapped 1:1 to a `ToolAction` enum, stripping repository tools if named `read_file` instead of `read`. | Added `KNOWN_REPOSITORY_TOOL_ACTIONS` mapping in `ModeResolver` and `RegisteredToolInfo` contracts. Differentiated `undefined` (inherit base tools) from `[]` (empty toolset). |
| **Base Mode Enforcement** | Relied on Webview UI to ensure mode consistency; execution could mismatch underlying profile base mode. | Added fail-closed runtime verification: `resolvedProfile.baseMode !== mode` throws and aborts turn before any bridge or model call occurs. |
| **Model Preference** | `preferredModel` was saved in the profile but never routed to `ModelRouter`. | Exposed `preferredDeploymentId` on `RoutedModelGateway` and forwarded it as route requirements to `ModelRouter`. |
| **Skills Context** | Required skills did not enable skill selector if global flags or options were not explicitly wired. | Updated `AgentSessionBridge` and `AgentRuntime` to activate skills dynamically when `resolvedProfile.appliedSkills` has entries and `OPEN_VS_CODE_SKILLS !== "0"`. |
| **Account Logout Isolation** | Active turns could continue running after account logout; account-owned MCP servers lingered. | Added `notifyAccountChange()` in `IntegrationManagerController` triggering `cancelTurn()` in `ChatController`. Purged account servers in `DesktopAccountManager.cleanupAccountIntegrations()`. |

---

## 3. End-to-End Acceptance Scorecard (20/20 Scenarios)

The test suite in `packages/vscode-integration/tests/custom-modes-e2e.test.ts` exercises the complete path from mode selection through `ChatController`, `ModeService`, `IntegrationManagerController`, `ModeResolver`, `AgentSessionBridge`, `AgentRuntime`, `PermissionGate`, and real file/tool execution:

| # | Acceptance Scenario | Expected Behavior | Result |
|---|---|---|---|
| **1** | Built-in Architecture Review | Reads actual repository files (`read_file`); executes without mutations. | **PASS** (109.7ms) |
| **2** | Reverse Engineering Analysis | Uses permitted search/read tools (`search_text`); produces analysis. | **PASS** (45.8ms) |
| **3** | Custom BUILD Profile Mutation | Controlled file mutation (`create_file`); approved by host `requestConfirmation`. | **PASS** (74.0ms) |
| **4** | Equivalent PLAN Profile File Mutation | Attempted `create_file` blocked and denied by `PermissionGate`. | **PASS** (110.7ms) |
| **5** | Required Installed Skill Injection | Built-in `security-review` required by profile reaches compiled model prompt. | **PASS** (106.4ms) |
| **6** | Disabled Skills Feature Flag | `OPEN_VS_CODE_SKILLS=0` causes resolver diagnostic; execution fails closed. | **PASS** (59.3ms) |
| **7** | Required Connected MCP Server | `fixture_server` stdio process executes permitted `echo` tool round-trip. | **PASS** (136.2ms) |
| **8** | Account-Owned MCP Availability | Alice's registered MCP server participates in runtime snapshot & execution. | **PASS** (306.3ms) |
| **9** | Cross-Account MCP Isolation | Bob logs in; Alice's MCP server is absent from capability snapshot. | **PASS** (280.9ms) |
| **10** | Workspace MCP Policy Restriction | `setWorkspacePolicy(id, false)` blocks execution of profile requiring it. | **PASS** (447.9ms) |
| **11** | Missing MCP Dependency | Disconnected required MCP marks profile `isReady: false`; task blocked. | **PASS** (88.5ms) |
| **12** | Explicit Empty Tool Allowlist | `toolAllowlist: []` strips all tools; prompt contains zero tool declarations. | **PASS** (122.3ms) |
| **13** | Default (Omitted) Tool Allowlist | `toolAllowlist: undefined` retains all base-mode permitted tools. | **PASS** (52.8ms) |
| **14** | Preferred Model Routing | `preferredModel` reaches `RoutedModelGateway` and selects target deployment. | **PASS** (58.4ms) |
| **15** | Workflow Preference Gate | Profile requesting `direct` workflow bypasses structured engineering loop. | **PASS** (0.9ms) |
| **16** | Disabled Profile Rejection | `enabled: false` profile cannot execute; posts actionable diagnostic. | **PASS** (1.0ms) |
| **17** | Deleted Profile Rejection | Deleted profile does not fall back silently; fails closed with error. | **PASS** (0.6ms) |
| **18** | Base-Mode Mismatch Guard | Requesting `BUILD` mode with `PLAN` profile fails closed with explicit error. | **PASS** (0.8ms) |
| **19** | Untrusted Workspace Evaluation | Untrusted workspace blocks `BUILD` base mode; allows read-only `REVIEW`. | **PASS** (91.3ms) |
| **20** | Account Switch Invalidation | Account switch mid-task terminates active turn and revokes tool authority. | **PASS** (0.9ms) |

---

## 4. Packaged Desktop Integration

In `apps/desktop/smoke/desktop-smoke.test.ts`, Test 14 was implemented and validated against the real packaged macOS application (`Open VS Code.app`):
- Selecting custom profile `packaged-custom-plan` (`PLAN` base mode, custom instructions, allowlist `['read_file', 'search_text']`) via Webview message updates controller state.
- Dispatching `chat.send` executes against the real bundled extension and deterministic HTTP inference fixture.
- Custom instructions (`Packaged desktop custom plan instruction.`) reach the actual model request payload in the bundled extension.
- Tool definitions sent to the model are strictly filtered: `create_file` is absent, and only allowlisted tools are declared.
- Clean deactivation flushes all state with zero memory leaks.

---

## 5. Monorepo Verification Matrix

All canonical test suites, evaluations, and packaging gates were executed on Node 22 (`v22.23.2`):

| Check | Scope | Result | Details |
|---|---|---|---|
| `npm run typecheck` | Monorepo | **PASS** | 0 errors across 5 workspaces. |
| `npm run lint` | Monorepo | **PASS** | 0 warnings, 0 errors (oxlint on 286+ files). |
| `npm run build` | Monorepo | **PASS** | `ide-adapter` compiled; `vscode-integration` bundled (1.2 MB). |
| `npm test` | All Workspaces | **PASS** | All unit and integration suites passing (including 203/203 in `vscode-integration`). |
| `npm run eval:runtime` | `@open-vs-code/agent-core` | **PASS** | 14/14 tests, 111 measured scenarios, deterministic. |
| `npm run eval:skills` | `@open-vs-code/agent-core` | **PASS** | 38/40 selection accuracy (95.0%), 81.8% token avoidance. |
| `npm run eval:workflow` | `@open-vs-code/agent-core` | **PASS** | 14/14 eligibility correct; structured vs direct verification passed. |
| `npm run desktop:smoke` | `@open-vs-code/desktop` | **PASS** | 14/14 tests passing, including Category D packaged custom mode execution. |
| `npm run desktop:accept` | `@open-vs-code/desktop` | **PASS** | 5/5 tests passing; real VSCodium extension host & GUI tests pass. |

---

## 6. Architecture & Security Invariants Preserved

1. **No Second Agent Runtime**: Single authoritative execution pipeline (`AgentRuntime`) remains the sole executor of model turns and tools.
2. **PermissionGate As Final Authority**: Profile allowlists can only narrow tool access; `PermissionGate` retains absolute authority over file mutations, terminal commands, and destructive actions.
3. **No Optimistic UI Authority**: Execution readiness is evaluated immediately before turn start against the live production capability snapshot.
4. **Credential Safety**: No credentials or decrypted secrets are placed into `CustomModeProfile`, `ResolvedExecutionProfile`, or model context.
5. **Fail-Closed Default**: Any missing dependency, unready profile, account mismatch, or disabled feature flag rejects execution cleanly with diagnostic feedback.

---

## 7. Upstream Reference Ledger

| Component | Pinned Version / Source | License | Integration / Usage in Sprint 8D.1 |
|---|---|---|---|
| **VSCodium** | `1.135.0` (`5a73682ca091082675b10c9dc3f348c1d824d94f`) | MIT | Packaged desktop shell hosting bundled extension in smoke and acceptance tests. |
| **Model Context Protocol (MCP)** | Spec version `2024-11-05` | MIT | Authoritative catalog integration; stdio transport process tree lifecycle and graceful stream termination. |
| **SQLite (Node 22 Built-in)** | Node `v22.23.2` `node:sqlite` | MIT | Multi-user in-memory account service persistence and cross-account isolation fixtures. |
