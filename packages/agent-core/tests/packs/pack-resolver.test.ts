import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  resolveCapabilityPack,
  computeManifestDigest,
  REPOSITORY_ARCHITECTURE_REVIEW_PACK,
  MCP_RESEARCH_DEMO_PACK,
  type CapabilityPackManifest,
  type InstalledCapabilityPack,
} from "../../src/packs/index.ts";

function createValidTestPack(overrides: Partial<CapabilityPackManifest>): CapabilityPackManifest {
  const base = {
    ...REPOSITORY_ARCHITECTURE_REVIEW_PACK,
    ...overrides,
  };
  const { integrity: _, ...rest } = base;
  const digest = computeManifestDigest(rest);
  return {
    ...rest,
    integrity: {
      algorithm: "sha256",
      digest,
    },
  };
}

describe("Capability Pack Deterministic Resolution (Sprint 8E)", () => {
  const baseSnapshot = {
    workspaceTrusted: true,
    availableSkills: [{ id: "security-review", name: "Security Review" }],
    availableMcpServers: [{ id: "fixture_server", connected: true, enabled: true }],
    availableTools: [
      { name: "read_file", action: "read_repository" },
      { name: "list_directory", action: "read_repository" },
      { name: "search_text", action: "search_repository" },
      { name: "find_files", action: "search_repository" },
      { name: "echo", action: "mcp_external_read" },
    ],
    availableDeployments: ["qwen-2.5-coder-7b"],
    globalWorkflowEnabled: true,
    globalSkillsEnabled: true,
    currentOpenVsCodeVersion: "0.1.0",
  };

  it("1. resolves Repository Architecture Review Pack as READY when dependencies are satisfied", () => {
    const res = resolveCapabilityPack({
      pack: REPOSITORY_ARCHITECTURE_REVIEW_PACK,
      ...baseSnapshot,
    });

    assert.strictEqual(res.status, "READY");
    assert.strictEqual(res.isReady, true);
    assert.strictEqual(res.packId, "repo-architecture-review");
    assert.strictEqual(res.missingSkills.length, 0);
    assert.strictEqual(res.missingMcpServers.length, 0);
    assert.ok(res.modeReadiness);
    assert.strictEqual(res.modeReadiness.baseMode, "REVIEW");
    assert.deepStrictEqual(res.modeReadiness.effectiveTools, [
      "read_file",
      "list_directory",
      "search_text",
      "find_files",
    ]);
  });

  it("2. resolves MCP Research Demo Pack as READY when fixture_server is connected", () => {
    const res = resolveCapabilityPack({
      pack: MCP_RESEARCH_DEMO_PACK,
      ...baseSnapshot,
    });

    assert.strictEqual(res.status, "READY");
    assert.strictEqual(res.isReady, true);
    assert.strictEqual(res.missingMcpServers.length, 0);
    assert.ok(res.modeReadiness);
    assert.strictEqual(res.modeReadiness.baseMode, "PLAN");
    assert.ok(res.modeReadiness.effectiveTools.includes("echo"));
  });

  it("3. returns INSTALLED_INACTIVE when pack is installed but disabled", () => {
    const installedPack: InstalledCapabilityPack = {
      packId: REPOSITORY_ARCHITECTURE_REVIEW_PACK.id,
      manifest: REPOSITORY_ARCHITECTURE_REVIEW_PACK,
      scope: "workspace",
      enabled: false,
      installedAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
      installedVersion: "1.0.0",
    };

    const res = resolveCapabilityPack({
      pack: installedPack,
      ...baseSnapshot,
    });

    assert.strictEqual(res.status, "INSTALLED_INACTIVE");
    assert.strictEqual(res.isReady, false);
  });

  it("4. returns MISSING_DEPENDENCIES when required skill is not installed", () => {
    const res = resolveCapabilityPack({
      pack: REPOSITORY_ARCHITECTURE_REVIEW_PACK,
      ...baseSnapshot,
      availableSkills: [], // security-review is missing
    });

    assert.strictEqual(res.status, "MISSING_DEPENDENCIES");
    assert.strictEqual(res.isReady, false);
    assert.deepStrictEqual(res.missingSkills, ["security-review"]);
    assert.ok(res.diagnostics.some((d) => d.includes("Missing mandatory skill")));
  });

  it("5. returns MISSING_DEPENDENCIES when required MCP server is not registered", () => {
    const res = resolveCapabilityPack({
      pack: MCP_RESEARCH_DEMO_PACK,
      ...baseSnapshot,
      availableMcpServers: [], // fixture_server is missing
    });

    assert.strictEqual(res.status, "MISSING_DEPENDENCIES");
    assert.strictEqual(res.isReady, false);
    assert.deepStrictEqual(res.missingMcpServers, ["fixture_server"]);
    assert.ok(res.diagnostics.some((d) => d.includes("Missing mandatory MCP dependency")));
  });

  it("6. returns MISSING_DEPENDENCIES when required MCP server is disconnected", () => {
    const res = resolveCapabilityPack({
      pack: MCP_RESEARCH_DEMO_PACK,
      ...baseSnapshot,
      availableMcpServers: [{ id: "fixture_server", connected: false, enabled: true }],
    });

    assert.strictEqual(res.status, "MISSING_DEPENDENCIES");
    assert.strictEqual(res.isReady, false);
    assert.deepStrictEqual(res.missingMcpServers, ["fixture_server"]);
    assert.ok(res.diagnostics.some((d) => d.includes("disconnected")));
  });

  it("7. returns INCOMPATIBLE when Open VS Code version requirement is not satisfied", () => {
    const incompatibleManifest = createValidTestPack({
      openVsCodeVersion: "^0.2.0",
    });

    const res = resolveCapabilityPack({
      pack: incompatibleManifest,
      ...baseSnapshot,
      currentOpenVsCodeVersion: "0.1.0",
    });

    assert.strictEqual(res.status, "INCOMPATIBLE");
    assert.strictEqual(res.isReady, false);
    assert.ok(res.diagnostics.some((d) => d.includes("requires Open VS Code version")));
  });

  it("8. returns BLOCKED_BY_POLICY when pack is restricted by account administration", () => {
    const res = resolveCapabilityPack({
      pack: REPOSITORY_ARCHITECTURE_REVIEW_PACK,
      ...baseSnapshot,
      accountPolicy: {
        blockedIntegrations: ["pack:repo-architecture-review"],
      },
    });

    assert.strictEqual(res.status, "BLOCKED_BY_POLICY");
    assert.strictEqual(res.isReady, false);
    assert.ok(res.blockedPolicies.length > 0);
  });

  it("9. returns UNTRUSTED when pack uses mutating base mode in untrusted workspace", () => {
    const mutatingPack = createValidTestPack({
      id: "mutating-pack",
      customMode: {
        ...REPOSITORY_ARCHITECTURE_REVIEW_PACK.customMode,
        baseMode: "BUILD" as const,
      },
    });

    const res = resolveCapabilityPack({
      pack: mutatingPack,
      ...baseSnapshot,
      workspaceTrusted: false, // Untrusted workspace
    });

    assert.strictEqual(res.status, "UNTRUSTED");
    assert.strictEqual(res.isReady, false);
    assert.ok(res.diagnostics.some((d) => d.includes("requires a trusted workspace")));
  });

  it("10. returns INVALID when manifest fails schema validation", () => {
    const invalidManifest = {
      ...REPOSITORY_ARCHITECTURE_REVIEW_PACK,
      schemaVersion: 99 as any,
    };

    const res = resolveCapabilityPack({
      pack: invalidManifest,
      ...baseSnapshot,
    });

    assert.strictEqual(res.status, "INVALID");
    assert.strictEqual(res.isReady, false);
  });

  it("11. rejects malformed version requirements instead of treating them as compatible", () => {
    const malformedVersions = ["not-semver", "abc.def", "^invalid", ">=foo", "1.0"];
    for (const badVer of malformedVersions) {
      const packWithBadVer = createValidTestPack({
        openVsCodeVersion: badVer,
      });

      const res = resolveCapabilityPack({
        pack: packWithBadVer,
        ...baseSnapshot,
        currentOpenVsCodeVersion: "0.1.0",
      });

      assert.strictEqual(
        res.status,
        "INCOMPATIBLE",
        `Expected malformed version "${badVer}" to resolve to INCOMPATIBLE, got ${res.status}`
      );
      assert.strictEqual(res.isReady, false);
    }
  });

  it("12. unmet model deployment requirement prevents READY and returns INCOMPATIBLE", () => {
    const packWithModel = createValidTestPack({
      preferredModel: {
        deploymentId: "claude-3-5-sonnet",
        family: "claude",
      },
    });

    const res = resolveCapabilityPack({
      pack: packWithModel,
      ...baseSnapshot,
      availableDeployments: ["qwen-2.5-coder-7b"], // claude-3-5-sonnet is missing
    });

    assert.strictEqual(res.status, "INCOMPATIBLE");
    assert.strictEqual(res.isReady, false);
    assert.ok(res.unmetModelRequirements.includes("claude-3-5-sonnet"));
  });

  it("13. unmet model capability requirement prevents READY and returns INCOMPATIBLE", () => {
    const packWithCap = createValidTestPack({
      preferredModel: {
        capabilities: ["vision", "code_review"],
      },
    });

    const res = resolveCapabilityPack({
      pack: packWithCap,
      ...baseSnapshot,
      availableModelCapabilities: ["chat", "code_review"], // vision is missing
    });

    assert.strictEqual(res.status, "INCOMPATIBLE");
    assert.strictEqual(res.isReady, false);
    assert.ok(res.unmetModelRequirements.includes("capability:vision"));
  });

  it("14. disabled global skills flag causes required skill pack to resolve to MISSING_DEPENDENCIES", () => {
    const res = resolveCapabilityPack({
      pack: REPOSITORY_ARCHITECTURE_REVIEW_PACK,
      ...baseSnapshot,
      globalSkillsEnabled: false,
    });

    assert.strictEqual(res.status, "MISSING_DEPENDENCIES");
    assert.strictEqual(res.isReady, false);
    assert.deepStrictEqual(res.missingSkills, ["security-review"]);
  });
});
