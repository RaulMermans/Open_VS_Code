# ADR 034: MCP Modern Transports, Secure Connections & Tool Governance

## Context
Sprint 4A established initial Model Context Protocol (MCP) support with a bounded local `stdio` transport (`ADR-015`). Since then, the Model Context Protocol has evolved significantly:
- **Stateless Streamable HTTP (2026-07-28)**: Modern protocol specification replaces stateful connection handshakes with stateless per-request JSON-RPC POST requests carrying protocol negotiation metadata (`_meta.protocolVersion`), SSE server-sent progress events, and explicit chunked responses.
- **Session-Based Protocol (2025-11-25)**: Previous protocol version requiring `Mcp-Session-Id` header tracking and handshake initialization.
- **Legacy Handshake Protocol (2024-11-05)**: Earliest specification requiring connection-scoped `initialize` RPC handshake.

Integrating remote HTTP MCP servers introduces major security and operational failure modes that local stdio did not face: Server-Side Request Forgery (SSRF), DNS rebinding, credential leakage into configuration files or prompts, runaway streaming responses, protocol downgrade redirects, and silent workspace exfiltration under the guise of "read" operations.

Furthermore, remote tools require finer-grained governance than a simple binary `read`/`side_effect` distinction. An external read might transmit sensitive workspace tokens or proprietary code to a third-party server.

## Decision

We evolve the MCP integration into an enterprise-grade foundation (MCP Integration 2.0) without introducing a second agent runtime:

### 1. Zero-Dependency Modern Transport (`StreamableHttpMcpTransport`)
We evaluated the official `@modelcontextprotocol/sdk` (v1.32.2) and `@modelcontextprotocol/client` (v2.4.0). Installing the upstream SDK pulls between 13 and 56 transitive dependencies (`zod`, `jose`, `cross-spawn`, `eventsource`, `pkce-challenge`, etc.) and couples the editor extension to an evolving external client lifecycle.

Instead, we maintain zero runtime dependencies by implementing `StreamableHttpMcpTransport` natively over Node/WHATWG `fetch` and EventSource/SSE parsing:
- **Protocol Version Negotiation**: Emits modern `2026-07-28` metadata by default, seamlessly falling back to `2025-11-25` (`Mcp-Session-Id` header) and `2024-11-05` (`initialize` handshake) based on server response headers and status codes.
- **Bounds**: Enforces `requestTimeoutMs` (default 30s), `connectTimeoutMs` (default 10s), `maxResponseBytes` (default 50 KB ceiling), and hard limits on infinite streaming responses.

### 2. Strict Network Guard & SSRF Protection (`McpNetworkGuard`)
All remote MCP endpoints and redirect destinations are validated prior to connection:
- **HTTPS Enforcement**: HTTPS is required by default for all remote endpoints.
- **Controlled Loopback**: Local loopback (`localhost`, `127.0.0.1`, `[::1]`) is permitted for locally administered development servers.
- **Private Network Blocking**: RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), `0.0.0.0/8`, and IPv6 unique-local/link-local are strictly blocked.
- **Cloud Metadata Protection**: Cloud instance metadata services (`169.254.169.254`, `metadata.google.internal`) are unconditionally rejected.
- **Redirect Validation**: HTTP redirects are inspected manually (`redirect: "manual"`). Downgrades from HTTPS to HTTP are blocked, and cross-origin redirects strip sensitive `Authorization` headers.

### 3. Secret Management Boundary (`SecretProvider` & VS Code SecretStorage)
Credentials are never stored in plain-text project configuration (`.open-vs-code/mcp.json`), chat history, project memory, logs, or LLM prompts.
- Configuration schemas define auth references (`type: "bearer"`, `secretKey: "mcp.service.token"` or `tokenEnv: "SERVICE_TOKEN"`).
- `SecretProvider` interface is implemented by `VsCodeSecretProvider` on top of `vscode.SecretStorage`.
- Standard RFC 9728 and RFC 8414 metadata discovery and S256 PKCE generation are provided for standards-compliant OAuth 2.1 protected resources.

### 4. Advanced Tool Governance & Action Classification
MCP tools cannot grant themselves read/write authority or lower their security classification. We expand tool actions to:
- `mcp_external_read`: Read-only queries to trusted local or bounded services (`ALLOW` in BUILD, `ALLOW` in PLAN/ASK/REVIEW).
- `mcp_external_side_effect`: Operations that change remote state (`CONFIRM` in BUILD, `DENY` in PLAN/ASK/REVIEW).
- `mcp_sensitive_data_transmission`: Tools that send workspace contents or context externally (`CONFIRM` in BUILD with explicit security warning, `DENY` in PLAN/ASK/REVIEW).
- `mcp_external_destructive`: Remote deletion or resource destruction (`CONFIRM` in BUILD with high-risk warning, `DENY` in PLAN/ASK/REVIEW).
- `mcp_external_unknown`: Default conservative classification for unclassified remote tools (`CONFIRM` in BUILD, `DENY` in PLAN/ASK/REVIEW).

Server annotations (such as `readOnlyHint: true`) cannot override user or workspace policy or lower risk from `CONFIRM` to `ALLOW`.

### 5. Minimal User-Facing Integration Surface
Rather than a full visual marketplace (deferred to Sprint 8B), we expose 8 focused native VS Code commands operating over native QuickPicks:
- `open-vs-code.listMcpServers`: Inspect server identity, transport, connection state, and discovered tool counts.
- `open-vs-code.inspectMcpServer`: View metadata, authentication requirements, and execute lifecycle actions.
- `open-vs-code.inspectMcpTools`: Browse discovered tools, security classifications, and schemas.
- `open-vs-code.openMcpConfig`: Open or scaffold starter `.open-vs-code/mcp.json`.
- `open-vs-code.connectMcpServer` / `disconnectMcpServer`: Deterministic connection lifecycle control.
- `open-vs-code.refreshMcpDiscovery`: Refresh catalog tools and update metrics.
- `open-vs-code.viewMcpDiagnostics`: Surface actionable configuration and server health warnings.

All commands function independently of HALO or live LLM availability.

## Consequences

- **Security**: Complete protection against SSRF, DNS rebinding, token exfiltration, and unauthorized external side-effects.
- **Reliability**: Deterministic states (`DISABLED`, `DISCONNECTED`, `CONNECTING`, `AUTH_REQUIRED`, `CONNECTED`, `DEGRADED`, `FAILED`) and bounded reconnect (maximum 3 retries) prevent agent stalls when remote servers fail.
- **Portability**: Native implementation preserves the lightweight, zero-dependency nature of `agent-core`.
- **Evolvability**: Solid base for Sprint 8B (Visual MCP Manager) and future Capability Packs.
