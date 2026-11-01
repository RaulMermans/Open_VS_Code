# ADR-040: Integrated Visual Browser Panel & Agent Observation UX

- **Status**: Accepted
- **Date**: 2026-11-01
- **Sprint**: 9B (Integrated Visual Browser, Agent Activity & Observation UX)
- **Preceded by**: ADR-018 (Chat UX Layer), ADR-023 (System Security Boundaries), ADR-036 (Visual Integration Manager & MCP Lifecycle UX), ADR-037 (Custom Modes Engine & Execution Profiles), ADR-038 (Capability Packs Architecture), ADR-039 (Governed Playwright Browser Runtime & Agent Tool Integration)

---

## 1. Context

Sprint 9A, 9A.1, and 9A.2 established a secure, governed Playwright browser automation foundation (`BrowserSessionManager`) executing within the canonical `AgentRuntime` and `PermissionGate`. However, running browser automation headlessly without human visibility creates significant operational and usability challenges:
1. **Black-Box Agent Operation**: Developers cannot see what the agent is browsing, whether pages rendered properly, or why a selector failed or was classified as sensitive.
2. **Interactive vs Observational Coupling**: Naive implementations frequently bind webview UI controls directly to browser automation instances, causing accidental browser launches when a panel opens, competing automation loops, or uncoordinated page navigations.
3. **Context Window Ballooning**: Streaming continuous video or capturing raw DOM trees into chat history degrades model context efficiency and risks credential leakage.
4. **Security Vulnerabilities in Webviews**: Embedding remote webpage HTML or running client scripts directly inside VS Code Webview panels exposes the editor to XSS, remote code execution, prototype pollution, and sandbox escapes.
5. **Lack of Preparation for Downstream Workflows**: Advanced Design & Motion QA (Sprint 9C) and Reverse Engineering Analysis (Sprint 9D) require standardized visual baselines, responsive viewport comparisons, and fact-based behavioral journals without creating premature monolithic capability implementations.

---

## 2. Architecture Decision: Strict Execution vs Observation Separation

To preserve existing architectural invariants and security guarantees, Open VS Code enforces an absolute separation between **Execution** and **Observation**:

```text
EXECUTION PATH (Governed, Authoritative, Permission-Gated)
User or Agent Request
       │
       ▼
AgentSessionBridge (Scoped by workspaceRoot + accountId + configKey)
       │
       ▼
AgentRuntime & AgentRunner (Origin & Task Correlation)
       │
       ▼
PermissionGate (Action Classification: ALLOW / CONFIRM / DENY)
       │
       ▼
Governed Browser Tools (`browser_open`, `browser_navigate`, `browser_click`, etc.)
       │
       ▼
BrowserSessionManager (Single authoritative session per context)
       │
       ▼
Playwright Chromium (Sandboxed OS process with connection-level egress proxy)

--------------------------------------------------------------------------------

OBSERVATION PATH (Passive, Redacted, Read-Only Presentation)
BrowserSessionManager
       │ (BrowserEvent & Snapshot stream)
       ▼
BrowserPanelController (Passive listener, rate limiter, artifact ring buffer)
       │
       ▼
Sanitized Browser View State (Redacted URLs, masked credentials, relative URIs)
       │
       ▼
VS Code WebviewPanel (`Open VS Code Browser` beside editor)
```

### Core Invariants

1. **Passive Panel Lifecycle**: Opening or revealing the browser panel (`open-vs-code.openBrowserPanel`) **never** launches Chromium, never creates a browser profile, and never performs network navigation. If no session is active, the panel displays a clean `DISCONNECTED` state and provisioning diagnostics.
2. **Single Authoritative Session**: There is exactly one authoritative browser session per permitted `(workspaceRoot, accountId, configKey)`. The panel passively observes this session. Multiple views or panels do not create competing browser instances.
3. **No Secondary Agent Brain**: The browser panel introduces zero autonomous planning loops. Manual user operations (such as opening a URL or clicking an element) are routed through the same governed tools, classifier, and `PermissionGate` contracts as agent actions.
4. **Context & Identity Isolation**: Sessions are strictly scoped to the active workspace and account identity. Any workspace switch, account logout, or trust revocation immediately invalidates the observed state and disposes unauthorized resources.

---

## 3. Visual Browser Preview Strategy

To provide visual clarity without the overhead and risks of live video streaming or embedded remote iframes:
1. **Screenshot-Based Preview**: The preview is driven exclusively by screenshot image files captured from the authoritative Playwright session and saved to private temporary storage outside the workspace repository (`os.tmpdir()/open-vs-code-browser-artifacts/`).
2. **Outside-Workspace Ring Buffer**: A bounded disk ring buffer (default 10 screenshots, maximum 20MB) retains recent previews. When new screenshots are captured, older files are automatically evicted and unlinked from disk.
3. **Bounded Refresh Rate**: Automatic preview refresh occurs primarily on meaningful browser events (completed navigations, element interactions). When continuous auto-refresh is enabled, it is strictly rate-limited to 1–2 frames per second (500ms minimum interval) with coalesced capture requests.
4. **Hidden-Panel Suspension**: When the webview panel is hidden or minimized (`panel.visible === false`), all screenshot refreshes and capture schedules are paused immediately, reducing background CPU and GPU consumption to zero.
5. **No Persistent Base64 in Chat**: Large base64 image strings are never placed into persistent chat conversation state. Screenshots are accessed via local file URIs served through VS Code's secure Webview resource bridge (`asWebviewUri`).
6. **Viewport Presets & Zoom Modes**: Supports standard presets (`desktop` 1280×800, `tablet` 768×1024, `mobile` 375×812, `custom`), zoom-to-fit, and actual-size (1:1) pixel inspection.

---

## 4. Bounded Event Timeline & Origin Attribution

The browser panel consumes events directly from `BrowserSessionManager.onEvent()` and maintains an ordered, bounded timeline (maximum 100 entries):
- **Lifecycle Events**: `session_started`, `sandbox_verified`, `session_closed`, `session_invalidated`, `browser_crashed`.
- **Navigation Events**: `navigation_attempted`, `navigation_completed`, `navigation_failed`, `viewport_changed`.
- **Observation Events**: `snapshot_taken`, `screenshot_taken`, `console_message`.
- **Governance Events**: `tool_invoked`, `approval_requested`, `approval_resolved`, `action_approved`, `action_denied`, `network_policy_denied`, `timeout`, `cancellation`.

### Attribution & Privacy
- Every event records its origin: `AGENT`, `USER`, or `SYSTEM`.
- Agent events link `taskId` and `confirmationId` for end-to-end traceability across the chat interface and permission reviews.
- **Zero Secret Leakage**: Passwords, authorization tokens, session cookies, and sensitive query parameters are redacted via `redactSensitiveText` and `sanitizeBrowserUrl` before reaching the timeline.

---

## 5. Accessibility & Element Inspector

The panel extends accessibility tree observations without creating alternative tool execution pathways:
1. **Structured Element Tree**: Presents interactive and semantic elements (`refId`, `tag`, `role`, `name`, `type`, `sensitive`).
2. **Interactive States & Warnings**: Reflects `disabled`, `readonly`, `required`, and sensitive field masking notices.
3. **Coordinate-Free Visual Highlighting**: When an element is selected in the inspector, its bounding box (`x, y, width, height`) calculated from the active viewport is rendered as a visual overlay on the screenshot preview. The overlay uses `pointer-events: none` to guarantee that image coordinates cannot be used as an unrestricted or unvalidated execution mechanism.
4. **Stale Snapshot Guard**: If the page navigates, reloads, or changes viewport dimensions, existing element references are marked stale (`snapshotStale: true`). Interactive action controls are disabled in the UI until observation is refreshed.

---

## 6. Governed Manual Browser Controls

Developers can perform manual actions directly from the browser panel:
- Open URL, Navigate Back, Navigate Forward, Reload.
- Refresh Observation & Capture Screenshot.
- Change Viewport Preset.
- Click Selected Element & Fill Form Field.
- Close Session (with modal confirmation).

### Security Rules for Manual Actions
- Manual operations use the exact same `PermissionGate` and `classifyAction()` logic as agent operations.
- Opening URLs enforces `isBrowserUrlPermitted()` and DNS rebinding protections. Manual controls cannot access `file://` URIs, link-local addresses, RFC1918 subnets, or cloud metadata endpoints.
- In read-only modes (`ASK`, `PLAN`, `REVIEW`), manual interactive or mutating operations are denied.
- In `BUILD` mode, side-effecting or sensitive form actions require user confirmation through the existing confirmation UX.
- Arbitrary JavaScript evaluation (`page.evaluate`), raw Chrome DevTools Protocol (`CDP`) commands, and cookie exports are strictly blocked.

---

## 7. Sprint 9C & Sprint 9D Observation Preparation

The browser panel implements lightweight, bounded observation contracts to prepare for upcoming capability packs without building premature monolithic features:
- **Sprint 9C (Advanced Design & Motion)**:
  - Supports capturing and pinning a design baseline screenshot.
  - Supports before/after side-by-side visual comparison against the pinned baseline.
  - Exposes read-only computed typography (`fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `color`) and box-model spacing (`margin`, `padding`, `border`, `display`, `position`) for inspected elements.
  - Provides a bounded animation probe recording duration, easing, and frame counts while explicitly enforcing `motionQualityClaimAllowed: false` (static screenshots cannot verify perceived 60fps smoothness).
- **Sprint 9D (Reverse Engineering Analysis)**:
  - Implements an opt-in `BoundedObservationJournal` (maximum 50 entries).
  - Enforces strict separation between **Observed Facts** (`kind: 'fact'`), **Inferred Behavior** (`kind: 'inferred'`), and **Unknown Implementation Details** (`kind: 'unknown'`).
  - Prohibits automated harvesting of network response bodies, authenticated credentials, or local browser storage.
  - Automatically clears journal records upon session closure or workspace invalidation.

---

## 8. Webview Security & Sandboxing

The browser panel webview operates under defense-in-depth isolation:
- **Strict Content Security Policy (CSP)**:
  ```text
  default-src 'none';
  img-src ${webview.cspSource} https: data:;
  script-src 'nonce-${nonce}';
  style-src ${webview.cspSource} 'unsafe-inline';
  font-src ${webview.cspSource};
  connect-src 'none';
  frame-src 'none';
  object-src 'none';
  ```
- **Zero Raw HTML Injection**: Untrusted page titles, URLs, accessible names, error strings, and console logs are rendered strictly through `textContent` and pure DOM construction. No raw remote HTML or scripts can execute inside the Webview.
- **Message Validation & Prototype Pollution Defense**: Inbound messages from the webview are validated against a strict schema allowlist. Object keys containing `__proto__`, `constructor`, or `prototype` trigger immediate rejection.
- **Outside-Repository Artifact Boundary**: Screenshot artifacts and temporary files must reside outside workspace roots. Path traversal attempts trigger `UNSAFE_ARTIFACT_PATH` errors.

---

## 9. Performance & Telemetry Invariants

The browser panel satisfies strict performance benchmarks verified against real Chromium:
- **Panel Opening Latency**: $\le 15\text{ms}$ (measured $0.9\text{ms}$ in real packaged desktop host).
- **Event-to-UI Latency**: $\le 10\text{ms}$ (measured $1.89\text{ms}$).
- **Screenshot Capture & Save**: $\le 100\text{ms}$ (measured $54.69\text{ms}$).
- **Idle Memory Footprint**: $\le 100\text{MB}$ RSS.
- **Idle & Hidden CPU**: $< 1.0\%$ extension host CPU.
- **Bounded Retention**: At most 10 screenshot files on disk, at most 100 timeline events, and at most 50 observation journal entries.
