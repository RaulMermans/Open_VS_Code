/**
 * Sprint 9C — Advanced Design & Motion Architecture Contracts.
 *
 * Grounded in ADR-038 (Capability Packs), ADR-039 (Browser Runtime),
 * ADR-040 (Browser Observation UX), and ADR-041 (Advanced Design & Motion).
 *
 * Preserves the single authoritative AgentRuntime and PermissionGate invariants.
 * Does not create autonomous secondary agent loops.
 */

import type { BrowserViewportDimensions, ElementBoundingBox, ViewportPresetId } from "../browser/browser-observation-contracts.ts";

// ---------------------------------------------------------------------------
// 1. Design Brief & Durable Context Contracts
// ---------------------------------------------------------------------------

export type ProductArchetype =
  | "developer_tool"
  | "saas_dashboard"
  | "landing_page"
  | "e_commerce"
  | "content_platform"
  | "mobile_web"
  | "utility";

export type AestheticStyle =
  | "minimal_editorial"
  | "modern_technical"
  | "high_contrast_utilitarian"
  | "subtle_luxury"
  | "playful_expressive"
  | "custom";

export interface BrandPositioning {
  readonly voice: string;
  readonly tone: string;
  readonly personality: readonly string[];
}

export interface ExistingDesignSystemContext {
  readonly name?: string;
  readonly tokensPath?: string;
  readonly framework?: string;
  readonly components?: readonly string[];
}

export interface AestheticDirection {
  readonly style: AestheticStyle;
  readonly visualMetaphor?: string | undefined;
  readonly primaryColorIntent?: string | undefined;
  readonly darkModeRequired: boolean;
  readonly references?: readonly string[] | undefined;
}

export interface AccessibilityRequirements {
  readonly standard: "WCAG_AA" | "WCAG_AAA";
  readonly contrastCheck: boolean;
  readonly keyboardNav: boolean;
  readonly screenReader: boolean;
  readonly motionPreference: "respect_reduced_motion";
}

export interface ResponsiveRequirements {
  readonly viewports: readonly BrowserViewportDimensions[];
  readonly mobileFirst: boolean;
  readonly breakpoints: Readonly<Record<string, number>>;
}

export interface MotionPreferences {
  readonly intensity: "none" | "subtle" | "moderate" | "expressive";
  readonly preferredEngine?: "css" | "motion" | "vanilla";
  readonly reduceMotionFallback: boolean;
  readonly layoutAnimations: boolean;
}

export interface PerformanceConstraints {
  readonly maxBundleKb?: number;
  readonly targetFps: number;
  readonly avoidHeavyTransitions: boolean;
}

export interface DesignBrief {
  readonly briefId: string;
  readonly productType: ProductArchetype;
  readonly intendedAudience: string;
  readonly userGoals: readonly string[];
  readonly brandPositioning: BrandPositioning;
  readonly existingDesignSystem?: ExistingDesignSystemContext;
  readonly desiredAestheticDirection: AestheticDirection;
  readonly targetFrameworks: readonly string[];
  readonly technicalConstraints: readonly string[];
  readonly accessibilityRequirements: AccessibilityRequirements;
  readonly responsiveRequirements: ResponsiveRequirements;
  readonly motionPreferences: MotionPreferences;
  readonly performanceConstraints: PerformanceConstraints;
  readonly deliverables: readonly string[];
  readonly confirmedRequirements: readonly string[];
  readonly inferredPreferences: readonly string[];
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// 2. Design Tokens Contracts
// ---------------------------------------------------------------------------

export interface ColorTokenValue {
  readonly hex: string;
  readonly rgb?: string | undefined;
  readonly hsl?: string | undefined;
  readonly variableName: string;
  readonly description?: string | undefined;
}

export interface SemanticColorTokens {
  readonly background: ColorTokenValue;
  readonly backgroundSubtle: ColorTokenValue;
  readonly surface: ColorTokenValue;
  readonly surfaceRaised: ColorTokenValue;
  readonly surfaceBorder: ColorTokenValue;
  readonly textPrimary: ColorTokenValue;
  readonly textSecondary: ColorTokenValue;
  readonly textMuted: ColorTokenValue;
  readonly primary: ColorTokenValue;
  readonly primaryHover: ColorTokenValue;
  readonly primaryText: ColorTokenValue;
  readonly success: ColorTokenValue;
  readonly warning: ColorTokenValue;
  readonly danger: ColorTokenValue;
  readonly info: ColorTokenValue;
}

export interface TypographyTokens {
  readonly fontDisplay: string;
  readonly fontSans: string;
  readonly fontMono: string;
  readonly scale: Readonly<Record<string, { fontSize: string; lineHeight: string; fontWeight?: string }>>;
}

export interface MotionTokens {
  readonly durationInstant: string;
  readonly durationFast: string;
  readonly durationNormal: string;
  readonly durationSlow: string;
  readonly easeStandard: string;
  readonly easeEnter: string;
  readonly easeExit: string;
  readonly springStiffness: number;
  readonly springDamping: number;
}

export interface DesignTokenSet {
  readonly setId: string;
  readonly themeName: string;
  readonly isDark: boolean;
  readonly colors: SemanticColorTokens;
  readonly typography: TypographyTokens;
  readonly spacing: Readonly<Record<string, string>>;
  readonly radii: Readonly<Record<string, string>>;
  readonly shadows: Readonly<Record<string, string>>;
  readonly breakpoints: Readonly<Record<string, number>>;
  readonly motion: MotionTokens;
}

// ---------------------------------------------------------------------------
// 3. Visual Comparison & Difference Contracts
// ---------------------------------------------------------------------------

export type DifferenceCategory =
  | "exact_pixel_mismatch"
  | "expected_dynamic_content"
  | "layout_regression"
  | "typography_mismatch"
  | "spacing_mismatch"
  | "color_mismatch"
  | "missing_or_displaced_components";

export interface DifferenceRegion {
  readonly regionId: string;
  readonly bounds: ElementBoundingBox;
  readonly pixelCount: number;
  readonly mismatchPercent: number;
  readonly category: DifferenceCategory;
  readonly description: string;
}

export interface VisualComparisonOptions {
  readonly colorThreshold?: number | undefined; // 0.0 to 1.0 (default 0.08)
  readonly tolerancePercent?: number | undefined; // 0.0 to 100.0 (default 0.1)
  readonly ignoredRegions?: readonly ElementBoundingBox[] | undefined;
  readonly dynamicContentSelectors?: readonly string[] | undefined;
}

export interface VisualComparisonResult {
  readonly comparisonId: string;
  readonly baselineSha256: string;
  readonly candidateSha256: string;
  readonly identicalHash: boolean;
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly mismatchedPixels: number;
  readonly mismatchPercentage: number;
  readonly pass: boolean;
  readonly diffPngBuffer?: Buffer;
  readonly diffArtifactPath?: string;
  readonly regions: readonly DifferenceRegion[];
  readonly summary: string;
  readonly comparedAt: number;
}

// ---------------------------------------------------------------------------
// 4. Real Measured Motion Evaluation Contracts
// ---------------------------------------------------------------------------

export interface FrameTimingSample {
  readonly frameIndex: number;
  readonly timestampMs: number;
  readonly deltaMs: number;
}

export interface ActiveAnimationRecord {
  readonly elementTag: string;
  readonly elementRole: string;
  readonly accessibleName: string;
  readonly animationName: string;
  readonly propertyName: string;
  readonly durationMs: number;
  readonly easing: string;
  readonly isComposited: boolean;
  readonly causesLayoutShift: boolean;
}

export interface LayoutShiftRecord {
  readonly value: number;
  readonly timestampMs: number;
  readonly sources?: readonly string[];
}

export interface MotionInterruptionSample {
  readonly interruptedAtMs: number;
  readonly previousTarget: string;
  readonly newTarget: string;
  readonly smoothRetargeted: boolean;
  readonly snapDetected: boolean;
}

export type MotionEvaluationVerdict =
  | "measured_passing"
  | "measured_failing"
  | "no_animation_detected"
  | "unsupported_measurement"
  | "insufficient_evidence";

export interface MotionFailure {
  readonly failureCode:
    | "LAYOUT_THRASHING_PROPERTY"
    | "DURATION_TOO_LONG"
    | "DURATION_TOO_SHORT"
    | "MISSING_REDUCED_MOTION_ALTERNATIVE"
    | "FRAME_JANK_DETECTED"
    | "UNWANTED_LAYOUT_SHIFT"
    | "INTERRUPTION_SNAP"
    | "NO_ANIMATION_DETECTED"
    | "INSUFFICIENT_EVIDENCE"
    | "UNSUPPORTED_MEASUREMENT";
  readonly severity: "blocker" | "warning";
  readonly details: string;
  readonly affectedElement?: string;
}

export interface MotionQualityReport {
  readonly verdict: MotionEvaluationVerdict;
  readonly measuredFps: number;
  readonly minFps: number;
  readonly jankCount: number;
  readonly totalFrames: number;
  readonly animationCount: number;
  readonly layoutThrashingProperties: readonly string[];
  readonly reducedMotionCompliant: boolean;
  readonly reducedMotionTested: boolean;
  readonly totalLayoutShift: number;
  readonly motionQualityClaimAllowed: boolean;
  readonly failures: readonly MotionFailure[];
  readonly score: number; // 0 - 100
  readonly summary: string;
  readonly limitationNotice: string;
}

export interface MeasuredMotionObservation {
  readonly sessionId: string;
  readonly url: string;
  readonly viewport: BrowserViewportDimensions;
  readonly capturedAt: number;
  readonly evidenceKind: "multi_frame_sample";
  readonly prefersReducedMotion: boolean;
  readonly frameTimings: readonly FrameTimingSample[];
  readonly animations: readonly ActiveAnimationRecord[];
  readonly layoutShifts: readonly LayoutShiftRecord[];
  readonly report: MotionQualityReport;
}

// ---------------------------------------------------------------------------
// 5. Visual QA Evaluator Contracts
// ---------------------------------------------------------------------------

export type VisualQACategory = "deterministic" | "judgment_based";
export type VisualQASeverity = "blocker" | "critical" | "warning" | "suggestion";

export interface VisualQAFinding {
  readonly findingId: string;
  readonly criterion: string;
  readonly category: VisualQACategory;
  readonly severity: VisualQASeverity;
  readonly observedEvidence: string;
  readonly expectedBehavior: string;
  readonly location: {
    readonly refId?: string;
    readonly selector?: string;
    readonly componentName?: string;
    readonly bounds?: ElementBoundingBox;
  };
  readonly suggestedCorrection: string;
  readonly confidence: number; // 0.0 to 1.0 (strictly required for judgment_based)
  readonly repairStatus?: "unresolved" | "verified_repaired" | "degraded";
}

export interface VisualQAReport {
  readonly reportId: string;
  readonly targetUrl: string;
  readonly viewport: BrowserViewportDimensions;
  readonly presetId: ViewportPresetId;
  readonly evaluatedAt: number;
  readonly overallPass: boolean;
  readonly deterministicPass: boolean;
  readonly judgmentPass: boolean;
  readonly score: number; // 0 - 100
  readonly findings: readonly VisualQAFinding[];
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// 6. Design Workflow Contracts
// ---------------------------------------------------------------------------

export type DesignWorkflowStage =
  | "discover_and_shape"
  | "design_system"
  | "frontend_implementation"
  | "motion_engineering"
  | "visual_qa_refinement";

export interface DesignWorkflowConfig {
  readonly brief: DesignBrief;
  readonly maxImprovementIterations?: number | undefined; // default 3
  readonly autoApproveLowRiskEdits?: boolean | undefined;
  readonly targetUrl?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly mutationEngine?: any | undefined;
  readonly browserSessionManager?: any | undefined;
  readonly componentFilePath?: string | undefined;
  readonly motionFilePath?: string | undefined;
  readonly tokensFilePath?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface DesignWorkflowIteration {
  readonly iterationNumber: number;
  readonly stage: DesignWorkflowStage;
  readonly visualReport?: VisualQAReport;
  readonly motionReport?: MotionQualityReport;
  readonly comparisonResult?: VisualComparisonResult;
  readonly repairsAttempted: readonly string[];
  readonly timestamp: number;
}

export interface DesignWorkflowResult {
  readonly workflowId: string;
  readonly status: "completed" | "escalated_to_user" | "iteration_budget_exhausted" | "failed";
  readonly finalStage: DesignWorkflowStage;
  readonly tokens?: DesignTokenSet | undefined;
  readonly generatedArtifacts: readonly string[];
  readonly iterations: readonly DesignWorkflowIteration[];
  readonly verified: boolean;
  readonly unresolvedFindings: readonly VisualQAFinding[];
  readonly message: string;
}
