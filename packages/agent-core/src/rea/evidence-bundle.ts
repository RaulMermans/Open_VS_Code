/**
 * Sprint 10A.1C — REA Evidence Bundle & Continuity Contracts.
 *
 * Implements addressable, bounded evidence bundles connecting REA Investigation
 * to Governed Reconstruction.
 *
 * Guarantees:
 * - Deterministic serialization and SHA-256 bundle digest.
 * - Workspace and account scope validation (fails closed across boundaries).
 * - Corrupted, tampered, or schema-incompatible evidence fails closed.
 * - Sensitive credential/cookie redaction before disk persistence.
 * - Stored under canonical workspace path: .open-vs-code/rea/bundles/<investigationId>.json.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactRuntimeEvalSecrets } from "../runtime-evals/evidence.ts";
import type {
  FeatureSpecItem,
  InvestigationTargetCategory,
  ObservableStateTransition,
  ReconstructionObligationLedger,
  ReconstructionSpecification,
  UnknownDetailItem,
} from "./contracts.ts";

export const REA_EVIDENCE_BUNDLE_SCHEMA_VERSION = "open-vs-code/rea-evidence-bundle@v1" as const;

export interface ReaEvidenceBundle {
  readonly schemaVersion: typeof REA_EVIDENCE_BUNDLE_SCHEMA_VERSION;
  readonly investigationId: string;
  readonly workspaceRoot: string;
  readonly accountScope?: string | undefined;
  readonly targetIdentity: string;
  readonly targetType: InvestigationTargetCategory;
  readonly timestamp: number;
  readonly featureInventory: readonly FeatureSpecItem[];
  readonly observedBehaviors: readonly string[];
  readonly inferredBehaviors: readonly string[];
  readonly unresolvedUnknowns: readonly UnknownDetailItem[];
  readonly stateTransitions: readonly ObservableStateTransition[];
  readonly evidenceReferences: readonly string[];
  readonly specification: ReconstructionSpecification;
  readonly obligationLedger: ReconstructionObligationLedger;
  readonly artifactDigests: Readonly<Record<string, string>>;
  readonly bundleDigest: string;
}

export interface CreateEvidenceBundleOptions {
  readonly investigationId: string;
  readonly workspaceRoot: string;
  readonly accountScope?: string | undefined;
  readonly specification: ReconstructionSpecification;
  readonly obligationLedger: ReconstructionObligationLedger;
  readonly stateTransitions?: readonly ObservableStateTransition[] | undefined;
  readonly evidenceReferences?: readonly string[] | undefined;
  readonly artifactDigests?: Readonly<Record<string, string>> | undefined;
  readonly timestamp?: number | undefined;
}

/**
 * Strips secrets, cookies, bearer tokens, and credentials from string values.
 */
function redactBundleText(text: string): string {
  let cleaned = redactRuntimeEvalSecrets(text);
  // Redact cookie headers or authentication parameters
  cleaned = cleaned.replace(/(?:cookie|authorization|bearer|token)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=***REDACTED***");
  return cleaned;
}

function sanitizeBundleObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return redactBundleText(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeBundleObject(item)) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = sanitizeBundleObject(val);
    }
    return out as T;
  }
  return obj;
}

/**
 * Computes deterministic SHA-256 digest of evidence bundle contents excluding bundleDigest.
 */
export function computeEvidenceBundleDigest(bundle: Omit<ReaEvidenceBundle, "bundleDigest">): string {
  const normalized = {
    schemaVersion: bundle.schemaVersion,
    investigationId: bundle.investigationId,
    workspaceRoot: bundle.workspaceRoot,
    accountScope: bundle.accountScope ?? null,
    targetIdentity: bundle.targetIdentity,
    targetType: bundle.targetType,
    timestamp: bundle.timestamp,
    featureInventory: bundle.featureInventory,
    observedBehaviors: bundle.observedBehaviors,
    inferredBehaviors: bundle.inferredBehaviors,
    unresolvedUnknowns: bundle.unresolvedUnknowns,
    stateTransitions: bundle.stateTransitions,
    evidenceReferences: bundle.evidenceReferences,
    specification: bundle.specification,
    obligationLedger: bundle.obligationLedger,
    artifactDigests: bundle.artifactDigests,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Creates an authoritative ReaEvidenceBundle from investigation artifacts.
 */
export function createReaEvidenceBundle(options: CreateEvidenceBundleOptions): ReaEvidenceBundle {
  const spec = options.specification;
  const ledger = options.obligationLedger;

  const observedBehaviors = spec.featureInventory
    .filter((f) => f.epistemicStatus === "OBSERVED")
    .map((f) => `[OBSERVED] ${f.title}: ${f.description}`);

  const inferredBehaviors = [
    ...spec.featureInventory
      .filter((f) => f.epistemicStatus === "INFERRED")
      .map((f) => `[INFERRED] ${f.title}: ${f.description}`),
    ...spec.visibleBusinessRules
      .filter((r) => r.isHypothesis)
      .map((r) => `[INFERRED_RULE] ${r.statement}`),
  ];

  const unresolvedUnknowns = spec.unknowns ?? [];
  const stateTransitions = options.stateTransitions ?? spec.interactionStateGraph ?? [];
  const evidenceReferences = options.evidenceReferences ?? spec.evidenceLinks ?? [];

  const rawArtifactDigests = options.artifactDigests ?? {
    specification: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    obligationLedger: createHash("sha256").update(JSON.stringify(ledger)).digest("hex"),
  };

  const canonicalRoot = existsSync(options.workspaceRoot)
    ? realpathSync(options.workspaceRoot)
    : resolve(options.workspaceRoot);

  const partialBundle: Omit<ReaEvidenceBundle, "bundleDigest"> = sanitizeBundleObject({
    schemaVersion: REA_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    investigationId: options.investigationId,
    workspaceRoot: canonicalRoot,
    accountScope: options.accountScope ?? LOCAL_UNAUTHENTICATED_ACCOUNT_SCOPE,
    targetIdentity: spec.target.rawInput || spec.target.normalizedLocation || spec.target.targetId,
    targetType: spec.target.category,
    timestamp: options.timestamp ?? spec.createdAt ?? Date.now(),
    featureInventory: spec.featureInventory,
    observedBehaviors,
    inferredBehaviors,
    unresolvedUnknowns,
    stateTransitions,
    evidenceReferences,
    specification: spec,
    obligationLedger: ledger,
    artifactDigests: rawArtifactDigests,
  });

  const bundleDigest = computeEvidenceBundleDigest(partialBundle);

  return {
    ...partialBundle,
    bundleDigest,
  };
}

/**
 * Resolves the storage directory for REA evidence bundles.
 */
export function getReaEvidenceStorageDir(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ".open-vs-code", "rea", "bundles");
}

/**
 * Persists an evidence bundle to the canonical workspace storage.
 */
export function saveReaEvidenceBundle(bundle: ReaEvidenceBundle): string {
  const dir = getReaEvidenceStorageDir(bundle.workspaceRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const bundlePath = join(dir, `${bundle.investigationId}.json`);
  const content = JSON.stringify(bundle, null, 2);
  writeFileSync(bundlePath, content, "utf8");

  // Also update latest pointer
  const latestPath = join(dir, "latest.json");
  writeFileSync(latestPath, content, "utf8");

  return bundlePath;
}

export const LOCAL_UNAUTHENTICATED_ACCOUNT_SCOPE = "local:unauthenticated";

export type EvidenceValidationResult =
  | { readonly valid: true; readonly bundle: ReaEvidenceBundle }
  | { readonly valid: false; readonly reason: string; readonly code: "WORKSPACE_MISMATCH" | "ACCOUNT_MISMATCH" | "SCHEMA_INCOMPATIBLE" | "INTEGRITY_COMPROMISED" | "CORRUPTED" | "NOT_FOUND" };

/**
 * Validates the cryptographic integrity, schema, and workspace/account scope of a bundle.
 */
export function validateReaEvidenceBundle(
  bundle: unknown,
  expectedWorkspaceRoot: string,
  expectedAccountScope?: string | undefined
): EvidenceValidationResult {
  if (!bundle || typeof bundle !== "object") {
    return { valid: false, reason: "Evidence bundle is not an object", code: "CORRUPTED" };
  }

  const b = bundle as Partial<ReaEvidenceBundle>;

  if (b.schemaVersion !== REA_EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `Unsupported schema version "${b.schemaVersion}". Expected "${REA_EVIDENCE_BUNDLE_SCHEMA_VERSION}".`,
      code: "SCHEMA_INCOMPATIBLE",
    };
  }

  if (!b.investigationId || !b.targetIdentity || !b.bundleDigest || !b.specification || !b.obligationLedger) {
    return { valid: false, reason: "Evidence bundle is missing required fields.", code: "CORRUPTED" };
  }

  // Scope check: workspace
  const canonicalExpectedWs = existsSync(expectedWorkspaceRoot)
    ? realpathSync(expectedWorkspaceRoot)
    : resolve(expectedWorkspaceRoot);

  const canonicalBundleWs = existsSync(b.workspaceRoot || "")
    ? realpathSync(b.workspaceRoot!)
    : resolve(b.workspaceRoot || "");

  if (canonicalBundleWs !== canonicalExpectedWs) {
    return {
      valid: false,
      reason: `Evidence bundle workspace "${b.workspaceRoot}" does not match active workspace "${expectedWorkspaceRoot}". Cross-workspace evidence is rejected.`,
      code: "WORKSPACE_MISMATCH",
    };
  }

  // Scope check: account ownership
  const effectiveExpectedScope = expectedAccountScope || LOCAL_UNAUTHENTICATED_ACCOUNT_SCOPE;
  const bundleScope = b.accountScope;

  if (bundleScope) {
    if (bundleScope !== effectiveExpectedScope) {
      return {
        valid: false,
        reason: `Evidence bundle account scope "${bundleScope}" does not match active account scope "${effectiveExpectedScope}". Cross-account evidence is rejected.`,
        code: "ACCOUNT_MISMATCH",
      };
    }
  } else {
    // Legacy unscoped bundle policy:
    // Only accessible in local:unauthenticated mode.
    // Authenticated users cannot claim legacy unscoped bundles without explicit migration.
    if (effectiveExpectedScope !== LOCAL_UNAUTHENTICATED_ACCOUNT_SCOPE) {
      return {
        valid: false,
        reason: `Evidence bundle is unscoped (legacy) and cannot be claimed by authenticated account "${effectiveExpectedScope}" without explicit migration.`,
        code: "ACCOUNT_MISMATCH",
      };
    }
  }

  // Cryptographic integrity check
  const { bundleDigest, ...rest } = b as ReaEvidenceBundle;
  const expectedDigest = computeEvidenceBundleDigest(rest as any);
  if (bundleDigest !== expectedDigest) {
    return {
      valid: false,
      reason: `Evidence bundle digest mismatch: claimed ${bundleDigest}, computed ${expectedDigest}. Evidence is compromised or tampered.`,
      code: "INTEGRITY_COMPROMISED",
    };
  }

  return { valid: true, bundle: b as ReaEvidenceBundle };
}

/**
 * Loads an evidence bundle by file path or ID from workspace storage and validates it.
 */
export function loadReaEvidenceBundle(
  identifierOrPath: string,
  workspaceRoot: string,
  accountScope?: string | undefined
): EvidenceValidationResult {
  let filePath = identifierOrPath;
  if (!existsSync(filePath)) {
    const storageDir = getReaEvidenceStorageDir(workspaceRoot);
    const candidatePath = join(storageDir, `${identifierOrPath.replace(/\.json$/, "")}.json`);
    if (existsSync(candidatePath)) {
      filePath = candidatePath;
    } else {
      return {
        valid: false,
        reason: `Evidence bundle file not found: "${identifierOrPath}".`,
        code: "NOT_FOUND",
      };
    }
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return {
      valid: false,
      reason: `Failed to read or parse evidence bundle at "${filePath}": ${err.message}`,
      code: "CORRUPTED",
    };
  }

  return validateReaEvidenceBundle(parsed, workspaceRoot, accountScope);
}

/**
 * Resolves the appropriate evidence bundle for reconstruction:
 * 1. Explicit investigation/bundle ID reference in task text (e.g. "investigation: inv_123")
 * 2. Explicit provided path
 * 3. Most recent valid investigation bundle for the workspace
 */
export function resolveReaEvidenceBundle(
  workspaceRoot: string,
  taskText?: string | undefined,
  accountScope?: string | undefined
): EvidenceValidationResult {
  const storageDir = getReaEvidenceStorageDir(workspaceRoot);

  if (taskText) {
    const invMatch = taskText.match(/(?:investigation|bundle|evidence)(?:_id|id)?[:=\s]+([a-zA-Z0-9_-]+)/i);
    if (invMatch && invMatch[1]) {
      const res = loadReaEvidenceBundle(invMatch[1], workspaceRoot, accountScope);
      if (res.valid) return res;
      if (res.code === "ACCOUNT_MISMATCH" || res.code === "WORKSPACE_MISMATCH" || res.code === "INTEGRITY_COMPROMISED") {
        return res;
      }
    }
  }

  // Check latest.json pointer
  let latestMismatchResult: EvidenceValidationResult | undefined;
  const latestPath = join(storageDir, "latest.json");
  if (existsSync(latestPath)) {
    const res = loadReaEvidenceBundle(latestPath, workspaceRoot, accountScope);
    if (res.valid) return res;
    if (res.code === "ACCOUNT_MISMATCH") {
      latestMismatchResult = res;
    }
  }

  // Scan storage dir for newest valid bundle for this account
  if (existsSync(storageDir)) {
    try {
      const files = readdirSync(storageDir)
        .filter((f) => f.endsWith(".json") && f !== "latest.json")
        .toSorted()
        .toReversed();

      for (const file of files) {
        const res = loadReaEvidenceBundle(join(storageDir, file), workspaceRoot, accountScope);
        if (res.valid) return res;
      }
    } catch {
      // Ignore read errors
    }
  }

  if (latestMismatchResult) {
    return latestMismatchResult;
  }

  return {
    valid: false,
    reason: `No valid REA evidence bundle found for workspace "${workspaceRoot}". Run REA investigation first.`,
    code: "NOT_FOUND",
  };
}
