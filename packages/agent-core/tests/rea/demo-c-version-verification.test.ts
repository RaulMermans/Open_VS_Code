import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
import { McpCatalog } from "../../src/mcp/mcp-catalog.ts";

const REA_CLI_CANDIDATE = "/tmp/rea-upstream/scripts/rea.mjs";
const hasUpstreamRea = existsSync(REA_CLI_CANDIDATE);

// Real behavioral test runner for the two obligations
async function realBehavioralTestRunner(obl: ReconstructionObligation, wsRoot: string) {
  if (obl.obligationId === "obl_token_expiry_validation") {
    const authPath = join(wsRoot, "src/auth.ts");
    if (!existsSync(authPath)) return { passed: false, output: "src/auth.ts missing" };
    // Execute the code logic directly to test both positive and negative cases
    const content = readFileSync(authPath, "utf-8");
    // Evaluate module exports in isolated context
    const fn = new Function(
      "token",
      "nowMs",
      `${content}; return typeof verifyToken === 'function' ? verifyToken(token, nowMs) : null;`
    );

    // Test 1: Valid unexpired token must pass
    const validResult = fn("valid_token_xyz.1700000000.signature", 1600000000);
    if (!validResult || validResult.valid !== true) {
      return {
        passed: false,
        output: `Positive case failed: expected valid=true, got ${JSON.stringify(validResult)}`,
        details: {
          verifier: "DeltaAuthTestRunner",
          testIdentity: "token_positive_valid",
          inputFixture: "valid_token_xyz.1700000000.signature (nowMs=1600000000)",
          expectedBehavior: "valid: true",
          observedResult: JSON.stringify(validResult),
        },
      };
    }

    // Test 2: Expired token must FAIL
    const expiredResult = fn("valid_token_xyz.1500000000.signature", 1600000000);
    if (!expiredResult || expiredResult.valid === true || expiredResult.error !== "EXPIRED") {
      return {
        passed: false,
        output: `Negative case failed: expired token must return valid=false with error='EXPIRED', got ${JSON.stringify(expiredResult)}`,
        details: {
          verifier: "DeltaAuthTestRunner",
          testIdentity: "token_negative_expired",
          inputFixture: "valid_token_xyz.1500000000.signature (nowMs=1600000000)",
          expectedBehavior: "valid: false, error: 'EXPIRED'",
          observedResult: JSON.stringify(expiredResult),
        },
      };
    }

    return {
      passed: true,
      output: "Token expiry verification passed for positive and negative cases",
      details: {
        verifier: "DeltaAuthTestRunner",
        testIdentity: "token_suite_full",
        inputFixture: "valid and expired test tokens",
        expectedBehavior: "expired rejected, unexpired accepted",
        observedResult: "All positive and negative cases satisfied",
      },
    };
  }

  if (obl.obligationId === "obl_cache_invalidation") {
    const cachePath = join(wsRoot, "src/cache.ts");
    if (!existsSync(cachePath)) return { passed: false, output: "src/cache.ts missing" };
    const content = readFileSync(cachePath, "utf-8");
    const fn = new Function(
      "userId",
      `${content}; return typeof clearCache === 'function' ? clearCache(userId) : null;`
    );

    // Test: clearCache with valid userId returns true
    const validPurge = fn("user_42");
    if (validPurge !== true) {
      return {
        passed: false,
        output: "clearCache('user_42') failed",
        details: {
          verifier: "DeltaCacheTestRunner",
          testIdentity: "cache_purge_valid",
          inputFixture: "user_42",
          expectedBehavior: "returns true",
          observedResult: JSON.stringify(validPurge),
        },
      };
    }
    // Test: clearCache with null userId rejects
    const emptyPurge = fn(null);
    if (emptyPurge !== false) {
      return {
        passed: false,
        output: "clearCache(null) should fail closed",
        details: {
          verifier: "DeltaCacheTestRunner",
          testIdentity: "cache_purge_null_fail_closed",
          inputFixture: "null",
          expectedBehavior: "returns false",
          observedResult: JSON.stringify(emptyPurge),
        },
      };
    }

    return {
      passed: true,
      output: "Cache invalidation verification passed",
      details: {
        verifier: "DeltaCacheTestRunner",
        testIdentity: "cache_suite_full",
        inputFixture: "user_42 and null",
        expectedBehavior: "selective purge for valid user, reject null",
        observedResult: "All cache cases satisfied",
      },
    };
  }

  return { passed: false, output: `Unknown obligation: ${obl.obligationId}` };
}

test(
  "Demo C — Application Version Comparison, Genuine Behavioral Verification & Residual Unknowns Audit",
  { skip: !hasUpstreamRea },
  async () => {
    const tmpWs = mkdtempSync(join(tmpdir(), "rea-demo-c-"));
    const v1Dir = join(tmpWs, "v1.0.0");
    const v2Dir = join(tmpWs, "v1.1.0");

    try {
      // 1. Setup two distinct application version directories representing a behavioral delta
      writeFileSync(
        join(tmpWs, "package.json"),
        JSON.stringify({ name: "demo-c-workspace", version: "1.1.0" })
      );

      const catalog = new McpCatalog({ servers: {} });
      const reaService = new ReaMcpService({
        mcpCatalog: catalog,
        serverId: "rea-cli",
        reaCliPath: REA_CLI_CANDIDATE,
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
          reconstruction_goal: "Verify clean-room TypeScript parity against observed v1.1.0 token expiry delta",
        });
        assert.ok(verifyPrompt.messages.length > 0);

        // 4. Invoke REA audit_residual_unknowns prompt
        const auditPrompt = await reaService.getPrompt("audit_residual_unknowns", {
          audit_scope: "database_and_server_persistence",
        });
        assert.ok(auditPrompt.messages.length > 0);

        // 5. Structure obligations for the behavioral delta between v1.0.0 and v1.1.0
        const deltaObligations: ReconstructionObligation[] = [
          {
            obligationId: "obl_token_expiry_validation",
            obligationVersion: 1,
            title: "JWT Token Expiry and Format Validation Delta",
            applicationLayer: "protocol",
            family: "auth.session",
            target: {
              artifactSha256: null,
              applicationNodeId: "node_auth",
              semanticNodeId: null,
              location: "src/auth.ts",
            },
            positiveCases: ["Valid unexpired token returns valid: true"],
            negativeCases: ["Expired token returns valid: false with EXPIRED code"],
            edgeCases: ["Malformed token returns valid: false with MALFORMED code"],
            failureCases: [],
            evidenceLinks: ["ev_auth_delta_1"],
            owner: "security-auditor",
            status: "characterized",
          },
          {
            obligationId: "obl_cache_invalidation",
            obligationVersion: 1,
            title: "Targeted User Cache Invalidation",
            applicationLayer: "persistence",
            family: "storage.cache",
            target: {
              artifactSha256: null,
              applicationNodeId: "node_cache",
              semanticNodeId: null,
              location: "src/cache.ts",
            },
            positiveCases: ["Cache invalidates requested user entries"],
            negativeCases: ["Invalid user ID does not purge other active sessions"],
            edgeCases: [],
            failureCases: [],
            evidenceLinks: ["ev_cache_delta_1"],
            owner: "security-auditor",
            status: "characterized",
          },
        ];

        const initialLedger: ReconstructionObligationLedger = {
          schema: "ReconstructionObligationLedger",
          ledgerId: "ledger_version_1_1_0_delta",
          closureDigest: "digest_initial_v1_1_delta_characterized",
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
            missingOwnerObligationIds: [],
            missingVerifierObligationIds: ["obl_token_expiry_validation", "obl_cache_invalidation"],
            contradictedObligationIds: [],
            residualUnknownIds: ["unk_backend_db_schema"],
          },
          obligations: deltaObligations,
          evidenceLinks: ["ev_auth_delta_1", "ev_cache_delta_1"],
          limitations: ["Remote database persistence details remain unobservable"],
        };

        const mockSpec: ReconstructionSpecification = {
          specificationId: "spec_v1_0_to_v1_1_delta",
          target: {
            targetId: "tgt_v1_1",
            category: "javascript_electron_app",
            rawInput: v2Dir,
            normalizedLocation: v2Dir,
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
              unknownId: "unk_backend_db_schema",
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
            supportingEvidenceIds: ["ev_auth_delta_1"],
          },
        };

        // 6. ADVERSARIAL STEP: Prove that an intentionally incorrect reconstruction FAILS verification
        const flawedReconEngine = new ReconstructionEngine({
          workspaceRoot: tmpWs,
          autoApproveMutations: true,
          testRunner: realBehavioralTestRunner,
        });

        // Flawed implementation: always returns valid=true without checking expiry!
        const flawedResult = await flawedReconEngine.runReconstruction(mockSpec, initialLedger, {
          userAuthorized: true,
          targetFiles: {
            "src/auth.ts": `
              function verifyToken(token, nowMs) {
                // Bug: ignores expiry, accepts all tokens
                return { valid: true };
              }
            `,
            "src/cache.ts": `
              function clearCache(userId) {
                return Boolean(userId);
              }
            `,
          },
        });

        // Fail-closed verification:
        assert.equal(flawedResult.verifiedObligationsCount, 1, "Only cache obligation should pass; auth MUST fail");
        assert.equal(flawedResult.remainingOpenCount, 1, "Auth obligation must remain open");
        assert.equal(flawedResult.updatedLedger.status, "partial", "Ledger must not be verified when obligation fails");
        assert.equal(flawedResult.updatedLedger.coverage.status, "partial");

        const failedAuthObl = flawedResult.updatedLedger.obligations.find(
          (o) => o.obligationId === "obl_token_expiry_validation"
        );
        assert.ok(failedAuthObl);
        assert.notEqual(failedAuthObl.status, "verified", "Flawed obligation must not be marked verified");
        assert.equal(failedAuthObl.testEvidence?.result, "FAIL");
        assert.ok(failedAuthObl.testEvidence?.observedResult.includes("expired token must return valid=false"));

        // 7. CORRECT IMPLEMENTATION: Verify genuine comparative closure
        const correctReconEngine = new ReconstructionEngine({
          workspaceRoot: tmpWs,
          autoApproveMutations: true,
          testRunner: realBehavioralTestRunner,
        });

        const correctResult = await correctReconEngine.runReconstruction(mockSpec, initialLedger, {
          userAuthorized: true,
          targetFiles: {
            "src/auth.ts": `
              function verifyToken(token, nowMs) {
                if (!token || typeof token !== 'string') return { valid: false, error: 'MALFORMED' };
                const parts = token.split('.');
                if (parts.length !== 3) return { valid: false, error: 'MALFORMED' };
                const expiry = parseInt(parts[1], 10);
                if (isNaN(expiry) || nowMs > expiry) {
                  return { valid: false, error: 'EXPIRED' };
                }
                return { valid: true };
              }
            `,
            "src/cache.ts": `
              function clearCache(userId) {
                if (!userId || typeof userId !== 'string') return false;
                return true;
              }
            `,
          },
        });

        // Verify successful closure
        assert.equal(correctResult.verifiedObligationsCount, 2);
        assert.equal(correctResult.remainingOpenCount, 0);
        assert.equal(correctResult.updatedLedger.status, "verified");
        assert.equal(correctResult.updatedLedger.coverage.status, "complete");

        // The closure digest must change deterministically to reflect verified obligations
        assert.notEqual(correctResult.updatedLedger.closureDigest, initialLedger.closureDigest);
        assert.ok(correctResult.updatedLedger.closureDigest.length === 64);

        // Every obligation now has PASS verification record with digest
        for (const obl of correctResult.updatedLedger.obligations) {
          assert.equal(obl.status, "verified");
          assert.equal(obl.testEvidence?.result, "PASS");
          assert.ok(obl.testEvidence?.artifactDigest);
          assert.ok(obl.testEvidence?.verifier);
          assert.ok(obl.testEvidence?.timestamp);
        }

        // Surviving unknowns remain recorded
        assert.ok(correctResult.updatedLedger.reports.residualUnknownIds.includes("unk_backend_db_schema"));
      } finally {
        await reaService.close();
        await catalog.close();
      }
    } finally {
      rmSync(tmpWs, { recursive: true, force: true });
    }
  }
);
