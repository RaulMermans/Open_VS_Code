import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCustomModeProfile,
  getStarterModeProfiles,
  findStarterModeProfile,
  resolveExecutionProfile,
  createAgentRuntime,
  type CustomModeProfile,
  type ModeResolverInput,
} from "../../src/index.ts";

describe("Custom Modes Engine (Sprint 8D) — Validation", () => {
  const validProfile: CustomModeProfile = {
    id: "test-mode",
    name: "Test Mode",
    description: "A test custom mode profile",
    icon: "code",
    version: 1,
    schemaVersion: 1,
    source: "workspace",
    baseMode: "PLAN",
    customInstructions: "Analyze the code carefully and provide suggestions.",
    requiredSkills: [],
    optionalSkills: [],
    requiredMcpServers: [],
    optionalMcpServers: [],
    toolAllowlist: ["read_repository", "search_repository"],
    preferredModelId: "test-model-7b",
    workflowPreference: "direct",
    scope: "workspace",
    enabled: true,
    createdAt: "2026-10-25T12:00:00.000Z",
    updatedAt: "2026-10-25T12:00:00.000Z",
  };

  it("validates a compliant profile successfully", () => {
    const result = validateCustomModeProfile(validProfile);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("fails closed on non-object or null input", () => {
    assert.equal(validateCustomModeProfile(null).valid, false);
    assert.equal(validateCustomModeProfile("not-an-object").valid, false);
    assert.equal(validateCustomModeProfile([]).valid, false);
  });

  it("detects and rejects prototype pollution attempts", () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":true},"id":"bad","name":"Bad","description":"","version":1,"schemaVersion":1,"source":"workspace","baseMode":"PLAN","requiredSkills":[],"optionalSkills":[],"requiredMcpServers":[],"optionalMcpServers":[],"scope":"workspace","enabled":true,"createdAt":"2026-10-25T00:00:00Z","updatedAt":"2026-10-25T00:00:00Z"}');
    const result = validateCustomModeProfile(malicious);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Forbidden key detected")));
  });

  it("detects and rejects unknown properties (strict fail-closed schema)", () => {
    const withExtra = { ...validProfile, maliciousScript: "exec('rm -rf')" };
    const result = validateCustomModeProfile(withExtra);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Unknown property")));
  });

  it("rejects unsupported schemaVersion", () => {
    const badVersion = { ...validProfile, schemaVersion: 2 };
    const result = validateCustomModeProfile(badVersion);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("schemaVersion")));
  });

  it("rejects invalid profile id syntax", () => {
    const badId = { ...validProfile, id: "Invalid Profile / Path" };
    const result = validateCustomModeProfile(badId);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Invalid profile id")));
  });

  it("rejects invalid baseMode outside canonical five modes", () => {
    const badBase = { ...validProfile, baseMode: "EXECUTE_ARBITRARY" };
    const result = validateCustomModeProfile(badBase);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Base mode must be one of")));
  });

  it("detects and rejects credential patterns in custom instructions", () => {
    const withSecret = { ...validProfile, customInstructions: "Use this token: sk-abcdef1234567890abcdef1234567890" };
    const result = validateCustomModeProfile(withSecret);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("contain credentials")));
  });

  it("rejects oversized instructions exceeding character budget", () => {
    const huge = { ...validProfile, customInstructions: "a".repeat(8001) };
    const result = validateCustomModeProfile(huge);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("exceed maximum length")));
  });

  it("enforces uniqueness and format in skills and MCP server lists", () => {
    const withDups = { ...validProfile, requiredSkills: ["skill-a", "skill-a"] };
    const result = validateCustomModeProfile(withDups);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Duplicate item")));
  });
});

describe("Custom Modes Engine (Sprint 8D) — Starter Profiles", () => {
  it("provides all canonical starter profiles", () => {
    const starters = getStarterModeProfiles();
    assert.equal(starters.length, 6);
    const ids = starters.map((p) => p.id);
    assert.ok(ids.includes("architecture-review"));
    assert.ok(ids.includes("reverse-engineering-analysis"));
    assert.ok(ids.includes("design-exploration"));
    assert.ok(ids.includes("browser-qa-local-dev"));
    assert.ok(ids.includes("browser-qa-interactive-local-dev"));
    assert.ok(ids.includes("advanced-design-motion"));
  });

  it("all starter profiles pass strict schema validation", () => {
    for (const starter of getStarterModeProfiles()) {
      const result = validateCustomModeProfile(starter);
      assert.equal(result.valid, true, `Profile ${starter.id} failed validation: ${result.errors.join(", ")}`);
    }
  });

  it("architecture-review maps to REVIEW and has zero mutation authority", () => {
    const p = findStarterModeProfile("architecture-review");
    assert.ok(p);
    assert.equal(p.baseMode, "REVIEW");
    assert.ok(p.toolAllowlist?.includes("read_repository"));
    assert.ok(!p.toolAllowlist?.includes("write_file"));
    assert.ok(!p.toolAllowlist?.includes("delete_file"));
  });

  it("reverse-engineering-analysis maps to PLAN with read-only tools", () => {
    const p = findStarterModeProfile("reverse-engineering-analysis");
    assert.ok(p);
    assert.equal(p.baseMode, "PLAN");
    assert.ok(p.toolAllowlist?.includes("search_repository"));
    assert.ok(!p.toolAllowlist?.includes("write_file"));
  });

  it("design-exploration maps to PLAN with read-only tools", () => {
    const p = findStarterModeProfile("design-exploration");
    assert.ok(p);
    assert.equal(p.baseMode, "PLAN");
    assert.ok(p.toolAllowlist?.includes("read_markdown"));
  });
});

describe("Custom Modes Engine (Sprint 8D) — Deterministic Resolution", () => {
  const baseProfile: CustomModeProfile = {
    id: "sec-review",
    name: "Security Review",
    description: "Security analysis mode",
    version: 1,
    schemaVersion: 1,
    source: "workspace",
    baseMode: "REVIEW",
    customInstructions: "Find security vulnerabilities.",
    requiredSkills: ["sec-audit"],
    optionalSkills: ["code-metrics"],
    requiredMcpServers: ["db-inspector"],
    optionalMcpServers: ["git-helper"],
    toolAllowlist: ["read_repository", "search_repository", "read_markdown"],
    preferredModelId: "deepseek-coder",
    workflowPreference: "direct",
    scope: "workspace",
    enabled: true,
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
  };

  const defaultInput: ModeResolverInput = {
    profile: baseProfile,
    workspaceTrusted: true,
    availableSkills: [{ id: "sec-audit" }, { id: "code-metrics" }],
    availableMcpServers: [
      { id: "db-inspector", connected: true, enabled: true },
      { id: "git-helper", connected: true, enabled: true },
    ],
    availableTools: ["read_repository", "search_repository", "read_markdown", "write_file", "delete_file"],
    availableDeployments: ["deepseek-coder", "fallback-7b"],
    globalWorkflowEnabled: true,
  };

  it("resolves fully when all mandatory dependencies are satisfied", () => {
    const resolved = resolveExecutionProfile(defaultInput);
    assert.equal(resolved.isReady, true);
    assert.equal(resolved.profileId, "sec-review");
    assert.equal(resolved.baseMode, "REVIEW");
    assert.deepEqual(resolved.appliedSkills, ["sec-audit", "code-metrics"]);
    assert.deepEqual(resolved.missingRequiredSkills, []);
    assert.deepEqual(resolved.activeMcpServers, ["db-inspector", "git-helper"]);
    assert.equal(resolved.effectiveModelId, "deepseek-coder");
    assert.equal(resolved.effectiveWorkflow, "direct");
    assert.deepEqual(resolved.effectiveTools, ["read_repository", "search_repository", "read_markdown"]);
    assert.ok(Object.isFrozen(resolved));
  });

  it("blocks execution when a required skill is missing", () => {
    const input: ModeResolverInput = {
      ...defaultInput,
      availableSkills: [{ id: "code-metrics" }], // sec-audit missing
    };
    const resolved = resolveExecutionProfile(input);
    assert.equal(resolved.isReady, false);
    assert.ok(resolved.missingRequiredSkills.includes("sec-audit"));
    assert.ok(resolved.diagnostics.some((d) => d.includes('Missing mandatory dependency: required skill "sec-audit"')));
  });

  it("omits missing optional skill with diagnostic and remains ready", () => {
    const input: ModeResolverInput = {
      ...defaultInput,
      availableSkills: [{ id: "sec-audit" }], // code-metrics missing
    };
    const resolved = resolveExecutionProfile(input);
    assert.equal(resolved.isReady, true);
    assert.ok(resolved.missingOptionalSkills.includes("code-metrics"));
    assert.ok(resolved.diagnostics.some((d) => d.includes('Optional skill "code-metrics" is not installed; omitted.')));
    assert.deepEqual(resolved.appliedSkills, ["sec-audit"]);
  });

  it("blocks execution when a required MCP server is disconnected or missing", () => {
    const inputDisconnected: ModeResolverInput = {
      ...defaultInput,
      availableMcpServers: [
        { id: "db-inspector", connected: false, enabled: true },
        { id: "git-helper", connected: true, enabled: true },
      ],
    };
    const resolved = resolveExecutionProfile(inputDisconnected);
    assert.equal(resolved.isReady, false);
    assert.ok(resolved.missingRequiredMcpServers.includes("db-inspector"));
    assert.ok(resolved.diagnostics.some((d) => d.includes('Required MCP server "db-inspector" is disconnected.')));
  });

  it("omits disconnected optional MCP server with diagnostic and remains ready", () => {
    const inputOptionalOff: ModeResolverInput = {
      ...defaultInput,
      availableMcpServers: [
        { id: "db-inspector", connected: true, enabled: true },
        { id: "git-helper", connected: false, enabled: true },
      ],
    };
    const resolved = resolveExecutionProfile(inputOptionalOff);
    assert.equal(resolved.isReady, true);
    assert.ok(resolved.missingOptionalMcpServers.includes("git-helper"));
    assert.deepEqual(resolved.activeMcpServers, ["db-inspector"]);
  });

  it("blocks mutating base mode (BUILD) in an untrusted workspace", () => {
    const buildProfile: CustomModeProfile = {
      ...baseProfile,
      id: "feature-builder",
      baseMode: "BUILD",
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
    };
    const input: ModeResolverInput = {
      ...defaultInput,
      profile: buildProfile,
      workspaceTrusted: false,
    };
    const resolved = resolveExecutionProfile(input);
    assert.equal(resolved.isReady, false);
    assert.ok(resolved.diagnostics.some((d) => d.includes("requires a trusted workspace")));
  });

  it("allows read-only base mode (REVIEW) in an untrusted workspace", () => {
    const input: ModeResolverInput = {
      ...defaultInput,
      workspaceTrusted: false,
    };
    const resolved = resolveExecutionProfile(input);
    assert.equal(resolved.isReady, true);
  });

  it("enforces tool allowlist and prevents permission escalation beyond base mode", () => {
    // Attempting to allowlist write_file in a REVIEW mode profile
    const escalativeProfile: CustomModeProfile = {
      ...baseProfile,
      baseMode: "REVIEW",
      toolAllowlist: ["read_repository", "write_file"],
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
    };
    const input: ModeResolverInput = {
      ...defaultInput,
      profile: escalativeProfile,
    };
    const resolved = resolveExecutionProfile(input);
    // write_file must NOT be in effectiveTools because REVIEW mode forbids it via PermissionGate
    assert.ok(!resolved.effectiveTools.includes("write_file"));
    assert.ok(resolved.effectiveTools.includes("read_repository"));
    assert.ok(resolved.permissionRestrictions.some((p) => p.includes("PermissionGate non-bypass")));
  });

  it("handles unavailable preferred model with deterministic fallback notice", () => {
    const input: ModeResolverInput = {
      ...defaultInput,
      availableDeployments: ["local-qwen-7b"], // deepseek-coder missing
    };
    const resolved = resolveExecutionProfile(input);
    assert.equal(resolved.effectiveModelId, "local-qwen-7b");
    assert.ok(resolved.modelFallbackNotice?.includes("falling back to default deployment"));
  });

  it("downgrades structured workflow to direct if global flag is off", () => {
    const structProfile: CustomModeProfile = {
      ...baseProfile,
      workflowPreference: "structured",
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
    };
    const input: ModeResolverInput = {
      ...defaultInput,
      profile: structProfile,
      globalWorkflowEnabled: false,
    };
    const resolved = resolveExecutionProfile(input);
    assert.equal(resolved.effectiveWorkflow, "direct");
    assert.ok(resolved.diagnostics.some((d) => d.includes("global workflow flag is disabled")));
  });

  it("respects account administrative policy blocking modes or integrations", () => {
    const inputPolicyBlocked: ModeResolverInput = {
      ...defaultInput,
      accountPolicy: {
        allowedModes: ["allowed-other-mode"],
        blockedIntegrations: ["mcp:db-inspector"],
      },
    };
    const resolved = resolveExecutionProfile(inputPolicyBlocked);
    assert.equal(resolved.isReady, false);
    assert.ok(resolved.diagnostics.some((d) => d.includes("restricted by account administration policy")));
  });
});

describe("Custom Modes Engine (Sprint 8D) — Runtime Execution Invariants", () => {
  it("createAgentRuntime fails closed when execution profile is not ready", async () => {
    const unreadyProfile = resolveExecutionProfile({
      profile: {
        id: "broken-mode",
        name: "Broken Mode",
        description: "",
        version: 1,
        schemaVersion: 1,
        source: "workspace",
        baseMode: "REVIEW",
        requiredSkills: ["non-existent-skill"],
        optionalSkills: [],
        requiredMcpServers: [],
        optionalMcpServers: [],
        scope: "workspace",
        enabled: true,
        createdAt: "2026-10-25T00:00:00Z",
        updatedAt: "2026-10-25T00:00:00Z",
      },
      workspaceTrusted: true,
      availableSkills: [],
      availableMcpServers: [],
      availableTools: ["read_repository"],
    });

    assert.equal(unreadyProfile.isReady, false);

    await assert.rejects(
      async () => {
        await createAgentRuntime({
          workspaceRoot: "/tmp",
          mode: "REVIEW",
          instruction: "Run audit",
          eventSink: () => {},
          isTrusted: true,
          resolvedProfile: unreadyProfile,
        });
      },
      (err: any) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Cannot execute custom mode"));
        assert.ok(err.message.includes("execution profile is not ready"));
        return true;
      }
    );
  });
});
