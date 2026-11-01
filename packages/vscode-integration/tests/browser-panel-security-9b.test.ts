import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";
import {
  BoundedObservationJournal,
  BrowserSessionError,
  BrowserSessionManager,
  type AgentMode,
  type BrowserEvent,
  type BrowserEventType,
} from "@open-vs-code/agent-core";
import {
  BrowserPanelController,
  buildBrowserPanelHtml,
  escapeHtmlAttribute,
  isSafeBrowserWebviewImageSrc,
  parseBrowserPanelMessage,
  renderBrowserInspector,
  renderBrowserObservationPrep,
  renderBrowserScreenshotPreview,
  renderBrowserStatusHeader,
  renderBrowserTimeline,
  type BrowserPanelState,
  type BrowserPanelViewAdapter,
  type BrowserWorkspaceEnvironment,
  type InboundBrowserPanelMessage,
} from "../src/browser/index.ts";
import { FakeDomDocument, FakeDomElement } from "./helpers/browser-panel-dom-harness.ts";

function makePngBuffer(width = 1280, height = 800): Buffer {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex"
  );
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

class SecurityPanelView implements BrowserPanelViewAdapter {
  public isOpen = false;
  public isVisible = false;
  public postedStates: BrowserPanelState[] = [];
  public onMessage!: (msg: InboundBrowserPanelMessage) => void;
  public onVisibilityChanged!: (visible: boolean) => void;
  public onPanelClosed!: () => void;

  public openOrReveal(): void {
    this.isOpen = true;
    this.isVisible = true;
  }

  public async postState(state: BrowserPanelState): Promise<boolean> {
    if (!this.isOpen || !this.isVisible) return false;
    this.postedStates.push(state);
    return true;
  }

  public asWebviewUri(filePath: string): string {
    return `vscode-webview-resource://file${filePath}`;
  }

  public dispose(): void {
    this.isOpen = false;
    this.isVisible = false;
  }
}

function attachSecurityMockSession(manager: BrowserSessionManager) {
  let pageUrl = "";
  let pageTitle = "";
  let started = false;
  let statusOverride: ReturnType<BrowserSessionManager["getStatus"]> = "UNINITIALIZED";
  let liveActionButtonName = "Submit Order";
  let liveActionFormAction = "/orders";
  let clickExecutedCount = 0;
  let fillExecutedCount = 0;

  const corrStack: Array<{ origin: "agent" | "user" | "system"; taskId?: string }> = [];
  const origWithCorrelation = manager.withCorrelation.bind(manager);
  manager.withCorrelation = async (corr, fn) => {
    corrStack.push(corr);
    try {
      return await origWithCorrelation(corr, fn);
    } finally {
      corrStack.pop();
    }
  };

  const listeners = new Set<(e: BrowserEvent) => void>();
  const origOnEvent = manager.onEvent.bind(manager);
  manager.onEvent = (cb) => {
    listeners.add(cb);
    const unsub = origOnEvent(cb);
    return () => {
      listeners.delete(cb);
      unsub();
    };
  };

  const emit = (type: BrowserEventType, details: Record<string, unknown>, origin?: "agent" | "user" | "system") => {
    const inherited = corrStack[corrStack.length - 1];
    const effectiveOrigin = origin ?? inherited?.origin;
    const ev: BrowserEvent = {
      type,
      sessionId: manager.getSessionId(),
      timestamp: Date.now(),
      details,
      ...(effectiveOrigin ? { correlation: { origin: effectiveOrigin } } : {}),
    };
    for (const cb of listeners) cb(ev);
  };

  const fakePage: any = {
    isClosed: () => false,
    url: () => pageUrl,
    title: async () => pageTitle,
    screenshot: async () => makePngBuffer(1280, 800),
    close: async () => {},
  };

  manager.start = async () => {
    if (!started) {
      started = true;
      statusOverride = "READY";
      emit("session_started", { platform: process.platform, verificationMethod: "mock_seatbelt" });
    }
  };
  manager.getActivePage = () => (started && statusOverride !== "CLOSED" ? fakePage : undefined);
  const origGetStatus = manager.getStatus.bind(manager);
  manager.getStatus = () => {
    const b = origGetStatus();
    return b === "ERROR" ? b : statusOverride;
  };
  manager.getCurrentUrl = () => (started && statusOverride !== "CLOSED" ? pageUrl : "");
  manager.getCurrentTitle = () => (started && statusOverride !== "CLOSED" ? pageTitle : "");

  const validateDestination = (rawUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BrowserSessionError("INVALID_URL", `[INVALID_URL] Invalid URL: "${rawUrl}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      emit("network_policy_denied", {
        url: rawUrl,
        method: "NAVIGATE",
        error: `[BLOCKED_SCHEME] Scheme "${parsed.protocol}" is forbidden.`,
      });
      throw new BrowserSessionError("BLOCKED_SCHEME", `[BLOCKED_SCHEME] Scheme "${parsed.protocol}" is forbidden.`);
    }
    if (parsed.hostname === "169.254.169.254" || parsed.hostname === "metadata.google.internal") {
      emit("network_policy_denied", {
        url: rawUrl,
        method: "NAVIGATE",
        error: `[CLOUD_METADATA_BLOCKED] Cloud metadata host "${parsed.hostname}" is strictly forbidden.`,
      });
      throw new BrowserSessionError("CLOUD_METADATA_BLOCKED", `[CLOUD_METADATA_BLOCKED] Host "${parsed.hostname}" blocked.`);
    }
    const allowed = manager.getNetworkPolicyConfig().allowedOrigins;
    if (!allowed.includes(parsed.origin)) {
      emit("network_policy_denied", {
        url: rawUrl,
        method: "NAVIGATE",
        error: `[ORIGIN_NOT_ALLOWED] Origin "${parsed.origin}" is not in allowedOrigins.`,
      });
      emit("navigation_failed", { url: rawUrl, reason: `Origin "${parsed.origin}" is not in allowedOrigins.` });
      throw new BrowserSessionError("ORIGIN_NOT_ALLOWED", `[ORIGIN_NOT_ALLOWED] Origin "${parsed.origin}" is not in allowedOrigins.`);
    }
    return parsed;
  };

  manager.open = async (url: string) => {
    emit("navigation_attempted", { url });
    validateDestination(url);
    await manager.start();
    pageUrl = url;
    pageTitle = "Secure Test App";
    emit("navigation_completed", { url: pageUrl, title: pageTitle });
    return { pageId: "p_main", url: pageUrl, title: pageTitle };
  };

  manager.navigate = async (url: string) => {
    const r = await manager.open(url);
    return { url: r.url, title: r.title };
  };

  let snapCounter = 0;
  let currentSnap: Awaited<ReturnType<BrowserSessionManager["snapshot"]>> | undefined;
  manager.snapshot = async () => {
    const snapId = `snap_sec_${++snapCounter}`;
    const elements = [
      {
        refId: "e1",
        role: "textbox",
        name: "Account Password",
        selector: "#pwd",
        snapshotId: snapId,
        tag: "input",
        sensitive: true,
        destructive: false,
        sideEffect: false,
        targetFingerprint: `fp_${snapId}_e1`,
        inputType: "password",
        href: "",
        formAction: "/login",
        parentSignature: "form#login",
        bounds: { x: 20, y: 40, width: 220, height: 34, viewportWidth: 1280, viewportHeight: 800 },
        interactiveState: { disabled: false, readonly: false, required: true, focused: false, editable: true },
      },
      {
        refId: "e2",
        role: "button",
        name: liveActionButtonName,
        selector: "#action-btn",
        snapshotId: snapId,
        tag: "button",
        sensitive: false,
        destructive: liveActionButtonName.toLowerCase().includes("delete"),
        sideEffect: liveActionButtonName.toLowerCase().includes("submit"),
        targetFingerprint: `fp_${snapId}_e2_${liveActionButtonName}`,
        inputType: "submit",
        href: "",
        formAction: liveActionFormAction,
        parentSignature: "form#orders",
        bounds: { x: 20, y: 96, width: 160, height: 38, viewportWidth: 1280, viewportHeight: 800 },
        interactiveState: { disabled: false, readonly: false, required: false, focused: false, editable: false },
      },
    ];
    currentSnap = {
      snapshotId: snapId,
      url: pageUrl,
      title: pageTitle,
      tree: `Page: "${pageTitle}"\n  [ref=e1] <input> textbox "Account Password"\n  [ref=e2] <button> button "${liveActionButtonName}"`,
      elements,
      elementCount: elements.length,
      truncated: false,
      bytes: 164,
      capturedAt: Date.now(),
      viewport: { width: 1280, height: 800 },
    };
    emit("snapshot_taken", { snapshotId: snapId, url: pageUrl, elementCount: 2, bytes: 164 });
    return currentSnap;
  };
  manager.getLatestSnapshot = () => currentSnap;
  manager.getActiveSnapshotId = () => currentSnap?.snapshotId;
  manager.isSnapshotFresh = (id?: string) => Boolean(currentSnap && (!id || id === currentSnap.snapshotId));
  manager.getElementRef = (refId: string) => currentSnap?.elements.find((e) => e.refId === refId);

  manager.revalidateApproval = async (params) => {
    const snapEl = currentSnap?.elements.find((e) => e.refId === params.refId);
    if (!currentSnap || !snapEl || params.approvedSnapshotId !== currentSnap.snapshotId) {
      emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "STALE_ELEMENT_REFERENCE" });
      throw new BrowserSessionError("STALE_ELEMENT_REFERENCE", "[STALE_ELEMENT_REFERENCE] Snapshot is stale.");
    }
    if (params.refId === "e2") {
      if (liveActionButtonName.toLowerCase().includes("delete") && !snapEl.destructive) {
        emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "ACTION_RISK_ESCALATED" });
        throw new BrowserSessionError(
          "ACTION_RISK_ESCALATED",
          `[ACTION_RISK_ESCALATED] Control "${params.refId}" mutated into DESTRUCTIVE target ("${liveActionButtonName}"). Approval invalidated.`
        );
      }
      if (liveActionFormAction !== snapEl.formAction) {
        emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "TARGET_MUTATION_DETECTED" });
        throw new BrowserSessionError(
          "TARGET_MUTATION_DETECTED",
          `[TARGET_MUTATION_DETECTED] formAction mutated from "${snapEl.formAction}" to "${liveActionFormAction}".`
        );
      }
    }
  };

  manager.click = async (refId: string) => {
    clickExecutedCount += 1;
    emit("tool_invoked", { tool: "browser_click", refId, target: liveActionButtonName });
    emit("action_approved", { tool: "browser_click", refId, target: liveActionButtonName });
  };

  manager.fill = async (refId: string) => {
    fillExecutedCount += 1;
    emit("tool_invoked", { tool: "browser_fill", refId, target: "Account Password" });
    emit("action_approved", { tool: "browser_fill", refId, target: "Account Password" });
  };

  const origScreenshot = manager.screenshot.bind(manager);
  manager.screenshot = async (opts) => {
    if (opts?.outputPath) {
      const resolved = path.resolve(opts.outputPath);
      const ws = path.resolve(manager.getWorkspaceRoot());
      if (!opts.allowWorkspaceExport && (resolved === ws || resolved.startsWith(ws + path.sep))) {
        throw new BrowserSessionError(
          "UNSAFE_ARTIFACT_PATH",
          `[UNSAFE_ARTIFACT_PATH] Refusing to write screenshot inside workspace repository: "${resolved}".`
        );
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
      fs.writeFileSync(resolved, makePngBuffer(1280, 800), { mode: 0o600 });
    }
    const res = {
      bytes: 68,
      mimeType: "image/png" as const,
      width: 1280,
      height: 800,
      capturedAt: Date.now(),
      url: pageUrl,
      pageTitle,
      viewport: { width: 1280, height: 800 },
      snapshotId: currentSnap?.snapshotId,
      maskedSensitiveFields: 1,
      ...(opts?.outputPath ? { filePath: path.resolve(opts.outputPath) } : {}),
    };
    emit("screenshot_taken", { bytes: 68, width: 1280, height: 800, url: pageUrl, maskedSensitiveFields: 1 });
    return res;
  };

  return {
    emit,
    origScreenshot,
    mutateLiveButton(newLabel: string, newFormAction = liveActionFormAction) {
      liveActionButtonName = newLabel;
      liveActionFormAction = newFormAction;
    },
    setPageTitle(title: string) {
      pageTitle = title;
    },
    getClickExecutedCount: () => clickExecutedCount,
    getFillExecutedCount: () => fillExecutedCount,
  };
}

describe("Sprint 9B — Visual Browser Security, Authority & Isolation Suite", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let artifactRoot: string;
  let fakeBrowserExec: string;
  let view: SecurityPanelView;
  let acquireCount: number;
  let currentMode: AgentMode;
  let currentModeLabel: string;
  let workspaceTrusted: boolean;
  let currentAccountId: string;
  let approvalCallback: (prompt: string, payload: Readonly<Record<string, unknown>>) => Promise<"APPROVE" | "REJECT">;
  let activeManager: BrowserSessionManager | undefined;
  let mockSession: ReturnType<typeof attachSecurityMockSession> | undefined;
  let controller: BrowserPanelController;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9b-sec-"));
    workspaceRoot = path.join(tmpDir, "workspace-sec");
    artifactRoot = path.join(tmpDir, "private-artifacts");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fakeBrowserExec = path.join(tmpDir, "fake-chromium");
    fs.writeFileSync(fakeBrowserExec, "#!/bin/sh\necho 'Chromium 156.0.0.0'\n", { mode: 0o755 });

    view = new SecurityPanelView();
    acquireCount = 0;
    currentMode = "BUILD";
    currentModeLabel = "BUILD";
    workspaceTrusted = true;
    currentAccountId = "acct_sec_user";
    approvalCallback = async () => "APPROVE";
    activeManager = undefined;
    mockSession = undefined;

    const getEnvironment = (): BrowserWorkspaceEnvironment => ({
      workspaceRoot,
      workspaceName: "workspace-sec",
      workspaceTrusted,
      activeMode: currentMode,
      activeModeLabel: currentModeLabel,
      allowedOrigins: ["http://127.0.0.1:4173"],
      executablePath: fakeBrowserExec,
      identity: {
        accountId: currentAccountId,
        displayLabel: "sec-user",
        authenticated: true,
      },
    });

    controller = new BrowserPanelController({
      artifactRootPath: artifactRoot,
      getEnvironment,
      acquireSessionManager: () => {
        acquireCount += 1;
        if (!activeManager) {
          activeManager = new BrowserSessionManager({
            workspaceRoot,
            accountId: currentAccountId,
            executablePath: fakeBrowserExec,
            networkPolicy: { allowedOrigins: ["http://127.0.0.1:4173"] },
          });
          mockSession = attachSecurityMockSession(activeManager);
        }
        return activeManager;
      },
      confirmationBridge: {
        requestConfirmation: (prompt, payload) => approvalCallback(prompt, payload),
        confirmSessionClose: async () => true,
      },
      createViewAdapter: (callbacks) => {
        view.onMessage = callbacks.onMessage;
        view.onVisibilityChanged = callbacks.onVisibilityChanged;
        view.onPanelClosed = callbacks.onPanelClosed;
        return view;
      },
    });
  });

  afterEach(async () => {
    controller.dispose();
    if (activeManager) {
      await activeManager.dispose();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("1. Strict inbound Webview message allowlist blocks JS eval, CDP, cookie export, FS commands, and prototype pollution", () => {
    const blockedPayloads: unknown[] = [
      null,
      undefined,
      "browserPanel.ready",
      ["browserPanel.ready"],
      { type: "browserPanel.eval", script: "document.cookie" },
      { type: "browser_eval", expression: "window.localStorage" },
      { type: "browserPanel.cdp", method: "Network.getAllCookies" },
      { type: "browserPanel.exportCookies" },
      { type: "browserPanel.writeFile", path: "/etc/passwd", content: "x" },
      { type: "browserPanel.readFile", path: "/Users/alice/.ssh/id_rsa" },
      { type: "browserPanel.clickCoordinates", x: 100, y: 200 },
      { type: "browserPanel.openUrl", url: "" },
      { type: "browserPanel.openUrl", url: "http://127.0.0.1:4173/\r\nInjected: header" },
      { type: "browserPanel.openUrl", url: "http://127.0.0.1:4173/" + "a".repeat(2100) },
      { type: "browserPanel.clickSelected", refId: "#raw-css-selector" },
      { type: "browserPanel.clickSelected", refId: "e0" },
      { type: "browserPanel.clickSelected", refId: "e123456" },
      { type: "browserPanel.clickSelected", refId: "<script>alert(1)</script>" },
      { type: "browserPanel.fillSelected", refId: "e1", value: "x".repeat(5000) },
      { type: "browserPanel.setViewportPreset", presetId: "ultrawide" },
      { type: "browserPanel.setZoomMode", zoomMode: "200%" },
      JSON.parse('{"type":"browserPanel.ready","__proto__":{"polluted":true}}'),
      JSON.parse('{"type":"browserPanel.ready","constructor":{"polluted":true}}'),
      JSON.parse('{"type":"browserPanel.ready","prototype":{"polluted":true}}'),
    ];

    for (const payload of blockedPayloads) {
      assert.equal(
        parseBrowserPanelMessage(payload),
        null,
        `Dangerous or malformed payload must be rejected: ${JSON.stringify(payload)}`
      );
    }

    assert.deepEqual(parseBrowserPanelMessage({ type: "browserPanel.clickSelected", refId: "e2" }), {
      type: "browserPanel.clickSelected",
      refId: "e2",
    });
  });

  test("2. Webview HTML shell enforces restrictive CSP, nonce script, zero iframes, and non-clickable geometry overlays", () => {
    const html = buildBrowserPanelHtml("https://file+.vscode-resource.vscode-cdn.net", "nonce_AbCdEf123456");

    assert.ok(
      html.includes(
        `content="default-src 'none'; img-src https://file+.vscode-resource.vscode-cdn.net; style-src 'unsafe-inline'; script-src 'nonce-nonce_AbCdEf123456';"`
      ),
      "CSP must restrict default-src to 'none', img-src to cspSource, and script-src to exact nonce"
    );
    assert.equal(html.includes("unsafe-eval"), false, "CSP must never permit unsafe-eval");
    assert.equal(/<iframe\b/i.test(html), false, "HTML shell must never embed iframes");
    assert.equal(/<script\s+src=/i.test(html), false, "HTML shell must never load remote scripts");
    assert.ok(html.includes("pointer-events: none;"), "Bounding-box highlight CSS must enforce pointer-events: none");

    // Verify attribute escaping against malicious CSP/nonce inputs
    const escaped = escapeHtmlAttribute(`" onload="alert(1)" <script>`);
    assert.equal(escaped.includes('"'), false, "Quotes must be escaped");
    assert.equal(escaped.includes("<"), false, "Angle brackets must be escaped");
  });

  test("3. Escapes untrusted page titles, URLs, accessible names, errors & warnings via textContent with zero non-empty innerHTML", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/xss-lab",
    });

    const xssPayload = `<img src=x onerror="alert('xss')"><script>fetch('https://evil.invalid')</script>`;
    mockSession!.setPageTitle(xssPayload);
    mockSession!.mutateLiveButton(xssPayload);
    await controller.handleMessage({ type: "browserPanel.inspectElements" });
    await controller.handleMessage({ type: "browserPanel.selectElement", refId: "e2" });
    mockSession!.emit("network_policy_denied", {
      url: "https://evil.invalid/steal",
      error: xssPayload,
    });
    mockSession!.emit("navigation_failed", {
      url: "http://127.0.0.1:4173/xss",
      error: xssPayload,
    });

    const state = controller.getState();
    const doc = new FakeDomDocument();
    const header = new FakeDomElement("header");
    const preview = new FakeDomElement("section");
    const inspector = new FakeDomElement("div");
    const timeline = new FakeDomElement("div");
    const prep = new FakeDomElement("div");

    renderBrowserStatusHeader(header, state, doc);
    renderBrowserScreenshotPreview(preview, state, doc);
    renderBrowserInspector(inspector, state, undefined, doc);
    renderBrowserTimeline(timeline, state.timeline, doc);
    renderBrowserObservationPrep(prep, state, doc);

    for (const root of [header, preview, inspector, timeline, prep, ...doc.createdElements]) {
      assert.equal(
        root.nonEmptyInnerHtmlAttempted,
        false,
        `Element <${root.tagName} class="${root.className}"> must NEVER assign non-empty innerHTML`
      );
    }
    assert.ok(header.textContent.includes(xssPayload), "Literal untrusted title rendered safely as plain text");
    assert.ok(inspector.textContent.includes(xssPayload), "Literal untrusted accessible name rendered safely as plain text");
  });

  test("4. Screenshot preview blocks javascript:, data:, file:, and arbitrary remote image URIs", () => {
    const blockedUris = [
      "",
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "file:///etc/passwd",
      "http://127.0.0.1:4173/evil.png",
      "https://evil.example.com/vscode-cdn.net/fake.png",
      "https://not-vscode-cdn.net/img.png",
      "vscode-webview-resource://file/tmp/a.png\r\nx",
    ];
    for (const uri of blockedUris) {
      assert.equal(isSafeBrowserWebviewImageSrc(uri), false, `URI must be rejected: ${uri}`);
    }

    assert.equal(isSafeBrowserWebviewImageSrc("vscode-webview-resource://file/tmp/shot.png"), true);
    assert.equal(isSafeBrowserWebviewImageSrc("https://file+.vscode-resource.vscode-cdn.net/tmp/shot.png"), true);
  });

  test("5. Manual Open/Navigate controls enforce network policy against file://, cloud metadata, and unauthorized ports", async () => {
    controller.openOrRevealPanel();

    for (const forbiddenUrl of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://127.0.0.1:9999/unauthorized-port",
    ]) {
      await controller.handleMessage({ type: "browserPanel.openUrl", url: forbiddenUrl });
      const state = controller.getState();
      assert.ok(state.navigationError, `Forbidden URL must produce navigationError: ${forbiddenUrl}`);
      assert.notEqual(state.activeUrl, forbiddenUrl, `Active URL must never become ${forbiddenUrl}`);
    }

    assert.ok(
      controller.getState().networkPolicyWarnings.length >= 3,
      "Blocked manual destinations must surface network-policy warnings"
    );
  });

  test("6. Untrusted workspaces block manual browser controls before acquiring or starting any session", async () => {
    workspaceTrusted = false;
    controller.openOrRevealPanel();

    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/safe",
    });

    assert.equal(acquireCount, 0, "Untrusted workspace must NOT acquire or create BrowserSessionManager");
    assert.match(controller.getState().navigationError || "", /untrusted workspaces/i);
  });

  test("7. Read-only modes (ASK / PLAN) allow observation but deny manual interactive/side-effect/sensitive actions", async () => {
    currentMode = "PLAN";
    currentModeLabel = "Browser QA — Local Development (PLAN)";
    controller.openOrRevealPanel();

    // Inspection (`browser_open`) is permitted in PLAN mode
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/readonly",
    });
    assert.equal(controller.getState().activeUrl, "http://127.0.0.1:4173/readonly");

    // Interactive/side-effect/sensitive manual controls are DENIED by PermissionGate in PLAN mode
    await controller.handleMessage({
      type: "browserPanel.navigate",
      url: "http://127.0.0.1:4173/other",
    });
    assert.match(controller.getState().navigationError || "", /Permission policy denied/i);

    await controller.handleMessage({ type: "browserPanel.clickSelected", refId: "e2" });
    assert.equal(mockSession!.getClickExecutedCount(), 0, "Click must not execute in PLAN mode");

    await controller.handleMessage({ type: "browserPanel.fillSelected", refId: "e1", value: "secret123" });
    assert.equal(mockSession!.getFillExecutedCount(), 0, "Fill must not execute in PLAN mode");
    assert.ok(
      controller.getState().timeline.some((t) => t.eventType === "action_denied" && t.origin === "user"),
      "Denied manual action must appear in timeline with origin=user"
    );
  });

  test("8. Manual side-effect/sensitive actions require confirmation in BUILD mode and block live DOM risk escalation on revalidation", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/checkout",
    });

    // 8a: Rejecting confirmation blocks click
    approvalCallback = async () => "REJECT";
    await controller.handleMessage({ type: "browserPanel.clickSelected", refId: "e2" });
    assert.equal(mockSession!.getClickExecutedCount(), 0, "Rejected confirmation must not click");

    // 8b: Live target mutates from "Submit Order" to destructive "Delete Account Forever" DURING user confirmation!
    approvalCallback = async () => {
      mockSession!.mutateLiveButton("Delete Account Forever", "/delete-everything");
      return "APPROVE";
    };
    await controller.handleMessage({ type: "browserPanel.clickSelected", refId: "e2" });
    assert.equal(
      mockSession!.getClickExecutedCount(),
      0,
      "revalidateApproval must block click when live target escalated to DESTRUCTIVE"
    );
    assert.match(controller.getState().navigationError || "", /ACTION_RISK_ESCALATED/);
  });

  test("9. Zero credential, token, cookie, or sensitive field value leakage across panel state, timeline & Sprint 9D journal", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({ type: "browserPanel.toggleEvidenceRecording", enabled: true });

    const secretUrl =
      "http://127.0.0.1:4173/auth?token=TopSecretUrlToken999&api_key=MyRawApiKey777#access_token=OAuthHashSecret555";
    await controller.handleMessage({ type: "browserPanel.openUrl", url: secretUrl });

    mockSession!.emit("console_message", {
      type: "error",
      text: "Leak check: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig Cookie: sid=RawCookieVal888 ovsc_sess_112233445566 AKIAIOSFODNN7EXAMPLE sk-abcdefghijklmnopqrstuvwxyz1234",
    });

    const serialized = JSON.stringify(controller.getState());
    for (const forbiddenSecret of [
      "TopSecretUrlToken999",
      "MyRawApiKey777",
      "OAuthHashSecret555",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "RawCookieVal888",
      "ovsc_sess_112233445566",
      "AKIAIOSFODNN7EXAMPLE",
      "sk-abcdefghijklmnopqrstuvwxyz1234",
    ]) {
      assert.equal(
        serialized.includes(forbiddenSecret),
        false,
        `Secret "${forbiddenSecret}" must NEVER appear in serialized BrowserPanelState`
      );
    }

    const journal = new BoundedObservationJournal();
    journal.setRecordingEnabled(true);
    const fact = journal.recordFact({
      kind: "network_diagnostic",
      sessionId: "s_sec",
      url: "http://admin:SuperPass123@127.0.0.1:4173/api?secret=HiddenQuerySecret",
      summary: "Header Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aa.bb",
    });
    assert.ok(fact, "Fact recorded when opt-in journal enabled");
    assert.equal(fact!.responseBodyRecorded, false);
    assert.equal(fact!.credentialsRecorded, false);
    assert.equal(fact!.browserStorageRecorded, false);
    assert.equal(JSON.stringify(fact).includes("SuperPass123"), false, "Basic auth password redacted");
    assert.equal(JSON.stringify(fact).includes("HiddenQuerySecret"), false, "Query secret redacted");
  });

  test("10. Refuses cross-workspace and cross-account BrowserSessionManager attachment", () => {
    const otherWorkspaceDir = path.join(tmpDir, "workspace-other");
    fs.mkdirSync(otherWorkspaceDir, { recursive: true });

    const wrongWorkspaceMgr = new BrowserSessionManager({
      workspaceRoot: otherWorkspaceDir,
      accountId: currentAccountId,
      executablePath: fakeBrowserExec,
      networkPolicy: { allowedOrigins: ["http://127.0.0.1:4173"] },
    });
    controller.attachSession(wrongWorkspaceMgr);
    assert.equal(
      controller.getObservedSessionManager(),
      undefined,
      "Must refuse session manager belonging to a different workspaceRoot"
    );

    const wrongAccountMgr = new BrowserSessionManager({
      workspaceRoot,
      accountId: "acct_intruder",
      executablePath: fakeBrowserExec,
      networkPolicy: { allowedOrigins: ["http://127.0.0.1:4173"] },
    });
    controller.attachSession(wrongAccountMgr);
    assert.equal(
      controller.getObservedSessionManager(),
      undefined,
      "Must refuse session manager belonging to a different accountId"
    );
  });

  test("11. Enforces outside-repository screenshot artifact paths (UNSAFE_ARTIFACT_PATH)", async () => {
    assert.throws(
      () =>
        new BrowserPanelController({
          artifactRootPath: path.join(workspaceRoot, ".leaked-screenshots"),
          getEnvironment: () => ({
            workspaceRoot,
            workspaceName: "workspace-sec",
            workspaceTrusted: true,
            activeMode: "BUILD",
            activeModeLabel: "BUILD",
            allowedOrigins: ["http://127.0.0.1:4173"],
            identity: { accountId: "a1", displayLabel: "a1", authenticated: true },
          }),
          acquireSessionManager: () => undefined,
          confirmationBridge: {
            requestConfirmation: async () => "REJECT",
            confirmSessionClose: async () => true,
          },
          createViewAdapter: () => view,
        }),
      /UNSAFE_ARTIFACT_PATH/,
      "Controller must reject artifactRootPath inside workspaceRoot"
    );

    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/safe",
    });

    await assert.rejects(
      () =>
        activeManager!.screenshot({
          outputPath: path.join(workspaceRoot, "accidental-leak.png"),
        }),
      (err: any) => err instanceof BrowserSessionError && err.code === "UNSAFE_ARTIFACT_PATH",
      "BrowserSessionManager.screenshot must block writing inside workspaceRoot unless allowWorkspaceExport=true"
    );
  });

  test("12. Extension wiring registers open-vs-code.openBrowserPanel without starting Chromium and invalidates on workspace change", async () => {
    let workspaceChangeListener: (() => void) | undefined;
    let webviewPanelsCreated = 0;

    const mockVscode: any = {
      ViewColumn: { Beside: 2 },
      window: {
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
        activeTextEditor: null,
        visibleTextEditors: [],
        showErrorMessage: () => {},
        showInformationMessage: () => {},
        showWarningMessage: async () => "Approve",
        showInputBox: async () => "",
        withProgress: async (_opts: any, task: any) =>
          task({ report: () => {} }, { onCancellationRequested: () => {} }),
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
        onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
        registerWebviewViewProvider: () => ({ dispose: () => {} }),
        createWebviewPanel: () => {
          webviewPanelsCreated += 1;
          return {
            visible: true,
            webview: {
              cspSource: "vscode-webview-resource:",
              html: "",
              postMessage: async () => true,
              asWebviewUri: (u: any) => u,
              onDidReceiveMessage: () => ({ dispose: () => {} }),
            },
            reveal: () => {},
            onDidChangeViewState: () => ({ dispose: () => {} }),
            onDidDispose: () => ({ dispose: () => {} }),
            dispose: () => {},
          };
        },
      },
      workspace: {
        workspaceFolders: [
          { uri: { fsPath: workspaceRoot, toString: () => `file://${workspaceRoot}` }, name: "workspace-sec" },
        ],
        isTrusted: true,
        getConfiguration: () => ({ get: (_k: string, fb: unknown) => fb }),
        getWorkspaceFolder: () => null,
        asRelativePath: () => "f.ts",
        findFiles: async () => [],
        onDidChangeWorkspaceFolders: (cb: () => void) => {
          workspaceChangeListener = cb;
          return { dispose: () => {} };
        },
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
      Uri: {
        file: (s: string) => ({ path: s, fsPath: s, toString: () => `vscode-webview-resource://file${s}` }),
        joinPath: (base: any, ...parts: string[]) => {
          const joined = path.join(base.fsPath, ...parts);
          return { path: joined, fsPath: joined, toString: () => `file://${joined}` };
        },
      },
      languages: {
        onDidChangeDiagnostics: () => ({ dispose: () => {} }),
        getDiagnostics: () => [],
        registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
      },
      commands: {
        registered: {} as Record<string, (...args: any[]) => any>,
        registerCommand: (id: string, cb: (...args: any[]) => any) => {
          mockVscode.commands.registered[id] = cb;
          return { dispose: () => {} };
        },
        executeCommand: async () => {},
      },
      ProgressLocation: { Notification: 15 },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    };

    const origResolve = (Module as any)._resolveFilename;
    const origRequire = (Module as any).prototype.require;
    (Module as any)._resolveFilename = function (req: string) {
      if (req === "vscode") return "vscode";
      return origResolve.apply(this, arguments);
    };
    (Module as any).prototype.require = function (id: string) {
      if (id === "vscode") return mockVscode;
      return origRequire.apply(this, arguments);
    };

    try {
      const extPath = require.resolve("../src/extension.ts");
      delete require.cache[extPath];
      const ext = require("../src/extension.ts");
      const extStorageDir = path.join(tmpDir, "ext-global-storage");
      ext.activate({
        subscriptions: [],
        extensionUri: { fsPath: workspaceRoot, path: workspaceRoot },
        globalStorageUri: { fsPath: extStorageDir, path: extStorageDir },
      });

      assert.equal(
        typeof mockVscode.commands.registered["open-vs-code.openBrowserPanel"],
        "function",
        "Extension must register open-vs-code.openBrowserPanel command"
      );

      await mockVscode.commands.registered["open-vs-code.openBrowserPanel"]();
      assert.equal(webviewPanelsCreated, 1, "Opening panel creates WebviewPanel");
      assert.equal(
        ext._testSeam.browserPanelController.getObservedSessionManager(),
        undefined,
        "Opening panel via command must NOT create or start a BrowserSessionManager"
      );

      workspaceChangeListener?.();
      assert.match(
        ext._testSeam.browserPanelController.getState().statusNotice || "",
        /Workspace folder changed/i
      );

      ext.deactivate();
    } finally {
      (Module as any)._resolveFilename = origResolve;
      (Module as any).prototype.require = origRequire;
    }
  });
});
