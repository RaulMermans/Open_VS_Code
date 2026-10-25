# ADR 035: Private Account Backend, Authentication & Persistent Integration Profiles

## Context
Open VS Code is designed as a private, local-first AI development environment combining editor UX with agentic workflows. As capabilities expand to include custom tool integrations, team/personal integration profiles, execution modes, and capability packs, users require persistent integration configurations and identities across development sessions.

However, several architectural hazards must be avoided:
1. **No Mandatory Cloud SaaS**: Open VS Code must never become a mandatory cloud service, hosted SaaS, or paid identity service.
2. **Runtime Independence**: The core Agent Runtime (`@open-vs-code/agent-core`, `PermissionGate`, tool execution, model inference, and workspace access) must remain local and decoupled from account availability.
3. **No Unauthenticated Account Creation**: Public signups, anonymous account creation, and default credentials represent severe security risks in self-hosted and private enterprise environments.
4. **Credential Leakage**: Third-party provider tokens and credentials must not be stored in plaintext configuration files, database tables, or synced across devices without explicit secret management.
5. **Offline Degradation**: If the account backend is unreachable or offline, existing local editing and inference must remain 100% operational.

## Decision

We establish a dedicated, lightweight, first-party account service (`packages/account-service`) and desktop integration layer (`DesktopAccountManager`) adhering to the following architectural decisions:

### 1. Separate Account Service Architecture
We implement `@open-vs-code/account-service` as an independent workspace package within the monorepo:
- **Boundary of Account Backend**: User identities, authentication sessions, role-based authorization (`ADMIN`, `USER`), persistent integration registrations, workspace integration policies, administrative management, audit events, and an optional encrypted vault.
- **Boundary of Agent Runtime**: Local tool execution, MCP client transports, dynamic discovery, `PermissionGate`, model gateway, workspace filesystem access, agent state, and checkpoints.
- **Invariance**: An account role of `ADMIN` grants administrative rights to the account service (user creation, credential resets) but does **not** grant arbitrary tool execution authority or bypass the local runtime's `PermissionGate`.

### 2. Private Administrator Model (Invite-Free, No Public Signup)
To guarantee private and enterprise security:
- Public signup endpoints do not exist (`POST /auth/register` is rejected or omitted).
- The first administrator is bootstrapped via a dedicated administrative CLI (`open-vs-code-admin bootstrap`) or environment variable bootstrap.
- The bootstrap operation is strictly one-time: subsequent attempts fail immediately (`BOOTSTRAP_DISALLOWED`).
- Passwords must meet a minimum length of 12 characters.
- All subsequent accounts must be created by an authenticated `ADMIN` (`POST /admin/users`).
- Administrators can activate/disable accounts and trigger administrative password resets. All administrative actions write immutable audit records to `audit_events`.

### 3. Secure Authentication & Cryptographic Standards
- **Password Hashing**: Implemented with Scrypt (RFC 7914) using standard parameters ($N=16384, r=8, p=1$), 32-byte cryptographically secure random salt, and constant-time equality checks (`timingSafeEqual`).
- **Timing Equalization / Anti-Enumeration**: Authentication attempts against nonexistent usernames execute a dummy Scrypt verification with identical cost parameters to prevent timing-based username enumeration.
- **Opaque Revocable Session Tokens**: Sessions generate high-entropy 32-byte tokens prefixed with `ovsc_sess_...`. The database persists only the SHA-256 verifier (`token_hash`), never the raw token.
- **Rate Limiting**: In-memory sliding-window limiter blocks brute-force authentication (5 failed attempts per 15 minutes per IP or username, returning HTTP 429).
- **Immediate Invalidation**: Disabling an account or resetting a password immediately revokes all active sessions for that user.

### 4. Persistence, Migrations & Ownership Constraints
- **SQLite Engine**: Utilizes embedded SQLite (`node:sqlite` `DatabaseSync` on Node 22+ with a robust CLI fallback) with foreign keys enabled (`PRAGMA foreign_keys = ON;`) and `ON DELETE CASCADE`.
- **Versioned Schema Migrations**: An incremental migration runner executes schema updates sequentially (`users`, `sessions`, `integration_registrations`, `integration_workspace_policies`, `audit_events`).
- **Server-Side Ownership Enforcement**: All profile and integration queries enforce ownership via `owner_user_id` bound to the authenticated session. User IDs and roles supplied by the client are never trusted.

### 5. Persistent Integration Registry & Credential Boundaries
The integration registry manages MCP configurations while strictly separating registration from execution:
- **Registration vs Execution**: A saved integration configuration does not imply that the server is connected, authorized, or executable. Local `stdio` registrations sync configuration metadata, but executable binaries must be validated on the host machine.
- **Client-Executed Integrations**: Provider credentials remain in client-side secure storage (`vscode.SecretStorage` via `VsCodeSecretProvider`). The account backend stores only a `credentialRef` string and non-secret configuration.
- **Vault Interface**: A formal `VaultService` abstraction is defined. The reference implementation (`AesGcmVaultService`) utilizes AES-256-GCM authenticated encryption with HKDF key derivation from a dedicated master key (`ACCOUNT_VAULT_KEY`) stored outside the database. In environments where no vault key is configured, `DisabledVaultService` fails closed, rejecting token storage. Plaintext secrets are never returned over profile or integration APIs.

### 6. Transport & Network Security
- **Loopback Enforcement**: In development, the HTTP server binds to `127.0.0.1` by default. Plain HTTP connections on non-loopback interfaces are strictly rejected; remote deployments mandate TLS/HTTPS.
- **Payload Ceiling**: Incoming HTTP request bodies are limited to a hard ceiling of 64 KB, with immediate stream draining on breach (`HTTP 413 Payload Too Large`).

### 7. Desktop Account Surface & Offline Resilience
- **Native VS Code Commands**: Exposes `open-vs-code.accountLogin`, `open-vs-code.accountLogout`, `open-vs-code.showAccountProfile`, and `open-vs-code.syncAccountIntegrations` using VS Code native QuickPicks and `SecretStorage`.
- **Offline & Partition Behavior**: If the account backend is offline or disconnected, local editor features, local inference, and local tool execution remain 100% operational. Cached profile data is explicitly marked as `STALE`, and write operations fail closed without silent corruption.

## Consequences

### Positive
- **Self-Sovereignty**: Users and private teams retain full control over their account data and integration profiles without depending on external cloud providers.
- **Security-First Lifecycle**: Private bootstrap, Scrypt hashing, verifier-only token persistence, and strict client credential boundaries prevent account takeover and token leakage.
- **Seamless Local Experience**: Full offline operation ensures Open VS Code remains an ultra-reliable local-first development tool.
- **Clean Architecture**: Decoupled `@open-vs-code/account-service` package with clear contracts allows independent evolution and testing.

### Neutral / Trade-offs
- Cross-device credential sync for client-executed MCP servers is intentionally not supported without local secret configuration, as client secrets remain in the local OS keychain.
- Multi-region or highly distributed teams requiring centralized user management must connect to a shared self-hosted backend over private TLS/VPN.
