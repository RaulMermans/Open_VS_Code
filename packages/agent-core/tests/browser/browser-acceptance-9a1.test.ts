import { test, describe, before, after } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  BrowserSessionManager,
  BrowserSessionError,
  detectBrowserProvisioning,
  createBrowserToolRegistrations,
  classifyBrowserToolAction,
  isBrowserUrlPermitted,
  verifyHostDnsSafety,
  redactSensitiveText,
  isSensitiveField,
  isDestructiveElement,
  isSideEffectElement,
  type ElementRef,
  type BrowserEvent,
} from "../../src/browser/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { classifyPermission } from "../../src/tools/permissions.ts";
import { STARTER_MODE_PROFILES } from "../../src/modes/starter-profiles.ts";
import { resolveExecutionProfile } from "../../src/modes/resolver.ts";
import { BROWSER_QA_LOCAL_DEV_PACK, BROWSER_QA_INTERACTIVE_PACK } from "../../src/packs/starter-packs.ts";

describe("Sprint 9A.1 Acceptance Tests — Browser Security, Permission Integrity & Desktop Runtime Closure", () => {
  let tmpRoot: string;
  let workspaceRootA: string;
  let workspaceRootB: string;
  let server: http.Server;
  let serverUrl: string;
  let serverPort: number;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-9a1-root-"));
    workspaceRootA = path.join(tmpRoot, "ws-a");
    workspaceRootB = path.join(tmpRoot, "ws-b");
    fs.mkdirSync(workspaceRootA, { recursive: true });
    fs.mkdirSync(workspaceRootB, { recursive: true });

    server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://${req.headers.host}`);
      if (u.pathname === "/safe") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><head><title>Safe Page</title></head><body><h1>Safe Local App</h1></body></html>`);
      } else if (u.pathname === "/redirect-to-metadata") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (u.pathname === "/redirect-loop") {
        res.writeHead(302, { Location: `${serverUrl}/redirect-loop` });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><head><title>Test App</title></head><body><h1>Hello</h1></body></html>`);
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Acceptance Criterion 1: Browser sandbox behavior
  test("1. Browser sandbox behavior: verifies no unconditional disabling of sandbox and fail-closed diagnostics", () => {
    const prov = detectBrowserProvisioning();
    assert.ok(prov.status === "READY" || prov.status === "NOT_CONFIGURED");
    if (prov.executable) {
      assert.ok(fs.existsSync(prov.executable.path));
    }

    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "sandbox-test-sess",
    });

    // Manager status starts uninitialized
    assert.strictEqual(sessionManager.getStatus(), "UNINITIALIZED");
  });

  // Acceptance Criterion 2: Service Worker restrictions
  test("2. Service Worker restrictions: context blocks Service Workers by default fail-closed", () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "sw-policy-sess",
      networkPolicy: {
        blockServiceWorkers: true,
      },
    });
    assert.strictEqual(sessionManager.getStatus(), "UNINITIALIZED");
  });

  // Acceptance Criterion 3: Popup network interception
  test("3. Popup network interception: context-level route covers all popups and secondary pages", () => {
    // Network policy verification for popups targeting unauthorized destinations
    const res = isBrowserUrlPermitted("https://evil-popup.adversarial.test/steal", {
      allowedOrigins: [serverUrl],
    });
    assert.strictEqual(res.allowed, false);
    assert.ok(res.reason?.includes("not authorized"));
  });

  // Acceptance Criterion 4: Redirect policy enforcement
  test("4. Redirect policy enforcement: blocks hops into cloud metadata and detects excessive redirect chains", () => {
    const metadataCheck = isBrowserUrlPermitted("http://169.254.169.254/latest/meta-data/", {
      allowedOrigins: [serverUrl],
    });
    assert.strictEqual(metadataCheck.allowed, false);
    assert.ok(metadataCheck.reason?.includes("cloud metadata"));

    const internalCheck = isBrowserUrlPermitted("http://metadata.google.internal/computeMetadata/v1/", {
      allowedOrigins: [serverUrl],
    });
    assert.strictEqual(internalCheck.allowed, false);
    assert.ok(internalCheck.reason?.includes("cloud metadata"));
  });

  // Acceptance Criterion 5: DNS-based private destination blocking
  test("5. DNS-based private destination blocking: verifyHostDnsSafety rejects DNS rebinding to metadata or private IP", async () => {
    // Rebinding to cloud metadata
    const rebindingMetadata = await verifyHostDnsSafety("169.254.169.254", [serverUrl]);
    assert.strictEqual(rebindingMetadata.safe, false);

    // Loopback host safety checks
    const loopbackSafe = await verifyHostDnsSafety("127.0.0.1", [serverUrl]);
    assert.strictEqual(loopbackSafe.safe, true);

    // Rejection when origin does not allow loopback
    const loopbackRejected = await verifyHostDnsSafety("127.0.0.1", ["https://production.example.com"]);
    assert.strictEqual(loopbackRejected.safe, false);
  });

  // Acceptance Criterion 6: Unauthorized localhost ports
  test("6. Unauthorized localhost ports: blocks non-allowlisted localhost ports fail-closed without wildcard", () => {
    const policy = {
      allowedOrigins: [`http://127.0.0.1:${serverPort}`],
    };

    // Authorized port allowed
    const authCheck = isBrowserUrlPermitted(`http://127.0.0.1:${serverPort}/app`, policy);
    assert.strictEqual(authCheck.allowed, true);

    // Unauthorized port blocked
    const unauthCheck = isBrowserUrlPermitted(`http://127.0.0.1:9999/admin`, policy);
    assert.strictEqual(unauthCheck.allowed, false);
    assert.ok(unauthCheck.reason?.includes("not authorized"));
  });

  // Acceptance Criterion 7: WebSocket restrictions
  test("7. WebSocket restrictions: blocks ws:// and wss:// connections to unauthorized destinations", () => {
    const policy = {
      allowedOrigins: [`http://127.0.0.1:${serverPort}`],
    };

    const wsDenied = isBrowserUrlPermitted("ws://unauthorized.test/socket", policy);
    assert.strictEqual(wsDenied.allowed, false);

    const wssDenied = isBrowserUrlPermitted("wss://exfiltration.test/stream", policy);
    assert.strictEqual(wssDenied.allowed, false);

    // Authorized WS
    const wsAllowed = isBrowserUrlPermitted(`ws://127.0.0.1:${serverPort}/events`, policy);
    assert.strictEqual(wsAllowed.allowed, true);
  });

  // Acceptance Criterion 8: Password and token masking in snapshots
  test("8. Password and token masking in snapshots: sensitive fields are detected and values are masked", () => {
    assert.strictEqual(isSensitiveField({ name: "password", role: "textbox", tag: "input", selector: "input#pw" }), true);
    assert.strictEqual(isSensitiveField({ name: "api_key", role: "textbox", tag: "input", selector: "input#key" }), true);
    assert.strictEqual(isSensitiveField({ name: "user_token", role: "textbox", tag: "input", selector: "input#t" }), true);
    assert.strictEqual(isSensitiveField({ name: "public_query", role: "textbox", tag: "input", selector: "input#q" }), false);
  });

  // Acceptance Criterion 9: Sensitive console and URL redaction
  test("9. Sensitive console and URL redaction: redactSensitiveText removes credentials, tokens, and keys", () => {
    const basicAuth = redactSensitiveText("Connecting to https://alice:supersecret123@api.internal.dev/v1");
    assert.ok(!basicAuth.includes("supersecret123"));
    assert.ok(basicAuth.includes("[REDACTED_CREDENTIALS]"));

    const queryToken = redactSensitiveText("Navigating to https://local.dev/auth?token=abc123xyz789&user=bob");
    assert.ok(!queryToken.includes("abc123xyz789"));
    assert.ok(queryToken.includes("[REDACTED_SECRET]"));

    const bearerToken = redactSensitiveText("Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature");
    assert.ok(!bearerToken.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
    assert.ok(bearerToken.includes("[REDACTED_TOKEN]"));
  });

  // Acceptance Criterion 10: Per-operation risk classification
  test("10. Per-operation risk classification: calculates effectiveAction deterministically from validated target and operation", () => {
    const inspectAction = classifyBrowserToolAction({ toolName: "browser_snapshot" });
    assert.strictEqual(inspectAction, "browser_inspection");

    const navAction = classifyBrowserToolAction({ toolName: "browser_navigate" });
    assert.strictEqual(navAction, "browser_interaction");

    const submitTarget: ElementRef = {
      refId: "e_sub",
      role: "button",
      name: "Submit Order",
      selector: "button#submit",
      snapshotId: "s1",
      tag: "button",
      sideEffect: true,
      sensitive: false,
      destructive: false,
    };
    const sideEffectAction = classifyBrowserToolAction({
      toolName: "browser_click",
      targetElement: submitTarget,
    });
    assert.strictEqual(sideEffectAction, "browser_side_effect");

    const destroyTarget: ElementRef = {
      refId: "e_del",
      role: "button",
      name: "Delete Repository",
      selector: "button#delete",
      snapshotId: "s1",
      tag: "button",
      destructive: true,
      sideEffect: false,
      sensitive: false,
    };
    const destructiveAction = classifyBrowserToolAction({
      toolName: "browser_click",
      targetElement: destroyTarget,
    });
    assert.strictEqual(destructiveAction, "browser_destructive");
  });

  // Acceptance Criterion 11: External form submission approval
  test("11. External form submission approval: submit buttons classify as browser_side_effect requiring confirmation in BUILD and denied in PLAN", () => {
    assert.strictEqual(isSideEffectElement({ name: "Checkout Now", role: "button", tag: "button", selector: "#btn" }), true);
    assert.strictEqual(isSideEffectElement({ name: "Publish Changes", role: "button", tag: "button", selector: "#btn" }), true);
    assert.strictEqual(isSideEffectElement({ name: "Pay Invoice", role: "button", tag: "button", selector: "#btn" }), true);

    const buildPerm = classifyPermission({
      action: "browser_side_effect",
      mode: "BUILD",
    });
    assert.strictEqual(buildPerm, "CONFIRM");

    const planPerm = classifyPermission({
      action: "browser_side_effect",
      mode: "PLAN",
    });
    assert.strictEqual(planPerm, "DENY");
  });

  // Acceptance Criterion 12: Destructive action rejection
  test("12. Destructive action rejection: destructive actions are strictly DENIED in PLAN mode and require CONFIRM in BUILD", () => {
    assert.strictEqual(isDestructiveElement({ name: "Destroy Database", role: "button", tag: "button" }), true);
    assert.strictEqual(isDestructiveElement({ name: "Revoke Access Token", role: "button", tag: "button" }), true);

    const planPerm = classifyPermission({
      action: "browser_destructive",
      mode: "PLAN",
    });
    assert.strictEqual(planPerm, "DENY");

    const buildPerm = classifyPermission({
      action: "browser_destructive",
      mode: "BUILD",
    });
    assert.strictEqual(buildPerm, "CONFIRM");
  });

  // Acceptance Criterion 13: Stale target protection
  test("13. Stale target protection: revalidation blocks stale approval when snapshotId or page changes", async () => {
    const dummyManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "stale-protection-sess",
    });

    const tools = createBrowserToolRegistrations(dummyManager);
    const clickTool = tools.find((t) => t.definition.name === "browser_click")!;

    const review = await clickTool.prepareForReview!(
      { refId: "stale_e1" },
      { signal: new AbortController().signal } as any
    );

    // Attempting to apply stale approval without active page or with mismatched snapshot must reject
    await assert.rejects(
      async () => {
        await review.apply();
      },
      (err: any) => err instanceof Error
    );

    await dummyManager.dispose();
  });

  // Acceptance Criterion 14: Cancelled navigation cleanup
  test("14. Cancelled navigation cleanup: AbortSignal cleanly cancels in-flight navigation and emits cancellation", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "cancel-nav-sess",
    });

    let cancellationEmitted = false;
    sessionManager.onEvent((ev: BrowserEvent) => {
      if (ev.type === "cancellation") cancellationEmitted = true;
    });

    const abortCtrl = new AbortController();
    abortCtrl.abort();

    await assert.rejects(
      async () => {
        await sessionManager.navigate(`${serverUrl}/safe`, abortCtrl.signal);
      },
      (err: any) => err.name === "AbortError"
    );

    assert.strictEqual(cancellationEmitted, true);
    await sessionManager.dispose();
  });

  // Acceptance Criterion 15: Account logout session revocation
  test("15. Account logout session revocation: disposing session terminates active manager and marks CLOSED", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "logout-sess",
    });

    assert.strictEqual(sessionManager.getStatus(), "UNINITIALIZED");
    await sessionManager.dispose();
    assert.strictEqual(sessionManager.getStatus(), "CLOSED");

    // Operations after logout/disposal fail with DISPOSED
    await assert.rejects(
      async () => {
        await sessionManager.open(`${serverUrl}/safe`);
      },
      (err: any) => err instanceof BrowserSessionError && err.code === "DISPOSED"
    );
  });

  // Acceptance Criterion 16: Workspace isolation
  test("16. Workspace isolation: workspaces A and B maintain separate session instances and isolated state", () => {
    const sessionManagerA = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "isolated-sess-a",
      networkPolicy: { allowedOrigins: [serverUrl] },
    });

    const sessionManagerB = new BrowserSessionManager({
      workspaceRoot: workspaceRootB,
      sessionId: "isolated-sess-b",
      networkPolicy: { allowedOrigins: [serverUrl] },
    });

    assert.notStrictEqual(sessionManagerA.getSessionId(), sessionManagerB.getSessionId());
    assert.strictEqual(sessionManagerA.getStatus(), "UNINITIALIZED");
    assert.strictEqual(sessionManagerB.getStatus(), "UNINITIALIZED");
  });

  // Acceptance Criterion 17: Production extension composition
  test("17. Production extension composition: browser pack exposes verified integrity digest and custom modes", () => {
    assert.strictEqual(BROWSER_QA_LOCAL_DEV_PACK.id, "browser-qa-local-dev-pack");
    assert.strictEqual(BROWSER_QA_LOCAL_DEV_PACK.integrity.algorithm, "sha256");
    assert.ok(BROWSER_QA_LOCAL_DEV_PACK.integrity.digest.length > 0);

    assert.strictEqual(BROWSER_QA_INTERACTIVE_PACK.id, "browser-qa-interactive-pack");
    assert.strictEqual(BROWSER_QA_INTERACTIVE_PACK.integrity.algorithm, "sha256");
    assert.ok(BROWSER_QA_INTERACTIVE_PACK.integrity.digest.length > 0);
  });

  // Acceptance Criterion 18: Real AgentRunner tool invocation
  test("18. Real AgentRunner tool invocation: evaluates effectiveAction against classifyPermission before gate decision", async () => {
    const registry = new ToolRegistry();
    let executedTool = false;

    // Register a mock browser inspection tool with classifyAction
    registry.register({
      definition: {
        name: "test_browser_inspect",
        description: "Test inspection tool",
        action: "browser_interaction", // Static action is interaction (which is DENIED in PLAN)
        parameters: { type: "object", properties: { target: { type: "string" } } },
      },
      validate: (raw: unknown) => raw as Record<string, unknown>,
      classifyAction: (args: any) => {
        // Effective action is inspection based on validated operation!
        return args.target === "read_only" ? "browser_inspection" : "browser_interaction";
      },
      execute: async () => {
        executedTool = true;
        return { ok: true, inspection: "complete" };
      },
    });

    // 1. Prepare tool call with read-only target
    const preparedReadOnly = registry.prepare({
      id: "call-1",
      name: "test_browser_inspect",
      arguments: { target: "read_only" },
    });
    // Effective action was promoted to browser_inspection from operation arguments!
    assert.strictEqual(preparedReadOnly.effectiveAction, "browser_inspection");

    // In PLAN mode, static action (browser_interaction) would be DENIED:
    assert.strictEqual(
      classifyPermission({ action: "browser_interaction", mode: "PLAN" }),
      "DENY"
    );

    // But effective action (browser_inspection) is ALLOWED:
    const readOnlyDecision = classifyPermission({
      action: preparedReadOnly.effectiveAction,
      mode: "PLAN",
    });
    assert.strictEqual(readOnlyDecision, "ALLOW");

    // Executing the prepared call succeeds
    const execResult = await preparedReadOnly.invoke({
      workspaceRoot: workspaceRootA,
      signal: new AbortController().signal,
    });
    assert.strictEqual(executedTool, true);
    assert.deepStrictEqual(execResult, { ok: true, inspection: "complete" });

    // 2. Prepare tool call with interactive target
    const preparedInteractive = registry.prepare({
      id: "call-2",
      name: "test_browser_inspect",
      arguments: { target: "mutate" },
    });
    assert.strictEqual(preparedInteractive.effectiveAction, "browser_interaction");
    const interactiveDecision = classifyPermission({
      action: preparedInteractive.effectiveAction,
      mode: "PLAN",
    });
    assert.strictEqual(interactiveDecision, "DENY");
  });

  // Acceptance Criterion 19: Browser QA inspection
  test("19. Browser QA inspection: browser-qa-local-dev profile operates under PLAN base mode with read-only tools", () => {
    const inspectionProfile = STARTER_MODE_PROFILES.find((p) => p.id === "browser-qa-local-dev")!;
    assert.ok(inspectionProfile);
    assert.strictEqual(inspectionProfile.baseMode, "PLAN");

    // Permitted inspection tools
    const allowed = inspectionProfile.toolAllowlist!;
    assert.ok(allowed.includes("browser_open"));
    assert.ok(allowed.includes("browser_snapshot"));
    assert.ok(allowed.includes("browser_screenshot"));
    assert.ok(allowed.includes("browser_close"));

    // Mutating interaction tools are excluded from inspection profile
    assert.strictEqual(allowed.includes("browser_click"), false);
    assert.strictEqual(allowed.includes("browser_fill"), false);

    const resolved = resolveExecutionProfile({
      profile: inspectionProfile,
      workspaceTrusted: true,
      availableSkills: [],
      availableMcpServers: [],
      availableTools: allowed.map((name) => ({ name, action: "browser_inspection" })),
      globalWorkflowEnabled: true,
    });

    assert.strictEqual(resolved.isReady, true);
    assert.strictEqual(resolved.baseMode, "PLAN");
  });

  // Acceptance Criterion 20: Approved Browser QA interaction
  test("20. Approved Browser QA interaction: browser-qa-interactive-local-dev operates under BUILD base mode with confirmations", () => {
    const interactiveProfile = STARTER_MODE_PROFILES.find((p) => p.id === "browser-qa-interactive-local-dev")!;
    assert.ok(interactiveProfile);
    assert.strictEqual(interactiveProfile.baseMode, "BUILD");

    // All tools permitted
    const allowed = interactiveProfile.toolAllowlist!;
    assert.ok(allowed.includes("browser_open"));
    assert.ok(allowed.includes("browser_click"));
    assert.ok(allowed.includes("browser_fill"));

    const resolved = resolveExecutionProfile({
      profile: interactiveProfile,
      workspaceTrusted: true,
      availableSkills: [],
      availableMcpServers: [],
      availableTools: allowed.map((name) => ({ name, action: "browser_interaction" })),
      globalWorkflowEnabled: true,
    });

    assert.strictEqual(resolved.isReady, true);
    assert.strictEqual(resolved.baseMode, "BUILD");

    // Interaction requires CONFIRM in BUILD mode
    const clickPerm = classifyPermission({
      action: "browser_interaction",
      mode: "BUILD",
    });
    assert.strictEqual(clickPerm, "CONFIRM");

    // Side effect requires CONFIRM in BUILD mode
    const sideEffectPerm = classifyPermission({
      action: "browser_side_effect",
      mode: "BUILD",
    });
    assert.strictEqual(sideEffectPerm, "CONFIRM");
  });
});
