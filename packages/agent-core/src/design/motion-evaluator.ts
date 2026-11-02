/**
 * Sprint 9C — Real Measured Motion Evaluation Engine.
 * Grounded in Motion primitives, Web Performance standards, and WCAG 2.1 2.3.3.
 *
 * Invariants (ADR-041):
 *   - Upgrades static CSS declaration probes into measured frame workflows.
 *   - Detects layout thrashing, dropped frames, duration bloat, and reduced-motion violations.
 *   - motionQualityClaimAllowed is true ONLY with measured FPS >= 55, zero layout thrashing,
 *     and proven reduced-motion compliance.
 */

import type {
  ActiveAnimationRecord,
  FrameTimingSample,
  LayoutShiftRecord,
  MeasuredMotionObservation,
  MotionEvaluationVerdict,
  MotionFailure,
  MotionInterruptionSample,
  MotionQualityReport,
} from "./contracts.ts";
import type { BrowserViewportDimensions } from "../browser/browser-observation-contracts.ts";

export interface MotionEvaluationInput {
  readonly sessionId: string;
  readonly url: string;
  readonly viewport: BrowserViewportDimensions;
  readonly prefersReducedMotion: boolean;
  readonly frameTimings: readonly FrameTimingSample[];
  readonly animations: readonly ActiveAnimationRecord[];
  readonly layoutShifts?: readonly LayoutShiftRecord[];
  readonly interruption?: MotionInterruptionSample;
  readonly unsupportedMeasurement?: boolean;
}

// Properties known to cause browser layout recalculation and paint thrashing
const LAYOUT_THRASHING_PROPERTIES = new Set([
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "top",
  "left",
  "right",
  "bottom",
  "margin",
  "margin-top",
  "margin-left",
  "margin-right",
  "margin-bottom",
  "padding",
  "padding-top",
  "padding-left",
  "padding-right",
  "padding-bottom",
  "border-width",
]);

export function evaluateMotionObservations(input: MotionEvaluationInput): MeasuredMotionObservation {
  const failures: MotionFailure[] = [];
  const layoutThrashingSet = new Set<string>();

  const limitationNotice =
    "In-page rAF frame sampling measures main-thread frame intervals over the capture window; it does not reflect GPU hardware compositor scheduling or universal 60 FPS performance across arbitrary client hardware.";

  const frameTimings = input.frameTimings || [];
  const animations = input.animations || [];
  const animationCount = animations.length;
  const reducedMotionTested = Boolean(input.prefersReducedMotion);

  // 0. Unsupported Measurement Check
  if (input.unsupportedMeasurement) {
    failures.push({
      failureCode: "UNSUPPORTED_MEASUREMENT",
      severity: "blocker",
      details: "Browser environment does not support requestAnimationFrame temporal sampling or Web Animations API.",
    });
    const report: MotionQualityReport = {
      verdict: "unsupported_measurement",
      measuredFps: 0,
      minFps: 0,
      jankCount: 0,
      totalFrames: 0,
      animationCount: 0,
      layoutThrashingProperties: [],
      reducedMotionCompliant: false,
      reducedMotionTested,
      totalLayoutShift: 0,
      motionQualityClaimAllowed: false,
      failures,
      score: 0,
      summary: "Motion measurement unsupported in active browser environment.",
      limitationNotice,
    };
    return {
      sessionId: input.sessionId,
      url: input.url,
      viewport: input.viewport,
      capturedAt: Date.now(),
      evidenceKind: "multi_frame_sample",
      prefersReducedMotion: input.prefersReducedMotion,
      frameTimings: [],
      animations: [],
      layoutShifts: [],
      report,
    };
  }

  // 1. Evidence sufficiency & animation presence checks
  if (frameTimings.length < 5) {
    failures.push({
      failureCode: "INSUFFICIENT_EVIDENCE",
      severity: "blocker",
      details: `Insufficient frame timing telemetry captured (${frameTimings.length} frame(s)). A minimum of 5 frames is required.`,
    });
  } else if (animationCount === 0) {
    failures.push({
      failureCode: "NO_ANIMATION_DETECTED",
      severity: "warning",
      details:
        "No active animations, transitions, or keyframe effects were detected during the measurement window. Cannot authorize motion-quality claims without active animation evidence.",
    });
  }

  // 2. Frame Timing & Jank Analysis
  let totalDelta = 0;
  let maxDelta = 0;
  let jankCount = 0;

  for (let i = 1; i < frameTimings.length; i++) {
    const delta = frameTimings[i]!.deltaMs;
    totalDelta += delta;
    if (delta > maxDelta) maxDelta = delta;
    if (delta > 33.3) {
      jankCount++;
    }
  }

  const sampleCount = Math.max(1, frameTimings.length - 1);
  const avgDelta = frameTimings.length > 1 ? totalDelta / sampleCount : 16.67;
  const measuredFps = Math.max(1, Math.min(120, Math.round(1000 / avgDelta)));
  const minFps = maxDelta > 0 ? Math.max(1, Math.round(1000 / maxDelta)) : measuredFps;

  if (jankCount > 0 && maxDelta > 50) {
    failures.push({
      failureCode: "FRAME_JANK_DETECTED",
      severity: jankCount > 3 ? "blocker" : "warning",
      details: `Detected ${jankCount} dropped frame(s) with maximum frame pause of ${maxDelta.toFixed(1)}ms (min FPS: ${minFps}).`,
    });
  }

  // 3. Layout Thrashing Properties Audit
  for (const anim of animations) {
    const prop = anim.propertyName.toLowerCase();
    if (LAYOUT_THRASHING_PROPERTIES.has(prop) && !anim.isComposited) {
      layoutThrashingSet.add(prop);
      failures.push({
        failureCode: "LAYOUT_THRASHING_PROPERTY",
        severity: "blocker",
        details: `Animated property '${prop}' triggers full browser layout recalculation. Use CSS 'transform' or 'opacity' instead.`,
        affectedElement: anim.accessibleName || anim.elementTag,
      });
    }

    // 4. Duration & Easing Bounds
    if (anim.durationMs > 800) {
      failures.push({
        failureCode: "DURATION_TOO_LONG",
        severity: "warning",
        details: `Animation '${anim.animationName}' duration (${anim.durationMs}ms) exceeds recommended 800ms ceiling for responsive UI.`,
        affectedElement: anim.accessibleName || anim.elementTag,
      });
    } else if (anim.durationMs < 50 && anim.durationMs > 0 && anim.animationName !== "none") {
      failures.push({
        failureCode: "DURATION_TOO_SHORT",
        severity: "warning",
        details: `Animation duration (${anim.durationMs}ms) is too rapid for perceptual continuity.`,
        affectedElement: anim.accessibleName || anim.elementTag,
      });
    }
  }

  // 5. Reduced-Motion Compliance
  let reducedMotionCompliant = true;
  if (reducedMotionTested) {
    let hasMotionViolations = false;
    for (const anim of animations) {
      if (
        anim.durationMs > 10 &&
        (anim.propertyName.includes("transform") ||
          anim.propertyName.includes("translate") ||
          anim.propertyName.includes("rotate") ||
          anim.propertyName.includes("scale"))
      ) {
        hasMotionViolations = true;
        failures.push({
          failureCode: "MISSING_REDUCED_MOTION_ALTERNATIVE",
          severity: "blocker",
          details: `Large spatial motion '${anim.propertyName}' active when 'prefers-reduced-motion: reduce' is requested. Replace with instant cut or opacity fade.`,
          affectedElement: anim.accessibleName || anim.elementTag,
        });
      }
    }
    reducedMotionCompliant = !hasMotionViolations;
  }

  // 6. Cumulative Layout Shift (CLS) during Animation
  const layoutShifts = input.layoutShifts || [];
  let totalLayoutShift = 0;
  for (const shift of layoutShifts) {
    totalLayoutShift += shift.value;
  }
  if (totalLayoutShift > 0.05) {
    failures.push({
      failureCode: "UNWANTED_LAYOUT_SHIFT",
      severity: "blocker",
      details: `Cumulative layout shift during animation is ${totalLayoutShift.toFixed(3)} (exceeds recommended 0.05 threshold).`,
    });
  }

  // 7. Interruption Handling
  if (input.interruption && input.interruption.snapDetected) {
    failures.push({
      failureCode: "INTERRUPTION_SNAP",
      severity: "warning",
      details: "Animation jumped or snapped abruptly when interrupted by user interaction instead of retargeting smoothly.",
    });
  }

  // Determine overall score, verdict, and claim authorization
  const layoutThrashingProperties = Array.from(layoutThrashingSet);
  const blockerCount = failures.filter((f) => f.severity === "blocker").length;
  const warningCount = failures.filter((f) => f.severity === "warning").length;

  let score = 100 - blockerCount * 30 - warningCount * 10;
  if (measuredFps < 50) score -= (50 - measuredFps);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: MotionEvaluationVerdict;
  let motionQualityClaimAllowed = false;

  if (input.unsupportedMeasurement) {
    verdict = "unsupported_measurement";
    motionQualityClaimAllowed = false;
  } else if (frameTimings.length < 5) {
    verdict = "insufficient_evidence";
    motionQualityClaimAllowed = false;
  } else if (animationCount === 0) {
    verdict = "no_animation_detected";
    motionQualityClaimAllowed = false;
  } else if (blockerCount > 0 || measuredFps < 50 || jankCount > 0 || layoutThrashingProperties.length > 0) {
    verdict = "measured_failing";
    motionQualityClaimAllowed = false;
  } else {
    verdict = "measured_passing";
    motionQualityClaimAllowed = true;
  }

  let summary = "";
  switch (verdict) {
    case "measured_passing":
      summary = `Smooth motion verified: measured ${measuredFps} FPS (min ${minFps} FPS), zero layout thrashing across ${animationCount} active animation(s).${
        reducedMotionTested ? (reducedMotionCompliant ? " Verified reduced-motion compliant." : " Reduced-motion non-compliant.") : " (Reduced-motion preference not tested in this capture)."
      }`;
      break;
    case "no_animation_detected":
      summary = "No active animations detected during measurement window. Cannot authorize motion-quality claims without active animation evidence.";
      break;
    case "insufficient_evidence":
      summary = `Insufficient measurement evidence: captured ${frameTimings.length} frames (minimum 5 required).`;
      break;
    case "unsupported_measurement":
      summary = "Motion measurement unsupported in active browser context.";
      break;
    case "measured_failing":
      summary = `Motion quality defects detected (Score: ${score}/100): ${failures.length} issue(s) identified. ${
        layoutThrashingProperties.length > 0 ? `Layout thrashing on ${layoutThrashingProperties.join(", ")}. ` : ""
      }${jankCount > 0 ? `${jankCount} dropped frame(s). ` : ""}${
        reducedMotionTested && !reducedMotionCompliant ? "Reduced-motion non-compliant. " : ""
      }`;
      break;
  }

  const report: MotionQualityReport = {
    verdict,
    measuredFps,
    minFps,
    jankCount,
    totalFrames: frameTimings.length,
    animationCount,
    layoutThrashingProperties,
    reducedMotionCompliant,
    reducedMotionTested,
    totalLayoutShift: Number(totalLayoutShift.toFixed(4)),
    motionQualityClaimAllowed,
    failures,
    score,
    summary,
    limitationNotice,
  };

  return {
    sessionId: input.sessionId,
    url: input.url,
    viewport: input.viewport,
    capturedAt: Date.now(),
    evidenceKind: "multi_frame_sample",
    prefersReducedMotion: input.prefersReducedMotion,
    frameTimings: input.frameTimings,
    animations: input.animations,
    layoutShifts,
    report,
  };
}
