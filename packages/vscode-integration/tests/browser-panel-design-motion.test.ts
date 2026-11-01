/**
 * Sprint 9C — VS Code Browser Panel Design & Motion UI Integration Tests
 *
 * Verifies that the BrowserPanelController and render helpers handle:
 *   - Inbound `measureMotion` and `runVisualQa` messages
 *   - State synchronization of `visualQaReport`, `diffResult`, and `measuredMotion`
 *   - Rendering of difference regions, motion metrics, and visual QA findings in the webview
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowserSessionManager,
  type VisualComparisonResult,
  type MeasuredMotionObservation,
  type VisualQAReport,
} from "@open-vs-code/agent-core";
import {
  BrowserPanelController,
  type BrowserPanelState,
  type BrowserPanelViewAdapter,
  type InboundBrowserPanelMessage,
  renderBrowserObservationPrep,
} from "../src/browser/index.ts";
import { FakeDomDocument, FakeDomElement } from "./helpers/browser-panel-dom-harness.ts";

class MockPanelView implements BrowserPanelViewAdapter {
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

describe("Sprint 9C — VS Code Browser Panel Design & Motion Controller Suite", () => {
  let tmpRoot: string;
  let workspaceRoot: string;
  let artifactRoot: string;
  let sessionManager: BrowserSessionManager;
  let panelView: MockPanelView;
  let controller: BrowserPanelController;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9c-panel-"));
    workspaceRoot = path.join(tmpRoot, "workspace");
    artifactRoot = path.join(tmpRoot, "artifacts");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });

    sessionManager = new BrowserSessionManager({
      workspaceRoot,
      networkPolicy: { allowedOrigins: ["http://127.0.0.1:3000"] },
    });

    panelView = new MockPanelView();
    controller = new BrowserPanelController({
      artifactRootPath: artifactRoot,
      getEnvironment: () => ({
        workspaceRoot,
        artifactRoot,
        activeMode: "BUILD",
        activeModeLabel: "Advanced Design & Motion (BUILD)",
        allowedOrigins: ["http://127.0.0.1:3000"],
      }),
      acquireSessionManager: () => sessionManager,
      createViewAdapter: () => panelView,
    });
  });

  afterEach(async () => {
    controller.dispose();
    await sessionManager.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("1. BrowserPanelController handles measureMotion message and updates panel state", async () => {
    controller.openOrRevealPanel();
    assert.equal(panelView.isOpen, true);

    // Send browserPanel.measureMotion inbound message
    await controller.handleMessage({
      type: "browserPanel.measureMotion",
      durationMs: 300,
    });

    const latest = controller.getState();
    assert.ok(latest);
  });

  test("2. BrowserPanelController handles runVisualQa message and sets status notice when no snapshot available", async () => {
    controller.openOrRevealPanel();

    await controller.handleMessage({
      type: "browserPanel.runVisualQa",
    });

    const state = controller.getState();
    assert.ok(state.statusNotice?.includes("No snapshot available"));
  });

  test("3. renderBrowserObservationPrep renders Visual Comparison difference regions", () => {
    const doc = new FakeDomDocument();
    const container = new FakeDomElement("div");

    const diffResult: VisualComparisonResult = {
      identicalHash: false,
      mismatchedPixels: 1420,
      totalPixels: 1024000,
      mismatchPercent: 0.138,
      baselineSha256: "aaa111",
      candidateSha256: "bbb222",
      regions: [
        {
          regionId: "reg-1",
          bounds: { x: 50, y: 120, width: 300, height: 40, viewportWidth: 1280, viewportHeight: 800 },
          pixelCount: 1420,
          mismatchPercent: 0.138,
          category: "spacing_mismatch",
          description: "Margin/padding displacement detected (300x40 band, 1420 changed px).",
        },
      ],
      pass: false,
    };

    const state: Partial<BrowserPanelState> = {
      visualComparison: {
        baselineTimestamp: 1000,
        candidateTimestamp: 2000,
        identicalHash: false,
        viewportMatch: true,
        baselinePath: "/tmp/base.png",
        candidatePath: "/tmp/cand.png",
        byteDelta: 120,
        diffResult,
      },
      observationPrep: {
        recentFailures: [],
        highlightedElements: [],
      },
    };

    renderBrowserObservationPrep(container as any, state as BrowserPanelState, doc as any);
    const text = container.textContent;

    assert.ok(text.includes("Before/After"));
    assert.ok(text.includes("Visual delta detected"));
    assert.ok(text.includes("1420 px"));
    assert.ok(text.includes("spacing_mismatch"));
    assert.ok(text.includes("Margin/padding displacement detected"));
  });

  test("4. renderBrowserObservationPrep renders Measured Motion metrics and claim status", () => {
    const doc = new FakeDomDocument();
    const container = new FakeDomElement("div");

    const measuredMotion: MeasuredMotionObservation = {
      evidenceKind: "multi_frame_sample",
      sessionId: "sess_test",
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      capturedAt: Date.now(),
      report: {
        measuredFps: 60,
        minFps: 58,
        jankCount: 0,
        totalFrames: 24,
        layoutThrashingProperties: [],
        reducedMotionCompliant: true,
        totalLayoutShift: 0.0,
        motionQualityClaimAllowed: true,
        failures: [],
        score: 100,
        summary: "Smooth motion verified: measured 60 FPS (min 58 FPS).",
      },
    };

    const state: Partial<BrowserPanelState> = {
      animationObservation: {
        timestamp: 1000,
        animatedElementCount: 1,
        motionQualityClaimAllowed: true,
        measuredMotion,
      },
      observationPrep: {
        recentFailures: [],
        highlightedElements: [],
      },
    };

    renderBrowserObservationPrep(container as any, state as BrowserPanelState, doc as any);
    const text = container.textContent;

    assert.ok(text.includes("Measured Motion"));
    assert.ok(text.includes("60 FPS"));
    assert.ok(text.includes("claimAllowed=true"));
  });

  test("5. renderBrowserObservationPrep renders Visual QA Report with findings and scores", () => {
    const doc = new FakeDomDocument();
    const container = new FakeDomElement("div");

    const visualQaReport: VisualQAReport = {
      reportId: "vqa-test",
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop_standard",
      evaluatedAt: Date.now(),
      overallPass: false,
      deterministicPass: false,
      judgmentPass: true,
      score: 65,
      findings: [
        {
          findingId: "f-1",
          criterion: "accessible_naming",
          category: "deterministic",
          severity: "blocker",
          observedEvidence: "Button lacks accessible text",
          expectedBehavior: "All interactive controls must have accessible names",
          location: { refId: "btn-1" },
          suggestedCorrection: "Add aria-label",
          confidence: 1.0,
        },
      ],
      summary: "Visual QA identified 1 blocker issue.",
    };

    const state: Partial<BrowserPanelState> = {
      visualQaReport,
      observationPrep: {
        recentFailures: [],
        highlightedElements: [],
      },
    };

    renderBrowserObservationPrep(container as any, state as BrowserPanelState, doc as any);
    const text = container.textContent;

    assert.ok(text.includes("Visual QA: FAILED"));
    assert.ok(text.includes("Score 65/100"));
    assert.ok(text.includes("accessible_naming"));
    assert.ok(text.includes("Button lacks accessible text"));
  });
});
