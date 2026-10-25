# ADR-036: Visual Integration Manager, Account Profiles & MCP Lifecycle UX

- **Status**: Accepted
- **Date**: 2026-10-25
- **Sprint**: 8C
- **Preceded by**: ADR-015 (Bounded MCP Integration), ADR-029 (Portable Skills Runtime), ADR-034 (MCP Modern Transports & Governance), ADR-035 (Private Accounts & Integration Profiles)

---

## 1. Context

In Sprint 8A, 8A.1 and 8B, Open VS Code developed robust underlying foundations for Model Context Protocol (MCP) transports (`stdio`, `streamable_http`, `sse`), local capability governance (`PermissionGate`), secret storage (`VsCodeSecretProvider`), and private account services (`@open-vs-code/account-service`).

However, user experience was previously driven primarily through text commands, manual JSON configuration files, and VS Code QuickPick dialogs. Developers lacked:
1. A visual hub to inspect connected and available MCP servers, monitor connection health, and view tool inventories.
2. A safe, guided wizard to configure new integrations without risking plaintext credential exposure or executing automated commands prematurely.
3. Transparent provenance and workspace policy management: distinguishing workspace-defined, local, and account-persisted integrations.
4. Strict security closure over account switching, redirect following, credential clearing, and SQLite driver fail-closed requirements.

---

## 2. Decision

### A. Separation of UI and Execution Authority
The Visual Integration Manager is implemented strictly as a presentation and configuration layer:
```text
Open VS Code UI (Webview)
  → IntegrationManagerController
    → DesktopAccountManager / AccountClient → Private Account Backend
    → McpService / McpCatalog → Transports
```
- **Invariant**: The user interface never invokes external MCP tools directly or bypasses `PermissionGate`.
- **Invariant**: Tool permissions are derived exclusively from local trusted policy (`classifyMcpAction`), not from server-authored hints alone. Server annotations can never lower risk to read.
- **Invariant**: Displaying an integration in the UI never automatically starts child processes or establishes remote network connections until explicitly requested.

### B. Ownership-Aware Reconciliation & Account Isolation
Provenance is explicitly tracked for all integrations:
- `workspace`: Defined in `.open-vs-code/mcp.json` or workspace settings. Never deleted or modified during account reconciliation.
- `local`: Added locally through the Add MCP wizard with local scope. Persisted locally.
- `account`: Synchronized from the user's private account backend.

Reconciliation rules:
- **Logout**: Disconnects all active transports for account-owned integrations and unregisters them from `McpCatalog`. Local and workspace integrations remain completely intact.
- **Account Switch**: Cleans up all registrations and active transports from User A before synchronizing User B.
- **Remote Deletion**: When an integration is deleted or disabled on the remote backend, the next synchronization unregisters it locally.
- **Offline Resilience**: Offline mode marks cached account integrations as stale; local coding, local inference, and local integrations remain 100% operational. Unconfirmed writes fail closed without optimistic illusions.

### C. Account Transport Security
`AccountClient` enforces:
- Rejection of remote plaintext HTTP (only loopback `127.0.0.1`, `localhost`, `::1` allowed for development HTTP; remote requires TLS HTTPS).
- Rejection of URLs containing embedded credentials.
- Automatic clearing of cached auth tokens when switching target backend URLs.
- Manual inspection of HTTP redirects: rejects cross-origin redirects while authenticated, protocol downgrades (HTTPS -> HTTP), and redirect targets containing embedded credentials.
- Clearing of cached session credentials on HTTP 401 or `ACCOUNT_DISABLED` responses to prevent stale authenticated state.

### D. SQLite Fallback Fail-Closed
The CLI fallback database driver (`sqlite3` subprocess) lacks atomic multi-statement transactions, persistent foreign keys, and reliable DML row counts. In accordance with ADR-035 and fail-closed safety, runtime database initialization strictly requires Node 22+ with native `node:sqlite`. The CLI fallback fails closed with `UnsupportedDatabaseRuntimeError`.

### E. Visual Integration Hub Structure
The webview UI provides five primary navigation surfaces:
1. **Profile**: Displays account status, authenticated user role, backend origin, profile cache status, and login/logout/sync controls.
2. **MCP Servers**: Live dashboard showing connection state, transport, provenance badge (`account`, `local`, `workspace`), workspace policy toggle, tool count, and action buttons (Connect, Disconnect, Inspect, Remove). Includes the 5-step Add MCP wizard.
3. **Skills**: Inventory of portable built-in and workspace skills, schema inspection, validation diagnostics, and direct links to `SKILL.md`.
4. **Modes**: Explicitly disabled placeholder surface with descriptive notices to prevent dead controls until future capability pack milestones.
5. **Diagnostics**: Aggregated health status, configuration warnings, network reachability, and account sync status.

---

## 3. Consequences

- **Security**: Complete account isolation prevents cross-account credential or integration leakage. Third-party servers cannot execute commands without explicit user configuration.
- **User Experience**: Developers have full visual insight into their toolchain without manual JSON editing or hidden background processes.
- **Reliability**: Deterministic lifecycle guarantees no zombie transports or orphan registrations linger across logout or workspace changes.
- **Upstream Alignment**: Matches VS Code extension guidelines, adheres to MCP 2026-07-28 specifications, and honors Cline/VSCodium architectural patterns without adopting proprietary Cursor internals.
