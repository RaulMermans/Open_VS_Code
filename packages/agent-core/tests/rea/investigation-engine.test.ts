import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InvestigationEngine,
} from "../../src/rea/investigation-engine.ts";
import { classifyInvestigationTarget } from "../../src/rea/target-classifier.ts";
import type { InvestigationStageId } from "../../src/rea/contracts.ts";

test("InvestigationEngine - tracks stage progression and synthesizes specification for source repo", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "rea-investigation-test-"));

  try {
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "mock-project", version: "1.0.0", main: "index.js" })
    );
    writeFileSync(join(testDir, "index.js"), "console.log('hello world');");

    const target = classifyInvestigationTarget(testDir, { workspaceRoot: testDir });

    const stagesObserved: { stage: InvestigationStageId; status: string }[] = [];
    const engine = new InvestigationEngine({
      onStageChange: (e) => {
        stagesObserved.push({ stage: e.stage, status: e.status });
      },
    });

    const result = await engine.runInvestigation(target);

    // Verify stage lifecycle
    assert.ok(stagesObserved.some((s) => s.stage === "target_intake" && s.status === "COMPLETED"));
    assert.ok(stagesObserved.some((s) => s.stage === "specification" && s.status === "COMPLETED"));
    assert.ok(stagesObserved.some((s) => s.stage === "ledger_generation" && s.status === "COMPLETED"));

    // Verify result artifacts
    assert.equal(result.target.targetId, target.targetId);
    assert.ok(result.evidenceLedger.length > 0);
    assert.ok(result.specification.featureInventory.length > 0);
    assert.ok(result.obligationLedger.obligations.length > 0);
    assert.ok(result.obligationLedger.closureDigest);

    // Verify epistemic discipline
    for (const obs of result.evidenceLedger) {
      assert.ok(["OBSERVED", "INFERRED", "UNKNOWN"].includes(obs.epistemicStatus));
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("InvestigationEngine - web behavioral exploration records state transitions and obligations", async () => {
  const target = classifyInvestigationTarget("http://localhost:3000/app");

  let clickCalled = false;
  let fillCalled = false;

  // Mock BrowserSessionManager conforming to minimal interface required by InvestigationEngine
  const mockBrowserManager: any = {
    open: async (_url: string) => ({ sessionId: "mock-session-1" }),
    snapshot: async () => ({
      url: "http://localhost:3000/app",
      title: "Task Management App",
      elements: [
        { refId: "ref_1", role: "textbox", name: "New Task Title", tag: "input", inputType: "text" },
        { refId: "ref_2", role: "button", name: "Add Task", tag: "button" },
        { refId: "ref_3", role: "link", name: "Settings", tag: "a", href: "/settings" },
      ],
      interactiveCount: 3,
    }),
    fill: async (_ref: string, _val: string) => {
      fillCalled = true;
    },
    click: async (_ref: string) => {
      clickCalled = true;
    },
    evaluate: async () => ["api/tasks", "api/users"],
    close: async () => {},
  };

  const engine = new InvestigationEngine({
    browserSessionManager: mockBrowserManager,
    maxInteractions: 5,
  });

  const result = await engine.runInvestigation(target);

  // Assert interactions were executed
  assert.equal(fillCalled, true);
  assert.equal(clickCalled, true);

  // Assert observable state transitions were recorded
  assert.ok(result.stateTransitions.length > 0);
  const transition = result.stateTransitions[0];
  assert.ok(transition);
  assert.equal(transition.userAction.type, "click");
  assert.equal(transition.confidence, "observed");

  // Assert specification details
  assert.ok(result.specification.pageAndRouteMap.length > 0);
  assert.ok(result.specification.formAndValidationBehavior.length > 0);
  assert.ok(result.specification.unknowns.length > 0);

  // Unknowns must reflect unobservable backend details
  const dbUnknown = result.specification.unknowns.find((u) => u.area === "database_schema");
  assert.ok(dbUnknown);
  assert.ok(dbUnknown.whyUnobservable);

  // Obligation ledger must contain open obligations for features, rules, and routes
  assert.ok(result.obligationLedger.obligations.length >= 2);
  for (const obl of result.obligationLedger.obligations) {
    assert.equal(obl.status, "characterized");
    assert.ok(obl.obligationId.startsWith("obl_"));
    assert.ok(obl.title);
    assert.ok(obl.applicationLayer);
  }
});
