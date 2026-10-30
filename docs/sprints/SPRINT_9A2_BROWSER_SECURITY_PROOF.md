# Sprint 9A.2 Report: Browser Security Proof, Network Isolation & Runtime Reliability

## Executive Summary

Sprint 9A.2 is a focused corrective sprint closing specific browser security, network isolation, target-binding, workspace/account scoping, and profile-storage defects identified through independent code inspection of Sprint 9A.1, and establishing real Chromium process and adversarial network evidence for all security guarantees prior to Sprint 9B.

- **Status**: Complete & Verified
- **Repository**: `RaulMermans/Open_VS_Code`
- **Branch**: `sprint/9a2-browser-security-proof`
- **Starting Canonical Main SHA**: `786bc0c1e9c52d55dfe8b4061d8120a80cd89dc4` (PR #49 / Sprint 9A.1)
- **Final Branch Commit SHA**: `PENDING_COMMIT_SHA`
- **Verdict**: **`SPRINT_9A2_ACCEPTED`**
- **Architectural Invariant**: Preserved the existing `AgentRuntime`, `AgentSessionBridge`, `PermissionGate`, Playwright `playwright-core` integration, and 7 governed browser tools (`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_close`) with zero secondary agent loops, zero secondary permission systems, and zero new UI features.

---

## 1. Independent Inspection Findings & Root Causes

| Defect Area | Independent Inspection Finding | Root Cause in Sprint 9A.1 | Sprint 9A.2 Corrective Resolution |
| :--- | :--- | :--- | :--- |
| **P0 — Real-Connection DNS & Egress Enforcement** | `verifyHostDnsSafety()` existed in `browser-network-policy.ts`, but was never called by `attachNetworkPolicyToContext()` before `route.continue()`. Even with preflight DNS checks, Playwright route continuation allows Chromium's own network stack to re-resolve DNS, creating a validation-to-connect DNS rebinding TOCTOU gap. Default-port origins (`http://host:80`) also failed `url.origin` comparison. | Route interception evaluated string URL patterns (`isBrowserUrlPermitted`) without awaiting `verifyHostDnsSafety()` or binding actual socket destinations. | Wired `await verifyHostDnsSafety()` into `attachNetworkPolicyToContext()` across requests, redirect chains, and `context.routeWebSocket()`, AND introduced per-session `BrowserEgressProxy` (`proxy: { server, bypass: "<-loopback>" }`) with `createPinnedLookup()` IP pinning on `http.request`, `https.request`, HTTP `Upgrade` (`ws://`), and TLS `CONNECT` (`https://` / `wss://`). Canonicalized default ports in `matchOrigin()`. |
| **P0 — Chromium Sandbox Verification** | `verifyEffectiveSandboxSupport()` returned `{ supported: true }` unconditionally on macOS and Windows, and `chromiumSandbox: true` was passed only on Linux (`process.platform === "linux"`). | Platform name checks were treated as proof of effective runtime sandboxing without probing OS kernel capabilities or inspecting spawned Chromium helper processes. | Enabled `chromiumSandbox: true` across all supported platforms. Separated pre-launch capability probing (`verifyEffectiveSandboxSupport()` running `/usr/bin/sandbox-exec` probe on macOS and kernel userns/setuid inspection on Linux) from post-launch OS process-table runtime proof (`EffectiveSandboxVerification` inspecting live `ps` / CIM child trees, verifying `--seatbelt-client=` / `/proc/<pid>/status` `Seccomp`, and asserting zero `--no-sandbox` flags). Fails closed with `SANDBOX_UNAVAILABLE`. |
| **P0 — Stable Target Binding & Approval Revalidation** | `browser_click` and `browser_fill` built combined selectors (`[data-ovsc-ref="e1"], button:nth-of-type(1)`) that silently fell back to positional CSS if the original DOM node detached or moved, and `prepareForReview.apply()` checked only `snapshotId` and page URL. | Combined CSS `,` selector matched whichever branch existed at action time, allowing DOM replacement, reordered buttons, duplicate injected `data-ovsc-ref` attributes, or asynchronous label/type mutation to inherit a prior user approval. | Eliminated CSS fallback selectors; bound targets strictly to `[data-ovsc-ref][data-ovsc-snap][data-ovsc-session]`, stripped pre-existing/malicious `data-ovsc-*` attributes before each snapshot, rejected `count !== 1` (`STALE_ELEMENT_REFERENCE` / `AMBIGUOUS_TARGET_REFERENCE`), computed SHA-256 `targetFingerprint` over live identity/side-effect attributes (`tag`, `role`, `name`, `inputType`, `href`, `formAction`, `parentSignature`), reclassified live risk, and enforced `revalidateApproval()` inside `prepareForReview.apply()`. |
| **P1 — Workspace & Account Isolation** | `packages/vscode-integration/src/extension.ts` cached a single module-global `activeBrowserSessionManager` and read unscoped configuration. | Extension composition root did not key browser sessions by `(workspaceRoot, accountId, allowedOrigins, headless)` or listen to workspace folder/configuration changes. | Replaced global singleton with `ScopedBrowserSessionEntry` keyed by `(normalizedWorkspace, effectiveAccountId, configKey)` using resource-scoped `vscode.workspace.getConfiguration("openVsCode", workspaceUri)`. Added automatic `invalidate()` on workspace switch, untrusted workspace, logout, account switch, browser config change, and `deactivate()`. Verified rendering Integrations Hub never launches Chromium. |
| **P1 — Temporary Profile Location & Secret Redaction** | Ephemeral browser profiles defaulted to `${workspaceRoot}/.browser-profile/${sessionId}` inside the user's Git workspace, and screenshots / page titles / error messages / WebSocket errors could surface raw secrets. | Profile directory defaulted relative to `workspaceRoot`; `screenshot()` did not mask live password/secret `<input>` elements before rasterization. | Moved default profile storage outside repositories to `os.tmpdir()/open-vs-code-browser-profiles/ovsc_<sessionId>` (mode `0o700`) or VS Code `context.globalStorageUri`, rejected in-repo `storageDir` (`UNSAFE_PROFILE_PATH`), added `cleanupOrphanedBrowserProfiles()`, gitignored `.browser-profile/`, masked sensitive DOM inputs during `screenshot()`, and enforced `redactSensitiveText()` across all 8 required observation surfaces. |

---

## 2. Files Changed

| File | Summary of Changes |
| :--- | :--- |
| `.gitignore` | Added `.browser-profile/` and `**/.browser-profile/` defense-in-depth exclusions. |
| `packages/agent-core/src/tools/kill-process-tree.ts` | Added bounded, `shell: false` `execProcessProbe()` helper centralizing `node:child_process` usage within `agent-core`'s canonical OS process boundary module. |
| `packages/agent-core/src/tools/registry.ts` | Restored explicit `ToolAction` type import for clean strict TypeScript compilation across all workspaces. |
| `packages/agent-core/src/agent/runner.ts` | Set `effectiveAction: "PAUSE_HUMAN"` on internal human-pause sentinel calls to satisfy strict `PreparedToolCall` typing. |
| `packages/agent-core/src/browser/browser-contracts.ts` | Extended `EffectiveSandboxVerification` (separating `capabilitySupported` vs `runtimeVerified`, recording `osRelease`, `browserVersion`, `executablePath`, `executableSource`, `browserPid`, `helperPids`, `verificationMethod`, `processFlags`), extended `ElementRef` (`targetFingerprint`, `inputType`, `href`, `formAction`, `parentSignature`), and added structured observability event types (`network_policy_denied`, `dns_resolution_failed`, `sandbox_verified`, `target_validated`, `approval_revalidated`, `session_invalidated`, `screenshot_taken`). |
| `packages/agent-core/src/browser/browser-provisioning.ts` | Made `createRequire` lazy with CJS fallback so `esbuild --format=cjs` bundles cleanly without `import.meta` warnings or startup failures. |
| `packages/agent-core/src/browser/browser-network-policy.ts` | Enforced `verifyHostDnsSafety()` before `route.continue()` across requests, redirect chains, and `routeWebSocket()`; enforced `blockWebSockets`, IPv4/IPv6 literal & mapped range checks, and default-port canonicalization in `matchOrigin()`; implemented per-session `BrowserEgressProxy` with `createPinnedLookup()` IP pinning and active socket tracking (`#sockets`) for instant teardown. |
| `packages/agent-core/src/browser/browser-session-manager.ts` | Implemented `UNSAFE_PROFILE_PATH` guard, OS-temp `0o700` profiles + `cleanupOrphanedBrowserProfiles()`, pre-launch kernel capability checks + post-launch OS process-table sandbox verification, `BrowserEgressProxy` attachment (`bypass: "<-loopback>"`), Service Worker init-script + context block, pre-snapshot `data-ovsc-*` DOM attribute stripping, SHA-256 `targetFingerprint` + `revalidateApproval()`, screenshot input masking, 8-surface `redactSensitiveText()`, crash recovery, and `invalidate(reason)`. |
| `packages/agent-core/src/browser/browser-tools.ts` | Wired `sessionManager.revalidateApproval()` into `browser_click` and `browser_fill` `prepareForReview.apply()`, propagated `AbortSignal`, and applied `redactSensitiveText()` to `reviewPayload` fields and error paths. |
| `packages/vscode-integration/src/extension.ts` | Scoped `BrowserSessionManager` to `(normalizedWorkspace, effectiveAccountId, configKey)` with `globalStorageUri` profile storage, resource-scoped configuration, and automatic `invalidate()` on workspace folder change, configuration change, untrusted workspace, account logout/switch, and `deactivate()`. |
| `packages/vscode-integration/package.json` | Marked `--external:playwright-core` in `esbuild` bundle command so `playwright-core` resolves its runtime assets cleanly in packaged desktop builds. |
| `packages/agent-core/tests/browser/browser-acceptance-9a2.test.ts` | Added 20-scenario real Chromium adversarial security & runtime verification suite using live Chromium `156.0.0.0`, adversarial HTTP/redirect/popup/iframe/Service-Worker/WebSocket servers, server-side request/upgrade counters, controlled DNS rebinding resolvers, `SIGKILL` crash injection, and `AgentRuntime`/`PermissionGate` integration. |
| `packages/vscode-integration/tests/browser-isolation-9a2.test.ts` | Added VS Code extension host isolation tests proving two real workspaces and two account identities never share browser sessions, settings, or profiles, and rendering the Integrations Hub launches 0 browser sessions. |
| `packages/agent-core/tests/browser/browser-acceptance-9a1.test.ts` | Updated strict TypeScript call sites (`allowedOrigins: []`, `review.apply({ workspaceRoot, signal })`, `inputSchema`) while preserving all 20 Sprint 9A.1 assertions. |
| `packages/agent-core/tests/browser/browser-security.test.ts` | Extended Scenario 30 to assert both `close()` (`NO_PAGE`) and terminal `dispose()` (`DISPOSED`) `BrowserSessionError` codes. |
| `packages/agent-core/tests/modes/modes-engine.test.ts` | Updated starter profile count assertion from 3 to 5 to include `browser-qa-local-dev` and `browser-qa-interactive-local-dev`. |
| `packages/agent-core/tests/tools/permissions.test.ts` | Added `browser_side_effect: "CONFIRM"` to the exhaustive `Record<ToolAction, PermissionDecision>` baseline table test. |
| `docs/adrs/ADR-039-governed-playwright-browser-runtime.md` | Added Section 13 (Sprint 9A.2 Addendum) documenting connection-pinned egress proxy, two-stage sandbox verification, cryptographic target binding, workspace/account scoping, and outside-repo profile isolation. |
| `docs/SECURITY_MODEL.md` | Added Asset Category K, Governed Browser Runtime Attack Surface section, and Security Invariants 23–26. |
| `ARCHITECTURE.md` | Updated Sprint 9A/9A.1/9A.2 execution pipeline, architectural invariants, and `packages/agent-core/src/browser/` module boundary documentation. |
| `PLAN.md` & `PROJECT.md` | Recorded Sprint 9A.2 completion, security guarantees, and verification metrics. |

---

## 3. Security Guarantees: Network, Sandbox & Permission Revalidation

### 3.1 Connection-Level Network Isolation & DNS Rebinding Protection
1. **Dual-Layer Enforcement (Context Interceptor + Socket-Pinned Local Egress Proxy)**:
   - Every session starts an ephemeral local `BrowserEgressProxy` bound to `127.0.0.1:0` and launches Chromium with `proxy: { server: egressProxy.serverUrl, bypass: "<-loopback>" }`. Passing `bypass: "<-loopback>"` disables Chromium's implicit localhost proxy bypass so loopback ports (`127.0.0.1:<port>`, `[::1]:<port>`, `localhost:<port>`) are also forced through the proxy.
   - `attachNetworkPolicyToContext()` evaluates `isBrowserUrlPermitted()` and `await verifyHostDnsSafety()` across every navigation, subresource, popup, redirect hop (`request.redirectedFrom()`), and WebSocket (`context.routeWebSocket()`).
   - At actual connection dial time (`http.request`, `https.request`, HTTP `Upgrade` for `ws://`, and TLS `CONNECT` for `https://`/`wss://`), `BrowserEgressProxy` re-runs `isBrowserUrlPermitted()` and `verifyHostDnsSafety()` and pins the outbound `net.Socket` via `createPinnedLookup(pinnedIp)` directly to the validated IP address—eliminating DNS rebinding TOCTOU between check and connect.
2. **Prohibited Destinations**:
   - Rejects RFC1918 private IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), link-local (`169.254.0.0/16`), cloud metadata (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.azure.com`), IPv6 loopback/ULA/link-local/IPv4-mapped ranges (`::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`), alternate IP encodings (octal/hex/dword), `file://`/`blob:`/`filesystem:`/`javascript:`/`data:` top-level navigations, and unauthorized loopback ports.
   - Never silently falls back to direct unrestricted network access; proxy or DNS failure aborts the connection fail-closed.

### 3.2 Two-Stage Chromium Sandbox Verification
1. **Stage 1 — Pre-Launch Capability Check (`verifyEffectiveSandboxSupport()`)**:
   - **macOS (`darwin`)**: Verifies Darwin 18+ and executes `/usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/true` via `execProcessProbe()` (`shell: false`). In environments where nested Seatbelt initialization is kernel-denied (`sandbox_apply: Operation not permitted`), Stage 1 returns `{ supported: false }` in ~10ms and `start()` fails closed with `BrowserSessionError("SANDBOX_UNAVAILABLE")`.
   - **Linux (`linux`)**: Inspects `/proc/sys/kernel/unprivileged_userns_clone`, `/proc/sys/user/max_user_namespaces`, and `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`, requiring either unprivileged user namespaces or a root `04755` `chrome-sandbox` binary.
   - **Windows (`win32`)**: Verifies Windows NT 10+ AppContainer / restricted-token baseline.
2. **Stage 2 — Post-Launch Runtime Process Proof (`EffectiveSandboxVerification`)**:
   - Launches Chromium with explicit `chromiumSandbox: true` on all supported platforms and zero sandbox-disabling flags.
   - Initializes a renderer page, extracts the live Chromium version, and inspects the OS process tree matching `userDataDir`:
     - Asserts zero spawned processes contain `--no-sandbox`, `--disable-setuid-sandbox`, `--no-zygote-sandbox`, `--disable-gpu-sandbox`, or `--disable-seccomp-filter-sandbox`.
     - On macOS, verifies live helper processes run with `--seatbelt-client=` (`darwin_ps_seatbelt_helper_inspection`).
     - On Linux, inspects `/proc/<pid>/status` for `Seccomp: 2` (`SECCOMP_MODE_FILTER`).
   - If runtime proof cannot be established, the browser process tree and profile directory are terminated immediately and `start()` throws `BrowserSessionError("SANDBOX_UNAVAILABLE")`.

### 3.3 Cryptographic Target Binding & Live Approval Revalidation
1. **Canonical Attribute Injection & Spoof Neutralization**:
   - Before each `snapshot()`, all existing `data-ovsc-ref`, `data-ovsc-snap`, and `data-ovsc-session` attributes anywhere in the document are stripped so untrusted pages cannot pre-seed or duplicate reference attributes.
   - Interactive elements receive `[data-ovsc-ref="<refId>"][data-ovsc-snap="<snapshotId>"][data-ovsc-session="<sessionId>"]` and a SHA-256 `targetFingerprint` over `{ tag, role, name, inputType, href, formAction, parentSignature }`. No positional CSS fallback selector is ever used.
2. **Pre-Action & Post-Approval Revalidation (`revalidateApproval()`)**:
   - Immediately before `browser_click` or `browser_fill` executes (including inside `prepareForReview.apply()` after human `CONFIRM`), `revalidateApproval()` verifies:
     - Active session and page URL match the approved origin/URL (`STALE_APPROVAL` on navigation).
     - `snapshotId` matches the active snapshot (`STALE_ELEMENT_REFERENCE`).
     - Exact attribute selector matches **strictly 1** attached, visible live DOM element (`0` -> `STALE_ELEMENT_REFERENCE`; `>1` -> `AMBIGUOUS_TARGET_REFERENCE`).
     - Recomputed live SHA-256 `targetFingerprint` matches the snapshot's `targetFingerprint` (`TARGET_MUTATED_AFTER_APPROVAL`).
     - Reclassified live action (`classifyBrowserToolAction`) does not escalate risk beyond `approvedAction` (e.g., harmless button mutated asynchronously into `"Delete Workspace"` or `type="submit"` -> rejected with `RISK_ESCALATED_AFTER_APPROVAL`).

---

## 4. Real Browser Evidence & Environment Provenance

### Environment & Binary Provenance
- **Operating System**: macOS (`darwin` kernel release `25.5.0`, `arm64`)
- **Node.js Runtime**: `v22.23.2` (monorepo test runner) / Electron `42.8.1` (`node v24.18.1`, VS Code `1.135.0` in packaged desktop acceptance)
- **Verified Browser Version**: Chromium `156.0.0.0` (`Google Chrome for Testing`)
- **Executable Path**: `/Users/raulm/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
- **Provisioning Source**: `playwright_cache`
- **Runtime Sandbox Proof Method**: `darwin_ps_seatbelt_helper_inspection` (`chromiumSandboxOption: true`, `seatbeltClientActive: true`, `noSandboxIntroduced: false`)

### 20 Real-Chromium Adversarial Scenarios (`packages/agent-core/tests/browser/browser-acceptance-9a2.test.ts`)

| # | Scenario | Independent Runtime / Server-Side Proof | Outcome |
| :---: | :--- | :--- | :---: |
| 1 | Browser launches with intended sandbox configuration | Live Chromium `156.0.0.0` PID + helper PIDs inspected via OS `ps`; `--seatbelt-client=` confirmed active; `--no-sandbox` absent across entire process tree; `sandbox_verified` event emitted. | **PASS** |
| 2 | Browser starts with isolated temporary profile | Profile created under `os.tmpdir()` outside repository with mode `0700` (`stat.mode & 0o777 === 0o700`); in-repo `storageDir` rejected with `UNSAFE_PROFILE_PATH`; stale `ovsc_*` orphan dir purged. | **PASS** |
| 3 | Authorized local origin loads successfully | Real navigation to `http://127.0.0.1:<allowedPort>/hello` renders DOM and increments server-side HTTP counter (`allowedHits === 1`). | **PASS** |
| 4 | Unauthorized local port is blocked | Navigation to `http://127.0.0.1:<forbiddenPort>/secret` rejected fail-closed; server-side counter on forbidden port remains **`forbiddenHits === 0`**. | **PASS** |
| 5 | Allowlisted hostname resolving to prohibited address is rejected | Allowlisted hostnames resolving to `169.254.169.254`, `10.10.1.5`, and `fd00:ec2::254` rejected by `BrowserEgressProxy` + context guard with `dns_resolution_failed` event. | **PASS** |
| 6 | DNS rebinding cannot bypass connection policy | Adversarial `customResolver` returns public IP `93.184.216.34` on preflight lookup #1 and rebinds to `127.0.0.1` on proxy socket lookup #2 (`proxyLookups >= 2`); connection aborted before socket dial; local loopback target server records **`rebindTargetHits === 0`**. | **PASS** |
| 7 | Redirects to metadata endpoints & redirect loops are blocked | `302` redirect from authorized server to `http://169.254.169.254/latest/meta-data/` and redirect loop `> maxRedirects` both blocked; secondary target server records **`0` requests**. | **PASS** |
| 8 | Popups cannot escape destination restrictions | `window.open()` targeting unauthorized local server port aborted by context + proxy boundary; unauthorized popup server records **`popupTargetHits === 0`**. | **PASS** |
| 9 | Iframes and subresources obey restrictions | Page embedding `<iframe src>`, `<img src>`, and `fetch()` to unauthorized local port renders main frame while unauthorized subresource server records **`unapprovedHits === 0`**. | **PASS** |
| 10 | WebSocket restrictions apply to real connections | Live `ws://` upgrade attempt from authorized page to unauthorized WebSocket server blocked across `routeWebSocket` + `BrowserEgressProxy` HTTP `Upgrade`; unauthorized WS server records **`unauthorizedWsUpgrades === 0`** while authorized WS succeeds (`authorizedWsUpgrades === 1`). | **PASS** |
| 11 | Service Workers cannot bypass effective policy | `navigator.serviceWorker.register('/sw.js')` rejected with `SecurityError` under `serviceWorkers: "block"` + init guard; server-side `/sw.js` counter remains **`swScriptHits === 0`**. | **PASS** |
| 12 | DOM replacement invalidates previously approved click | Replacing approved `<button>` with a fresh DOM node before `prepareForReview.apply()` aborts click with `STALE_ELEMENT_REFERENCE`; replacement handler never fires (`replacementClicked === false`). | **PASS** |
| 13 | Destructive target substitution, reordering, duplicate refs & async mutation blocked | Mutating harmless button text to `"Delete Account"` (`RISK_ESCALATED_AFTER_APPROVAL`), mutating button to `type="submit"` (`TARGET_MUTATED_AFTER_APPROVAL`), reordering siblings, injecting duplicate `data-ovsc-ref` (`AMBIGUOUS_TARGET_REFERENCE`), and mutating `<input type="text">` to `type="password"` all fail closed with 0 target activations. | **PASS** |
| 14 | Secrets redacted across all 8 observation surfaces | Password/API-key/Bearer/AWS/Cookie/session values masked or scrubbed across (1) snapshot form values (`[hasValue]`, `value: undefined`), (2) URLs, (3) page titles, (4) console logs, (5) network diagnostics, (6) PNG screenshots (inputs visually masked during capture and restored afterward), (7) `reviewPayload`, and (8) error messages. | **PASS** |
| 15 | Account switching terminates and invalidates sessions | Switching from `acct-alpha` to `acct-beta` emits `session_invalidated`, kills `acct-alpha` Chromium PID, deletes `acct-alpha` temp profile, and rejects stale manager commands with `DISPOSED`; VS Code `browser-isolation-9a2.test.ts` additionally verifies extension-host account switching & logout. | **PASS** |
| 16 | Workspace switching does not reuse browser authority | Workspace A (`allowedPortA`) and Workspace B (`allowedPortB`) receive distinct managers, profiles, and proxies; Workspace B cannot reach Workspace A's port (**`serverAHitsFromB === 0`**). | **PASS** |
| 17 | Temporary profiles are removed after disposal | After real Chromium navigation and `dispose()`, `fs.existsSync(profileDir) === false` and `process.kill(browserPid, 0)` throws `ESRCH`. | **PASS** |
| 18 | Cancellation stops active browser operations | `AbortController.abort()` at 150ms during a hanging 10s response aborts `open()` in `< 2.5s` (not waiting for 15s timeout) and emits `cancellation` event. | **PASS** |
| 19 | Browser crashes produce bounded recovery behavior | Sending `SIGKILL` to live Chromium `browserPid` transitions session cleanly without hanging, rejects snapshot with bounded `BrowserSessionError`, and recovers cleanly on next `open()` with a fresh sandboxed Chromium process. | **PASS** |
| 20 | `AgentRuntime` & `AgentRunner` invoke real governed Playwright tools with `PermissionGate` | Real `createAgentRuntime` + `AgentRunner`: `PLAN` mode allows `browser_open`/`browser_snapshot` against live server and `DENY`s `browser_click` (`permission.denied`); `BUILD` mode pauses `browser_click` for `CONFIRM`, executes real click when unchanged, and blocks execution when DOM mutates to `"Delete Repository"` during confirmation pause. | **PASS** |

---

## 5. Full Regression Gate Outcomes (Section 8)

All required regression gates were executed and recorded with zero weakened assertions:

| Gate Command | Suites / Scope | Passed | Failed | Skipped | Notes |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Standalone Real-Browser Security Suite** (`node --import tsx/esm --test packages/agent-core/tests/browser/browser-acceptance-9a2.test.ts`) | 1 suite (`agent-core` real Chromium `156.0.0.0`) | **20** | **0** | **0** | 31.1s duration; real HTTP/WS servers + OS `ps` sandbox verification |
| **VS Code Extension Isolation Suite** (`node --import tsx --test packages/vscode-integration/tests/browser-isolation-9a2.test.ts`) | 1 suite (`vscode-integration`) | **2** | **0** | **0** | 2 workspaces × 2 accounts + Integrations Hub render non-launch |
| `npm test` (all workspaces, Node `v22.23.2`) | 5 workspaces (`account-service` 84, `agent-core` 807, `cli` 21, `ide-adapter` 7, `vscode-integration` 238) | **1,157** | **0** | **0** | Full monorepo unit, integration, security, and real-browser suites |
| `npm run typecheck` | All 5 workspaces (`tsc --noEmit`) | **5 / 5** | **0** | **0** | 0 TypeScript errors across monorepo |
| `npm run lint` | `oxlint --deny-warnings` (308 files: 39 + 263 + 6) | **308 / 308** | **0** | **0** | 0 warnings, 0 errors |
| `npm run build` | All workspaces + `esbuild` extension bundle (`1.4mb`) | **6 / 6** | **0** | **0** | Clean CJS bundle with `--external:playwright-core` |
| `npm run eval:runtime` | Sprint 4B deterministic runtime evals (111 scenarios × 2 runs) | **14** | **0** | **0** | Run 1 === Run 2 deterministic equality |
| `npm run eval:skills` | Sprint 5A deterministic skill selection & token efficiency | **38 / 40** (`95.0%`) | **0** gate failures | **0** | `9/9` (`100.0%`) no-skill accuracy; `86.9%` token reduction |
| `npm run eval:workflow` | Sprint 5B structured workflow loop evaluation | **14 / 14** eligibility (`5/5` structured) | **0** | **0** | `2/2` seeded security/logic defects caught |
| `npm run desktop:smoke` | Packaged `Open VS Code.app` smoke & Category D integration | **14** | **0** | **0** | Ad-hoc signature & packaged custom-mode/chat/FIM contracts verified |
| `npm run desktop:accept` | Real packaged VSCodium/Electron `42.8.1` GUI acceptance | **5** | **0** | **0** | Real extension host activation (`40.95ms` perf probe), restart persistence |

---

## 6. Known Limitations & Operational Boundaries

1. **Nested OS Sandbox Environments Fail Closed by Design**:
   - When Open VS Code or the test runner is itself executed inside a restrictive outer macOS Seatbelt sandbox that forbids nested `sandbox_init()` (`sandbox-exec: sandbox_apply: Operation not permitted`), `verifyEffectiveSandboxSupport()` returns `supported: false` and `BrowserSessionManager.start()` fails closed with `BrowserSessionError("SANDBOX_UNAVAILABLE")` rather than launching Chromium without a sandbox. Normal macOS user sessions, packaged `Open VS Code.app`, and standard CI VMs initialize native Chromium Seatbelt helpers cleanly.
2. **Operator-Provisioned Browser Binary (No Auto-Downloads)**:
   - Consistent with ADR-039 and supply-chain rules, `detectBrowserProvisioning()` never invokes `npx playwright install` or downloads binaries at runtime. If no local Chromium/Chrome binary is present in `OPEN_VS_CODE_BROWSER_EXECUTABLE_PATH`, the Playwright cache, or standard OS paths, browser tools fail closed with `NOT_CONFIGURED`.
3. **Packaged Desktop External Playwright Resolution**:
   - `packages/vscode-integration` marks `playwright-core` as `--external:playwright-core` so `playwright-core` resolves its relative metadata cleanly in Node/Electron. Operators using browser QA from a standalone extracted `.app` outside the monorepo workspace require `playwright-core` available in the host Node module path (or bundled alongside its `browsers.json` descriptor in Sprint 9B distribution packaging).
4. **No Arbitrary Script Evaluation or Autonomous Open-Web Browsing**:
   - `DEFAULT_ALLOWED_LOCAL_ORIGINS` remains `[]` (fail-closed until exact origins and ports are explicitly configured), and `browser_evaluate` / raw CDP / persistent cookie import remain excluded.

---

## 7. Merge Readiness & Sprint Verdict

- **Starting Canonical Main SHA**: `786bc0c1e9c52d55dfe8b4061d8120a80cd89dc4`
- **Branch**: `sprint/9a2-browser-security-proof`
- **All 10 Section 11 Acceptance Criteria**: **SATISFIED WITH REAL CHROMIUM EVIDENCE**
- **Merge Readiness**: Ready for operator review and PR merge into `main`. Per instructions, **not merged or pushed** awaiting explicit approval.
- **Verdict**: **`SPRINT_9A2_ACCEPTED`**
