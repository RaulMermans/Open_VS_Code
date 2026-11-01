/**
 * Sprint 9C — Independent Visual QA Evaluator.
 * Combines deterministic checks with evidence-grounded visual critique.
 *
 * Invariants (ADR-041):
 *   - Grounded in real DOM observations, accessibility snapshots, and computed styles.
 *   - Zero fabricated findings: every finding must cite exact location and observed evidence.
 *   - Separates deterministic failures (WCAG contrast, overflow, missing elements) from
 *     judgment-based critique (visual hierarchy, rhythm, brand coherence).
 */

import type {
  DifferenceRegion,
  VisualQAFinding,
  VisualQAReport,
  VisualQASeverity,
} from "./contracts.ts";
import type {
  BrowserViewportDimensions,
  ViewportPresetId,
} from "../browser/browser-observation-contracts.ts";

export interface EvaluatorElementSnapshot {
  readonly refId: string;
  readonly tag: string;
  readonly role: string;
  readonly accessibleName: string;
  readonly textContent?: string;
  readonly bounds?: { x: number; y: number; width: number; height: number };
  readonly computedStyle?: {
    readonly color?: string;
    readonly backgroundColor?: string;
    readonly fontSize?: string;
    readonly fontWeight?: string;
    readonly lineHeight?: string;
    readonly fontFamily?: string;
    readonly display?: string;
    readonly position?: string;
    readonly overflow?: string;
    readonly outlineStyle?: string;
  };
  readonly isInteractive?: boolean;
  readonly hasFocusVisibleStyle?: boolean;
}

export interface VisualQAEvaluationContext {
  readonly targetUrl: string;
  readonly viewport: BrowserViewportDimensions;
  readonly presetId: ViewportPresetId;
  readonly elements: readonly EvaluatorElementSnapshot[];
  readonly consoleErrors?: readonly string[];
  readonly differenceRegions?: readonly DifferenceRegion[];
  readonly scrollWidth?: number;
  readonly clientWidth?: number;
}

// ---------------------------------------------------------------------------
// WCAG Contrast Ratio Calculator
// ---------------------------------------------------------------------------

function parseRgb(colorStr: string): [number, number, number] | null {
  if (!colorStr) return null;
  const hex = colorStr.trim().replace(/^#/, "");
  if (hex.length === 3) {
    return [
      parseInt(hex[0]! + hex[0]!, 16),
      parseInt(hex[1]! + hex[1]!, 16),
      parseInt(hex[2]! + hex[2]!, 16),
    ];
  }
  if (hex.length === 6) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const rgbMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  return null;
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function calculateContrastRatio(fgStr: string, bgStr: string): number {
  const fg = parseRgb(fgStr);
  const bg = parseRgb(bgStr);
  if (!fg || !bg) return 21; // Assume high contrast if color is unparseable or transparent
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// VisualQAEvaluator
// ---------------------------------------------------------------------------

export class VisualQAEvaluator {
  public evaluate(context: VisualQAEvaluationContext): VisualQAReport {
    const findings: VisualQAFinding[] = [];
    let findingSeq = 0;

    const createId = () => `finding-${++findingSeq}`;

    // -------------------------------------------------------------------------
    // Deterministic Checks
    // -------------------------------------------------------------------------

    // 1. Unhandled Runtime / Console Errors
    if (context.consoleErrors && context.consoleErrors.length > 0) {
      for (const err of context.consoleErrors) {
        findings.push({
          findingId: createId(),
          criterion: "runtime_cleanliness",
          category: "deterministic",
          severity: "critical",
          observedEvidence: `Console error logged during execution: ${err.slice(0, 140)}`,
          expectedBehavior: "Page renders without unhandled JavaScript exceptions or console errors.",
          location: {},
          suggestedCorrection: "Fix unhandled exception or missing asset reference in component code.",
          confidence: 1.0,
        });
      }
    }

    // 2. Responsive Horizontal Overflow
    if (
      context.scrollWidth !== undefined &&
      context.clientWidth !== undefined &&
      context.scrollWidth > context.clientWidth + 2
    ) {
      findings.push({
        findingId: createId(),
        criterion: "responsive_viewport_containment",
        category: "deterministic",
        severity: "blocker",
        observedEvidence: `Document scrollWidth (${context.scrollWidth}px) exceeds clientWidth (${context.clientWidth}px) at ${context.viewport.width}x${context.viewport.height} (${context.presetId}).`,
        expectedBehavior: "Layout fits cleanly within the viewport without unintentional horizontal scrolling.",
        location: {},
        suggestedCorrection: "Add `overflow-x: hidden` or replace fixed pixel widths with fluid percentages/max-widths.",
        confidence: 1.0,
      });
    }

    // 3. Accessibility & Contrast Audit per Element
    for (const el of context.elements) {
      // 3a. Interactive Elements without Accessible Names
      if (
        (el.tag === "button" || el.tag === "a" || el.role === "button" || el.role === "link") &&
        !el.accessibleName.trim() &&
        !el.textContent?.trim()
      ) {
        findings.push({
          findingId: createId(),
          criterion: "accessible_naming",
          category: "deterministic",
          severity: "blocker",
          observedEvidence: `Interactive element <${el.tag}> (refId: ${el.refId}) has neither visible text nor aria-label.`,
          expectedBehavior: "All interactive controls must have accessible names for screen readers and keyboard users.",
          location: { refId: el.refId, selector: el.tag },
          suggestedCorrection: `Add visible text or \`aria-label="..."\` to the <${el.tag}> element.`,
          confidence: 1.0,
        });
      }

      // 3b. Missing Alt on Images
      if (el.tag === "img" && !el.accessibleName.trim()) {
        findings.push({
          findingId: createId(),
          criterion: "image_alternative_text",
          category: "deterministic",
          severity: "critical",
          observedEvidence: `Image element (refId: ${el.refId}) lacks an \`alt\` text attribute.`,
          expectedBehavior: "All <img> elements must provide descriptive `alt` text or `alt=\"\"` for decorative images.",
          location: { refId: el.refId, selector: "img" },
          suggestedCorrection: "Add an `alt` attribute describing the image content or set `alt=\"\"` if decorative.",
          confidence: 1.0,
        });
      }

      // 3c. Focus Visibility on Interactive Controls
      if (el.isInteractive && el.hasFocusVisibleStyle === false && el.computedStyle?.outlineStyle === "none") {
        findings.push({
          findingId: createId(),
          criterion: "focus_visibility",
          category: "deterministic",
          severity: "critical",
          observedEvidence: `Interactive element <${el.tag}> has \`outline: none\` with no focus-visible replacement.`,
          expectedBehavior: "Keyboard focus indicators must be clearly visible with at least 2px high-contrast outline.",
          location: { refId: el.refId, selector: el.tag },
          suggestedCorrection: "Provide a visible `:focus-visible` ring (e.g. `outline: 2px solid var(--color-primary)`).",
          confidence: 1.0,
        });
      }

      // 3d. Color Contrast Ratio
      if (el.computedStyle?.color && el.computedStyle?.backgroundColor && el.textContent?.trim()) {
        const ratio = calculateContrastRatio(el.computedStyle.color, el.computedStyle.backgroundColor);
        const fontSizePx = parseFloat(el.computedStyle.fontSize || "16");
        const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.5 && el.computedStyle.fontWeight === "700");
        const minRatio = isLargeText ? 3.0 : 4.5;

        if (ratio < minRatio && ratio > 1.05) { // ratio ~ 1.0 indicates transparent/identical background check
          findings.push({
            findingId: createId(),
            criterion: "color_contrast_wcag_aa",
            category: "deterministic",
            severity: "critical",
            observedEvidence: `Text contrast ratio of ${ratio.toFixed(2)}:1 falls below the required ${minRatio}:1 threshold (fg: ${el.computedStyle.color}, bg: ${el.computedStyle.backgroundColor}).`,
            expectedBehavior: `Text must achieve minimum ${minRatio}:1 contrast ratio against its surface background.`,
            location: { refId: el.refId, selector: el.tag },
            suggestedCorrection: "Darken foreground text or lighten the background surface to achieve >= 4.5:1 contrast.",
            confidence: 1.0,
          });
        }
      }
    }

    // 4. Visual Baseline Regression Differences
    if (context.differenceRegions && context.differenceRegions.length > 0) {
      for (const reg of context.differenceRegions) {
        if (reg.category !== "expected_dynamic_content") {
          const sev: VisualQASeverity =
            reg.category === "layout_regression" || reg.category === "missing_or_displaced_components"
              ? "critical"
              : "warning";
          findings.push({
            findingId: createId(),
            criterion: "visual_regression_fidelity",
            category: "deterministic",
            severity: sev,
            observedEvidence: `Visual difference region (${reg.category}) detected at x:${reg.bounds.x}, y:${reg.bounds.y} (${reg.pixelCount} mismatched pixels, ${reg.mismatchPercent}% of viewport).`,
            expectedBehavior: "Rendered page must match approved visual baseline without unexpected shifts.",
            location: { bounds: reg.bounds },
            suggestedCorrection: reg.description,
            confidence: 1.0,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // Judgment-Based Checks
    // -------------------------------------------------------------------------

    // 5. Visual Hierarchy & Call-to-Action Balance
    const primaryCtas = context.elements.filter(
      (e) => (e.tag === "button" || e.role === "button") && e.computedStyle?.backgroundColor?.includes("rgb")
    );
    if (context.elements.length > 10 && primaryCtas.length === 0) {
      findings.push({
        findingId: createId(),
        criterion: "visual_hierarchy_cta",
        category: "judgment_based",
        severity: "warning",
        observedEvidence: "No prominent primary action button detected in the main viewport layout.",
        expectedBehavior: "Interfaces should provide a distinct primary call-to-action guiding user next steps.",
        location: {},
        suggestedCorrection: "Style the primary action with dominant brand color and high-contrast text.",
        confidence: 0.85,
      });
    }

    // 6. Typographic Measure (Line Length)
    for (const el of context.elements) {
      if ((el.tag === "p" || el.tag === "article") && el.bounds && el.textContent) {
        const charCount = el.textContent.length;
        if (charCount > 120 && el.bounds.width > 900) {
          findings.push({
            findingId: createId(),
            criterion: "typography_measure",
            category: "judgment_based",
            severity: "suggestion",
            observedEvidence: `Paragraph line width (${el.bounds.width}px for ${charCount} chars) exceeds the optimal 45-75 character reading measure.`,
            expectedBehavior: "Body paragraphs should maintain comfortable line lengths (max 65-75ch) for readability.",
            location: { refId: el.refId, selector: el.tag },
            suggestedCorrection: "Add `max-width: 65ch` or container constraints to prevent overly wide reading lines.",
            confidence: 0.8,
          });
          break; // Report at most once per page
        }
      }
    }

    // -------------------------------------------------------------------------
    // Score & Pass Calculation
    // -------------------------------------------------------------------------

    const blockerCount = findings.filter((f) => f.severity === "blocker").length;
    const criticalCount = findings.filter((f) => f.severity === "critical").length;
    const warningCount = findings.filter((f) => f.severity === "warning").length;
    const suggestionCount = findings.filter((f) => f.severity === "suggestion").length;

    const deterministicPass = blockerCount === 0 && criticalCount === 0;
    const judgmentPass = blockerCount === 0 && warningCount <= 1;
    const overallPass = deterministicPass && judgmentPass;

    let score = 100 - blockerCount * 35 - criticalCount * 20 - warningCount * 5 - suggestionCount * 2;
    score = Math.max(0, Math.min(100, score));

    const summary = overallPass
      ? `Visual QA passed (Score: ${score}/100): 0 blockers, 0 critical issues across ${context.elements.length} inspected elements.`
      : `Visual QA identified ${findings.length} issue(s) (Score: ${score}/100): ${blockerCount} blocker(s), ${criticalCount} critical, ${warningCount} warning(s).`;

    return {
      reportId: `vqa-${Date.now()}`,
      targetUrl: context.targetUrl,
      viewport: context.viewport,
      presetId: context.presetId,
      evaluatedAt: Date.now(),
      overallPass,
      deterministicPass,
      judgmentPass,
      score,
      findings,
      summary,
    };
  }
}
