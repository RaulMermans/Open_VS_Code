import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BROWSER_VIEWPORT_PRESETS,
  BoundedObservationJournal,
  BrowserSessionManager,
  type AgentMode,
  type BrowserEvent,
  type BrowserEventType,
} from "@open-vs-code/agent-core";
import {
  BrowserPanelController,
  type BrowserPanelState,
  type BrowserPanelViewAdapter,
  type BrowserWorkspaceEnvironment,
  type InboundBrowserPanelMessage,
  canHighlightSelectedElementBounds,
  renderBrowserInspector,
  renderBrowserObservationPrep,
  renderBrowserScreenshotPreview,
  renderBrowserStatusHeader,
  renderBrowserTimeline,
} from "../src/browser/index.ts";
import { FakeDomDocument, FakeDomElement } from "./helpers/browser-panel-dom-harness.ts";

// Minimal 1x1 valid PNG (68 bytes, width=1280, height=800 patched in IHDR for realism)
function makeFakePngBuffer(width = 1280, height = 800, seedByte = 0x11): Buffer {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex"
  );
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[png.length - 5] = seedByte;
  return png;
}

class FakePanelView implements BrowserPanelViewAdapter {
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

  public hide(): void {
    this.isVisible = false;
    this.onVisibilityChanged(false);
  }

  public show(): void {
    this.isVisible = true;
    this.onVisibilityChanged(true);
  }

  public closeUserTab(): void {
    this.isOpen = false;
    this.isVisible = false;
    this.onPanelClosed();
  }

  public dispose(): void {
    this.isOpen = false;
    this.isVisible = false;
  }
}

/**
 * Controllable BrowserSessionManager double that exercises real BrowserEvent subscriptions,
 * snapshot freshness, viewport state, and PNG file output without launching OS Chromium.
 */
function attachMockPageToManager(
  manager: BrowserSessionManager,
  initialUrl = "http://127.0.0.1:4173/dashboard",
  initialTitle = "Local Dev Dashboard"
) {
  let pageUrl = initialUrl;
  let pageTitle = initialTitle;
  let screenshotCounter = 0;
  let domMutatedLabel = "Submit Order";
  let navDelayMs = 0;
  let simulateTimeout = false;

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

  const emitRaw = (
    type: BrowserEventType,
    details: Record<string, unknown>,
    origin?: "agent" | "user" | "system",
    taskId?: string
  ) => {
    const inherited = corrStack[corrStack.length - 1];
    const effectiveOrigin = origin ?? inherited?.origin;
    const effectiveTaskId = taskId ?? inherited?.taskId;
    const ev: BrowserEvent = {
      type,
      sessionId: manager.getSessionId(),
      timestamp: Date.now(),
      details,
      ...(effectiveOrigin
        ? { correlation: { origin: effectiveOrigin, ...(effectiveTaskId ? { taskId: effectiveTaskId } : {}) } }
        : {}),
    };
    for (const cb of (manager as any).__testListeners ?? []) {
      cb(ev);
    }
  };

  const origOnEvent = manager.onEvent.bind(manager);
  (manager as any).__testListeners = new Set<(e: BrowserEvent) => void>();
  manager.onEvent = (listener) => {
    (manager as any).__testListeners.add(listener);
    const unsub = origOnEvent(listener);
    return () => {
      (manager as any).__testListeners.delete(listener);
      unsub();
    };
  };

  const fakePage: any = {
    isClosed: () => false,
    url: () => pageUrl,
    title: async () => pageTitle,
    setViewportSize: async () => {},
    evaluate: async (fn: any, arg?: any) => {
      // Distinguish snapshot, screenshot mask, design probe, and animation probe
      if (typeof arg === "string" && arg.startsWith("ovsc-mask-")) {
        return 1; // 1 masked password field
      }
      if (arg && typeof arg === "object" && "snapId" in arg && !("ref" in arg)) {
        const vp = manager.getViewport();
        return [
          {
            tag: "input",
            role: "textbox",
            name: "Search Query",
            selector: "#q",
            value: "hello",
            inputType: "text",
            href: "",
            formAction: "/search",
            parentSignature: "form#f1|form#f1:/search",
            hasValue: true,
            isSensitive: false,
            bounds: { x: 24, y: 40, width: 280, height: 36, viewportWidth: vp.width, viewportHeight: vp.height },
            interactiveState: { disabled: false, readonly: false, required: false, focused: true, editable: true },
          },
          {
            tag: "input",
            role: "textbox",
            name: "API Secret Token",
            selector: "#api_token",
            inputType: "password",
            href: "",
            formAction: "/search",
            parentSignature: "form#f1|form#f1:/search",
            hasValue: true,
            isSensitive: true,
            bounds: { x: 24, y: 92, width: 280, height: 36, viewportWidth: vp.width, viewportHeight: vp.height },
            interactiveState: { disabled: false, readonly: false, required: true, focused: false, editable: true },
          },
          {
            tag: "button",
            role: "button",
            name: domMutatedLabel,
            selector: "#submit-btn",
            inputType: "submit",
            href: "",
            formAction: "/orders",
            parentSignature: "form#f1|form#f1:/orders",
            isSensitive: false,
            bounds: { x: 24, y: 148, width: 140, height: 40, viewportWidth: vp.width, viewportHeight: vp.height },
            interactiveState: { disabled: false, readonly: false, required: false, focused: false, editable: false },
          },
        ];
      }
      if (arg && typeof arg === "object" && "ref" in arg) {
        const vp = manager.getViewport();
        return {
          bounds: { x: 24, y: 148, width: 140, height: 40, viewportWidth: vp.width, viewportHeight: vp.height },
          typography: {
            fontFamily: "Inter, sans-serif",
            fontSize: "14px",
            fontWeight: "600",
            lineHeight: "20px",
            letterSpacing: "0px",
            color: "rgb(255, 255, 255)",
            textAlign: "center",
          },
          spacing: {
            marginTop: "8px",
            marginRight: "0px",
            marginBottom: "0px",
            marginLeft: "0px",
            paddingTop: "8px",
            paddingRight: "16px",
            paddingBottom: "8px",
            paddingLeft: "16px",
            gap: "6px",
          },
          layout: {
            display: "inline-flex",
            position: "relative",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgb(0, 127, 212)",
            borderRadius: "4px",
            opacity: "1",
            overflow: "visible",
          },
        };
      }
      // Animation probe or live target check
      const fnSrc = String(fn);
      if (fnSrc.includes("prefers-reduced-motion")) {
        return {
          reducedMotion: false,
          total: 2,
          samples: [
            {
              tag: "button",
              role: "button",
              accessibleName: "Submit Order",
              animationName: "none",
              animationDuration: "0s",
              transitionProperty: "background-color",
              transitionDuration: "0.15s",
              prefersReducedMotionActive: false,
            },
          ],
        };
      }
      // Live target validation inside click/fill
      return {
        tag: "button",
        role: "button",
        name: domMutatedLabel,
        inputType: "submit",
        href: "",
        formAction: "/orders",
        parentSignature: "form#f1|form#f1:/orders",
        isConnected: true,
      };
    },
    locator: () => ({
      count: async () => 1,
      first: () => ({
        evaluate: async () => ({
          tag: "button",
          role: "button",
          name: domMutatedLabel,
          inputType: "submit",
          href: "",
          formAction: "/orders",
          parentSignature: "form#f1|form#f1:/orders",
          isConnected: true,
        }),
      }),
      click: async () => {},
      fill: async () => {},
    }),
    screenshot: async () => {
      screenshotCounter += 1;
      const vp = manager.getViewport();
      return makeFakePngBuffer(vp.width, vp.height, screenshotCounter & 0xff);
    },
    goto: async (targetUrl: string) => {
      if (simulateTimeout) {
        const err = new Error("page.goto: Timeout 5000ms exceeded");
        err.name = "TimeoutError";
        throw err;
      }
      if (navDelayMs > 0) {
        await new Promise((r) => setTimeout(r, navDelayMs));
      }
      pageUrl = targetUrl;
      pageTitle = `Page ${new URL(targetUrl).pathname}`;
    },
    close: async () => {},
  };

  // Override start() on this mock instance so tests run inside standard sandbox without Chromium binary launch
  let started = false;
  manager.start = async () => {
    if (!started) {
      started = true;
      emitRaw("session_started", {
        platform: process.platform,
        browserPid: 42424,
        verificationMethod: "mock_seatbelt",
      });
    }
  };
  manager.getActivePage = () => (started && manager.getStatus() !== "CLOSED" ? fakePage : undefined);

  // Hook open/navigate onto fakePage while preserving BrowserSessionManager's real snapshot/screenshot/revalidate logic!
  const origSnapshot = manager.snapshot.bind(manager);
  const origScreenshot = manager.screenshot.bind(manager);

  // Inject private #activePage via prototype/open shim by overriding open & navigate cleanly
  let statusOverride: ReturnType<BrowserSessionManager["getStatus"]> = "UNINITIALIZED";
  const origGetStatus = manager.getStatus.bind(manager);
  manager.getStatus = () => {
    const base = origGetStatus();
    if (base === "ERROR") return base;
    return statusOverride;
  };
  manager.getCurrentUrl = () => (statusOverride === "CLOSED" || !started ? "" : pageUrl);
  manager.getCurrentTitle = () => (statusOverride === "CLOSED" || !started ? "" : pageTitle);

  manager.open = async (url: string, signal?: AbortSignal) => {
    await manager.start(signal);
    emitRaw("navigation_attempted", { url });
    const allowed = manager.getNetworkPolicyConfig().allowedOrigins;
    const u = new URL(url);
    if (!allowed.includes(u.origin)) {
      const reason = `Origin ${u.origin} is not in allowedOrigins`;
      emitRaw("network_policy_denied", { url, method: "NAVIGATE", error: reason });
      emitRaw("navigation_failed", { url, reason });
      throw new Error(reason);
    }
    statusOverride = "NAVIGATING";
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          emitRaw("cancellation", { action: "open", url });
          reject(new DOMException("Navigation cancelled", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        fakePage
          .goto(url)
          .then(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          })
          .catch((e: any) => {
            signal?.removeEventListener("abort", onAbort);
            reject(e);
          });
      });
      statusOverride = "READY";
      emitRaw("navigation_completed", { url: pageUrl, title: pageTitle });
      return { pageId: "page_main", url: pageUrl, title: pageTitle };
    } catch (err: any) {
      statusOverride = "READY";
      if (err?.name === "TimeoutError") {
        emitRaw("timeout", { action: "open", url, error: err.message });
      }
      if (err?.name !== "AbortError") {
        emitRaw("navigation_failed", { url, error: err?.message || String(err) });
      }
      throw err;
    }
  };

  manager.navigate = async (url: string, signal?: AbortSignal) => {
    const res = await manager.open(url, signal);
    return { url: res.url, title: res.title };
  };

  // Delegate snapshot/screenshot/design/animations by setting fakePage on a lightweight internal wrapper
  let currentSnap: Awaited<ReturnType<typeof origSnapshot>> | undefined;
  manager.snapshot = async () => {
    const vp = manager.getViewport();
    const rawEls = await fakePage.evaluate(() => {}, { snapId: "snap_test_1", sessId: manager.getSessionId() });
    const snapId = `snap_${++screenshotCounter}_${Date.now()}`;
    const elements = rawEls.map((r: any, idx: number) => ({
      refId: `e${idx + 1}`,
      role: r.role,
      name: r.name,
      selector: r.selector,
      snapshotId: snapId,
      tag: r.tag,
      ...(r.isSensitive ? {} : r.value ? { value: r.value } : {}),
      sensitive: Boolean(r.isSensitive),
      destructive: String(r.name).toLowerCase().includes("delete"),
      sideEffect: String(r.name).toLowerCase().includes("submit"),
      targetFingerprint: `fp_${snapId}_e${idx + 1}_${r.name}`,
      inputType: r.inputType,
      href: r.href,
      formAction: r.formAction,
      parentSignature: r.parentSignature,
      bounds: r.bounds,
      interactiveState: r.interactiveState,
    }));
    const tree = [
      `Page: "${pageTitle}" (${pageUrl})`,
      ...elements.map((e: any) => `  [ref=${e.refId}] <${e.tag}> ${e.role} "${e.name}"`),
    ].join("\n");
    currentSnap = {
      snapshotId: snapId,
      url: pageUrl,
      title: pageTitle,
      tree,
      elements,
      elementCount: elements.length,
      truncated: false,
      bytes: Buffer.byteLength(tree, "utf8"),
      capturedAt: Date.now(),
      viewport: vp,
    };
    emitRaw("snapshot_taken", {
      snapshotId: snapId,
      url: pageUrl,
      elementCount: elements.length,
      bytes: currentSnap.bytes,
      truncated: false,
    });
    return currentSnap;
  };
  manager.getLatestSnapshot = () => currentSnap;
  manager.getActiveSnapshotId = () => currentSnap?.snapshotId;
  manager.isSnapshotFresh = (id?: string) =>
    Boolean(currentSnap && (!id || id === currentSnap.snapshotId) && statusOverride === "READY");
  manager.getElementRef = (refId: string) => currentSnap?.elements.find((e) => e.refId === refId);

  manager.screenshot = async (opts) => {
    const buf = await fakePage.screenshot();
    if (opts?.outputPath) {
      const resolved = path.resolve(opts.outputPath);
      const ws = path.resolve(manager.getWorkspaceRoot());
      if (!opts.allowWorkspaceExport && (resolved === ws || resolved.startsWith(ws + path.sep))) {
        throw new Error("UNSAFE_ARTIFACT_PATH: Cannot write screenshot inside workspaceRoot");
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
      fs.writeFileSync(resolved, buf, { mode: 0o600 });
    }
    const vp = manager.getViewport();
    const res = {
      bytes: buf.length,
      mimeType: "image/png" as const,
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      capturedAt: Date.now(),
      url: pageUrl,
      pageTitle,
      viewport: vp,
      snapshotId: currentSnap?.snapshotId,
      maskedSensitiveFields: 1,
      ...(opts?.outputPath ? { filePath: path.resolve(opts.outputPath) } : {}),
      ...(!opts?.omitBase64 ? { base64: buf.toString("base64") } : {}),
    };
    emitRaw("screenshot_taken", {
      bytes: res.bytes,
      width: res.width,
      height: res.height,
      url: pageUrl,
      snapshotId: currentSnap?.snapshotId,
      maskedSensitiveFields: 1,
    });
    return res;
  };

  manager.inspectElementDesign = async (refId: string) => {
    if (!currentSnap || !manager.isSnapshotFresh(currentSnap.snapshotId)) {
      throw new Error("[STALE_ELEMENT_REFERENCE] Snapshot is stale");
    }
    const el = currentSnap.elements.find((e) => e.refId === refId);
    if (!el) throw new Error("[STALE_ELEMENT_REFERENCE] Unknown element");
    const raw = await fakePage.evaluate(() => {}, { ref: refId });
    return {
      sessionId: manager.getSessionId(),
      snapshotId: currentSnap.snapshotId,
      refId,
      url: pageUrl,
      viewport: manager.getViewport(),
      presetId: "desktop",
      capturedAt: Date.now(),
      role: el.role,
      tag: el.tag,
      accessibleName: el.name,
      bounds: raw.bounds,
      typography: raw.typography,
      spacing: raw.spacing,
      layout: raw.layout,
    };
  };

  manager.observeAnimations = async () => ({
    sessionId: manager.getSessionId(),
    url: pageUrl,
    viewport: manager.getViewport(),
    capturedAt: Date.now(),
    evidenceKind: "static_css_declaration_probe",
    prefersReducedMotion: false,
    animatedElementCount: 2,
    samples: [
      {
        tag: "button",
        role: "button",
        accessibleName: "Submit Order",
        animationName: "none",
        animationDuration: "0s",
        transitionProperty: "background-color",
        transitionDuration: "0.15s",
        prefersReducedMotionActive: false,
      },
    ],
    motionQualityClaimAllowed: false,
    limitationNotice:
      "Static screenshot preview and CSS declaration probe only; frame-rate, easing smoothness, and runtime motion quality cannot be claimed from static captures.",
  });

  const origSetViewport = manager.setViewport.bind(manager);
  manager.setViewport = async (dims) => {
    currentSnap = undefined;
    return origSetViewport(dims);
  };

  const origClose = manager.close.bind(manager);
  manager.close = async () => {
    started = false;
    statusOverride = "CLOSED";
    currentSnap = undefined;
    await origClose();
  };

  return {
    emitRaw,
    setNavDelay(ms: number) {
      navDelayMs = ms;
    },
    setSimulateTimeout(val: boolean) {
      simulateTimeout = val;
    },
    setMutatedButtonLabel(label: string) {
      domMutatedLabel = label;
    },
    simulateCrash() {
      statusOverride = "ERROR";
      currentSnap = undefined;
      emitRaw("browser_crashed", { reason: "renderer_process_killed" }, "system");
    },
    invalidateSnapshot() {
      currentSnap = undefined;
    },
    origScreenshot,
  };
}

describe("Sprint 9B — Visual Browser Panel, Inspector, Timeline & Observation UX", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let artifactRoot: string;
  let fakeBrowserExec: string;
  let view: FakePanelView;
  let acquireCount: number;
  let currentMode: AgentMode;
  let currentModeLabel: string;
  let currentAccountId: string;
  let currentWorkspace: string;
  let workspaceTrusted: boolean;
  let approvalDecision: "APPROVE" | "REJECT";
  let closeConfirmDecision: boolean;
  let confirmationPrompts: string[];
  let activeManager: BrowserSessionManager | undefined;
  let mockHarness: ReturnType<typeof attachMockPageToManager> | undefined;
  let controller: BrowserPanelController;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9b-panel-"));
    workspaceRoot = path.join(tmpDir, "workspace-alpha");
    artifactRoot = path.join(tmpDir, "outside-artifacts");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fakeBrowserExec = path.join(tmpDir, "fake-chromium");
    fs.writeFileSync(fakeBrowserExec, "#!/bin/sh\necho 'Chromium 156.0.0.0'\n", { mode: 0o755 });

    view = new FakePanelView();
    acquireCount = 0;
    currentMode = "BUILD";
    currentModeLabel = "Browser QA — Interactive Local Development (BUILD)";
    currentAccountId = "acct_alice";
    currentWorkspace = workspaceRoot;
    workspaceTrusted = true;
    approvalDecision = "APPROVE";
    closeConfirmDecision = true;
    confirmationPrompts = [];
    activeManager = undefined;
    mockHarness = undefined;

    const getEnvironment = (): BrowserWorkspaceEnvironment => ({
      workspaceRoot: currentWorkspace,
      workspaceName: path.basename(currentWorkspace),
      workspaceTrusted,
      activeMode: currentMode,
      activeModeLabel: currentModeLabel,
      allowedOrigins: ["http://127.0.0.1:4173"],
      executablePath: fakeBrowserExec,
      identity: {
        accountId: currentAccountId,
        displayLabel: currentAccountId === "anonymous" ? "Local anonymous" : "alice",
        authenticated: currentAccountId !== "anonymous",
      },
    });

    controller = new BrowserPanelController({
      artifactRootPath: artifactRoot,
      getEnvironment,
      acquireSessionManager: () => {
        acquireCount += 1;
        if (!activeManager) {
          activeManager = new BrowserSessionManager({
            workspaceRoot: currentWorkspace,
            accountId: currentAccountId,
            executablePath: fakeBrowserExec,
            networkPolicy: { allowedOrigins: ["http://127.0.0.1:4173"] },
          });
          mockHarness = attachMockPageToManager(activeManager);
        }
        return activeManager;
      },
      confirmationBridge: {
        requestConfirmation: async (prompt) => {
          confirmationPrompts.push(prompt);
          return approvalDecision;
        },
        confirmSessionClose: async () => closeConfirmDecision,
      },
      createViewAdapter: (callbacks) => {
        view.onMessage = callbacks.onMessage;
        view.onVisibilityChanged = callbacks.onVisibilityChanged;
        view.onPanelClosed = callbacks.onPanelClosed;
        return view;
      },
      maxTimelineItems: 25,
      maxRetainedScreenshots: 4,
      minPreviewIntervalMs: 500,
    });
  });

  afterEach(async () => {
    controller.dispose();
    if (activeManager) {
      await activeManager.dispose();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("1. Opening the Browser Panel never creates or launches a browser session", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({ type: "browserPanel.ready" });

    assert.equal(acquireCount, 0, "Panel open must NOT invoke acquireSessionManager");
    assert.equal(controller.getObservedSessionManager(), undefined);
    const state = controller.getState();
    assert.equal(state.hasActiveSession, false);
    assert.equal(state.sessionStatus, "DISCONNECTED");
    assert.equal(state.workspaceName, "workspace-alpha");
    assert.equal(state.identity.displayLabel, "alice");
    assert.equal(state.provisioning.status, "READY");
  });

  test("2. Renders disconnected state and NOT_CONFIGURED provisioning diagnostics cleanly", () => {
    fakeBrowserExec = path.join(tmpDir, "missing-chromium-binary");
    controller.openOrRevealPanel();
    const state = controller.getState();

    const doc = new FakeDomDocument();
    const header = new FakeDomElement("header");
    const preview = new FakeDomElement("section");
    renderBrowserStatusHeader(header, state, doc);
    renderBrowserScreenshotPreview(preview, state, doc);

    assert.ok(header.textContent.includes("DISCONNECTED"));
    assert.ok(header.textContent.includes("workspace-alpha"));
    assert.ok(header.textContent.includes("Identity: alice"));
    assert.ok(preview.textContent.includes("Browser session has not been started."));
  });

  test("3. Renders active session, URL, page title, identity, and file-backed screenshot preview", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/orders",
    });

    assert.equal(acquireCount, 1);
    const state = controller.getState();
    assert.equal(state.hasActiveSession, true);
    assert.equal(state.sessionStatus, "READY");
    assert.equal(state.activeUrl, "http://127.0.0.1:4173/orders");
    assert.equal(state.pageTitle, "Page /orders");
    assert.ok(state.identity.sessionId, "Session ID must be shown on read-only identity badge");

    // Screenshot stored on disk OUTSIDE workspaceRoot, served via webview resource URI
    assert.ok(state.screenshot);
    assert.ok(state.screenshot.webviewUri.startsWith("vscode-webview-resource://"));
    assert.equal(state.screenshot.width, 1280);
    assert.equal(state.screenshot.height, 800);
    assert.equal(state.screenshot.stale, false);
    assert.equal(fs.readdirSync(workspaceRoot).length, 0, "Zero screenshot artifacts inside workspaceRoot");

    const doc = new FakeDomDocument();
    const previewContainer = new FakeDomElement("section");
    renderBrowserScreenshotPreview(previewContainer, state, doc);
    const imgs = previewContainer.findAll((el) => el.tagName === "img");
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0]!.getAttribute("src"), state.screenshot.webviewUri);
  });

  test("4. Supports zoom-to-fit, actual-size (1:1), and Desktop/Tablet/Mobile viewport presets", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/responsive",
    });

    await controller.handleMessage({ type: "browserPanel.setZoomMode", zoomMode: "actual" });
    assert.equal(controller.getState().zoomMode, "actual");

    await controller.handleMessage({
      type: "browserPanel.setViewportPreset",
      presetId: "mobile",
    });
    const mobileState = controller.getState();
    assert.equal(mobileState.viewportPreset, "mobile");
    assert.deepEqual(mobileState.viewport, {
      width: BROWSER_VIEWPORT_PRESETS.mobile.width,
      height: BROWSER_VIEWPORT_PRESETS.mobile.height,
    });
    assert.equal(mobileState.screenshot?.width, 390);
    assert.equal(mobileState.screenshot?.height, 844);

    await controller.handleMessage({
      type: "browserPanel.setViewportPreset",
      presetId: "tablet",
    });
    assert.equal(controller.getState().viewportPreset, "tablet");
    assert.deepEqual(controller.getState().viewport, { width: 768, height: 1024 });
  });

  test("5. Accessibility inspector renders elements, interactive states, warnings, selection & bounding-box highlight", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/checkout",
    });

    await controller.handleMessage({ type: "browserPanel.selectElement", refId: "e3" });
    const state = controller.getState();
    assert.equal(state.selectedRefId, "e3");
    assert.ok(state.snapshot);
    assert.equal(state.snapshot.elementCount, 3);

    const secretInput = state.snapshot.elements.find((e) => e.refId === "e2")!;
    assert.ok(secretInput.warnings.includes("sensitive"));
    assert.equal(secretInput.valuePreview, undefined, "Sensitive input value must never appear in inspector");

    const submitBtn = state.snapshot.elements.find((e) => e.refId === "e3")!;
    assert.ok(submitBtn.warnings.includes("side_effect"));
    assert.deepEqual(submitBtn.bounds, {
      x: 24,
      y: 148,
      width: 140,
      height: 40,
      viewportWidth: 1280,
      viewportHeight: 800,
    });

    const highlight = canHighlightSelectedElementBounds(state);
    assert.equal(highlight.allowed, true);

    const doc = new FakeDomDocument();
    const previewEl = new FakeDomElement("section");
    const inspectorEl = new FakeDomElement("div");
    renderBrowserScreenshotPreview(previewEl, state, doc);
    renderBrowserInspector(inspectorEl, state, undefined, doc);

    const overlays = previewEl.findAll((el) => el.getAttribute("data-highlight-ref") === "e3");
    assert.equal(overlays.length, 1, "Selected element geometry must render highlight overlay on matching screenshot");
    assert.ok(inspectorEl.textContent.includes("Selected [e3] button <button> — Submit Order"));
  });

  test("6. Stale snapshot disables element action buttons in UI and blocks execution until refreshed", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/form",
    });
    await controller.handleMessage({ type: "browserPanel.selectElement", refId: "e3" });

    // Invalidate live snapshot (e.g. DOM/route changed)
    mockHarness!.invalidateSnapshot();
    const staleState = controller.getState();
    assert.equal(staleState.snapshot?.stale, true);
    assert.equal(canHighlightSelectedElementBounds(staleState).allowed, false, "Stale snapshot must not highlight outdated geometry");

    const doc = new FakeDomDocument();
    const inspectorEl = new FakeDomElement("div");
    renderBrowserInspector(inspectorEl, staleState, undefined, doc);
    const clickBtns = inspectorEl.findAll((el) => el.getAttribute("data-action") === "click-selected");
    assert.equal(clickBtns.length, 1);
    assert.equal(clickBtns[0]!.disabled, true, "Click button must be disabled when snapshot is stale");

    // Attempting manual click anyway fails closed with STALE_ELEMENT_REFERENCE
    await controller.handleMessage({ type: "browserPanel.clickSelected", refId: "e3" });
    assert.match(controller.getState().navigationError || "", /STALE_ELEMENT_REFERENCE/);
  });

  test("7. Timeline records bounded ordered events, differentiates AGENT vs USER actions, and links taskId/confirmationId", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/app",
    });

    // Simulate agent-correlated events on the same session
    mockHarness!.emitRaw(
      "approval_requested",
      { tool: "browser_click", action: "browser_side_effect", target: "Submit Order", confirmationId: "conf_99" },
      "agent",
      "task_agent_42"
    );
    assert.equal(controller.getState().pendingApproval?.confirmationId, "conf_99");
    assert.equal(controller.getState().pendingApproval?.origin, "agent");

    mockHarness!.emitRaw(
      "approval_resolved",
      { tool: "browser_click", approved: false, reason: "USER_REJECTED", confirmationId: "conf_99" },
      "agent",
      "task_agent_42"
    );
    mockHarness!.emitRaw(
      "action_denied",
      { tool: "browser_click", reason: "USER_REJECTED", target: "Submit Order" },
      "agent",
      "task_agent_42"
    );

    const state = controller.getState();
    assert.equal(state.pendingApproval, undefined);
    assert.ok(state.timeline.some((t) => t.origin === "user" && t.eventType === "navigation_completed"));
    assert.ok(
      state.timeline.some(
        (t) => t.origin === "agent" && t.taskId === "task_agent_42" && t.confirmationId === "conf_99"
      )
    );

    // Emit 40 more events and verify timeline stays strictly bounded at maxTimelineItems (25)
    for (let i = 0; i < 40; i++) {
      mockHarness!.emitRaw("tool_invoked", { tool: "browser_snapshot", target: `step_${i}` }, "agent");
    }
    assert.equal(controller.getState().timeline.length, 25);

    const doc = new FakeDomDocument();
    const tlContainer = new FakeDomElement("div");
    renderBrowserTimeline(tlContainer, controller.getState().timeline, doc);
    assert.ok(tlContainer.textContent.includes("AGENT"));
  });

  test("8. Bounded screenshot ring buffer evicts oldest PNG files from disk automatically", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/gallery",
    });

    for (let i = 0; i < 6; i++) {
      await controller.handleMessage({ type: "browserPanel.captureScreenshot", fullPage: false });
    }

    const metrics = controller.getPerformanceMetrics();
    assert.equal(metrics.retainedScreenshotCount, 4, "Must cap retained screenshots at maxRetainedScreenshots=4");

    const sessionSubdir = path.join(artifactRoot, `sess_${activeManager!.getSessionId()}`);
    const filesOnDisk = fs.readdirSync(sessionSubdir).filter((f) => f.endsWith(".png"));
    assert.equal(filesOnDisk.length, 4, "Evicted screenshot files must be deleted from disk immediately");
  });

  test("9. Hidden panel pauses preview refreshes; revealing or reopening restores current session without launching second browser", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/home",
    });
    assert.equal(acquireCount, 1);

    // Hide panel and simulate agent navigation while hidden
    view.hide();
    await activeManager!.withCorrelation({ origin: "agent", taskId: "t_hidden" }, () =>
      activeManager!.navigate("http://127.0.0.1:4173/hidden-dest")
    );

    const hiddenMetrics = controller.getPerformanceMetrics();
    assert.ok(hiddenMetrics.skippedHiddenRefreshes >= 1, "Hidden panel must skip preview captures");
    assert.equal(controller.getState().screenshot?.stale, true, "Existing preview must be marked stale while hidden");

    // Close panel tab completely and reopen it
    view.closeUserTab();
    assert.equal(controller.isPanelOpen(), false);
    controller.openOrRevealPanel();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(acquireCount, 1, "Reopening panel must NOT create or launch a second browser");
    assert.equal(controller.getState().activeUrl, "http://127.0.0.1:4173/hidden-dest");
  });

  test("10. Handles browser crash, navigation timeout, and manual cancellation cleanly", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/start",
    });

    // 10a: Cancellation of slow navigation
    mockHarness!.setNavDelay(400);
    const navPromise = controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/slow",
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(controller.getState().activeOperationBusy, true);
    await controller.handleMessage({ type: "browserPanel.cancelOperation" });
    await navPromise;
    assert.equal(controller.getState().activeOperationBusy, false);
    assert.ok(controller.getState().timeline.some((t) => t.eventType === "cancellation"));

    // 10b: Navigation timeout
    mockHarness!.setNavDelay(0);
    mockHarness!.setSimulateTimeout(true);
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/timeout",
    });
    assert.ok(controller.getState().timeline.some((t) => t.eventType === "timeout"));
    mockHarness!.setSimulateTimeout(false);

    // 10c: Unexpected browser crash
    mockHarness!.simulateCrash();
    assert.equal(controller.getState().sessionStatus, "ERROR");
    assert.match(controller.getState().navigationError || "", /crashed unexpectedly/i);
    assert.ok(controller.getState().timeline.some((t) => t.eventType === "browser_crashed"));
  });

  test("11. Close session requires confirmation when active and cleans up temporary artifacts; workspace/account switch invalidates immediately", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/account",
    });
    assert.ok(controller.getPerformanceMetrics().retainedScreenshotCount >= 1);

    // Cancel close confirmation -> session remains READY
    closeConfirmDecision = false;
    await controller.handleMessage({ type: "browserPanel.closeSession" });
    assert.equal(controller.getState().sessionStatus, "READY");

    // Confirm close -> session closes and artifacts are deleted
    closeConfirmDecision = true;
    await controller.handleMessage({ type: "browserPanel.closeSession" });
    assert.equal(controller.getState().sessionStatus, "CLOSED");
    assert.equal(controller.getPerformanceMetrics().retainedScreenshotCount, 0);

    // Reopen and simulate workspace/account invalidation
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/account",
    });
    assert.ok(controller.getPerformanceMetrics().retainedScreenshotCount >= 1);

    currentAccountId = "acct_bob";
    controller.invalidateObservation("Account switched to bob.");
    assert.equal(controller.getState().hasActiveSession, false);
    assert.equal(controller.getState().timeline.length, 0);
    assert.equal(controller.getPerformanceMetrics().retainedScreenshotCount, 0);
  });

  test("12. Sprint 9C Design contracts: baseline pinning, before/after comparison, element typography/spacing, and non-claim motion probe", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:4173/design",
    });

    // Pin baseline
    await controller.handleMessage({ type: "browserPanel.captureBaseline" });
    assert.ok(controller.getState().visualBaseline);

    // Capture a new frame and compare
    await controller.handleMessage({ type: "browserPanel.captureScreenshot", fullPage: false });
    await controller.handleMessage({ type: "browserPanel.compareWithBaseline" });
    const cmp = controller.getState().visualComparison;
    assert.ok(cmp);
    assert.equal(cmp.sameOrigin, true);
    assert.equal(cmp.viewportMatch, true);
    assert.equal(cmp.identicalHash, false);

    // Inspect element typography & spacing
    await controller.handleMessage({ type: "browserPanel.selectElement", refId: "e3" });
    await controller.handleMessage({ type: "browserPanel.inspectElementDesign", refId: "e3" });
    const dm = controller.getState().selectedDesignMetadata;
    assert.ok(dm);
    assert.equal(dm.typography.fontSize, "14px");
    assert.equal(dm.layout.display, "inline-flex");

    // Probe CSS animations — must explicitly forbid motion quality claims from static probes!
    await controller.handleMessage({ type: "browserPanel.observeAnimations" });
    const anim = controller.getState().animationObservation;
    assert.ok(anim);
    assert.equal(anim.evidenceKind, "static_css_declaration_probe");
    assert.equal(anim.motionQualityClaimAllowed, false);

    const doc = new FakeDomDocument();
    const prepEl = new FakeDomElement("div");
    renderBrowserObservationPrep(prepEl, controller.getState(), doc);
    assert.ok(prepEl.textContent.includes("motionQualityClaimAllowed=false"));
  });

  test("13. Sprint 9D Reverse Engineering contracts: opt-in bounded journal separating Observed Facts, Inferred Behavior, and Unknown Details", async () => {
    const journal = new BoundedObservationJournal({ maxFacts: 5, maxInferences: 5, maxUnknowns: 5 });
    assert.equal(journal.isRecordingEnabled(), false, "Evidence recording must be OFF by default");
    assert.equal(
      journal.recordFact({ kind: "route_visited", sessionId: "s1", summary: "Ignored when off" }),
      null
    );

    journal.setRecordingEnabled(true);
    const f1 = journal.recordFact({
      kind: "route_visited",
      sessionId: "s1",
      origin: "user",
      url: "http://user:hunter2@127.0.0.1:4173/login?token=supersecret123",
      summary: "Visited login with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    });
    assert.ok(f1);
    assert.equal(f1.evidenceClass, "observed_fact");
    assert.equal(f1.responseBodyRecorded, false);
    assert.equal(f1.credentialsRecorded, false);
    assert.equal(f1.browserStorageRecorded, false);
    assert.ok(!f1.sanitizedUrl?.includes("hunter2"));
    assert.ok(!f1.sanitizedUrl?.includes("supersecret123"));
    assert.ok(!f1.summary.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));

    const inf = journal.recordInference({
      hypothesis: "Login form likely submits credentials to session endpoint",
      confidence: "medium",
      supportingFactIds: [f1.factId, "nonexistent_fact"],
    });
    assert.ok(inf);
    assert.equal(inf.evidenceClass, "inferred_behavior");
    assert.deepEqual(inf.supportingFactIds, [f1.factId]);

    const unk = journal.recordUnknown({
      area: "auth_mechanism",
      description: "Server-side password hashing and session store implementation",
      reasonUnobservable: "Backend source and network response bodies are not captured",
    });
    assert.ok(unk);
    assert.equal(unk.evidenceClass, "unknown_implementation_detail");

    // Verify bounded eviction
    for (let i = 0; i < 8; i++) {
      journal.recordFact({ kind: "visible_state_snapshot", sessionId: "s1", summary: `Snap ${i}` });
    }
    const snap = journal.snapshot();
    assert.equal(snap.retention.retainedFacts, 5);
    assert.ok(snap.retention.droppedFacts >= 4);
  });
});
