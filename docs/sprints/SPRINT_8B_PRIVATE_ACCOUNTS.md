# SPRINT 8B REPORT
## Private Account Backend, Authentication & Persistent Integration Profiles

- **Sprint**: 8B
- **Status**: Complete & Verified
- **Verdict**: `SPRINT_8B_ACCEPTED`
- **Branch**: `sprint/8b-private-accounts`
- **Base Commit**: `18c58d1f1f9a0c79dbba4e0f143713f0a0ea5007`
- **ADR Reference**: `docs/adrs/ADR-035-private-accounts-and-integration-profiles.md`

---

## 1. Executive Summary & Mission

Sprint 8B introduces a secure, private, administrator-controlled account backend and integration registry for Open VS Code without compromising its local-first, privacy-respecting core principles.

Key deliveries:
1. **Separately Deployable Account Service (`@open-vs-code/account-service`)**: A lightweight Node 22+ microservice providing identity, session management, integration registries, workspace policies, and audit logging.
2. **Private Administrator Provisioning**: Strict invite-free administration model. No public signup or anonymous registration. One-time bootstrap mechanism via administrative CLI (`open-vs-code-admin bootstrap`), with zero default credentials shipped.
3. **Cryptographic Rigor & Session Security**: Scrypt password hashing ($N=16384, r=8, p=1$), constant-time comparisons, dummy Scrypt verification to prevent timing-based username enumeration, high-entropy 32-byte opaque session tokens (`ovsc_sess_...`), verifier-only database persistence (SHA-256), and sliding-window rate limiting.
4. **Persistent Schema & Ownership**: Embedded SQLite engine with versioned migrations, foreign key constraints (`ON DELETE CASCADE`), and server-enforced ownership checks.
5. **Persistent Integration Registry & Credential Boundaries**: Manages saved MCP configurations, non-secret settings, and credential references. Clear credential boundary: client-executed integrations keep secrets in `vscode.SecretStorage`, while future server-side integrations use an AES-256-GCM vault with external master keys.
6. **Desktop Account Integration & Offline Resilience**: `DesktopAccountManager` within `@open-vs-code/vscode-integration` connects to the account service, persists sessions via native `SecretStorage`, and syncs integrations into `McpService`. If the backend is unreachable, the system gracefully falls back to `OFFLINE` or `STALE` without impeding local coding or local LLM inference.
7. **Independent MCP Interoperability**: Validated modern MCP `2026-07-28` interoperability against an independent mock MCP server without regressions.

---

## 2. Architecture & Boundary Contracts

```text
┌────────────────────────────────────────────────────────────────────────┐
│                       OPEN VS CODE DESKTOP                             │
│                                                                        │
│  ┌─────────────────────────┐            ┌───────────────────────────┐  │
│  │ DesktopAccountManager   │            │ Agent Runtime             │  │
│  │ - SecretStorage Token   │            │ - PermissionGate          │  │
│  │ - Online/Offline State  │            │ - Tool Registry & Exec    │  │
│  │ - QuickPick UI / Cmds   │            │ - Local Model Inference   │  │
│  └────────────┬────────────┘            │ - McpService (Client)     │  │
│               │                         └─────────────▲─────────────┘  │
│               │ REST / JSON-RPC                       │                │
│               │ (Bearer Token)                        │ Register       │
│               ▼                                       │ Configs        │
│  ┌────────────────────────────────────────────────────┴─────────────┐  │
│  │ Authenticated Account Client                                     │  │
└───────┬────────────────────────────────────────────────────────────────┘
        │
        ▼ (Loopback HTTP or Remote TLS)
┌────────────────────────────────────────────────────────────────────────┐
│               ACCOUNT SERVICE (@open-vs-code/account-service)          │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ HTTP Server (Loopback only for HTTP, 64 KB limit, CORS, Auth MW) │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│  ┌─────────────────┬────────────────┴┬─────────────────┬────────────┐  │
│  │   AuthService   │  AdminService   │ IntegrationSvc  │ VaultSvc   │  │
│  │ - Scrypt Hash   │ - Bootstrap     │ - MCP Profiles  │ - AES-GCM  │  │
│  │ - Token Verif   │ - User Mgmt     │ - Workspaces    │ - External │  │
│  │ - Rate Limiting │ - Audit Logs    │ - Policy Check  │   Key      │  │
│  └────────┬────────┴────────┬────────┴────────┬────────┴─────┬──────┘  │
│           └─────────────────┼─────────────────┘              │         │
│                             ▼                                │         │
│  ┌────────────────────────────────────────────────────────┐  │         │
│  │ SQLite Database (Foreign Keys, Migrations, Verifiers)  │◄─┘         │
│  └────────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────┘
```

### Separation of Concerns:
- **Account Backend owns**: User identities, session verification, roles (`ADMIN`, `USER`), account status (`ACTIVE`, `DISABLED`), integration profiles, workspace policies, encrypted vault records, and immutable audit logs.
- **Agent Runtime owns**: Tool discovery and execution, transport lifecycle, `PermissionGate` policy enforcement, model inference routing, workspace filesystem mutations, and conversation checkpoints.
- **Security Invariant**: Account `ADMIN` status grants account management rights only. It **never** bypasses `PermissionGate` or escalates local filesystem permissions.

---

## 3. Provisioning & Administration Model

### Bootstrap Mechanism
1. The service begins with zero users and bootstrap allowed.
2. The initial administrator is created via CLI:
   ```bash
   npx open-vs-code-admin bootstrap --username admin --role ADMIN
   ```
   (Password is securely requested via hidden prompt or `ADMIN_PASSWORD` environment variable; never passed via command-line arguments).
3. Once bootstrapped, subsequent bootstrap requests are strictly rejected with `BOOTSTRAP_DISALLOWED` (409 Conflict).

### Administrative Capabilities
- **User Creation**: Authenticated administrators create users (`POST /admin/users`) with explicit roles (`ADMIN` or `USER`).
- **Account Disablement**: Administrators can set user status to `DISABLED`. Disabling an account immediately revokes all active sessions.
- **Password Reset**: Administrators can reset user passwords, which invalidates all active sessions immediately.
- **Audit Logging**: All administrative actions (user creation, status changes, password resets) generate persistent records in the `audit_events` table with timestamp, actor, target, and outcome.

---

## 4. Authentication & Cryptographic Rigor

| Feature | Specification / Implementation |
| :--- | :--- |
| **Password Hashing** | Scrypt (RFC 7914) with $N=16384, r=8, p=1$, 32-byte salt, 64-byte derived key. |
| **Password Comparison** | Constant-time comparison using `crypto.timingSafeEqual`. |
| **Anti-Enumeration** | Timing-equalized dummy Scrypt verification performed on invalid usernames. |
| **Session Tokens** | 32-byte cryptographically secure random token (`ovsc_sess_...`). |
| **Token Storage** | Server stores only SHA-256 verifiers (`token_hash`), never raw session tokens. |
| **Rate Limiting** | Sliding window rate limiter enforcing max 5 failed attempts per 15 minutes per IP or username. Returns HTTP 429. |
| **Revocation** | Immediate server-side revocation on logout, status disablement, or password reset. |
| **Session Lifetime** | 30-day sliding expiration; touched upon valid access. |

---

## 5. Database Schema & Migrations

Database management uses an embedded SQLite driver (`node:sqlite` with native `DatabaseSync` on Node 22+, falling back cleanly to sqlite3 CLI).

### Tables:
1. `schema_migrations`: Version tracking (`version INTEGER PRIMARY KEY, applied_at TEXT`).
2. `users`: `id`, `username`, `password_hash`, `role`, `status`, `created_at`, `updated_at`.
3. `sessions`: `id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `revoked_at`, `last_used_at`. Foreign key to `users(id)` with `ON DELETE CASCADE`.
4. `integration_registrations`: `id`, `owner_user_id`, `server_id`, `display_name`, `transport`, `config_json`, `credential_ref`, `enabled`, `created_at`, `updated_at`, `schema_version`.
5. `integration_workspace_policies`: `id`, `user_id`, `integration_id`, `workspace_id`, `enabled`, `policy_json`, `created_at`, `updated_at`.
6. `audit_events`: `id`, `actor_user_id`, `action`, `target_id`, `outcome`, `details_json`, `created_at`.
7. `vault_secrets`: `id`, `owner_user_id`, `secret_key`, `ciphertext`, `iv`, `tag`, `created_at`, `updated_at`.

---

## 6. Persistent Integration Registry & Credential Boundary

### Registration vs Execution:
- **Registration**: Saved configuration and metadata in the account service.
- **Authentication**: Secret provider token (stored in client `SecretStorage`).
- **Connection**: Active network or process session in `McpService`.
- **Permission**: Authorization evaluated per tool call by `PermissionGate`.

Restoring an integration from the account registry populates the catalog but leaves the connection `DISCONNECTED` or `DISABLED` until explicitly connected or enabled.

### Credential Handling:
- **Client-Executed Integrations**: Secrets remain in the client's OS keychain via `vscode.SecretStorage`. The account service stores only non-secret configuration and a `credentialRef`.
- **Vault Service Interface**: Defined `VaultService` with `AesGcmVaultService` (authenticated AES-256-GCM encryption with HKDF key derivation from external `ACCOUNT_VAULT_KEY`). Defaults to `DisabledVaultService` if no key is provided, failing closed to prevent accidental plaintext storage.

---

## 7. Desktop Integration & Offline Resilience

`DesktopAccountManager` coordinates the account lifecycle within the desktop extension:
- **Secure Storage**: Session tokens are stored in `vscode.SecretStorage` under `open-vs-code.accountSession`.
- **State Machine**: Transitions across `DISCONNECTED`, `CONNECTING`, `AUTHENTICATED`, `OFFLINE`, `STALE`.
- **Offline Resilience**:
  - If the account server is offline, local editor operations, local tool execution, and local model inference remain 100% available.
  - Cached profile metadata is displayed with an explicit `STALE` indicator.
  - Write operations fail closed with clear error messaging rather than silent mock acceptance.

---

## 8. Independent MCP Interoperability Evidence

Validated against an independent mock MCP server running on loopback:
- Negotiated protocol version `2026-07-28`.
- Transmitted valid `params._meta` with `clientCapabilities` and `clientInfo`.
- Discovered and listed tools without connection errors.
- Verified that registering an integration from the account backend does not bypass local tool validation or auto-execute tools.

---

## 9. Verification Matrix

| Suite | Tests Run | Result | Notes |
| :--- | :--- | :--- | :--- |
| `packages/account-service` Unit | 24 | ✅ Pass | Password hashing, token verifier, rate limiter, vault encryption, schema migrations. |
| `packages/account-service` Integration | 30 | ✅ Pass | Bootstrap, user management, auth flow, session revocation, anti-enumeration, integration CRUD, policies, audit logging, HTTP API. |
| `packages/account-service` MCP Smoke | 2 | ✅ Pass | Independent reference compatibility, protocol 2026-07-28 negotiation. |
| `packages/vscode-integration` Account Tests | 5 | ✅ Pass | DesktopAccountManager login, logout, secret storage, stale profile caching, integration syncing. |
| `packages/vscode-integration` Full Suite | 137 | ✅ Pass | All MCP commands, terminal review, diff review, chat controller, autocomplete. |
| `apps/desktop` Smoke Tests | 13 | ✅ Pass | Packaging, extension manifests, bundle integrity. |
| `apps/desktop` Acceptance Tests | 5 | ✅ Pass | Packaged Electron launch, extension discovery, conversation persistence, responsiveness probe. |
| Workspace Linter (`oxlint`) | Full Repo | ✅ 0 Errors | Zero warnings, zero errors. |
| Workspace Typechecker (`tsc`) | Full Repo | ✅ 0 Errors | Zero errors across all workspaces with `strict: true` and `exactOptionalPropertyTypes: true`. |

---

## 10. Deployment Runbook

### Local Development:
```bash
# Set database path and run service on loopback (default port 4040)
export ACCOUNT_DB_PATH="$HOME/.open-vs-code/accounts.db"
npx tsx packages/account-service/src/admin/admin-cli.ts serve --port 4040

# Bootstrap initial administrator
npx tsx packages/account-service/src/admin/admin-cli.ts bootstrap --username admin --role ADMIN
```

### Configuration in VS Code:
- Set `open-vs-code.account.serverUrl` to `http://127.0.0.1:4040`.
- Execute command: `Open VS Code: Log In to Account`.
