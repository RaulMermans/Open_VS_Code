import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  ReaMcpService,
  ReaServiceError,
} from "../../src/rea/rea-mcp-service.ts";
import { REA_PINNED_VERSION } from "../../src/rea/contracts.ts";

const REA_CLI_CANDIDATE = "/tmp/rea-upstream/scripts/rea.mjs";
const hasUpstreamRea = existsSync(REA_CLI_CANDIDATE);

test("ReaMcpService - handles missing REA executable gracefully", async () => {
  const service = new ReaMcpService({
    reaCliPath: "/path/to/nonexistent/rea.mjs",
  });

  await assert.rejects(
    () => service.connect(),
    (err: any) => {
      assert.ok(err instanceof ReaServiceError);
      assert.equal(err.code, "REA_NOT_INSTALLED");
      return true;
    }
  );
  assert.equal(service.isConnected, false);
});

test("ReaMcpService - queries provider diagnostics without server connection", async () => {
  const service = new ReaMcpService();
  const diagnostics = await service.queryProviderDiagnostics();

  assert.ok(Array.isArray(diagnostics));
  assert.ok(diagnostics.length >= 6);

  // macOS provider check
  const macReport = diagnostics.find((d) => d.id === "native-macos");
  assert.ok(macReport);
  assert.equal(macReport.available, process.platform === "darwin");

  // Heavyweight unconfigured providers
  const ghidraReport = diagnostics.find((d) => d.id === "ghidra");
  assert.ok(ghidraReport);
  assert.equal(ghidraReport.available, false);
  assert.ok(ghidraReport.remediation?.includes("GHIDRA_INSTALL_DIR"));

  const idaReport = diagnostics.find((d) => d.id === "ida");
  assert.ok(idaReport);
  assert.equal(idaReport.available, false);
  assert.ok(idaReport.remediation?.includes("IDADIR"));
});

test(
  "ReaMcpService - connects to real REA MCP server, audits catalog, prompts, and closes",
  { skip: !hasUpstreamRea },
  async () => {
    const service = new ReaMcpService({
      reaCliPath: REA_CLI_CANDIDATE,
      nodeExecutable: "/Users/raulm/.nvm/versions/node/v22.23.2/bin/node",
      requestTimeoutMs: 15000,
    });

    try {
      const identity = await service.connect();
      assert.equal(service.isConnected, true);
      assert.equal(identity.server.version, REA_PINNED_VERSION);
      assert.ok(identity.catalogCounts.mcpTools > 50);
      assert.ok(service.advertisedToolNames.length > 50);

      // Verify essential REA tools are advertised
      assert.ok(service.hasTool("analyze_javascript_application"));
      assert.ok(service.hasTool("inspect_artifact"));

      // Verify guided prompts are discovered
      assert.ok(service.hasPrompt("investigate_feature"));
      assert.ok(service.hasPrompt("compare_application_versions"));
      assert.ok(service.hasPrompt("verify_reconstruction"));

      // Retrieve prompt
      const promptResult = await service.getPrompt("investigate_feature", {
        feature: "UserLogin",
        target_path: "/tmp/fake-target",
      });
      assert.ok(promptResult.messages.length > 0);

      // Query runtime provider diagnostics
      const reports = await service.queryProviderDiagnostics();
      const artifactGraphReport = reports.find((r) => r.id === "rea-artifact-graph");
      assert.ok(artifactGraphReport);
      assert.equal(artifactGraphReport.available, true);
    } finally {
      await service.close();
      assert.equal(service.isConnected, false);
    }
  }
);
