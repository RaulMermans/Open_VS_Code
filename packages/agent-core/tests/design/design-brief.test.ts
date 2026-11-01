import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  createDefaultDesignBrief,
  deriveDesignTokensFromBrief,
  formatDesignDirectionDoc,
  formatDesignTokensAsCss,
  validateDesignBrief,
  DesignBriefValidationError,
} from "../../src/design/index.ts";

describe("Sprint 9C — Design Brief & Token Generation Contracts", () => {
  test("1. createDefaultDesignBrief returns a valid complete DesignBrief", () => {
    const brief = createDefaultDesignBrief();
    assert.ok(brief.briefId.startsWith("brief-"));
    assert.equal(brief.productType, "developer_tool");
    assert.equal(brief.accessibilityRequirements.standard, "WCAG_AA");
    assert.equal(brief.accessibilityRequirements.motionPreference, "respect_reduced_motion");
    assert.ok(brief.userGoals.length >= 3);
    assert.ok(brief.confirmedRequirements.length > 0);
    assert.ok(brief.inferredPreferences.length > 0);
  });

  test("2. validateDesignBrief rejects non-objects, missing required fields, and invalid archetypes", () => {
    assert.throws(
      () => validateDesignBrief(null),
      (err: any) => err instanceof DesignBriefValidationError && err.message.includes("non-null object")
    );
    assert.throws(
      () => validateDesignBrief({}),
      (err: any) => err instanceof DesignBriefValidationError && err.message.includes("briefId")
    );
    assert.throws(
      () =>
        validateDesignBrief({
          briefId: "b1",
          productType: "unsupported_xyz",
        }),
      (err: any) => err instanceof DesignBriefValidationError && err.message.includes("Invalid productType")
    );
    assert.throws(
      () =>
        validateDesignBrief({
          briefId: "b1",
          productType: "developer_tool",
          intendedAudience: "",
        }),
      (err: any) => err instanceof DesignBriefValidationError && err.message.includes("intendedAudience")
    );
    assert.throws(
      () =>
        validateDesignBrief({
          briefId: "b1",
          productType: "developer_tool",
          intendedAudience: "developers",
          userGoals: [],
        }),
      (err: any) => err instanceof DesignBriefValidationError && err.message.includes("userGoals")
    );
  });

  test("3. validateDesignBrief validates aesthetic direction styles and preserves confirmed vs inferred preferences", () => {
    const brief = validateDesignBrief({
      briefId: "b-custom-1",
      productType: "saas_dashboard",
      intendedAudience: "Financial analysts",
      userGoals: ["Analyze portfolio risks", "Export compliance reports"],
      brandPositioning: { voice: "authoritative", tone: "calm", personality: ["analytical", "secure"] },
      desiredAestheticDirection: {
        style: "high_contrast_utilitarian",
        primaryColorIntent: "#059669",
        darkModeRequired: true,
      },
      confirmedRequirements: ["WCAG_AA compliance", "Export to CSV"],
      inferredPreferences: ["Prefers compact data tables"],
    });

    assert.equal(brief.briefId, "b-custom-1");
    assert.equal(brief.desiredAestheticDirection.style, "high_contrast_utilitarian");
    assert.equal(brief.desiredAestheticDirection.primaryColorIntent, "#059669");
    assert.deepEqual(brief.confirmedRequirements, ["WCAG_AA compliance", "Export to CSV"]);
    assert.deepEqual(brief.inferredPreferences, ["Prefers compact data tables"]);
  });

  test("4. deriveDesignTokensFromBrief synthesizes coherent colors, typography, spacing, and motion tokens", () => {
    const brief = createDefaultDesignBrief({
      desiredAestheticDirection: {
        style: "modern_technical",
        primaryColorIntent: "#3b82f6",
        darkModeRequired: true,
      },
    });

    const tokens = deriveDesignTokensFromBrief(brief);
    assert.equal(tokens.isDark, true);
    assert.equal(tokens.colors.primary.hex, "#3b82f6");
    assert.ok(tokens.colors.background.hex.startsWith("#"));
    assert.ok(tokens.colors.textPrimary.hex.startsWith("#"));
    assert.ok(tokens.typography.scale["base"]?.fontSize === "16px");
    assert.ok(tokens.spacing["4"] === "16px");
    assert.equal(tokens.motion.durationFast, "150ms");
    assert.equal(tokens.motion.durationNormal, "250ms");
    assert.ok(tokens.motion.easeStandard.includes("cubic-bezier"));
  });

  test("5. formatDesignTokensAsCss outputs valid CSS variables and prefers-reduced-motion media query", () => {
    const brief = createDefaultDesignBrief();
    const tokens = deriveDesignTokensFromBrief(brief);
    const css = formatDesignTokensAsCss(tokens);

    assert.ok(css.includes(":root {"));
    assert.ok(css.includes("--color-bg:"));
    assert.ok(css.includes("--color-primary:"));
    assert.ok(css.includes("--font-sans:"));
    assert.ok(css.includes("--space-4: 16px;"));
    assert.ok(css.includes("@media (prefers-reduced-motion: reduce) {"));
    assert.ok(css.includes("animation-duration: 0.01ms !important;"));
  });

  test("6. formatDesignDirectionDoc formats structured Markdown design direction", () => {
    const brief = createDefaultDesignBrief();
    const tokens = deriveDesignTokensFromBrief(brief);
    const doc = formatDesignDirectionDoc(brief, tokens);

    assert.ok(doc.includes("# Design Direction:"));
    assert.ok(doc.includes("User Goals & Hierarchy"));
    assert.ok(doc.includes("Typography Strategy"));
    assert.ok(doc.includes("Color & Surface Architecture"));
    assert.ok(doc.includes("Motion Language"));
  });
});
