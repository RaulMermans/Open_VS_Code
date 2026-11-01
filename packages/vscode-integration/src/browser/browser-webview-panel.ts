import * as crypto from "node:crypto";
import type * as vscode from "vscode";
import type {
  BrowserPanelState,
  InboundBrowserPanelMessage,
  OutboundBrowserPanelMessage,
} from "./browser-panel-protocol.ts";
import { parseBrowserPanelMessage } from "./browser-panel-protocol.ts";
import {
  canHighlightSelectedElementBounds,
  formatBrowserBytes,
  formatBrowserTimestamp,
  isSafeBrowserWebviewImageSrc,
  renderBrowserInspector,
  renderBrowserObservationPrep,
  renderBrowserScreenshotPreview,
  renderBrowserStatusHeader,
  renderBrowserTimeline,
} from "./browser-panel-render-helpers.ts";

export interface BrowserPanelViewAdapter {
  readonly isOpen: boolean;
  readonly isVisible: boolean;
  openOrReveal(): void;
  postState(state: BrowserPanelState): Promise<boolean>;
  asWebviewUri(filePath: string): string;
  dispose(): void;
}

export function generateBrowserPanelNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Generates the restrictive, self-contained HTML shell for the Open VS Code Browser WebviewPanel.
 * Injects the shared `browser-panel-render-helpers.ts` functions verbatim via `.toString()`.
 */
export function buildBrowserPanelHtml(cspSource: string, nonce: string): string {
  const safeCspSource = escapeHtmlAttribute(cspSource);
  const safeNonce = escapeHtmlAttribute(nonce);

  const sharedHelpersSource = [
    isSafeBrowserWebviewImageSrc.toString(),
    formatBrowserTimestamp.toString(),
    formatBrowserBytes.toString(),
    canHighlightSelectedElementBounds.toString(),
    renderBrowserStatusHeader.toString(),
    renderBrowserScreenshotPreview.toString(),
    renderBrowserInspector.toString(),
    renderBrowserTimeline.toString(),
    renderBrowserObservationPrep.toString(),
  ].join("\n\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${safeCspSource}; style-src 'unsafe-inline'; script-src 'nonce-${safeNonce}';" />
  <title>Open VS Code Browser</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 1px;
    }
    .bp-top-shell {
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.28)));
      padding: 8px 12px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      flex-shrink: 0;
    }
    .bp-header-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    .bp-status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--vscode-contrastBorder, rgba(128,128,128,0.4));
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .bp-status-badge.status-ready {
      background: var(--vscode-testing-iconPassed, #2ea043);
      color: #ffffff;
    }
    .bp-status-badge.status-navigating,
    .bp-status-badge.status-action_pending {
      background: var(--vscode-editorWarning-foreground, #cca700);
      color: #000000;
    }
    .bp-status-badge.status-error {
      background: var(--vscode-testing-iconFailed, #f14c4c);
      color: #ffffff;
    }
    .bp-page-title {
      font-weight: 600;
      max-width: 340px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bp-meta-pill {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.14));
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-contrastBorder, transparent);
    }
    .bp-provisioning-row {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      margin-bottom: 4px;
    }
    .bp-banner {
      margin-top: 6px;
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 12px;
      border: 1px solid var(--vscode-contrastBorder, rgba(128,128,128,0.35));
    }
    .bp-banner-error {
      background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.16));
      border-color: var(--vscode-inputValidation-errorBorder, #f14c4c);
    }
    .bp-banner-warning,
    .bp-banner-policy {
      background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,0.16));
      border-color: var(--vscode-inputValidation-warningBorder, #cca700);
    }
    .bp-banner-info {
      background: var(--vscode-inputValidation-infoBackground, rgba(0,127,212,0.15));
      border-color: var(--vscode-inputValidation-infoBorder, #007fd4);
    }
    .bp-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.28)));
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      flex-shrink: 0;
    }
    .bp-url-input {
      flex: 1 1 220px;
      min-width: 140px;
    }
    .bp-input,
    .bp-select {
      padding: 4px 8px;
      font-size: 12px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, rgba(128,128,128,0.4)));
      border-radius: 3px;
    }
    .bp-btn {
      padding: 4px 9px;
      font-size: 12px;
      border-radius: 3px;
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      white-space: nowrap;
    }
    .bp-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
    }
    .bp-btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.22));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    .bp-btn-danger {
      background: var(--vscode-testing-iconFailed, #c72e2e);
      color: #ffffff;
    }
    .bp-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .bp-toggle-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      cursor: pointer;
    }
    .bp-workspace-grid {
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(280px, 1fr);
      min-height: 0;
      overflow: hidden;
    }
    @media (max-width: 760px) {
      .bp-workspace-grid {
        grid-template-columns: 1fr;
        overflow-y: auto;
      }
      .bp-preview-pane,
      .bp-side-pane {
        overflow: visible !important;
        min-height: 280px;
      }
    }
    .bp-preview-pane {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.28)));
      min-height: 0;
      overflow: hidden;
      padding: 10px;
    }
    .bp-preview-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      margin-bottom: 6px;
      flex-shrink: 0;
    }
    .bp-stale-pill {
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
      background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,0.22));
      border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
      color: var(--vscode-foreground);
    }
    .bp-preview-stage {
      flex: 1 1 auto;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35)));
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.14);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 8px;
    }
    .bp-preview-stage.is-stale .bp-preview-image {
      opacity: 0.78;
    }
    .bp-preview-frame-wrap {
      position: relative;
      display: inline-block;
      line-height: 0;
    }
    .bp-preview-stage.zoom-fit .bp-preview-frame-wrap {
      max-width: 100%;
    }
    .bp-preview-stage.zoom-fit .bp-preview-image {
      max-width: 100%;
      height: auto;
      display: block;
    }
    .bp-preview-stage.zoom-actual .bp-preview-image {
      max-width: none;
      height: auto;
      display: block;
    }
    .bp-element-highlight {
      position: absolute;
      border: 2px solid var(--vscode-focusBorder, #007fd4);
      background: rgba(0, 127, 212, 0.16);
      pointer-events: none;
      z-index: 2;
    }
    .bp-element-highlight-label {
      position: absolute;
      top: -18px;
      left: 0;
      font-size: 10px;
      line-height: 1.3;
      padding: 1px 4px;
      background: var(--vscode-focusBorder, #007fd4);
      color: #ffffff;
      border-radius: 2px;
      white-space: nowrap;
      pointer-events: none;
    }
    .bp-preview-empty {
      margin: auto;
      text-align: center;
      padding: 28px 16px;
      max-width: 420px;
    }
    .bp-preview-empty-title {
      font-weight: 600;
      margin-bottom: 6px;
    }
    .bp-preview-empty-sub,
    .bp-empty-note {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .bp-side-pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      gap: 12px;
    }
    .bp-section {
      border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, rgba(128,128,128,0.28)));
      border-radius: 4px;
      padding: 8px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .bp-section-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 6px;
    }
    .bp-inspector-meta,
    .bp-detail-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      margin-bottom: 6px;
    }
    .bp-element-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 210px;
      overflow-y: auto;
      margin-bottom: 8px;
    }
    .bp-element-item {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      text-align: left;
      width: 100%;
      padding: 4px 6px;
      border-radius: 3px;
      border: 1px solid transparent;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 12px;
    }
    .bp-element-item.is-selected {
      border-color: var(--vscode-focusBorder, #007fd4);
      background: var(--vscode-list-activeSelectionBackground, rgba(0,127,212,0.2));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }
    .bp-ref-chip {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      font-weight: 600;
      padding: 0 4px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .bp-role-chip {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }
    .bp-el-name {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bp-warn-chip {
      font-size: 10px;
      font-weight: 600;
      padding: 0 4px;
      border-radius: 3px;
      border: 1px solid currentColor;
    }
    .bp-warn-chip.warn-sensitive,
    .bp-warn-chip.warn-destructive {
      color: var(--vscode-testing-iconFailed, #f14c4c);
    }
    .bp-warn-chip.warn-side_effect {
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .bp-selected-detail {
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.24));
      padding-top: 6px;
      margin-top: 4px;
    }
    .bp-detail-title {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 3px;
    }
    .bp-selected-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-top: 6px;
    }
    .bp-design-meta {
      margin-top: 6px;
      padding: 5px 6px;
      font-size: 11px;
      border-radius: 3px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    }
    .bp-tree-pre {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      max-height: 150px;
      overflow: auto;
      padding: 6px;
      background: var(--vscode-editor-background);
      border-radius: 3px;
      white-space: pre-wrap;
      margin: 4px 0 0 0;
    }
    .bp-timeline-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-height: 240px;
      overflow-y: auto;
    }
    .bp-timeline-item {
      padding: 5px 7px;
      border-radius: 3px;
      background: var(--vscode-editor-background);
      border-left: 3px solid var(--vscode-descriptionForeground, #888888);
      font-size: 11px;
    }
    .bp-timeline-item.status-success {
      border-left-color: var(--vscode-testing-iconPassed, #2ea043);
    }
    .bp-timeline-item.status-denied,
    .bp-timeline-item.status-error {
      border-left-color: var(--vscode-testing-iconFailed, #f14c4c);
    }
    .bp-timeline-item.status-pending {
      border-left-color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .bp-timeline-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
    }
    .bp-origin-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 0 4px;
      border-radius: 2px;
      background: rgba(128, 128, 128, 0.22);
    }
    .bp-origin-badge.origin-agent {
      background: rgba(0, 127, 212, 0.25);
    }
    .bp-origin-badge.origin-user {
      background: rgba(46, 160, 67, 0.25);
    }
    .bp-timeline-action {
      font-weight: 600;
      flex: 1 1 auto;
    }
    .bp-timeline-time,
    .bp-timeline-corr {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      font-size: 10px;
    }
    .bp-timeline-target,
    .bp-timeline-result {
      margin-top: 2px;
      word-break: break-word;
    }
    .bp-prep-card {
      padding: 6px;
      border-radius: 3px;
      background: var(--vscode-editor-background);
      margin-bottom: 6px;
    }
    .bp-prep-title {
      font-weight: 600;
      font-size: 11px;
      margin-bottom: 3px;
    }
  </style>
</head>
<body>
  <header id="bp-status-header" class="bp-top-shell" role="region" aria-label="Browser session status"></header>

  <div class="bp-toolbar" role="toolbar" aria-label="Manual browser controls">
    <input id="bp-url-input" class="bp-input bp-url-input" type="url" placeholder="Authorized URL (e.g. http://127.0.0.1:3000)" aria-label="Authorized target URL" />
    <button id="bp-btn-open" class="bp-btn" type="button">Open URL</button>
    <button id="bp-btn-navigate" class="bp-btn bp-btn-secondary" type="button">Navigate</button>
    <button id="bp-btn-refresh" class="bp-btn bp-btn-secondary" type="button" title="Capture fresh accessibility snapshot and screenshot">Refresh Observation</button>
    <button id="bp-btn-screenshot" class="bp-btn bp-btn-secondary" type="button">Screenshot</button>
    <button id="bp-btn-inspect" class="bp-btn bp-btn-secondary" type="button">Inspect Elements</button>
    <select id="bp-viewport-select" class="bp-select" aria-label="Viewport preset">
      <option value="desktop">Desktop (1280×800)</option>
      <option value="tablet">Tablet (768×1024)</option>
      <option value="mobile">Mobile (390×844)</option>
    </select>
    <select id="bp-zoom-select" class="bp-select" aria-label="Preview zoom mode">
      <option value="fit">Zoom to Fit</option>
      <option value="actual">Actual Size (1:1)</option>
    </select>
    <label class="bp-toggle-label">
      <input id="bp-auto-refresh" type="checkbox" />
      <span>Bounded Auto-Refresh</span>
    </label>
    <button id="bp-btn-cancel" class="bp-btn bp-btn-secondary" type="button" disabled>Cancel</button>
    <button id="bp-btn-close" class="bp-btn bp-btn-danger" type="button" disabled>Close Session</button>
  </div>

  <main class="bp-workspace-grid">
    <section id="bp-preview-container" class="bp-preview-pane" role="region" aria-label="Screenshot preview"></section>

    <aside class="bp-side-pane">
      <section class="bp-section" role="region" aria-label="Accessibility and element inspector">
        <div class="bp-section-header">
          <span>Accessibility &amp; Element Inspector</span>
        </div>
        <div id="bp-inspector-container"></div>
      </section>

      <section class="bp-section" role="region" aria-label="Browser activity timeline">
        <div class="bp-section-header">
          <span>Browser Activity Timeline</span>
        </div>
        <div id="bp-timeline-container" class="bp-timeline-list" role="log" aria-live="polite"></div>
      </section>

      <section class="bp-section" role="region" aria-label="Design and observation contracts">
        <div class="bp-section-header">
          <span>Observation &amp; Evidence Controls</span>
          <div>
            <button id="bp-btn-baseline" class="bp-btn bp-btn-secondary" type="button">Set Baseline</button>
            <button id="bp-btn-compare" class="bp-btn bp-btn-secondary" type="button">Compare</button>
            <button id="bp-btn-animations" class="bp-btn bp-btn-secondary" type="button">Probe CSS Motion</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
          <label class="bp-toggle-label">
            <input id="bp-evidence-toggle" type="checkbox" />
            <span>Record Bounded Evidence</span>
          </label>
          <button id="bp-btn-clear-evidence" class="bp-btn bp-btn-secondary" type="button">Clear Evidence</button>
        </div>
        <div id="bp-prep-container"></div>
      </section>
    </aside>
  </main>

  <script nonce="${safeNonce}">
    (function () {
      const vscode = acquireVsCodeApi();

      ${sharedHelpersSource}

      const statusHeader = document.getElementById("bp-status-header");
      const previewContainer = document.getElementById("bp-preview-container");
      const inspectorContainer = document.getElementById("bp-inspector-container");
      const timelineContainer = document.getElementById("bp-timeline-container");
      const prepContainer = document.getElementById("bp-prep-container");

      const urlInput = document.getElementById("bp-url-input");
      const btnOpen = document.getElementById("bp-btn-open");
      const btnNavigate = document.getElementById("bp-btn-navigate");
      const btnRefresh = document.getElementById("bp-btn-refresh");
      const btnScreenshot = document.getElementById("bp-btn-screenshot");
      const btnInspect = document.getElementById("bp-btn-inspect");
      const viewportSelect = document.getElementById("bp-viewport-select");
      const zoomSelect = document.getElementById("bp-zoom-select");
      const autoRefreshCheckbox = document.getElementById("bp-auto-refresh");
      const btnCancel = document.getElementById("bp-btn-cancel");
      const btnClose = document.getElementById("bp-btn-close");
      const btnBaseline = document.getElementById("bp-btn-baseline");
      const btnCompare = document.getElementById("bp-btn-compare");
      const btnAnimations = document.getElementById("bp-btn-animations");
      const evidenceToggle = document.getElementById("bp-evidence-toggle");
      const btnClearEvidence = document.getElementById("bp-btn-clear-evidence");

      function sendMessage(payload) {
        vscode.postMessage(payload);
      }

      btnOpen.addEventListener("click", function () {
        const url = String(urlInput.value || "").trim();
        if (url) sendMessage({ type: "browserPanel.openUrl", url: url });
      });

      btnNavigate.addEventListener("click", function () {
        const url = String(urlInput.value || "").trim();
        if (url) sendMessage({ type: "browserPanel.navigate", url: url });
      });

      urlInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          const url = String(urlInput.value || "").trim();
          if (url) sendMessage({ type: "browserPanel.openUrl", url: url });
        }
      });

      btnRefresh.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.refreshObservation" });
      });

      btnScreenshot.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.captureScreenshot", fullPage: false });
      });

      btnInspect.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.inspectElements" });
      });

      viewportSelect.addEventListener("change", function () {
        const val = viewportSelect.value;
        if (val === "desktop" || val === "tablet" || val === "mobile") {
          sendMessage({ type: "browserPanel.setViewportPreset", presetId: val });
        }
      });

      zoomSelect.addEventListener("change", function () {
        const val = zoomSelect.value === "actual" ? "actual" : "fit";
        sendMessage({ type: "browserPanel.setZoomMode", zoomMode: val });
      });

      autoRefreshCheckbox.addEventListener("change", function () {
        sendMessage({ type: "browserPanel.setAutoRefresh", enabled: Boolean(autoRefreshCheckbox.checked) });
      });

      btnCancel.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.cancelOperation" });
      });

      btnClose.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.closeSession" });
      });

      btnBaseline.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.captureBaseline" });
      });

      btnCompare.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.compareWithBaseline" });
      });

      btnAnimations.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.observeAnimations" });
      });

      evidenceToggle.addEventListener("change", function () {
        sendMessage({ type: "browserPanel.toggleEvidenceRecording", enabled: Boolean(evidenceToggle.checked) });
      });

      btnClearEvidence.addEventListener("click", function () {
        sendMessage({ type: "browserPanel.clearEvidence" });
      });

      function applyState(state) {
        if (!state) return;
        if (document.activeElement !== urlInput && state.activeUrl) {
          urlInput.value = state.activeUrl;
        }
        if (state.viewportPreset === "desktop" || state.viewportPreset === "tablet" || state.viewportPreset === "mobile") {
          viewportSelect.value = state.viewportPreset;
        }
        zoomSelect.value = state.zoomMode === "actual" ? "actual" : "fit";
        autoRefreshCheckbox.checked = Boolean(state.autoRefreshEnabled);
        evidenceToggle.checked = Boolean(state.evidence && state.evidence.retention && state.evidence.retention.recordingEnabled);

        const hasLiveSession = Boolean(state.hasActiveSession && state.sessionStatus !== "CLOSED" && state.sessionStatus !== "DISCONNECTED");
        btnCancel.disabled = !state.activeOperationBusy;
        btnClose.disabled = !hasLiveSession;
        btnRefresh.disabled = !hasLiveSession || Boolean(state.activeOperationBusy);
        btnScreenshot.disabled = !hasLiveSession || Boolean(state.activeOperationBusy);
        btnInspect.disabled = !hasLiveSession || Boolean(state.activeOperationBusy);
        btnBaseline.disabled = !state.screenshot || Boolean(state.activeOperationBusy);
        btnCompare.disabled = !state.visualBaseline || !state.screenshot || Boolean(state.activeOperationBusy);
        btnAnimations.disabled = !hasLiveSession || Boolean(state.activeOperationBusy);

        renderBrowserStatusHeader(statusHeader, state, document);
        renderBrowserScreenshotPreview(previewContainer, state, document);
        renderBrowserInspector(inspectorContainer, state, sendMessage, document);
        renderBrowserTimeline(timelineContainer, state.timeline || [], document);
        renderBrowserObservationPrep(prepContainer, state, document);
      }

      window.addEventListener("message", function (event) {
        const data = event && event.data;
        if (data && data.type === "browserPanel.state") {
          applyState(data.state);
        }
      });

      sendMessage({ type: "browserPanel.ready" });
    })();
  </script>
</body>
</html>`;
}

/**
 * VS Code WebviewPanel host wrapper for the Open VS Code Browser panel.
 * Opens beside the active code editor (`ViewColumn.Beside`) with tight `localResourceRoots`
 * and strict message parsing.
 */
export class VscodeBrowserWebviewPanel implements BrowserPanelViewAdapter {
  public static readonly viewType = "open-vs-code.browserPanel";

  readonly #vscodeApi: typeof vscode;
  readonly #extensionUri: vscode.Uri;
  readonly #artifactRootUri: vscode.Uri;
  readonly #onMessage: (message: InboundBrowserPanelMessage) => void;
  readonly #onVisibilityChanged: (visible: boolean) => void;
  readonly #onPanelClosed: () => void;

  #panel: vscode.WebviewPanel | undefined;
  #disposables: vscode.Disposable[] = [];

  constructor(options: {
    readonly vscodeApi: typeof vscode;
    readonly extensionUri: vscode.Uri;
    readonly artifactRootPath: string;
    readonly onMessage: (message: InboundBrowserPanelMessage) => void;
    readonly onVisibilityChanged: (visible: boolean) => void;
    readonly onPanelClosed: () => void;
  }) {
    this.#vscodeApi = options.vscodeApi;
    this.#extensionUri = options.extensionUri;
    this.#artifactRootUri =
      options.vscodeApi?.Uri?.file
        ? options.vscodeApi.Uri.file(options.artifactRootPath)
        : ({
            fsPath: options.artifactRootPath,
            scheme: "file",
            path: options.artifactRootPath,
            toString: () => `file://${options.artifactRootPath}`,
          } as any);
    this.#onMessage = options.onMessage;
    this.#onVisibilityChanged = options.onVisibilityChanged;
    this.#onPanelClosed = options.onPanelClosed;
  }

  public get isOpen(): boolean {
    return this.#panel !== undefined;
  }

  public get isVisible(): boolean {
    return Boolean(this.#panel?.visible);
  }

  public openOrReveal(): void {
    const viewColumn = this.#vscodeApi?.ViewColumn?.Beside ?? 2;
    if (this.#panel) {
      this.#panel.reveal(viewColumn, false);
      return;
    }

    if (typeof this.#vscodeApi?.window?.createWebviewPanel !== "function") {
      return;
    }

    const localResourceRoots: any[] = [];
    if (this.#extensionUri) localResourceRoots.push(this.#extensionUri);
    if (this.#artifactRootUri) localResourceRoots.push(this.#artifactRootUri);

    const panel = this.#vscodeApi.window.createWebviewPanel(
      VscodeBrowserWebviewPanel.viewType,
      "Open VS Code Browser",
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots,
      }
    );

    const nonce = generateBrowserPanelNonce();
    panel.webview.html = buildBrowserPanelHtml(panel.webview.cspSource, nonce);

    this.#disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const parsed = parseBrowserPanelMessage(raw);
        if (parsed) {
          this.#onMessage(parsed);
        }
      }),
      panel.onDidChangeViewState((ev) => {
        this.#onVisibilityChanged(ev.webviewPanel.visible);
      }),
      panel.onDidDispose(() => {
        this.#cleanupDisposables();
        this.#panel = undefined;
        this.#onPanelClosed();
      })
    );

    this.#panel = panel;
  }

  public async postState(state: BrowserPanelState): Promise<boolean> {
    if (!this.#panel || !this.#panel.visible) {
      return false;
    }
    const payload: OutboundBrowserPanelMessage = {
      type: "browserPanel.state",
      state,
    };
    try {
      return await this.#panel.webview.postMessage(payload);
    } catch {
      return false;
    }
  }

  public asWebviewUri(filePath: string): string {
    const fileUri = this.#vscodeApi.Uri.file(filePath);
    if (this.#panel) {
      return this.#panel.webview.asWebviewUri(fileUri).toString();
    }
    return `vscode-webview-resource://local${fileUri.path}`;
  }

  public dispose(): void {
    const panel = this.#panel;
    this.#panel = undefined;
    this.#cleanupDisposables();
    try {
      panel?.dispose();
    } catch {
      // Safe dispose
    }
  }

  #cleanupDisposables(): void {
    for (const d of this.#disposables) {
      try {
        d.dispose();
      } catch {
        // Safe ignore
      }
    }
    this.#disposables = [];
  }
}
