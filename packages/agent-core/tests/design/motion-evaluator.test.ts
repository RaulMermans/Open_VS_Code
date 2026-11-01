import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateMotionObservations } from "../../src/design/index.ts";

describe("Sprint 9C — Real Measured Motion Evaluation Engine", () => {
  const defaultViewport = { width: 1280, height: 800 };

  test("1. Verifies smooth 60 FPS motion with composited properties and grants motionQualityClaimAllowed", () => {
    // Generate 30 frames at ~16.6ms intervals (60 FPS)
    const frameTimings = Array.from({ length: 30 }, (_, i) => ({
      frameIndex: i,
      timestampMs: Math.round(i * 16.67),
      deltaMs: 16.7,
    }));

    const result = evaluateMotionObservations({
      sessionId: "sess_motion_1",
      url: "http://127.0.0.1:3000/app",
      viewport: defaultViewport,
      prefersReducedMotion: false,
      frameTimings,
      animations: [
        {
          elementTag: "div",
          elementRole: "dialog",
          accessibleName: "Export Dialog",
          animationName: "modal-fade-scale",
          propertyName: "transform",
          durationMs: 250,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
          isComposited: true,
          causesLayoutShift: false,
        },
        {
          elementTag: "div",
          elementRole: "dialog",
          accessibleName: "Export Dialog",
          animationName: "modal-fade-scale",
          propertyName: "opacity",
          durationMs: 250,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
          isComposited: true,
          causesLayoutShift: false,
        },
      ],
      layoutShifts: [],
    });

    assert.equal(result.evidenceKind, "multi_frame_sample");
    assert.equal(result.report.measuredFps, 60);
    assert.equal(result.report.jankCount, 0);
    assert.equal(result.report.layoutThrashingProperties.length, 0);
    assert.equal(result.report.reducedMotionCompliant, true);
    assert.equal(result.report.motionQualityClaimAllowed, true);
    assert.equal(result.report.score, 100);
    assert.ok(result.report.summary.includes("Smooth motion verified"));
  });

  test("2. Detects layout-thrashing properties (width, top, left) as blocker failures", () => {
    const frameTimings = Array.from({ length: 20 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16,
      deltaMs: 16.0,
    }));

    const result = evaluateMotionObservations({
      sessionId: "sess_motion_2",
      url: "http://127.0.0.1:3000/nav",
      viewport: defaultViewport,
      prefersReducedMotion: false,
      frameTimings,
      animations: [
        {
          elementTag: "aside",
          elementRole: "navigation",
          accessibleName: "Sidebar Menu",
          animationName: "expand-drawer",
          propertyName: "width",
          durationMs: 300,
          easing: "ease",
          isComposited: false,
          causesLayoutShift: true,
        },
      ],
    });

    assert.equal(result.report.motionQualityClaimAllowed, false);
    assert.deepEqual(result.report.layoutThrashingProperties, ["width"]);
    assert.ok(
      result.report.failures.some(
        (f) => f.failureCode === "LAYOUT_THRASHING_PROPERTY" && f.severity === "blocker"
      )
    );
  });

  test("3. Detects dropped frames and jank pauses (> 50ms) and lowers score", () => {
    const frameTimings = [
      { frameIndex: 0, timestampMs: 0, deltaMs: 16.6 },
      { frameIndex: 1, timestampMs: 16, deltaMs: 16.6 },
      { frameIndex: 2, timestampMs: 80, deltaMs: 64.0 }, // 64ms pause = severe jank
      { frameIndex: 3, timestampMs: 96, deltaMs: 16.0 },
    ];

    const result = evaluateMotionObservations({
      sessionId: "sess_motion_3",
      url: "http://127.0.0.1:3000/chart",
      viewport: defaultViewport,
      prefersReducedMotion: false,
      frameTimings,
      animations: [],
    });

    assert.equal(result.report.jankCount, 1);
    assert.equal(result.report.motionQualityClaimAllowed, false);
    assert.ok(result.report.failures.some((f) => f.failureCode === "FRAME_JANK_DETECTED"));
  });

  test("4. Enforces reduced-motion compliance when prefersReducedMotion is active", () => {
    const frameTimings = Array.from({ length: 20 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16,
      deltaMs: 16.0,
    }));

    // Active spatial translate animation without reduced-motion suppression
    const result = evaluateMotionObservations({
      sessionId: "sess_motion_4",
      url: "http://127.0.0.1:3000/hero",
      viewport: defaultViewport,
      prefersReducedMotion: true,
      frameTimings,
      animations: [
        {
          elementTag: "div",
          elementRole: "region",
          accessibleName: "Hero Banner",
          animationName: "slide-in-right",
          propertyName: "translate-x",
          durationMs: 400,
          easing: "ease-out",
          isComposited: true,
          causesLayoutShift: false,
        },
      ],
    });

    assert.equal(result.report.reducedMotionCompliant, false);
    assert.equal(result.report.motionQualityClaimAllowed, false);
    assert.ok(
      result.report.failures.some((f) => f.failureCode === "MISSING_REDUCED_MOTION_ALTERNATIVE")
    );
  });

  test("5. Flags excessive duration (> 800ms) as UX warning", () => {
    const frameTimings = Array.from({ length: 20 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16,
      deltaMs: 16.0,
    }));

    const result = evaluateMotionObservations({
      sessionId: "sess_motion_5",
      url: "http://127.0.0.1:3000/tooltip",
      viewport: defaultViewport,
      prefersReducedMotion: false,
      frameTimings,
      animations: [
        {
          elementTag: "span",
          elementRole: "tooltip",
          accessibleName: "Help Tip",
          animationName: "slow-fade",
          propertyName: "opacity",
          durationMs: 1200, // Sluggish 1.2s tooltip fade
          easing: "linear",
          isComposited: true,
          causesLayoutShift: false,
        },
      ],
    });

    assert.ok(result.report.failures.some((f) => f.failureCode === "DURATION_TOO_LONG"));
  });

  test("6. Flags cumulative layout shift (CLS > 0.05) during animation as a blocker", () => {
    const frameTimings = Array.from({ length: 20 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16,
      deltaMs: 16.0,
    }));

    const result = evaluateMotionObservations({
      sessionId: "sess_motion_6",
      url: "http://127.0.0.1:3000/cards",
      viewport: defaultViewport,
      prefersReducedMotion: false,
      frameTimings,
      animations: [],
      layoutShifts: [
        { value: 0.03, timestampMs: 100 },
        { value: 0.04, timestampMs: 250 }, // Total CLS = 0.07 > 0.05
      ],
    });

    assert.equal(result.report.totalLayoutShift, 0.07);
    assert.equal(result.report.motionQualityClaimAllowed, false);
    assert.ok(result.report.failures.some((f) => f.failureCode === "UNWANTED_LAYOUT_SHIFT"));
  });
});
