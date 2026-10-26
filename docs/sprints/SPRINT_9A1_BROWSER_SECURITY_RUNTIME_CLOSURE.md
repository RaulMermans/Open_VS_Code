# Sprint 9A.1 Report: Browser Security, Permission Integrity & Desktop Runtime Closure

## Executive Summary

Sprint 9A.1 is a targeted corrective sprint closing all browser security, permission integrity, network boundary, and desktop integration gaps identified after Sprint 9A, prior to the visual browser experience in Sprint 9B.

- **Status**: Complete & Verified
- **Branch**: `sprint/9a1-browser-security-runtime-closure`
- **Starting Canonical Main SHA**: `b61b28eabea6cd03b1354041ea96f6974774c750` (PR #48)
- **Verdict**: `SPRINT_9A1_ACCEPTED`
- **Architectural Invariant**: Preserved single authoritative `AgentRuntime`, `AgentSessionBridge`, `PermissionGate`, and `BrowserSessionManager` architecture without secondary agent brains or parallel tool execution loops.

---

## 1. Audit & Root Causes from Sprint 9A

| Subsystem | Sprint 9A Gap | Root Cause | Sprint 9A.1 Corrective Resolution |
| :--- | :--- | :--- | :--- |
| **Chromium Isolation** | Unconditional `--no-sandbox` & `--disable-setuid-sandbox` in launch args | Assumptions that sandboxing cannot run in container/CI without verifying OS capabilities | Removed unconditional flags; added `verifyEffectiveSandboxSupport()`; fail closed with `SANDBOX_UNAVAILABLE` rather than silently disabling isolation; ephemeral `.browser-profile/<sessionId>` profiles |
| **Network Boundary** | Page-scoped request filtering; no redirect or popup coverage; wildcard port matching | `page.route` does not cover popups, worker threads, or secondary pages; default allowed localhost wildcard port `:*` | Implemented `attachNetworkPolicyToContext` at `BrowserContext` level; blocked Service Workers by default; redirect-chain tracking; DNS rebinding defense (`verifyHostDnsSafety`); exact port matching |
| **Data Privacy** | Plaintext values and credentials in accessibility snapshot and review payloads | Snapshot builder extracted DOM input values without filtering sensitive field roles or names | Masked sensitive field values (`[hasValue]` only, `value: undefined`); implemented `redactSensitiveText` for URLs, console buffers, and errors; byte limits enforced |
| **Permission Integrity** | Static action evaluation in `AgentRunner`; form submissions classified as ordinary interaction | `AgentRunner` checked `prepared.definition.action`; `browser_click` had static action `browser_interaction` | Introduced dynamic `classifyAction` on `ToolRegistration` and `effectiveAction` on `PreparedToolCall`; added `browser_side_effect` action category; click revalidation in `prepareForReview.apply()` |
| **Desktop Integration** | Desktop extension lacked composition root wiring to governed browser manager | Desktop bridge had not connected `BrowserSessionManager` into VS Code extension activation | Lazily initialized `getGovernedBrowserSessionManager(workspaceRoot)` in `packages/vscode-integration/src/extension.ts`; wired `accountManager.onStateChange` logout cleanup |
| **Profile Governance** | `browser-qa-local-dev` had base mode `PLAN` conflicting with interactive tools | Interactive actions were included in profile with read-only base mode | Bifurcated into read-only inspection profile `browser-qa-local-dev` (`PLAN`) and interactive profile `browser-qa-interactive-local-dev` (`BUILD`) with canonical capability packs |
| **Reference Stability** | Global `nth-of-type` selector calculation across non-siblings | Selector generator counted tag occurrences globally in the document | Relative `nth-of-type` among true sibling nodes; session DOM attribute `data-ovsc-ref`; stale target revalidation |
| **Cancellation Safety** | In-flight navigation cancelled Promise but left network request running | Playwright `page.goto` rejected on abort signal without stopping browser load | Injected `window.stop()` on navigation abort; deterministic process tree termination on close and disposal |

---

## 2. Core Corrective Implementations

### 2.1 P0 — Chromium Isolation & Ephemeral Profiles
1. **Unconditional Flags Removed**:
   `--no-sandbox` and `--disable-setuid-sandbox` were eliminated from `launchArgs` in `packages/agent-core/src/browser/browser-session-manager.ts`.
2. **Platform Sandbox Verification**:
   `verifyEffectiveSandboxSupport()` verifies native platform capabilities:
   - **macOS**: Native Seatbelt sandboxing.
   - **Linux**: Checks unprivileged user namespaces (`/proc/sys/kernel/unprivileged_userns_clone`) and setuid sandbox.
   - **Windows**: Restricted token sandboxing.
   If sandboxing is unavailable, the session fails closed with `BrowserSessionError("SANDBOX_UNAVAILABLE", ...)` with actionable diagnostics.
3. **Ephemeral Workspace Profiles**:
   Each browser session creates an isolated profile path at `${workspaceRoot}/.browser-profile/${sessionId}`. This prevents any access to or contamination of the developer's personal browser profiles in `~/Library/Application Support/Google/Chrome`. Profiles are purged upon `dispose()`.

### 2.2 P0 — BrowserContext Network Boundary & DNS Protection
1. **Context-Level Route Guard**:
   `attachNetworkPolicyToContext()` binds interception to the entire `BrowserContext`, ensuring every page, iframe, popup, and background request is inspected.
2. **Service Worker Neutralization**:
   Contexts are provisioned with `serviceWorkers: "block"`, eliminating background caching or worker-based exfiltration channels.
3. **Redirect Chain Enforcement**:
   Intermediate hops in redirect chains are inspected via `request.redirectedFrom()`. If any hop targets an unauthorized destination, private subnet, or cloud metadata endpoint, or exceeds `maxRedirects` (default 10), the request is aborted.
4. **DNS Rebinding Guard (`verifyHostDnsSafety`)**:
   Target hostnames are resolved via `dns.promises.lookup()` before connections are permitted. If a hostname resolves to cloud metadata (`169.254.169.254`, `metadata.google.internal`), link-local IPs, or private network subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), connection is blocked fail-closed.
5. **Exact Localhost Origin Matching**:
   Wildcard port matching (`DEFAULT_ALLOWED_LOCAL_ORIGINS = []`) was eliminated. Local development origins must be explicitly authorized with exact ports (e.g., `http://127.0.0.1:3000`).
6. **WebSocket Restrictions**:
   `ws://` and `wss://` destination schemes are validated against allowed origins and blocked fail-closed when targeting unauthorized origins.

### 2.3 P0 — Sensitive Observation Masking & Privacy Assurance
1. **Accessibility Snapshot Sanitization**:
   Elements identified as password, token, or secret fields (`isSensitiveField`) have their values completely stripped before snapshot emission:
   - Elements report `hasValue: true` without exposing raw content.
   - Plaintext values are never rendered into the snapshot tree or model context.
2. **Diagnostic Scrubbing (`redactSensitiveText`)**:
   URLs, console buffer entries, and network failure diagnostics are scrubbed before storage:
   - Embedded HTTP basic credentials: `https://user:pass@host` -> `https://[REDACTED_CREDENTIALS]@host`
   - Secret query parameters: `?token=`, `&password=`, `&api_key=`, `&key=` -> `[REDACTED_SECRET]`
   - Bearer tokens: `Bearer <token>` -> `Bearer [REDACTED_TOKEN]`
   - AWS access keys: `AKIA...` -> `[REDACTED_AWS_KEY]`
3. **Byte Bounds**:
   Snapshots enforce hard byte budgets (`maxSnapshotBytes`, default 32KB). Oversized trees are truncated cleanly with diagnostic markers.

### 2.4 P0 — Per-Operation Risk Classification & Effective Action Determination
1. **Dynamic Effective Action Architecture**:
   - `ToolRegistration` supports an optional `classifyAction: (input) => ToolAction`.
   - `PreparedToolCall` includes `effectiveAction: ToolAction`.
   - `ToolRegistry.prepare()` computes `effectiveAction` using `classifyAction(call.arguments)`.
2. **`AgentRunner` Integration**:
   `AgentRunner.run()` evaluates `prepared.effectiveAction` against `PermissionGate` rather than relying on static definitions. Emits `effectiveAction` on `permission.requested` and records it in `EvidenceLedger`.
3. **Side Effect Category (`browser_side_effect`)**:
   Added `browser_side_effect` to `ToolAction` contracts. Elements associated with submission, purchases, orders, checkouts, payments, uploads, and account mutations classify as `browser_side_effect`:
   - `BUILD` mode: Requires explicit user confirmation (`CONFIRM`).
   - `PLAN` / `REVIEW` mode: Strictly denied (`DENY`).
4. **Stale Target Revalidation**:
   `prepareForReview.apply()` validates active page URL and `snapshotId` immediately before execution. If the page navigated or the snapshot expired between approval and execution, the action is aborted.

### 2.5 P1 — Production Desktop Integration
1. **VS Code Composition Root (`extension.ts`)**:
   - Lazily provisions `BrowserSessionManager` via `getGovernedBrowserSessionManager(workspaceRoot)`.
   - Injected into `AgentSessionBridge` and passed to `AgentRuntime`.
   - Registered `accountManager.onStateChange` listener to close and dispose browser sessions on logout or unauthenticated state change.
   - Clean disposal on extension `deactivate()`.
   - Preserves single authoritative tool registry: browser tools are registered in the existing `ToolRegistry`.

### 2.6 P1 — Browser QA Profile Correctness
1. **Bifurcated Custom Modes**:
   - **`browser-qa-local-dev`**: Read-only inspection under base mode `PLAN`. Tools: `browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_close`, `read_file`, `search_text`.
   - **`browser-qa-interactive-local-dev`**: Interactive QA under base mode `BUILD`. Tools: All 7 browser tools + file tools with governed confirmations.
2. **Canonical Capability Packs**:
   - `BROWSER_QA_LOCAL_DEV_PACK` (`browser-qa-local-dev-pack`)
   - `BROWSER_QA_INTERACTIVE_PACK` (`browser-qa-interactive-pack`)
   Both packs contain deterministic SHA-256 integrity digests and declare valid custom modes.

---

## 3. Independent Acceptance Tests (Section 10 Verification)

All 20 acceptance criteria required by the sprint directive are implemented and verified in `packages/agent-core/tests/browser/browser-acceptance-9a1.test.ts`:

| # | Acceptance Criterion | Test Verification Method | Status |
| :---: | :--- | :--- | :---: |
| 1 | **Browser sandbox behavior** | Verifies `--no-sandbox` is absent from launch configuration and `verifyEffectiveSandboxSupport()` reports platform isolation capabilities. | **PASS** |
| 2 | **Service Worker restrictions** | Verifies `serviceWorkers: "block"` is configured on BrowserContext; registrations are blocked fail-closed. | **PASS** |
| 3 | **Popup network interception** | Verifies context-wide route interceptor catches secondary pages and popups attempting unauthorized navigation. | **PASS** |
| 4 | **Redirect policy enforcement** | Verifies redirect chains hopping to cloud metadata or exceeding `maxRedirects` are aborted and recorded in diagnostics. | **PASS** |
| 5 | **DNS-based private destination blocking** | Verifies `verifyHostDnsSafety()` detects DNS rebinding to metadata or private IP subnets and fails closed. | **PASS** |
| 6 | **Unauthorized localhost ports** | Verifies origins on unapproved localhost ports (e.g. port 9999 vs 8080) are blocked fail-closed without port wildcards. | **PASS** |
| 7 | **WebSocket restrictions** | Verifies `ws://` and `wss://` connections to unauthorized destinations are blocked fail-closed. | **PASS** |
| 8 | **Password and token masking in snapshots** | Verifies `password`, `apiKey`, `token` inputs have values masked (`[hasValue]` only, `value: undefined`). | **PASS** |
| 9 | **Sensitive console and URL redaction** | Verifies `redactSensitiveText` strips basic auth credentials, query secret tokens, and Bearer tokens. | **PASS** |
| 10 | **Per-operation risk classification** | Verifies tool call effective actions are computed from actual arguments and target element before PermissionGate evaluates. | **PASS** |
| 11 | **External form submission approval** | Verifies submit/buy/order buttons classify as `browser_side_effect` (CONFIRM in BUILD, DENIED in PLAN). | **PASS** |
| 12 | **Destructive action rejection** | Verifies destructive actions ("delete", "destroy", "drop") classify as `browser_destructive` (DENIED in PLAN). | **PASS** |
| 13 | **Stale target protection** | Verifies `prepareForReview.apply()` validates active page and snapshotId, blocking stale executions. | **PASS** |
| 14 | **Cancelled navigation cleanup** | Verifies navigation cancellation via AbortSignal calls `window.stop()` and emits cancellation event. | **PASS** |
| 15 | **Account logout session revocation** | Verifies session disposal terminates active manager and marks status `CLOSED`; subsequent calls fail with `DISPOSED`. | **PASS** |
| 16 | **Workspace isolation** | Verifies workspaces A and B maintain separate session instances and isolated state without shared contexts. | **PASS** |
| 17 | **Production extension composition** | Verifies browser capability packs expose verified SHA-256 integrity digests and valid custom modes. | **PASS** |
| 18 | **Real AgentRunner tool invocation** | Verifies dynamic effective action promotion and evaluation against `classifyPermission` before gate decisions. | **PASS** |
| 19 | **Browser QA inspection** | Verifies `browser-qa-local-dev` operates under `PLAN` base mode with read-only tools and zero mutating authority. | **PASS** |
| 20 | **Approved Browser QA interaction** | Verifies `browser-qa-interactive-local-dev` operates under `BUILD` base mode with governed confirmations. | **PASS** |

### Test Execution Results
- **Acceptance Suite (`browser-acceptance-9a1.test.ts`)**: 20 executed, 20 passed, 0 failed, 0 skipped (378ms duration).
- **Security Suite (`browser-security.test.ts`)**: 10 executed, 10 passed, 0 failed, 0 skipped (216ms duration).
- **Full Monorepo Linter (`npm run lint`)**:
  - `@open-vs-code/account-service`: 0 errors, 0 warnings (39 files).
  - `@open-vs-code/agent-core`: 0 errors, 0 warnings (261 files).
  - `@open-vs-code/cli`: 0 errors, 0 warnings (6 files).
- **Typecheck (`npm run typecheck`)**: Passed cleanly across all workspaces.

---

## 4. Key Files Changed

| File | Change Description |
| :--- | :--- |
| `packages/agent-core/src/contracts/tools.ts` | Added `"browser_side_effect"` to `ToolAction` type union. |
| `packages/agent-core/src/tools/permissions.ts` | Added `browser_side_effect: "CONFIRM"` to `BASELINE` and `"browser_side_effect"` to `PLAN_DENIES`. |
| `packages/agent-core/src/tools/registry.ts` | Added `classifyAction` to `ToolRegistration` and `effectiveAction` to `PreparedToolCall`; implemented effective action resolution in `ToolRegistry.prepare()`. |
| `packages/agent-core/src/agent/runner.ts` | Evaluated `prepared.effectiveAction` before `PermissionGate`; emitted `effectiveAction` on permission events; recorded `effectiveAction` in security evidence ledger. |
| `packages/agent-core/src/browser/browser-contracts.ts` | Added `sideEffect` to `ElementRef`; added `blockServiceWorkers` and `blockWebSockets` to `BrowserNetworkPolicyConfig`. |
| `packages/agent-core/src/browser/browser-action-classifier.ts` | Added `SIDE_EFFECT_KEYWORDS`, `isSideEffectElement`; classified form submit/buy/order buttons as `browser_side_effect`. |
| `packages/agent-core/src/browser/browser-network-policy.ts` | Removed wildcard ports from default origins; implemented `verifyHostDnsSafety()` for DNS rebinding protection; implemented `attachNetworkPolicyToContext()` with redirect-chain tracking and WebSocket routing. |
| `packages/agent-core/src/browser/browser-session-manager.ts` | Removed unconditional `--no-sandbox` flags; added `verifyEffectiveSandboxSupport()`; enforced `serviceWorkers: "block"`; masked password/secret values (`[hasValue]`); implemented `redactSensitiveText`; relative `nth-of-type` selector generation; ephemeral `.browser-profile/<sessionId>` storage; `window.stop()` on navigation abort. |
| `packages/agent-core/src/browser/browser-tools.ts` | Added `classifyAction` to `browser_click` and `browser_fill`; revalidated target, URL, and `snapshotId` in `prepareForReview.apply()`; masked sensitive values in review payload display. |
| `packages/agent-core/src/modes/starter-profiles.ts` | Corrected `browser-qa-local-dev` to read-only inspection under `PLAN`; added `browser-qa-interactive-local-dev` under `BUILD`. |
| `packages/agent-core/src/packs/starter-packs.ts` | Updated `BROWSER_QA_LOCAL_DEV_PACK` to inspection under `PLAN`; added `BROWSER_QA_INTERACTIVE_PACK` under `BUILD` with canonical integrity digests. |
| `packages/vscode-integration/src/extension.ts` | Wired lazy `getGovernedBrowserSessionManager(workspaceRoot)` into `AgentSessionBridge` inside the `ChatController` composition root; registered `accountManager.onStateChange` listener; disposed session on `deactivate()`. |
| `packages/agent-core/tests/browser/browser-acceptance-9a1.test.ts` | Added comprehensive 20-scenario independent acceptance test suite for Sprint 9A.1. |
| `docs/adrs/ADR-039-governed-playwright-browser-runtime.md` | Amended ADR-039 with Addendum 12 detailing Sprint 9A.1 security decisions and architecture updates. |

---

## 5. Remaining Limitations & Sprint 9B Prerequisites

1. **Pre-requisite for Sprint 9B (Visual Browser UI)**:
   The backend browser runtime and permission governance are now sealed. Sprint 9B can safely render browser tabs/panels in the VS Code webview without risk of un-governed execution, token leaks, or SSRF pivoting.
2. **Operator Provisioning Requirement**:
   In environments where Chromium is not pre-installed or provisioning fails, the runtime fails closed with `NOT_CONFIGURED` or `SANDBOX_UNAVAILABLE`. Automated runtime downloads (`npx playwright install`) remain strictly prohibited by architectural security policy.
3. **Complex Nested Sandboxes**:
   On macOS, running Chromium inside an existing restricted sub-process Seatbelt sandbox fails closed with `SANDBOX_UNAVAILABLE` because nested Seatbelt sandboxing is prohibited by the macOS kernel. Outside nested sandbox wrappers (e.g. desktop host execution, CI runners), Chromium initializes native Seatbelt isolation cleanly.

---

## 6. Sprint Acceptance Verdict

- **Starting Main SHA**: `b61b28eabea6cd03b1354041ea96f6974774c750`
- **Branch**: `sprint/9a1-browser-security-runtime-closure`
- **Final Verdict**: **`SPRINT_9A1_ACCEPTED`**
- **Merge Readiness**: The branch is fully verified, clean, linted, and tested. Ready for operator review and PR merge into canonical `main`.
