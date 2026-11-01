/**
 * Production Webview rendering helpers for the Open VS Code Browser panel (Sprint 9B).
 *
 * Security & Authority Model:
 *   - Untrusted webpage strings (titles, URLs, accessible names, input values,
 *     warnings, console/network errors) are rendered strictly via `el.textContent`.
 *   - Containers are cleared via `el.innerHTML = ''` only.
 *   - Screenshot `<img>` `src` only accepts sanitized VS Code webview resource URIs
 *     (`vscode-webview-resource:`, `vscode-resource:`, or `*.vscode-cdn.net`), never
 *     `javascript:`, `data:text/html`, or arbitrary remote origins.
 *   - Element bounding-box overlays use `pointer-events: none` and are never
 *     connected to any coordinate execution command.
 *   - Shared verbatim between `BrowserWebviewPanel` (via `Function.prototype.toString()`)
 *     and security/UI verification tests. Do NOT use template literals in these functions.
 */

import type {
  BrowserElementView,
  BrowserPanelState,
  BrowserTimelineItem,
} from "./browser-panel-protocol.ts";

export function isSafeBrowserWebviewImageSrc(uri: string): boolean {
  if (typeof uri !== "string" || !uri) return false;
  var trimmed = uri.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return false;
  if (
    trimmed.indexOf("vscode-webview-resource:") === 0 ||
    trimmed.indexOf("vscode-resource:") === 0
  ) {
    return true;
  }
  if (trimmed.indexOf("https://") === 0) {
    try {
      var parsed = new URL(trimmed);
      var host = parsed.hostname.toLowerCase();
      return (
        host === "vscode-cdn.net" ||
        host.slice(-15) === ".vscode-cdn.net"
      );
    } catch (_e) {
      return false;
    }
  }
  return false;
}

export function formatBrowserTimestamp(ts: number): string {
  if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "--:--:--";
  try {
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  } catch (_e) {
    return "--:--:--";
  }
}

export function formatBrowserBytes(bytes: number): string {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return String(Math.round(bytes)) + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

export function canHighlightSelectedElementBounds(state: BrowserPanelState): {
  allowed: boolean;
  element?: BrowserElementView;
} {
  if (!state || !state.selectedRefId || !state.snapshot || !state.screenshot) {
    return { allowed: false };
  }
  if (state.snapshot.stale || state.screenshot.stale) {
    return { allowed: false };
  }
  if (state.snapshot.url !== state.screenshot.url) {
    return { allowed: false };
  }
  var found: BrowserElementView | undefined;
  for (var i = 0; i < state.snapshot.elements.length; i++) {
    var candidate = state.snapshot.elements[i];
    if (candidate && candidate.refId === state.selectedRefId) {
      found = candidate;
      break;
    }
  }
  if (!found || !found.bounds) {
    return { allowed: false };
  }
  var b = found.bounds;
  if (
    b.width <= 0 ||
    b.height <= 0 ||
    b.viewportWidth <= 0 ||
    b.viewportHeight <= 0
  ) {
    return { allowed: false };
  }
  if (
    b.viewportWidth !== state.screenshot.viewport.width ||
    b.viewportHeight !== state.screenshot.viewport.height
  ) {
    return { allowed: false };
  }
  return { allowed: true, element: found };
}

export function renderBrowserStatusHeader(
  container: any,
  state: BrowserPanelState,
  doc?: any
): void {
  var d = doc || (globalThis as any).document;
  if (!container || !d) return;
  container.innerHTML = "";

  var topRow = d.createElement("div");
  topRow.className = "bp-header-row";

  var badge = d.createElement("span");
  badge.className = "bp-status-badge status-" + String(state.sessionStatus || "DISCONNECTED").toLowerCase();
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-live", "polite");
  badge.textContent = String(state.sessionStatus || "DISCONNECTED");
  topRow.appendChild(badge);

  var titleEl = d.createElement("span");
  titleEl.className = "bp-page-title";
  titleEl.textContent = state.pageTitle ? state.pageTitle : "No active page";
  topRow.appendChild(titleEl);

  var vpBadge = d.createElement("span");
  vpBadge.className = "bp-meta-pill";
  vpBadge.textContent =
    String(state.viewport.width) +
    "×" +
    String(state.viewport.height) +
    " (" +
    String(state.viewportPreset) +
    ")";
  topRow.appendChild(vpBadge);

  var wsBadge = d.createElement("span");
  wsBadge.className = "bp-meta-pill";
  wsBadge.textContent =
    "Workspace: " +
    (state.workspaceName || "None") +
    (state.workspaceTrusted ? "" : " [Untrusted]");
  topRow.appendChild(wsBadge);

  var idBadge = d.createElement("span");
  idBadge.className = "bp-meta-pill bp-identity-pill";
  idBadge.setAttribute("aria-label", "Read-only session identity");
  idBadge.textContent =
    "Identity: " +
    (state.identity && state.identity.displayLabel ? state.identity.displayLabel : "local") +
    (state.identity && state.identity.sessionId ? " · " + state.identity.sessionId : "");
  topRow.appendChild(idBadge);

  var modeBadge = d.createElement("span");
  modeBadge.className = "bp-meta-pill";
  modeBadge.textContent = "Mode: " + (state.activeExecutionMode || "ASK");
  topRow.appendChild(modeBadge);

  container.appendChild(topRow);

  var provRow = d.createElement("div");
  provRow.className = "bp-provisioning-row";
  var provText =
    "Runtime: " +
    String(state.provisioning.status) +
    (state.provisioning.summary ? " — " + state.provisioning.summary : "") +
    (state.provisioning.sandboxVerified
      ? " · Sandbox verified" +
        (state.provisioning.sandboxMethod ? " (" + state.provisioning.sandboxMethod + ")" : "")
      : "");
  provRow.textContent = provText;
  container.appendChild(provRow);

  if (state.pendingApproval) {
    var approvalBanner = d.createElement("div");
    approvalBanner.className = "bp-banner bp-banner-warning";
    approvalBanner.setAttribute("role", "alert");
    approvalBanner.textContent =
      "Awaiting confirmation (" +
      String(state.pendingApproval.origin).toUpperCase() +
      "): " +
      state.pendingApproval.toolName +
      " [" +
      state.pendingApproval.action +
      "]" +
      (state.pendingApproval.target ? " → " + state.pendingApproval.target : "");
    container.appendChild(approvalBanner);
  }

  if (state.navigationError) {
    var errBanner = d.createElement("div");
    errBanner.className = "bp-banner bp-banner-error";
    errBanner.setAttribute("role", "alert");
    errBanner.textContent = state.navigationError;
    container.appendChild(errBanner);
  }

  if (state.statusNotice) {
    var noticeBanner = d.createElement("div");
    noticeBanner.className = "bp-banner bp-banner-info";
    noticeBanner.setAttribute("role", "status");
    noticeBanner.textContent = state.statusNotice;
    container.appendChild(noticeBanner);
  }

  if (state.networkPolicyWarnings && state.networkPolicyWarnings.length > 0) {
    var warnBox = d.createElement("div");
    warnBox.className = "bp-banner bp-banner-policy";
    warnBox.setAttribute("role", "region");
    warnBox.setAttribute("aria-label", "Network policy warnings");
    var latestWarn = state.networkPolicyWarnings[state.networkPolicyWarnings.length - 1];
    warnBox.textContent =
      "Network policy (" +
      String(state.networkPolicyWarnings.length) +
      "): " +
      String(latestWarn || "");
    container.appendChild(warnBox);
  }
}

export function renderBrowserScreenshotPreview(
  container: any,
  state: BrowserPanelState,
  doc?: any
): void {
  var d = doc || (globalThis as any).document;
  if (!container || !d) return;
  container.innerHTML = "";

  var shot = state.screenshot;
  if (!shot || !isSafeBrowserWebviewImageSrc(shot.webviewUri)) {
    var empty = d.createElement("div");
    empty.className = "bp-preview-empty";
    var emptyTitle = d.createElement("div");
    emptyTitle.className = "bp-preview-empty-title";
    emptyTitle.textContent = state.hasActiveSession
      ? "No screenshot captured for the current page yet."
      : "Browser session has not been started.";
    empty.appendChild(emptyTitle);

    var emptySub = d.createElement("div");
    emptySub.className = "bp-preview-empty-sub";
    emptySub.textContent =
      "Opening this panel never launches Chromium automatically. Enter an authorized URL or run a Browser QA task in Chat.";
    empty.appendChild(emptySub);
    container.appendChild(empty);
    return;
  }

  var metaBar = d.createElement("div");
  metaBar.className = "bp-preview-meta";

  var tsSpan = d.createElement("span");
  tsSpan.textContent =
    "Captured " +
    formatBrowserTimestamp(shot.capturedAt) +
    " · " +
    String(shot.width) +
    "×" +
    String(shot.height) +
    " · " +
    formatBrowserBytes(shot.bytes) +
    " · Artifact " +
    shot.artifactId +
    (shot.maskedSensitiveFields > 0
      ? " · " + String(shot.maskedSensitiveFields) + " sensitive field(s) masked"
      : "");
  metaBar.appendChild(tsSpan);

  if (shot.stale) {
    var staleTag = d.createElement("span");
    staleTag.className = "bp-stale-pill";
    staleTag.setAttribute("role", "status");
    staleTag.textContent =
      "STALE PREVIEW" + (shot.staleReason ? ": " + shot.staleReason : "");
    metaBar.appendChild(staleTag);
  }

  container.appendChild(metaBar);

  var stage = d.createElement("div");
  stage.className =
    "bp-preview-stage zoom-" +
    (state.zoomMode === "actual" ? "actual" : "fit") +
    (shot.stale ? " is-stale" : "");

  var frameWrap = d.createElement("div");
  frameWrap.className = "bp-preview-frame-wrap";
  if (state.zoomMode === "actual") {
    frameWrap.style.width = String(shot.width) + "px";
  }

  var img = d.createElement("img");
  img.className = "bp-preview-image";
  img.setAttribute("src", shot.webviewUri);
  img.setAttribute(
    "alt",
    "Sanitized browser screenshot for " + (shot.pageTitle || shot.url || "active page")
  );
  frameWrap.appendChild(img);

  var highlightCheck = canHighlightSelectedElementBounds(state);
  if (highlightCheck.allowed && highlightCheck.element && highlightCheck.element.bounds) {
    var b = highlightCheck.element.bounds;
    var overlay = d.createElement("div");
    overlay.className = "bp-element-highlight";
    overlay.setAttribute("data-highlight-ref", highlightCheck.element.refId);
    overlay.setAttribute("aria-hidden", "true");
    var leftPct = Math.max(0, Math.min(100, (b.x / b.viewportWidth) * 100));
    var topPct = Math.max(0, Math.min(100, (b.y / b.viewportHeight) * 100));
    var widthPct = Math.max(0, Math.min(100 - leftPct, (b.width / b.viewportWidth) * 100));
    var heightPct = Math.max(0, Math.min(100 - topPct, (b.height / b.viewportHeight) * 100));
    overlay.style.left = leftPct.toFixed(2) + "%";
    overlay.style.top = topPct.toFixed(2) + "%";
    overlay.style.width = widthPct.toFixed(2) + "%";
    overlay.style.height = heightPct.toFixed(2) + "%";

    var overlayLabel = d.createElement("span");
    overlayLabel.className = "bp-element-highlight-label";
    overlayLabel.textContent =
      highlightCheck.element.refId + " · " + highlightCheck.element.role;
    overlay.appendChild(overlayLabel);
    frameWrap.appendChild(overlay);
  }

  stage.appendChild(frameWrap);
  container.appendChild(stage);
}

export function renderBrowserInspector(
  container: any,
  state: BrowserPanelState,
  postMessage?: (msg: any) => void,
  doc?: any
): void {
  var d = doc || (globalThis as any).document;
  if (!container || !d) return;
  container.innerHTML = "";

  var snap = state.snapshot;
  if (!snap) {
    var empty = d.createElement("div");
    empty.className = "bp-empty-note";
    empty.textContent =
      "No accessibility snapshot captured yet. Use Inspect Elements or Refresh Observation when a page is open.";
    container.appendChild(empty);
    return;
  }

  var header = d.createElement("div");
  header.className = "bp-inspector-meta";
  header.textContent =
    "Snapshot " +
    snap.snapshotId.slice(0, 14) +
    " · " +
    String(snap.elementCount) +
    " element(s) · " +
    formatBrowserBytes(snap.bytes) +
    " · " +
    formatBrowserTimestamp(snap.capturedAt);
  container.appendChild(header);

  if (snap.stale) {
    var staleWarn = d.createElement("div");
    staleWarn.className = "bp-banner bp-banner-warning";
    staleWarn.setAttribute("role", "status");
    staleWarn.textContent =
      "Snapshot is stale" +
      (snap.staleReason ? " (" + snap.staleReason + ")" : "") +
      ". Element actions are disabled until you Refresh Observation.";
    container.appendChild(staleWarn);
  }

  var list = d.createElement("div");
  list.className = "bp-element-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Observed accessibility elements");

  var selectedEl: BrowserElementView | undefined;
  for (var i = 0; i < snap.elements.length; i++) {
    (function (el: BrowserElementView) {
      if (!el) return;
      var isSelected = state.selectedRefId === el.refId;
      if (isSelected) selectedEl = el;

      var row = d.createElement("button");
      row.type = "button";
      row.className = "bp-element-item" + (isSelected ? " is-selected" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", isSelected ? "true" : "false");
      row.setAttribute("data-ref-id", el.refId);

      var refSpan = d.createElement("span");
      refSpan.className = "bp-ref-chip";
      refSpan.textContent = el.refId;
      row.appendChild(refSpan);

      var roleSpan = d.createElement("span");
      roleSpan.className = "bp-role-chip";
      roleSpan.textContent =
        el.role + (el.inputType ? " (" + el.inputType + ")" : " <" + el.tag + ">");
      row.appendChild(roleSpan);

      var nameSpan = d.createElement("span");
      nameSpan.className = "bp-el-name";
      nameSpan.textContent = el.name || "(unnamed)";
      row.appendChild(nameSpan);

      if (el.warnings && el.warnings.length > 0) {
        for (var w = 0; w < el.warnings.length; w++) {
          var warnChip = d.createElement("span");
          warnChip.className = "bp-warn-chip warn-" + el.warnings[w];
          warnChip.textContent = String(el.warnings[w]).toUpperCase();
          row.appendChild(warnChip);
        }
      }

      if (typeof row.addEventListener === "function" && postMessage) {
        row.addEventListener("click", function () {
          postMessage({
            type: "browserPanel.selectElement",
            refId: isSelected ? null : el.refId,
          });
        });
      }

      list.appendChild(row);
    })(snap.elements[i]!);
  }
  container.appendChild(list);

  if (selectedEl) {
    var detail = d.createElement("div");
    detail.className = "bp-selected-detail";
    detail.setAttribute("role", "region");
    detail.setAttribute("aria-label", "Selected element details");

    var summaryLine = d.createElement("div");
    summaryLine.className = "bp-detail-title";
    summaryLine.textContent =
      "Selected [" +
      selectedEl.refId +
      "] " +
      selectedEl.role +
      " <" +
      selectedEl.tag +
      "> — " +
      (selectedEl.name || "(unnamed)");
    detail.appendChild(summaryLine);

    var stateParts: string[] = [];
    stateParts.push(selectedEl.interactiveState.disabled ? "disabled" : "enabled");
    if (selectedEl.interactiveState.editable) stateParts.push("editable");
    if (selectedEl.interactiveState.readonly) stateParts.push("readonly");
    if (selectedEl.interactiveState.required) stateParts.push("required");
    if (selectedEl.interactiveState.focused) stateParts.push("focused");
    if (typeof selectedEl.interactiveState.checked === "boolean") {
      stateParts.push(selectedEl.interactiveState.checked ? "checked" : "unchecked");
    }
    if (typeof selectedEl.interactiveState.expanded === "boolean") {
      stateParts.push(selectedEl.interactiveState.expanded ? "expanded" : "collapsed");
    }
    if (selectedEl.bounds) {
      stateParts.push(
        "bounds (" +
          String(selectedEl.bounds.x) +
          "," +
          String(selectedEl.bounds.y) +
          " " +
          String(selectedEl.bounds.width) +
          "×" +
          String(selectedEl.bounds.height) +
          ")"
      );
    }

    var stateLine = d.createElement("div");
    stateLine.className = "bp-detail-meta";
    stateLine.textContent = "State: " + stateParts.join(" · ");
    detail.appendChild(stateLine);

    var actionsDisabled = Boolean(
      snap.stale || state.activeOperationBusy || selectedEl.interactiveState.disabled
    );

    var actionRow = d.createElement("div");
    actionRow.className = "bp-selected-actions";

    var clickBtn = d.createElement("button");
    clickBtn.type = "button";
    clickBtn.className = "bp-btn";
    clickBtn.disabled = actionsDisabled;
    clickBtn.setAttribute("aria-disabled", actionsDisabled ? "true" : "false");
    clickBtn.setAttribute("data-action", "click-selected");
    clickBtn.textContent = "Click " + selectedEl.refId;
    if (!actionsDisabled && typeof clickBtn.addEventListener === "function" && postMessage) {
      var targetRefClick = selectedEl.refId;
      clickBtn.addEventListener("click", function () {
        postMessage({ type: "browserPanel.clickSelected", refId: targetRefClick });
      });
    }
    actionRow.appendChild(clickBtn);

    var designBtn = d.createElement("button");
    designBtn.type = "button";
    designBtn.className = "bp-btn bp-btn-secondary";
    var designDisabled = Boolean(snap.stale || state.activeOperationBusy);
    designBtn.disabled = designDisabled;
    designBtn.setAttribute("aria-disabled", designDisabled ? "true" : "false");
    designBtn.setAttribute("data-action", "inspect-design");
    designBtn.textContent = "Inspect Typography & Layout";
    if (!designDisabled && typeof designBtn.addEventListener === "function" && postMessage) {
      var targetRefDesign = selectedEl.refId;
      designBtn.addEventListener("click", function () {
        postMessage({ type: "browserPanel.inspectElementDesign", refId: targetRefDesign });
      });
    }
    actionRow.appendChild(designBtn);

    if (selectedEl.interactiveState.editable) {
      var fillInput = d.createElement("input");
      fillInput.type = selectedEl.warnings.indexOf("sensitive") >= 0 ? "password" : "text";
      fillInput.className = "bp-input bp-fill-input";
      fillInput.placeholder = "Fill value for " + selectedEl.refId;
      fillInput.disabled = actionsDisabled;
      fillInput.setAttribute("aria-label", "Value to fill into " + selectedEl.refId);
      actionRow.appendChild(fillInput);

      var fillBtn = d.createElement("button");
      fillBtn.type = "button";
      fillBtn.className = "bp-btn";
      fillBtn.disabled = actionsDisabled;
      fillBtn.setAttribute("aria-disabled", actionsDisabled ? "true" : "false");
      fillBtn.setAttribute("data-action", "fill-selected");
      fillBtn.textContent = "Fill " + selectedEl.refId;
      if (!actionsDisabled && typeof fillBtn.addEventListener === "function" && postMessage) {
        var targetRefFill = selectedEl.refId;
        fillBtn.addEventListener("click", function () {
          postMessage({
            type: "browserPanel.fillSelected",
            refId: targetRefFill,
            value: String(fillInput.value || ""),
          });
        });
      }
      actionRow.appendChild(fillBtn);
    }

    detail.appendChild(actionRow);

    if (
      state.selectedDesignMetadata &&
      state.selectedDesignMetadata.refId === selectedEl.refId &&
      state.selectedDesignMetadata.snapshotId === snap.snapshotId
    ) {
      var dm = state.selectedDesignMetadata;
      var dmBox = d.createElement("div");
      dmBox.className = "bp-design-meta";
      dmBox.textContent =
        "Typography: " +
        dm.typography.fontFamily +
        " · " +
        dm.typography.fontSize +
        " / " +
        dm.typography.lineHeight +
        " · weight " +
        dm.typography.fontWeight +
        " · Layout: " +
        dm.layout.display +
        " (" +
        dm.layout.position +
        ") · Padding: " +
        dm.spacing.paddingTop +
        " " +
        dm.spacing.paddingRight +
        " " +
        dm.spacing.paddingBottom +
        " " +
        dm.spacing.paddingLeft;
      detail.appendChild(dmBox);
    }

    container.appendChild(detail);
  }

  var treeDetails = d.createElement("details");
  treeDetails.className = "bp-raw-tree";
  var treeSummary = d.createElement("summary");
  treeSummary.textContent = "Raw Accessibility Tree" + (snap.truncated ? " (truncated)" : "");
  treeDetails.appendChild(treeSummary);
  var pre = d.createElement("pre");
  pre.className = "bp-tree-pre";
  pre.textContent = snap.tree;
  treeDetails.appendChild(pre);
  container.appendChild(treeDetails);
}

export function renderBrowserTimeline(
  container: any,
  timeline: readonly BrowserTimelineItem[],
  doc?: any
): void {
  var d = doc || (globalThis as any).document;
  if (!container || !d) return;
  container.innerHTML = "";

  if (!timeline || timeline.length === 0) {
    var empty = d.createElement("div");
    empty.className = "bp-empty-note";
    empty.textContent = "No browser events recorded in this session yet.";
    container.appendChild(empty);
    return;
  }

  for (var i = timeline.length - 1; i >= 0; i--) {
    var item = timeline[i];
    if (!item) continue;

    var row = d.createElement("div");
    row.className = "bp-timeline-item status-" + item.status;
    row.setAttribute("data-event-type", item.eventType);
    row.setAttribute("data-origin", item.origin);

    var top = d.createElement("div");
    top.className = "bp-timeline-top";

    var originBadge = d.createElement("span");
    originBadge.className = "bp-origin-badge origin-" + item.origin;
    originBadge.textContent = String(item.origin).toUpperCase();
    top.appendChild(originBadge);

    var actionSpan = d.createElement("span");
    actionSpan.className = "bp-timeline-action";
    actionSpan.textContent = item.actionName;
    top.appendChild(actionSpan);

    var statusSpan = d.createElement("span");
    statusSpan.className = "bp-timeline-status";
    statusSpan.textContent = String(item.status).toUpperCase();
    top.appendChild(statusSpan);

    var timeSpan = d.createElement("span");
    timeSpan.className = "bp-timeline-time";
    timeSpan.textContent = formatBrowserTimestamp(item.timestamp);
    top.appendChild(timeSpan);

    row.appendChild(top);

    if (item.target) {
      var targetDiv = d.createElement("div");
      targetDiv.className = "bp-timeline-target";
      targetDiv.textContent = "Target: " + item.target;
      row.appendChild(targetDiv);
    }

    if (item.resultOrError) {
      var resDiv = d.createElement("div");
      resDiv.className = "bp-timeline-result";
      resDiv.textContent = item.resultOrError;
      row.appendChild(resDiv);
    }

    var linksParts: string[] = [];
    if (item.taskId) linksParts.push("Task: " + item.taskId);
    if (item.snapshotId) linksParts.push("Snapshot: " + item.snapshotId.slice(0, 12));
    if (item.screenshotArtifactId) linksParts.push("Screenshot: " + item.screenshotArtifactId);
    if (linksParts.length > 0) {
      var corrDiv = d.createElement("div");
      corrDiv.className = "bp-timeline-corr";
      corrDiv.textContent = linksParts.join(" · ");
      row.appendChild(corrDiv);
    }

    container.appendChild(row);
  }
}

export function renderBrowserObservationPrep(
  container: any,
  state: BrowserPanelState,
  doc?: any
): void {
  var d = doc || (globalThis as any).document;
  if (!container || !d) return;
  container.innerHTML = "";

  // Sprint 9C Baseline / Comparison / Motion observation metadata
  var designCard = d.createElement("div");
  designCard.className = "bp-prep-card";
  var designTitle = d.createElement("div");
  designTitle.className = "bp-prep-title";
  designTitle.textContent = "Design & Viewport Observation Metadata";
  designCard.appendChild(designTitle);

  var baselineLine = d.createElement("div");
  baselineLine.className = "bp-detail-meta";
  if (state.visualBaseline) {
    baselineLine.textContent =
      "Baseline: " +
      state.visualBaseline.baselineId +
      " · " +
      String(state.visualBaseline.viewport.width) +
      "×" +
      String(state.visualBaseline.viewport.height) +
      " (" +
      state.visualBaseline.presetId +
      ") · " +
      formatBrowserBytes(state.visualBaseline.bytes);
  } else {
    baselineLine.textContent = "Baseline: none captured in current session.";
  }
  designCard.appendChild(baselineLine);

  if (state.visualComparison) {
    var compLine = d.createElement("div");
    compLine.className = "bp-detail-meta";
    compLine.textContent =
      "Before/After: " +
      (state.visualComparison.identicalHash ? "Identical PNG hash" : "Visual delta detected") +
      " · viewportMatch=" +
      String(state.visualComparison.viewportMatch) +
      " · byteDelta=" +
      String(state.visualComparison.byteDelta) +
      " B";
    designCard.appendChild(compLine);
  }

  if (state.animationObservation) {
    var animLine = d.createElement("div");
    animLine.className = "bp-detail-meta";
    animLine.textContent =
      "CSS Declarations: " +
      String(state.animationObservation.animatedElementCount) +
      " animated/transitioning element(s) · motionQualityClaimAllowed=" +
      String(state.animationObservation.motionQualityClaimAllowed) +
      " — " +
      state.animationObservation.limitationNotice;
    designCard.appendChild(animLine);
  }
  container.appendChild(designCard);

  // Sprint 9D Evidence Retention Status
  var evCard = d.createElement("div");
  evCard.className = "bp-prep-card";
  var evTitle = d.createElement("div");
  evTitle.className = "bp-prep-title";
  evTitle.textContent = "Bounded Observation Journal";
  evCard.appendChild(evTitle);

  var ret = state.evidence.retention;
  var evMeta = d.createElement("div");
  evMeta.className = "bp-detail-meta";
  evMeta.textContent =
    "Recording: " +
    (ret.recordingEnabled ? "ON" : "OFF") +
    " · Observed facts: " +
    String(ret.retainedFacts) +
    "/" +
    String(ret.maxFacts) +
    (ret.droppedFacts > 0 ? " (" + String(ret.droppedFacts) + " evicted)" : "") +
    " · Inferred: " +
    String(ret.retainedInferences) +
    " · Unknown details: " +
    String(ret.retainedUnknowns) +
    " · Response bodies/cookies/storage: never recorded";
  evCard.appendChild(evMeta);
  container.appendChild(evCard);
}
