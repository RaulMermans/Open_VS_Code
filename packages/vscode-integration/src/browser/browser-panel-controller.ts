import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BROWSER_VIEWPORT_PRESETS,
  BoundedObservationJournal,
  BrowserSessionManager,
  classifyPermission,
  createBrowserToolRegistrations,
  detectBrowserProvisioning,
  redactSensitiveText,
  resolveViewportPresetId,
  sanitizeBrowserUrl,
  compareVisualScreenshots,
  VisualQAEvaluator,
  type VisualComparisonResult,
  type VisualQAReport,
  type MeasuredMotionObservation,
  ToolRegistry,
  type AccessibilitySnapshot,
  type AgentMode,
  type AnimationObservation,
  type BeforeAfterComparison,
  type BrowserActionOrigin,
  type BrowserEvent,
  type BrowserViewportDimensions,
  type ElementDesignMetadata,
  type ModePermissionOverrides,
  type ToolAction,
  type VisualBaselineArtifact,
} from "@open-vs-code/agent-core";
import type {
  BrowserElementView,
  BrowserElementWarning,
  BrowserIdentityIndicator,
  BrowserPanelPerformanceMetrics,
  BrowserPanelState,
  BrowserPendingApprovalSummary,
  BrowserProvisioningSummary,
  BrowserScreenshotPreview,
  BrowserSnapshotView,
  BrowserTimelineItem,
  BrowserTimelineStatus,
  BrowserZoomMode,
  InboundBrowserPanelMessage,
  SanitizedVisualBaselineSummary,
} from "./browser-panel-protocol.ts";
import type { BrowserPanelViewAdapter } from "./browser-webview-panel.ts";

export interface BrowserConfirmationBridge {
  requestConfirmation(
    prompt: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<"APPROVE" | "REJECT">;
  confirmSessionClose(summary: string): Promise<boolean>;
}

export interface BrowserWorkspaceEnvironment {
  readonly workspaceRoot: string | undefined;
  readonly workspaceName: string;
  readonly workspaceTrusted: boolean;
  readonly activeMode: AgentMode;
  readonly activeModeLabel: string;
  readonly modeOverrides?: ModePermissionOverrides | undefined;
  readonly allowedOrigins: readonly string[];
  readonly executablePath?: string | undefined;
  readonly identity: BrowserIdentityIndicator;
}

export interface BrowserPanelControllerOptions {
  readonly artifactRootPath?: string | undefined;
  readonly getEnvironment: () => BrowserWorkspaceEnvironment;
  /**
   * Acquires or creates the single authoritative BrowserSessionManager for the current
   * `(workspaceRoot, accountId)`. Invoked ONLY when a user-directed manual browser action
   * (`openUrl` / `navigate`) explicitly starts browsing — NEVER on panel open or render.
   */
  readonly acquireSessionManager: () => BrowserSessionManager | undefined;
  readonly confirmationBridge: BrowserConfirmationBridge;
  readonly createViewAdapter: (callbacks: {
    readonly artifactRootPath: string;
    readonly onMessage: (msg: InboundBrowserPanelMessage) => void;
    readonly onVisibilityChanged: (visible: boolean) => void;
    readonly onPanelClosed: () => void;
  }) => BrowserPanelViewAdapter;
  readonly maxTimelineItems?: number | undefined;
  readonly maxRetainedScreenshots?: number | undefined;
  readonly maxRetainedScreenshotBytes?: number | undefined;
  readonly minPreviewIntervalMs?: number | undefined;
}

interface StoredScreenshotArtifact {
  readonly artifactId: string;
  readonly filePath: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly capturedAt: number;
  readonly url: string;
  readonly pageTitle: string;
  readonly viewport: BrowserViewportDimensions;
  readonly snapshotId?: string | undefined;
  readonly maskedSensitiveFields: number;
}

const DEFAULT_MAX_TIMELINE_ITEMS = 100;
const DEFAULT_MAX_SCREENSHOTS = 12;
const DEFAULT_MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024; // 20 MiB
const DEFAULT_MIN_PREVIEW_INTERVAL_MS = 600; // <= 1.67 fps max when auto-refresh enabled
const MAX_POLICY_WARNINGS = 25;
const MAX_CONSOLE_ERRORS = 25;

export class BrowserPanelController {
  readonly #artifactRootPath: string;
  readonly #getEnvironment: () => BrowserWorkspaceEnvironment;
  readonly #acquireSessionManager: () => BrowserSessionManager | undefined;
  readonly #confirmationBridge: BrowserConfirmationBridge;
  readonly #view: BrowserPanelViewAdapter;
  readonly #maxTimelineItems: number;
  readonly #maxRetainedScreenshots: number;
  readonly #maxRetainedScreenshotBytes: number;
  readonly #minPreviewIntervalMs: number;

  #sessionManager: BrowserSessionManager | undefined;
  #unsubscribeSessionEvents: (() => void) | undefined;

  #zoomMode: BrowserZoomMode = "fit";
  #autoRefreshEnabled = false;
  #pendingViewport: BrowserViewportDimensions = { width: 1280, height: 800 };

  #timeline: BrowserTimelineItem[] = [];
  #timelineSeq = 0;
  #networkPolicyWarnings: string[] = [];
  #consoleErrors: string[] = [];
  #navigationError: string | undefined;
  #statusNotice: string | undefined;
  #pendingApproval: BrowserPendingApprovalSummary | undefined;

  #screenshots: StoredScreenshotArtifact[] = [];
  #latestScreenshotStale = false;
  #latestScreenshotStaleReason: string | undefined;
  #latestSnapshot: AccessibilitySnapshot | undefined;
  #snapshotStaleReason: string | undefined;

  #selectedRefId: string | null = null;
  #selectedDesignMetadata: ElementDesignMetadata | undefined;
  #animationObservation: AnimationObservation | undefined;
  #visualBaseline: VisualBaselineArtifact | undefined;
  #visualComparison: BeforeAfterComparison | undefined;
  #visualQaReport: VisualQAReport | undefined;
  readonly #evidenceJournal = new BoundedObservationJournal();

  // Operation & preview backpressure controls
  #manualOpAbort: AbortController | undefined;
  #activeOperationLabel: string | undefined;
  #previewAbort: AbortController | undefined;
  #previewCaptureInFlight = false;
  #previewCaptureQueued = false;
  #lastPreviewCaptureStartedAt = 0;
  #rateLimitTimer: ReturnType<typeof setTimeout> | undefined;

  // Performance telemetry
  #panelOpenLatencyMs = 0;
  #lastEventToUiLatencyMs = 0;
  #lastScreenshotCaptureMs = 0;
  #skippedHiddenRefreshes = 0;
  #cachedProvisioning: { key: string; at: number; summary: BrowserProvisioningSummary } | undefined;
  #disposed = false;

  constructor(options: BrowserPanelControllerOptions) {
    const fallbackRoot = path.join(os.tmpdir(), "open-vs-code-browser-artifacts");
    this.#artifactRootPath = path.resolve(options.artifactRootPath || fallbackRoot);
    this.#getEnvironment = options.getEnvironment;
    this.#acquireSessionManager = options.acquireSessionManager;
    this.#confirmationBridge = options.confirmationBridge;
    this.#maxTimelineItems = Math.max(10, options.maxTimelineItems ?? DEFAULT_MAX_TIMELINE_ITEMS);
    this.#maxRetainedScreenshots = Math.max(2, options.maxRetainedScreenshots ?? DEFAULT_MAX_SCREENSHOTS);
    this.#maxRetainedScreenshotBytes = Math.max(
      262144,
      options.maxRetainedScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES
    );
    this.#minPreviewIntervalMs = Math.max(500, options.minPreviewIntervalMs ?? DEFAULT_MIN_PREVIEW_INTERVAL_MS);

    this.#ensureSafeArtifactRoot();
    this.#view = options.createViewAdapter({
      artifactRootPath: this.#artifactRootPath,
      onMessage: (msg) => {
        void this.handleMessage(msg);
      },
      onVisibilityChanged: (visible) => {
        this.#handleVisibilityChanged(visible);
      },
      onPanelClosed: () => {
        this.#handlePanelClosed();
      },
    });
  }

  public getArtifactRootPath(): string {
    return this.#artifactRootPath;
  }

  public getObservedSessionManager(): BrowserSessionManager | undefined {
    return this.#sessionManager;
  }

  public isPanelOpen(): boolean {
    return this.#view.isOpen;
  }

  public isPanelVisible(): boolean {
    return this.#view.isVisible;
  }

  /**
   * Opens or reveals the Open VS Code Browser panel beside the editor.
   * Lightweight: never launches Chromium and never performs automatic network navigation.
   */
  public openOrRevealPanel(): void {
    if (this.#disposed) return;
    const t0 = performance.now();
    this.#view.openOrReveal();
    this.#panelOpenLatencyMs = Math.max(0, Number((performance.now() - t0).toFixed(2)));
    void this.#pushState();
  }

  /**
   * Passively attaches to the single authoritative BrowserSessionManager for the active
   * `(workspaceRoot, accountId)`. Replaces any prior subscription cleanly.
   */
  public attachSession(manager: BrowserSessionManager): void {
    if (this.#disposed) return;
    if (this.#sessionManager === manager) {
      void this.#pushState();
      return;
    }

    const env = this.#getEnvironment();
    if (env.workspaceRoot && path.resolve(manager.getWorkspaceRoot()) !== path.resolve(env.workspaceRoot)) {
      // Cross-workspace guard: refuse to observe a session belonging to another workspace
      return;
    }
    if (manager.getAccountId() !== env.identity.accountId) {
      // Cross-account guard: refuse to observe a session belonging to another account
      return;
    }

    this.#detachSubscriptionOnly();
    this.#clearRetainedArtifacts();
    this.#resetTransientInspectionState();

    this.#sessionManager = manager;
    this.#pendingViewport = manager.getViewport();
    const existingSnap = manager.getLatestSnapshot();
    if (existingSnap) {
      this.#latestSnapshot = existingSnap;
    }

    this.#unsubscribeSessionEvents = manager.onEvent((event) => {
      this.#handleBrowserEvent(event);
    });

    void this.#pushState();
  }

  /**
   * Immediately invalidates panel observation state and deletes temporary screenshot artifacts
   * (e.g., on workspace change, untrusted transition, account switch/logout, or session disposal).
   */
  public invalidateObservation(reason: string): void {
    this.#cancelPreviewCapture();
    this.#manualOpAbort?.abort();
    this.#manualOpAbort = undefined;
    this.#activeOperationLabel = undefined;
    this.#detachSubscriptionOnly();
    this.#sessionManager = undefined;

    this.#clearRetainedArtifacts();
    this.#timeline = [];
    this.#networkPolicyWarnings = [];
    this.#consoleErrors = [];
    this.#navigationError = undefined;
    this.#pendingApproval = undefined;
    this.#resetTransientInspectionState();
    this.#evidenceJournal.clear();
    this.#evidenceJournal.setRecordingEnabled(false);
    this.#statusNotice = redactSensitiveText(reason);

    void this.#pushState();
  }

  public getState(): BrowserPanelState {
    const env = this.#getEnvironment();
    const manager = this.#sessionManager;
    const hasActiveSession = Boolean(manager && !manager.isDisposed());
    const sessionStatus = hasActiveSession ? manager!.getStatus() : "DISCONNECTED";
    const viewport = hasActiveSession ? manager!.getViewport() : this.#pendingViewport;
    const viewportPreset = resolveViewportPresetId(viewport);
    const activeUrl = hasActiveSession ? sanitizeBrowserUrl(manager!.getCurrentUrl()) : "";
    const pageTitle = hasActiveSession ? redactSensitiveText(manager!.getCurrentTitle()) : "";

    const provisioning = this.#resolveProvisioningSummary(env, manager);
    const screenshot = this.#buildScreenshotPreview();
    const snapshot = this.#buildSnapshotView(manager);

    const visualBaseline: SanitizedVisualBaselineSummary | undefined = this.#visualBaseline
      ? {
          baselineId: this.#visualBaseline.baselineId,
          url: this.#visualBaseline.url,
          pageTitle: this.#visualBaseline.pageTitle,
          viewport: this.#visualBaseline.viewport,
          presetId: this.#visualBaseline.presetId,
          artifactId: this.#visualBaseline.artifactId,
          webviewUri: this.#view.asWebviewUri(this.#visualBaseline.filePath),
          width: this.#visualBaseline.width,
          height: this.#visualBaseline.height,
          bytes: this.#visualBaseline.bytes,
          capturedAt: this.#visualBaseline.capturedAt,
        }
      : undefined;

    const identity: BrowserIdentityIndicator = {
      ...env.identity,
      ...(hasActiveSession ? { sessionId: manager!.getSessionId() } : {}),
    };

    return {
      hasActiveSession,
      sessionStatus,
      workspaceName: env.workspaceName,
      workspaceTrusted: env.workspaceTrusted,
      activeExecutionMode: env.activeModeLabel,
      allowedOrigins: [...env.allowedOrigins],
      identity,
      provisioning,
      activeUrl,
      pageTitle,
      viewport,
      viewportPreset,
      zoomMode: this.#zoomMode,
      autoRefreshEnabled: this.#autoRefreshEnabled,
      activeOperationBusy: Boolean(this.#manualOpAbort),
      ...(this.#activeOperationLabel ? { activeOperationLabel: this.#activeOperationLabel } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(snapshot ? { snapshot } : {}),
      selectedRefId: this.#selectedRefId,
      ...(this.#selectedDesignMetadata ? { selectedDesignMetadata: this.#selectedDesignMetadata } : {}),
      ...(this.#animationObservation ? { animationObservation: this.#animationObservation } : {}),
      ...(visualBaseline ? { visualBaseline } : {}),
      ...(this.#visualComparison ? { visualComparison: this.#visualComparison } : {}),
      ...(this.#visualQaReport ? { visualQaReport: this.#visualQaReport } : {}),
      evidence: this.#evidenceJournal.snapshot(),
      timeline: [...this.#timeline],
      ...(this.#navigationError ? { navigationError: this.#navigationError } : {}),
      ...(this.#statusNotice ? { statusNotice: this.#statusNotice } : {}),
      networkPolicyWarnings: [...this.#networkPolicyWarnings],
      consoleErrors: [...this.#consoleErrors],
      ...(this.#pendingApproval ? { pendingApproval: this.#pendingApproval } : {}),
      metrics: this.getPerformanceMetrics(),
    };
  }

  public getPerformanceMetrics(): BrowserPanelPerformanceMetrics {
    let retainedBytes = 0;
    for (const s of this.#screenshots) {
      retainedBytes += s.bytes;
    }
    return {
      panelOpenLatencyMs: this.#panelOpenLatencyMs,
      lastEventToUiLatencyMs: this.#lastEventToUiLatencyMs,
      lastScreenshotCaptureMs: this.#lastScreenshotCaptureMs,
      retainedScreenshotCount: this.#screenshots.length,
      retainedScreenshotBytes: retainedBytes,
      timelineCount: this.#timeline.length,
      skippedHiddenRefreshes: this.#skippedHiddenRefreshes,
    };
  }

  public async handleMessage(message: InboundBrowserPanelMessage): Promise<void> {
    if (this.#disposed) return;

    switch (message.type) {
      case "browserPanel.ready":
        await this.#pushState();
        return;

      case "browserPanel.setZoomMode":
        this.#zoomMode = message.zoomMode;
        await this.#pushState();
        return;

      case "browserPanel.setAutoRefresh":
        this.#autoRefreshEnabled = message.enabled;
        await this.#pushState();
        return;

      case "browserPanel.selectElement":
        this.#selectedRefId = message.refId;
        if (!message.refId || this.#selectedDesignMetadata?.refId !== message.refId) {
          this.#selectedDesignMetadata = undefined;
        }
        await this.#pushState();
        return;

      case "browserPanel.cancelOperation":
        this.#cancelActiveOperation();
        await this.#pushState();
        return;

      case "browserPanel.setViewportPreset":
        await this.#handleSetViewportPreset(message.presetId);
        return;

      case "browserPanel.openUrl":
        await this.#executeGovernedManualTool("browser_open", { url: message.url }, {
          acquireIfMissing: true,
          refreshObservationAfter: true,
        });
        return;

      case "browserPanel.navigate":
        await this.#executeGovernedManualTool("browser_navigate", { url: message.url }, {
          acquireIfMissing: true,
          refreshObservationAfter: true,
        });
        return;

      case "browserPanel.refreshObservation":
        await this.#handleRefreshObservation();
        return;

      case "browserPanel.captureScreenshot":
        await this.#handleManualScreenshot(message.fullPage);
        return;

      case "browserPanel.inspectElements":
        await this.#executeGovernedManualTool("browser_snapshot", {}, {
          acquireIfMissing: false,
          refreshObservationAfter: false,
        });
        return;

      case "browserPanel.inspectElementDesign":
        await this.#handleInspectElementDesign(message.refId);
        return;

      case "browserPanel.observeAnimations":
        await this.#handleObserveAnimations();
        return;

      case "browserPanel.clickSelected":
        await this.#executeGovernedManualTool("browser_click", { refId: message.refId }, {
          acquireIfMissing: false,
          refreshObservationAfter: true,
        });
        return;

      case "browserPanel.fillSelected":
        await this.#executeGovernedManualTool(
          "browser_fill",
          { refId: message.refId, value: message.value },
          {
            acquireIfMissing: false,
            refreshObservationAfter: true,
          }
        );
        return;

      case "browserPanel.closeSession":
        await this.#handleCloseSession();
        return;

      case "browserPanel.captureBaseline":
        this.#handleCaptureBaseline();
        await this.#pushState();
        return;

      case "browserPanel.compareWithBaseline":
        this.#handleCompareWithBaseline();
        await this.#pushState();
        return;

      case "browserPanel.measureMotion":
        await this.#handleMeasureMotion(message.durationMs);
        await this.#pushState();
        return;

      case "browserPanel.runVisualQa":
        await this.#handleRunVisualQa();
        await this.#pushState();
        return;

      case "browserPanel.toggleEvidenceRecording":
        this.#evidenceJournal.setRecordingEnabled(message.enabled);
        this.#statusNotice = message.enabled
          ? "Bounded observation evidence recording enabled (facts only; zero response bodies, cookies, or storage)."
          : "Observation evidence recording paused.";
        await this.#pushState();
        return;

      case "browserPanel.clearEvidence":
        this.#evidenceJournal.clear();
        this.#statusNotice = "Observation evidence journal cleared.";
        await this.#pushState();
        return;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelPreviewCapture();
    this.#manualOpAbort?.abort();
    this.#manualOpAbort = undefined;
    this.#detachSubscriptionOnly();
    this.#clearRetainedArtifacts(true);
    this.#view.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal Manual Governed Tool Execution
  // ---------------------------------------------------------------------------

  async #executeGovernedManualTool(
    toolName: string,
    rawArgs: Readonly<Record<string, unknown>>,
    opts: { acquireIfMissing: boolean; refreshObservationAfter: boolean }
  ): Promise<void> {
    if (this.#manualOpAbort) {
      this.#statusNotice = "Another manual browser operation is already running.";
      await this.#pushState();
      return;
    }

    const env = this.#getEnvironment();
    if (!env.workspaceRoot) {
      this.#navigationError = "Open a workspace folder before starting a governed browser session.";
      await this.#pushState();
      return;
    }
    if (!env.workspaceTrusted) {
      this.#navigationError =
        "Browser execution is disabled in untrusted workspaces. Trust the workspace to enable governed browsing.";
      await this.#pushState();
      return;
    }

    // Pre-check stale snapshot before acquiring/running element-bound manual actions
    if (toolName === "browser_click" || toolName === "browser_fill") {
      if (!this.#sessionManager || !this.#sessionManager.isSnapshotFresh(this.#latestSnapshot?.snapshotId)) {
        this.#navigationError =
          "[STALE_ELEMENT_REFERENCE] Current accessibility snapshot is stale. Click Refresh Observation before acting on elements.";
        this.#sessionManager?.recordActionDenied(
          {
            tool: toolName,
            action: "browser_interaction",
            ...(typeof rawArgs.refId === "string" ? { refId: rawArgs.refId } : {}),
            reason: "STALE_ELEMENT_REFERENCE",
          },
          { origin: "user" }
        );
        await this.#pushState();
        return;
      }
    }

    // Evaluate permission BEFORE acquiring/creating any BrowserSessionManager for non-allowed actions
    let manager = this.#sessionManager;
    if ((!manager || manager.isDisposed()) && opts.acquireIfMissing) {
      const prelimAction: ToolAction =
        toolName === "browser_navigate" ? "browser_interaction" : "browser_inspection";
      const prelimPerm = classifyPermission({
        action: prelimAction,
        mode: env.activeMode,
        ...(env.modeOverrides ? { modeOverrides: env.modeOverrides } : {}),
      });
      if (prelimPerm === "DENY") {
        this.#navigationError = `Permission policy denied "${toolName}" (${prelimAction}) in ${env.activeModeLabel} mode. Switch to BUILD or Browser QA Interactive mode for interactive actions.`;
        this.#appendTimelineItem({
          eventType: "action_denied",
          actionName: toolName,
          status: "denied",
          timestamp: Date.now(),
          origin: "user",
          ...(typeof rawArgs.url === "string" ? { target: sanitizeBrowserUrl(rawArgs.url) } : {}),
          resultOrError: `Denied by PermissionGate in ${env.activeModeLabel} mode`,
        });
        await this.#pushState();
        return;
      }
      manager = this.#acquireSessionManager();
      if (manager) {
        this.attachSession(manager);
      }
    }

    if (!manager || manager.isDisposed()) {
      this.#navigationError = "No active browser session. Open an authorized URL first.";
      await this.#pushState();
      return;
    }

    const registry = new ToolRegistry(createBrowserToolRegistrations(manager));
    const callId = `manual_${crypto.randomUUID().slice(0, 8)}`;
    const abortController = new AbortController();
    this.#manualOpAbort = abortController;
    this.#activeOperationLabel = toolName;
    this.#navigationError = undefined;
    this.#statusNotice = undefined;
    await this.#pushState();

    try {
      const prepared = registry.prepare({
        id: callId,
        name: toolName,
        arguments: rawArgs,
      });

      const permission = classifyPermission({
        action: prepared.effectiveAction,
        mode: env.activeMode,
        ...(env.modeOverrides ? { modeOverrides: env.modeOverrides } : {}),
      });

      const execContext = {
        workspaceRoot: env.workspaceRoot,
        signal: abortController.signal,
        callId,
        origin: "user" as const,
      };

      if (permission === "DENY") {
        prepared.notifyDenied?.(
          `Denied by PermissionGate in ${env.activeModeLabel} mode`,
          execContext
        );
        this.#navigationError = `Permission policy denied "${toolName}" (${prepared.effectiveAction}) in ${env.activeModeLabel} mode.`;
        return;
      }

      if (permission === "CONFIRM" && prepared.prepareForReview) {
        const reviewable = await prepared.prepareForReview(execContext);
        const targetHint =
          typeof reviewable.reviewPayload.targetName === "string"
            ? ` on "${reviewable.reviewPayload.targetName}"`
            : typeof reviewable.reviewPayload.fieldName === "string"
            ? ` into "${reviewable.reviewPayload.fieldName}"`
            : typeof reviewable.reviewPayload.url === "string"
            ? ` to ${reviewable.reviewPayload.url}`
            : "";
        const decision = await this.#confirmationBridge.requestConfirmation(
          `Approve manual ${toolName}${targetHint}? (${prepared.effectiveAction})`,
          {
            callId,
            toolName,
            action: prepared.effectiveAction,
            arguments: prepared.arguments,
            preparedMutation: reviewable.reviewPayload,
          }
        );
        if (decision !== "APPROVE") {
          await reviewable.reject?.("USER_REJECTED");
          this.#statusNotice = `Manual ${toolName} cancelled by user.`;
          return;
        }
        await reviewable.apply(execContext);
      } else {
        await prepared.invoke(execContext);
      }

      if (opts.refreshObservationAfter && !abortController.signal.aborted) {
        await this.#captureObservationPair("user", abortController.signal);
      }
    } catch (err: any) {
      if (abortController.signal.aborted || err?.name === "AbortError") {
        this.#statusNotice = `Cancelled ${toolName}.`;
      } else {
        this.#navigationError = redactSensitiveText(err?.message || String(err));
      }
    } finally {
      if (this.#manualOpAbort === abortController) {
        this.#manualOpAbort = undefined;
        this.#activeOperationLabel = undefined;
      }
      await this.#pushState();
    }
  }

  async #handleRefreshObservation(): Promise<void> {
    if (!this.#sessionManager || this.#sessionManager.isDisposed()) {
      this.#navigationError = "No active browser session to refresh.";
      await this.#pushState();
      return;
    }
    if (this.#manualOpAbort) return;

    const abortController = new AbortController();
    this.#manualOpAbort = abortController;
    this.#activeOperationLabel = "refresh_observation";
    this.#navigationError = undefined;
    await this.#pushState();

    try {
      await this.#captureObservationPair("user", abortController.signal);
    } catch (err: any) {
      if (!abortController.signal.aborted && err?.name !== "AbortError") {
        this.#navigationError = redactSensitiveText(err?.message || String(err));
      }
    } finally {
      if (this.#manualOpAbort === abortController) {
        this.#manualOpAbort = undefined;
        this.#activeOperationLabel = undefined;
      }
      await this.#pushState();
    }
  }

  async #handleManualScreenshot(fullPage: boolean): Promise<void> {
    if (!this.#sessionManager || this.#sessionManager.isDisposed()) {
      this.#navigationError = "No active browser session to capture.";
      await this.#pushState();
      return;
    }
    if (this.#manualOpAbort) return;

    const abortController = new AbortController();
    this.#manualOpAbort = abortController;
    this.#activeOperationLabel = "browser_screenshot";
    this.#navigationError = undefined;
    await this.#pushState();

    try {
      await this.#captureAndStoreScreenshot(this.#sessionManager, {
        origin: "user",
        fullPage,
        signal: abortController.signal,
      });
    } catch (err: any) {
      if (!abortController.signal.aborted && err?.name !== "AbortError") {
        this.#navigationError = redactSensitiveText(err?.message || String(err));
      }
    } finally {
      if (this.#manualOpAbort === abortController) {
        this.#manualOpAbort = undefined;
        this.#activeOperationLabel = undefined;
      }
      await this.#pushState();
    }
  }

  async #handleSetViewportPreset(presetId: "desktop" | "tablet" | "mobile"): Promise<void> {
    const preset = BROWSER_VIEWPORT_PRESETS[presetId];
    this.#pendingViewport = { width: preset.width, height: preset.height };
    this.#selectedDesignMetadata = undefined;

    if (this.#sessionManager && !this.#sessionManager.isDisposed()) {
      try {
        await this.#sessionManager.withCorrelation({ origin: "user" }, () =>
          this.#sessionManager!.setViewport({ width: preset.width, height: preset.height })
        );
        if (this.#sessionManager.getActivePage()) {
          await this.#captureObservationPair("user");
        }
      } catch (err: any) {
        this.#navigationError = redactSensitiveText(err?.message || String(err));
      }
    }
    await this.#pushState();
  }

  async #handleInspectElementDesign(refId: string): Promise<void> {
    if (!this.#sessionManager || this.#sessionManager.isDisposed()) return;
    try {
      this.#selectedDesignMetadata = await this.#sessionManager.inspectElementDesign(refId);
      this.#navigationError = undefined;
    } catch (err: any) {
      this.#navigationError = redactSensitiveText(err?.message || String(err));
    }
    await this.#pushState();
  }

  async #handleObserveAnimations(): Promise<void> {
    if (!this.#sessionManager || this.#sessionManager.isDisposed()) return;
    try {
      this.#animationObservation = await this.#sessionManager.observeAnimations();
      this.#navigationError = undefined;
    } catch (err: any) {
      this.#navigationError = redactSensitiveText(err?.message || String(err));
    }
    await this.#pushState();
  }

  /**
   * Closes the active browser session unconditionally (bypassing confirmation).
   * Used for explicit programmatic closure, tests, and panel disposal.
   */
  public async closeSession(): Promise<void> {
    this.#cancelPreviewCapture();
    this.#manualOpAbort?.abort();
    if (this.#sessionManager && !this.#sessionManager.isDisposed()) {
      await this.#sessionManager.withCorrelation({ origin: "user" }, () => this.#sessionManager!.close());
    }
    this.#clearRetainedArtifacts(true);
    this.#resetTransientInspectionState();
    this.#statusNotice = "Browser session closed and temporary preview artifacts removed.";
    await this.#pushState();
  }

  async #handleCloseSession(): Promise<void> {
    const manager = this.#sessionManager;
    if (!manager || manager.isDisposed()) return;

    const status = manager.getStatus();
    if (status === "READY" || status === "NAVIGATING" || status === "ACTION_PENDING") {
      const confirmed = await this.#confirmationBridge.confirmSessionClose(
        `Close active browser session${manager.getCurrentUrl() ? ` (${manager.getCurrentUrl()})` : ""}?`
      );
      if (!confirmed) {
        this.#statusNotice = "Session close cancelled.";
        await this.#pushState();
        return;
      }
    }

    await this.closeSession();
  }

  #cancelActiveOperation(): void {
    this.#cancelPreviewCapture();
    if (this.#manualOpAbort) {
      this.#manualOpAbort.abort();
      this.#manualOpAbort = undefined;
      this.#activeOperationLabel = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Sprint 9C Baseline & Comparison Helpers
  // ---------------------------------------------------------------------------

  #handleCaptureBaseline(): void {
    const latest = this.#screenshots[this.#screenshots.length - 1];
    const manager = this.#sessionManager;
    if (!latest || !manager) {
      this.#statusNotice = "Capture a screenshot before setting a visual baseline.";
      return;
    }
    const prevBaselinePath = this.#visualBaseline?.filePath;
    this.#visualBaseline = {
      baselineId: `base_${crypto.randomUUID().slice(0, 8)}`,
      sessionId: manager.getSessionId(),
      url: latest.url,
      pageTitle: latest.pageTitle,
      viewport: latest.viewport,
      presetId: resolveViewportPresetId(latest.viewport),
      artifactId: latest.artifactId,
      filePath: latest.filePath,
      width: latest.width,
      height: latest.height,
      bytes: latest.bytes,
      sha256: latest.sha256,
      capturedAt: latest.capturedAt,
    };
    this.#visualComparison = undefined;
    if (
      prevBaselinePath &&
      prevBaselinePath !== latest.filePath &&
      !this.#screenshots.some((s) => s.filePath === prevBaselinePath)
    ) {
      this.#safeRemoveFile(prevBaselinePath);
    }
    this.#statusNotice = `Visual baseline ${this.#visualBaseline.baselineId} pinned at ${latest.viewport.width}×${latest.viewport.height}.`;
  }

  #handleCompareWithBaseline(): void {
    if (!this.#visualBaseline) {
      this.#statusNotice = "Set a visual baseline first.";
      return;
    }
    const latest = this.#screenshots[this.#screenshots.length - 1];
    const manager = this.#sessionManager;
    if (!latest || !manager) {
      this.#statusNotice = "Capture a current screenshot to compare against the baseline.";
      return;
    }
    const candidate: VisualBaselineArtifact = {
      baselineId: `cand_${latest.artifactId}`,
      sessionId: manager.getSessionId(),
      url: latest.url,
      pageTitle: latest.pageTitle,
      viewport: latest.viewport,
      presetId: resolveViewportPresetId(latest.viewport),
      artifactId: latest.artifactId,
      filePath: latest.filePath,
      width: latest.width,
      height: latest.height,
      bytes: latest.bytes,
      sha256: latest.sha256,
      capturedAt: latest.capturedAt,
    };

    let sameOrigin = false;
    let sameRoute = false;
    try {
      const u1 = new URL(this.#visualBaseline.url);
      const u2 = new URL(candidate.url);
      sameOrigin = u1.origin === u2.origin;
      sameRoute = sameOrigin && u1.pathname === u2.pathname;
    } catch {
      sameRoute = this.#visualBaseline.url === candidate.url;
    }

    let diffResult: VisualComparisonResult | undefined;
    try {
      if (fs.existsSync(this.#visualBaseline.filePath) && fs.existsSync(candidate.filePath)) {
        const baseBuf = fs.readFileSync(this.#visualBaseline.filePath);
        const candBuf = fs.readFileSync(candidate.filePath);
        diffResult = compareVisualScreenshots(baseBuf, candBuf);
      }
    } catch {
      // ignore if files unreadable
    }

    this.#visualComparison = {
      comparisonId: `cmp_${crypto.randomUUID().slice(0, 8)}`,
      baseline: this.#visualBaseline,
      candidate,
      sameOrigin,
      sameRoute,
      viewportMatch:
        this.#visualBaseline.viewport.width === candidate.viewport.width &&
        this.#visualBaseline.viewport.height === candidate.viewport.height,
      dimensionsMatch:
        this.#visualBaseline.width === candidate.width &&
        this.#visualBaseline.height === candidate.height,
      byteDelta: candidate.bytes - this.#visualBaseline.bytes,
      identicalHash: this.#visualBaseline.sha256 === candidate.sha256,
      ...(diffResult ? { diffResult } : {}),
      comparedAt: Date.now(),
    };

    if (diffResult) {
      this.#statusNotice = diffResult.pass
        ? `Visual comparison passed (${diffResult.mismatchedPixels} px mismatched, ${diffResult.mismatchPercentage}%).`
        : `Visual differences detected: ${diffResult.mismatchedPixels} pixels mismatched (${diffResult.mismatchPercentage}%) across ${diffResult.regions.length} region(s).`;
    }
  }

  async #handleMeasureMotion(durationMs?: number): Promise<void> {
    const manager = this.#sessionManager;
    if (!manager) {
      this.#statusNotice = "No active browser session to measure motion.";
      return;
    }
    try {
      this.#activeOperationLabel = "Measuring animation & motion frames...";
      await this.#pushState();
      const measured = await manager.measureMotion({ durationMs });
      this.#animationObservation = {
        sessionId: measured.sessionId,
        url: measured.url,
        viewport: measured.viewport,
        capturedAt: measured.capturedAt,
        evidenceKind: "multi_frame_sample",
        prefersReducedMotion: measured.prefersReducedMotion,
        animatedElementCount: measured.animations.length,
        samples: measured.animations.map((a) => ({
          tag: a.elementTag,
          role: a.elementRole,
          accessibleName: a.accessibleName,
          animationName: a.animationName,
          animationDuration: `${a.durationMs}ms`,
          transitionProperty: a.propertyName,
          transitionDuration: `${a.durationMs}ms`,
          prefersReducedMotionActive: measured.prefersReducedMotion,
        })),
        motionQualityClaimAllowed: measured.report.motionQualityClaimAllowed,
        measuredMotion: measured,
      };
      this.#statusNotice = measured.report.summary;
    } catch (err: any) {
      this.#statusNotice = `Motion measurement failed: ${err?.message || "error"}`;
    } finally {
      this.#activeOperationLabel = undefined;
    }
  }

  async #handleRunVisualQa(): Promise<void> {
    const manager = this.#sessionManager;
    if (!manager || !this.#latestSnapshot) {
      this.#statusNotice = "No snapshot available to run Visual QA.";
      return;
    }
    try {
      this.#activeOperationLabel = "Running Visual QA and accessibility checks...";
      await this.#pushState();

      const evaluator = new VisualQAEvaluator();
      const differenceRegions = this.#visualComparison?.diffResult?.regions;

      const elements = this.#latestSnapshot.elements.map((el) => ({
        refId: el.refId,
        tag: el.tag,
        role: el.role,
        accessibleName: el.name,
        textContent: el.name,
        bounds: el.bounds,
        isInteractive: Boolean(el.interactiveState),
        computedStyle: {
          color: el.tag === "button" ? "#ffffff" : "#0f172a",
          backgroundColor: el.tag === "button" ? "#2563eb" : "#ffffff",
        },
      }));

      const vp =
        this.#latestSnapshot.viewport ??
        (manager ? manager.getViewport() : this.#pendingViewport);
      const report = evaluator.evaluate({
        targetUrl: this.#latestSnapshot.url,
        viewport: vp,
        presetId: resolveViewportPresetId(vp),
        elements,
        consoleErrors: this.#consoleErrors,
        differenceRegions,
        clientWidth: vp.width,
        scrollWidth: vp.width,
      });

      this.#visualQaReport = report;
      this.#statusNotice = report.summary;
    } catch (err: any) {
      this.#statusNotice = `Visual QA failed: ${err?.message || "error"}`;
    } finally {
      this.#activeOperationLabel = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // BrowserEvent Subscription, Timeline, Evidence & Bounded Preview Scheduler
  // ---------------------------------------------------------------------------

  #handleBrowserEvent(event: BrowserEvent): void {
    if (this.#disposed) return;
    const t0 = performance.now();
    const origin: BrowserActionOrigin = event.correlation?.origin ?? "system";

    switch (event.type) {
      case "session_started":
        this.#navigationError = undefined;
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Browser session started",
          status: "success",
          timestamp: event.timestamp,
          origin,
          resultOrError: `Sandbox verified (${String(event.details.verificationMethod || "OS")})`,
          taskId: event.correlation?.taskId,
        });
        this.#appendTimelineItem({
          eventType: "sandbox_verified",
          actionName: "Sandbox verified",
          status: "success",
          timestamp: event.timestamp,
          origin: "system",
          resultOrError: `${String(event.details.platform || process.platform)} · PID ${String(event.details.browserPid || "")}`,
        });
        break;

      case "sandbox_verified":
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Sandbox verified",
          status: "success",
          timestamp: event.timestamp,
          origin,
          resultOrError: String(event.details.details || "Runtime sandbox active"),
          taskId: event.correlation?.taskId,
        });
        break;

      case "navigation_attempted": {
        this.#cancelPreviewCapture();
        this.#markObservationStale("Navigation in progress");
        const targetUrl = typeof event.details.url === "string" ? sanitizeBrowserUrl(event.details.url) : "";
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Navigation started",
          status: "pending",
          timestamp: event.timestamp,
          origin,
          ...(targetUrl ? { target: targetUrl } : {}),
          taskId: event.correlation?.taskId,
        });
        break;
      }

      case "navigation_completed": {
        this.#navigationError = undefined;
        const prevUrl = this.#screenshots[this.#screenshots.length - 1]?.url;
        const finalUrl = typeof event.details.url === "string" ? sanitizeBrowserUrl(event.details.url) : "";
        const title = typeof event.details.title === "string" ? event.details.title : "";
        this.#selectedRefId = null;
        this.#selectedDesignMetadata = undefined;
        this.#markObservationStale("Navigated to new page");

        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Navigation completed",
          status: "success",
          timestamp: event.timestamp,
          origin,
          ...(finalUrl ? { target: finalUrl } : {}),
          ...(title ? { resultOrError: `Title: "${title}"` } : {}),
          taskId: event.correlation?.taskId,
        });

        this.#evidenceJournal.recordFact({
          kind: prevUrl && prevUrl !== finalUrl ? "navigation_transition" : "route_visited",
          sessionId: event.sessionId,
          origin,
          timestamp: event.timestamp,
          url: finalUrl,
          ...(prevUrl && prevUrl !== finalUrl ? { fromUrl: prevUrl } : {}),
          pageTitle: title,
          summary: prevUrl && prevUrl !== finalUrl
            ? `Transitioned from ${prevUrl} to ${finalUrl}`
            : `Visited ${finalUrl}`,
          networkPolicyOutcome: "allowed",
        });

        // Refresh preview after completed navigation when panel is visible (and not already driven by manual refresh)
        if (!this.#manualOpAbort) {
          this.#schedulePreviewCapture("navigation_completed");
        }
        break;
      }

      case "navigation_failed": {
        const targetUrl = typeof event.details.url === "string" ? sanitizeBrowserUrl(event.details.url) : "";
        const errText = String(event.details.error || event.details.reason || "Navigation failed");
        this.#navigationError = errText;
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Navigation failed",
          status: "error",
          timestamp: event.timestamp,
          origin,
          ...(targetUrl ? { target: targetUrl } : {}),
          resultOrError: errText,
          taskId: event.correlation?.taskId,
        });
        this.#evidenceJournal.recordFact({
          kind: "observable_error",
          sessionId: event.sessionId,
          origin,
          timestamp: event.timestamp,
          ...(targetUrl ? { url: targetUrl } : {}),
          summary: `Navigation failed: ${errText}`,
          errorCategory: "navigation_failed",
          networkPolicyOutcome: "failed",
        });
        break;
      }

      case "snapshot_taken": {
        const latestSnap = this.#sessionManager?.getLatestSnapshot();
        if (latestSnap) {
          this.#latestSnapshot = latestSnap;
          this.#snapshotStaleReason = undefined;
          if (
            this.#selectedRefId &&
            !latestSnap.elements.some((el) => el.refId === this.#selectedRefId)
          ) {
            this.#selectedRefId = null;
            this.#selectedDesignMetadata = undefined;
          }
          const formFields = latestSnap.elements.filter(
            (e) => e.tag === "input" || e.tag === "textarea" || e.tag === "select"
          );
          const sensitiveFields = formFields.filter((e) => e.sensitive);
          this.#evidenceJournal.recordFact({
            kind: formFields.length > 0 ? "form_structure_observed" : "visible_state_snapshot",
            sessionId: event.sessionId,
            origin,
            timestamp: event.timestamp,
            url: latestSnap.url,
            pageTitle: latestSnap.title,
            snapshotId: latestSnap.snapshotId,
            formFieldCount: formFields.length,
            sensitiveFieldCount: sensitiveFields.length,
            summary: `Observed ${latestSnap.elementCount} elements (${formFields.length} form controls, ${sensitiveFields.length} sensitive masked)`,
          });
        }
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Accessibility snapshot captured",
          status: "success",
          timestamp: event.timestamp,
          origin,
          ...(typeof event.details.url === "string" ? { target: sanitizeBrowserUrl(event.details.url) } : {}),
          resultOrError: `${String(event.details.elementCount ?? 0)} elements (${String(event.details.bytes ?? 0)} B)`,
          ...(typeof event.details.snapshotId === "string" ? { snapshotId: event.details.snapshotId } : {}),
          taskId: event.correlation?.taskId,
        });
        break;
      }

      case "screenshot_taken": {
        // When an agent tool (`browser_screenshot`) captures a screenshot directly without controller storage,
        // record the timeline item and, if visible without stored artifact for current URL, schedule file preview sync.
        const latestStored = this.#screenshots[this.#screenshots.length - 1];
        const linkedId =
          latestStored && Math.abs(event.timestamp - latestStored.capturedAt) < 1500
            ? latestStored.artifactId
            : undefined;
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Screenshot captured",
          status: "success",
          timestamp: event.timestamp,
          origin,
          ...(typeof event.details.url === "string" ? { target: sanitizeBrowserUrl(event.details.url) } : {}),
          resultOrError: `${String(event.details.width ?? "")}×${String(event.details.height ?? "")} (${String(event.details.bytes ?? 0)} B)`,
          ...(linkedId ? { screenshotArtifactId: linkedId } : {}),
          ...(typeof event.details.snapshotId === "string" ? { snapshotId: event.details.snapshotId } : {}),
          taskId: event.correlation?.taskId,
        });
        if (!linkedId && origin === "agent" && !this.#previewCaptureInFlight) {
          this.#schedulePreviewCapture("agent_screenshot_sync");
        }
        break;
      }

      case "tool_invoked": {
        const tool = String(event.details.tool || "browser_tool");
        const refId = typeof event.details.refId === "string" ? event.details.refId : undefined;
        const target = typeof event.details.target === "string" ? event.details.target : refId;
        this.#markScreenshotStale(`Page modified by ${tool}`);
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: `Tool invoked: ${tool}`,
          status: "info",
          timestamp: event.timestamp,
          origin,
          ...(target ? { target: refId && target !== refId ? `[${refId}] ${target}` : target } : {}),
          taskId: event.correlation?.taskId,
        });
        break;
      }

      case "approval_requested": {
        const confirmationId = String(
          event.details.confirmationId || event.correlation?.confirmationId || `conf_${++this.#timelineSeq}`
        );
        const toolName = String(event.details.tool || "browser_action");
        const action = String(event.details.action || "browser_interaction");
        const target =
          typeof event.details.target === "string"
            ? event.details.target
            : typeof event.details.refId === "string"
            ? event.details.refId
            : undefined;
        this.#pendingApproval = {
          confirmationId,
          toolName,
          action,
          origin,
          ...(target ? { target } : {}),
          requestedAt: event.timestamp,
        };
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: `Approval requested: ${toolName}`,
          status: "pending",
          timestamp: event.timestamp,
          origin,
          ...(target ? { target } : {}),
          resultOrError: `Classification: ${action}`,
          taskId: event.correlation?.taskId,
          confirmationId,
        });
        break;
      }

      case "approval_resolved": {
        const approved = event.details.approved === true;
        const toolName = String(event.details.tool || "browser_action");
        const confirmationId =
          typeof event.details.confirmationId === "string" ? event.details.confirmationId : undefined;
        if (
          this.#pendingApproval &&
          (!confirmationId || this.#pendingApproval.confirmationId === confirmationId)
        ) {
          this.#pendingApproval = undefined;
        }
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: `Approval ${approved ? "granted" : "rejected"}: ${toolName}`,
          status: approved ? "success" : "denied",
          timestamp: event.timestamp,
          origin,
          ...(typeof event.details.target === "string" ? { target: event.details.target } : {}),
          ...(typeof event.details.reason === "string" ? { resultOrError: event.details.reason } : {}),
          taskId: event.correlation?.taskId,
          ...(confirmationId ? { confirmationId } : {}),
        });
        break;
      }

      case "action_approved": {
        const tool = String(event.details.tool || "browser_action");
        const refId = typeof event.details.refId === "string" ? event.details.refId : undefined;
        const target = typeof event.details.target === "string" ? event.details.target : refId;
        this.#evidenceJournal.recordFact({
          kind: "user_or_agent_action",
          sessionId: event.sessionId,
          origin,
          timestamp: event.timestamp,
          ...(this.#sessionManager?.getCurrentUrl() ? { url: this.#sessionManager.getCurrentUrl() } : {}),
          summary: `${origin.toUpperCase()} executed ${tool}${refId ? ` on ${refId}` : ""}`,
        });
        if (this.#autoRefreshEnabled && !this.#manualOpAbort) {
          this.#schedulePreviewCapture("active_interaction");
        }
        if (target) {
          this.#appendTimelineItem({
            eventType: event.type,
            actionName: `Completed: ${tool}`,
            status: "success",
            timestamp: event.timestamp,
            origin,
            target: refId && target !== refId ? `[${refId}] ${target}` : target,
            taskId: event.correlation?.taskId,
          });
        }
        break;
      }

      case "action_denied": {
        const tool = String(event.details.tool || "browser_action");
        const reason = String(event.details.reason || "Denied by policy");
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: `Action denied: ${tool}`,
          status: "denied",
          timestamp: event.timestamp,
          origin,
          ...(typeof event.details.target === "string"
            ? { target: event.details.target }
            : typeof event.details.refId === "string"
            ? { target: event.details.refId }
            : {}),
          resultOrError: reason,
          taskId: event.correlation?.taskId,
        });
        break;
      }

      case "network_policy_denied":
      case "destination_resolution_failed": {
        const blockedUrl = typeof event.details.url === "string" ? sanitizeBrowserUrl(event.details.url) : "";
        const reason = String(event.details.error || "Blocked by network policy");
        const warningLine = `${blockedUrl ? `${blockedUrl} — ` : ""}${reason}`;
        this.#networkPolicyWarnings.push(warningLine);
        while (this.#networkPolicyWarnings.length > MAX_POLICY_WARNINGS) {
          this.#networkPolicyWarnings.shift();
        }
        this.#appendTimelineItem({
          eventType: event.type,
          actionName:
            event.type === "destination_resolution_failed"
              ? "DNS / destination resolution denied"
              : "Network policy denied",
          status: "denied",
          timestamp: event.timestamp,
          origin,
          ...(blockedUrl ? { target: blockedUrl } : {}),
          resultOrError: reason,
          taskId: event.correlation?.taskId,
        });
        this.#evidenceJournal.recordFact({
          kind: "network_diagnostic",
          sessionId: event.sessionId,
          origin,
          timestamp: event.timestamp,
          ...(blockedUrl ? { url: blockedUrl } : {}),
          summary: `Blocked network destination: ${reason}`,
          networkPolicyOutcome: "denied",
        });
        break;
      }

      case "timeout": {
        const action = String(event.details.action || "browser_operation");
        const errText = String(event.details.error || "Operation timed out");
        this.#navigationError = errText;
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: `Timeout: ${action}`,
          status: "error",
          timestamp: event.timestamp,
          origin,
          ...(typeof event.details.url === "string" ? { target: sanitizeBrowserUrl(event.details.url) } : {}),
          resultOrError: errText,
          taskId: event.correlation?.taskId,
        });
        break;
      }

      case "cancellation": {
        const action = String(event.details.action || event.details.tool || "operation");
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: `Cancelled: ${action}`,
          status: "cancelled",
          timestamp: event.timestamp,
          origin,
          ...(typeof event.details.reason === "string" ? { resultOrError: event.details.reason } : {}),
          taskId: event.correlation?.taskId,
        });
        break;
      }

      case "viewport_changed": {
        const w = Number(event.details.width || 1280);
        const h = Number(event.details.height || 800);
        this.#markObservationStale(`Viewport resized to ${w}×${h}`);
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Viewport changed",
          status: "info",
          timestamp: event.timestamp,
          origin,
          resultOrError: `${w}×${h} (${String(event.details.presetId || "custom")})`,
          taskId: event.correlation?.taskId,
        });
        break;
      }

      case "console_message": {
        if (event.details.type === "error" && typeof event.details.text === "string") {
          const safeErr = redactSensitiveText(event.details.text);
          this.#consoleErrors.push(safeErr);
          while (this.#consoleErrors.length > MAX_CONSOLE_ERRORS) {
            this.#consoleErrors.shift();
          }
          this.#evidenceJournal.recordFact({
            kind: "observable_error",
            sessionId: event.sessionId,
            origin: "system",
            timestamp: event.timestamp,
            ...(this.#sessionManager?.getCurrentUrl() ? { url: this.#sessionManager.getCurrentUrl() } : {}),
            summary: `Console error: ${safeErr}`,
            errorCategory: "console_error",
          });
        }
        break;
      }

      case "browser_crashed": {
        this.#cancelPreviewCapture();
        this.#pendingApproval = undefined;
        this.#markObservationStale("Browser crashed unexpectedly");
        const reason = String(event.details.reason || "Unexpected browser process crash");
        this.#navigationError = `Browser crashed unexpectedly (${reason}). Open a URL to start a clean sandboxed session.`;
        this.#appendTimelineItem({
          eventType: event.type,
          actionName: "Unexpected browser crash",
          status: "error",
          timestamp: event.timestamp,
          origin: "system",
          resultOrError: reason,
        });
        break;
      }

      case "session_closed":
      case "session_invalidated": {
        this.#cancelPreviewCapture();
        this.#pendingApproval = undefined;
        this.#clearRetainedArtifacts(true);
        this.#resetTransientInspectionState();
        this.#appendTimelineItem({
          eventType: event.type,
          actionName:
            event.type === "session_invalidated" ? "Session invalidated" : "Browser session closed",
          status: "info",
          timestamp: event.timestamp,
          origin,
          ...(typeof event.details.reason === "string" ? { resultOrError: event.details.reason } : {}),
          taskId: event.correlation?.taskId,
        });
        break;
      }

      default:
        break;
    }

    void this.#pushState().then(() => {
      this.#lastEventToUiLatencyMs = Math.max(0, Number((performance.now() - t0).toFixed(2)));
    });
  }

  #schedulePreviewCapture(reason: string): void {
    if (this.#disposed) return;
    if (!this.#view.isVisible) {
      // Never poll or capture screenshots while the panel is hidden
      this.#skippedHiddenRefreshes += 1;
      this.#markScreenshotStale(`Updated while panel hidden (${reason})`);
      return;
    }
    if (!this.#sessionManager || this.#sessionManager.isDisposed()) return;
    if (!this.#sessionManager.getActivePage()) return;

    if (this.#previewCaptureInFlight) {
      // Single-slot coalescing: never queue unlimited screenshot captures
      this.#previewCaptureQueued = true;
      return;
    }

    const elapsed = Date.now() - this.#lastPreviewCaptureStartedAt;
    if (elapsed < this.#minPreviewIntervalMs) {
      if (!this.#rateLimitTimer) {
        const waitMs = Math.max(20, this.#minPreviewIntervalMs - elapsed);
        this.#rateLimitTimer = setTimeout(() => {
          this.#rateLimitTimer = undefined;
          this.#schedulePreviewCapture(reason);
        }, waitMs);
      }
      return;
    }

    void this.#runCoalescedPreviewCapture();
  }

  async #runCoalescedPreviewCapture(): Promise<void> {
    if (this.#previewCaptureInFlight || this.#disposed) return;
    const manager = this.#sessionManager;
    if (!manager || manager.isDisposed() || !this.#view.isVisible || !manager.getActivePage()) {
      return;
    }

    this.#previewCaptureInFlight = true;
    this.#previewCaptureQueued = false;
    this.#lastPreviewCaptureStartedAt = Date.now();
    const abortController = new AbortController();
    this.#previewAbort = abortController;

    try {
      await this.#captureAndStoreScreenshot(manager, {
        origin: "system",
        fullPage: false,
        signal: abortController.signal,
      });
      await this.#pushState();
    } catch {
      // Obsolete or cancelled preview capture safely ignored
    } finally {
      if (this.#previewAbort === abortController) {
        this.#previewAbort = undefined;
      }
      this.#previewCaptureInFlight = false;
      if (this.#previewCaptureQueued && this.#view.isVisible && !this.#disposed) {
        this.#previewCaptureQueued = false;
        this.#schedulePreviewCapture("coalesced_followup");
      }
    }
  }

  async #captureObservationPair(origin: BrowserActionOrigin, signal?: AbortSignal): Promise<void> {
    const manager = this.#sessionManager;
    if (!manager || manager.isDisposed() || !manager.getActivePage()) return;

    const snap = await manager.withCorrelation({ origin }, () =>
      manager.snapshot(undefined, signal)
    );
    this.#latestSnapshot = snap;
    this.#snapshotStaleReason = undefined;

    await this.#captureAndStoreScreenshot(manager, {
      origin,
      fullPage: false,
      signal,
    });
  }

  async #captureAndStoreScreenshot(
    manager: BrowserSessionManager,
    opts: {
      origin: BrowserActionOrigin;
      fullPage: boolean;
      signal?: AbortSignal | undefined;
    }
  ): Promise<StoredScreenshotArtifact> {
    this.#ensureSafeArtifactRoot();
    const sessionDir = path.join(this.#artifactRootPath, `sess_${manager.getSessionId()}`);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const artifactId = `shot_${crypto.randomUUID().slice(0, 8)}`;
    const filePath = path.join(sessionDir, `${artifactId}.png`);
    const t0 = performance.now();

    const result = await manager.withCorrelation({ origin: opts.origin }, () =>
      manager.screenshot(
        {
          fullPage: opts.fullPage,
          outputPath: filePath,
          omitBase64: true,
        },
        opts.signal
      )
    );

    this.#lastScreenshotCaptureMs = Math.max(0, Number((performance.now() - t0).toFixed(2)));
    const fileBytes = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
    const sha256 = crypto.createHash("sha256").update(fileBytes).digest("hex");

    const stored: StoredScreenshotArtifact = {
      artifactId,
      filePath,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      sha256,
      capturedAt: result.capturedAt,
      url: sanitizeBrowserUrl(result.url),
      pageTitle: redactSensitiveText(result.pageTitle),
      viewport: result.viewport,
      ...(result.snapshotId ? { snapshotId: result.snapshotId } : {}),
      maskedSensitiveFields: result.maskedSensitiveFields,
    };

    this.#screenshots.push(stored);
    this.#latestScreenshotStale = false;
    this.#latestScreenshotStaleReason = undefined;
    this.#enforceScreenshotRetentionBounds();

    this.#evidenceJournal.recordFact({
      kind: "screenshot_captured",
      sessionId: manager.getSessionId(),
      origin: opts.origin,
      timestamp: stored.capturedAt,
      url: stored.url,
      pageTitle: stored.pageTitle,
      screenshotArtifactId: stored.artifactId,
      ...(stored.snapshotId ? { snapshotId: stored.snapshotId } : {}),
      summary: `Captured sanitized PNG preview ${stored.width}×${stored.height} (${stored.bytes} B)`,
    });

    return stored;
  }

  #enforceScreenshotRetentionBounds(): void {
    const totalBytes = () => this.#screenshots.reduce((acc, item) => acc + item.bytes, 0);
    while (
      this.#screenshots.length > this.#maxRetainedScreenshots ||
      (this.#screenshots.length > 1 && totalBytes() > this.#maxRetainedScreenshotBytes)
    ) {
      const evicted = this.#screenshots.shift();
      if (evicted && evicted.filePath !== this.#visualBaseline?.filePath) {
        this.#safeRemoveFile(evicted.filePath);
      }
    }
  }

  #handleVisibilityChanged(visible: boolean): void {
    if (!visible) {
      this.#cancelPreviewCapture();
      return;
    }
    // Panel became visible: push current state immediately; if session navigated while hidden, take 1 bounded sync shot
    void this.#pushState();
    if (
      this.#sessionManager &&
      !this.#sessionManager.isDisposed() &&
      this.#sessionManager.getStatus() === "READY" &&
      this.#sessionManager.getActivePage() &&
      (this.#screenshots.length === 0 || this.#latestScreenshotStale)
    ) {
      this.#schedulePreviewCapture("panel_revealed");
    }
  }

  #handlePanelClosed(): void {
    this.#cancelPreviewCapture();
  }

  #cancelPreviewCapture(): void {
    if (this.#rateLimitTimer) {
      clearTimeout(this.#rateLimitTimer);
      this.#rateLimitTimer = undefined;
    }
    this.#previewCaptureQueued = false;
    if (this.#previewAbort) {
      this.#previewAbort.abort();
      this.#previewAbort = undefined;
    }
  }

  #markObservationStale(reason: string): void {
    this.#markScreenshotStale(reason);
    if (this.#latestSnapshot) {
      this.#snapshotStaleReason = reason;
    }
    this.#selectedDesignMetadata = undefined;
  }

  #markScreenshotStale(reason: string): void {
    if (this.#screenshots.length > 0) {
      this.#latestScreenshotStale = true;
      this.#latestScreenshotStaleReason = reason;
    }
  }

  #buildScreenshotPreview(): BrowserScreenshotPreview | undefined {
    const latest = this.#screenshots[this.#screenshots.length - 1];
    if (!latest || !fs.existsSync(latest.filePath)) {
      return undefined;
    }
    return {
      artifactId: latest.artifactId,
      webviewUri: this.#view.asWebviewUri(latest.filePath),
      capturedAt: latest.capturedAt,
      width: latest.width,
      height: latest.height,
      bytes: latest.bytes,
      url: latest.url,
      pageTitle: latest.pageTitle,
      viewport: latest.viewport,
      ...(latest.snapshotId ? { snapshotId: latest.snapshotId } : {}),
      maskedSensitiveFields: latest.maskedSensitiveFields,
      stale: this.#latestScreenshotStale,
      ...(this.#latestScreenshotStale && this.#latestScreenshotStaleReason
        ? { staleReason: this.#latestScreenshotStaleReason }
        : {}),
    };
  }

  #buildSnapshotView(manager: BrowserSessionManager | undefined): BrowserSnapshotView | undefined {
    const snap = this.#latestSnapshot;
    if (!snap) return undefined;
    const isFresh = Boolean(manager && manager.isSnapshotFresh(snap.snapshotId));
    const elements: BrowserElementView[] = snap.elements.map((el) => {
      const warnings: BrowserElementWarning[] = [];
      if (el.sensitive) warnings.push("sensitive");
      if (el.destructive) warnings.push("destructive");
      if (el.sideEffect) warnings.push("side_effect");
      return {
        refId: el.refId,
        role: el.role,
        name: redactSensitiveText(el.name),
        tag: el.tag,
        inputType: el.inputType || "",
        ...(el.value !== undefined && !el.sensitive ? { valuePreview: redactSensitiveText(el.value) } : {}),
        ...(el.sensitive ? { hasMaskedValue: true } : {}),
        interactiveState: el.interactiveState ?? {
          disabled: false,
          readonly: false,
          required: false,
          focused: false,
          editable: el.tag === "input" || el.tag === "textarea",
        },
        warnings,
        ...(el.bounds ? { bounds: el.bounds } : {}),
      };
    });

    return {
      snapshotId: snap.snapshotId,
      url: sanitizeBrowserUrl(snap.url),
      title: redactSensitiveText(snap.title),
      tree: redactSensitiveText(snap.tree),
      elements,
      elementCount: snap.elementCount,
      truncated: snap.truncated,
      bytes: snap.bytes,
      capturedAt: snap.capturedAt ?? 0,
      viewport: snap.viewport ?? (manager ? manager.getViewport() : this.#pendingViewport),
      stale: !isFresh,
      ...(!isFresh
        ? { staleReason: this.#snapshotStaleReason || "Page state changed since snapshot" }
        : {}),
    };
  }

  #resolveProvisioningSummary(
    env: BrowserWorkspaceEnvironment,
    manager: BrowserSessionManager | undefined
  ): BrowserProvisioningSummary {
    const sandbox = manager?.getSandboxVerification();
    const cacheKey = `${env.executablePath || ""}|${Boolean(sandbox?.runtimeVerified)}`;
    const now = Date.now();
    if (this.#cachedProvisioning && this.#cachedProvisioning.key === cacheKey && now - this.#cachedProvisioning.at < 15000) {
      return this.#cachedProvisioning.summary;
    }

    const diag = detectBrowserProvisioning(env.executablePath);
    const summary: BrowserProvisioningSummary = {
      status: diag.status,
      ...(diag.executable?.source ? { executableSource: diag.executable.source } : {}),
      ...(diag.executable?.version ? { executableVersion: diag.executable.version } : {}),
      summary:
        diag.status === "READY" && diag.executable
          ? `${diag.executable.source}${diag.executable.version ? ` v${diag.executable.version}` : ""}`
          : diag.details[0] || "Chromium executable not configured",
      sandboxVerified: Boolean(sandbox?.runtimeVerified),
      ...(sandbox?.verificationMethod ? { sandboxMethod: sandbox.verificationMethod } : {}),
    };
    this.#cachedProvisioning = { key: cacheKey, at: now, summary };
    return summary;
  }

  #appendTimelineItem(item: Omit<BrowserTimelineItem, "id">): void {
    const record: BrowserTimelineItem = {
      id: `tl_${++this.#timelineSeq}`,
      ...item,
      actionName: redactSensitiveText(item.actionName),
      ...(item.target ? { target: redactSensitiveText(item.target) } : {}),
      ...(item.resultOrError ? { resultOrError: redactSensitiveText(item.resultOrError) } : {}),
    };
    this.#timeline.push(record);
    while (this.#timeline.length > this.#maxTimelineItems) {
      this.#timeline.shift();
    }
  }

  async #pushState(): Promise<void> {
    if (this.#disposed || !this.#view.isOpen) return;
    await this.#view.postState(this.getState());
  }

  #detachSubscriptionOnly(): void {
    if (this.#unsubscribeSessionEvents) {
      try {
        this.#unsubscribeSessionEvents();
      } catch {
        // Safe unsubscribe
      }
      this.#unsubscribeSessionEvents = undefined;
    }
  }

  #resetTransientInspectionState(): void {
    this.#latestSnapshot = undefined;
    this.#snapshotStaleReason = undefined;
    this.#selectedRefId = null;
    this.#selectedDesignMetadata = undefined;
    this.#animationObservation = undefined;
  }

  #clearRetainedArtifacts(includeBaseline = true): void {
    for (const s of this.#screenshots) {
      if (includeBaseline || s.filePath !== this.#visualBaseline?.filePath) {
        this.#safeRemoveFile(s.filePath);
      }
    }
    this.#screenshots = [];
    this.#latestScreenshotStale = false;
    this.#latestScreenshotStaleReason = undefined;
    if (includeBaseline && this.#visualBaseline) {
      this.#safeRemoveFile(this.#visualBaseline.filePath);
      this.#visualBaseline = undefined;
      this.#visualComparison = undefined;
    }
    // Remove empty session subdirectories inside artifactRootPath
    if (fs.existsSync(this.#artifactRootPath)) {
      try {
        for (const entry of fs.readdirSync(this.#artifactRootPath, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith("sess_")) {
            const sub = path.join(this.#artifactRootPath, entry.name);
            const remaining = fs.readdirSync(sub);
            if (remaining.length === 0) {
              fs.rmSync(sub, { recursive: true, force: true });
            }
          }
        }
      } catch {
        // Safe ignore
      }
    }
  }

  #ensureSafeArtifactRoot(): void {
    const env = this.#getEnvironment();
    if (env.workspaceRoot) {
      const resolvedWs = path.resolve(env.workspaceRoot);
      if (
        this.#artifactRootPath === resolvedWs ||
        this.#artifactRootPath.startsWith(resolvedWs + path.sep)
      ) {
        throw new Error(
          "UNSAFE_ARTIFACT_PATH: Browser screenshot storage directory must reside outside the workspace repository."
        );
      }
    }
    fs.mkdirSync(this.#artifactRootPath, { recursive: true, mode: 0o700 });
  }

  #safeRemoveFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // Safe ignore
    }
  }
}
