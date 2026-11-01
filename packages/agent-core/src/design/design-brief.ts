/**
 * Sprint 9C — Design Brief Validation, Token Extraction & Direction Generator.
 * Grounded in Impeccable shape-before-build and UI UX Pro Max token strategies.
 */

import { BROWSER_VIEWPORT_PRESETS } from "../browser/browser-observation-contracts.ts";
import type {
  AestheticDirection,
  AestheticStyle,
  BrandPositioning,
  ColorTokenValue,
  DesignBrief,
  DesignTokenSet,
  ProductArchetype,
  SemanticColorTokens,
  TypographyTokens,
  MotionTokens,
} from "./contracts.ts";

export class DesignBriefValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignBriefValidationError";
  }
}

export function validateDesignBrief(raw: unknown): DesignBrief {
  if (!raw || typeof raw !== "object") {
    throw new DesignBriefValidationError("DesignBrief must be a non-null object.");
  }
  const obj = raw as Record<string, any>;

  if (typeof obj.briefId !== "string" || !obj.briefId.trim()) {
    throw new DesignBriefValidationError("briefId is required and must be a non-empty string.");
  }

  const validArchetypes: ProductArchetype[] = [
    "developer_tool",
    "saas_dashboard",
    "landing_page",
    "e_commerce",
    "content_platform",
    "mobile_web",
    "utility",
  ];
  if (!validArchetypes.includes(obj.productType)) {
    throw new DesignBriefValidationError(
      `Invalid productType '${obj.productType}'. Allowed: ${validArchetypes.join(", ")}`
    );
  }

  if (typeof obj.intendedAudience !== "string" || !obj.intendedAudience.trim()) {
    throw new DesignBriefValidationError("intendedAudience is required.");
  }

  if (!Array.isArray(obj.userGoals) || obj.userGoals.length === 0) {
    throw new DesignBriefValidationError("userGoals must be a non-empty array of strings.");
  }

  const brand = obj.brandPositioning;
  if (!brand || typeof brand !== "object") {
    throw new DesignBriefValidationError("brandPositioning must be an object.");
  }
  const brandPositioning: BrandPositioning = {
    voice: String(brand.voice || "clear"),
    tone: String(brand.tone || "confident"),
    personality: Array.isArray(brand.personality) ? brand.personality.map(String) : ["focused", "reliable"],
  };

  const validStyles: AestheticStyle[] = [
    "minimal_editorial",
    "modern_technical",
    "high_contrast_utilitarian",
    "subtle_luxury",
    "playful_expressive",
    "custom",
  ];
  const aesthetic = obj.desiredAestheticDirection;
  if (!aesthetic || typeof aesthetic !== "object") {
    throw new DesignBriefValidationError("desiredAestheticDirection must be an object.");
  }
  if (!validStyles.includes(aesthetic.style)) {
    throw new DesignBriefValidationError(
      `Invalid aesthetic style '${aesthetic.style}'. Allowed: ${validStyles.join(", ")}`
    );
  }

  const desiredAestheticDirection: AestheticDirection = {
    style: aesthetic.style,
    visualMetaphor: aesthetic.visualMetaphor ? String(aesthetic.visualMetaphor) : undefined,
    primaryColorIntent: aesthetic.primaryColorIntent ? String(aesthetic.primaryColorIntent) : undefined,
    darkModeRequired: Boolean(aesthetic.darkModeRequired ?? true),
    references: Array.isArray(aesthetic.references) ? aesthetic.references.map(String) : [],
  };

  const accessibility = obj.accessibilityRequirements || {};
  const accessibilityRequirements = {
    standard: accessibility.standard === "WCAG_AAA" ? ("WCAG_AAA" as const) : ("WCAG_AA" as const),
    contrastCheck: Boolean(accessibility.contrastCheck ?? true),
    keyboardNav: Boolean(accessibility.keyboardNav ?? true),
    screenReader: Boolean(accessibility.screenReader ?? true),
    motionPreference: "respect_reduced_motion" as const,
  };

  const responsive = obj.responsiveRequirements || {};
  const responsiveRequirements = {
    viewports: Array.isArray(responsive.viewports) && responsive.viewports.length > 0
      ? responsive.viewports
      : [BROWSER_VIEWPORT_PRESETS.desktop, BROWSER_VIEWPORT_PRESETS.tablet, BROWSER_VIEWPORT_PRESETS.mobile],
    mobileFirst: Boolean(responsive.mobileFirst ?? true),
    breakpoints: responsive.breakpoints || { sm: 640, md: 768, lg: 1024, xl: 1280 },
  };

  const motion = obj.motionPreferences || {};
  const motionPreferences = {
    intensity: ["none", "subtle", "moderate", "expressive"].includes(motion.intensity)
      ? motion.intensity
      : ("subtle" as const),
    preferredEngine: motion.preferredEngine || ("css" as const),
    reduceMotionFallback: Boolean(motion.reduceMotionFallback ?? true),
    layoutAnimations: Boolean(motion.layoutAnimations ?? false),
  };

  const perf = obj.performanceConstraints || {};
  const performanceConstraints = {
    maxBundleKb: typeof perf.maxBundleKb === "number" ? perf.maxBundleKb : 500,
    targetFps: typeof perf.targetFps === "number" ? perf.targetFps : 60,
    avoidHeavyTransitions: Boolean(perf.avoidHeavyTransitions ?? true),
  };

  return {
    briefId: obj.briefId.trim(),
    productType: obj.productType,
    intendedAudience: obj.intendedAudience.trim(),
    userGoals: obj.userGoals.map(String),
    brandPositioning,
    existingDesignSystem: obj.existingDesignSystem,
    desiredAestheticDirection,
    targetFrameworks: Array.isArray(obj.targetFrameworks) ? obj.targetFrameworks.map(String) : ["html5", "css3"],
    technicalConstraints: Array.isArray(obj.technicalConstraints) ? obj.technicalConstraints.map(String) : [],
    accessibilityRequirements,
    responsiveRequirements,
    motionPreferences,
    performanceConstraints,
    deliverables: Array.isArray(obj.deliverables) ? obj.deliverables.map(String) : ["component", "styles"],
    confirmedRequirements: Array.isArray(obj.confirmedRequirements) ? obj.confirmedRequirements.map(String) : [],
    inferredPreferences: Array.isArray(obj.inferredPreferences) ? obj.inferredPreferences.map(String) : [],
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Date.now(),
  };
}

export function createDefaultDesignBrief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  const base: DesignBrief = {
    briefId: `brief-${Date.now()}`,
    productType: "developer_tool",
    intendedAudience: "Software engineers and product designers",
    userGoals: ["Inspect application state", "Verify interface quality", "Make fast, reliable decisions"],
    brandPositioning: {
      voice: "precise, technical, unpretentious",
      tone: "focused and helpful",
      personality: ["reliable", "craft-oriented", "responsive"],
    },
    desiredAestheticDirection: {
      style: "modern_technical",
      visualMetaphor: "instrumentation panel",
      primaryColorIntent: "#2563eb",
      darkModeRequired: true,
      references: [],
    },
    targetFrameworks: ["html5", "css3"],
    technicalConstraints: ["zero external runtime dependencies", "local-first"],
    accessibilityRequirements: {
      standard: "WCAG_AA",
      contrastCheck: true,
      keyboardNav: true,
      screenReader: true,
      motionPreference: "respect_reduced_motion",
    },
    responsiveRequirements: {
      viewports: [BROWSER_VIEWPORT_PRESETS.desktop, BROWSER_VIEWPORT_PRESETS.tablet, BROWSER_VIEWPORT_PRESETS.mobile],
      mobileFirst: true,
      breakpoints: { sm: 640, md: 768, lg: 1024, xl: 1280 },
    },
    motionPreferences: {
      intensity: "subtle",
      preferredEngine: "css",
      reduceMotionFallback: true,
      layoutAnimations: false,
    },
    performanceConstraints: {
      maxBundleKb: 250,
      targetFps: 60,
      avoidHeavyTransitions: true,
    },
    deliverables: ["html_screen", "css_tokens", "motion_specs"],
    confirmedRequirements: ["WCAG_AA compliance", "prefers-reduced-motion support", "responsive down to 390px"],
    inferredPreferences: ["Dark mode primary", "Subtle border styling over heavy drop-shadows"],
    createdAt: Date.now(),
  };

  return { ...base, ...overrides };
}

function color(hex: string, varName: string, desc?: string): ColorTokenValue {
  return { hex, variableName: varName, description: desc };
}

export function deriveDesignTokensFromBrief(brief: DesignBrief): DesignTokenSet {
  const isDark = brief.desiredAestheticDirection.darkModeRequired;
  const primaryHex = brief.desiredAestheticDirection.primaryColorIntent || "#2563eb";

  const colors: SemanticColorTokens = isDark
    ? {
        background: color("#090d16", "--color-bg", "Main application background"),
        backgroundSubtle: color("#0f172a", "--color-bg-subtle", "Secondary background surface"),
        surface: color("#1e293b", "--color-surface", "Standard card and container surface"),
        surfaceRaised: color("#334155", "--color-surface-raised", "Elevated modal/dropdown surface"),
        surfaceBorder: color("rgba(255, 255, 255, 0.1)", "--color-border", "Subtle structural border"),
        textPrimary: color("#f8fafc", "--color-text-primary", "High contrast primary text"),
        textSecondary: color("#cbd5e1", "--color-text-secondary", "Supporting secondary text"),
        textMuted: color("#94a3b8", "--color-text-muted", "Muted metadata labels"),
        primary: color(primaryHex, "--color-primary", "Primary brand and action color"),
        primaryHover: color("#1d4ed8", "--color-primary-hover", "Primary action hover state"),
        primaryText: color("#ffffff", "--color-primary-text", "Text on primary action"),
        success: color("#10b981", "--color-success", "Success confirmation indicator"),
        warning: color("#f59e0b", "--color-warning", "Warning indicator"),
        danger: color("#ef4444", "--color-danger", "Error and destructive indicator"),
        info: color("#06b6d4", "--color-info", "Informational callout"),
      }
    : {
        background: color("#ffffff", "--color-bg", "Main application background"),
        backgroundSubtle: color("#f8fafc", "--color-bg-subtle", "Secondary background surface"),
        surface: color("#ffffff", "--color-surface", "Standard card surface"),
        surfaceRaised: color("#ffffff", "--color-surface-raised", "Elevated modal surface"),
        surfaceBorder: color("#e2e8f0", "--color-border", "Subtle structural border"),
        textPrimary: color("#0f172a", "--color-text-primary", "High contrast primary text"),
        textSecondary: color("#334155", "--color-text-secondary", "Supporting secondary text"),
        textMuted: color("#64748b", "--color-text-muted", "Muted metadata labels"),
        primary: color(primaryHex, "--color-primary", "Primary brand and action color"),
        primaryHover: color("#1d4ed8", "--color-primary-hover", "Primary action hover state"),
        primaryText: color("#ffffff", "--color-primary-text", "Text on primary action"),
        success: color("#059669", "--color-success", "Success confirmation indicator"),
        warning: color("#d97706", "--color-warning", "Warning indicator"),
        danger: color("#dc2626", "--color-danger", "Error and destructive indicator"),
        info: color("#0891b2", "--color-info", "Informational callout"),
      };

  const typography: TypographyTokens = {
    fontDisplay: brief.desiredAestheticDirection.style === "minimal_editorial"
      ? "Georgia, 'Times New Roman', serif"
      : "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontMono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    scale: {
      xs: { fontSize: "12px", lineHeight: "16px", fontWeight: "400" },
      sm: { fontSize: "14px", lineHeight: "20px", fontWeight: "400" },
      base: { fontSize: "16px", lineHeight: "24px", fontWeight: "400" },
      md: { fontSize: "18px", lineHeight: "28px", fontWeight: "500" },
      lg: { fontSize: "20px", lineHeight: "28px", fontWeight: "600" },
      xl: { fontSize: "24px", lineHeight: "32px", fontWeight: "600" },
      "2xl": { fontSize: "30px", lineHeight: "36px", fontWeight: "700" },
      "3xl": { fontSize: "36px", lineHeight: "40px", fontWeight: "700" },
    },
  };

  const motion: MotionTokens = {
    durationInstant: "50ms",
    durationFast: "150ms",
    durationNormal: "250ms",
    durationSlow: "400ms",
    easeStandard: "cubic-bezier(0.2, 0.0, 0, 1.0)",
    easeEnter: "cubic-bezier(0.0, 0.0, 0.2, 1.0)",
    easeExit: "cubic-bezier(0.4, 0.0, 1.0, 1.0)",
    springStiffness: 240,
    springDamping: 24,
  };

  return {
    setId: `tokens-${brief.briefId}`,
    themeName: `${brief.productType}-${brief.desiredAestheticDirection.style}`,
    isDark,
    colors,
    typography,
    spacing: {
      "0": "0px",
      "1": "4px",
      "2": "8px",
      "3": "12px",
      "4": "16px",
      "6": "24px",
      "8": "32px",
      "12": "48px",
      "16": "64px",
    },
    radii: {
      none: "0px",
      sm: "4px",
      md: "8px",
      lg: "12px",
      full: "9999px",
    },
    shadows: isDark
      ? {
          none: "none",
          sm: "0 1px 2px 0 rgba(0, 0, 0, 0.4)",
          md: "0 4px 6px -1px rgba(0, 0, 0, 0.5), 0 2px 4px -2px rgba(0, 0, 0, 0.5)",
          lg: "0 10px 15px -3px rgba(0, 0, 0, 0.6), 0 4px 6px -4px rgba(0, 0, 0, 0.6)",
        }
      : {
          none: "none",
          sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
          md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
          lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
        },
    breakpoints: brief.responsiveRequirements.breakpoints,
    motion,
  };
}

export function formatDesignTokensAsCss(tokens: DesignTokenSet): string {
  const lines: string[] = [":root {"];

  // Colors
  for (const [key, token] of Object.entries(tokens.colors)) {
    lines.push(`  ${token.variableName}: ${token.hex}; /* ${key}: ${token.description || ""} */`);
  }

  // Typography
  lines.push(`  --font-display: ${tokens.typography.fontDisplay};`);
  lines.push(`  --font-sans: ${tokens.typography.fontSans};`);
  lines.push(`  --font-mono: ${tokens.typography.fontMono};`);
  for (const [size, spec] of Object.entries(tokens.typography.scale)) {
    lines.push(`  --font-size-${size}: ${spec.fontSize};`);
    lines.push(`  --line-height-${size}: ${spec.lineHeight};`);
  }

  // Spacing
  for (const [key, val] of Object.entries(tokens.spacing)) {
    lines.push(`  --space-${key}: ${val};`);
  }

  // Radii
  for (const [key, val] of Object.entries(tokens.radii)) {
    lines.push(`  --radius-${key}: ${val};`);
  }

  // Shadows
  for (const [key, val] of Object.entries(tokens.shadows)) {
    lines.push(`  --shadow-${key}: ${val};`);
  }

  // Motion
  lines.push(`  --duration-instant: ${tokens.motion.durationInstant};`);
  lines.push(`  --duration-fast: ${tokens.motion.durationFast};`);
  lines.push(`  --duration-normal: ${tokens.motion.durationNormal};`);
  lines.push(`  --duration-slow: ${tokens.motion.durationSlow};`);
  lines.push(`  --ease-standard: ${tokens.motion.easeStandard};`);
  lines.push(`  --ease-enter: ${tokens.motion.easeEnter};`);
  lines.push(`  --ease-exit: ${tokens.motion.easeExit};`);

  lines.push("}");
  lines.push("");

  // Reduced motion media query
  lines.push("@media (prefers-reduced-motion: reduce) {");
  lines.push("  *, *::before, *::after {");
  lines.push("    animation-duration: 0.01ms !important;");
  lines.push("    animation-iteration-count: 1 !important;");
  lines.push("    transition-duration: 0.01ms !important;");
  lines.push("    scroll-behavior: auto !important;");
  lines.push("  }");
  lines.push("}");

  return lines.join("\n");
}

export function formatDesignDirectionDoc(brief: DesignBrief, tokens: DesignTokenSet): string {
  return `# Design Direction: ${brief.productType} (${brief.desiredAestheticDirection.style})

**Brief ID:** \`${brief.briefId}\`
**Audience:** ${brief.intendedAudience}
**Aesthetic Style:** \`${brief.desiredAestheticDirection.style}\`
**Primary Accent:** \`${brief.desiredAestheticDirection.primaryColorIntent || "#2563eb"}\`
**Theme Mode:** ${tokens.isDark ? "Dark First" : "Light First"}

---

## 1. User Goals & Hierarchy
${brief.userGoals.map((g, i) => `${i + 1}. **${g}**`).join("\n")}

## 2. Visual Strategy & Personality
- **Voice & Tone:** ${brief.brandPositioning?.voice || "clear"}; ${brief.brandPositioning?.tone || "direct"}
- **Personality Traits:** ${(brief.brandPositioning?.personality || ["focused", "reliable"]).join(", ")}
- **Visual Metaphor:** ${brief.desiredAestheticDirection.visualMetaphor || "Clean, uncluttered structural layout"}

## 3. Typography Strategy
- **Display / Headings:** \`${tokens.typography.fontDisplay}\`
- **Body & UI:** \`${tokens.typography.fontSans}\`
- **Code & Numeric Data:** \`${tokens.typography.fontMono}\`

## 4. Color & Surface Architecture
- Background: \`${tokens.colors.background.hex}\`
- Surface: \`${tokens.colors.surface.hex}\`
- Text Primary: \`${tokens.colors.textPrimary.hex}\` (High contrast >= 7:1)
- Accent / Primary CTA: \`${tokens.colors.primary.hex}\`
- Semantic Alerts: Success \`${tokens.colors.success.hex}\` | Danger \`${tokens.colors.danger.hex}\`

## 5. Motion Language
- Intensity: **${brief.motionPreferences.intensity}**
- Micro-interactions: **${tokens.motion.durationFast}** with ease-out
- Viewport / Modal Transitions: **${tokens.motion.durationNormal}** (${tokens.motion.easeStandard})
- Reduced-Motion Policy: **Instant cuts or subtle opacity fades; spatial movement disabled.**

## 6. Responsive Breakpoints
${Object.entries(tokens.breakpoints).map(([name, px]) => `- \`${name}\`: \`${px}px\``).join("\n")}
`;
}
