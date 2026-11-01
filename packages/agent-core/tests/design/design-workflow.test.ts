/**
 * Sprint 9C — Design Workflow Engine Tests
 * Tests 5-stage sequential workflow (Stages A through E) and the bounded refinement loop.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DesignWorkflowEngine } from "../../src/design/design-workflow.ts";
import { createDefaultDesignBrief } from "../../src/design/design-brief.ts";
import type { VisualQAEvaluationContext } from "../../src/design/visual-qa-evaluator.ts";

const dummyRepairApplier = async (_findings: readonly any[], iter: number) => [
  `Repaired accessible name for button in iteration ${iter}`,
];

const failingProvider = async (): Promise<VisualQAEvaluationContext> => ({
  targetUrl: "http://localhost:3000",
  viewport: { width: 1280, height: 800 },
  presetId: "desktop",
  elements: [],
  consoleErrors: ["Fatal runtime error in vendor library"],
});

describe("Sprint 9C — Governed Design Workflow Engine", () => {
  it("1. Stage A (Discover & Shape) synthesizes visual direction document and tokens", () => {
    const brief = createDefaultDesignBrief({
      productType: "developer_tool",
      userGoals: ["Deploy serverless containers", "Monitor cluster health"],
      brandPositioning: {
        voice: "technical, authoritative",
        tone: "calm and precise",
        personality: ["robust", "developer-first", "high-performance"],
      },
    });

    const engine = new DesignWorkflowEngine({ brief });
    const { directionDoc, tokens } = engine.executeStageA_DiscoverAndShape();

    assert.equal(engine.currentStage, "discover_and_shape");
    assert.ok(directionDoc.includes("# Design Direction"));
    assert.ok(directionDoc.includes("developer_tool"));
    assert.ok(directionDoc.includes("Deploy serverless containers"));
    assert.ok(tokens.colors.primary);
    assert.ok(engine.generatedArtifacts.includes("DESIGN_DIRECTION.md"));
  });

  it("2. Stage B (Design System) formalizes CSS custom properties with reduced-motion support", () => {
    const brief = createDefaultDesignBrief();
    const engine = new DesignWorkflowEngine({ brief });
    engine.executeStageA_DiscoverAndShape();

    const { cssContent, tokens } = engine.executeStageB_DesignSystem();
    assert.equal(engine.currentStage, "design_system");
    assert.ok(cssContent.includes(":root {"));
    assert.ok(cssContent.includes("--color-primary"));
    assert.ok(cssContent.includes("@media (prefers-reduced-motion: reduce)"));
    assert.ok(engine.generatedArtifacts.includes("tokens.css"));
    assert.ok(tokens);
  });

  it("3. Stage C & Stage D progress through frontend composition and motion engineering", () => {
    const brief = createDefaultDesignBrief();
    const engine = new DesignWorkflowEngine({ brief });
    engine.executeStageA_DiscoverAndShape();
    engine.executeStageB_DesignSystem();

    const html = "<main><button class='btn-primary'>Deploy</button></main>";
    const stageC = engine.executeStageC_FrontendImplementation(html);
    assert.equal(engine.currentStage, "frontend_implementation");
    assert.equal(stageC.componentCode, html);
    assert.ok(engine.generatedArtifacts.includes("component.html"));

    const motionCss = ".btn-primary { transition: transform var(--motion-duration-fast); }";
    const stageD = engine.executeStageD_MotionEngineering(motionCss);
    assert.equal(engine.currentStage, "motion_engineering");
    assert.equal(stageD.motionCss, motionCss);
    assert.ok(engine.generatedArtifacts.includes("motion.css"));
  });

  it("4. Stage E succeeds immediately when first evaluation has 0 blockers/criticals", async () => {
    const brief = createDefaultDesignBrief();
    const engine = new DesignWorkflowEngine({ brief, maxImprovementIterations: 3 });
    engine.executeStageA_DiscoverAndShape();
    engine.executeStageB_DesignSystem();

    const cleanContext: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "btn-1",
          tag: "button",
          role: "button",
          accessibleName: "Deploy Application",
          textContent: "Deploy Application",
          isInteractive: true,
          hasFocusVisibleStyle: true,
          computedStyle: {
            color: "#ffffff",
            backgroundColor: "rgb(37, 99, 235)",
            outlineStyle: "solid",
          },
        },
      ],
      scrollWidth: 1280,
      clientWidth: 1280,
      consoleErrors: [],
    };

    const result = await engine.executeStageE_VisualQALoop(async () => cleanContext);
    assert.equal(result.status, "completed");
    assert.equal(result.verified, true);
    assert.equal(result.iterations.length, 1);
    assert.equal(result.unresolvedFindings.length, 0);
  });

  it("5. Stage E runs bounded refinement loop and fixes detected issues across iterations", async () => {
    const brief = createDefaultDesignBrief();
    const transitions: string[] = [];
    const engine = new DesignWorkflowEngine(
      { brief, maxImprovementIterations: 3 },
      {
        onStageTransition: (stage) => transitions.push(stage),
      }
    );
    engine.executeStageA_DiscoverAndShape();
    engine.executeStageB_DesignSystem();

    let attempt = 0;
    const provider = async (iter: number): Promise<VisualQAEvaluationContext> => {
      attempt = iter;
      if (iter === 1) {
        // First iteration has missing accessible name (blocker)
        return {
          targetUrl: "http://localhost:3000",
          viewport: { width: 1280, height: 800 },
          presetId: "desktop",
          elements: [
            {
              refId: "btn-1",
              tag: "button",
              role: "button",
              accessibleName: "", // blocker!
              textContent: "",
            },
          ],
        };
      }
      // Second iteration: repair was applied, button now has accessible text!
      return {
        targetUrl: "http://localhost:3000",
        viewport: { width: 1280, height: 800 },
        presetId: "desktop",
        elements: [
          {
            refId: "btn-1",
            tag: "button",
            role: "button",
            accessibleName: "Deploy Container",
            textContent: "Deploy Container",
            isInteractive: true,
            hasFocusVisibleStyle: true,
            computedStyle: {
              color: "#ffffff",
              backgroundColor: "rgb(37, 99, 235)",
              outlineStyle: "solid",
            },
          },
        ],
        scrollWidth: 1280,
        clientWidth: 1280,
      };
    };

    const result = await engine.executeStageE_VisualQALoop(provider, dummyRepairApplier);
    assert.equal(result.status, "completed");
    assert.equal(result.verified, true);
    assert.equal(result.iterations.length, 2);
    assert.equal(attempt, 2);
    assert.ok((result.iterations[0]?.repairsAttempted.length ?? 0) > 0);
  });

  it("6. Stage E stops cleanly when max iteration budget is exhausted with remaining blockers", async () => {
    const brief = createDefaultDesignBrief();
    const engine = new DesignWorkflowEngine({ brief, maxImprovementIterations: 2 });
    engine.executeStageA_DiscoverAndShape();

    const result = await engine.executeStageE_VisualQALoop(failingProvider);
    assert.equal(result.status, "iteration_budget_exhausted");
    assert.equal(result.verified, false);
    assert.equal(result.iterations.length, 2);
    assert.ok(result.unresolvedFindings.length > 0);
  });
});
