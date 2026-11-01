/**
 * Sprint 9B — Visual Browser Experience, Sprint 9C Design Observation Contracts,
 * and Sprint 9D Reverse Engineering Evidence Contracts.
 *
 * Architectural boundaries (ADR-039 & ADR-040):
 *   - Pure observation and metadata contracts only.
 *   - Element geometry (`ElementBoundingBox`) is strictly display/highlight metadata
 *     bound to exact `(sessionId, snapshotId, url, viewport)`. Coordinates are NEVER
 *     an execution path.
 *   - Sprint 9C animation probes forbid motion-quality claims from static screenshots
 *     or static CSS declarations (`motionQualityClaimAllowed: false`).
 *   - Sprint 9D evidence recording is opt-in, explicitly bounded, redacts sensitive text,
 *     never records network response bodies, credentials, cookies, or browser storage,
 *     and separates Observed Facts, Inferred Behavior, and Unknown Implementation Details.
 */

import { redactSensitiveText, sanitizeBrowserUrl } from "./browser-action-classifier.ts";

export type ViewportPresetId = "desktop" | "tablet" | "mobile" | "custom";

export interface BrowserViewportDimensions {
  readonly width: number;
  readonly height: number;
}

export interface BrowserViewportPreset extends BrowserViewportDimensions {
  readonly id: Exclude<ViewportPresetId, "custom">;
  readonly label: string;
}

export const BROWSER_VIEWPORT_PRESETS: Readonly<Record<Exclude<ViewportPresetId, "custom">, BrowserViewportPreset>> = {
  desktop: { id: "desktop", label: "Desktop (1280×800)", width: 1280, height: 800 },
  tablet: { id: "tablet", label: "Tablet (768×1024)", width: 768, height: 1024 },
  mobile: { id: "mobile", label: "Mobile (390×844)", width: 390, height: 844 },
};

export function resolveViewportPresetId(viewport: BrowserViewportDimensions): ViewportPresetId {
  for (const preset of Object.values(BROWSER_VIEWPORT_PRESETS)) {
    if (preset.width === viewport.width && preset.height === viewport.height) {
      return preset.id;
    }
  }
  return "custom";
}

/**
 * Bounded element geometry for screenshot overlay highlighting ONLY.
 * Tied to exact `sessionId`, `snapshotId`, `url`, and `viewport`.
 * Never accepted as tool execution coordinates.
 */
export interface ElementBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface ElementInteractiveState {
  readonly disabled: boolean;
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly readonly: boolean;
  readonly required: boolean;
  readonly focused: boolean;
  readonly editable: boolean;
}

export type BrowserActionOrigin = "agent" | "user" | "system";

export interface BrowserEventCorrelation {
  readonly origin: BrowserActionOrigin;
  readonly taskId?: string;
  readonly toolCallId?: string;
  readonly confirmationId?: string;
}

// ---------------------------------------------------------------------------
// Sprint 9C — Design & Motion Observation Contracts (Preparation Only)
// ---------------------------------------------------------------------------

export interface ElementTypographyMetadata {
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly color: string;
  readonly textAlign: string;
}

export interface ElementSpacingMetadata {
  readonly marginTop: string;
  readonly marginRight: string;
  readonly marginBottom: string;
  readonly marginLeft: string;
  readonly paddingTop: string;
  readonly paddingRight: string;
  readonly paddingBottom: string;
  readonly paddingLeft: string;
  readonly gap: string;
}

export interface ElementLayoutMetadata {
  readonly display: string;
  readonly position: string;
  readonly flexDirection?: string;
  readonly alignItems?: string;
  readonly justifyContent?: string;
  readonly gridTemplateColumns?: string;
  readonly backgroundColor: string;
  readonly borderRadius: string;
  readonly opacity: string;
  readonly overflow: string;
}

export interface ElementDesignMetadata {
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly refId: string;
  readonly url: string;
  readonly viewport: BrowserViewportDimensions;
  readonly presetId: ViewportPresetId;
  readonly capturedAt: number;
  readonly role: string;
  readonly tag: string;
  readonly accessibleName: string;
  readonly bounds?: ElementBoundingBox;
  readonly typography: ElementTypographyMetadata;
  readonly spacing: ElementSpacingMetadata;
  readonly layout: ElementLayoutMetadata;
}

export interface VisualBaselineArtifact {
  readonly baselineId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly pageTitle: string;
  readonly viewport: BrowserViewportDimensions;
  readonly presetId: ViewportPresetId;
  readonly artifactId: string;
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly capturedAt: number;
}

export interface BeforeAfterComparison {
  readonly comparisonId: string;
  readonly baseline: VisualBaselineArtifact;
  readonly candidate: VisualBaselineArtifact;
  readonly sameOrigin: boolean;
  readonly sameRoute: boolean;
  readonly viewportMatch: boolean;
  readonly dimensionsMatch: boolean;
  readonly byteDelta: number;
  readonly identicalHash: boolean;
  readonly comparedAt: number;
}

export interface AnimationDeclarationSample {
  readonly tag: string;
  readonly role: string;
  readonly accessibleName: string;
  readonly animationName: string;
  readonly animationDuration: string;
  readonly transitionProperty: string;
  readonly transitionDuration: string;
  readonly prefersReducedMotionActive: boolean;
}

export interface AnimationObservation {
  readonly sessionId: string;
  readonly url: string;
  readonly viewport: BrowserViewportDimensions;
  readonly capturedAt: number;
  readonly evidenceKind: "static_css_declaration_probe" | "multi_frame_sample";
  readonly prefersReducedMotion: boolean;
  readonly animatedElementCount: number;
  readonly samples: readonly AnimationDeclarationSample[];
  /**
   * Explicitly `false` when collected from a static screenshot or CSS declaration probe.
   * Prevents downstream packs from claiming smooth motion quality without temporal sampling.
   */
  readonly motionQualityClaimAllowed: boolean;
  readonly limitationNotice: string;
}

// ---------------------------------------------------------------------------
// Sprint 9D — Reverse Engineering Evidence Contracts (Preparation Only)
// ---------------------------------------------------------------------------

export type ObservedFactKind =
  | "route_visited"
  | "navigation_transition"
  | "user_or_agent_action"
  | "visible_state_snapshot"
  | "form_structure_observed"
  | "observable_error"
  | "screenshot_captured"
  | "network_diagnostic";

export interface ObservedBrowserFact {
  readonly factId: string;
  readonly evidenceClass: "observed_fact";
  readonly kind: ObservedFactKind;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly origin: BrowserActionOrigin;
  readonly sanitizedUrl?: string;
  readonly fromSanitizedUrl?: string;
  readonly pageTitle?: string;
  readonly summary: string;
  readonly snapshotId?: string;
  readonly screenshotArtifactId?: string;
  readonly formFieldCount?: number;
  readonly sensitiveFieldCount?: number;
  readonly errorCategory?: string;
  readonly networkPolicyOutcome?: "allowed" | "denied" | "failed";
  /** Hard invariants enforced by contract and constructor: */
  readonly responseBodyRecorded: false;
  readonly credentialsRecorded: false;
  readonly browserStorageRecorded: false;
}

export interface InferredBehaviorRecord {
  readonly inferenceId: string;
  readonly evidenceClass: "inferred_behavior";
  readonly timestamp: number;
  readonly hypothesis: string;
  readonly confidence: "low" | "medium" | "high";
  readonly supportingFactIds: readonly string[];
}

export interface UnknownImplementationDetail {
  readonly unknownId: string;
  readonly evidenceClass: "unknown_implementation_detail";
  readonly timestamp: number;
  readonly area: "backend_handler" | "database_schema" | "auth_mechanism" | "hidden_api_payload" | "server_side_validation" | "other";
  readonly description: string;
  readonly reasonUnobservable: string;
}

export interface ObservationRetentionPolicy {
  readonly recordingEnabled: boolean;
  readonly maxFacts: number;
  readonly maxInferences: number;
  readonly maxUnknowns: number;
  readonly retainedFacts: number;
  readonly droppedFacts: number;
  readonly retainedInferences: number;
  readonly retainedUnknowns: number;
}

export interface ObservationEvidenceSnapshot {
  readonly retention: ObservationRetentionPolicy;
  readonly observedFacts: readonly ObservedBrowserFact[];
  readonly inferredBehaviors: readonly InferredBehaviorRecord[];
  readonly unknownDetails: readonly UnknownImplementationDetail[];
}

export interface BoundedObservationJournalOptions {
  readonly maxFacts?: number;
  readonly maxInferences?: number;
  readonly maxUnknowns?: number;
}

const DEFAULT_MAX_FACTS = 80;
const DEFAULT_MAX_INFERENCES = 30;
const DEFAULT_MAX_UNKNOWNS = 30;
const MAX_SUMMARY_CHARS = 280;

function boundSafeText(text: string | undefined, maxChars = MAX_SUMMARY_CHARS): string {
  if (!text) return "";
  const redacted = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted;
}

/**
 * Bounded, opt-in evidence journal preparing Sprint 9D observation contracts.
 * Recording is OFF by default, enforces strict retention limits, redacts sensitive strings,
 * and structurally forbids storing response bodies, credentials, or browser storage.
 */
export class BoundedObservationJournal {
  #recordingEnabled = false;
  readonly #maxFacts: number;
  readonly #maxInferences: number;
  readonly #maxUnknowns: number;
  readonly #facts: ObservedBrowserFact[] = [];
  readonly #inferences: InferredBehaviorRecord[] = [];
  readonly #unknowns: UnknownImplementationDetail[] = [];
  #droppedFacts = 0;
  #seq = 0;

  constructor(options: BoundedObservationJournalOptions = {}) {
    this.#maxFacts = Math.max(5, Math.min(options.maxFacts ?? DEFAULT_MAX_FACTS, 250));
    this.#maxInferences = Math.max(5, Math.min(options.maxInferences ?? DEFAULT_MAX_INFERENCES, 100));
    this.#maxUnknowns = Math.max(5, Math.min(options.maxUnknowns ?? DEFAULT_MAX_UNKNOWNS, 100));
  }

  isRecordingEnabled(): boolean {
    return this.#recordingEnabled;
  }

  setRecordingEnabled(enabled: boolean): void {
    this.#recordingEnabled = Boolean(enabled);
  }

  recordFact(input: {
    readonly kind: ObservedFactKind;
    readonly sessionId: string;
    readonly origin?: BrowserActionOrigin;
    readonly timestamp?: number;
    readonly url?: string;
    readonly fromUrl?: string;
    readonly pageTitle?: string;
    readonly summary: string;
    readonly snapshotId?: string;
    readonly screenshotArtifactId?: string;
    readonly formFieldCount?: number;
    readonly sensitiveFieldCount?: number;
    readonly errorCategory?: string;
    readonly networkPolicyOutcome?: "allowed" | "denied" | "failed";
  }): ObservedBrowserFact | null {
    if (!this.#recordingEnabled) {
      return null;
    }
    const fact: ObservedBrowserFact = {
      factId: `fact-${++this.#seq}`,
      evidenceClass: "observed_fact",
      kind: input.kind,
      timestamp: input.timestamp ?? Date.now(),
      sessionId: input.sessionId,
      origin: input.origin ?? "system",
      ...(input.url ? { sanitizedUrl: sanitizeBrowserUrl(input.url) } : {}),
      ...(input.fromUrl ? { fromSanitizedUrl: sanitizeBrowserUrl(input.fromUrl) } : {}),
      ...(input.pageTitle ? { pageTitle: boundSafeText(input.pageTitle, 140) } : {}),
      summary: boundSafeText(input.summary),
      ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
      ...(input.screenshotArtifactId ? { screenshotArtifactId: input.screenshotArtifactId } : {}),
      ...(typeof input.formFieldCount === "number" ? { formFieldCount: input.formFieldCount } : {}),
      ...(typeof input.sensitiveFieldCount === "number" ? { sensitiveFieldCount: input.sensitiveFieldCount } : {}),
      ...(input.errorCategory ? { errorCategory: boundSafeText(input.errorCategory, 80) } : {}),
      ...(input.networkPolicyOutcome ? { networkPolicyOutcome: input.networkPolicyOutcome } : {}),
      responseBodyRecorded: false,
      credentialsRecorded: false,
      browserStorageRecorded: false,
    };
    this.#facts.push(fact);
    while (this.#facts.length > this.#maxFacts) {
      this.#facts.shift();
      this.#droppedFacts += 1;
    }
    return fact;
  }

  recordInference(input: {
    readonly hypothesis: string;
    readonly confidence: "low" | "medium" | "high";
    readonly supportingFactIds: readonly string[];
    readonly timestamp?: number;
  }): InferredBehaviorRecord | null {
    if (!this.#recordingEnabled) {
      return null;
    }
    const validFactIds = new Set(this.#facts.map((f) => f.factId));
    const supportingFactIds = input.supportingFactIds.filter((id) => validFactIds.has(id)).slice(0, 10);
    const record: InferredBehaviorRecord = {
      inferenceId: `inf-${++this.#seq}`,
      evidenceClass: "inferred_behavior",
      timestamp: input.timestamp ?? Date.now(),
      hypothesis: boundSafeText(input.hypothesis),
      confidence: input.confidence,
      supportingFactIds,
    };
    this.#inferences.push(record);
    while (this.#inferences.length > this.#maxInferences) {
      this.#inferences.shift();
    }
    return record;
  }

  recordUnknown(input: {
    readonly area: UnknownImplementationDetail["area"];
    readonly description: string;
    readonly reasonUnobservable: string;
    readonly timestamp?: number;
  }): UnknownImplementationDetail | null {
    if (!this.#recordingEnabled) {
      return null;
    }
    const detail: UnknownImplementationDetail = {
      unknownId: `unk-${++this.#seq}`,
      evidenceClass: "unknown_implementation_detail",
      timestamp: input.timestamp ?? Date.now(),
      area: input.area,
      description: boundSafeText(input.description),
      reasonUnobservable: boundSafeText(input.reasonUnobservable),
    };
    this.#unknowns.push(detail);
    while (this.#unknowns.length > this.#maxUnknowns) {
      this.#unknowns.shift();
    }
    return detail;
  }

  clear(): void {
    this.#facts.length = 0;
    this.#inferences.length = 0;
    this.#unknowns.length = 0;
    this.#droppedFacts = 0;
  }

  snapshot(): ObservationEvidenceSnapshot {
    return {
      retention: {
        recordingEnabled: this.#recordingEnabled,
        maxFacts: this.#maxFacts,
        maxInferences: this.#maxInferences,
        maxUnknowns: this.#maxUnknowns,
        retainedFacts: this.#facts.length,
        droppedFacts: this.#droppedFacts,
        retainedInferences: this.#inferences.length,
        retainedUnknowns: this.#unknowns.length,
      },
      observedFacts: [...this.#facts],
      inferredBehaviors: [...this.#inferences],
      unknownDetails: [...this.#unknowns],
    };
  }
}
