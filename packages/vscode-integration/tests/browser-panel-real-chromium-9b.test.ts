import { test, describe, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  BROWSER_QA_INTERACTIVE_PACK,
  BROWSER_QA_LOCAL_DEV_PACK,
  BrowserSessionManager,
  KNOWN_REPOSITORY_TOOL_ACTIONS,
  ScriptedModelProvider,
  detectBrowserProvisioning,
  resolveExecutionProfile,
  verifyEffectiveSandboxSupport,
  type AgentEvent,
} from "@open-vs-code/agent-core";
import { AgentSessionBridge, type IdeHost } from "@open-vs-code/ide-adapter";
import {
  BrowserPanelController,
  type BrowserPanelState,
  type BrowserPanelViewAdapter,
  type InboundBrowserPanelMessage,
} from "../src/browser/index.ts";

function closeHttpServer(srv?: http.Server): Promise<void> {
  return srv
    ? new Promise<void>((resolve) => {
        (srv as any).closeAllConnections?.();
        srv.close(() => resolve());
      })
    : Promise.resolve();
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class RealTestPanelView implements BrowserPanelViewAdapter {
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

  public closeTab(): void {
    this.isOpen = false;
    this.isVisible = false;
    this.onPanelClosed();
  }

  public dispose(): void {
    this.isOpen = false;
    this.isVisible = false;
  }
}

const chromiumSandbox = verifyEffectiveSandboxSupport();

describe("Sprint 9B — Real Chromium Agent/Browser Synchronization, Security & Performance Suite", {
  skip: process.env.CI === "true" && process.platform === "linux"
    ? false
    : chromiumSandbox.supported ? false : chromiumSandbox.details,
}, () => {
  let tmpRoot: string;
  let workspaceRoot: string;
  let artifactRoot: string;
  let appServer: http.Server;
  let appOrigin: string;
  let submittedOrders = 0;
  let deletedOrders = 0;
  let dynamicBtnClicked = 0;
  let lastCustomerNote = "";

  // Shared governed session + panel across synchronized scenarios
  let sessionManager: BrowserSessionManager;
  let panelView: RealTestPanelView;
  let controller: BrowserPanelController;
  let currentMode: "PLAN" | "BUILD" = "PLAN";
  let currentModeLabel = "Browser QA — Local Development (PLAN)";
  let hostConfirmationHandler: (prompt: string, payload: any) => Promise<"APPROVE" | "REJECT"> =
    async () => "APPROVE";

  before(async () => {
    const preflight = verifyEffectiveSandboxSupport();
    assert.equal(
      preflight.supported,
      true,
      `Real OS Chromium sandbox must be supported to run Sprint 9B real-browser acceptance: ${preflight.details}`
    );
    const prov = detectBrowserProvisioning();
    assert.equal(prov.status, "READY", "Operator-provisioned Chromium must be READY");

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9b-real-"));
    workspaceRoot = path.join(tmpRoot, "workspace-app");
    artifactRoot = path.join(tmpRoot, "outside-browser-artifacts");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Test App\n", "utf8");

    appServer = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://${req.headers.host}`);
      if (u.pathname === "/submit-order" && req.method === "POST") {
        submittedOrders += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, submittedOrders }));
        return;
      }
      if (u.pathname === "/delete-order" && req.method === "POST") {
        deletedOrders += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (u.pathname === "/settings") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head><title>Workspace Settings</title></head>
<body>
  <h1>Settings View</h1>
  <a id="back-link" href="/checkout">Back to Checkout</a>
</body>
</html>`);
        return;
      }

      // Default `/checkout` fixture with layout, CSS transition, sensitive password input, interactive controls
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Checkout QA Portal ?token=PortalQuerySecret777</title>
  <style>
    body { margin: 24px; font-family: sans-serif; background: #111827; color: #f9fafb; }
    #hero-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: 700;
      padding: 12px 20px;
      margin-top: 8px;
      border-radius: 6px;
      background: rgb(37, 99, 235);
      color: rgb(255, 255, 255);
      transition: background-color 0.2s ease-in-out;
      border: none;
    }
    .field-row { margin: 12px 0; }
  </style>
</head>
<body>
  <h1>Local Checkout QA</h1>
  <div class="field-row">
    <label for="customer-note">Delivery Note</label>
    <input id="customer-note" name="note" type="text" aria-label="Delivery Note" value="" oninput="window.__note = this.value" />
  </div>
  <div class="field-row">
    <label for="api-secret">Payment Secret Password</label>
    <input id="api-secret" name="password" type="password" aria-label="Payment Secret Password" value="LiveCardSecret9999" />
  </div>
  <div class="field-row">
    <button id="hero-cta" type="button" onclick="fetch('/submit-order', { method: 'POST' }); document.getElementById('status-msg').textContent = 'Submitted!';">Submit Order</button>
    <button id="delete-btn" type="button" onclick="fetch('/delete-order', { method: 'POST' })">Delete Order</button>
    <button id="dynamic-btn" type="button" onclick="window.__dynClicked = (window.__dynClicked || 0) + 1">Preview Invoice</button>
  </div>
  <p id="status-msg">Ready</p>
</body>
</html>`);
    });

    await new Promise<void>((resolve) => {
      appServer.listen(0, "127.0.0.1", () => {
        const port = (appServer.address() as any).port;
        appOrigin = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    sessionManager = new BrowserSessionManager({
      workspaceRoot,
      accountId: "acct_qa_engineer",
      networkPolicy: { allowedOrigins: [appOrigin] },
    });

    panelView = new RealTestPanelView();
    controller = new BrowserPanelController({
      artifactRootPath: artifactRoot,
      getEnvironment: () => ({
        workspaceRoot,
        workspaceName: "workspace-app",
        workspaceTrusted: true,
        activeMode: currentMode,
        activeModeLabel: currentModeLabel,
        allowedOrigins: [appOrigin],
        identity: {
          accountId: "acct_qa_engineer",
          displayLabel: "qa-engineer",
          authenticated: true,
        },
      }),
      acquireSessionManager: () => sessionManager,
      confirmationBridge: {
        requestConfirmation: (prompt, payload) => hostConfirmationHandler(prompt, payload),
        confirmSessionClose: async () => true,
      },
      createViewAdapter: (callbacks) => {
        panelView.onMessage = callbacks.onMessage;
        panelView.onVisibilityChanged = callbacks.onVisibilityChanged;
        panelView.onPanelClosed = callbacks.onPanelClosed;
        return panelView;
      },
      maxTimelineItems: 50,
      maxRetainedScreenshots: 6,
      minPreviewIntervalMs: 500,
    });
  });

  after(async () => {
    controller?.dispose();
    await sessionManager?.dispose();
    await closeHttpServer(appServer);
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function createIdeHost(): IdeHost {
    const wsRoots = [{ uri: `file://${workspaceRoot}`, fsPath: workspaceRoot, name: "workspace-app" }];
    return {
      getWorkspaceRoots: async () => wsRoots,
      getActiveDocument: async () => null,
      getSelection: async () => null,
      getVisibleDocuments: async () => [],
      getDiagnostics: async () => [],
      isWorkspaceTrusted: async () => true,
      showOutput: async () => {},
      showError: async () => {},
      requestConfirmation: (prompt, payload) => hostConfirmationHandler(prompt, payload),
      onWorkspaceChange: () => ({ dispose: () => {} }),
      getSnapshot: async () => ({
        workspaceRoots: wsRoots,
        activeDocument: null,
        selection: null,
        visibleDocuments: [],
        diagnostics: [],
        isTrusted: true,
      }),
    };
  }

  test("1. Opening Browser Panel is lightweight and does NOT launch Chromium before Browser QA task starts", async () => {
    controller.openOrRevealPanel();
    await controller.handleMessage({ type: "browserPanel.ready" });

    assert.equal(sessionManager.getStatus(), "UNINITIALIZED", "Session must remain UNINITIALIZED on panel open");
    assert.equal(sessionManager.getBrowserPid(), undefined, "Zero Chromium PID before browsing task");
    assert.ok(
      controller.getPerformanceMetrics().panelOpenLatencyMs < 50,
      `Panel open must be lightweight (<50ms, actual=${controller.getPerformanceMetrics().panelOpenLatencyMs}ms)`
    );
  });

  test("2. Browser QA — Local Development synchronizes AgentSessionBridge -> AgentRuntime -> BrowserSessionManager -> BrowserPanelController", async () => {
    currentMode = "PLAN";
    currentModeLabel = "Browser QA — Local Development (PLAN)";
    controller.attachSession(sessionManager);

    const qaProfile = resolveExecutionProfile({
      profile: BROWSER_QA_LOCAL_DEV_PACK.customMode,
      workspaceTrusted: true,
      availableSkills: [],
      availableMcpServers: [],
      availableTools: Object.keys(KNOWN_REPOSITORY_TOOL_ACTIONS),
      availableDeployments: [],
    });
    assert.equal(qaProfile.isReady, true, "Browser QA read-only profile must resolve ready");

    const scripted = new ScriptedModelProvider([
      {
        model: "scripted-qa",
        message: { role: "assistant", content: "Opening checkout page for QA inspection." },
        toolCalls: [
          {
            id: "call_open_1",
            name: "browser_open",
            arguments: { url: `${appOrigin}/checkout` },
          },
        ],
      },
      {
        model: "scripted-qa",
        message: { role: "assistant", content: "Taking accessibility snapshot of checkout page." },
        toolCalls: [
          {
            id: "call_snap_1",
            name: "browser_snapshot",
            arguments: {},
          },
        ],
      },
      {
        model: "scripted-qa",
        message: {
          role: "assistant",
          content: "Observed Local Checkout QA with Delivery Note input and Submit Order button.",
        },
        toolCalls: [],
      },
    ]);

    const bridge = new AgentSessionBridge({
      host: createIdeHost(),
      workspaceRoot,
      providerOverride: scripted,
      browserSessionManager: sessionManager,
    });

    const events: AgentEvent[] = [];
    const result = await bridge.runTask(
      `Inspect ${appOrigin}/checkout`,
      qaProfile.baseMode,
      new AbortController().signal,
      (ev) => events.push(ev),
      [],
      qaProfile
    );
    assert.equal(result.status, "COMPLETED", "Browser QA inspection task must complete");

    // Wait briefly for coalesced navigation_completed preview PNG capture to complete
    for (let i = 0; i < 30 && !controller.getState().screenshot; i++) {
      await new Promise((r) => setTimeout(r, 80));
    }

    const state = controller.getState();
    assert.equal(state.hasActiveSession, true, "Panel must reflect active Chromium session");
    assert.equal(state.sessionStatus, "READY", "Session status must be READY");
    assert.equal(state.provisioning.sandboxVerified, true, "OS sandbox verification must be visible");
    assert.equal(state.activeUrl, `${appOrigin}/checkout`, "Active URL must match navigated route");
    assert.equal(
      state.pageTitle.includes("PortalQuerySecret777"),
      false,
      "Sensitive token in document.title must be redacted"
    );

    assert.ok(state.screenshot, "Sanitized PNG preview must be captured automatically after navigation");
    assert.ok(state.screenshot!.width > 0 && state.screenshot!.height > 0, "PNG dimensions parsed");
    assert.ok(state.screenshot!.maskedSensitiveFields >= 1, "Password input must be masked in screenshot");
    assert.equal(
      fs.readdirSync(workspaceRoot).filter((f) => f.endsWith(".png")).length,
      0,
      "Zero screenshots written inside workspace repository"
    );

    assert.ok(state.snapshot, "Accessibility snapshot must be populated in inspector");
    const submitEl = state.snapshot!.elements.find((e) => e.name.includes("Submit Order"));
    assert.ok(submitEl, "Submit Order button present in inspector");
    assert.ok(submitEl!.bounds && submitEl!.bounds.width > 0, "Real Chromium bounding box captured");
    assert.ok(submitEl!.warnings.includes("side_effect"), "Submit button classified with side_effect warning");

    const pwdEl = state.snapshot!.elements.find((e) => e.inputType === "password");
    assert.ok(pwdEl, "Password input present in inspector");
    assert.equal(pwdEl!.valuePreview, undefined, "Password value must never leak into inspector");

    const eventTypes = new Set(state.timeline.map((t) => t.eventType));
    assert.ok(eventTypes.has("session_started"), "Timeline includes session_started");
    assert.ok(eventTypes.has("sandbox_verified"), "Timeline includes sandbox_verified");
    assert.ok(eventTypes.has("navigation_completed"), "Timeline includes navigation_completed");
    assert.ok(eventTypes.has("snapshot_taken"), "Timeline includes snapshot_taken");
  });

  test("3. Interactive Browser QA synchronizes PermissionGate confirmation (APPROVE & REJECT) with BrowserPanelController", async () => {
    currentMode = "BUILD";
    currentModeLabel = "Browser QA — Interactive Local Development (BUILD)";

    const interactiveProfile = resolveExecutionProfile({
      profile: BROWSER_QA_INTERACTIVE_PACK.customMode,
      workspaceTrusted: true,
      availableSkills: [],
      availableMcpServers: [],
      availableTools: Object.keys(KNOWN_REPOSITORY_TOOL_ACTIONS),
      availableDeployments: [],
    });
    assert.equal(interactiveProfile.isReady, true, "Interactive Browser QA profile must resolve ready");

    const snap = controller.getState().snapshot!;
    const noteRef = snap.elements.find((e) => e.name.includes("Delivery Note"))!.refId;
    const submitRef = snap.elements.find((e) => e.name.includes("Submit Order"))!.refId;
    const deleteRef = snap.elements.find((e) => e.name.includes("Delete Order"))!.refId;

    let observedPendingApprovalInPanel = false;
    const confirmationActionsSeen: string[] = [];

    hostConfirmationHandler = async (_prompt, payload) => {
      confirmationActionsSeen.push(payload.action);
      if (controller.getState().pendingApproval) {
        observedPendingApprovalInPanel = true;
      }
      // Approve interaction & side-effect, reject destructive delete!
      if (payload.action === "browser_destructive") {
        return "REJECT";
      }
      return "APPROVE";
    };

    const scripted = new ScriptedModelProvider([
      {
        model: "scripted-qa",
        message: { role: "assistant", content: "Filling delivery note." },
        toolCalls: [
          {
            id: "call_fill_note",
            name: "browser_fill",
            arguments: { refId: noteRef, value: "Leave at reception" },
          },
        ],
      },
      {
        model: "scripted-qa",
        message: { role: "assistant", content: "Submitting order." },
        toolCalls: [
          {
            id: "call_click_submit",
            name: "browser_click",
            arguments: { refId: submitRef },
          },
        ],
      },
      {
        model: "scripted-qa",
        message: { role: "assistant", content: "Attempting delete order to verify governance." },
        toolCalls: [
          {
            id: "call_click_delete",
            name: "browser_click",
            arguments: { refId: deleteRef },
          },
        ],
      },
      {
        model: "scripted-qa",
        message: { role: "assistant", content: "Completed interactive flow." },
        toolCalls: [],
      },
    ]);

    const bridge = new AgentSessionBridge({
      host: createIdeHost(),
      workspaceRoot,
      providerOverride: scripted,
      browserSessionManager: sessionManager,
    });

    await bridge.runTask(
      "Fill note and submit order",
      interactiveProfile.baseMode,
      new AbortController().signal,
      undefined,
      [],
      interactiveProfile
    );

    // Wait briefly for POST /submit-order to hit local server
    for (let i = 0; i < 20 && submittedOrders === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(observedPendingApprovalInPanel, true, "Panel must display pendingApproval while awaiting confirmation");
    assert.ok(confirmationActionsSeen.includes("browser_interaction"), "browser_fill routed as browser_interaction");
    assert.ok(confirmationActionsSeen.includes("browser_side_effect"), "Submit button routed as browser_side_effect");
    assert.ok(confirmationActionsSeen.includes("browser_destructive"), "Delete button routed as browser_destructive");
    assert.equal(submittedOrders, 1, "Approved Submit Order click must execute in real Chromium");
    assert.equal(deletedOrders, 0, "Rejected Delete Order click must NOT execute");

    lastCustomerNote = await sessionManager.getActivePage()!.evaluate(() => (globalThis as any).__note || "");
    assert.equal(lastCustomerNote, "Leave at reception", "Approved fill populated real input");

    const tl = controller.getState().timeline;
    assert.ok(
      tl.some((item) => item.eventType === "approval_requested" && item.origin === "agent" && Boolean(item.taskId)),
      "Agent approval_requested event linked with taskId"
    );
    assert.ok(
      tl.some((item) => item.eventType === "action_denied" && item.origin === "agent"),
      "Rejected destructive action recorded as action_denied in timeline"
    );
  });

  test("4. Manual Browser Panel controls share the single Chromium session without launching a second browser", async () => {
    const pidBefore = sessionManager.getBrowserPid();
    const sessionIdBefore = sessionManager.getSessionId();
    assert.ok(pidBefore && pidBefore > 0, "Active Chromium PID exists");

    // Resize to mobile preset & back to desktop via manual UI messages
    await controller.handleMessage({ type: "browserPanel.setViewportPreset", presetId: "mobile" });
    assert.equal(controller.getState().viewportPreset, "mobile");
    assert.equal(controller.getState().screenshot?.width, 390);
    assert.equal(sessionManager.getBrowserPid(), pidBefore, "Viewport resize must reuse same Chromium process");

    await controller.handleMessage({ type: "browserPanel.setViewportPreset", presetId: "desktop" });
    assert.equal(controller.getState().viewportPreset, "desktop");
    assert.equal(sessionManager.getSessionId(), sessionIdBefore, "Session ID unchanged");

    // Manual click on harmless Preview Invoice button via governed confirmation
    const dynRef = controller
      .getState()
      .snapshot!.elements.find((e) => e.name.includes("Preview Invoice"))!.refId;
    hostConfirmationHandler = async () => "APPROVE";
    await controller.handleMessage({ type: "browserPanel.selectElement", refId: dynRef });
    await controller.handleMessage({ type: "browserPanel.clickSelected", refId: dynRef });

    dynamicBtnClicked = await sessionManager.getActivePage()!.evaluate(() => (globalThis as any).__dynClicked || 0);
    assert.equal(dynamicBtnClicked, 1, "Manual click executed through governed tool contract");
    assert.ok(
      controller.getState().timeline.some((t) => t.origin === "user" && t.eventType === "action_approved"),
      "Timeline distinguishes user-directed manual action (origin=user)"
    );
  });

  test("5. Live Chromium DOM mutation during confirmation fails closed via revalidateApproval()", async () => {
    await controller.handleMessage({ type: "browserPanel.refreshObservation" });
    const dynRef = controller
      .getState()
      .snapshot!.elements.find((e) => e.name.includes("Preview Invoice"))!.refId;
    const clicksBefore = await sessionManager.getActivePage()!.evaluate(() => (globalThis as any).__dynClicked || 0);

    // Mutate live DOM button text into destructive label while confirmation dialog is open!
    hostConfirmationHandler = async () => {
      await sessionManager.getActivePage()!.evaluate(() => {
        const btn = (globalThis as any).document.getElementById("dynamic-btn");
        if (btn) btn.textContent = "Delete Workspace Permanently";
      });
      return "APPROVE";
    };

    await controller.handleMessage({ type: "browserPanel.clickSelected", refId: dynRef });
    const clicksAfter = await sessionManager.getActivePage()!.evaluate(() => (globalThis as any).__dynClicked || 0);
    assert.equal(clicksAfter, clicksBefore, "Mutated destructive target must NOT be clicked");
    assert.match(controller.getState().navigationError || "", /ACTION_RISK_ESCALATED/);
  });

  test("6. Hidden-panel navigation skips preview captures and syncs cleanly on reveal/reopen without launching second browser", async () => {
    const pidBefore = sessionManager.getBrowserPid();
    panelView.hide();

    await sessionManager.withCorrelation({ origin: "agent", taskId: "task_bg_nav" }, () =>
      sessionManager.navigate(`${appOrigin}/settings`)
    );

    const hiddenMetrics = controller.getPerformanceMetrics();
    assert.ok(hiddenMetrics.skippedHiddenRefreshes >= 1, "Hidden panel must skip preview captures");
    assert.equal(sessionManager.getBrowserPid(), pidBefore, "No second browser launched while hidden");

    // Close panel tab and reopen it
    panelView.closeTab();
    controller.openOrRevealPanel();
    for (let i = 0; i < 25 && controller.getState().screenshot?.stale !== false; i++) {
      await new Promise((r) => setTimeout(r, 80));
    }

    const revealedState = controller.getState();
    assert.equal(revealedState.activeUrl, `${appOrigin}/settings`, "Revealed panel shows current agent URL");
    assert.equal(revealedState.pageTitle, "Workspace Settings", "Revealed panel shows current page title");
    assert.equal(sessionManager.getBrowserPid(), pidBefore, "Reopened panel observes identical Chromium PID");
  });

  test("7. Sprint 9C Design & Motion observation contracts against real Chromium computed styles", async () => {
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: `${appOrigin}/checkout`,
    });

    const heroRef = controller
      .getState()
      .snapshot!.elements.find((e) => e.name.includes("Submit Order"))!.refId;
    await controller.handleMessage({ type: "browserPanel.selectElement", refId: heroRef });
    await controller.handleMessage({ type: "browserPanel.inspectElementDesign", refId: heroRef });

    const dm = controller.getState().selectedDesignMetadata;
    assert.ok(dm, "Real Chromium computed style metadata captured");
    assert.equal(dm!.typography.fontSize, "18px", "Computed fontSize matches CSS");
    assert.equal(dm!.typography.fontWeight, "700", "Computed fontWeight matches CSS");
    assert.equal(dm!.spacing.paddingTop, "12px", "Computed paddingTop matches CSS");
    assert.equal(dm!.layout.display, "inline-flex", "Computed display matches CSS");

    await controller.handleMessage({ type: "browserPanel.observeAnimations" });
    const anim = controller.getState().animationObservation;
    assert.ok(anim, "Animation declaration observation captured");
    assert.ok(anim!.animatedElementCount >= 1, "Detects CSS transition on #hero-cta");
    assert.equal(
      anim!.motionQualityClaimAllowed,
      false,
      "Must forbid claiming runtime animation smoothness from static probe"
    );

    // Baseline + comparison
    await controller.handleMessage({ type: "browserPanel.captureBaseline" });
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: `${appOrigin}/settings`,
    });
    await controller.handleMessage({ type: "browserPanel.compareWithBaseline" });
    const cmp = controller.getState().visualComparison;
    assert.ok(cmp, "Visual comparison computed");
    assert.equal(cmp!.identicalHash, false, "Different routes produce distinct PNG hashes");
  });

  test("8. Sprint 9D Evidence Journal & real BrowserEgressProxy network-policy denial", async () => {
    await controller.handleMessage({ type: "browserPanel.toggleEvidenceRecording", enabled: true });
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: "http://127.0.0.1:59991/forbidden-port",
    });

    const state = controller.getState();
    assert.ok(state.networkPolicyWarnings.length >= 1, "Blocked port surfaces network policy warning");
    assert.ok(
      state.evidence.observedFacts.some((f) => f.kind === "network_diagnostic" && f.networkPolicyOutcome === "denied"),
      "Journal records sanitized network_diagnostic fact"
    );
    for (const fact of state.evidence.observedFacts) {
      assert.equal(fact.responseBodyRecorded, false, "Response bodies never recorded");
      assert.equal(fact.credentialsRecorded, false, "Credentials never recorded");
      assert.equal(fact.browserStorageRecorded, false, "Browser storage never recorded");
    }
  });

  test("9. Measures latency, memory, idle/hidden CPU, long-session bounds & verifies zero process/artifact leaks on close", async (t) => {
    await controller.handleMessage({
      type: "browserPanel.openUrl",
      url: `${appOrigin}/checkout`,
    });

    // Measure idle CPU over 500ms while panel is open & idle
    const idleCpuStart = process.cpuUsage();
    const idleWallStart = performance.now();
    await new Promise((r) => setTimeout(r, 500));
    const idleCpuDelta = process.cpuUsage(idleCpuStart);
    const idleWallMs = performance.now() - idleWallStart;
    const idleCpuPercent = Number((((idleCpuDelta.user + idleCpuDelta.system) / 1000 / idleWallMs) * 100).toFixed(2));

    // Measure hidden-panel CPU over 500ms while panel is hidden
    panelView.hide();
    const hiddenCpuStart = process.cpuUsage();
    const hiddenWallStart = performance.now();
    await new Promise((r) => setTimeout(r, 500));
    const hiddenCpuDelta = process.cpuUsage(hiddenCpuStart);
    const hiddenWallMs = performance.now() - hiddenWallStart;
    const hiddenCpuPercent = Number(
      (((hiddenCpuDelta.user + hiddenCpuDelta.system) / 1000 / hiddenWallMs) * 100).toFixed(2)
    );
    panelView.show();

    // Long-session stress: 65 rapid inspection events + 8 screenshot captures -> strictly bounded!
    for (let i = 0; i < 65; i++) {
      sessionManager.recordActionDenied(
        { tool: "browser_click", action: "browser_interaction", reason: `STRESS_${i}` },
        { origin: "agent", taskId: "stress_task" }
      );
    }
    for (let i = 0; i < 8; i++) {
      await controller.handleMessage({ type: "browserPanel.captureScreenshot", fullPage: false });
    }

    const metrics = controller.getPerformanceMetrics();
    const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));

    t.diagnostic(
      `Sprint 9B Telemetry: panelOpenLatencyMs=${metrics.panelOpenLatencyMs} | eventToUiLatencyMs=${metrics.lastEventToUiLatencyMs} | screenshotCaptureMs=${metrics.lastScreenshotCaptureMs} | retainedScreenshots=${metrics.retainedScreenshotCount} (${metrics.retainedScreenshotBytes} B) | timelineCount=${metrics.timelineCount} | rssMb=${rssMb} | idleCpuPct=${idleCpuPercent}% | hiddenCpuPct=${hiddenCpuPercent}%`
    );

    assert.equal(metrics.timelineCount, 50, "Timeline bounded at maxTimelineItems=50 over long session");
    assert.ok(metrics.retainedScreenshotCount <= 6, "Screenshot ring buffer bounded at maxRetainedScreenshots=6");
    assert.ok(metrics.retainedScreenshotBytes < 20 * 1024 * 1024, "Retained screenshot bytes strictly bounded");
    assert.ok(idleCpuPercent < 25, `Idle CPU must remain low (<25%, actual=${idleCpuPercent}%)`);
    assert.ok(hiddenCpuPercent < 15, `Hidden-panel CPU must remain near-zero (<15%, actual=${hiddenCpuPercent}%)`);

    const livePid = sessionManager.getBrowserPid();
    assert.equal(isPidAlive(livePid), true, "Chromium PID alive prior to close");

    await controller.handleMessage({ type: "browserPanel.closeSession" });
    await sessionManager.dispose();

    for (let i = 0; i < 20 && isPidAlive(livePid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(isPidAlive(livePid), false, "Chromium PID must be terminated after session close/dispose");
    assert.equal(controller.getPerformanceMetrics().retainedScreenshotCount, 0, "All temporary screenshots cleaned up");
  });
});
