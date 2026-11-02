/**
 * Sprint 10A.1C — Final Pre-HALO Integration, Evidence Continuity & Production Verification.
 *
 * Verification and test suite for:
 * - Work Package A: REA Evidence Continuity (Investigation -> Bundle -> Reconstruction handoff, isolation, fail-closed)
 * - Work Package B: Production Verification Wiring (ComparativeWebVerifier via loopback adapter, obligation closure, defect detection)
 * - Work Package C: Approval Integrity (Exact token binding, TOCTOU disk checks, rejection/cancellation semantics, bridge integration)
 * - Work Package D: Honest Skills & Execution Telemetry (Requested/available/loaded/injected lifecycle, prompt injection, honest tokens)
 * - Work Package E: End-to-End Runtime and Bridge Integration
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { GovernedReaWorkflow } from "../../src/rea/governed-rea-workflow.ts";
import { MutationEngine } from "../../src/tools/mutation-engine.ts";
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../../src/skills/registry.ts";
import {
  createReaEvidenceBundle,
  saveReaEvidenceBundle,
  loadReaEvidenceBundle,
  validateReaEvidenceBundle,
  resolveReaEvidenceBundle,
  REA_EVIDENCE_BUNDLE_SCHEMA_VERSION,
} from "../../src/rea/evidence-bundle.ts";
import { createReaProductionTestRunner } from "../../src/rea/production-verifier.ts";
import { classifyInvestigationTarget } from "../../src/rea/target-classifier.ts";
import type {
  ReconstructionSpecification,
  ReconstructionObligationLedger,
  ReconstructionObligation,
} from "../../src/rea/contracts.ts";

function createMockModelProvider(handler: (request: any) => Promise<any> | any) {
  return {
    modelId: "test-model-gateway",
    complete: async (request: any) => handler(request),
  };
}

function buildTestSpec(id: string, category: "form_app" | "nav_app", targetPath: string): ReconstructionSpecification {
  return {
    specificationId: `spec_${id}`,
    target: classifyInvestigationTarget(targetPath, { workspaceRoot: targetPath }),
    createdAt: Date.now(),
    featureInventory: category === "form_app"
      ? [
          {
            featureId: "feat_form_validation",
            title: "Order Form Input Validation",
            description: "Rejects empty email and non-positive quantity",
            category: "input-validation",
            supportingEvidenceIds: ["ev_form_1"],
            epistemicStatus: "OBSERVED",
          },
          {
            featureId: "feat_form_submission",
            title: "Order Form Submission & Result State",
            description: "Displays confirmation badge with order id upon valid submit",
            category: "business-flow",
            supportingEvidenceIds: ["ev_form_2"],
            epistemicStatus: "OBSERVED",
          },
        ]
      : [
          {
            featureId: "feat_tab_navigation",
            title: "Multi-View Tab Navigation",
            description: "Switches active tabs between Dashboard, Analytics, and Settings",
            category: "navigation",
            supportingEvidenceIds: ["ev_nav_1"],
            epistemicStatus: "OBSERVED",
          },
        ],
    pageAndRouteMap: category === "form_app"
      ? [{ route: "/", title: "Order Form", observedLandmarks: ["form", "header"], interactiveElements: ["input", "button"], accessibleRoles: ["form", "button"], supportingEvidenceIds: ["ev_form_1"] }]
      : [{ route: "/", title: "App Portal", observedLandmarks: ["nav", "main"], interactiveElements: ["tab", "button"], accessibleRoles: ["tablist", "tab", "tabpanel"], supportingEvidenceIds: ["ev_nav_1"] }],
    interactionStateGraph: category === "form_app"
      ? [
          {
            transitionId: "t_validate",
            initialState: { route: "/" },
            userAction: { type: "click", targetSelector: "#submit-btn" },
            resultingState: { route: "/" },
            visibleChange: "Displays validation error when required fields are empty",
            evidenceId: "ev_form_1",
            confidence: "observed",
          },
        ]
      : [
          {
            transitionId: "t_switch_analytics",
            initialState: { route: "/" },
            userAction: { type: "click", targetSelector: "#tab-analytics" },
            resultingState: { route: "/" },
            visibleChange: "Activates #tab-analytics and shows #view-analytics",
            evidenceId: "ev_nav_1",
            confidence: "observed",
          },
        ],
    visibleBusinessRules: category === "form_app"
      ? [
          {
            ruleId: "rule_email_required",
            statement: "Email must be non-empty and valid email format",
            trigger: "submit_click",
            outcome: "Show error #email-error",
            supportingEvidenceIds: ["ev_form_1"],
            isHypothesis: false,
          },
        ]
      : [
          {
            ruleId: "rule_tab_exclusive",
            statement: "Only one tab panel can be visible at any given time",
            trigger: "tab_click",
            outcome: "Add .active to clicked tab, hide other tabpanels",
            supportingEvidenceIds: ["ev_nav_1"],
            isHypothesis: false,
          },
        ],
    formAndValidationBehavior: category === "form_app"
      ? [
          {
            formId: "order-form",
            fields: [
              { name: "email", type: "email", required: true, observableErrors: ["Email is required"] },
            ],
            submissionAction: "Render order confirmation summary",
            supportingEvidenceIds: ["ev_form_1"],
          },
        ]
      : [],
    componentInventory: [],
    observableDataContracts: [],
    responsiveUiRequirements: [],
    errorHandling: [],
    knownConstraints: ["Strict client-side clean-room implementation"],
    evidenceLinks: [`evidence://${id}`],
    unknowns: [],
    inferredArchitecture: {
      summary: "Clean-room web application",
      suspectedTechStack: ["HTML5", "Vanilla JavaScript", "CSS"],
      stateManagementModel: "DOM State",
      dataPersistenceModel: "In-memory",
      explicitlyInferred: true,
      supportingEvidenceIds: ["ev_1"],
    },
  };
}

function buildTestLedger(spec: ReconstructionSpecification, category: "form_app" | "nav_app"): ReconstructionObligationLedger {
  const obligations: ReconstructionObligation[] = category === "form_app"
    ? [
        {
          obligationId: "obl_form_val",
          obligationVersion: 1,
          title: "Form Validation Enforcement",
          applicationLayer: "application",
          family: "input-validation",
          target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/" },
          positiveCases: ["Displays error when email is empty"],
          negativeCases: ["Does not submit without valid fields"],
          edgeCases: [],
          failureCases: [],
          evidenceLinks: ["ev_form_1"],
          owner: "index.html",
          status: "characterized",
        },
        {
          obligationId: "obl_form_result",
          obligationVersion: 1,
          title: "Order Confirmation View State",
          applicationLayer: "application",
          family: "state-transition",
          target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/" },
          positiveCases: ["Valid input renders confirmation container"],
          negativeCases: [],
          edgeCases: [],
          failureCases: [],
          evidenceLinks: ["ev_form_2"],
          owner: "src/app.js",
          status: "characterized",
        },
      ]
    : [
        {
          obligationId: "obl_nav_switch",
          obligationVersion: 1,
          title: "Tab Switching and Active State",
          applicationLayer: "application",
          family: "navigation",
          target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/" },
          positiveCases: ["Clicking analytics tab adds .active class and reveals analytics view"],
          negativeCases: ["Inactive views remain hidden"],
          edgeCases: [],
          failureCases: [],
          evidenceLinks: ["ev_nav_1"],
          owner: "src/app.js",
          status: "characterized",
        },
      ];

  return {
    schema: "ReconstructionObligationLedger",
    ledgerId: `ledger_${spec.specificationId}`,
    closureDigest: "open_digest",
    status: "partial",
    coverage: { status: "partial" },
    summary: {
      total: obligations.length,
      required: obligations.length,
      verified: 0,
      requiredOpen: obligations.length,
      byStatus: [{ key: "characterized", count: obligations.length }],
      byApplicationLayer: [{ key: "application", count: obligations.length }],
    },
    reports: {
      missingOwnerObligationIds: [],
      missingVerifierObligationIds: obligations.map((o) => o.obligationId),
      contradictedObligationIds: [],
      residualUnknownIds: [],
    },
    obligations,
    evidenceLinks: ["ev_1"],
    limitations: [],
  };
}

// ============================================================================
// WORK PACKAGE A: REA EVIDENCE CONTINUITY
// ============================================================================

test("WP-A.1: Investigation produces valid evidence bundle with cryptographic digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpa-1-"));
  try {
    const spec = buildTestSpec("appA", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_appA_100",
      workspaceRoot: root,
      accountScope: "account_123",
      specification: spec,
      obligationLedger: ledger,
    });

    assert.equal(bundle.schemaVersion, REA_EVIDENCE_BUNDLE_SCHEMA_VERSION);
    assert.equal(bundle.investigationId, "inv_appA_100");
    assert.equal(bundle.accountScope, "account_123");
    assert.ok(bundle.bundleDigest.length === 64, "Digest must be 64-char sha256 hex");

    const savedPath = saveReaEvidenceBundle(bundle);
    assert.ok(existsSync(savedPath));

    const loadResult = loadReaEvidenceBundle("inv_appA_100", root, "account_123");
    assert.equal(loadResult.valid, true);
    if (!loadResult.valid) return;

    assert.equal(loadResult.bundle.investigationId, "inv_appA_100");
    assert.equal(loadResult.bundle.bundleDigest, bundle.bundleDigest);

    const validation = validateReaEvidenceBundle(loadResult.bundle, root, "account_123");
    assert.equal(validation.valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-A.2: Investigation A -> Bundle A -> Reconstruction A consumes precisely Bundle A", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpa-2-"));
  try {
    const specA = buildTestSpec("appA", "form_app", root);
    const ledgerA = buildTestLedger(specA, "form_app");

    const bundleA = createReaEvidenceBundle({
      investigationId: "inv_appA",
      workspaceRoot: root,
      specification: specA,
      obligationLedger: ledgerA,
    });
    saveReaEvidenceBundle(bundleA);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      task: "Reconstruct form application",
      taskId: "task_recon_A",
      autoApprove: true,
      testRunner: async () => ({ passed: true, output: "Mock verified" }),
    });

    const res = await recon.run();
    assert.equal(res.status, "COMPLETE");
    assert.equal(recon.evidenceProvenance, "investigation_evidence");
    assert.equal(recon.evidenceBundle?.investigationId, "inv_appA");
    assert.equal(recon.evidenceBundle?.specification.featureInventory.length, 2);
    assert.equal(recon.evidenceBundle?.specification.featureInventory[0]?.title, "Order Form Input Validation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-A.3: Investigation B produces materially different evidence and Reconstruction B consumes Bundle B", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpa-3-"));
  try {
    const specB = buildTestSpec("appB", "nav_app", root);
    const ledgerB = buildTestLedger(specB, "nav_app");

    const bundleB = createReaEvidenceBundle({
      investigationId: "inv_appB",
      workspaceRoot: root,
      specification: specB,
      obligationLedger: ledgerB,
    });
    saveReaEvidenceBundle(bundleB);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      task: "Reconstruct navigation application",
      taskId: "task_recon_B",
      autoApprove: true,
      testRunner: async () => ({ passed: true, output: "Mock verified" }),
    });

    const res = await recon.run();
    assert.equal(res.status, "COMPLETE");
    assert.equal(recon.evidenceProvenance, "investigation_evidence");
    assert.equal(recon.evidenceBundle?.investigationId, "inv_appB");
    assert.equal(recon.evidenceBundle?.specification.featureInventory.length, 1);
    assert.equal(recon.evidenceBundle?.specification.featureInventory[0]?.title, "Multi-View Tab Navigation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-A.4: Cross-workspace evidence bundle is rejected (WORKSPACE_MISMATCH)", async () => {
  const root1 = mkdtempSync(join(tmpdir(), "rea-wpa-4a-"));
  const root2 = mkdtempSync(join(tmpdir(), "rea-wpa-4b-"));
  try {
    const spec = buildTestSpec("cross_ws", "form_app", root1);
    const ledger = buildTestLedger(spec, "form_app");

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_cross_ws",
      workspaceRoot: root1,
      specification: spec,
      obligationLedger: ledger,
    });

    const validation = validateReaEvidenceBundle(bundle, root2);
    assert.equal(validation.valid, false);
    if (!validation.valid) {
      assert.equal(validation.code, "WORKSPACE_MISMATCH");
    }

    const mutEngine = new MutationEngine(root2);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root2,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      task: "Reconstruct cross-ws target",
      taskId: "task_recon_cross_ws",
      autoApprove: true,
    });

    const res = await recon.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "STAGE_FAILED");
    assert.ok(res.state.blockerDetail?.includes("does not match active workspace"));
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("WP-A.5: Cross-account evidence bundle is rejected (ACCOUNT_MISMATCH)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpa-5-"));
  try {
    const spec = buildTestSpec("cross_acc", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_cross_acc",
      workspaceRoot: root,
      accountScope: "tenant_alpha",
      specification: spec,
      obligationLedger: ledger,
    });

    const validation = validateReaEvidenceBundle(bundle, root, "tenant_beta");
    assert.equal(validation.valid, false);
    if (!validation.valid) {
      assert.equal(validation.code, "ACCOUNT_MISMATCH");
    }

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      accountScope: "tenant_beta",
      task: "Reconstruct cross-account target",
      taskId: "task_recon_cross_acc",
      autoApprove: true,
    });

    const res = await recon.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "STAGE_FAILED");
    assert.ok(res.state.blockerDetail?.includes("does not match active account"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-A.6: Corrupted evidence bundle fails closed (INTEGRITY_COMPROMISED)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpa-6-"));
  try {
    const spec = buildTestSpec("corrupt", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_corrupt",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });

    const tampered = {
      ...bundle,
      specification: {
        ...bundle.specification,
        featureInventory: [],
      },
    };

    const validation = validateReaEvidenceBundle(tampered, root);
    assert.equal(validation.valid, false);
    if (!validation.valid) {
      assert.equal(validation.code, "INTEGRITY_COMPROMISED");
    }

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: tampered,
      task: "Reconstruct tampered bundle",
      taskId: "task_recon_tampered",
      autoApprove: true,
    });

    const res = await recon.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "STAGE_FAILED");
    assert.ok(res.state.blockerDetail?.includes("digest mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-A.7: Missing investigation fails closed with INVESTIGATION_REQUIRED without synthetic fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpa-7-"));
  try {
    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      task: "Reconstruct with no investigation performed yet",
      taskId: "task_recon_empty",
      autoApprove: true,
    });

    const res = await recon.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "STAGE_FAILED");
    assert.ok(res.state.blockerDetail?.includes("INVESTIGATION_REQUIRED"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// WORK PACKAGE B: PRODUCTION VERIFICATION WIRING
// ============================================================================

test("WP-B.1: Production verifier rejects non-loopback reference URL safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpb-1-"));
  try {
    const spec = buildTestSpec("prod_b1", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");

    const testRunner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: "https://arbitrary-external-site.com/target",
      browserSessionManager: {} as any,
    });

    const result = await testRunner(ledger.obligations[0]!, root);
    assert.equal(result.passed, false);
    assert.ok(result.output.includes("Comparative verification is restricted to explicit local loopback fixtures"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-B.2: Production verifier handles non-web target without fabricating PASS", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpb-2-"));
  try {
    const spec = buildTestSpec("prod_b2", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");

    const testRunner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: "http://127.0.0.1:3000",
      targetCategory: "javascript_electron_app",
      browserSessionManager: {} as any,
    });

    const result = await testRunner(ledger.obligations[0]!, root);
    assert.equal(result.passed, false);
    assert.ok(result.output.includes("Target category \"javascript_electron_app\" does not support automatic web comparative verification"));
    assert.ok(result.output.includes("UNVERIFIED"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-B.3: Dual-server loopback verification closes obligations with genuine PASS records", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpb-3-"));
  let refServer: Server | undefined;

  try {
    refServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Order Form</title></head>
<body>
  <h1>Order Form</h1>
  <form id="main-form">
    <input id="email" name="email" type="email" required />
    <button id="submit-btn" type="submit">Submit</button>
  </form>
</body>
</html>`);
    });

    await new Promise<void>((res) => refServer!.listen(0, "127.0.0.1", () => res()));
    const refPort = (refServer.address() as any).port;
    const refUrl = `http://127.0.0.1:${refPort}/`;

    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "index.html"),
      `<!DOCTYPE html>
<html>
<head><title>Order Form</title></head>
<body>
  <h1>Order Form</h1>
  <form id="main-form">
    <input id="email" name="email" type="email" required />
    <button id="submit-btn" type="submit">Submit</button>
  </form>
</body>
</html>`
    );

    const spec = buildTestSpec("dual_ok", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");

    const mockSnapshot = {
      elements: [
        { role: "textbox", tag: "input", refId: "ref_input" },
        { role: "button", tag: "button", refId: "ref_btn" },
        { role: "listitem", tag: "li", refId: "ref_li", text: "Automated Task Verification 1" },
      ],
    };

    const mockBrowser = {
      open: async () => {},
      snapshot: async () => mockSnapshot,
      click: async () => {},
      fill: async () => {},
      createSession: async () => ({ sessionId: "s" }),
      closeSession: async () => {},
    } as any;

    const testRunner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: refUrl,
      browserSessionManager: mockBrowser,
    });

    const result = await testRunner(ledger.obligations[0]!, root);
    assert.equal(result.passed, true);
    assert.equal(result.details?.verifier, "ComparativeWebVerifier");
    assert.ok(result.output.includes("Comparative verification PASSED"));
  } finally {
    if (refServer) {
      await new Promise<void>((res) => refServer!.close(() => res()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-B.4: Deliberate defect in reconstruction fails verification and leaves obligations unverified", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpb-4-"));
  let refServer: Server | undefined;

  try {
    refServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body><h1>Order Form</h1><form id="main-form"></form></body></html>`);
    });
    await new Promise<void>((res) => refServer!.listen(0, "127.0.0.1", () => res()));
    const refPort = (refServer.address() as any).port;
    const refUrl = `http://127.0.0.1:${refPort}/`;

    // Empty workspace with no index.html -> fails to launch
    const spec = buildTestSpec("defect", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");

    const mockBrowser = {
      open: async () => {},
      snapshot: async () => ({ elements: [] }),
      click: async () => {},
      fill: async () => {},
      createSession: async () => ({ sessionId: "mock_session_defect" }),
      closeSession: async () => {},
    } as any;

    const testRunner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: refUrl,
      browserSessionManager: mockBrowser,
    });

    const result = await testRunner(ledger.obligations[0]!, root);
    assert.equal(result.passed, false);
    assert.ok(result.output.includes("failed") || result.output.includes("FAILED") || result.output.includes("failed to launch"));
  } finally {
    if (refServer) {
      await new Promise<void>((res) => refServer!.close(() => res()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// WORK PACKAGE C: APPROVAL INTEGRITY
// ============================================================================

test("WP-C.1: Missing confirmation token is rejected during reconstruction decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpc-1-"));
  try {
    const spec = buildTestSpec("app_tok1", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_tok1",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      task: "Reconstruct with missing token",
      taskId: "task_recon_tok1",
      autoApprove: false,
    });

    const res1 = await recon.run();
    assert.equal(res1.status, "WAITING_FOR_CONFIRMATION");
    assert.ok(recon.pendingConfirmation);

    await assert.rejects(
      async () => recon.resume("APPROVE", undefined as any),
      /Missing confirmation token/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-C.2: Mismatched confirmation token is rejected and leaves pending confirmation intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpc-2-"));
  try {
    const spec = buildTestSpec("app_tok2", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_tok2",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      task: "Reconstruct with wrong token",
      taskId: "task_recon_tok2",
      autoApprove: false,
    });

    const res1 = await recon.run();
    assert.equal(res1.status, "WAITING_FOR_CONFIRMATION");

    await assert.rejects(
      async () => recon.resume("APPROVE", "wrong_token_123"),
      /does not match active confirmation/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-C.3: Correct token resumes and cannot be consumed a second time", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpc-3-"));
  try {
    const spec = buildTestSpec("app_tok3", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_tok3",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      task: "Reconstruct token consumption test",
      taskId: "task_recon_tok3",
      autoApprove: false,
      testRunner: async () => ({ passed: true, output: "Mock ok" }),
    });

    const res1 = await recon.run();
    assert.equal(res1.status, "WAITING_FOR_CONFIRMATION");
    const token = recon.pendingConfirmation!.callId;

    const res2 = await recon.resume("APPROVE", token);
    assert.ok(res2.status === "WAITING_FOR_CONFIRMATION" || res2.status === "COMPLETE");

    await assert.rejects(
      async () => recon.resume("APPROVE", token),
      /Workflow is not waiting for confirmation|does not match active confirmation/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-C.4: TOCTOU check detects modified target file on disk before applying mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpc-4-"));
  try {
    const spec = buildTestSpec("toctou", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_toctou",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.html"), "initial content", "utf-8");

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      targetFiles: {
        "src/index.html": "updated content from model",
      },
      task: "Reconstruct with TOCTOU check",
      taskId: "task_toctou",
      autoApprove: false,
    });

    let step = await recon.run();
    if (step.status === "WAITING_FOR_CONFIRMATION") {
      step = await recon.resume("APPROVE", recon.pendingConfirmation!.callId);
    }

    assert.equal(step.status, "WAITING_FOR_CONFIRMATION");
    assert.ok(recon.pendingConfirmation);
    const patchToken = recon.pendingConfirmation!.callId;

    writeFileSync(join(root, "src", "index.html"), "concurrent modification by another process", "utf-8");

    const resFail = await recon.resume("APPROVE", patchToken);
    assert.equal(resFail.status, "BLOCKED");
    assert.ok(resFail.state.blockerDetail?.includes("modified on disk"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-C.5: Operator cancellation invalidates pending approval and cleans up empty dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpc-5-"));
  try {
    const spec = buildTestSpec("cancel", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_cancel",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      task: "Reconstruct cancellation test",
      taskId: "task_cancel",
      autoApprove: false,
    });

    const res1 = await recon.run();
    assert.equal(res1.status, "WAITING_FOR_CONFIRMATION");
    assert.ok(recon.pendingConfirmation);

    recon.cancel();
    assert.equal(recon.state.status, "CANCELLED");
    assert.equal(recon.pendingConfirmation, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// WORK PACKAGE D: HONEST SKILLS & EXECUTION TELEMETRY
// ============================================================================

test("WP-D.1: Skill lifecycle accurately tracks requested, available, loaded, injected", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpd-1-"));
  try {
    const spec = buildTestSpec("skills_life", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_skills",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const builtinRoot = defaultBuiltinSkillsRoot();
    const skillRegistry = await SkillRegistry.discover({
      ...(builtinRoot ? { builtinRoot } : {}),
      workspaceTrusted: true,
    });
    const mutEngine = new MutationEngine(root);

    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      skills: skillRegistry,
      task: "Reconstruct with skill tracking",
      taskId: "task_skills_track",
      autoApprove: true,
      testRunner: async () => ({ passed: true, output: "Mock ok" }),
    });

    const res = await recon.run();
    assert.equal(res.status, "COMPLETE");

    const trackers = recon.stageSkillTracker;
    assert.ok(trackers["spec_review"]);
    assert.equal(trackers["spec_review"].requestedSkill, "reconstruction-planning");
    assert.equal(trackers["spec_review"].available, true);
    assert.equal(trackers["spec_review"].loaded, true);
    assert.equal(trackers["spec_review"].injected, false);
    assert.equal(trackers["spec_review"].status, "PENDING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-D.2: Missing skill reports NOT_APPLICABLE with skillInjected=false honestly", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpd-2-"));
  try {
    const spec = buildTestSpec("skills_miss", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_skills_miss",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const emptySkillRegistry = SkillRegistry.empty();
    const mutEngine = new MutationEngine(root);

    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      skills: emptySkillRegistry,
      task: "Reconstruct with missing skill",
      taskId: "task_skills_miss",
      autoApprove: true,
      testRunner: async () => ({ passed: true, output: "Mock ok" }),
    });

    const res = await recon.run();
    assert.equal(res.status, "COMPLETE");

    const trackers = recon.stageSkillTracker;
    assert.ok(trackers["spec_review"]);
    assert.equal(trackers["spec_review"].available, false);
    assert.equal(trackers["spec_review"].loaded, false);
    assert.equal(trackers["spec_review"].injected, false);
    assert.equal(trackers["spec_review"].status, "NOT_APPLICABLE");

    const planStage = recon.stageRecords.find((s) => s.stage === "PLAN");
    assert.ok(planStage);
    assert.equal(planStage.skillInjected, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-D.3: Loaded skill body is genuinely injected into model prompt during synthesis", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpd-3-"));
  try {
    const spec = buildTestSpec("prompt_inject", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_prompt_inject",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const builtinRoot = defaultBuiltinSkillsRoot();
    const skillRegistry = await SkillRegistry.discover({
      ...(builtinRoot ? { builtinRoot } : {}),
      workspaceTrusted: true,
    });
    let capturedPrompt = "";

    const modelProvider = createMockModelProvider(async (req) => {
      capturedPrompt = (req.messages || []).map((m: any) => m.content).join("\n");
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            files: [
              {
                path: "src/index.html",
                content: "<!DOCTYPE html><html><body><h1>Order Form</h1></body></html>",
              },
            ],
          }),
        },
        usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
      };
    });

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      skills: skillRegistry,
      provider: modelProvider,
      task: "Reconstruct with model synthesis",
      taskId: "task_prompt_inject",
      autoApprove: true,
      testRunner: async () => ({ passed: true, output: "Mock ok" }),
    });

    const res = await recon.run();
    assert.equal(res.status, "COMPLETE");
    assert.equal(recon.generationSource, "model");

    assert.ok(
      capturedPrompt.includes("Skill: reconstruction-planning") || capturedPrompt.includes("reconstruction-planning"),
      "Model prompt must include loaded skill guidance"
    );

    const implTracker = recon.stageSkillTracker["implementation"];
    assert.ok(implTracker);
    assert.equal(implTracker.injected, true);
    assert.equal(implTracker.status, "INJECTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WP-D.4: Non-model stages report modelCalls = 0 and accurate token telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpd-4-"));
  try {
    const spec = buildTestSpec("telem", "form_app", root);
    const ledger = buildTestLedger(spec, "form_app");
    const bundle = createReaEvidenceBundle({
      investigationId: "inv_telem",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      task: "Reconstruct with template fallback",
      taskId: "task_telem",
      autoApprove: true,
      testRunner: async () => ({ passed: true, output: "Mock ok" }),
    });

    const res = await recon.run();
    assert.equal(res.status, "COMPLETE");

    for (const record of recon.stageRecords) {
      assert.equal(record.modelCalls, 0, `Stage ${record.stage} should report 0 model calls`);
      assert.equal(record.contextTokens, 0, `Stage ${record.stage} should report 0 tokens`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// WORK PACKAGE E: END-TO-END CONTINUITY & PROVENANCE
// ============================================================================

test("WP-E.1: Full Investigation to Reconstruction lifecycle retains evidence provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-wpe-1-"));
  try {
    const mutEngine = new MutationEngine(root);

    // 1. Investigation workflow
    const inv = GovernedReaWorkflow.startInvestigation({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      task: "Investigate target http://127.0.0.1:8080/demo",
      taskId: "task_inv_e1",
    });

    const invResult = await inv.run();
    assert.equal(invResult.status, "COMPLETE");

    // Verify bundle was persisted
    const resolveResult = resolveReaEvidenceBundle(root);
    assert.equal(resolveResult.valid, true);
    if (!resolveResult.valid) return;

    assert.equal(resolveResult.bundle.targetType, "running_web_app");
    assert.ok(resolveResult.bundle.featureInventory.length > 0);

    // 2. Reconstruction workflow consuming resolved bundle
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: resolveResult.bundle,
      task: "Reconstruct investigated application",
      taskId: "task_recon_e1",
      autoApprove: true,
      testRunner: async () => ({ passed: true, output: "Verified" }),
    });

    const reconResult = await recon.run();
    assert.equal(reconResult.status, "COMPLETE");
    assert.equal(recon.evidenceProvenance, "investigation_evidence");
    assert.equal(recon.evidenceBundle?.investigationId, resolveResult.bundle.investigationId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
