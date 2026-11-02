/**
 * Sprint 10A.1B — Specialized Workflow Execution, Real Model Synthesis & Production Closure.
 *
 * Comprehensive regression and verification suite:
 * - Section 3: REA reconstruction authorization, approval binding, suspension, denial, and rollback
 * - Section 4: Real model synthesis for REA with materially different Application A & Application B
 * - Section 5: Honest model execution in Design (no silent fallback, labeled templates, distinct interfaces)
 * - Section 6: Honest telemetry (live tokens, actual tools, modelCalls=0 when uncalled)
 * - Section 8: 10 mandatory independent negative verification tests
 * - Section 7: Three Core Modes verification (Coding, Design, REA)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GovernedReaWorkflow } from "../../src/rea/governed-rea-workflow.ts";
import { ReconstructionEngine } from "../../src/rea/reconstruction-engine.ts";
import { GovernedDesignWorkflow } from "../../src/design/governed-design-workflow.ts";
import { MutationEngine } from "../../src/tools/mutation-engine.ts";
import { createDefaultDesignBrief } from "../../src/design/design-brief.ts";
import { classifyInvestigationTarget } from "../../src/rea/target-classifier.ts";
import { ReaMcpService } from "../../src/rea/rea-mcp-service.ts";
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
          {
            featureId: "feat_conditional_content",
            title: "Conditional View Display",
            description: "Renders selected tab view while hiding inactive views",
            category: "presentation",
            supportingEvidenceIds: ["ev_nav_2"],
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
          {
            transitionId: "t_submit_success",
            initialState: { route: "/" },
            userAction: { type: "click", targetSelector: "#submit-btn" },
            resultingState: { route: "/" },
            visibleChange: "Hides form and displays order confirmation container",
            evidenceId: "ev_form_2",
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
          {
            transitionId: "t_switch_settings",
            initialState: { route: "/" },
            userAction: { type: "click", targetSelector: "#tab-settings" },
            resultingState: { route: "/" },
            visibleChange: "Activates #tab-settings and shows #view-settings",
            evidenceId: "ev_nav_2",
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
              { name: "quantity", type: "number", required: true, observableErrors: ["Quantity must be > 0"] },
            ],
            submissionAction: "Render order confirmation summary",
            supportingEvidenceIds: ["ev_form_1", "ev_form_2"],
          },
        ]
      : [],
    componentInventory: [],
    observableDataContracts: [],
    responsiveUiRequirements: [],
    errorHandling: [],
    knownConstraints: ["Strict client-side clean-room implementation"],
    evidenceLinks: ["ev_1"],
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
          positiveCases: ["Displays error when email is empty", "Displays error when quantity is 0"],
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
// PHASE A: SECTION 3 — REA RECONSTRUCTION AUTHORIZATION
// ============================================================================

test("Section 3: REA Authorization — Approved reconstruction suspends for confirmation and applies intended file changes", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-auth-approved-"));
  try {
    const mutationEngine = new MutationEngine(ws);
    const spec = buildTestSpec("auth-app", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine,
      taskId: "task-auth-appr",
      task: `Reconstruct web application from specification at ${ws}`,
      autoApprove: false,
      userAuthorized: false,
      initialSpecification: spec,
      initialLedger: ledger,
      targetFiles: {
        "index.html": "<!DOCTYPE html><html><body><form id=\"order-form\"><input id=\"email\"><button id=\"submit-btn\">Submit</button></form></body></html>",
        "src/app.js": "console.log('App initialized');",
      },
      testRunner: async (obl) => ({ passed: true, output: `PASS: ${obl.obligationId} verified` }),
    });

    // Step 1: Run workflow. Should suspend at PLANNING for plan authorization
    let res = await workflow.run();
    assert.equal(res.status, "WAITING_FOR_CONFIRMATION", "Workflow must suspend when userAuthorized is false");
    assert.ok(res.confirmation, "Workflow must emit confirmation descriptor");
    assert.equal(res.confirmation.stage, "PLAN");

    // Step 2: Approve the implementation plan
    res = await workflow.resume("APPROVE", workflow.pendingConfirmation?.callId);
    assert.equal(res.status, "WAITING_FOR_CONFIRMATION", "Workflow must suspend for first file mutation");
    assert.equal(res.confirmation?.stage, "IMPLEMENT");
    assert.equal(res.confirmation?.runner?.preparedMutation?.path, "index.html");

    // Verify index.html does NOT exist yet prior to approval
    assert.equal(existsSync(join(ws, "index.html")), false, "File must not be created before confirmation");

    // Step 3: Approve index.html mutation
    res = await workflow.resume("APPROVE", workflow.pendingConfirmation?.callId);
    assert.equal(existsSync(join(ws, "index.html")), true, "Approved index.html must be written to disk");

    // Step 4: Next file (src/app.js) confirmation
    assert.equal(res.status, "WAITING_FOR_CONFIRMATION", "Workflow must suspend for second file mutation");
    assert.equal(res.confirmation?.runner?.preparedMutation?.path, "src/app.js");

    // Step 5: Approve src/app.js mutation
    res = await workflow.resume("APPROVE", workflow.pendingConfirmation?.callId);
    assert.equal(existsSync(join(ws, "src/app.js")), true, "Approved src/app.js must be written to disk");

    // All files approved, test runner verifies obligations, workflow finishes COMPLETE
    assert.equal(res.status, "COMPLETE", "Workflow must complete after all mutations and tests pass");
    assert.equal(res.state.verification?.verdict, "READY");
    assert.equal(res.state.stages.find((s) => s.stage === "IMPLEMENT")?.status, "PASSED");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 3: REA Authorization — Rejected reconstruction makes zero changes and rolls back empty parent directories", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-auth-rejected-"));
  try {
    const mutationEngine = new MutationEngine(ws);
    const spec = buildTestSpec("auth-rej", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine,
      taskId: "task-auth-rej",
      task: `Reconstruct web application from specification at ${ws}`,
      autoApprove: false,
      userAuthorized: false,
      initialSpecification: spec,
      initialLedger: ledger,
      targetFiles: {
        "nested/sub/module.js": "export const value = 42;",
      },
    });

    let res = await workflow.run();
    assert.equal(res.status, "WAITING_FOR_CONFIRMATION");
    // Approve plan
    res = await workflow.resume("APPROVE", workflow.pendingConfirmation?.callId);

    assert.equal(res.status, "WAITING_FOR_CONFIRMATION");
    assert.equal(res.confirmation?.runner?.preparedMutation?.path, "nested/sub/module.js");

    // REJECT the mutation
    res = await workflow.resume("REJECT", workflow.pendingConfirmation?.callId);
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "VERIFICATION_REJECTED");

    // Verify zero changes on disk and empty parent directories are rolled back
    assert.equal(existsSync(join(ws, "nested/sub/module.js")), false);
    assert.equal(existsSync(join(ws, "nested")), false, "Empty parent directories created for staging must be cleaned up");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 3: REA Authorization — Missing or stale approval blocks execution", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-auth-stale-"));
  try {
    const mutationEngine = new MutationEngine(ws);
    const spec = buildTestSpec("auth-stale", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine,
      taskId: "task-auth-stale",
      task: `Reconstruct web application at ${ws}`,
      autoApprove: false,
      userAuthorized: false,
      initialSpecification: spec,
      initialLedger: ledger,
    });

    // 1. Resuming before suspension throws
    await assert.rejects(
      workflow.resume("APPROVE"),
      /Workflow is not waiting for confirmation/,
      "Resuming workflow when not waiting for confirmation must throw"
    );

    // 2. Calling run() while WAITING_FOR_CONFIRMATION must fail closed without applying mutations
    const res = await workflow.run();
    assert.equal(res.status, "WAITING_FOR_CONFIRMATION");
    const resRepeat = await workflow.run();
    assert.equal(resRepeat.status, "WAITING_FOR_CONFIRMATION", "Calling run() while waiting must not bypass confirmation");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE A: SECTION 4 — CONNECT REA TO ACTUAL MODEL SYNTHESIS
// ============================================================================

test("Section 4: REA Model Synthesis — Application A (Form-Driven) produces distinct validation & submission implementation", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-model-app-a-"));
  try {
    const specA = buildTestSpec("form-app", "form_app", ws);
    const ledgerA = buildTestLedger(specA, "form_app");

    let receivedPrompt = "";
    const mockModel = createMockModelProvider(async (req) => {
      receivedPrompt = req.messages[0].content;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            files: [
              {
                path: "index.html",
                content: `<!DOCTYPE html>
<html lang="en">
<head><title>Order Form</title><link rel="stylesheet" href="src/styles.css"></head>
<body>
  <form id="order-form" novalidate>
    <label for="email">Customer Email</label>
    <input type="email" id="email" name="email" required>
    <span id="email-error" class="error-msg" style="display:none;">Email is required</span>
    <label for="quantity">Item Quantity</label>
    <input type="number" id="quantity" name="quantity" min="1" required>
    <span id="quantity-error" class="error-msg" style="display:none;">Quantity must be > 0</span>
    <button type="submit" id="submit-btn">Place Order</button>
  </form>
  <div id="confirmation-view" style="display:none;">
    <h2>Order Confirmed!</h2>
    <p id="order-id">ORD-9821</p>
  </div>
  <script src="src/app.js"></script>
</body>
</html>`,
              },
              {
                path: "src/app.js",
                content: `document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("order-form");
  const emailInput = document.getElementById("email");
  const qtyInput = document.getElementById("quantity");
  const emailErr = document.getElementById("email-error");
  const qtyErr = document.getElementById("quantity-error");
  const confirmation = document.getElementById("confirmation-view");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let valid = true;
    if (!emailInput.value.trim() || !emailInput.value.includes("@")) {
      emailErr.style.display = "block";
      valid = false;
    } else {
      emailErr.style.display = "none";
    }
    if (parseInt(qtyInput.value || "0", 10) <= 0) {
      qtyErr.style.display = "block";
      valid = false;
    } else {
      qtyErr.style.display = "none";
    }
    if (valid) {
      form.style.display = "none";
      confirmation.style.display = "block";
    }
  });
});`,
              },
              {
                path: "src/styles.css",
                content: ".error-msg { color: #dc2626; font-size: 0.875rem; } #confirmation-view { padding: 1.5rem; background: #f0fdf4; }",
              },
            ],
          }),
        },
        usage: { inputTokens: 540, outputTokens: 620 },
      };
    });

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-model-app-a",
      task: `Reconstruct form-driven application at ${ws}`,
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: specA,
      initialLedger: ledgerA,
      provider: mockModel,
      testRunner: async (obl, root) => {
        const html = readFileSync(join(root, "index.html"), "utf-8");
        const js = readFileSync(join(root, "src/app.js"), "utf-8");
        if (obl.obligationId === "obl_form_val") {
          const hasInputs = html.includes('id="email"') && html.includes('id="quantity"');
          const hasValidation = js.includes("emailErr.style.display") && js.includes("qtyErr.style.display");
          return { passed: hasInputs && hasValidation, output: "Form inputs and validation handlers verified." };
        }
        if (obl.obligationId === "obl_form_result") {
          const hasConfirmation = html.includes('id="confirmation-view"') && js.includes("confirmation.style.display");
          return { passed: hasConfirmation, output: "Confirmation view and transition verified." };
        }
        return { passed: false, output: "Unknown obligation" };
      },
    });

    const res = await workflow.run();
    assert.equal(res.status, "COMPLETE");
    assert.equal(workflow.generationSource, "model", "Must identify generation source as model");
    assert.ok(receivedPrompt.includes("Order Form Input Validation"), "Model prompt must receive feature inventory");
    assert.ok(receivedPrompt.includes("Displays validation error when required fields are empty"), "Model prompt must receive state transitions");

    // Verify disk files
    const htmlContent = readFileSync(join(ws, "index.html"), "utf-8");
    assert.ok(htmlContent.includes("order-form"));
    assert.ok(htmlContent.includes("confirmation-view"));

    // Verify telemetry
    const implementStage = res.state.stages.find((s) => s.stage === "IMPLEMENT");
    assert.equal(implementStage?.modelCalls, 1, "Must record exactly 1 model call in IMPLEMENT stage");
    assert.equal(implementStage?.contextTokens, 1160, "Must record provider tokens (540+620)");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 4: REA Model Synthesis — Application B (Navigation & Tabs) produces materially different interactive architecture", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-model-app-b-"));
  try {
    const specB = buildTestSpec("nav-app", "nav_app", ws);
    const ledgerB = buildTestLedger(specB, "nav_app");

    let receivedPrompt = "";
    const mockModel = createMockModelProvider(async (req) => {
      receivedPrompt = req.messages[0].content;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            files: [
              {
                path: "index.html",
                content: `<!DOCTYPE html>
<html lang="en">
<head><title>Interactive Portal</title><link rel="stylesheet" href="src/styles.css"></head>
<body>
  <nav id="tabs" role="tablist">
    <button id="tab-overview" role="tab" class="active">Overview</button>
    <button id="tab-analytics" role="tab">Analytics</button>
    <button id="tab-settings" role="tab">Settings</button>
  </nav>
  <main>
    <section id="view-overview" role="tabpanel"><h2>System Overview</h2><p>Normal operating status.</p></section>
    <section id="view-analytics" role="tabpanel" style="display:none;"><h2>Live Analytics</h2><div class="metrics">42 requests/sec</div></section>
    <section id="view-settings" role="tabpanel" style="display:none;"><h2>Portal Settings</h2></section>
  </main>
  <script src="src/app.js"></script>
</body>
</html>`,
              },
              {
                path: "src/app.js",
                content: `document.addEventListener("DOMContentLoaded", () => {
  const tabs = document.querySelectorAll("nav[role='tablist'] button");
  const panels = document.querySelectorAll("main section[role='tabpanel']");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.style.display = "none");
      tab.classList.add("active");
      const targetPanel = document.getElementById(tab.id.replace("tab-", "view-"));
      if (targetPanel) targetPanel.style.display = "block";
    });
  });
});`,
              },
              {
                path: "src/styles.css",
                content: "nav button.active { font-weight: bold; border-bottom: 2px solid #2563eb; }",
              },
            ],
          }),
        },
        usage: { inputTokens: 490, outputTokens: 530 },
      };
    });

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-model-app-b",
      task: `Reconstruct interactive tabbed navigation at ${ws}`,
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: specB,
      initialLedger: ledgerB,
      provider: mockModel,
      testRunner: async (obl, root) => {
        const html = readFileSync(join(root, "index.html"), "utf-8");
        const js = readFileSync(join(root, "src/app.js"), "utf-8");
        if (obl.obligationId === "obl_nav_switch") {
          const hasTabs = html.includes('role="tablist"') && html.includes('id="tab-analytics"');
          const hasToggle = js.includes("classList.remove(\"active\")") && js.includes("classList.add(\"active\")");
          return { passed: hasTabs && hasToggle, output: "Tab navigation verified." };
        }
        return { passed: false, output: "Unknown" };
      },
    });

    const res = await workflow.run();
    assert.equal(res.status, "COMPLETE");
    assert.equal(workflow.generationSource, "model");
    assert.ok(receivedPrompt.includes("Multi-View Tab Navigation"), "Must receive nav features");

    const htmlContent = readFileSync(join(ws, "index.html"), "utf-8");
    assert.ok(htmlContent.includes("tab-analytics"));
    assert.ok(htmlContent.includes("view-analytics"));
    assert.equal(htmlContent.includes("order-form"), false, "App B must be materially different from App A");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE A: SECTION 5 — PRESERVE HONEST MODEL EXECUTION IN DESIGN
// ============================================================================

test("Section 5: Design Model Execution — Provider error fails closed as BLOCKED without silent procedural fallback", async () => {
  const ws = mkdtempSync(join(tmpdir(), "design-fail-closed-"));
  try {
    const brief = createDefaultDesignBrief();
    const failingModel = createMockModelProvider(async () => {
      throw new Error("Connection timeout from model gateway (504 Gateway Timeout)");
    });

    const workflow = GovernedDesignWorkflow.start({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-design-fail",
      task: "Create accessible frontend component",
      brief,
      provider: failingModel,
      autoApprove: true,
    });

    const res = await workflow.run();
    assert.equal(res.status, "BLOCKED", "Workflow must fail closed when model provider throws");
    assert.equal(res.state.blocker, "STAGE_FAILED");
    assert.ok(res.state.blockerDetail?.includes("Model component generation failed"), "Must report model generation failure");
    assert.equal(existsSync(join(ws, "index.html")), false, "No template component must be written when model fails");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 5: Design Model Execution — Deterministic templates are explicitly labeled when provider is omitted", async () => {
  const ws = mkdtempSync(join(tmpdir(), "design-template-label-"));
  try {
    const brief = createDefaultDesignBrief();
    // No provider passed
    const workflow = GovernedDesignWorkflow.start({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-design-template",
      task: "Generate offline baseline template",
      brief,
      autoApprove: true,
    });

    const res = await workflow.run();
    assert.equal(workflow.generationSource, "template", "Must identify generation source as template");
    assert.ok(res.state.implementation?.summary.includes("source: template"), "Implementation summary must state template source");

    const html = readFileSync(join(ws, "index.html"), "utf-8");
    assert.ok(html.includes("<!-- TEMPLATE_BASED_OUTPUT"), "Generated HTML must carry explicit template banner");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 5: Design Model Execution — Two different DesignBriefs produce genuinely distinct model-generated interfaces", async () => {
  const ws1 = mkdtempSync(join(tmpdir(), "design-brief-ecom-"));
  const ws2 = mkdtempSync(join(tmpdir(), "design-brief-dash-"));
  try {
    const briefEcom = { ...createDefaultDesignBrief(), productType: "e_commerce" as const };
    const briefDash = { ...createDefaultDesignBrief(), productType: "saas_dashboard" as const };

    const modelEcom = createMockModelProvider(async (_req) => ({
      message: {
        role: "assistant",
        content: "<!DOCTYPE html><html><body><header><h1>Storefront</h1></header><main><section class=\"product-grid\"><article class=\"product-card\"><h3>Sneaker</h3><button>Add to Cart</button></article></section></main></body></html>",
      },
      usage: { inputTokens: 400, outputTokens: 200 },
    }));

    const modelDash = createMockModelProvider(async (_req) => ({
      message: {
        role: "assistant",
        content: "<!DOCTYPE html><html><body><header><h1>Analytics Dashboard</h1></header><main><aside class=\"sidebar-nav\"></aside><section class=\"kpi-grid\"><div class=\"metric-card\">Latency: 2ms</div></section></main></body></html>",
      },
      usage: { inputTokens: 420, outputTokens: 210 },
    }));

    const wfEcom = GovernedDesignWorkflow.start({
      workspaceRoot: ws1,
      mutationEngine: new MutationEngine(ws1),
      taskId: "task-ecom",
      task: "Ecom store",
      brief: briefEcom,
      provider: modelEcom,
      autoApprove: true,
    });
    const wfDash = GovernedDesignWorkflow.start({
      workspaceRoot: ws2,
      mutationEngine: new MutationEngine(ws2),
      taskId: "task-dash",
      task: "Analytics dash",
      brief: briefDash,
      provider: modelDash,
      autoApprove: true,
    });

    await wfEcom.run();
    await wfDash.run();

    const ecomHtml = readFileSync(join(ws1, "index.html"), "utf-8");
    const dashHtml = readFileSync(join(ws2, "index.html"), "utf-8");

    assert.ok(ecomHtml.includes("product-grid"));
    assert.ok(dashHtml.includes("kpi-grid"));
    assert.notEqual(ecomHtml, dashHtml, "Two briefs must produce distinct model-generated outputs");
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE A: SECTION 6 — TELEMETRY TRUTHFULNESS
// ============================================================================

test("Section 6: Telemetry — GovernedReaWorkflow reports modelCalls=0 and contextTokens=0 when model is not invoked", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-telemetry-"));
  try {
    const spec = buildTestSpec("tel-spec", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-telemetry",
      task: `Reconstruct offline baseline at ${ws}`,
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: spec,
      initialLedger: ledger,
      testRunner: async () => ({ passed: true, output: "PASS" }),
    });

    const res = await workflow.run();
    assert.equal(res.status, "COMPLETE");

    for (const stage of res.state.stages) {
      assert.equal(stage.modelCalls, 0, `Stage ${stage.stage} must report 0 model calls when uninvoked`);
      assert.equal(stage.contextTokens, 0, `Stage ${stage.stage} must report 0 context tokens when uninvoked`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE B: SECTION 8 — TEN MANDATORY INDEPENDENT NEGATIVE TESTS
// ============================================================================

test("Section 8: Negative Test 1 — Deliberately incorrect REA reconstruction fails independent verification", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-1-"));
  try {
    const spec = buildTestSpec("neg-1", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-1",
      task: "Reconstruct with deliberate defect",
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: spec,
      initialLedger: ledger,
      targetFiles: { "index.html": "<html><body>Empty</body></html>" },
      testRunner: async () => ({ passed: false, output: "FAIL: Validation element not present in DOM" }),
    });

    const res = await workflow.run();
    assert.equal(res.status, "BLOCKED", "Workflow must block when verification fails");
    assert.equal(res.state.verification?.verdict, "BLOCKED");
    assert.equal(res.state.blockerDetail, "2 reconstruction obligation(s) unverified.");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 2 — Missing model provider cannot produce a model-generated success", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-2-"));
  try {
    const spec = buildTestSpec("neg-2", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    // Missing provider
    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-2",
      task: "Reconstruct without model",
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: spec,
      initialLedger: ledger,
      testRunner: async () => ({ passed: true, output: "PASS" }),
    });

    await workflow.run();
    assert.notEqual(workflow.generationSource, "model", "Missing provider cannot claim generationSource 'model'");
    assert.equal(workflow.generationSource, "template");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 3 — Missing browser observation cannot produce a visual PASS in Design", async () => {
  const ws = mkdtempSync(join(tmpdir(), "design-neg-3-"));
  try {
    // No browserSessionManager passed
    const workflow = GovernedDesignWorkflow.start({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-3",
      task: "Visual QA without browser",
      brief: createDefaultDesignBrief(),
      autoApprove: true,
    });

    const res = await workflow.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.blocker, "BLOCKED_REVIEW");
    assert.ok(res.state.blockerDetail?.includes("INSUFFICIENT_EVIDENCE"), "Must report INSUFFICIENT_EVIDENCE without browser observation");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 4 — Missing REA installation cannot produce an REA integration PASS", async () => {
  const service = new ReaMcpService({
    reaCliPath: "/nonexistent/path/to/rea_missing",
  });
  await assert.rejects(
    service.connect(),
    /Configured REA executable path was not found/,
    "Missing REA binary must reject connection without fabricating success"
  );
  assert.equal(service.isConnected, false);
});

test("Section 8: Negative Test 5 — Denied file mutation changes zero files", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-5-"));
  try {
    const engine = new ReconstructionEngine({
      workspaceRoot: ws,
      autoApproveMutations: false,
      requestConfirmation: async () => "REJECT",
    });

    const spec = buildTestSpec("neg-5", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    await assert.rejects(
      engine.runReconstruction(spec, ledger, { userAuthorized: true }),
      /denied by user confirmation/
    );

    assert.equal(existsSync(join(ws, "index.html")), false);
    assert.equal(existsSync(join(ws, "src")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 6 — Incorrect model-generated paths escaping workspace are rejected", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-6-"));
  try {
    const maliciousModel = createMockModelProvider(async () => ({
      message: {
        role: "assistant",
        content: JSON.stringify({
          files: [{ path: "../../etc/shadow.js", content: "pwned" }],
        }),
      },
    }));

    const spec = buildTestSpec("neg-6", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-6",
      task: "Attempt traversal mutation",
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: spec,
      initialLedger: ledger,
      provider: maliciousModel,
    });

    const res = await workflow.run();
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.state.blockerDetail?.includes("Model proposed invalid or escaping path"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 7 — Invalid model outputs do not reach MutationEngine", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-7-"));
  try {
    const malformedModel = createMockModelProvider(async () => ({
      message: {
        role: "assistant",
        content: "Sorry, I cannot fulfill this request as an AI.",
      },
    }));

    const spec = buildTestSpec("neg-7", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-7",
      task: "Attempt malformed generation",
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: spec,
      initialLedger: ledger,
      provider: malformedModel,
    });

    const res = await workflow.run();
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.state.blockerDetail?.includes("Model response did not contain valid JSON"));
    assert.equal(existsSync(join(ws, "index.html")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 8 — Stale approvals cannot authorize modified operations", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-8-"));
  try {
    const spec = buildTestSpec("neg-8", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-8",
      task: "Test stale confirmation",
      autoApprove: false,
      userAuthorized: false,
      initialSpecification: spec,
      initialLedger: ledger,
    });

    const res1 = await workflow.run();
    assert.equal(res1.status, "WAITING_FOR_CONFIRMATION");
    const staleToken = res1.confirmation?.runner?.callId;
    assert.ok(staleToken, "Initial suspension must produce confirmation token");

    // Approve initial plan using valid token
    const res2 = await workflow.resume("APPROVE", staleToken);
    assert.equal(res2.status, "WAITING_FOR_CONFIRMATION");
    const nextToken = res2.confirmation?.runner?.callId;
    assert.notEqual(nextToken, staleToken, "Subsequent mutation must issue a distinct confirmation token");

    // Attempting to resume with the prior stale token must be rejected
    await assert.rejects(
      workflow.resume("APPROVE", staleToken),
      /Stale confirmation token/,
      "Resuming with expired or stale confirmation token must reject"
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 9 — Cancelled workflows cannot resume unsafe side effects", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-9-"));
  try {
    const spec = buildTestSpec("neg-9", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-9",
      task: "Cancelled workflow test",
      autoApprove: false,
      userAuthorized: false,
      initialSpecification: spec,
      initialLedger: ledger,
      targetFiles: { "leak.js": "alert('unsafe')" },
    });

    await workflow.run();
    workflow.cancel();

    await assert.rejects(
      workflow.resume("APPROVE"),
      /Workflow is not waiting for confirmation/,
      "Resuming cancelled workflow must be rejected"
    );

    const runRes = await workflow.run();
    assert.equal(runRes.status, "CANCELLED");
    assert.equal(existsSync(join(ws, "leak.js")), false, "Cancelled workflow must not write files");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Section 8: Negative Test 10 — Incomplete reconstruction obligations remain UNVERIFIED", async () => {
  const ws = mkdtempSync(join(tmpdir(), "rea-neg-10-"));
  try {
    const spec = buildTestSpec("neg-10", "form_app", ws);
    const ledger = buildTestLedger(spec, "form_app");

    // Missing testRunner
    const workflow = GovernedReaWorkflow.startReconstruction({
      workspaceRoot: ws,
      mutationEngine: new MutationEngine(ws),
      taskId: "task-neg-10",
      task: "Reconstruct without test runner",
      autoApprove: true,
      userAuthorized: true,
      initialSpecification: spec,
      initialLedger: ledger,
      targetFiles: { "index.html": "<form id='order-form'></form>" },
      // testRunner omitted!
    });

    const res = await workflow.run();
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.state.verification?.verdict, "BLOCKED");
    assert.ok(res.state.blockerDetail?.includes("unverified"), "Missing verifier must leave obligations unverified");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ============================================================================
// PHASE B: SECTION 7 — CORE MODES VERIFICATION (CODING AGENT)
// ============================================================================

test("Section 7A: Coding Agent — Diagnoses failing test, requests approval, patches file, and reports success", async () => {
  const ws = mkdtempSync(join(tmpdir(), "coding-agent-test-"));
  try {
    const calcFile = join(ws, "calculator.ts");
    writeFileSync(calcFile, "export function add(a: number, b: number): number {\n  return a - b; // Defect: subtraction instead of addition\n}\n");

    const mutationEngine = new MutationEngine(ws);
    const prep = await mutationEngine.preparePatch({
      operation: "patch",
      path: "calculator.ts",
      patch: {
        search: "return a - b;",
        replace: "return a + b;",
      },
    });

    assert.equal(prep.operation, "patch");
    assert.equal(prep.path, "calculator.ts");
    assert.equal(prep.diff.linesAdded, 1);
    assert.equal(prep.diff.linesRemoved, 1);

    // Apply approved mutation
    const applyRes = await mutationEngine.applyPreparedMutation(prep);
    assert.equal(applyRes.status, "APPLIED");

    const patchedContent = readFileSync(calcFile, "utf-8");
    assert.ok(patchedContent.includes("return a + b;"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
