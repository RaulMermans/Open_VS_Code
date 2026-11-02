/**
 * Sprint 9D — Reverse Engineering Anything (REA) Contracts.
 *
 * Epistemic foundations, evidence structures, reconstruction obligations,
 * target categories, and provider diagnostics conformant with REA 6.8.0.
 */

export const REA_PINNED_VERSION = "6.8.0" as const;
export const REA_PINNED_COMMIT = "f95bdbce76fa538d9383a36c7dde0468078b42f4" as const;

// ---------------------------------------------------------------------------
// 1. Target Classification & Investigation Categories
// ---------------------------------------------------------------------------

export type InvestigationTargetCategory =
  | "running_web_app"
  | "javascript_electron_app"
  | "native_packaged_app"
  | "source_repository";

export interface InvestigationTarget {
  readonly targetId: string;
  readonly category: InvestigationTargetCategory;
  readonly rawInput: string;
  readonly normalizedLocation: string;
  readonly format?: string;
  readonly authorized: boolean;
  readonly authorizationProof?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 2. Epistemic Separation
// ---------------------------------------------------------------------------

export type EpistemicStatus = "OBSERVED" | "INFERRED" | "UNKNOWN";

export type EvidenceAuthority =
  | "shipped-artifact"
  | "controlled-replay"
  | "browser-observation"
  | "historical-reference"
  | "external-service"
  | "analyst-inference";

export interface ReaEvidenceRecord {
  readonly evidenceId: string;
  readonly targetId: string;
  readonly targetCategory: InvestigationTargetCategory;
  readonly sourceUri: string;
  readonly timestamp: number;
  readonly provider: {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
  };
  readonly operation: string;
  readonly predicateType: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly observation: unknown;
  readonly epistemicStatus: EpistemicStatus;
  readonly authority: EvidenceAuthority;
  readonly confidence: "observed" | "inferred" | "unknown";
  readonly limitations: readonly string[];
  readonly relatedFeatureId?: string;
  readonly contentDigest: string;
}

// ---------------------------------------------------------------------------
// 3. Web & Runtime Behavioral Transitions
// ---------------------------------------------------------------------------

export interface ObservableStateTransition {
  readonly transitionId: string;
  readonly initialState: {
    readonly route: string;
    readonly title?: string;
    readonly domSnapshotRef?: string;
  };
  readonly userAction: {
    readonly type: "click" | "fill" | "navigate" | "keypress" | "hover";
    readonly targetRef?: string;
    readonly targetSelector?: string;
    readonly value?: string;
  };
  readonly resultingState: {
    readonly route: string;
    readonly title?: string;
    readonly domSnapshotRef?: string;
  };
  readonly visibleChange: string;
  readonly networkObservation?: {
    readonly method: string;
    readonly url: string;
    readonly status?: number;
  };
  readonly evidenceId: string;
  readonly confidence: "observed" | "inferred";
}

// ---------------------------------------------------------------------------
// 4. Feature & Architecture Specification
// ---------------------------------------------------------------------------

export interface FeatureSpecItem {
  readonly featureId: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly supportingEvidenceIds: readonly string[];
  readonly epistemicStatus: EpistemicStatus;
}

export interface RouteSpecItem {
  readonly route: string;
  readonly title?: string;
  readonly observedLandmarks: readonly string[];
  readonly interactiveElements: readonly string[];
  readonly accessibleRoles: readonly string[];
  readonly supportingEvidenceIds: readonly string[];
}

export interface BusinessRuleSpecItem {
  readonly ruleId: string;
  readonly statement: string;
  readonly trigger: string;
  readonly outcome: string;
  readonly supportingEvidenceIds: readonly string[];
  readonly isHypothesis: boolean;
}

export interface FormValidationSpecItem {
  readonly formId: string;
  readonly fields: readonly {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly validationPattern?: string;
    readonly observableErrors: readonly string[];
  }[];
  readonly submissionAction: string;
  readonly supportingEvidenceIds: readonly string[];
}

export interface ComponentSpecItem {
  readonly componentName: string;
  readonly role: string;
  readonly visualCharacteristics: string;
  readonly states: readonly string[];
  readonly supportingEvidenceIds: readonly string[];
}

export interface DataContractSpecItem {
  readonly endpointOrPattern: string;
  readonly method?: string;
  readonly observablePayloadFields: readonly string[];
  readonly observableResponseFields: readonly string[];
  readonly notes: string;
  readonly supportingEvidenceIds: readonly string[];
}

export interface ResponsiveRequirementItem {
  readonly viewportName: string;
  readonly minWidth: number;
  readonly observedLayoutBehavior: string;
  readonly supportingEvidenceIds: readonly string[];
}

export interface ErrorHandlingSpecItem {
  readonly scenario: string;
  readonly triggerAction: string;
  readonly observableUiResponse: string;
  readonly recoveryPath: string;
  readonly supportingEvidenceIds: readonly string[];
}

export interface UnknownDetailItem {
  readonly unknownId: string;
  readonly area: "backend_algorithm" | "database_schema" | "server_validation" | "auth_crypto" | "external_integration" | "other";
  readonly description: string;
  readonly whyUnobservable: string;
  readonly riskLevel: "low" | "medium" | "high";
}

export interface InferredArchitectureItem {
  readonly summary: string;
  readonly suspectedTechStack: readonly string[];
  readonly stateManagementModel: string;
  readonly dataPersistenceModel: string;
  readonly explicitlyInferred: true;
  readonly supportingEvidenceIds: readonly string[];
}

export interface ReconstructionSpecification {
  readonly specificationId: string;
  readonly target: InvestigationTarget;
  readonly createdAt: number;
  readonly featureInventory: readonly FeatureSpecItem[];
  readonly pageAndRouteMap: readonly RouteSpecItem[];
  readonly interactionStateGraph: readonly ObservableStateTransition[];
  readonly visibleBusinessRules: readonly BusinessRuleSpecItem[];
  readonly formAndValidationBehavior: readonly FormValidationSpecItem[];
  readonly componentInventory: readonly ComponentSpecItem[];
  readonly observableDataContracts: readonly DataContractSpecItem[];
  readonly responsiveUiRequirements: readonly ResponsiveRequirementItem[];
  readonly errorHandling: readonly ErrorHandlingSpecItem[];
  readonly knownConstraints: readonly string[];
  readonly evidenceLinks: readonly string[];
  readonly unknowns: readonly UnknownDetailItem[];
  readonly inferredArchitecture: InferredArchitectureItem;
}

// ---------------------------------------------------------------------------
// 5. Reconstruction Obligations & Ledger
// ---------------------------------------------------------------------------

export type ObligationApplicationLayer =
  | "cli"
  | "protocol"
  | "electron"
  | "persistence"
  | "process"
  | "runtime"
  | "packaging"
  | "native-abi"
  | "application"
  | "other";

export type ObligationStatus =
  | "unowned"
  | "characterized"
  | "implemented"
  | "verified"
  | "contradicted"
  | "blocked"
  | "out-of-scope"
  | "unknown";

export interface ObligationVerificationRecord {
  readonly obligationId: string;
  readonly obligationVersion: number;
  readonly artifactDigest: string;
  readonly testIdentity: string;
  readonly inputFixture: string;
  readonly expectedBehavior: string;
  readonly observedResult: string;
  readonly result: "PASS" | "FAIL";
  readonly verifier: string;
  readonly timestamp: number;
  readonly digest: string;
  readonly testOutputSnippet?: string;
  readonly supportingEvidence?: readonly string[];
  readonly limitations?: readonly string[];
}

export interface ReconstructionObligation {
  readonly obligationId: string;
  readonly obligationVersion: number;
  readonly title: string;
  readonly applicationLayer: ObligationApplicationLayer;
  readonly family: string;
  readonly target: {
    readonly artifactSha256: string | null;
    readonly applicationNodeId: string | null;
    readonly semanticNodeId: string | null;
    readonly location: string | null;
  };
  readonly positiveCases: readonly string[];
  readonly negativeCases: readonly string[];
  readonly edgeCases: readonly string[];
  readonly failureCases: readonly string[];
  readonly evidenceLinks: readonly string[];
  readonly owner: string | null;
  readonly status: ObligationStatus;
  readonly testEvidence?: ObligationVerificationRecord;
}

export interface ReconstructionObligationLedgerSummary {
  readonly total: number;
  readonly required: number;
  readonly verified: number;
  readonly requiredOpen: number;
  readonly byStatus: readonly { readonly key: ObligationStatus; readonly count: number }[];
  readonly byApplicationLayer: readonly { readonly key: ObligationApplicationLayer; readonly count: number }[];
}

export interface ReconstructionObligationLedger {
  readonly schema: "ReconstructionObligationLedger";
  readonly ledgerId: string;
  readonly closureDigest: string;
  readonly status: "unknown" | "partial" | "verified" | "contradicted";
  readonly coverage: {
    readonly status: "complete" | "partial" | "unknown";
  };
  readonly summary: ReconstructionObligationLedgerSummary;
  readonly reports: {
    readonly missingOwnerObligationIds: readonly string[];
    readonly missingVerifierObligationIds: readonly string[];
    readonly contradictedObligationIds: readonly string[];
    readonly residualUnknownIds: readonly string[];
  };
  readonly obligations: readonly ReconstructionObligation[];
  readonly evidenceLinks: readonly string[];
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// 6. Provider Diagnostics & Server Identity
// ---------------------------------------------------------------------------

export type KnownReaProviderId =
  | "native-macos"
  | "rea-artifact-graph"
  | "rea-dotnet-static"
  | "sqlite"
  | "ghidra"
  | "hopper"
  | "ida"
  | "kuna"
  | "jeb"
  | "sigrok"
  | "tshark"
  | "wabt";

export type ReaProviderStatus = "installed" | "connected" | "ready" | "not_configured" | "unsupported" | "unknown";

export interface ReaProviderReport {
  readonly id: KnownReaProviderId | string;
  readonly name: string;
  readonly available: boolean;
  readonly status?: ReaProviderStatus;
  readonly reason?: string | null;
  readonly availabilityCode?: string | null;
  readonly remediation?: string | null;
}

export interface ReaServerIdentity {
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly rootPath?: string;
  };
  readonly server: {
    readonly name: string;
    readonly version: string;
  };
  readonly catalogCounts: {
    readonly cliCommands: number;
    readonly mcpTools: number;
    readonly mcpPrompts: number;
  };
  readonly providers: readonly ReaProviderReport[];
}

// ---------------------------------------------------------------------------
// 7. Workflow Stages
// ---------------------------------------------------------------------------

export type InvestigationStageId =
  | "target_intake"
  | "provider_discovery"
  | "routing"
  | "exploration"
  | "evidence_collection"
  | "specification"
  | "ledger_generation";

export type ReconstructionStageId =
  | "spec_review"
  | "planning"
  | "implementation"
  | "local_execution"
  | "comparative_verification"
  | "closure_reporting";
