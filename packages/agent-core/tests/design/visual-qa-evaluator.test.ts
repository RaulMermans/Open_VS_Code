/**
 * Sprint 9C — Visual QA Evaluator Tests
 * Validates deterministic accessibility/contrast/overflow/runtime checks
 * and judgment-based visual hierarchy & typography measure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VisualQAEvaluator,
  calculateContrastRatio,
  type VisualQAEvaluationContext,
  type EvaluatorElementSnapshot,
} from "../../src/design/visual-qa-evaluator.ts";

describe("Sprint 9C — Visual QA Evaluator Engine", () => {
  it("1. calculateContrastRatio accurately calculates WCAG contrast ratios", () => {
    // Pure black on pure white -> 21:1
    const blackOnWhite = calculateContrastRatio("#000000", "#ffffff");
    assert.ok(blackOnWhite !== null && blackOnWhite >= 20.9 && blackOnWhite <= 21.1, `Expected ~21:1, got ${blackOnWhite}`);

    // Pure white on pure black -> 21:1
    const whiteOnBlack = calculateContrastRatio("#ffffff", "#000000");
    assert.ok(whiteOnBlack !== null && whiteOnBlack >= 20.9 && whiteOnBlack <= 21.1, `Expected ~21:1, got ${whiteOnBlack}`);

    // Mid-gray #767676 on white -> WCAG AA 4.54:1 boundary
    const grayOnWhite = calculateContrastRatio("#767676", "#ffffff");
    assert.ok(grayOnWhite !== null && grayOnWhite >= 4.5, `Expected >= 4.5:1 for #767676, got ${grayOnWhite}`);

    // Light gray #cccccc on white -> Fail (< 2.0:1)
    const lightGrayOnWhite = calculateContrastRatio("#cccccc", "#ffffff");
    assert.ok(lightGrayOnWhite !== null && lightGrayOnWhite < 2.0, `Expected < 2.0:1 for #cccccc, got ${lightGrayOnWhite}`);

    // rgb() format parsing
    const rgbTest = calculateContrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)");
    assert.ok(rgbTest !== null && rgbTest >= 20.9, `Expected ~21:1 from rgb(), got ${rgbTest}`);
  });

  it("2. Clean DOM context yields score 100 with deterministicPass and overallPass true", () => {
    const evaluator = new VisualQAEvaluator();
    const cleanElements: EvaluatorElementSnapshot[] = [
      {
        refId: "el-1",
        tag: "header",
        role: "banner",
        accessibleName: "Site Header",
      },
      {
        refId: "el-2",
        tag: "h1",
        role: "heading",
        accessibleName: "Developer Tools Platform",
        textContent: "Developer Tools Platform",
        computedStyle: {
          color: "#0f172a",
          backgroundColor: "#ffffff",
          fontSize: "32px",
          fontWeight: "700",
        },
      },
      {
        refId: "el-3",
        tag: "button",
        role: "button",
        accessibleName: "Deploy Project",
        textContent: "Deploy Project",
        isInteractive: true,
        hasFocusVisibleStyle: true,
        computedStyle: {
          color: "#ffffff",
          backgroundColor: "rgb(37, 99, 235)",
          outlineStyle: "solid",
        },
      },
    ];

    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: cleanElements,
      scrollWidth: 1280,
      clientWidth: 1280,
      consoleErrors: [],
    };

    const report = evaluator.evaluate(context);
    assert.equal(report.overallPass, true);
    assert.equal(report.deterministicPass, true);
    assert.equal(report.judgmentPass, true);
    assert.equal(report.score, 100);
    assert.equal(report.findings.length, 0);
  });

  it("3. Flags console runtime errors as critical findings", () => {
    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [],
      consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'map')"],
    };

    const report = evaluator.evaluate(context);
    assert.equal(report.overallPass, false);
    assert.equal(report.deterministicPass, false);
    const finding = report.findings.find((f) => f.criterion === "runtime_cleanliness");
    assert.ok(finding);
    assert.equal(finding?.severity, "critical");
    assert.ok(finding?.observedEvidence.includes("TypeError"));
  });

  it("4. Flags horizontal overflow (scrollWidth > clientWidth + 2) as blocker", () => {
    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 390, height: 844 },
      presetId: "mobile",
      elements: [],
      scrollWidth: 460, // 70px overflow!
      clientWidth: 390,
    };

    const report = evaluator.evaluate(context);
    assert.equal(report.overallPass, false);
    assert.equal(report.deterministicPass, false);
    const finding = report.findings.find((f) => f.criterion === "responsive_viewport_containment");
    assert.ok(finding);
    assert.equal(finding?.severity, "blocker");
    assert.ok(finding?.observedEvidence.includes("460px"));
  });

  it("5. Flags interactive elements missing accessible names as blocker", () => {
    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "btn-icon-only",
          tag: "button",
          role: "button",
          accessibleName: "",
          textContent: "", // Empty icon button!
          isInteractive: true,
        },
      ],
    };

    const report = evaluator.evaluate(context);
    assert.equal(report.overallPass, false);
    const finding = report.findings.find((f) => f.criterion === "accessible_naming");
    assert.ok(finding);
    assert.equal(finding?.severity, "blocker");
    assert.equal(finding?.location.refId, "btn-icon-only");
  });

  it("6. Flags images missing alt text as critical", () => {
    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "img-hero",
          tag: "img",
          role: "img",
          accessibleName: "", // missing alt
        },
      ],
    };

    const report = evaluator.evaluate(context);
    assert.equal(report.overallPass, false);
    const finding = report.findings.find((f) => f.criterion === "image_alternative_text");
    assert.ok(finding);
    assert.equal(finding?.severity, "critical");
    assert.equal(finding?.location.refId, "img-hero");
  });

  it("7. Flags outline:none without focus-visible replacement as critical", () => {
    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "btn-bad-focus",
          tag: "button",
          role: "button",
          accessibleName: "Submit",
          textContent: "Submit",
          isInteractive: true,
          hasFocusVisibleStyle: false,
          computedStyle: {
            outlineStyle: "none",
          },
        },
      ],
    };

    const report = evaluator.evaluate(context);
    assert.equal(report.overallPass, false);
    const finding = report.findings.find((f) => f.criterion === "focus_visibility");
    assert.ok(finding);
    assert.equal(finding?.severity, "critical");
  });

  it("8. Flags poor text contrast below 4.5:1 as critical", () => {
    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "txt-faint",
          tag: "span",
          role: "text",
          accessibleName: "Faint secondary metadata",
          textContent: "Faint secondary metadata",
          computedStyle: {
            color: "#999999",
            backgroundColor: "#ffffff", // Contrast is ~2.85:1
            fontSize: "14px",
          },
        },
      ],
    };

    const report = evaluator.evaluate(context);
    assert.equal(report.overallPass, false);
    const finding = report.findings.find((f) => f.criterion === "color_contrast_wcag_aa");
    assert.ok(finding);
    assert.equal(finding?.severity, "critical");
  });

  it("9. Evaluates judgment-based typography measure for excessively wide paragraphs", () => {
    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "p-wide",
          tag: "p",
          role: "paragraph",
          accessibleName: "",
          textContent:
            "This is an excessively long line of text that spans across the entire desktop viewport without any max-width constraints or container boundaries, making it very tiring for human eyes to track across the broad horizon of modern high-resolution displays.",
          bounds: { x: 20, y: 100, width: 1100, height: 40 },
        },
      ],
    };

    const report = evaluator.evaluate(context);
    const finding = report.findings.find((f) => f.criterion === "typography_measure");
    assert.ok(finding);
    assert.equal(finding?.severity, "suggestion");
    assert.equal(finding?.category, "judgment_based");
  });

  it("10. Unparseable, transparent, or indeterminate colors return null and produce inconclusive warnings instead of 21:1", () => {
    // Unparseable colors return null
    assert.equal(calculateContrastRatio("not_evaluated", "#ffffff"), null);
    assert.equal(calculateContrastRatio("transparent", "#ffffff"), null);
    assert.equal(calculateContrastRatio("invalid-color", "#000000"), null);
    assert.equal(calculateContrastRatio(undefined, "#ffffff"), null);

    const evaluator = new VisualQAEvaluator();
    const context: VisualQAEvaluationContext = {
      targetUrl: "http://localhost:3000",
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      elements: [
        {
          refId: "el-unparseable",
          tag: "p",
          role: "paragraph",
          accessibleName: "Indeterminate text",
          textContent: "Some text with unknown background",
          computedStyle: {
            color: "#111111",
            backgroundColor: "transparent",
            effectiveBackgroundColor: "transparent",
          },
        },
      ],
    };

    const report = evaluator.evaluate(context);
    const finding = report.findings.find((f) => f.criterion === "color_contrast_wcag_aa");
    assert.ok(finding, "Expected finding for indeterminate colors");
    assert.equal(finding?.severity, "warning");
    assert.ok(finding?.observedEvidence.includes("could not be determined or are transparent"));
    assert.ok(report.summary.includes("does not guarantee complete manual WCAG AA compliance"));
  });
});
