import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReaMcpService } from "../../src/rea/rea-mcp-service.ts";
import {
  type ReconstructionObligationLedger,
  type ReconstructionObligation,
  type ReconstructionSpecification,
  REA_PINNED_VERSION,
} from "../../src/rea/contracts.ts";
import { ReconstructionEngine } from "../../src/rea/reconstruction-engine.ts";

const REA_CLI_CANDIDATE = "/tmp/rea-upstream/scripts/rea.mjs";
const hasUpstreamRea = existsSync(REA_CLI_CANDIDATE);

test(
  "Demo C — Application Version Comparison, Obligation Verification & Residual Unknowns Audit",
  { skip: !hasUpstreamRea },
  async () => {
    const tmpWs = mkdtempSync(join(tmpdir(), "rea-demo-c-"));
    const v1Dir = join(tmpWs, "v1.0.0");
    const v2Dir = join(tmpWs, "v1.1.0");

    try {
      // 1. Setup two distinct application version directories
      writeFileSync(
        join(tmpWs, "package.json"),
        JSON.stringify({ name: "demo-c-workspace", version: "1.0.0" })
      );

      const reaService = new ReaMcpService({
        reaCliPath: REA_CLI_CANDIDATE,
        nodeExecutable: "/Users/raulm/.nvm/versions/node/v22.23.2/bin/node",
        requestTimeoutMs: 30000,
      });

      try {
        const identity = await reaService.connect();
        assert.equal(identity.server.version, REA_PINNED_VERSION);

        // 2. Invoke REA compare_application_versions prompt
        const comparePrompt = await reaService.getPrompt("compare_application_versions", {
          left_target_path: v1Dir,
          right_target_path: v2Dir,
        });
        assert.ok(comparePrompt.messages.length > 0);
        const compareText = comparePrompt.messages.map((m) => m.content.text).join(" ");
        assert.ok(compareText.includes("Compare") || compareText.includes("comparison") || compareText.length > 50);

        // 3. Invoke REA verify_reconstruction prompt
        const verifyPrompt = await reaService.getPrompt("verify_reconstruction", {
          reconstruction_goal: "Verify clean-room TypeScript parity against observed v1.0.0 behaviors",
        });
        assert.ok(verifyPrompt.messages.length > 0);

        // 4. Invoke REA audit_residual_unknowns prompt
        const auditPrompt = await reaService.getPrompt("audit_residual_unknowns", {
          audit_scope: "database_and_server_persistence",
        });
        assert.ok(auditPrompt.messages.length > 0);

        // 5. Test obligation ledger progression and deterministic closure digest calculation
        const obligationsV1: ReconstructionObligation[] = [
          {
            obligationId: "obl_auth_token",
            obligationVersion: 1,
            title: "JWT Token Authentication",
            applicationLayer: "protocol",
            family: "auth.session",
            target: {
              artifactSha256: null,
              applicationNodeId: "node_auth",
              semanticNodeId: null,
              location: "src/auth.ts",
            },
            positiveCases: ["Valid token allows access"],
            negativeCases: ["Expired token rejects"],
            edgeCases: [],
            failureCases: [],
            evidenceLinks: ["ev_auth_1"],
            owner: null,
            status: "characterized",
          },
          {
            obligationId: "obl_cache_invalidation",
            obligationVersion: 1,
            title: "Local Cache Invalidation",
            applicationLayer: "persistence",
            family: "storage.cache",
            target: {
              artifactSha256: null,
              applicationNodeId: "node_cache",
              semanticNodeId: null,
              location: "src/cache.ts",
            },
            positiveCases: ["Cache clears on logout"],
            negativeCases: [],
            edgeCases: [],
            failureCases: [],
            evidenceLinks: ["ev_cache_1"],
            owner: null,
            status: "characterized",
          },
        ];

        const ledgerV1: ReconstructionObligationLedger = {
          schema: "ReconstructionObligationLedger",
          ledgerId: "ledger_version_1_0_0",
          closureDigest: "digest_initial_v1_characterized",
          status: "partial",
          coverage: { status: "partial" },
          summary: {
            total: 2,
            required: 2,
            verified: 0,
            requiredOpen: 2,
            byStatus: [{ key: "characterized", count: 2 }],
            byApplicationLayer: [
              { key: "protocol", count: 1 },
              { key: "persistence", count: 1 },
            ],
          },
          reports: {
            missingOwnerObligationIds: ["obl_auth_token", "obl_cache_invalidation"],
            missingVerifierObligationIds: ["obl_auth_token", "obl_cache_invalidation"],
            contradictedObligationIds: [],
            residualUnknownIds: ["unk_backend_db"],
          },
          obligations: obligationsV1,
          evidenceLinks: ["ev_auth_1", "ev_cache_1"],
          limitations: ["2 obligations unowned and unverified"],
        };

        // Execute ReconstructionEngine with automated test runner to close obligations
        const engine = new ReconstructionEngine({
          workspaceRoot: tmpWs,
          testRunner: async (obl) => {
            return {
              passed: true,
              output: `Automated test passed for ${obl.obligationId}`,
            };
          },
        });

        const mockSpec: ReconstructionSpecification = {
          specificationId: "spec_v1_to_v2",
          target: {
            targetId: "tgt_v1",
            category: "javascript_electron_app",
            rawInput: v1Dir,
            normalizedLocation: v1Dir,
            format: "unpacked_directory",
            authorized: true,
            metadata: {},
          },
          createdAt: Date.now(),
          featureInventory: [],
          pageAndRouteMap: [],
          interactionStateGraph: [],
          visibleBusinessRules: [],
          formAndValidationBehavior: [],
          componentInventory: [],
          observableDataContracts: [],
          responsiveUiRequirements: [],
          errorHandling: [],
          knownConstraints: [],
          evidenceLinks: [],
          unknowns: [
            {
              unknownId: "unk_backend_db",
              area: "database_schema",
              description: "Remote database schema is unobservable via black-box inspection",
              whyUnobservable: "Client only sees local cache and auth tokens",
              riskLevel: "medium",
            },
          ],
          inferredArchitecture: {
            summary: "Modular application with protocol and persistence layers",
            suspectedTechStack: ["TypeScript"],
            stateManagementModel: "Local state",
            dataPersistenceModel: "In-memory cache",
            explicitlyInferred: true,
            supportingEvidenceIds: ["ev_auth_1"],
          },
        };

        const reconResult = await engine.runReconstruction(mockSpec, ledgerV1, {
          userAuthorized: true,
          targetFiles: {
            "src/auth.ts": "export function verifyToken(t: string) { return Boolean(t); }\n",
            "src/cache.ts": "export function clearCache() { return true; }\n",
          },
        });

        // Verify deterministic closure
        assert.equal(reconResult.verifiedObligationsCount, 2);
        assert.equal(reconResult.remainingOpenCount, 0);
        assert.equal(reconResult.updatedLedger.status, "verified");
        assert.equal(reconResult.updatedLedger.coverage.status, "complete");

        // The closure digest must change deterministically to reflect verified obligations
        assert.notEqual(reconResult.updatedLedger.closureDigest, ledgerV1.closureDigest);
        assert.ok(reconResult.updatedLedger.closureDigest.length === 64);

        // Every obligation now has PASS evidence and verified status
        for (const obl of reconResult.updatedLedger.obligations) {
          assert.equal(obl.status, "verified");
          assert.equal(obl.testEvidence?.result, "PASS");
          assert.ok(obl.testEvidence?.digest);
        }
      } finally {
        await reaService.close();
      }
    } finally {
      rmSync(tmpWs, { recursive: true, force: true });
    }
  }
);
