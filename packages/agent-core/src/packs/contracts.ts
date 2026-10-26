import type { CustomModeProfile, ResolvedExecutionProfile } from "../modes/contracts.ts";

export type PackInstallationScope = "builtin" | "workspace" | "account";

export type PackReadinessStatus =
  | "READY"
  | "INSTALLED_INACTIVE"
  | "MISSING_DEPENDENCIES"
  | "INCOMPATIBLE"
  | "BLOCKED_BY_POLICY"
  | "UNTRUSTED"
  | "INVALID";

export interface PackPublisher {
  readonly id: string;
  readonly name: string;
  readonly url?: string | undefined;
  readonly verified?: boolean | undefined;
}

export interface PackSourceRepository {
  readonly url: string;
  readonly commit?: string | undefined;
  readonly release?: string | undefined;
}

export interface PackMcpServerRequirement {
  readonly id: string;
  readonly name?: string | undefined;
  readonly transport?: "stdio" | "streamable_http" | "sse" | undefined;
}

export interface PackPreferredModel {
  readonly capabilities?: readonly string[] | undefined;
  readonly deploymentId?: string | undefined;
  readonly family?: string | undefined;
}

export interface PackWorkflowRequirements {
  readonly workflowPreference?: "direct" | "structured" | undefined;
  readonly requireCheckpoints?: boolean | undefined;
}

export interface PackEvaluationRequirement {
  readonly name: string;
  readonly type: "read_only" | "mutation_gate" | "permission_check" | "tool_call";
  readonly expectation: string;
}

export interface PackResourceConstraints {
  readonly maxMemoryMb?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
}

export interface PackDocumentation {
  readonly summary: string;
  readonly guidelines?: string | undefined;
  readonly readme?: string | undefined;
}

export interface PackIntegrityMetadata {
  readonly algorithm: "sha256";
  readonly digest: string;
}

export interface CapabilityPackManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly publisher: PackPublisher;
  readonly sourceRepository: PackSourceRepository;
  readonly license: string;
  readonly attribution?: string | undefined;
  readonly openVsCodeVersion: string;
  readonly customMode: CustomModeProfile;
  readonly requiredSkills: readonly string[];
  readonly optionalSkills: readonly string[];
  readonly requiredMcpServers: readonly PackMcpServerRequirement[];
  readonly optionalMcpServers: readonly PackMcpServerRequirement[];
  readonly preferredModel?: PackPreferredModel | undefined;
  readonly workflowRequirements?: PackWorkflowRequirements | undefined;
  readonly evaluationRequirements?: readonly PackEvaluationRequirement[] | undefined;
  readonly permissionDeclarations: readonly string[];
  readonly resourceConstraints?: PackResourceConstraints | undefined;
  readonly documentation: PackDocumentation;
  readonly integrity: PackIntegrityMetadata;
}

export interface PackValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface PackValidationResult {
  readonly valid: boolean;
  readonly issues: readonly PackValidationIssue[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface InstalledCapabilityPack {
  readonly packId: string;
  readonly manifest: CapabilityPackManifest;
  readonly scope: PackInstallationScope;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly installedVersion: string;
  readonly previousVersion?: string | undefined;
  readonly previousManifest?: CapabilityPackManifest | undefined;
}

export interface PackReadinessResult {
  readonly packId: string;
  readonly version: string;
  readonly status: PackReadinessStatus;
  readonly isReady: boolean;
  readonly modeReadiness?: ResolvedExecutionProfile | undefined;
  readonly diagnostics: readonly string[];
  readonly missingSkills: readonly string[];
  readonly missingMcpServers: readonly string[];
  readonly blockedPolicies: readonly string[];
  readonly unmetModelRequirements: readonly string[];
  readonly timestamp: number;
}

export interface PackPreviewInfo {
  readonly packId: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: PackPublisher;
  readonly sourceRepository: PackSourceRepository;
  readonly license: string;
  readonly attribution?: string | undefined;
  readonly requestedPermissions: readonly string[];
  readonly requiredSkills: readonly string[];
  readonly requiredMcpServers: readonly string[];
  readonly baseMode: string;
  readonly trustWarnings: readonly string[];
  readonly integrityVerified: boolean;
}
