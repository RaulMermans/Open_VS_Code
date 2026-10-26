# ADR-039: Governed Playwright Browser Runtime & Agent Tool Integration

- **Status**: Accepted
- **Date**: 2026-10-26
- **Sprint**: 9A (Governed Playwright Browser Runtime & Agent Tool Integration)
- **Preceded by**: ADR-015 (Bounded MCP Integration), ADR-021 (Controlled Terminal Execution), ADR-023 (System Security Boundaries), ADR-034 (MCP Modern Transports & Governance), ADR-037 (Custom Modes Engine & Execution Profiles), ADR-038 (Capability Packs Architecture)

---

## 1. Context

In Sprint 8D and 8E, Open VS Code established Custom Modes (ADR-037) and Capability Packs (ADR-038), creating declarative, governed execution profiles running on a single authoritative Agent Runtime. However, real-world development workflows (such as web application debugging, accessibility audits, and UI end-to-end verification) require the agent to observe and interact with live browser environments.

Introducing browser automation naively creates severe security and architectural risks:
1. **Proliferation of Secondary Agent Brains**: Spawning a dedicated "browser agent" loop that bypasses the canonical `AgentRuntime`, `AgentSessionBridge`, and `PermissionGate`.
2. **Context Window Exhaustion**: Dumping massive raw HTML trees (often 100KB–2MB) and mandatory full-page screenshots into the context window on every action, ballooning token costs and degrading model reasoning.
3. **SSRF & Network Boundary Evasion**: Using browser navigation as an SSRF proxy to pivot into local microservices, link-local addresses, or cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`).
4. **Credential Leakage & Unsafe Persistence**: Reusing personal browser user data directories, persisting authenticated session cookies across unrelated workspaces or users, or exposing autofilled credentials.
5. **High-Risk Capability Exposure**: Allowing arbitrary JavaScript evaluation (`page.evaluate`), raw Chrome DevTools Protocol (`CDP`) commands, arbitrary file uploads, or cookie export.
6. **Uncontrolled Dependency Execution**: Automatically executing `npx playwright install`, `npm install`, or download scripts at runtime from inside the agent.

---

## 2. Upstream Evaluation & Technology Selection

Two major upstream projects from Microsoft were evaluated alongside a native governed library adapter:
- **`microsoft/playwright-mcp`**: Official Model Context Protocol wrapper for Playwright.
- **`microsoft/playwright-cli`**: Command-line interface wrapper for Playwright automation.
- **Governed `BrowserSessionManager` wrapping `playwright-core`**: A native in-process adapter implementing compact MCP-compatible tool definitions.

### Trade-off Comparison

| Evaluation Metric | `playwright-mcp` | `playwright-cli` | Governed `BrowserSessionManager` (`playwright-core`) |
| :--- | :--- | :--- | :--- |
| **Existing Architecture Alignment** | High (MCP protocol) | Low (CLI subprocess parser) | Highest (Direct integration with `ToolRegistry` and `PermissionGate`) |
| **Process Tree Governance & Cleanup** | Medium (external server subprocess) | Low (detached CLI processes) | High (deterministic PID tracking and POSIX process tree termination) |
| **SSRF & Network Interception** | Low (standard browser navigation) | Low (no fine-grained route guard) | High (`page.route` intercepts every request, blocking metadata & private IPs) |
| **High-Risk Capability Exclusion** | Poor (exposes arbitrary `eval` and CDP) | Poor (exposes arbitrary script runs) | High (eval, CDP, cookie export strictly excluded from tool catalog) |
| **Context & Token Efficiency** | Medium | Low (stdout/stderr logging) | High (bounded accessibility tree, element ref IDs, optional screenshots) |
| **Browser Provisioning Safety** | Poor (auto-downloads binaries) | Poor (auto-downloads binaries) | High (fails closed with `NOT_CONFIGURED`; zero automated `npx/npm` installs) |

### Decision
Open VS Code adopts a **Governed Browser Tool Adapter** backed by `BrowserSessionManager` using pinned `playwright-core`. The adapter exposes compact, MCP-compatible tool definitions directly into the existing `ToolRegistry` without creating a secondary agent brain or running competing execution paths.

---

## 3. Core Architecture

The browser capability executes strictly through the existing authoritative pipeline:

```text
User Request
       │
       ▼
Custom Mode (`browser-qa-local-dev`) / Capability Pack
       │
       ▼
AgentSessionBridge
       │
       ▼
AgentRuntime
       │
       ▼
PermissionGate (Action Classification: ALLOW / CONFIRM / DENY)
       │
       ▼
Governed Browser Tool Adapter (`browser-tools.ts`)
       │
       ▼
BrowserSessionManager (`browser-session-manager.ts`)
       │
       ▼
Playwright Chromium Session (Isolated Context, Route Interception)
       │
       ▼
Structured Browser Result (Compact Accessibility Snapshot / Element Refs)
```

No second planning loop or browser-specific autonomous agent is introduced.

---

## 4. Browser Session Lifecycle & Isolation Invariants

1. **Ephemeral Isolated Contexts**: Every browsing session operates inside a distinct, ephemeral `BrowserContext`. No cookies, local storage, or authenticated state are shared across workspaces, sessions, or tasks.
2. **No Attachment to Personal Profiles**: The agent never attaches to or reads from the operator's personal browser profiles.
3. **Deterministic Process Cleanup**: When a session closes, encounters an unhandled error, or is cancelled via `AbortSignal`, `BrowserSessionManager` disposes of pages, closes contexts, terminates the browser process, and recursively terminates child processes (`killProcessTree`).
4. **Stale Element Reference Invalidation**: Each accessibility snapshot assigns unique element references (`refId`). If navigation or DOM mutation occurs, older element references are invalidated; subsequent interactions fail closed with `STALE_ELEMENT_REFERENCE`, prompting the agent to capture a fresh snapshot.

---

## 5. Browser Provisioning & Operator Diagnostics

1. **Provable Detection Order**:
   - Explicit path via `OPEN_VS_CODE_BROWSER_EXECUTABLE` or options override.
   - Pinned Playwright cache scan (`~/Library/Caches/ms-playwright/chromium-*`).
   - Playwright default executable path (`chromium.executablePath()`).
   - System standard installation paths.
2. **Fail Closed**: If no supported browser executable is discovered, `detectBrowserProvisioning()` returns `NOT_CONFIGURED` with actionable diagnostics.
3. **Zero Agent Self-Installation**: The agent is strictly prohibited from running `npx playwright install`, `npm install`, or download scripts. Binary provisioning is an operator-controlled task.

---

## 6. Governed Browser Tool Interface

The initial tool surface is deliberately compact (7 tools):
- `browser_open`: Opens a browser session at an authorized URL.
- `browser_navigate`: Navigates the active page to an authorized URL.
- `browser_snapshot`: Captures a byte-bounded accessibility snapshot with interactive element refs.
- `browser_click`: Clicks a permitted interactive element by `refId`.
- `browser_fill`: Fills a permitted input field by `refId` with redacted preview for sensitive fields.
- `browser_screenshot`: Captures an optional PNG screenshot observation.
- `browser_close`: Closes the active page and browser session.

### High-Risk Capabilities Strictly Excluded
The following capabilities are excluded from the tool catalog:
- Arbitrary JavaScript evaluation (`page.evaluate`)
- Direct Chrome DevTools Protocol (`CDP`) commands
- Cookie export and session storage extraction
- Arbitrary file uploads and uncontrolled downloads
- Extension loading and proxy reconfiguration

---

## 7. Permission Model & Risk Classification

All browser tool invocations map to deterministic `ToolAction` categories evaluated by `PermissionGate`:
- **`browser_inspection`** (`browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_close`): Read-only inspection within allowed origins. Allowed by default in `PLAN`, `REVIEW`, and `BUILD` modes.
- **`browser_interaction`** (`browser_navigate`, `browser_click`, `browser_fill`): Interactive mutations. Requires explicit user confirmation in `BUILD` mode; denied in read-only modes (`PLAN`, `REVIEW`) unless explicitly overridden.
- **`browser_sensitive`**: Target fields containing passwords, tokens, API keys, credit cards, or SSNs. Requires high-risk confirmation with value redaction in review payloads (`[REDACTED_SECRET]`).
- **`browser_destructive`**: Target elements matching destructive keywords (`delete`, `destroy`, `remove`, `drop`, `revoke`, `terminate`). Requires high-risk user confirmation or denial.

---

## 8. Network & Isolation Guard

The browser runtime enforces strict network boundaries via `isBrowserUrlPermitted()` and `page.route` interception:
1. **Prohibited Schemes**: `file://`, `data:`, `javascript:`, and non-HTTP protocols are rejected.
2. **SSRF Blocking**: Link-local addresses (`169.254.0.0/16`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and cloud metadata hostnames (`metadata.google.internal`) are blocked.
3. **Authorized Origins**: Navigation and subresource requests are restricted to explicitly allowlisted origins (e.g. authorized local development ports `http://127.0.0.1:<port>`). Subresource requests to unauthorized third parties are aborted.

---

## 9. Mandatory Preflight: Account Pack Reconciliation

`CapabilityPackService.syncAccountPacks()` reconciles the authoritative server pack list against ephemeral account pack profiles registered in `ModeService`.
1. Prunes orphaned mode profiles for revoked account packs.
2. Invalidates active custom mode selection if the active mode was revoked.
3. Preserves local workspace-owned custom modes.
4. Prevents revoked profiles from executing.

---

## 10. Starter Demonstration Profile & Pack

- **Starter Profile**: `Browser QA — Local Development` (`browser-qa-local-dev`)
  - Base mode: `PLAN` (inspection-oriented ceiling).
  - Allowed tools: All 7 governed browser tools.
- **Starter Pack**: `Browser QA — Local Development Pack` (`browser-qa-local-dev-pack`)
  - Canonical SHA-256 integrity verification.
  - Declares the `browser-qa-local-dev` custom mode profile.

---

## 11. Consequences

### Positive
- Browser automation integrated directly into canonical `AgentRuntime` and `PermissionGate`.
- Complete immunity against automated `npx/npm` malware and runtime binary downloads.
- High token efficiency: compact accessibility snapshots and `refId`s prevent context bloating.
- Strong network isolation: SSRF and cloud metadata access prevented via page route interception.
- Cross-device pack reconciliation prevents revoked account profiles from running.

### Trade-offs / Limitations
- Headless testing on loopback requires operator-provisioned browser binaries.
- Complex SPA sites requiring custom scripts cannot use arbitrary `page.evaluate()`; automation must rely on standard interactive element queries.

---

## 12. Addendum — Sprint 9A.1 Security Hardening & Runtime Closure

Following security and architecture audit of Sprint 9A, Sprint 9A.1 closed critical security, network, permission, and integration gaps prior to Sprint 9B:

### 12.1 P0 — Chromium Isolation & Ephemeral Profiles
- **Sandbox Preservation**: Removed unconditional `--no-sandbox` and `--disable-setuid-sandbox` flags from all browser launches.
- **Platform Verification**: Added `verifyEffectiveSandboxSupport()` to detect native platform sandboxing (macOS Seatbelt, Linux unprivileged user namespaces / setuid sandbox, Windows restricted tokens). If isolation cannot be established, the system fails closed with `SANDBOX_UNAVAILABLE` rather than silently disabling sandboxing.
- **Ephemeral Isolation**: Chromium profiles are allocated in isolated workspace paths (`.browser-profile/<sessionId>`) and destroyed upon `dispose()`, completely decoupling automation from user personal profiles.

### 12.2 P0 — BrowserContext Network Boundary & DNS Rebinding Protection
- **Context-Wide Controls**: Replaced page-scoped routes with context-wide request interception covering main pages, popups, and iframes (`attachNetworkPolicyToContext`).
- **Service Worker Neutralization**: Service Workers are blocked by default (`serviceWorkers: "block"`).
- **Redirect Chain Enforcement**: Redirect chains track hop counts against `maxRedirects` and re-evaluate each intermediate URL against the network policy.
- **DNS Rebinding Guard**: Introduced `verifyHostDnsSafety()` to resolve target hostnames before connection, rejecting hostnames that resolve to link-local (`169.254.0.0/16`), cloud metadata (`169.254.169.254`, `metadata.google.internal`), or private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
- **Strict Localhost Origins**: Removed default port wildcards (`:*`) from `DEFAULT_ALLOWED_LOCAL_ORIGINS`. Local development origins must be explicitly authorized with exact ports.
- **WebSocket Restrictions**: Intercepts `ws://` and `wss://` connections, blocking unauthorized WebSocket channels fail-closed.

### 12.3 P0 — Sensitive Observation Masking & Privacy Assurance
- **Form Value Masking**: Password, token, and API key fields are never emitted with plain text values in accessibility snapshots or model context. They report only `[hasValue]` metadata with `value: undefined`.
- **Diagnostic Redaction**: Implemented `redactSensitiveText()` to scrub embedded HTTP Basic credentials (`user:pass@host`), query parameters (`?token=`, `&password=`), Bearer tokens, and AWS access keys from URLs, console buffers, and network error logs.

### 12.4 P0 — Per-Operation Risk Classification & Effective Action Determination
- **Dynamic Effective Action**: Added `classifyAction` to `ToolRegistration` and `effectiveAction: ToolAction` to `PreparedToolCall`. `AgentRunner` evaluates `effectiveAction` against `PermissionGate` before decision-making rather than relying on static definitions.
- **Side Effect Classification**: Added `browser_side_effect` action category. Form submit buttons, purchases, checkouts, uploads, and account mutations classify as `browser_side_effect` (requiring `CONFIRM` in `BUILD` mode, and strictly `DENIED` in `PLAN` mode).
- **Stale Target Revalidation**: `prepareForReview.apply()` validates active page URL and `snapshotId` prior to execution, aborting if the target or page mutated after approval.

### 12.5 P1 — Production Desktop Extension Composition Root
- **Lazy Provisioning**: Governed `BrowserSessionManager` is lazily initialized via `getGovernedBrowserSessionManager(workspaceRoot)` in `packages/vscode-integration/src/extension.ts` and passed through `AgentSessionBridge` to `AgentRuntime`.
- **Account & Extension Lifecycle**: `accountManager.onStateChange` terminates and disposes the browser session on logout or unauthenticated state change. Clean disposal is guaranteed in extension `deactivate()`.

### 12.6 P1 — Browser QA Profile Bifurcation
- **Inspection Profile (`browser-qa-local-dev`)**: Read-only inspection under base mode `PLAN` containing only non-mutating tools (`browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_close`, `read_file`, `search_text`).
- **Interactive QA Profile (`browser-qa-interactive-local-dev`)**: Interactive testing under base mode `BUILD` containing full browser tool surface with explicit confirmation gates.
- **Canonical Capability Packs**: `browser-qa-local-dev-pack` and `browser-qa-interactive-pack` provide deterministic SHA-256 integrity verification.
