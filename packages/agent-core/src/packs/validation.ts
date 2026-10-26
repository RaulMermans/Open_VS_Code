import { createHash } from "node:crypto";
import { validateCustomModeProfile } from "../modes/validation.ts";
import type {
  CapabilityPackManifest,
  PackIntegrityMetadata,
  PackValidationIssue,
  PackValidationResult,
} from "./contracts.ts";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const CREDENTIAL_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9_]{36,}/,
  /gho_[A-Za-z0-9_]{36,}/,
  /ovsc_sess_[A-Za-z0-9_-]{32,}/,
  /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/,
];

const EXECUTABLE_DIRECTIVE_KEYS = new Set([
  "exec",
  "execute",
  "script",
  "scripts",
  "shell",
  "command",
  "commands",
  "binary",
  "binaries",
  "postinstall",
  "preinstall",
  "installhook",
  "hooks",
  "npminstall",
  "npx",
  "runcommand",
]);

const TRAVERSAL_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

const MUTATION_PERMISSIONS = new Set([
  "write_file",
  "create_file",
  "apply_patch",
  "delete_file",
  "git_commit",
  "git_push",
  "deploy",
  "terminal_command",
  "mcp_external_destructive",
  "mcp_external_side_effect",
]);

export function computeManifestDigest(manifestJsonOrPayload: string): string {
  return createHash("sha256").update(manifestJsonOrPayload, "utf8").digest("hex");
}

export function verifyPackIntegrity(content: string, integrity: PackIntegrityMetadata): boolean {
  if (!integrity || integrity.algorithm !== "sha256" || !integrity.digest) {
    return false;
  }
  const actual = computeManifestDigest(content);
  return actual.toLowerCase() === integrity.digest.toLowerCase();
}

function scanObjectForPollutionAndExec(
  obj: unknown,
  path: string,
  issues: PackValidationIssue[]
): void {
  if (obj === null || typeof obj !== "object") {
    return;
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => scanObjectForPollutionAndExec(item, `${path}[${idx}]`, issues));
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(record)) {
    if (FORBIDDEN_PROPERTY_NAMES.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `Forbidden property name "${key}" detected (prototype pollution prevention).`,
        severity: "error",
      });
      continue;
    }

    if (EXECUTABLE_DIRECTIVE_KEYS.has(key.toLowerCase())) {
      issues.push({
        path: `${path}.${key}`,
        message: `Executable directive "${key}" is strictly forbidden in capability packs (arbitrary execution prevention).`,
        severity: "error",
      });
    }

    const val = record[key];
    if (typeof val === "string") {
      if (TRAVERSAL_PATTERN.test(val)) {
        issues.push({
          path: `${path}.${key}`,
          message: `Path traversal sequence detected in "${key}": "${val}".`,
          severity: "error",
        });
      }

      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(val)) {
          issues.push({
            path: `${path}.${key}`,
            message: `Potential credential or private key detected in "${key}". Manifests cannot contain credentials.`,
            severity: "error",
          });
          break;
        }
      }
    } else if (val !== null && typeof val === "object") {
      scanObjectForPollutionAndExec(val, `${path}.${key}`, issues);
    }
  }
}

export function validateCapabilityPackManifest(input: unknown): PackValidationResult {
  const issues: PackValidationIssue[] = [];

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      issues: [{ path: "manifest", message: "Manifest must be a non-null object.", severity: "error" }],
      errors: ["Manifest must be a non-null object."],
      warnings: [],
    };
  }

  // Scan deeply for prototype pollution, executable directives, traversal, and credentials
  scanObjectForPollutionAndExec(input, "manifest", issues);

  const manifest = input as Partial<CapabilityPackManifest>;

  // Schema version
  if (manifest.schemaVersion !== 1) {
    issues.push({
      path: "manifest.schemaVersion",
      message: `Unsupported schemaVersion "${String(manifest.schemaVersion)}". Only version 1 is supported.`,
      severity: "error",
    });
  }

  // Pack ID
  if (!manifest.id || typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id)) {
    issues.push({
      path: "manifest.id",
      message: `Invalid pack id "${String(manifest.id)}". Must match pattern ${ID_PATTERN.source} (1-64 chars, lowercase alphanumeric, hyphens, underscores).`,
      severity: "error",
    });
  }

  // Name
  if (!manifest.name || typeof manifest.name !== "string" || manifest.name.trim().length === 0 || manifest.name.length > 100) {
    issues.push({
      path: "manifest.name",
      message: "Pack name is required and must be between 1 and 100 characters.",
      severity: "error",
    });
  }

  // Description
  if (!manifest.description || typeof manifest.description !== "string" || manifest.description.trim().length === 0 || manifest.description.length > 500) {
    issues.push({
      path: "manifest.description",
      message: "Pack description is required and must be between 1 and 500 characters.",
      severity: "error",
    });
  }

  // Version
  if (!manifest.version || typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    issues.push({
      path: "manifest.version",
      message: `Pack version "${String(manifest.version)}" must be a valid Semantic Version (e.g. 1.0.0).`,
      severity: "error",
    });
  }

  // Publisher
  if (!manifest.publisher || typeof manifest.publisher !== "object") {
    issues.push({
      path: "manifest.publisher",
      message: "Publisher identity object is required.",
      severity: "error",
    });
  } else {
    if (!manifest.publisher.id || typeof manifest.publisher.id !== "string" || !ID_PATTERN.test(manifest.publisher.id)) {
      issues.push({
        path: "manifest.publisher.id",
        message: `Invalid publisher id "${String(manifest.publisher.id)}". Must match pattern ${ID_PATTERN.source}.`,
        severity: "error",
      });
    }
    if (!manifest.publisher.name || typeof manifest.publisher.name !== "string" || manifest.publisher.name.trim().length === 0) {
      issues.push({
        path: "manifest.publisher.name",
        message: "Publisher name is required.",
        severity: "error",
      });
    }
    if (manifest.publisher.url) {
      try {
        const u = new URL(manifest.publisher.url);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          issues.push({
            path: "manifest.publisher.url",
            message: "Publisher URL must use https: or http: scheme.",
            severity: "error",
          });
        }
        if (u.username || u.password) {
          issues.push({
            path: "manifest.publisher.url",
            message: "Publisher URL cannot contain embedded credentials.",
            severity: "error",
          });
        }
      } catch {
        issues.push({
          path: "manifest.publisher.url",
          message: "Publisher URL is not a valid URL.",
          severity: "error",
        });
      }
    }
  }

  // Source Repository
  if (!manifest.sourceRepository || typeof manifest.sourceRepository !== "object") {
    issues.push({
      path: "manifest.sourceRepository",
      message: "Source repository object is required.",
      severity: "error",
    });
  } else {
    if (!manifest.sourceRepository.url || typeof manifest.sourceRepository.url !== "string") {
      issues.push({
        path: "manifest.sourceRepository.url",
        message: "Source repository URL is required.",
        severity: "error",
      });
    } else {
      try {
        const u = new URL(manifest.sourceRepository.url);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          issues.push({
            path: "manifest.sourceRepository.url",
            message: "Source repository URL must use https: or http: scheme.",
            severity: "error",
          });
        }
        if (u.username || u.password) {
          issues.push({
            path: "manifest.sourceRepository.url",
            message: "Source repository URL cannot contain embedded credentials.",
            severity: "error",
          });
        }
      } catch {
        issues.push({
          path: "manifest.sourceRepository.url",
          message: "Source repository URL is not a valid URL.",
          severity: "error",
        });
      }
    }
  }

  // License
  if (!manifest.license || typeof manifest.license !== "string" || manifest.license.trim().length === 0) {
    issues.push({
      path: "manifest.license",
      message: "Pack license declaration is required (e.g. MIT, Apache-2.0).",
      severity: "error",
    });
  }

  // Compatible Open VS Code version
  if (!manifest.openVsCodeVersion || typeof manifest.openVsCodeVersion !== "string" || manifest.openVsCodeVersion.trim().length === 0) {
    issues.push({
      path: "manifest.openVsCodeVersion",
      message: "Compatible Open VS Code version requirement is required (e.g. ^0.1.0).",
      severity: "error",
    });
  }

  // Custom Mode
  if (!manifest.customMode || typeof manifest.customMode !== "object") {
    issues.push({
      path: "manifest.customMode",
      message: "Referenced Custom Mode definition is required.",
      severity: "error",
    });
  } else {
    const modeValidation = validateCustomModeProfile(manifest.customMode);
    if (!modeValidation.valid) {
      for (const err of modeValidation.errors) {
        issues.push({
          path: "manifest.customMode",
          message: `Custom mode validation error: ${err}`,
          severity: "error",
        });
      }
    }
  }

  // Required & Optional Skills
  if (!Array.isArray(manifest.requiredSkills)) {
    issues.push({
      path: "manifest.requiredSkills",
      message: "requiredSkills must be an array of skill identifiers.",
      severity: "error",
    });
  } else {
    for (const [idx, s] of manifest.requiredSkills.entries()) {
      if (typeof s !== "string" || !ID_PATTERN.test(s)) {
        issues.push({
          path: `manifest.requiredSkills[${idx}]`,
          message: `Invalid required skill identifier "${String(s)}".`,
          severity: "error",
        });
      }
    }
  }

  if (!Array.isArray(manifest.optionalSkills)) {
    issues.push({
      path: "manifest.optionalSkills",
      message: "optionalSkills must be an array of skill identifiers.",
      severity: "error",
    });
  } else {
    for (const [idx, s] of manifest.optionalSkills.entries()) {
      if (typeof s !== "string" || !ID_PATTERN.test(s)) {
        issues.push({
          path: `manifest.optionalSkills[${idx}]`,
          message: `Invalid optional skill identifier "${String(s)}".`,
          severity: "error",
        });
      }
    }
  }

  // Required & Optional MCP Servers
  if (!Array.isArray(manifest.requiredMcpServers)) {
    issues.push({
      path: "manifest.requiredMcpServers",
      message: "requiredMcpServers must be an array of MCP server requirement objects.",
      severity: "error",
    });
  } else {
    for (const [idx, req] of manifest.requiredMcpServers.entries()) {
      if (!req || typeof req !== "object" || !req.id || typeof req.id !== "string" || !ID_PATTERN.test(req.id)) {
        issues.push({
          path: `manifest.requiredMcpServers[${idx}]`,
          message: `Invalid required MCP server specification at index ${idx}. Must include valid id.`,
          severity: "error",
        });
      }
    }
  }

  if (!Array.isArray(manifest.optionalMcpServers)) {
    issues.push({
      path: "manifest.optionalMcpServers",
      message: "optionalMcpServers must be an array of MCP server requirement objects.",
      severity: "error",
    });
  } else {
    for (const [idx, req] of manifest.optionalMcpServers.entries()) {
      if (!req || typeof req !== "object" || !req.id || typeof req.id !== "string" || !ID_PATTERN.test(req.id)) {
        issues.push({
          path: `manifest.optionalMcpServers[${idx}]`,
          message: `Invalid optional MCP server specification at index ${idx}. Must include valid id.`,
          severity: "error",
        });
      }
    }
  }

  // Permission Declarations & Conflict Checks
  if (!Array.isArray(manifest.permissionDeclarations)) {
    issues.push({
      path: "manifest.permissionDeclarations",
      message: "permissionDeclarations must be an array of requested permission strings.",
      severity: "error",
    });
  } else {
    const baseMode = manifest.customMode?.baseMode;
    const isReadOnlyBaseMode = baseMode === "ASK" || baseMode === "PLAN" || baseMode === "REVIEW";

    for (const [idx, perm] of manifest.permissionDeclarations.entries()) {
      if (typeof perm !== "string" || perm.trim().length === 0) {
        issues.push({
          path: `manifest.permissionDeclarations[${idx}]`,
          message: "Permission declaration must be a non-empty string.",
          severity: "error",
        });
      } else if (isReadOnlyBaseMode && MUTATION_PERMISSIONS.has(perm)) {
        issues.push({
          path: `manifest.permissionDeclarations[${idx}]`,
          message: `Permission conflict: pack requests mutating permission "${perm}" while base mode is read-only "${baseMode}". Custom packs cannot expand base mode authority.`,
          severity: "error",
        });
      }
    }
  }

  // Documentation
  if (!manifest.documentation || typeof manifest.documentation !== "object" || !manifest.documentation.summary) {
    issues.push({
      path: "manifest.documentation",
      message: "Documentation object with summary is required.",
      severity: "error",
    });
  }

  // Integrity metadata
  if (!manifest.integrity || typeof manifest.integrity !== "object" || manifest.integrity.algorithm !== "sha256" || !manifest.integrity.digest) {
    issues.push({
      path: "manifest.integrity",
      message: "Integrity metadata with sha256 algorithm and digest is required.",
      severity: "error",
    });
  } else if (!/^[a-fA-F0-9]{64}$/.test(manifest.integrity.digest)) {
    issues.push({
      path: "manifest.integrity.digest",
      message: "Integrity digest must be a 64-character hexadecimal SHA-256 string.",
      severity: "error",
    });
  }

  const errors = issues.filter((i) => i.severity === "error").map((i) => `${i.path}: ${i.message}`);
  const warnings = issues.filter((i) => i.severity === "warning").map((i) => `${i.path}: ${i.message}`);

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
  };
}
