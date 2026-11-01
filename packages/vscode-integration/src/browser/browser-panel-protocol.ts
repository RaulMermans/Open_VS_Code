/**
 * Typed, validated protocol and sanitized view-state contracts for the
 * Open VS Code Browser WebviewPanel (Sprint 9B / ADR-040).
 *
 * Security invariants:
 *   - Strict inbound command allowlist (zero JS eval, zero CDP, zero cookie export,
 *     zero arbitrary filesystem authority).
 *   - Prototype pollution keys (`__proto__`, `constructor`, `prototype`) are rejected.
 *   - Outbound state contains only sanitized URLs, titles, element names, and
 *     `asWebviewUri(...)` references to private outside-repository PNG files.
 *   - Never embeds large base64 screenshot payloads into persistent state.
 */

import type {
  AnimationObservation,
  BeforeAfterComparison,
  BrowserActionOrigin,
  BrowserProvisioningStatus,
  BrowserSessionStatus,
  BrowserViewportDimensions,
  ElementBoundingBox,
  ElementDesignMetadata,
  ElementInteractiveState,
  ObservationEvidenceSnapshot,
  ViewportPresetId,
  VisualBaselineArtifact,
} from "@open-vs-code/agent-core";

export type BrowserZoomMode = "fit" | "actual";

export type BrowserTimelineStatus =
  | "info"
  | "pending"
  | "success"
  | "denied"
  | "error"
  | "cancelled";

export interface BrowserTimelineItem {
  readonly id: string;
  readonly eventType: string;
  readonly actionName: string;
  readonly status: BrowserTimelineStatus;
  readonly timestamp: number;
  readonly origin: BrowserActionOrigin;
  readonly target?: string;
  readonly resultOrError?: string;
  readonly screenshotArtifactId?: string;
  readonly snapshotId?: string;
  readonly taskId?: string;
  readonly confirmationId?: string;
}

export type BrowserElementWarning = "sensitive" | "destructive" | "side_effect";

export interface BrowserElementView {
  readonly refId: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly inputType: string;
  readonly valuePreview?: string;
  readonly hasMaskedValue?: boolean;
  readonly interactiveState: ElementInteractiveState;
  readonly warnings: readonly BrowserElementWarning[];
  readonly bounds?: ElementBoundingBox;
}

export interface BrowserSnapshotView {
  readonly snapshotId: string;
  readonly url: string;
  readonly title: string;
  readonly tree: string;
  readonly elements: readonly BrowserElementView[];
  readonly elementCount: number;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly capturedAt: number;
  readonly viewport: BrowserViewportDimensions;
  readonly stale: boolean;
  readonly staleReason?: string;
}

export interface BrowserScreenshotPreview {
  readonly artifactId: string;
  readonly webviewUri: string;
  readonly capturedAt: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly url: string;
  readonly pageTitle: string;
  readonly viewport: BrowserViewportDimensions;
  readonly snapshotId?: string;
  readonly maskedSensitiveFields: number;
  readonly stale: boolean;
  readonly staleReason?: string;
}

export interface BrowserIdentityIndicator {
  readonly accountId: string;
  readonly displayLabel: string;
  readonly authenticated: boolean;
  readonly sessionId?: string;
}

export interface BrowserProvisioningSummary {
  readonly status: BrowserProvisioningStatus;
  readonly executableSource?: string;
  readonly executableVersion?: string;
  readonly summary: string;
  readonly sandboxVerified: boolean;
  readonly sandboxMethod?: string;
}

export interface BrowserPendingApprovalSummary {
  readonly confirmationId: string;
  readonly toolName: string;
  readonly action: string;
  readonly origin: BrowserActionOrigin;
  readonly target?: string;
  readonly requestedAt: number;
}

export interface BrowserPanelPerformanceMetrics {
  readonly panelOpenLatencyMs: number;
  readonly lastEventToUiLatencyMs: number;
  readonly lastScreenshotCaptureMs: number;
  readonly retainedScreenshotCount: number;
  readonly retainedScreenshotBytes: number;
  readonly timelineCount: number;
  readonly skippedHiddenRefreshes: number;
}

export interface SanitizedVisualBaselineSummary {
  readonly baselineId: string;
  readonly url: string;
  readonly pageTitle: string;
  readonly viewport: BrowserViewportDimensions;
  readonly presetId: ViewportPresetId;
  readonly artifactId: string;
  readonly webviewUri: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly capturedAt: number;
}

export interface BrowserPanelState {
  readonly hasActiveSession: boolean;
  readonly sessionStatus: BrowserSessionStatus | "DISCONNECTED";
  readonly workspaceName: string;
  readonly workspaceTrusted: boolean;
  readonly activeExecutionMode: string;
  readonly allowedOrigins: readonly string[];
  readonly identity: BrowserIdentityIndicator;
  readonly provisioning: BrowserProvisioningSummary;
  readonly activeUrl: string;
  readonly pageTitle: string;
  readonly viewport: BrowserViewportDimensions;
  readonly viewportPreset: ViewportPresetId;
  readonly zoomMode: BrowserZoomMode;
  readonly autoRefreshEnabled: boolean;
  readonly activeOperationBusy: boolean;
  readonly activeOperationLabel?: string;
  readonly screenshot?: BrowserScreenshotPreview;
  readonly snapshot?: BrowserSnapshotView;
  readonly selectedRefId: string | null;
  readonly selectedDesignMetadata?: ElementDesignMetadata;
  readonly animationObservation?: AnimationObservation;
  readonly visualBaseline?: SanitizedVisualBaselineSummary;
  readonly visualComparison?: BeforeAfterComparison;
  readonly evidence: ObservationEvidenceSnapshot;
  readonly timeline: readonly BrowserTimelineItem[];
  readonly navigationError?: string;
  readonly statusNotice?: string;
  readonly networkPolicyWarnings: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly pendingApproval?: BrowserPendingApprovalSummary;
  readonly metrics: BrowserPanelPerformanceMetrics;
}

export type OutboundBrowserPanelMessage = {
  readonly type: "browserPanel.state";
  readonly state: BrowserPanelState;
};

export type InboundBrowserPanelMessage =
  | { readonly type: "browserPanel.ready" }
  | { readonly type: "browserPanel.openUrl"; readonly url: string }
  | { readonly type: "browserPanel.navigate"; readonly url: string }
  | { readonly type: "browserPanel.refreshObservation" }
  | { readonly type: "browserPanel.captureScreenshot"; readonly fullPage: boolean }
  | { readonly type: "browserPanel.inspectElements" }
  | { readonly type: "browserPanel.selectElement"; readonly refId: string | null }
  | { readonly type: "browserPanel.inspectElementDesign"; readonly refId: string }
  | { readonly type: "browserPanel.observeAnimations" }
  | { readonly type: "browserPanel.clickSelected"; readonly refId: string }
  | { readonly type: "browserPanel.fillSelected"; readonly refId: string; readonly value: string }
  | { readonly type: "browserPanel.setViewportPreset"; readonly presetId: "desktop" | "tablet" | "mobile" }
  | { readonly type: "browserPanel.setZoomMode"; readonly zoomMode: BrowserZoomMode }
  | { readonly type: "browserPanel.setAutoRefresh"; readonly enabled: boolean }
  | { readonly type: "browserPanel.cancelOperation" }
  | { readonly type: "browserPanel.closeSession" }
  | { readonly type: "browserPanel.captureBaseline" }
  | { readonly type: "browserPanel.compareWithBaseline" }
  | { readonly type: "browserPanel.toggleEvidenceRecording"; readonly enabled: boolean }
  | { readonly type: "browserPanel.clearEvidence" };

const MAX_URL_LENGTH = 2048;
const MAX_FILL_VALUE_LENGTH = 4096;
const REF_ID_RE = /^e[1-9]\d{0,4}$/;
const ALLOWED_PRESETS = new Set(["desktop", "tablet", "mobile"]);
const ALLOWED_ZOOM_MODES = new Set(["fit", "actual"]);

function hasForbiddenKeys(obj: Record<string, unknown>): boolean {
  if (
    Object.prototype.hasOwnProperty.call(obj, "__proto__") ||
    Object.prototype.hasOwnProperty.call(obj, "constructor") ||
    Object.prototype.hasOwnProperty.call(obj, "prototype")
  ) {
    return true;
  }
  return false;
}

/**
 * Validates untrusted inbound Webview messages against the strict command allowlist.
 * Returns `null` for any unknown, malformed, oversized, or dangerous command.
 */
export function parseBrowserPanelMessage(raw: unknown): InboundBrowserPanelMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const msg = raw as Record<string, unknown>;
  if (hasForbiddenKeys(msg)) {
    return null;
  }
  if (typeof msg.type !== "string") {
    return null;
  }

  switch (msg.type) {
    case "browserPanel.ready":
      return { type: "browserPanel.ready" };

    case "browserPanel.openUrl":
    case "browserPanel.navigate": {
      if (typeof msg.url !== "string") return null;
      const trimmed = msg.url.trim();
      if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
      if (/[\r\n\0]/.test(trimmed)) return null;
      return { type: msg.type, url: trimmed };
    }

    case "browserPanel.refreshObservation":
      return { type: "browserPanel.refreshObservation" };

    case "browserPanel.captureScreenshot":
      if (msg.fullPage !== undefined && typeof msg.fullPage !== "boolean") return null;
      return { type: "browserPanel.captureScreenshot", fullPage: msg.fullPage === true };

    case "browserPanel.inspectElements":
      return { type: "browserPanel.inspectElements" };

    case "browserPanel.selectElement": {
      if (msg.refId === null) {
        return { type: "browserPanel.selectElement", refId: null };
      }
      if (typeof msg.refId !== "string" || !REF_ID_RE.test(msg.refId)) {
        return null;
      }
      return { type: "browserPanel.selectElement", refId: msg.refId };
    }

    case "browserPanel.inspectElementDesign": {
      if (typeof msg.refId !== "string" || !REF_ID_RE.test(msg.refId)) {
        return null;
      }
      return { type: "browserPanel.inspectElementDesign", refId: msg.refId };
    }

    case "browserPanel.observeAnimations":
      return { type: "browserPanel.observeAnimations" };

    case "browserPanel.clickSelected": {
      if (typeof msg.refId !== "string" || !REF_ID_RE.test(msg.refId)) {
        return null;
      }
      return { type: "browserPanel.clickSelected", refId: msg.refId };
    }

    case "browserPanel.fillSelected": {
      if (typeof msg.refId !== "string" || !REF_ID_RE.test(msg.refId)) {
        return null;
      }
      if (typeof msg.value !== "string" || msg.value.length > MAX_FILL_VALUE_LENGTH) {
        return null;
      }
      return { type: "browserPanel.fillSelected", refId: msg.refId, value: msg.value };
    }

    case "browserPanel.setViewportPreset": {
      if (typeof msg.presetId !== "string" || !ALLOWED_PRESETS.has(msg.presetId)) {
        return null;
      }
      return {
        type: "browserPanel.setViewportPreset",
        presetId: msg.presetId as "desktop" | "tablet" | "mobile",
      };
    }

    case "browserPanel.setZoomMode": {
      if (typeof msg.zoomMode !== "string" || !ALLOWED_ZOOM_MODES.has(msg.zoomMode)) {
        return null;
      }
      return { type: "browserPanel.setZoomMode", zoomMode: msg.zoomMode as BrowserZoomMode };
    }

    case "browserPanel.setAutoRefresh": {
      if (typeof msg.enabled !== "boolean") return null;
      return { type: "browserPanel.setAutoRefresh", enabled: msg.enabled };
    }

    case "browserPanel.cancelOperation":
      return { type: "browserPanel.cancelOperation" };

    case "browserPanel.closeSession":
      return { type: "browserPanel.closeSession" };

    case "browserPanel.captureBaseline":
      return { type: "browserPanel.captureBaseline" };

    case "browserPanel.compareWithBaseline":
      return { type: "browserPanel.compareWithBaseline" };

    case "browserPanel.toggleEvidenceRecording": {
      if (typeof msg.enabled !== "boolean") return null;
      return { type: "browserPanel.toggleEvidenceRecording", enabled: msg.enabled };
    }

    case "browserPanel.clearEvidence":
      return { type: "browserPanel.clearEvidence" };

    default:
      // Reject all unknown or dangerous commands (eval, cdp, exportCookies, writeFile, etc.)
      return null;
  }
}

export type { VisualBaselineArtifact };
