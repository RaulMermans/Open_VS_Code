# SPRINT 9A REPORT
## Governed Playwright Browser Runtime & Agent Tool Integration

- **Sprint**: 9A (Governed Playwright Browser Runtime & Agent Tool Integration)
- **Status**: Complete & Verified
- **Verdict**: `SPRINT_9A_ACCEPTED`
- **Branch**: `sprint/9a-playwright-browser-runtime`
- **Starting Canonical Main**: `a3d5f54d7199db7feb86333e06e8dba81e162209` (PR #47)
- **ADR Reference**: `docs/adrs/ADR-039-governed-playwright-browser-runtime.md`

---

## 1. Executive Summary

Sprint 9A introduces a secure, locally executable browser automation capability integrated directly into Open VS Code's existing Agent Runtime through governed tools.

Per the sprint mandate:
1. **Zero Secondary Agent Brains**: Browser execution does not introduce a secondary planning loop or autonomous browser sub-agent. All browsing requests flow from user input through existing Custom Modes / Capability Packs → `AgentSessionBridge` → `AgentRuntime` → `PermissionGate` → `Governed Browser Tool Adapter` → `BrowserSessionManager` → `Playwright Chromium` → `Structured Browser Result`.
2. **Upstream Selection & Technology Choice**: Evaluated `microsoft/playwright-mcp` and `microsoft/playwright-cli`. Selected a governed direct Playwright session manager wrapping pinned `playwright-core`. This avoids external subprocess proxy overhead, enables deterministic POSIX process tree cleanup (`killProcessTree`), allows granular request interception (`page.route`) to block SSRF and metadata endpoints, and excludes high-risk capabilities (`page.evaluate`, direct CDP, cookie extraction) at the tool registry layer.
3. **Mandatory Preflight — Account Pack Reconciliation**: Inspected `CapabilityPackService.syncAccountPacks()` and `ModeService`. Reconciled authoritative server packs against ephemeral account pack mode profiles, pruning orphaned profiles, invalidating active mode selections when revoked, preserving workspace-owned modes, and preventing revoked profiles from executing.
4. **Governed Browser Tool Surface**: Exposed 7 compact, MCP-compatible tools:
   - `browser_open`: Launch browser session at an authorized origin.
   - `browser_navigate`: Navigate active page to an authorized origin.
   - `browser_snapshot`: Capture a byte-bounded accessibility tree with element references (`refId`).
   - `browser_click`: Click a permitted element reference.
   - `browser_fill`: Fill a permitted input field with masked sensitive value preview.
   - `browser_screenshot`: Capture optional PNG observation artifacts.
   - `browser_close`: Cleanly terminate page and browser context.
5. **Security & Permission Model**: Deterministically classified actions into `browser_inspection` (ALLOW in all modes), `browser_interaction` (CONFIRM in BUILD, gated in PLAN/REVIEW), `browser_sensitive` (CONFIRM with credential masking), and `browser_destructive` (CONFIRM/DENY for destructive operations).
6. **Network Guard & Isolation**: Enforced origin allowlists, blocked `file://` URLs, link-local addresses, private network subnets, and cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`) across all primary and secondary resource requests via `page.route`.
7. **Browser Provisioning Diagnostics**: Detected browser executables deterministically (`OPEN_VS_CODE_BROWSER_EXECUTABLE`, Playwright cache scan, system paths) with explicit `NOT_CONFIGURED` fail-closed diagnostics. Prohibited runtime `npx/npm` auto-downloads from within the agent.
8. **Demonstration Profile & Pack**: Shipped starter mode profile `Browser QA — Local Development` (`browser-qa-local-dev`) with base mode `PLAN` and starter capability pack `Browser QA — Local Development Pack` (`browser-qa-local-dev-pack`) with canonical SHA-256 integrity digest.
9. **Verification**: 31 high-value test scenarios covering browser lifecycle, accessibility snapshots, stale element references, console/network error observation, cancellation, process tree termination, network guard SSRF blocks, permission gates, sensitive/destructive classification, and end-to-end integration with real local Chromium execution.

---

## 2. Preflight Defect & Corrective Actions

| Component | Defect Prior to Sprint 9A | Corrective Action in Sprint 9A |
|---|---|---|
| **Account Pack Mode Synchronization** | When an account pack was removed from the backend on another device, `syncAccountPacks()` deleted the local cached manifest, but did not prune the ephemeral mode profile from `ModeService`. | Added `ModeService.reconcileAccountPackProfiles(validModeIds)`. Authoritative synchronization now purges revoked ephemeral account pack modes, resets active mode selections if affected, preserves workspace-owned modes, and blocks revoked mode execution. |
| **Cross-Device Deletion Test** | Lack of regression test verifying cross-device revocation cleanup. | Added Scenario 12 in `capability-packs-e2e.test.ts` verifying that server deletion purges ephemeral mode profiles on next sync while leaving workspace modes intact. |

---

## 3. Architecture & Key Implementation Components

### A. Browser Session Lifecycle (`BrowserSessionManager`)
- **Isolated Contexts**: Every session runs inside an ephemeral `BrowserContext` with isolated storage, cookies, and cache.
- **Process Tree Cleanup**: Tracks browser PID and executes recursive SIGTERM/SIGKILL tree termination (`killProcessTree`) upon closure, disposal, or cancellation.
- **Cancellation**: Supports `AbortSignal` for non-blocking cancellation during launch, navigation, clicks, fills, or screenshots.
- **Stale Reference Invalidation**: Tracks active `snapshotId`. If the page navigates or reloads, prior element `refId`s are invalidated, failing closed with `[STALE_ELEMENT_REFERENCE]` to enforce fresh snapshot observations.
- **Diagnostics Ring Buffers**: Bounded circular buffers for console messages (log, warn, error) and network failures without storing private response payloads.

### B. Provisioning & Operator Diagnostics (`browser-provisioning.ts`)
- Scans `process.env.OPEN_VS_CODE_BROWSER_EXECUTABLE`, Playwright cache directory (`~/Library/Caches/ms-playwright/chromium-*`), Playwright default binary, and system installation paths.
- Returns `NOT_CONFIGURED` with operator instructions if no browser binary is present.
- Never invokes `npx` or `npm install` from the agent runtime.

### C. Network Policy & SSRF Guard (`browser-network-policy.ts`)
- `isBrowserUrlPermitted()` parses target URLs and blocks non-HTTP schemes (`file://`, `data:`), link-local IP ranges (`169.254.0.0/16`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and metadata services (`metadata.google.internal`).
- In `BrowserSessionManager`, `page.route("**/*")` intercepts every request:
  - Allowed origin matches proceed.
  - SSRF or unallowed origin requests are aborted with `route.abort("blockedbyclient")` and logged into network failure diagnostics.

### D. Action Classifier & Permission Model (`browser-action-classifier.ts`)
- Analyzes tool name, arguments, and target element metadata.
- **Low-Risk Inspection**: `browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_close` map to `browser_inspection` (ALLOW).
- **Interaction**: `browser_navigate`, `browser_click`, `browser_fill` map to `browser_interaction` (CONFIRM in BUILD; DENY in PLAN/REVIEW).
- **Sensitive Fields**: Targets matching password, token, secret, api_key, credit card, or ssn keywords classify as `browser_sensitive` and mask values (`[REDACTED_SECRET]`) in review payloads.
- **Destructive Elements**: Targets matching delete, destroy, remove, drop, purge, or terminate keywords classify as `browser_destructive` and require high-risk confirmation or denial.
- **Excluded Tools**: Arbitrary `eval`, CDP, and cookie export requests fail closed as `unknown` (DENY).

---

## 4. Verification & Test Matrix

Sprint 9A implements 31 comprehensive test scenarios across 4 test suites:

### Suite 1: Browser Runtime & Lifecycle (`packages/agent-core/tests/browser/browser-runtime.test.ts`)
- **Scenario 1**: Launch browser session
- **Scenario 2**: Open authorized local page
- **Scenario 3**: Navigate between authorized local pages
- **Scenario 4**: Read structured accessibility snapshot
- **Scenario 5**: Identify form elements with `refId`
- **Scenario 6**: Fill a permitted field
- **Scenario 7**: Click a permitted button
- **Scenario 8**: Capture screenshot observation artifact
- **Scenario 9**: Read console diagnostics (log, warn, error)
- **Scenario 10**: Observe network request failures
- **Scenario 11**: Cancel navigation via `AbortSignal`
- **Scenario 12**: Cancel mid-action via `AbortSignal`
- **Scenario 13**: Close browser session cleanly
- **Scenario 14**: Terminate browser process tree on shutdown
- **Scenario 22**: Bound oversized accessibility snapshots to byte cap
- **Scenario 23**: Reject stale element references upon navigation

### Suite 2: Browser Security & Policy Enforcement (`packages/agent-core/tests/browser/browser-security.test.ts`)
- **Scenario 15**: Network guard blocks SSRF and unauthorized origins
- **Scenario 16**: Reject `file://` URLs
- **Scenario 17**: Reject cloud metadata endpoints
- **Scenario 18**: Distinguish inspection from interaction
- **Scenario 19**: Require confirmation for form interactions in mutating modes
- **Scenario 20**: Sensitive field protection & review masking
- **Scenario 21**: Destructive action classification
- **Scenario 28**: Exclude high-risk capabilities (eval, CDP, cookies)
- **Scenario 29**: Missing browser binary handling (`NOT_CONFIGURED`)
- **Scenario 30**: Process death and crash recovery

### Suite 3: End-to-End Integration & Pack Governance (`packages/agent-core/tests/browser/browser-e2e.test.ts`)
- **Scenario 24**: Custom Mode selection: Browser QA profile enables governed tools and base mode constraints
- **Scenario 25**: Workspace boundary isolation: Multiple workspaces run isolated browser contexts
- **Scenario 26**: Account isolation: Revoked account profiles are excluded from active resolution
- **Scenario 27**: Pack installation safety: Registering browser pack does not auto-start browser sessions
- **Scenario 31**: End-to-end integration: User request → custom mode / pack → AgentRuntime → Browser tools → PermissionGate → real Playwright execution → verified DOM result

### Suite 4: Preflight Account Pack Reconciliation (`packages/vscode-integration/tests/capability-packs-e2e.test.ts`)
- **Scenario 12**: Cross-device deletion and resynchronization purges orphaned mode profiles and prevents revoked execution while preserving workspace modes

---

## 5. Artifacts and Commits

- **ADR-039**: `docs/adrs/ADR-039-governed-playwright-browser-runtime.md`
- **Contracts**: `packages/agent-core/src/browser/browser-contracts.ts`
- **Provisioning**: `packages/agent-core/src/browser/browser-provisioning.ts`
- **Network Policy**: `packages/agent-core/src/browser/browser-network-policy.ts`
- **Action Classifier**: `packages/agent-core/src/browser/browser-action-classifier.ts`
- **Session Manager**: `packages/agent-core/src/browser/browser-session-manager.ts`
- **Browser Tools**: `packages/agent-core/src/browser/browser-tools.ts`
- **Starter Profile & Pack**: `packages/agent-core/src/modes/starter-profiles.ts`, `packages/agent-core/src/packs/starter-packs.ts`
- **Preflight Reconciliation**: `packages/vscode-integration/src/modes/mode-service.ts`, `packages/vscode-integration/src/packs/capability-pack-service.ts`

---

## 6. Sprint Verdict

Sprint 9A meets all governance, security, architecture, and verification criteria.

**Verdict: `SPRINT_9A_ACCEPTED`**
