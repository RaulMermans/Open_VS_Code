import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ReconstructionEngine,
  ReconstructionAuthorizationError,
} from "../../src/rea/reconstruction-engine.ts";
import type {
  ReconstructionSpecification,
  ReconstructionObligationLedger,
  ReconstructionStageId,
} from "../../src/rea/contracts.ts";

function createMockSpecAndLedger(): {
  specification: ReconstructionSpecification;
  initialLedger: ReconstructionObligationLedger;
} {
  const specification: ReconstructionSpecification = {
    specificationId: "spec_mock_123",
    target: {
      targetId: "tgt_mock_123",
      category: "running_web_app",
      rawInput: "http://localhost:3000",
      normalizedLocation: "http://localhost:3000",
      format: "http_endpoint",
      authorized: true,
      metadata: {},
    },
    createdAt: Date.now(),
    featureInventory: [
      {
        featureId: "feat_counter",
        title: "Reactive Counter",
        description: "Increments count on click",
        category: "interactive",
        supportingEvidenceIds: ["ev_1"],
        epistemicStatus: "OBSERVED",
      },
    ],
    pageAndRouteMap: [
      {
        route: "/",
        observedLandmarks: ["main"],
        interactiveElements: ["button"],
        accessibleRoles: ["button"],
        supportingEvidenceIds: ["ev_1"],
      },
    ],
    interactionStateGraph: [],
    visibleBusinessRules: [
      {
        ruleId: "rule_1",
        statement: "Clicking button increments value by 1",
        trigger: "click",
        outcome: "count + 1",
        supportingEvidenceIds: ["ev_1"],
        isHypothesis: false,
      },
    ],
    formAndValidationBehavior: [],
    componentInventory: [],
    observableDataContracts: [],
    responsiveUiRequirements: [],
    errorHandling: [],
    knownConstraints: ["Offline first"],
    evidenceLinks: ["ev_1"],
    unknowns: [],
    inferredArchitecture: {
      summary: "Client-side SPA",
      suspectedTechStack: ["TypeScript"],
      stateManagementModel: "Reactive",
      dataPersistenceModel: "In-memory",
      explicitlyInferred: true,
      supportingEvidenceIds: ["ev_1"],
    },
  };

  const initialLedger: ReconstructionObligationLedger = {
    schema: "ReconstructionObligationLedger",
    ledgerId: "ledger_mock_123",
    closureDigest: "sha256_mock_initial_closure",
    status: "partial",
    coverage: { status: "partial" },
    summary: {
      total: 2,
      required: 2,
      verified: 0,
      requiredOpen: 2,
      byStatus: [{ key: "characterized", count: 2 }],
      byApplicationLayer: [{ key: "application", count: 2 }],
    },
    reports: {
      missingOwnerObligationIds: [],
      missingVerifierObligationIds: [],
      contradictedObligationIds: [],
      residualUnknownIds: [],
    },
    obligations: [
      {
        obligationId: "obl_feat_counter",
        obligationVersion: 1,
        title: "Reconstruct Reactive Counter",
        applicationLayer: "application",
        family: "ui.feature",
        target: {
          artifactSha256: null,
          applicationNodeId: "feat_counter",
          semanticNodeId: null,
          location: "/",
        },
        positiveCases: ["Counter increments on click"],
        negativeCases: [],
        edgeCases: [],
        failureCases: [],
        evidenceLinks: ["ev_1"],
        owner: null,
        status: "characterized",
      },
      {
        obligationId: "obl_rule_counter_increment",
        obligationVersion: 1,
        title: "Reconstruct Business Rule: Increment",
        applicationLayer: "application",
        family: "behavior.rule",
        target: {
          artifactSha256: null,
          applicationNodeId: "rule_1",
          semanticNodeId: null,
          location: "/",
        },
        positiveCases: ["Clicking button increments count"],
        negativeCases: [],
        edgeCases: [],
        failureCases: [],
        evidenceLinks: ["ev_1"],
        owner: null,
        status: "characterized",
      },
    ],
    evidenceLinks: ["ev_1"],
    limitations: [],
  };

  return { specification, initialLedger };
}

test("ReconstructionEngine - fails closed if human authorization is not granted", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "rea-recon-unauth-"));

  try {
    const engine = new ReconstructionEngine({ workspaceRoot: testDir });
    const { specification, initialLedger } = createMockSpecAndLedger();

    await assert.rejects(
      () =>
        engine.runReconstruction(specification, initialLedger, {
          userAuthorized: false,
          targetFiles: {
            "src/counter.ts": "export function increment(n: number) { return n + 1; }",
          },
        }),
      (err: any) => {
        assert.ok(err instanceof ReconstructionAuthorizationError);
        assert.equal(err.code, "RECONSTRUCTION_UNAUTHORIZED");
        return true;
      }
    );

    // Verify no files were created
    assert.equal(existsSync(join(testDir, "src", "counter.ts")), false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("ReconstructionEngine - executes governed reconstruction, writes files, verifies obligations, and computes closure digest", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "rea-recon-exec-"));

  try {
    const stagesObserved: { stage: ReconstructionStageId; status: string }[] = [];
    let testsExecuted = 0;

    const engine = new ReconstructionEngine({
      workspaceRoot: testDir,
      onStageChange: (e) => {
        stagesObserved.push({ stage: e.stage, status: e.status });
      },
      testRunner: async (obligation) => {
        testsExecuted++;
        // Both obligations pass
        return {
          passed: true,
          output: `Test passed for obligation: ${obligation.title}`,
        };
      },
    });

    const { specification, initialLedger } = createMockSpecAndLedger();

    const result = await engine.runReconstruction(specification, initialLedger, {
      userAuthorized: true,
      targetFiles: {
        "src/counter.ts": "export function increment(n: number) { return n + 1; }\n",
        "tests/counter.test.ts": "import { increment } from '../src/counter.ts';\nassert.equal(increment(0), 1);\n",
      },
    });

    // 1. Verify stage emissions
    assert.ok(stagesObserved.some((s) => s.stage === "spec_review" && s.status === "COMPLETED"));
    assert.ok(stagesObserved.some((s) => s.stage === "implementation" && s.status === "COMPLETED"));
    assert.ok(stagesObserved.some((s) => s.stage === "local_execution" && s.status === "COMPLETED"));
    assert.ok(stagesObserved.some((s) => s.stage === "closure_reporting" && s.status === "COMPLETED"));

    // 2. Verify files were written cleanly
    const writtenFile = join(testDir, "src", "counter.ts");
    assert.equal(existsSync(writtenFile), true);
    assert.ok(readFileSync(writtenFile, "utf-8").includes("export function increment"));

    // 3. Verify tests were executed
    assert.equal(testsExecuted, 2);

    // 4. Verify obligation closure and ledger updates
    assert.equal(result.verifiedObligationsCount, 2);
    assert.equal(result.remainingOpenCount, 0);
    assert.equal(result.updatedLedger.status, "verified");
    assert.equal(result.updatedLedger.coverage.status, "complete");
    assert.notEqual(result.updatedLedger.closureDigest, initialLedger.closureDigest);

    for (const obl of result.updatedLedger.obligations) {
      assert.equal(obl.status, "verified");
      assert.ok(obl.testEvidence);
      assert.equal(obl.testEvidence.result, "PASS");
      assert.ok(obl.testEvidence.digest);
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
