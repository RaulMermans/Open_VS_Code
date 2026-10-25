# SPRINT 8C REPORT
## Visual Integration Manager, Account Profiles & MCP Lifecycle UX

- **Sprint**: 8C
- **Status**: Complete & Verified
- **Verdict**: `SPRINT_8C_ACCEPTED`
- **Branch**: `sprint/8c-visual-integration-manager`
- **Base Commit**: `1637670a83dd1e4a90980ab450ee3f154126137a` (PR #42)
- **ADR Reference**: `docs/adrs/ADR-036-visual-integration-manager-and-mcp-lifecycle-ux.md`

---

## 1. Executive Summary & Deliverables

Sprint 8C delivers a polished, account-aware Visual Integration Manager for MCP servers, portable skills, and account profiles in Open VS Code, building directly upon the infrastructure established in Sprints 8A, 8A.1, and 8B.

Key deliveries:
1. **P0 Security Closures**:
   - **Account-Switch Isolation & Deterministic Reconciliation**: Explicit provenance tracking (`account`, `local`, `workspace`). Logging out removes and disconnects account-owned integrations without deleting workspace or local configurations. Account switching purges User A integrations before loading User B. Remote deletions reconcile effective local state on synchronization.
   - **Endpoint Transport Security**: Remote plaintext HTTP rejected. URLs with embedded credentials rejected. Cached session tokens cleared when switching backend origins. Manual redirect inspection prevents authenticated cross-origin or downgrade redirects. Stale tokens cleared on HTTP 401 or account disablement.
   - **Workspace Policy Enforcement**: Integrations are constrained by workspace-specific policy; connections disabled in a workspace cannot be connected or invoked there even if enabled globally in an account.
   - **SQLite Runtime Fail-Closed**: Evaluated CLI fallback; verified that external child processes cannot ensure ACID transactions, foreign keys, or accurate DML row counts. Database initialization fails closed with `UnsupportedDatabaseRuntimeError` on unsupported engines, mandating native `node:sqlite` on Node 22+.
2. **Visual Integration Manager Hub**:
   - Integrated into the Open VS Code Webview (`ChatViewProvider`), toggleable from the sidebar header.
   - Fully styled using VS Code native theme CSS variables, responsive to narrow sidebars and larger detail panels.
   - Accessible keyboard navigation adhering to WAI-ARIA standards (`role="tab"`, `aria-selected`, `aria-controls`, `aria-live`).
3. **MCP Connections Dashboard**:
   - Displays server display name, transport, provenance badge, connection state (`CONNECTED`, `DISCONNECTED`, `DISABLED`, `FAILED`, `AUTH_REQUIRED`), tool count, endpoint/command details, and workspace availability.
   - Real action buttons (Add, Connect, Disconnect, Enable/Disable, Workspace Policy, Inspect Tools, Remove).
   - Zero silent auto-execution: merely rendering the dashboard does not launch child processes or establish network connections.
4. **5-Step Add MCP Wizard**:
   - **Step 1**: Transport selection (`stdio`, `streamable_http`, `sse`).
   - **Step 2**: Form configuration (server identifier, display name, endpoint URL, bearer credential reference and secret value, command, arguments, environment variable references, workspace scope).
   - **Step 3**: Local validation displaying network policy check, endpoint reachability, credential requirements, transport compatibility, and third-party trust warnings.
   - **Step 4**: Save and optionally connect (supports save-only without spawning background processes).
   - **Step 5**: Discovered tools summary with option to proceed to tool inspection.
5. **Tool Inspection & Local Permissions**:
   - Deep inspection of discovered tools displaying canonical name, description, and JSON schema parameters.
   - Tool permission classes derive strictly from trusted local policy (`classifyMcpAction`), not server-authored annotations.
   - Visual warning banners for destructive operations (`mcp_external_destructive`) and workspace content transmissions (`mcp_sensitive_data_transmission`).
   - Hard invariant: Webview UI never invokes external tools directly and cannot bypass `PermissionGate`.
6. **Skills Integration & Modes Placeholder**:
   - Skills section discovers built-in and workspace skills via `SkillRegistry`, displays validation diagnostics, and provides direct links to `SKILL.md`.
   - Modes section provides an explicitly non-interactive placeholder for future capability packs, avoiding dead controls.
7. **Diagnostics Surface**:
   - Live aggregated view of MCP catalog status, configuration diagnostics, and account backend reachability.

---

## 2. Architecture & Provenance Model

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        OPEN VS CODE WEBVIEW                            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Visual Integration Hub (renderIntegrationsHub)                   │  │
│  │ ├─ ProfileSection       ├─ McpDashboard      ├─ AddMcpWizard     │  │
│  │ ├─ ToolInspector        ├─ SkillsSection     ├─ ModesPlaceholder │  │
│  │ └─ DiagnosticsSection                                            │  │
│  └──────────────────────────────────▲───────────────────────────────┘  │
│                                     │ Webview Messages                 │
│                                     ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ChatController (chat-controller.ts)                              │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │ Dispatch                         │
│                                     ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ IntegrationManagerController                                     │  │
│  │ (packages/vscode-integration/src/integrations/)                  │  │
│  └──────────────┬───────────────────────────────────┬───────────────┘  │
│                 │                                   │                  │
│                 ▼                                   ▼                  │
│  ┌───────────────────────────────┐   ┌──────────────────────────────┐  │
│  │ DesktopAccountManager         │   │ McpService & McpCatalog      │  │
│  │ - Session SecretStorage       │   │ - Provenance Tracking        │  │
│  │ - Provenance: "account"       │   │   (account, local, workspace)│  │
│  │ - Reconcile on logout/switch  │   │ - Workspace Policy Gate      │  │
│  │ - Safe AccountClient          │   │ - Transports (stdio, http)   │  │
│  │ - Transport Security          │   │ - PermissionGate Mapping     │  │
│  └──────────────┬────────────────┘   └──────────────────────────────┘  │
└─────────────────┼──────────────────────────────────────────────────────┘
                  │ HTTPS (or Loopback HTTP)
                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│               PRIVATE ACCOUNT SERVICE (@open-vs-code/account-service)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Verification & Test Matrix

All tests execute on Node 22+ with native `node:sqlite`. 100% of test suites pass with zero regressions.

### A. Sprint 8C Automated Test Inventory (38 Tests)

1. **`packages/account-service/tests/unit/account-client-security.test.ts` (10 tests)**:
   - Accept loopback endpoints (`127.0.0.1`, `localhost`, `::1`).
   - Reject remote plaintext HTTP (`http://remote-host.com`).
   - Reject embedded credentials (`http://user:pass@127.0.0.1`).
   - Reject non-HTTP protocols (`file://`, `ftp://`).
   - Clear cached token when switching server URLs.
   - Reject cross-origin redirects when authenticated.
   - Reject redirects to remote plaintext HTTP.
   - Reject redirects containing embedded credentials.
   - Clear client token on 401 Unauthorized to prevent stale authenticated state.
   - Fail closed when `SqliteCliConnection` is instantiated.

2. **`packages/vscode-integration/tests/integration-manager.test.ts` (28 tests)**:
   - Initial state defaults to `profile` tab and empty wizard.
   - `setTab` switches tab and notifies listeners.
   - Alice logs in and syncs integrations into local catalog.
   - Logging out removes account-owned MCP registrations from catalog.
   - Account switch removes User A integrations before loading User B.
   - Deleting a remote integration reconciles effective local state on sync.
   - Workspace policy disables account integration for current workspace.
   - Server disabled by workspace policy cannot be connected (fails closed).
   - Wizard Step 1: select transport advances to Step 2.
   - Wizard Step 2: update form draft.
   - Wizard Step 3: validation rejects missing server ID and URL.
   - Wizard Step 3: validation warns on remote unverified endpoint.
   - Wizard Step 4: save without connecting persists locally without spawning processes.
   - Wizard Step 5: cancel wizard cleans up draft and resets.
   - Tool inspection sets inspecting server ID and applies local policy (`classifyToolPermission`).
   - Inspect tools clearing resets inspecting server ID.
   - `getSkillsInventory` lists built-in skills and reports runtime status.
   - `inspectSkill` selects skill and surfaces diagnostics.
   - Modes tab is recognized as non-interactive future placeholder.
   - Diagnostics section aggregates catalog and system diagnostics.
   - Server removal requires confirmation and can be cancelled.
   - `executeRemoveServer` deletes registration from catalog.
   - `renderIntegrationsHub` renders accessible tab bar with `role="tab"` and `aria-selected`.
   - `renderMcpDashboard` renders server cards, badges, and empty states.
   - `renderAddMcpWizard` renders step indicators and form inputs.
   - `renderToolInspector` renders security warnings and permission classes.
   - `renderModesSection` renders disabled future placeholder notice.
   - `renderProfileSection` renders unauthenticated state with login button.

### B. Full Repository Test Suite

| Test Suite | Total Tests | Passed | Failed | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Account Service Suite** | 66 | 66 | 0 | `PASSED` |
| **VS Code Integration Suite** | 165 | 165 | 0 | `PASSED` |
| **Desktop Smoke Suite (`npm run desktop:smoke`)** | 13 | 13 | 0 | `PASSED` |
| **Desktop Acceptance Suite (`npm run desktop:accept`)** | 5 | 5 | 0 | `PASSED` |
| **Total Verified Automated Tests** | **249** | **249** | **0** | `PASSED` |

### C. Build & Linter Verification
- `npm run typecheck`: 0 errors across all workspaces (`account-service`, `agent-core`, `cli`, `ide-adapter`, `vscode-integration`, `desktop`).
- `npm run lint`: 0 errors, 0 warnings across all workspaces.
- `npm run build`: Bundles `dist/extension.js` (1.1 MB) cleanly with esbuild.

---

## 4. Upstream References & Compliance

In accordance with ADR-001 (Reuse First) and `REFERENCE_MAP.md`:
- **`microsoft/vscode`**: Followed webview security guidelines (`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-...'`). Used native VS Code CSS variables (`--vscode-focusBorder`, `--vscode-editorWidget-background`, `--vscode-badge-background`).
- **`VSCodium/vscodium`**: Preserved complete compatibility with VSCodium desktop host, passing all real Electron/Chromium acceptance tests.
- **`modelcontextprotocol/typescript-sdk`**: Adhered to standard JSON-RPC 2.0 protocol and transport life-cycles (`2026-07-28` specification).
- **`cline/cline`**: Referenced clean tool inspection and permission confirmation concepts while keeping execution authority strictly inside `PermissionGate`.
- **Zero Proprietary Cursor Code**: Implemented from clean architectural specifications.
