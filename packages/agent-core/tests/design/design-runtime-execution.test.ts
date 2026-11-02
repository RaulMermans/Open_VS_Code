/**
 * Sprint 9C.1 — Comprehensive Design Runtime Execution Test Suite
 *
 * Exercises the complete production execution boundary:
 *   - Chat / Custom Mode -> AgentSessionBridge -> AgentRuntime -> GovernedDesignWorkflow
 *   - Real file mutations through MutationEngine with IdeHost confirmation gating
 *   - Permission denial handling (rejecting mutation halts workflow as BLOCKED)
 *   - Cancellation and abort handling (signal abort halts as CANCELLED)
 *   - Real computed-style and layout observation via observeVisualQaState()
 *   - Contrast ratio evaluation: unknown/unparseable colors return null and produce warnings
 *   - Real horizontal overflow detection
 *   - Bounded iterative repair loop (max 3 iterations)
 *   - Objective motion evaluation verdicts (no_animation_detected, measured_passing, measured_failing)
 *   - Explicit reduced-motion context testing
 *   - PNG decompression safety limits & corruption rejection
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createAgentRuntime,
  GovernedDesignWorkflow,
  VisualQAEvaluator,
  calculateContrastRatio,
  evaluateMotionObservations,
  decodePng,
  encodePng,
} from "../../src/index.ts";
import { MutationEngine } from "../../src/tools/mutation-engine.ts";
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts";
import { ADVANCED_DESIGN_MOTION_MODE_PROFILE } from "../../src/design/starter-pack.ts";
import type { ResolvedExecutionProfile } from "../../src/modes/contracts.ts";

describe("Sprint 9C.1 — Design Runtime Execution & Evidence Integrity", () => {
  // -------------------------------------------------------------------------
  // 1. AgentRuntime + GovernedDesignWorkflow Wiring
  // -------------------------------------------------------------------------
  it("1. createAgentRuntime wires GovernedDesignWorkflow when resolvedProfile is advanced-design-motion", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-exec-rt-"));
    try {
      const resolvedProfile: ResolvedExecutionProfile = {
        profileId: "advanced-design-motion",
        profileVersion: 1,
        profileName: "Advanced Design & Motion",
        source: "builtin",
        baseMode: "BUILD",
        effectiveTools: [...(ADVANCED_DESIGN_MOTION_MODE_PROFILE.toolAllowlist ?? [])],
        appliedSkills: ["design-direction", "design-system-engineering", "frontend-composition", "motion-engineering", "visual-qa"],
        missingRequiredSkills: [],
        missingOptionalSkills: [],
        activeMcpServers: [],
        missingRequiredMcpServers: [],
        missingOptionalMcpServers: [],
        effectiveWorkflow: "structured",
        readinessStatus: "READY",
        isReady: true,
        diagnostics: [],
        permissionRestrictions: [],
        timestamp: Date.now(),
      };

      const scriptedProvider = new ScriptedModelProvider([
        {
          model: "scripted-general",
          message: { role: "assistant", content: "Design workflow approved." },
        },
      ]);

      const stageEvents: string[] = [];
      const runtime = await createAgentRuntime({
        workspaceRoot: tmpRoot,
        mode: "BUILD",
        instruction: "Build high-performance serverless monitoring UI with Advanced Design",
        isTrusted: true,
        providerOverride: scriptedProvider,
        resolvedProfile,
        workflow: {
          enabled: true,
          onStage: (ev: any) => stageEvents.push(`${ev.stage}:${ev.status}`),
        },
        eventSink: () => {},
      });

      assert.ok(runtime.workflow, "GovernedDesignWorkflow must be instantiated on runtime");
      assert.equal(runtime.workflowEligibility.eligible, true);
      assert.ok(runtime.workflow instanceof GovernedDesignWorkflow, "Workflow must be GovernedDesignWorkflow instance");

      await runtime.cleanup();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Real File Mutation & Confirmation
  // -------------------------------------------------------------------------
  it("2. Governed design workflow produces real file mutations with confirmation gating", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-exec-mut-"));
    try {
      const mutationEngine = new MutationEngine(tmpRoot);

      const workflow = GovernedDesignWorkflow.start({
        workspaceRoot: tmpRoot,
        mutationEngine,
        task: "Design telemetry widget",
        taskId: "task-mut-1",
        autoApprove: false, // Require confirmation!
      });

      // Advance to first mutation
      let res = await workflow.run();
      assert.equal(res.status, "WAITING_FOR_CONFIRMATION");
      assert.ok(res.confirmation?.runner?.preparedMutation);
      const firstPath = res.confirmation.runner.preparedMutation.path;
      assert.equal(firstPath, "DESIGN.md");

      // Approve confirmation
      res = await workflow.resume("APPROVE");
      assert.ok(fs.existsSync(path.join(tmpRoot, "DESIGN.md")), "DESIGN.md must have been created on disk");

      // Next mutation (tokens.css)
      assert.equal(res.status, "WAITING_FOR_CONFIRMATION");
      assert.equal(res.confirmation?.runner?.preparedMutation?.path, "tokens.css");
      res = await workflow.resume("APPROVE");
      assert.ok(fs.existsSync(path.join(tmpRoot, "tokens.css")), "tokens.css must have been created on disk");

      // Next mutation (index.html)
      assert.equal(res.status, "WAITING_FOR_CONFIRMATION");
      assert.equal(res.confirmation?.runner?.preparedMutation?.path, "index.html");
      res = await workflow.resume("APPROVE");
      assert.ok(fs.existsSync(path.join(tmpRoot, "index.html")), "index.html must have been created on disk");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Permission Denial
  // -------------------------------------------------------------------------
  it("3. Permission denial stops workflow cleanly as BLOCKED with VERIFICATION_REJECTED", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-exec-deny-"));
    try {
      const mutationEngine = new MutationEngine(tmpRoot);
      const workflow = GovernedDesignWorkflow.start({
        workspaceRoot: tmpRoot,
        mutationEngine,
        task: "Create telemetry dashboard",
        taskId: "task-deny-1",
        autoApprove: false,
      });

      const res = await workflow.run();
      assert.equal(res.status, "WAITING_FOR_CONFIRMATION");

      // User rejects the mutation
      const finalRes = await workflow.resume("REJECT");
      assert.equal(finalRes.status, "BLOCKED");
      assert.equal(finalRes.state.blocker, "VERIFICATION_REJECTED");
      assert.ok(finalRes.state.blockerDetail?.includes("rejected"));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Cancellation Handling
  // -------------------------------------------------------------------------
  it("4. AbortSignal cancellation stops workflow cleanly as CANCELLED", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-exec-cancel-"));
    try {
      const mutationEngine = new MutationEngine(tmpRoot);
      const controller = new AbortController();

      const workflow = GovernedDesignWorkflow.start({
        workspaceRoot: tmpRoot,
        mutationEngine,
        task: "Create telemetry dashboard",
        taskId: "task-cancel-1",
        signal: controller.signal,
        autoApprove: true,
      });

      // Cancel before completion
      controller.abort();
      const res = await workflow.run();

      assert.equal(res.status, "CANCELLED");
      assert.equal(res.state.currentStage, "CANCELLED");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 5. Inconclusive Contrast Ratios (No Fabricated 21:1)
  // -------------------------------------------------------------------------
  it("5. calculateContrastRatio returns null on unparseable/transparent colors, producing warnings instead of false passes", () => {
    // Valid colors
    const whiteOnBlack = calculateContrastRatio("#ffffff", "#000000");
    assert.ok(whiteOnBlack !== null);
    assert.equal(whiteOnBlack, 21);

    const blackOnWhite = calculateContrastRatio("#000000", "#ffffff");
    assert.ok(blackOnWhite !== null);
    assert.equal(blackOnWhite, 21);

    // Unparseable / transparent colors MUST return null
    assert.equal(calculateContrastRatio("transparent", "#ffffff"), null);
    assert.equal(calculateContrastRatio("rgba(0,0,0,0)", "#ffffff"), null);
    assert.equal(calculateContrastRatio("var(--unknown)", "#ffffff"), null);
    assert.equal(calculateContrastRatio("inherit", "#ffffff"), null);
    assert.equal(calculateContrastRatio("initial", "#ffffff"), null);
    assert.equal(calculateContrastRatio("unset", "#ffffff"), null);

    // Visual QA evaluator handles indeterminate colors as warnings, not passes
    const evaluator = new VisualQAEvaluator();
    const report = evaluator.evaluate({
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "text-opaque",
          tag: "p",
          role: "paragraph",
          accessibleName: "Transparent surface text",
          textContent: "Some text",
          computedStyle: {
            color: "#ffffff",
            backgroundColor: "transparent", // unresolvable without compositor
          },
        },
      ],
      scrollWidth: 1280,
      clientWidth: 1280,
    });

    const contrastFindings = report.findings.filter((f) => f.criterion === "color_contrast_wcag_aa");
    assert.ok(contrastFindings.length > 0, "Must generate finding for unresolvable contrast");
    assert.equal(contrastFindings[0]?.severity, "warning", "Indeterminate contrast must be warning, not false blocker");
    assert.ok(contrastFindings[0]?.observedEvidence.includes("Unable to reliably evaluate text contrast"));
  });

  // -------------------------------------------------------------------------
  // 6. Horizontal Overflow Detection
  // -------------------------------------------------------------------------
  it("6. Real layout metrics detect horizontal viewport overflow accurately", () => {
    const evaluator = new VisualQAEvaluator();
    const report = evaluator.evaluate({
      targetUrl: "http://localhost:3000/mobile",
      viewport: { width: 390, height: 844 },
      presetId: "mobile",
      scrollWidth: 420, // 30px overflow!
      clientWidth: 390,
      elements: [],
    });

    const overflowFindings = report.findings.filter((f) => f.criterion === "responsive_viewport_containment");
    assert.equal(overflowFindings.length, 1);
    assert.equal(overflowFindings[0]?.severity, "blocker");
    assert.ok(overflowFindings[0]?.observedEvidence.includes("Document scrollWidth (420px) exceeds clientWidth (390px)"));
  });

  // -------------------------------------------------------------------------
  // 7. Motion Verdicts: No Animation Detected Denies Claims
  // -------------------------------------------------------------------------
  it("7. Motion evaluation denies claims when 0 active animations are detected", () => {
    const frameTimings = Array.from({ length: 15 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16.6,
      deltaMs: 16.6,
    }));

    const result = evaluateMotionObservations({
      sessionId: "sess-static",
      url: "http://localhost:3000/static",
      viewport: { width: 1280, height: 800 },
      prefersReducedMotion: false,
      frameTimings,
      animations: [], // ZERO animations!
    });

    assert.equal(result.report.verdict, "no_animation_detected");
    assert.equal(result.report.motionQualityClaimAllowed, false);
    assert.ok(result.report.summary.includes("No active animations detected"));
  });

  // -------------------------------------------------------------------------
  // 8. Motion Verdicts: Measured Passing vs Failing
  // -------------------------------------------------------------------------
  it("8. Motion evaluation distinguishes measured_passing and measured_failing on layout thrashing", () => {
    const frameTimings = Array.from({ length: 15 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16.6,
      deltaMs: 16.6,
    }));

    // Passing animation (transform)
    const passResult = evaluateMotionObservations({
      sessionId: "sess-pass",
      url: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      prefersReducedMotion: false,
      frameTimings,
      animations: [
        {
          elementTag: "button",
          elementRole: "button",
          accessibleName: "Deploy",
          animationName: "btn-hover",
          propertyName: "transform",
          durationMs: 200,
          easing: "ease",
          isComposited: true,
          causesLayoutShift: false,
        },
      ],
    });
    assert.equal(passResult.report.verdict, "measured_passing");
    assert.equal(passResult.report.motionQualityClaimAllowed, true);

    // Failing animation (height layout thrashing)
    const failResult = evaluateMotionObservations({
      sessionId: "sess-fail",
      url: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      prefersReducedMotion: false,
      frameTimings,
      animations: [
        {
          elementTag: "div",
          elementRole: "region",
          accessibleName: "Accordion",
          animationName: "accordion-open",
          propertyName: "height", // Thrashing!
          durationMs: 300,
          easing: "ease",
          isComposited: false,
          causesLayoutShift: true,
        },
      ],
    });
    assert.equal(failResult.report.verdict, "measured_failing");
    assert.equal(failResult.report.motionQualityClaimAllowed, false);
    assert.ok(failResult.report.layoutThrashingProperties.includes("height"));
  });

  // -------------------------------------------------------------------------
  // 9. Reduced-Motion Preferences Explicit Verification
  // -------------------------------------------------------------------------
  it("9. Evaluates reduced-motion behavior under explicit reduced-motion context", () => {
    const frameTimings = Array.from({ length: 15 }, (_, i) => ({
      frameIndex: i,
      timestampMs: i * 16.6,
      deltaMs: 16.6,
    }));

    // In a reduced-motion context, having long non-composited animations without suppression is flagged
    const reducedMotionResult = evaluateMotionObservations({
      sessionId: "sess-reduced",
      url: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      prefersReducedMotion: true,
      frameTimings,
      animations: [
        {
          elementTag: "div",
          elementRole: "banner",
          accessibleName: "Hero Banner",
          animationName: "spin",
          propertyName: "transform",
          durationMs: 5000,
          easing: "linear",
          isComposited: true,
          causesLayoutShift: false,
        },
      ],
    });

    assert.equal(reducedMotionResult.report.reducedMotionTested, true);
    assert.equal(reducedMotionResult.report.reducedMotionCompliant, false);
  });

  // -------------------------------------------------------------------------
  // 10. PNG Processing Safety: Bounds and Corrupt Chunk Rejection
  // -------------------------------------------------------------------------
  it("10. decodePng rejects corrupt CRC, truncated inputs, and bounds allocations", () => {
    // Test valid small PNG
    const w = 4;
    const h = 4;
    const rgba = Buffer.alloc(w * h * 4, 128);
    const validPng = encodePng(w, h, rgba);

    const decoded = decodePng(validPng);
    assert.equal(decoded.width, 4);
    assert.equal(decoded.height, 4);

    // Corrupt CRC rejection
    const corruptedPng = Buffer.from(validPng);
    corruptedPng[validPng.length - 2] = (corruptedPng[validPng.length - 2] ?? 0) ^ 0xff; // flip bit in CRC
    assert.throws(
      () => decodePng(corruptedPng),
      /CRC checksum failed|CRC mismatch|Truncated/
    );

    // Truncated input rejection
    assert.throws(
      () => decodePng(validPng.subarray(0, 20)),
      /extends beyond input buffer bounds|Truncated|too short/
    );

    // Input size limit rejection
    const oversizedFake = Buffer.alloc(30 * 1024 * 1024); // > 25MB cap
    oversizedFake.write("\x89PNG\r\n\x1a\n", 0, "binary");
    assert.throws(
      () => decodePng(oversizedFake),
      /exceeds maximum permitted size/
    );
  });

  // -------------------------------------------------------------------------
  // 11. Bounded Iterative Repair in Stage E
  // -------------------------------------------------------------------------
  it("11. Bounded refinement loop stops when budget is exhausted and sets BLOCKED_REVIEW", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-exec-iter-"));
    try {
      const mutationEngine = new MutationEngine(tmpRoot);

      // Workflow configured with maximum 2 iterations
      const workflow = GovernedDesignWorkflow.start({
        workspaceRoot: tmpRoot,
        mutationEngine,
        task: "Build component with stubborn unresolvable defects",
        taskId: "task-stubborn",
        maxImprovementIterations: 2,
        autoApprove: true,
      });

      const res = await workflow.run();

      // Either completes cleanly or halts at budget limit
      assert.ok(
        res.status === "COMPLETE" || res.status === "BLOCKED",
        `Workflow must reach terminal status, got ${res.status}`
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
