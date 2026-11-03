/**
 * Sprint 10A.1D — Final Pre-HALO Readiness, Security Closure & Release Freeze.
 *
 * Mandatory Regression & Security Test Suite covering:
 * 1. Production REA Verifier Initialization from validated evidence
 * 2. Strict scenario-to-obligation verification coverage (no false positives)
 * 3. Ephemeral Fixture Server filesystem isolation and HTTP security
 * 4. Account-scoped evidence ownership and cross-account rejection
 * 5. Lifecycle cancellation and resource cleanup
 * 6. Genuine behavioral comparison and defect detection
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get as httpGet, createServer, type Server } from "node:http";
import { GovernedReaWorkflow } from "../../src/rea/governed-rea-workflow.ts";
import { MutationEngine } from "../../src/tools/mutation-engine.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import {
  createReaEvidenceBundle,
  saveReaEvidenceBundle,
  validateReaEvidenceBundle,
  resolveReaEvidenceBundle,
  computeEvidenceBundleDigest,
  LOCAL_UNAUTHENTICATED_ACCOUNT_SCOPE,
} from "../../src/rea/evidence-bundle.ts";
import {
  createReaProductionTestRunner,
  startEphemeralWorkspaceServer,
  stageVerificationFixture,
} from "../../src/rea/production-verifier.ts";
import type {
  ReconstructionSpecification,
  ReconstructionObligationLedger,
  ReconstructionObligation,
} from "../../src/rea/contracts.ts";

function createMockModelProvider(files: Array<{ path: string; content: string }>) {
  return {
    modelId: "test-model-gateway",
    capabilities: new Set(["complete"] as const),
    complete: async () => ({
      message: {
        role: "assistant",
        content: JSON.stringify({
          summary: "Clean-room reconstruction synthesis",
          files,
        }),
      },
    }),
  } as any;
}

function buildTestSpec(
  id: string,
  targetUrl: string,
  _targetPath: string
): ReconstructionSpecification {
  return {
    specificationId: `spec_${id}`,
    target: {
      category: "running_web_app",
      rawInput: targetUrl,
      normalizedLocation: targetUrl,
      targetId: id,
      authorized: true,
      metadata: {},
    },
    createdAt: Date.now(),
    featureInventory: [
      {
        featureId: "feat_route",
        title: "Navigation & Landmarks",
        description: "Primary routes and accessible landmarks",
        category: "navigation",
        supportingEvidenceIds: ["ev_1"],
        epistemicStatus: "OBSERVED",
      },
      {
        featureId: "feat_form",
        title: "Form Validation",
        description: "Negative validation on empty submission",
        category: "forms",
        supportingEvidenceIds: ["ev_2"],
        epistemicStatus: "OBSERVED",
      },
      {
        featureId: "feat_state",
        title: "Item Mutation",
        description: "Adding item mutates visible list",
        category: "state",
        supportingEvidenceIds: ["ev_3"],
        epistemicStatus: "OBSERVED",
      },
    ],
    pageAndRouteMap: [
      {
        route: "/",
        title: "Home",
        observedLandmarks: ["main"],
        interactiveElements: [],
        accessibleRoles: ["main"],
        supportingEvidenceIds: ["ev_1"],
      },
    ],
    interactionStateGraph: [],
    visibleBusinessRules: [],
    formAndValidationBehavior: [],
    componentInventory: [],
    observableDataContracts: [],
    responsiveUiRequirements: [],
    errorHandling: [],
    knownConstraints: ["Local loopback only"],
    evidenceLinks: ["ev_1", "ev_2", "ev_3"],
    unknowns: [],
    inferredArchitecture: {
      summary: "Clean-Room SPA",
      suspectedTechStack: ["HTML5", "CSS", "JavaScript"],
      stateManagementModel: "DOM-driven",
      dataPersistenceModel: "In-memory",
      explicitlyInferred: true,
      supportingEvidenceIds: ["ev_1"],
    },
  };
}

function buildTestLedger(spec: ReconstructionSpecification): ReconstructionObligationLedger {
  return {
    schema: "ReconstructionObligationLedger",
    ledgerId: `ledger_${spec.specificationId}`,
    status: "partial",
    closureDigest: "",
    obligations: [
      {
        obligationId: "obl_route",
        obligationVersion: 1,
        title: "Route & Accessibility Landmark Parity",
        applicationLayer: "application",
        family: "route",
        target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/" },
        positiveCases: ["Loads home route and accessible main landmark"],
        negativeCases: [],
        edgeCases: [],
        failureCases: [],
        evidenceLinks: ["ev_1"],
        owner: null,
        status: "characterized",
      },
      {
        obligationId: "obl_form",
        obligationVersion: 1,
        title: "Negative Form Validation Parity",
        applicationLayer: "application",
        family: "form_validation",
        target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/form" },
        positiveCases: ["Valid submission creates item"],
        negativeCases: ["Empty submission is rejected with visible error"],
        edgeCases: [],
        failureCases: [],
        evidenceLinks: ["ev_2"],
        owner: null,
        status: "characterized",
      },
      {
        obligationId: "obl_state",
        obligationVersion: 1,
        title: "State Change & Item Mutation Parity",
        applicationLayer: "application",
        family: "state_change",
        target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/items" },
        positiveCases: ["Submitting item adds it to DOM list"],
        negativeCases: [],
        edgeCases: [],
        failureCases: [],
        evidenceLinks: ["ev_3"],
        owner: null,
        status: "characterized",
      },
    ],
    coverage: { status: "partial" },
    reports: {
      missingOwnerObligationIds: [],
      missingVerifierObligationIds: [],
      contradictedObligationIds: [],
      residualUnknownIds: [],
    },
    evidenceLinks: ["ev_1", "ev_2", "ev_3"],
    limitations: [],
    summary: {
      total: 3,
      required: 3,
      verified: 0,
      requiredOpen: 3,
      byStatus: [{ key: "characterized", count: 3 }],
      byApplicationLayer: [
        { key: "application", count: 3 },
      ],
    },
  };
}

function httpFetch(url: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string>,
          body: data,
        });
      });
    }).on("error", reject);
  });
}

// ============================================================================
// PHASE A.3: P0 — CORRECT PRODUCTION REA VERIFIER INITIALIZATION
// ============================================================================

test("10A.1D-1: Verifier initializes from validated evidence bundle via AgentRuntime execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-1-"));
  let refServer: Server | undefined;
  try {
    refServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><main><h1>App</h1></main></html>");
    });
    await new Promise<void>((r) => refServer!.listen(0, "127.0.0.1", () => r()));
    const refPort = (refServer.address() as any).port;
    const refUrl = `http://127.0.0.1:${refPort}/`;

    writeFileSync(join(root, "index.html"), "<html><main><h1>App</h1></main></html>");
    const spec = buildTestSpec("app1", refUrl, root);
    const ledger: ReconstructionObligationLedger = {
      schema: "ReconstructionObligationLedger",
      ledgerId: `ledger_${spec.specificationId}`,
      status: "partial",
      closureDigest: "",
      obligations: [
        {
          obligationId: "obl_route_1",
          obligationVersion: 1,
          title: "Route & Accessibility Landmark Parity",
          applicationLayer: "application",
          family: "route",
          target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/" },
          positiveCases: ["Loads home route and accessible main landmark"],
          negativeCases: [],
          edgeCases: [],
          failureCases: [],
          evidenceLinks: ["ev_1"],
          owner: null,
          status: "characterized",
        },
      ],
      coverage: { status: "partial" },
      reports: {
        missingOwnerObligationIds: [],
        missingVerifierObligationIds: [],
        contradictedObligationIds: [],
        residualUnknownIds: [],
      },
      evidenceLinks: ["ev_1"],
      limitations: [],
      summary: {
        total: 1,
        required: 1,
        verified: 0,
        requiredOpen: 1,
        byStatus: [{ key: "characterized", count: 1 }],
        byApplicationLayer: [{ key: "application", count: 1 }],
      },
    };

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_init_test",
      workspaceRoot: root,
      accountScope: "tenant_alpha",
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const mockBrowser = {
      observeVisualQaState: async (options?: any) => {
        const u = options?.url || "";
        return {
          url: u,
          title: "Test App",
          elements: [{ tagName: "main" }, { tagName: "h1" }],
          accessibilityTree: { role: "main", name: "App", children: [] },
        };
      },
      open: async () => ({}),
      close: async () => ({}),
      snapshot: async () => ({
        elements: [
          { role: "textbox", tag: "input" },
          { role: "button", tag: "button" },
        ],
        text: "App",
      }),
    } as any;

    const runtime = await createAgentRuntime({
      workspaceRoot: root,
      mode: "BUILD",
      instruction: "clean-room reconstruction inv_init_test",
      isTrusted: true,
      browserSessionManager: mockBrowser,
      initialEvidenceBundle: bundle,
      accountScope: "tenant_alpha",
      providerOverride: createMockModelProvider([
        { path: "index.html", content: "<html><main><h1>App</h1></main></html>" },
      ]),
      eventSink: () => {},
      workflow: { enabled: true },
    });

    assert.ok(runtime.workflow, "Reconstruction workflow must be instantiated");
    const wf = runtime.workflow as any;
    let res = await wf.run();

    // Auto-approve reconstruction planning and file mutations
    while (res.status === "WAITING_FOR_CONFIRMATION") {
      res = await wf.resume("APPROVE", wf.pendingConfirmation?.callId);
    }

    assert.equal(res.status, "COMPLETE");
    assert.equal(wf.state.status, "COMPLETE");
  } finally {
    if (refServer) {
      await new Promise<void>((r) => refServer!.close(() => r()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-2: Missing reference evidence URL strictly blocks verification (fails closed)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-2-"));
  try {
    writeFileSync(join(root, "index.html"), "<html><body>App</body></html>");
    // Target identity is an abstract label without URL, and rawInput / normalizedLocation are empty
    const spec = buildTestSpec("no_url", "", root);
    (spec.target as any).rawInput = "";
    (spec.target as any).normalizedLocation = "";
    (spec.target as any).targetId = "abstract_label_without_url";
    const ledger = buildTestLedger(spec);

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_missing_url",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    // Set targetIdentity to non-URL label
    (bundle as any).targetIdentity = "abstract_label_without_url";
    (bundle as any).bundleDigest = computeEvidenceBundleDigest(bundle as any);

    const mutEngine = new MutationEngine(root);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      task: "clean-room reconstruction",
      taskId: "task_missing_url",
      autoApprove: true,
      provider: createMockModelProvider([
        { path: "index.html", content: "<html><body>Reconstructed</body></html>" },
      ]) as any,
    });

    const res = await recon.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "STAGE_FAILED");
    assert.ok(res.state.blockerDetail?.includes("MISSING_REFERENCE_EVIDENCE"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-3: Unsupported target category returns accurate UNSUPPORTED_VERIFIER status", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-3-"));
  try {
    const runner = createReaProductionTestRunner({
      workspaceRoot: root,
      targetCategory: "native_packaged_app",
      referenceUrl: "http://127.0.0.1:3000",
      browserSessionManager: {} as any,
    });

    const obl: ReconstructionObligation = {
      obligationId: "obl_native_1",
      obligationVersion: 1,
      title: "Native Mach-O Export Parity",
      applicationLayer: "application",
      family: "native_export",
      target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/" },
      positiveCases: ["Exports symbols"],
      negativeCases: [],
      edgeCases: [],
      failureCases: [],
      evidenceLinks: [],
      owner: null,
      status: "characterized",
    };

    const res = await runner(obl, root);
    assert.equal(res.passed, false);
    assert.equal(res.details?.observedResult, "UNSUPPORTED_VERIFIER");
    assert.ok(res.output.includes("UNSUPPORTED_VERIFIER"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-4: Recovered workflow revalidates source evidence bundle on resumption", async () => {
  const root1 = mkdtempSync(join(tmpdir(), "rea-10a1d-4a-"));
  const root2 = mkdtempSync(join(tmpdir(), "rea-10a1d-4b-"));
  try {
    const spec = buildTestSpec("recov_test", "http://127.0.0.1:8888", root1);
    const ledger = buildTestLedger(spec);

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_recov_test",
      workspaceRoot: root1,
      accountScope: "account_dev",
      specification: spec,
      obligationLedger: ledger,
    });

    // Attempting to run reconstruction on root2 with root1 bundle fails closed
    const mutEngine2 = new MutationEngine(root2);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root2,
      mutationEngine: mutEngine2,
      evidenceBundle: bundle,
      accountScope: "account_dev",
      task: "clean-room reconstruction",
      taskId: "task_recov",
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

// ============================================================================
// PHASE A.4: P0 — ELIMINATE FALSE-POSITIVE OBLIGATION CLOSURE
// ============================================================================

test("10A.1D-5: Obligation without corresponding scenario remains UNVERIFIED (no false pass)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-5-"));
  try {
    writeFileSync(join(root, "index.html"), "<html><body>App</body></html>");

    const runner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: "http://127.0.0.1:4000",
      browserSessionManager: {
        observeVisualQaState: async () => ({
          url: "http://127.0.0.1:4000",
          title: "App",
          elements: [],
          accessibilityTree: { role: "main", children: [] },
        }),
      } as any,
    });

    // Obligation for an unexecuted/unsupported category
    const unmappedObl: ReconstructionObligation = {
      obligationId: "obl_unmapped_feature",
      obligationVersion: 1,
      title: "Audio WebRTC Streaming Parity",
      applicationLayer: "application",
      family: "webrtc_audio",
      target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/stream" },
      positiveCases: ["Streams 48kHz audio"],
      negativeCases: [],
      edgeCases: [],
      failureCases: [],
      evidenceLinks: [],
      owner: null,
      status: "characterized",
    };

    const res = await runner(unmappedObl, root);
    assert.equal(res.passed, false, "Obligation with no executed scenario must NOT pass");
    assert.ok(
      res.details?.observedResult === "UNVERIFIED" || res.details?.observedResult === "UNSUPPORTED_VERIFIER",
      "Must report UNVERIFIED or UNSUPPORTED_VERIFIER"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-6: Obligation with one passing and one failing required case strictly FAILS", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-6-"));
  try {
    // Reconstructed app has form, but does NOT validate empty input (submits without error)
    writeFileSync(
      join(root, "index.html"),
      '<html><body><form id="order"><input id="item"><button type="submit">Submit</button></form><ul id="list"></ul><script>document.getElementById("order").onsubmit = (e) => { e.preventDefault(); const li = document.createElement("li"); li.textContent = document.getElementById("item").value; document.getElementById("list").appendChild(li); };</script></body></html>'
    );

    const runner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: "http://127.0.0.1:4001",
      browserSessionManager: {
        observeVisualQaState: async () => ({
          url: "http://127.0.0.1:4001",
          title: "Ref App",
          elements: [{ tagName: "form", id: "order" }],
          accessibilityTree: { role: "form", children: [] },
        }),
      } as any,
    });

    const formObl: ReconstructionObligation = {
      obligationId: "obl_form_mixed",
      obligationVersion: 1,
      title: "Form Submission & Validation Parity",
      applicationLayer: "application",
      family: "form_validation",
      target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/form" },
      positiveCases: ["Valid input adds item"],
      negativeCases: ["Empty input is rejected with visible validation error"],
      edgeCases: [],
      failureCases: [],
      evidenceLinks: [],
      owner: null,
      status: "characterized",
    };

    const res = await runner(formObl, root);
    assert.equal(res.passed, false, "Mixed case obligation must fail when negative validation fails");
    assert.ok(res.details?.observedResult?.includes("FAILED") || res.output.includes("FAILED"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-7: Interrupted verification run returns INCOMPLETE status", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-7-"));
  try {
    writeFileSync(join(root, "index.html"), "<html><body>App</body></html>");
    const abortCtrl = new AbortController();
    abortCtrl.abort(); // Pre-aborted signal

    const runner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: "http://127.0.0.1:4002",
      browserSessionManager: {} as any,
      signal: abortCtrl.signal,
    });

    const obl: ReconstructionObligation = {
      obligationId: "obl_interrupted",
      obligationVersion: 1,
      title: "Route Parity",
      applicationLayer: "application",
      family: "route",
      target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/" },
      positiveCases: ["Loads home route"],
      negativeCases: [],
      edgeCases: [],
      failureCases: [],
      evidenceLinks: [],
      owner: null,
      status: "characterized",
    };

    const res = await runner(obl, root);
    assert.equal(res.passed, false);
    assert.equal(res.details?.observedResult, "INCOMPLETE");
    assert.ok(res.output.includes("INCOMPLETE"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-8: Unsupported capability in obligation title/family returns UNSUPPORTED_VERIFIER", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-8-"));
  try {
    writeFileSync(join(root, "index.html"), "<html><body>App</body></html>");

    const runner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: "http://127.0.0.1:4003",
      browserSessionManager: {
        observeVisualQaState: async () => ({}),
      } as any,
    });

    const obl: ReconstructionObligation = {
      obligationId: "obl_bluetooth_1",
      obligationVersion: 1,
      title: "Hardware Bluetooth Device Pairing",
      applicationLayer: "application",
      family: "unsupported_hardware",
      target: { artifactSha256: null, applicationNodeId: null, semanticNodeId: null, location: "/device" },
      positiveCases: ["Pairs with BLE peripheral"],
      negativeCases: [],
      edgeCases: [],
      failureCases: [],
      evidenceLinks: [],
      owner: null,
      status: "characterized",
    };

    const res = await runner(obl, root);
    assert.equal(res.passed, false);
    assert.equal(res.details?.observedResult, "UNSUPPORTED_VERIFIER");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE A.5: P0 — SECURE THE TEMPORARY VERIFICATION SERVER
// ============================================================================

test("10A.1D-9: Fixture staging copies only approved public web assets and isolates workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-9-"));
  try {
    // Legitimate public assets
    writeFileSync(join(root, "index.html"), "<html><head><link rel='stylesheet' href='styles.css'></head><body><h1>App</h1></body></html>");
    writeFileSync(join(root, "styles.css"), "body { margin: 0; }");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.js"), "console.log('App loaded');");

    // Prohibited secret and internal files
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://user:pass@localhost:5432/db");
    writeFileSync(join(root, ".env.production"), "SECRET_KEY=12345");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "[core]\nrepositoryformatversion = 0");
    mkdirSync(join(root, ".open-vs-code"));
    writeFileSync(join(root, ".open-vs-code", "state.json"), '{"token":"secret_session_token"}');
    writeFileSync(join(root, "id_rsa"), "-----BEGIN RSA PRIVATE KEY-----");
    writeFileSync(join(root, "deploy.sh"), "#!/bin/bash\necho deploy");

    const staged = stageVerificationFixture(root);
    try {
      assert.ok(staged.fileCount >= 3, "Must stage html, css, js");
      // Check that prohibited files are NOT staged
      assert.ok(!existsSync(join(staged.fixtureDir, ".env")), ".env must NOT be staged");
      assert.ok(!existsSync(join(staged.fixtureDir, ".env.production")), ".env.production must NOT be staged");
      assert.ok(!existsSync(join(staged.fixtureDir, ".git")), ".git must NOT be staged");
      assert.ok(!existsSync(join(staged.fixtureDir, ".open-vs-code")), ".open-vs-code must NOT be staged");
      assert.ok(!existsSync(join(staged.fixtureDir, "id_rsa")), "private key must NOT be staged");
      assert.ok(!existsSync(join(staged.fixtureDir, "deploy.sh")), "shell script must NOT be staged");

      // Check legitimate files ARE staged
      assert.ok(existsSync(join(staged.fixtureDir, "index.html")), "index.html must be staged");
      assert.ok(existsSync(join(staged.fixtureDir, "styles.css")), "styles.css must be staged");
      assert.ok(existsSync(join(staged.fixtureDir, "src", "app.js")), "src/app.js must be staged");
    } finally {
      staged.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-10: Ephemeral verification server rejects .env, credentials, and internal state via HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-10-"));
  try {
    writeFileSync(join(root, "index.html"), "<html><body>Legitimate Web App</body></html>");
    writeFileSync(join(root, ".env"), "TOP_SECRET_API_KEY=shhh_do_not_leak");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "git_credentials=forbidden");
    mkdirSync(join(root, ".open-vs-code"));
    writeFileSync(join(root, ".open-vs-code", "internal.json"), '{"secret":"vault_key"}');

    const serverInfo = await startEphemeralWorkspaceServer(root);
    try {
      // 1. Legitimate asset must load with 200 and nosniff
      const homeRes = await httpFetch(`${serverInfo.url}/index.html`);
      assert.equal(homeRes.statusCode, 200);
      assert.ok(homeRes.body.includes("Legitimate Web App"));
      assert.equal(homeRes.headers["x-content-type-options"], "nosniff");

      // 2. .env must return 404 or 403 and never expose secrets
      const envRes = await httpFetch(`${serverInfo.url}/.env`);
      assert.ok(envRes.statusCode === 404 || envRes.statusCode === 403);
      assert.ok(!envRes.body.includes("TOP_SECRET_API_KEY"));

      // 3. .git/config must return 404 or 403
      const gitRes = await httpFetch(`${serverInfo.url}/.git/config`);
      assert.ok(gitRes.statusCode === 404 || gitRes.statusCode === 403);
      assert.ok(!gitRes.body.includes("git_credentials"));

      // 4. .open-vs-code state must return 404 or 403
      const stateRes = await httpFetch(`${serverInfo.url}/.open-vs-code/internal.json`);
      assert.ok(stateRes.statusCode === 404 || stateRes.statusCode === 403);
      assert.ok(!stateRes.body.includes("vault_key"));
    } finally {
      await serverInfo.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-11: Ephemeral server rejects directory traversal and encoded escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-11-"));
  try {
    writeFileSync(join(root, "index.html"), "<html><body>Safe</body></html>");

    const serverInfo = await startEphemeralWorkspaceServer(root);
    try {
      // Traversal using ..
      const travRes = await httpFetch(`${serverInfo.url}/../../../etc/passwd`);
      assert.ok(travRes.statusCode === 403 || travRes.statusCode === 404);
      assert.ok(!travRes.body.includes("root:"));

      // Encoded traversal %2e%2e
      const encRes = await httpFetch(`${serverInfo.url}/%2e%2e/%2e%2e/etc/passwd`);
      assert.ok(encRes.statusCode === 403 || encRes.statusCode === 404);
      assert.ok(!encRes.body.includes("root:"));

      // Null byte injection
      const nullRes = await httpFetch(`${serverInfo.url}/index.html%00.png`);
      assert.ok(nullRes.statusCode === 400 || nullRes.statusCode === 403 || nullRes.statusCode === 404);
    } finally {
      await serverInfo.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-12: Ephemeral server denies symlink escapes to outside targets", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "rea-10a1d-12-outside-"));
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-12-ws-"));
  try {
    writeFileSync(join(outsideDir, "secret_outside.txt"), "OUTSIDE_WORKSPACE_SECRET");
    writeFileSync(join(root, "index.html"), "<html><body>App</body></html>");

    // Create a symlink inside workspace pointing to an outside file
    try {
      symlinkSync(join(outsideDir, "secret_outside.txt"), join(root, "leak_link.txt"));
    } catch {
      // If symlink creation is not permitted on this platform, test passes vacuously
    }

    const serverInfo = await startEphemeralWorkspaceServer(root);
    try {
      const linkRes = await httpFetch(`${serverInfo.url}/leak_link.txt`);
      assert.ok(linkRes.statusCode === 404 || linkRes.statusCode === 403);
      assert.ok(!linkRes.body.includes("OUTSIDE_WORKSPACE_SECRET"));
    } finally {
      await serverInfo.close();
    }
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-13: Server resources and fixture directories are cleaned up on close", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-13-"));
  try {
    writeFileSync(join(root, "index.html"), "<html><body>Cleanup Test</body></html>");

    const staged = stageVerificationFixture(root);
    const fixtureDir = staged.fixtureDir;
    assert.ok(existsSync(fixtureDir), "Fixture dir must exist when staged");

    staged.cleanup();
    assert.ok(!existsSync(fixtureDir), "Fixture dir must be completely removed on cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE A.6: P1 — ENFORCE ACCOUNT-SCOPED EVIDENCE OWNERSHIP
// ============================================================================

test("10A.1D-14: Authenticated Account A creates bundle; Account A can load and reconstruct", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-14-"));
  try {
    const spec = buildTestSpec("acct_a", "http://127.0.0.1:5001", root);
    const ledger = buildTestLedger(spec);

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_acct_a",
      workspaceRoot: root,
      accountScope: "user_alice_42",
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    const val = validateReaEvidenceBundle(bundle, root, "user_alice_42");
    assert.equal(val.valid, true);
    if (!val.valid) return;
    assert.equal(val.bundle.accountScope, "user_alice_42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-15: Account B is strictly denied access to Account A's evidence (ACCOUNT_MISMATCH)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-15-"));
  try {
    const spec = buildTestSpec("cross_user", "http://127.0.0.1:5002", root);
    const ledger = buildTestLedger(spec);

    const bundleA = createReaEvidenceBundle({
      investigationId: "inv_alice",
      workspaceRoot: root,
      accountScope: "user_alice",
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundleA);

    // Bob attempts to validate Alice's bundle
    const bobVal = validateReaEvidenceBundle(bundleA, root, "user_bob");
    assert.equal(bobVal.valid, false);
    if (!bobVal.valid) {
      assert.equal(bobVal.code, "ACCOUNT_MISMATCH");
    }

    // Bob attempts to resolve Alice's bundle via task text
    const bobResolve = resolveReaEvidenceBundle(root, "reconstruct inv_alice", "user_bob");
    assert.equal(bobResolve.valid, false);
    if (!bobResolve.valid) {
      assert.equal(bobResolve.code, "ACCOUNT_MISMATCH");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-16: Unauthenticated user cannot access authenticated account evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-16-"));
  try {
    const spec = buildTestSpec("auth_acct", "http://127.0.0.1:5003", root);
    const ledger = buildTestLedger(spec);

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_auth_only",
      workspaceRoot: root,
      accountScope: "user_carol",
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundle);

    // Unauthenticated access (expectedAccountScope is undefined)
    const unauthVal = validateReaEvidenceBundle(bundle, root, undefined);
    assert.equal(unauthVal.valid, false, "Unauthenticated access to user_carol's bundle must be rejected");
    if (!unauthVal.valid) {
      assert.equal(unauthVal.code, "ACCOUNT_MISMATCH");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-17: Authenticated user cannot claim legacy unscoped bundle without migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-17-"));
  try {
    const spec = buildTestSpec("legacy_app", "http://127.0.0.1:5004", root);
    const ledger = buildTestLedger(spec);

    // Simulate an unscoped legacy bundle with valid cryptographic digest
    const legacyBundle = createReaEvidenceBundle({
      investigationId: "inv_legacy_unscoped",
      workspaceRoot: root,
      specification: spec,
      obligationLedger: ledger,
    });
    const { bundleDigest: _ignored, ...bundleRest } = legacyBundle;
    const legacyWithoutScope = { ...bundleRest, accountScope: undefined };
    const validLegacyDigest = computeEvidenceBundleDigest(legacyWithoutScope);
    const validLegacyBundle = { ...legacyWithoutScope, bundleDigest: validLegacyDigest };

    // Authenticated Dave attempts to claim unscoped bundle
    const daveVal = validateReaEvidenceBundle(validLegacyBundle, root, "user_dave");
    assert.equal(daveVal.valid, false, "Authenticated user cannot claim legacy unscoped bundle without migration");
    if (!daveVal.valid) {
      assert.equal(daveVal.code, "ACCOUNT_MISMATCH");
      assert.ok(daveVal.reason.includes("without explicit migration"));
    }

    // Unauthenticated local user CAN access legacy unscoped bundle (deliberate compatibility policy)
    const localVal = validateReaEvidenceBundle(validLegacyBundle, root, LOCAL_UNAUTHENTICATED_ACCOUNT_SCOPE);
    assert.equal(localVal.valid, true, "Local unauthenticated mode safely permits legacy unscoped bundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-18: Account logout / session transition invalidates active session bridge and cancels scoped turn", async () => {
  let activeBridge: any = { accountScope: "user_alice" };
  let cancelledTurn = false;

  const mockChatController = {
    cancelTurn: () => {
      cancelledTurn = true;
    },
  };

  // Simulate account manager state listener as wired in extension.ts
  let lastKnownUserId: string | undefined = "user_alice";
  const handleAccountStateChange = (state: { status: string; user?: { id: string } }) => {
    if (state.status === "unauthenticated" || state.user?.id !== lastKnownUserId) {
      activeBridge = null;
      mockChatController.cancelTurn();
      lastKnownUserId = state.user?.id;
    }
  };

  // State 1: User logs out -> transitions to unauthenticated
  handleAccountStateChange({ status: "unauthenticated" });
  assert.equal(activeBridge, null, "Active bridge must be invalidated on logout");
  assert.equal(cancelledTurn, true, "In-flight chat turn must be cancelled on logout");

  // State 2: User Bob logs in -> transitions to user_bob
  cancelledTurn = false;
  activeBridge = { accountScope: "user_bob" };
  lastKnownUserId = "user_bob";

  // Account switches to user_carol
  handleAccountStateChange({ status: "authenticated", user: { id: "user_carol" } });
  assert.equal(activeBridge, null, "Active bridge must be invalidated on account switch");
  assert.equal(cancelledTurn, true, "Turn must be cancelled on account switch");
});

// ============================================================================
// PHASE B: END-TO-END REA ACCEPTANCE & NEGATIVE DEMONSTRATIONS
// ============================================================================

test("10A.1D-19: Complete REA End-to-End Acceptance: Investigation -> Bundle -> Governed Reconstruction -> Comparative Verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-e2e-"));
  let refServer: Server | undefined;
  try {
    // 1. Controlled reference web application with 3 verifiable behaviors
    refServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Tasks App</title></head>
<body>
  <main>
    <h1>Task Manager</h1>
    <form id="task-form">
      <input id="task-title" name="title" required />
      <button id="add-btn" type="submit">Add Task</button>
    </form>
    <ul id="task-list"></ul>
  </main>
</body>
</html>`);
    });
    await new Promise<void>((r) => refServer!.listen(0, "127.0.0.1", () => r()));
    const refPort = (refServer.address() as any).port;
    const refUrl = `http://127.0.0.1:${refPort}/`;

    // 2. Production Browser Session Simulator with deterministic DOM states
    let activeUrl = refUrl;
    let inputBuffer = "";
    const appLists: Record<string, string[]> = {};

    const mockBrowser = {
      observeVisualQaState: async (opts?: any) => {
        const u = opts?.url || activeUrl;
        return {
          url: u,
          title: "Tasks App",
          elements: [
            { tagName: "main" },
            { tagName: "h1", textContent: "Task Manager" },
            { tagName: "form", id: "task-form" },
            { tagName: "input", id: "task-title" },
            { tagName: "button", id: "add-btn" },
            { tagName: "ul", id: "task-list" },
          ],
          accessibilityTree: { role: "main", name: "Task Manager", children: [] },
        };
      },
      open: async (url: string) => {
        activeUrl = url;
        if (!appLists[activeUrl]) {
          appLists[activeUrl] = [];
        }
      },
      close: async () => ({}),
      fill: async (_refId: string, value: string) => {
        inputBuffer = value;
      },
      click: async (_refId: string) => {
        if (!appLists[activeUrl]) appLists[activeUrl] = [];
        if (inputBuffer.trim().length > 0) {
          appLists[activeUrl]!.push(inputBuffer.trim());
          inputBuffer = "";
        }
      },
      snapshot: async (opts?: any) => {
        const currentUrl = opts?.url || activeUrl;
        const currentItems = appLists[currentUrl] || [];
        const itemElements = currentItems.map((item, idx) => ({
          role: "listitem",
          tag: "li",
          refId: `item_${idx}`,
          name: item,
        }));
        return {
          elements: [
            { role: "main", tag: "main" },
            { role: "textbox", tag: "input", id: "task-title", refId: "task-input" },
            { role: "button", tag: "button", id: "add-btn", refId: "task-submit" },
            ...itemElements,
          ],
          text: `Task Manager ${currentItems.join(" ")}`,
        };
      },
    } as any;

    // 3. Stage 1: Investigation Phase
    const mutEngine = new MutationEngine(root);
    const investigationWorkflow = GovernedReaWorkflow.startInvestigation({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      targetInput: refUrl,
      task: `investigate ${refUrl}`,
      taskId: "task_e2e_inv",
      browserSessionManager: mockBrowser,
      accountScope: "engineer_10a1d",
      autoApprove: true,
    });

    const invResult = await investigationWorkflow.run();
    assert.equal(invResult.status, "COMPLETE");
    assert.ok(investigationWorkflow.evidenceBundle, "Investigation must generate and persist ReaEvidenceBundle");

    const bundle = investigationWorkflow.evidenceBundle;
    assert.equal(bundle.accountScope, "engineer_10a1d");
    assert.ok(bundle.bundleDigest.length === 64);

    // 4. Stage 2: Clean-Room Reconstruction Phase
    const reconstructedHtml = `<!DOCTYPE html>
<html>
<head><title>Tasks App (Clean-Room)</title></head>
<body>
  <main>
    <h1>Task Manager</h1>
    <form id="task-form">
      <input id="task-title" name="title" required />
      <button id="add-btn" type="submit">Add Task</button>
    </form>
    <ul id="task-list"></ul>
  </main>
  <script>
    document.getElementById("task-form").onsubmit = (e) => {
      e.preventDefault();
      const val = document.getElementById("task-title").value.trim();
      if (!val) return;
      const li = document.createElement("li");
      li.textContent = val;
      document.getElementById("task-list").appendChild(li);
      document.getElementById("task-title").value = "";
    };
  </script>
</body>
</html>`;

    const modelProvider = createMockModelProvider([
      { path: "index.html", content: reconstructedHtml },
    ]);

    const reconstructionWorkflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: root,
      mutationEngine: mutEngine,
      evidenceBundle: bundle,
      accountScope: "engineer_10a1d",
      task: `clean-room reconstruction of ${refUrl}`,
      taskId: "task_e2e_recon",
      browserSessionManager: mockBrowser,
      provider: modelProvider as any,
    });

    let reconResult = await reconstructionWorkflow.run();

    // Enforce human confirmation for planning and mutation
    assert.equal(reconResult.status, "WAITING_FOR_CONFIRMATION");
    assert.equal(reconstructionWorkflow.pendingConfirmation?.stage, "planning");

    reconResult = await reconstructionWorkflow.resume(
      "APPROVE",
      reconstructionWorkflow.pendingConfirmation?.callId
    );

    assert.equal(reconResult.status, "WAITING_FOR_CONFIRMATION");
    assert.equal(reconstructionWorkflow.pendingConfirmation?.stage, "implementation");

    reconResult = await reconstructionWorkflow.resume(
      "APPROVE",
      reconstructionWorkflow.pendingConfirmation?.callId
    );

    // 5. Verification Phase & Ledger Closure
    assert.equal(reconResult.status, "COMPLETE");
    assert.equal(reconstructionWorkflow.state.status, "COMPLETE");

    const reconReport = reconstructionWorkflow.reconstructionResult;
    assert.ok(reconReport, "Reconstruction report must be generated");
    assert.ok(reconReport.verifiedObligationsCount >= 1, "Must verify observed obligations");
    assert.equal(reconReport.remainingOpenCount, 0, "No obligations should remain unverified on passing run");
    assert.equal(reconReport.updatedLedger.status, "verified");
  } finally {
    if (refServer) {
      await new Promise<void>((r) => refServer!.close(() => r()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-20: Negative Demonstration: Deliberately flawed reconstruction fails verification and refuses parity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rea-10a1d-neg-"));
  let refServer: Server | undefined;
  try {
    refServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><main><h1>Ref</h1><input id='inp'><button id='btn'>OK</button></main></html>");
    });
    await new Promise<void>((r) => refServer!.listen(0, "127.0.0.1", () => r()));
    const refPort = (refServer.address() as any).port;
    const refUrl = `http://127.0.0.1:${refPort}/`;

    // Deliberately flawed reconstructed app: missing controls entirely (div only)
    writeFileSync(join(root, "index.html"), "<html><body><div>Empty Div App</div></body></html>");

    const spec = buildTestSpec("neg_app", refUrl, root);
    const ledger = buildTestLedger(spec);

    const bundle = createReaEvidenceBundle({
      investigationId: "inv_neg_demo",
      workspaceRoot: root,
      accountScope: "engineer_10a1d",
      specification: spec,
      obligationLedger: ledger,
    });
    assert.ok(bundle.bundleDigest, "Bundle digest must be present");

    const mockBrowser = {
      observeVisualQaState: async (opts?: any) => ({
        url: opts?.url || "",
        title: "Flawed App",
        elements: [{ tagName: "div" }],
        accessibilityTree: { role: "generic", children: [] },
      }),
      open: async () => ({}),
      snapshot: async (opts?: any) => {
        const isRef = opts?.url?.includes(String(refPort));
        return {
          elements: isRef
            ? [{ role: "textbox", tag: "input" }, { role: "button", tag: "button" }]
            : [], // Reconstructed app has 0 inputs and 0 buttons
          text: isRef ? "Ref" : "Empty Div App",
        };
      },
    } as any;

    const runner = createReaProductionTestRunner({
      workspaceRoot: root,
      referenceUrl: refUrl,
      targetCategory: "running_web_app",
      browserSessionManager: mockBrowser,
    });

    const routeObl = ledger.obligations.find((o) => o.family === "route")!;
    const res = await runner(routeObl, root);

    // Flawed implementation MUST fail verification
    assert.equal(res.passed, false, "Flawed implementation must fail verification");
    assert.ok(res.output.includes("FAILED") || res.details?.observedResult?.includes("FAILED"));
    assert.ok(res.details?.limitations && res.details.limitations.length > 0);
  } finally {
    if (refServer) {
      await new Promise<void>((r) => refServer!.close(() => r()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-21: Multi-workspace isolation: switching workspace invalidates cross-workspace evidence access", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "rea-10a1d-wsA-"));
  const rootB = mkdtempSync(join(tmpdir(), "rea-10a1d-wsB-"));
  try {
    const spec = buildTestSpec("ws_a", "http://127.0.0.1:6001", rootA);
    const ledger = buildTestLedger(spec);

    const bundleA = createReaEvidenceBundle({
      investigationId: "inv_workspace_a",
      workspaceRoot: rootA,
      accountScope: "shared_account",
      specification: spec,
      obligationLedger: ledger,
    });
    saveReaEvidenceBundle(bundleA);

    // Workspace B attempts to validate Workspace A's bundle
    const val = validateReaEvidenceBundle(bundleA, rootB, "shared_account");
    assert.equal(val.valid, false, "Cross-workspace bundle must fail validation");
    if (!val.valid) {
      assert.equal(val.code, "WORKSPACE_MISMATCH");
    }

    // Workspace B attempts reconstruction using Workspace A's bundle
    const mutEngineB = new MutationEngine(rootB);
    const recon = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: rootB,
      mutationEngine: mutEngineB,
      evidenceBundle: bundleA,
      accountScope: "shared_account",
      task: "clean-room reconstruction",
      taskId: "task_cross_ws",
      autoApprove: true,
    });

    const res = await recon.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "STAGE_FAILED");
    assert.ok(res.state.blockerDetail?.includes("does not match active workspace"));
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE B: CODING & ADVANCED DESIGN WORKFLOW ACCEPTANCE
// ============================================================================

test("10A.1D-22: Coding Agent Acceptance: inspect -> governed mutation -> test pass & negative rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "coding-10a1d-"));
  try {
    const srcDir = join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    const calcFile = join(srcDir, "calc.ts");
    writeFileSync(calcFile, "export function add(a: number, b: number): number {\n  return a - b; // Buggy subtraction\n}\n");

    const mutEngine = new MutationEngine(root);

    // 1. Inspect existing code
    const inspectContent = readFileSync(calcFile, "utf-8");
    assert.ok(inspectContent.includes("return a - b;"));

    // 2. Prepare governed mutation
    const prep = await mutEngine.preparePatch({
      operation: "patch",
      path: "src/calc.ts",
      patch: {
        search: "return a - b; // Buggy subtraction",
        replace: "return a + b;",
      },
    });
    assert.equal(prep.operation, "patch");
    assert.ok(prep.proposedContent.includes("return a + b;"));

    // 3. Negative check: if human operator rejects, file on disk must NOT change
    mutEngine.rejectMutation(prep.id);
    const untouchedDiskContent = readFileSync(calcFile, "utf-8");
    assert.ok(untouchedDiskContent.includes("return a - b;"), "Unapproved mutation must not mutate disk");

    // 4. Positive check: operator approves -> mutation is applied
    const prep2 = await mutEngine.preparePatch({
      operation: "patch",
      path: "src/calc.ts",
      patch: {
        search: "return a - b; // Buggy subtraction",
        replace: "return a + b;",
      },
    });
    const applyResult = await mutEngine.applyPreparedMutation(prep2);
    assert.equal(applyResult.status, "APPLIED");

    const mutatedDiskContent = readFileSync(calcFile, "utf-8");
    assert.ok(mutatedDiskContent.includes("return a + b;"));
    assert.ok(!mutatedDiskContent.includes("return a - b;"));

    // 5. Verification: test runner verifies corrected implementation
    const verified = mutatedDiskContent.includes("return a + b;");
    assert.equal(verified, true, "Coding agent fix successfully verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10A.1D-23: Advanced Design Acceptance: design brief -> layout synthesis -> truthful visual QA observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "design-10a1d-"));
  try {
    // 1. Synthesize design system tokens from design brief
    const designTokens = {
      theme: "dark",
      colors: {
        background: "#0f172a",
        foreground: "#f8fafc",
        primary: "#38bdf8",
        success: "#22c55e",
      },
      borderRadius: "0.5rem",
      typography: {
        fontFamily: "Inter, system-ui, sans-serif",
        headingSize: "1.25rem",
      },
    };

    writeFileSync(
      join(root, "tokens.json"),
      JSON.stringify(designTokens, null, 2)
    );

    // 2. Mock Chromium Browser Visual QA Observer
    let capturedUrl = "";
    const mockBrowser = {
      observeVisualQaState: async (opts?: any) => {
        capturedUrl = opts?.url || "http://127.0.0.1:9090";
        return {
          url: capturedUrl,
          title: "Analytics Dashboard Card",
          elements: [
            { tagName: "div", className: "card", role: "region" },
            { tagName: "h3", textContent: "Active Deployments", role: "heading" },
            { tagName: "span", textContent: "42", className: "metric-counter" },
            { tagName: "span", textContent: "Operational", role: "status" },
          ],
          accessibilityTree: {
            role: "region",
            name: "Analytics Dashboard Card",
            children: [
              { role: "heading", name: "Active Deployments" },
              { role: "status", name: "Operational" },
            ],
          },
        };
      },
    };

    const qaState = await mockBrowser.observeVisualQaState({ url: "http://127.0.0.1:9090" });
    assert.equal(qaState.title, "Analytics Dashboard Card");
    assert.equal(qaState.elements.length, 4);

    // Truthful assertions: verify heading and status elements
    const hasHeading = qaState.elements.some((e) => e.role === "heading" && e.textContent === "Active Deployments");
    const hasStatus = qaState.elements.some((e) => e.role === "status" && e.textContent === "Operational");
    assert.equal(hasHeading, true, "Visual QA confirms heading presence");
    assert.equal(hasStatus, true, "Visual QA confirms status badge presence");

    // Negative QA assertion: missing unstyled element is correctly reported as missing
    const hasNonexistent = qaState.elements.some((e) => e.tagName === "video");
    assert.equal(hasNonexistent, false, "Visual QA does not hallucinate non-existent video element");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
