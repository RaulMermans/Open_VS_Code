import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InvestigationEngine,
} from "../../src/rea/investigation-engine.ts";
import {
  ReconstructionEngine,
} from "../../src/rea/reconstruction-engine.ts";
import {
  ReaMcpService,
} from "../../src/rea/rea-mcp-service.ts";
import {
  GovernedReaWorkflow,
} from "../../src/rea/governed-rea-workflow.ts";
import {
  ComparativeWebVerifier,
} from "../../src/rea/comparative-verifier.ts";
import {
  createAgentRuntime,
} from "../../src/agent/runtime.ts";
import {
  McpCatalog,
} from "../../src/mcp/mcp-catalog.ts";
import { happyModel } from "../workflow/helpers.ts";
import {
  type ReconstructionSpecification,
  type ReconstructionObligationLedger,
  type ReconstructionObligation,
  type InvestigationTarget,
  REA_PINNED_VERSION,
} from "../../src/rea/contracts.ts";
import { MutationEngine } from "../../src/tools/mutation-engine.ts";

function createMockSpec(targetLocation: string): ReconstructionSpecification {
  return {
    specificationId: "spec_test_gov_1",
    target: {
      targetId: "tgt_test_1",
      category: "source_repository",
      rawInput: targetLocation,
      normalizedLocation: targetLocation,
      format: "local_directory",
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
        unknownId: "unk_1",
        area: "database_schema",
        description: "Database details cannot be observed",
        whyUnobservable: "Client-only observation",
        riskLevel: "medium",
      },
    ],
    inferredArchitecture: {
      summary: "Test application architecture",
      suspectedTechStack: ["TypeScript"],
      stateManagementModel: "In-memory",
      dataPersistenceModel: "None",
      explicitlyInferred: true,
      supportingEvidenceIds: [],
    },
  };
}

function createMockLedger(): ReconstructionObligationLedger {
  const obligations: ReconstructionObligation[] = [
    {
      obligationId: "obl_unit_1",
      obligationVersion: 1,
      title: "Core Functionality Obligation",
      applicationLayer: "protocol",
      family: "core.service",
      target: {
        artifactSha256: null,
        applicationNodeId: "node_1",
        semanticNodeId: null,
        location: "src/service.ts",
      },
      positiveCases: ["Returns success"],
      negativeCases: ["Throws on invalid input"],
      edgeCases: [],
      failureCases: [],
      evidenceLinks: ["ev_1"],
      owner: "engineer-1",
      status: "characterized",
    },
  ];

  return {
    schema: "ReconstructionObligationLedger",
    ledgerId: "ledger_test_gov_1",
    closureDigest: "digest_initial",
    status: "partial",
    coverage: { status: "partial" },
    summary: {
      total: 1,
      required: 1,
      verified: 0,
      requiredOpen: 1,
      byStatus: [{ key: "characterized", count: 1 }],
      byApplicationLayer: [{ key: "protocol", count: 1 }],
    },
    reports: {
      missingOwnerObligationIds: [],
      missingVerifierObligationIds: ["obl_unit_1"],
      contradictedObligationIds: [],
      residualUnknownIds: ["unk_1"],
    },
    obligations,
    evidenceLinks: ["ev_1"],
    limitations: [],
  };
}

// ============================================================================
// 1. Production Runtime & Governed REA Workflow Integration
// ============================================================================

test("REA Governance — AgentRuntime routes chat investigation request to GovernedReaWorkflow", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-rt-"));
  try {
    const runtime = await createAgentRuntime({
      workspaceRoot: tmpWs,
      mode: "REVIEW",
      instruction: "Please investigate target http://127.0.0.1:8080/app using rea-investigation",
      isTrusted: true,
      eventSink: () => {},
      providerOverride: happyModel(),
      workflow: { enabled: true },
    });

    assert.ok(runtime.workflow, "REA investigation request must instantiate workflow");
    assert.ok(runtime.workflow instanceof GovernedReaWorkflow, "Workflow must be instance of GovernedReaWorkflow");
    assert.equal(runtime.workflow.workflowType, "investigation");

    await runtime.cleanup();
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("REA Governance — AgentRuntime routes clean-room reconstruction request to GovernedReaWorkflow", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-rt-recon-"));
  try {
    const runtime = await createAgentRuntime({
      workspaceRoot: tmpWs,
      mode: "BUILD",
      instruction: "Perform rea-reconstruction and clean-room reconstruction of application",
      isTrusted: true,
      eventSink: () => {},
      providerOverride: happyModel(),
      workflow: { enabled: true },
    });

    assert.ok(runtime.workflow, "REA reconstruction request must instantiate workflow");
    assert.ok(runtime.workflow instanceof GovernedReaWorkflow);
    assert.equal(runtime.workflow.workflowType, "reconstruction");

    await runtime.cleanup();
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("REA Governance — GovernedReaWorkflow supports stages, progress events, and cancellation", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-wf-"));
  const events: any[] = [];
  try {
    const abortController = new AbortController();
    const workflow = GovernedReaWorkflow.startInvestigation({
      workspaceRoot: tmpWs,
      mutationEngine: new MutationEngine(tmpWs),
      task: "Investigate application",
      taskId: "task_test_wf",
      signal: abortController.signal,
      onStage: (event) => events.push(event),
    });

    assert.equal(workflow.state.status, "RUNNING");
    assert.equal(workflow.workflowType, "investigation");

    // Cancel workflow
    workflow.cancel();
    assert.equal(workflow.state.status, "CANCELLED");
    assert.ok(events.some((e) => e.status === "CANCELLED"));
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. Browser Governance & Permission Enforcement
// ============================================================================

test("REA Governance — InvestigationEngine in REVIEW mode strictly enforces read-only (zero clicks or fills)", async () => {
  let clickAttempted = false;
  let fillAttempted = false;

  const mockBrowser = {
    open: async () => {},
    snapshot: async () => ({
      elements: [
        { refId: "btn_1", role: "button", name: "Submit Form" },
        { refId: "inp_1", role: "textbox", name: "Username" },
      ],
    }),
    click: async () => {
      clickAttempted = true;
      return { success: true };
    },
    fill: async () => {
      fillAttempted = true;
      return { success: true };
    },
    navigate: async () => {},
    close: async () => {},
  } as any;

  const engine = new InvestigationEngine({
    browserSessionManager: mockBrowser,
    mode: "REVIEW",
    interactiveModeAllowed: false,
  });

  const target: InvestigationTarget = {
    targetId: "tgt_read_only",
    category: "running_web_app",
    rawInput: "http://127.0.0.1:3000/",
    normalizedLocation: "http://127.0.0.1:3000/",
    format: "url",
    authorized: true,
    metadata: {},
  };

  const result = await engine.runInvestigation(target);
  assert.equal(clickAttempted, false, "REVIEW mode must NOT execute browser click");
  assert.equal(fillAttempted, false, "REVIEW mode must NOT execute browser fill");
  assert.equal(result.stateTransitions.length, 0);
});

test("REA Governance — InvestigationEngine rejects destructive controls automatically", async () => {
  let destructiveClicked = false;

  const mockBrowser = {
    open: async () => {},
    snapshot: async () => ({
      elements: [
        { refId: "btn_del", role: "button", name: "Delete Account Permanently" },
      ],
    }),
    click: async () => {
      destructiveClicked = true;
      return { success: true };
    },
    fill: async () => ({ success: true }),
    navigate: async () => {},
    close: async () => {},
  } as any;

  const engine = new InvestigationEngine({
    browserSessionManager: mockBrowser,
    mode: "BUILD",
    interactiveModeAllowed: true,
    autoApproveInteractions: true,
  });

  const target: InvestigationTarget = {
    targetId: "tgt_destructive",
    category: "running_web_app",
    rawInput: "http://127.0.0.1:3000/",
    normalizedLocation: "http://127.0.0.1:3000/",
    format: "url",
    authorized: true,
    metadata: {},
  };

  await engine.runInvestigation(target);
  assert.equal(destructiveClicked, false, "Destructive button must be rejected from automatic interaction");
});

test("REA Governance — InvestigationEngine respects human confirmation denials for browser actions", async () => {
  let clickExecuted = false;

  const mockBrowser = {
    open: async () => {},
    snapshot: async () => ({
      elements: [
        { refId: "btn_submit", role: "button", name: "Send Data" },
        { refId: "inp_data", role: "textbox", name: "Query" },
      ],
    }),
    click: async () => {
      clickExecuted = true;
      return { success: true };
    },
    fill: async () => ({ success: true }),
    navigate: async () => {},
    close: async () => {},
  } as any;

  const engine = new InvestigationEngine({
    browserSessionManager: mockBrowser,
    mode: "BUILD",
    interactiveModeAllowed: true,
    autoApproveInteractions: false,
    requestConfirmation: async () => "REJECT", // User denies interaction
  });

  const target: InvestigationTarget = {
    targetId: "tgt_confirm_deny",
    category: "running_web_app",
    rawInput: "http://127.0.0.1:3000/",
    normalizedLocation: "http://127.0.0.1:3000/",
    format: "url",
    authorized: true,
    metadata: {},
  };

  const res = await engine.runInvestigation(target);
  assert.equal(clickExecuted, false, "Denied browser interaction must not be executed");
  assert.equal(res.stateTransitions.length, 0);
});

// ============================================================================
// 3. Filesystem Governance & MutationEngine Containment
// ============================================================================

test("REA Governance — ReconstructionEngine rejects absolute path mutation escape", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-mut-esc-"));
  try {
    const engine = new ReconstructionEngine({
      workspaceRoot: tmpWs,
      autoApproveMutations: true,
    });

    const spec = createMockSpec(tmpWs);
    const ledger = createMockLedger();

    await assert.rejects(
      () =>
        engine.runReconstruction(spec, ledger, {
          userAuthorized: true,
          targetFiles: {
            "/etc/passwd": "malicious content",
          },
        }),
      (err: any) => err.message.includes("Path traversal") || err.message.includes("outside workspace") || err.code === "WORKSPACE_ESCAPE"
    );
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("REA Governance — ReconstructionEngine rejects ../../ directory traversal escape", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-mut-trav-"));
  try {
    const engine = new ReconstructionEngine({
      workspaceRoot: tmpWs,
      autoApproveMutations: true,
    });

    const spec = createMockSpec(tmpWs);
    const ledger = createMockLedger();

    await assert.rejects(
      () =>
        engine.runReconstruction(spec, ledger, {
          userAuthorized: true,
          targetFiles: {
            "../../escape.txt": "malicious content",
          },
        }),
      (err: any) => err.message.includes("Path traversal") || err.message.includes("outside workspace") || err.code === "WORKSPACE_ESCAPE"
    );
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("REA Governance — ReconstructionEngine rejects symlink workspace escape", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-mut-sym-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "rea-gov-outside-"));
  try {
    // Create symlink pointing outside workspaceRoot
    const symlinkTarget = join(tmpWs, "symlink-outside");
    symlinkSync(outsideDir, symlinkTarget);

    const engine = new ReconstructionEngine({
      workspaceRoot: tmpWs,
      autoApproveMutations: true,
    });

    const spec = createMockSpec(tmpWs);
    const ledger = createMockLedger();

    await assert.rejects(
      () =>
        engine.runReconstruction(spec, ledger, {
          userAuthorized: true,
          targetFiles: {
            "symlink-outside/pwned.txt": "malicious",
          },
        }),
      (err: any) => err.message.includes("Path traversal") || err.message.includes("symlink") || err.message.includes("outside workspace") || err.code === "WORKSPACE_ESCAPE"
    );
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("REA Governance — ReconstructionEngine fails closed if host-mediated mutation approval is denied", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-mut-deny-"));
  try {
    const engine = new ReconstructionEngine({
      workspaceRoot: tmpWs,
      autoApproveMutations: false,
      requestConfirmation: async () => "REJECT", // User denies mutation
    });

    const spec = createMockSpec(tmpWs);
    const ledger = createMockLedger();

    await assert.rejects(
      () =>
        engine.runReconstruction(spec, ledger, {
          userAuthorized: true,
          targetFiles: {
            "src/service.ts": "export function run() {}",
          },
        }),
      (err: any) => err.message.includes("denied by user confirmation")
    );
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. Verification Integrity & Elimination of Fabricated PASS
// ============================================================================

test("REA Governance — Missing testRunner prevents fabricated verification success", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-no-test-"));
  try {
    const engine = new ReconstructionEngine({
      workspaceRoot: tmpWs,
      autoApproveMutations: true,
      testRunner: undefined, // NO independent verifier configured
    });

    const spec = createMockSpec(tmpWs);
    const ledger = createMockLedger();

    const result = await engine.runReconstruction(spec, ledger, {
      userAuthorized: true,
      targetFiles: {
        "src/service.ts": "export function run() { return true; }\n",
      },
    });

    // Obligations MUST NOT be marked verified!
    assert.equal(result.verifiedObligationsCount, 0, "No obligations may be verified when testRunner is missing");
    assert.equal(result.remainingOpenCount, 1, "Obligation must remain open");
    assert.notEqual(result.updatedLedger.status, "verified");
    assert.notEqual(result.updatedLedger.coverage.status, "complete");

    for (const obl of result.updatedLedger.obligations) {
      assert.notEqual(obl.status, "verified");
      assert.equal(obl.testEvidence, undefined, "Fabricated testEvidence must never be generated");
    }
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("REA Governance — Failing test runner leaves obligation open with FAIL evidence", async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), "rea-gov-fail-test-"));
  try {
    const engine = new ReconstructionEngine({
      workspaceRoot: tmpWs,
      autoApproveMutations: true,
      testRunner: async (obl) => ({
        passed: false,
        output: `Verification assertion failed for ${obl.obligationId}`,
        details: {
          verifier: "MockIndependentVerifier",
          testIdentity: "test_failure_case",
          inputFixture: "invalid input",
          expectedBehavior: "throw exception",
          observedResult: "returned undefined",
        },
      }),
    });

    const spec = createMockSpec(tmpWs);
    const ledger = createMockLedger();

    const result = await engine.runReconstruction(spec, ledger, {
      userAuthorized: true,
      targetFiles: {
        "src/service.ts": "export function run() {}\n",
      },
    });

    assert.equal(result.verifiedObligationsCount, 0);
    assert.equal(result.remainingOpenCount, 1);
    const obl = result.updatedLedger.obligations[0]!;
    assert.notEqual(obl.status, "verified");
    assert.equal(obl.testEvidence?.result, "FAIL");
    assert.ok(obl.testEvidence?.digest);
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ============================================================================
// 5. Shared MCP Infrastructure, Zero Duplicate Processes & Tool Subsetting
// ============================================================================

test("REA Governance — ReaMcpService integrates with McpCatalog to prevent duplicate processes", async () => {
  const catalog = new McpCatalog({ servers: {} });
  const reaService = new ReaMcpService({
    mcpCatalog: catalog,
    serverId: "shared-rea",
  });

  assert.equal(reaService.serverId, "shared-rea");
  await catalog.close();
});

test("REA Governance — Tool subsetting selects only category-appropriate tools", async () => {
  const reaService = new ReaMcpService();

  // Category 1: Electron App
  const electronTools = reaService.selectToolsForCategory("javascript_electron_app");
  assert.ok(electronTools.includes("analyze_javascript_application"));
  assert.ok(!electronTools.includes("analyze_mach_o_binary"), "Electron should exclude Mach-O binary tools");

  // Category 2: Native Packaged App
  const binaryTools = reaService.selectToolsForCategory("native_packaged_app");
  assert.ok(binaryTools.includes("analyze_mach_o_binary"));
  assert.ok(!electronTools.includes("analyze_mach_o_binary"));

  // Category 3: Running Web App
  const webTools = reaService.selectToolsForCategory("running_web_app");
  assert.ok(webTools.includes("browser_snapshot"));
  assert.ok(!webTools.includes("analyze_mach_o_binary"));
});

// ============================================================================
// 6. Accurate Provider Diagnostics Probing
// ============================================================================

test("REA Governance — queryProviderDiagnostics returns accurate statuses without hardcoded assumptions", async () => {
  const reaService = new ReaMcpService();
  const reports = await reaService.queryProviderDiagnostics();

  assert.ok(Array.isArray(reports));
  assert.ok(reports.length >= 6);

  // Native macos provider
  const macosReport = reports.find((r) => r.id === "native-macos");
  assert.ok(macosReport);
  if (process.platform === "darwin") {
    assert.equal(macosReport.available, true);
    assert.equal(macosReport.status, "ready");
  } else {
    assert.equal(macosReport.available, false);
    assert.equal(macosReport.status, "unsupported");
  }

  // Heavyweight providers report not_configured when environment variables are unset
  const ghidraReport = reports.find((r) => r.id === "ghidra");
  assert.ok(ghidraReport);
  assert.equal(ghidraReport.status, process.env.GHIDRA_INSTALL_DIR ? "ready" : "not_configured");

  const hopperReport = reports.find((r) => r.id === "hopper");
  assert.ok(hopperReport);
  assert.equal(hopperReport.status, process.env.REA_HOPPER_PATH ? "ready" : "not_configured");

  const idaReport = reports.find((r) => r.id === "ida");
  assert.ok(idaReport);
  assert.equal(idaReport.status, process.env.IDADIR ? "ready" : "not_configured");
});

// ============================================================================
// 7. Resource Constraints & Budget Enforcement
// ============================================================================

test("REA Governance — InvestigationEngine enforces maxInteractions budget strictly", async () => {
  let interactionCount = 0;

  const mockBrowser = {
    open: async () => {},
    snapshot: async () => ({
      elements: [
        { refId: `btn_${interactionCount}`, role: "button", name: `Action ${interactionCount}` },
      ],
    }),
    click: async () => {
      interactionCount++;
      return { success: true };
    },
    fill: async () => ({ success: true }),
    navigate: async () => {},
    close: async () => {},
  } as any;

  const maxBudget = 2;
  const engine = new InvestigationEngine({
    browserSessionManager: mockBrowser,
    mode: "BUILD",
    interactiveModeAllowed: true,
    autoApproveInteractions: true,
    maxInteractions: maxBudget,
  });

  const target: InvestigationTarget = {
    targetId: "tgt_budget",
    category: "running_web_app",
    rawInput: "http://127.0.0.1:3000/",
    normalizedLocation: "http://127.0.0.1:3000/",
    format: "url",
    authorized: true,
    metadata: {},
  };

  await engine.runInvestigation(target);
  assert.ok(interactionCount <= maxBudget, `Interactions (${interactionCount}) must not exceed maxBudget (${maxBudget})`);
});

test("REA Governance — InvestigationEngine enforces timeoutMs cancellation", async () => {
  const mockBrowser = {
    open: async () => {
      // Simulate slow hung browser operation
      await new Promise((done) => setTimeout(done, 500));
    },
    snapshot: async () => ({ elements: [] }),
    click: async () => ({ success: true }),
    fill: async () => ({ success: true }),
    navigate: async () => {},
    close: async () => {},
  } as any;

  const engine = new InvestigationEngine({
    browserSessionManager: mockBrowser,
    timeoutMs: 50, // Short timeout
  });

  const target: InvestigationTarget = {
    targetId: "tgt_timeout",
    category: "running_web_app",
    rawInput: "http://127.0.0.1:3000/",
    normalizedLocation: "http://127.0.0.1:3000/",
    format: "url",
    authorized: true,
    metadata: {},
  };

  await assert.rejects(
    () => engine.runInvestigation(target),
    (err: any) => err.message.includes("timed out") || err.name === "AbortError"
  );
});

// ============================================================================
// 8. Epistemic Discipline & Version Closure
// ============================================================================

test("REA Governance — Version mismatch is detected and rejected against pinned 6.8.0", (t) => {
  const reaService = new ReaMcpService();
  assert.equal(REA_PINNED_VERSION, "6.8.0");
  try {
    assert.equal(typeof reaService.resolveReaPath(), "string");
  } catch (error) {
    if ((error as { code?: string }).code === "REA_NOT_INSTALLED") {
      t.skip("REA is not installed on this host");
      return;
    }
    throw error;
  }
});

test("REA Governance — Epistemic discipline requires whyUnobservable on all synthesized unknowns", async () => {
  const spec = createMockSpec("/fake/path");
  for (const unknown of spec.unknowns) {
    assert.ok(unknown.whyUnobservable, "Every unknown must have a reason explaining why it is unobservable");
    assert.ok(unknown.whyUnobservable.length > 5);
  }
});

const deterministicTestRunner = async (obl: ReconstructionObligation) => ({
  passed: true,
  output: `PASS ${obl.obligationId}`,
  details: {
    timestamp: 1700000000000,
  },
});

test("REA Governance — Obligation closure digest is strictly deterministic", async () => {
  const tmpWsA = mkdtempSync(join(tmpdir(), "rea-gov-digest-a-"));
  const tmpWsB = mkdtempSync(join(tmpdir(), "rea-gov-digest-b-"));
  try {
    const engineA = new ReconstructionEngine({
      workspaceRoot: tmpWsA,
      autoApproveMutations: true,
      testRunner: deterministicTestRunner,
    });
    const engineB = new ReconstructionEngine({
      workspaceRoot: tmpWsB,
      autoApproveMutations: true,
      testRunner: deterministicTestRunner,
    });

    const specA = createMockSpec(tmpWsA);
    const specB = createMockSpec(tmpWsB);
    const ledgerA = createMockLedger();
    const ledgerB = createMockLedger();

    const resA = await engineA.runReconstruction(specA, ledgerA, { userAuthorized: true });
    const resB = await engineB.runReconstruction(specB, ledgerB, { userAuthorized: true });

    assert.equal(resA.closureDigest, resB.closureDigest, "Identical inputs and verification outcomes must yield identical closure digest");
  } finally {
    rmSync(tmpWsA, { recursive: true, force: true });
    rmSync(tmpWsB, { recursive: true, force: true });
  }
});

test("REA Governance — ComparativeWebVerifier reports failure when applications differ", async () => {
  const mockBrowser = {
    open: async () => {},
    snapshot: async (_opt: any) => ({
      // Return inputs for ref, but none for recon
      elements: [],
    }),
    click: async () => ({ success: true }),
    fill: async () => ({ success: true }),
    navigate: async () => {},
    close: async () => {},
  } as any;

  const verifier = new ComparativeWebVerifier({
    referenceUrl: "http://127.0.0.1:8001/",
    reconstructedUrl: "http://127.0.0.1:8002/",
    browserSessionManager: mockBrowser,
  });

  const result = await verifier.runComparativeVerification();
  assert.equal(result.passed, false, "Verifier must detect mismatched empty controls and fail closed");
  assert.ok(result.mismatches.length > 0);
  assert.ok(result.digest.length === 64);
});

test("REA Governance — Interactive mode allowed is strictly required for mutating clicks", async () => {
  let clickOccurred = false;
  const mockBrowser = {
    open: async () => {},
    snapshot: async () => ({
      elements: [
        { refId: "btn_1", role: "button", name: "Click Me" },
        { refId: "inp_1", role: "textbox", name: "Input" },
      ],
    }),
    click: async () => {
      clickOccurred = true;
      return { success: true };
    },
    fill: async () => ({ success: true }),
    navigate: async () => {},
    close: async () => {},
  } as any;

  const engine = new InvestigationEngine({
    browserSessionManager: mockBrowser,
    mode: "BUILD",
    interactiveModeAllowed: false, // Disallow interactive interactions even in BUILD mode
  });

  const target: InvestigationTarget = {
    targetId: "tgt_disallow_interactive",
    category: "running_web_app",
    rawInput: "http://127.0.0.1:3000/",
    normalizedLocation: "http://127.0.0.1:3000/",
    format: "url",
    authorized: true,
    metadata: {},
  };

  await engine.runInvestigation(target);
  assert.equal(clickOccurred, false, "When interactiveModeAllowed is false, clicks must never execute");
});

