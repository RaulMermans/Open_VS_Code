import { AGENT_MODES, type AgentMode } from "../contracts/agent.ts";
import type { ModeValidationIssue, ModeValidationResult } from "./contracts.ts";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_INSTRUCTION_CHARS = 8000;
const MAX_NAME_CHARS = 100;
const MAX_DESC_CHARS = 500;
const MAX_ITEMS = 50;

const CREDENTIAL_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /-----BEGIN\s+(?:RSA|OPENSSH|EC|DSA)?\s*PRIVATE KEY-----/,
];

const KNOWN_FIELDS = new Set([
  "id",
  "name",
  "description",
  "icon",
  "version",
  "schemaVersion",
  "source",
  "baseMode",
  "customInstructions",
  "requiredSkills",
  "optionalSkills",
  "requiredMcpServers",
  "optionalMcpServers",
  "toolAllowlist",
  "preferredModelId",
  "workflowPreference",
  "contextGuidance",
  "verificationPreferences",
  "sourceRepoReferences",
  "scope",
  "enabled",
  "createdAt",
  "updatedAt",
]);

export function validateCustomModeProfile(raw: unknown): ModeValidationResult {
  const issues: ModeValidationIssue[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      issues: [{ path: "", message: "Profile must be a non-null object", severity: "error" }],
      errors: ["Profile must be a non-null object"],
      warnings: [],
    };
  }

  const record = raw as Record<string, unknown>;

  // Prototype pollution guard
  for (const forbiddenKey of ["__proto__", "constructor", "prototype"]) {
    if (Object.prototype.hasOwnProperty.call(record, forbiddenKey)) {
      issues.push({
        path: forbiddenKey,
        message: `Forbidden key detected: ${forbiddenKey}`,
        severity: "error",
      });
    }
  }

  // Unknown fields check (fail closed)
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      issues.push({
        path: key,
        message: `Unknown property "${key}" in custom mode profile`,
        severity: "error",
      });
    }
  }

  // schemaVersion
  if (record.schemaVersion !== 1) {
    issues.push({
      path: "schemaVersion",
      message: `Unsupported schemaVersion "${String(record.schemaVersion)}". Only schemaVersion 1 is supported.`,
      severity: "error",
    });
  }

  // id
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) {
    issues.push({
      path: "id",
      message: `Invalid profile id "${String(record.id)}". Must match pattern ${ID_PATTERN.source}.`,
      severity: "error",
    });
  }

  // name
  if (typeof record.name !== "string" || record.name.trim().length === 0 || record.name.length > MAX_NAME_CHARS) {
    issues.push({
      path: "name",
      message: `Name must be a non-empty string between 1 and ${MAX_NAME_CHARS} characters.`,
      severity: "error",
    });
  }

  // description
  if (typeof record.description !== "string" || record.description.length > MAX_DESC_CHARS) {
    issues.push({
      path: "description",
      message: `Description must be a string up to ${MAX_DESC_CHARS} characters.`,
      severity: "error",
    });
  }

  // icon
  if (record.icon !== undefined && (typeof record.icon !== "string" || record.icon.length > 50)) {
    issues.push({
      path: "icon",
      message: "Icon identifier must be a string up to 50 characters.",
      severity: "error",
    });
  }

  // version
  if (typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) {
    issues.push({
      path: "version",
      message: "Version must be a positive integer.",
      severity: "error",
    });
  }

  // source
  if (record.source !== "builtin" && record.source !== "workspace" && record.source !== "account") {
    issues.push({
      path: "source",
      message: 'Source must be "builtin", "workspace", or "account".',
      severity: "error",
    });
  }

  // scope
  if (record.scope !== "builtin" && record.scope !== "workspace" && record.scope !== "account") {
    issues.push({
      path: "scope",
      message: 'Scope must be "builtin", "workspace", or "account".',
      severity: "error",
    });
  }

  // baseMode
  if (typeof record.baseMode !== "string" || !AGENT_MODES.includes(record.baseMode as AgentMode)) {
    issues.push({
      path: "baseMode",
      message: `Base mode must be one of: ${AGENT_MODES.join(", ")}.`,
      severity: "error",
    });
  }

  // customInstructions
  if (record.customInstructions !== undefined) {
    if (typeof record.customInstructions !== "string") {
      issues.push({
        path: "customInstructions",
        message: "Custom instructions must be a string.",
        severity: "error",
      });
    } else {
      if (record.customInstructions.length > MAX_INSTRUCTION_CHARS) {
        issues.push({
          path: "customInstructions",
          message: `Custom instructions exceed maximum length of ${MAX_INSTRUCTION_CHARS} characters.`,
          severity: "error",
        });
      }
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(record.customInstructions)) {
          issues.push({
            path: "customInstructions",
            message: "Custom instructions appear to contain credentials or private key material.",
            severity: "error",
          });
          break;
        }
      }
    }
  }

  // validate string arrays helper
  const validateStringArray = (field: string, pattern?: RegExp) => {
    const val = record[field];
    if (val === undefined) {
      issues.push({
        path: field,
        message: `${field} is required and must be an array of strings.`,
        severity: "error",
      });
      return;
    }
    if (!Array.isArray(val)) {
      issues.push({
        path: field,
        message: `${field} must be an array of strings.`,
        severity: "error",
      });
      return;
    }
    if (val.length > MAX_ITEMS) {
      issues.push({
        path: field,
        message: `${field} cannot contain more than ${MAX_ITEMS} items.`,
        severity: "error",
      });
    }
    const seen = new Set<string>();
    for (let i = 0; i < val.length; i++) {
      const item = val[i];
      if (typeof item !== "string" || item.trim().length === 0) {
        issues.push({
          path: `${field}[${i}]`,
          message: `Each item in ${field} must be a non-empty string.`,
          severity: "error",
        });
      } else if (seen.has(item)) {
        issues.push({
          path: `${field}[${i}]`,
          message: `Duplicate item "${item}" in ${field}.`,
          severity: "error",
        });
      } else if (pattern && !pattern.test(item)) {
        issues.push({
          path: `${field}[${i}]`,
          message: `Item "${item}" in ${field} does not match required format.`,
          severity: "error",
        });
      }
      seen.add(item);
    }
  };

  validateStringArray("requiredSkills", SKILL_ID_PATTERN);
  validateStringArray("optionalSkills", SKILL_ID_PATTERN);
  validateStringArray("requiredMcpServers", MCP_SERVER_ID_PATTERN);
  validateStringArray("optionalMcpServers", MCP_SERVER_ID_PATTERN);

  // toolAllowlist
  if (record.toolAllowlist !== undefined) {
    if (!Array.isArray(record.toolAllowlist)) {
      issues.push({
        path: "toolAllowlist",
        message: "toolAllowlist must be an array of strings.",
        severity: "error",
      });
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < record.toolAllowlist.length; i++) {
        const item = record.toolAllowlist[i];
        if (typeof item !== "string" || item.trim().length === 0) {
          issues.push({
            path: `toolAllowlist[${i}]`,
            message: "Each item in toolAllowlist must be a non-empty string.",
            severity: "error",
          });
        } else if (seen.has(item)) {
          issues.push({
            path: `toolAllowlist[${i}]`,
            message: `Duplicate tool "${item}" in toolAllowlist.`,
            severity: "error",
          });
        }
        seen.add(item);
      }
    }
  }

  // preferredModelId
  if (record.preferredModelId !== undefined && (typeof record.preferredModelId !== "string" || record.preferredModelId.length > 100)) {
    issues.push({
      path: "preferredModelId",
      message: "preferredModelId must be a string up to 100 characters.",
      severity: "error",
    });
  }

  // workflowPreference
  if (record.workflowPreference !== undefined && record.workflowPreference !== "direct" && record.workflowPreference !== "structured") {
    issues.push({
      path: "workflowPreference",
      message: 'workflowPreference must be either "direct" or "structured".',
      severity: "error",
    });
  }

  // verificationPreferences
  if (record.verificationPreferences !== undefined) {
    if (typeof record.verificationPreferences !== "object" || record.verificationPreferences === null) {
      issues.push({
        path: "verificationPreferences",
        message: "verificationPreferences must be an object.",
        severity: "error",
      });
    } else {
      const vp = record.verificationPreferences as Record<string, unknown>;
      if (vp.testCommandOverride !== undefined && (typeof vp.testCommandOverride !== "string" || vp.testCommandOverride.length > 200)) {
        issues.push({
          path: "verificationPreferences.testCommandOverride",
          message: "testCommandOverride must be a string up to 200 characters.",
          severity: "error",
        });
      }
    }
  }

  // enabled
  if (typeof record.enabled !== "boolean") {
    issues.push({
      path: "enabled",
      message: "enabled must be a boolean.",
      severity: "error",
    });
  }

  // createdAt & updatedAt
  if (typeof record.createdAt !== "string" || record.createdAt.trim().length === 0) {
    issues.push({
      path: "createdAt",
      message: "createdAt must be a valid ISO-8601 string.",
      severity: "error",
    });
  }
  if (typeof record.updatedAt !== "string" || record.updatedAt.trim().length === 0) {
    issues.push({
      path: "updatedAt",
      message: "updatedAt must be a valid ISO-8601 string.",
      severity: "error",
    });
  }

  const errors = issues.filter((i) => i.severity === "error").map((i) => `${i.path ? `[${i.path}] ` : ""}${i.message}`);
  const warnings = issues.filter((i) => i.severity === "warning").map((i) => `${i.path ? `[${i.path}] ` : ""}${i.message}`);

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
  };
}
