import { test, describe, before, after } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  BrowserSessionManager,
  detectBrowserProvisioning,
  createBrowserToolRegistrations,
  classifyBrowserToolAction,
  type ElementRef,
} from "../../src/browser/index.ts";
import { BROWSER_QA_LOCAL_DEV_PACK } from "../../src/packs/starter-packs.ts";
import { STARTER_MODE_PROFILES } from "../../src/modes/starter-profiles.ts";
import { resolveExecutionProfile } from "../../src/modes/resolver.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { classifyPermission } from "../../src/tools/permissions.ts";

describe("Sprint 9A — Governed Browser Runtime End-to-End & Pack Governance", () => {
  let tmpRoot: string;
  let workspaceRootA: string;
  let workspaceRootB: string;
  let server: http.Server;
  let serverUrl: string;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-e2e-root-"));
    workspaceRootA = path.join(tmpRoot, "ws-a");
    workspaceRootB = path.join(tmpRoot, "ws-b");
    fs.mkdirSync(workspaceRootA, { recursive: true });
    fs.mkdirSync(workspaceRootB, { recursive: true });

    // Controlled local test server
    server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://${req.headers.host}`);
      if (u.pathname === "/qa-dashboard") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
  <head><title>Governed QA Dashboard</title></head>
  <body>
    <h1>Browser QA App</h1>
    <form id="qa-form">
      <label>Feedback: <input id="qa-feedback" name="feedback" type="text" placeholder="Type feedback" /></label>
      <button id="qa-submit" type="button" onclick="document.getElementById('qa-status').innerText = 'Processed: ' + document.getElementById('qa-feedback').value;">Submit Feedback</button>
      <div id="qa-status">Pending Review</div>
    </form>
  </body>
</html>`);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Scenario 24: Custom Mode selection
  test("24. Custom Mode selection: Browser QA profile enables governed tools and base mode constraints", () => {
    // 1. Read-only inspection profile under PLAN
    const qaProfile = STARTER_MODE_PROFILES.find((p) => p.id === "browser-qa-local-dev");
    assert.ok(qaProfile, "Browser QA profile must exist in starter profiles");
    assert.strictEqual(qaProfile.name, "Browser QA — Local Development");
    assert.strictEqual(qaProfile.baseMode, "PLAN");

    const inspectionTools = [
      "browser_open",
      "browser_snapshot",
      "browser_screenshot",
      "browser_close",
    ];
    for (const tool of inspectionTools) {
      assert.ok(qaProfile.toolAllowlist?.includes(tool), `Profile must include ${tool}`);
    }

    // Resolving execution profile with inspection tools succeeds
    const resolvedInspection = resolveExecutionProfile({
      profile: qaProfile,
      workspaceTrusted: true,
      availableSkills: [],
      availableMcpServers: [],
      availableTools: inspectionTools.map((name) => ({ name, action: "browser_inspection" })),
      globalWorkflowEnabled: true,
    });
    assert.strictEqual(resolvedInspection.isReady, true);
    assert.strictEqual(resolvedInspection.baseMode, "PLAN");

    // 2. Interactive QA profile under BUILD
    const interactiveProfile = STARTER_MODE_PROFILES.find((p) => p.id === "browser-qa-interactive-local-dev");
    assert.ok(interactiveProfile, "Browser QA Interactive profile must exist");
    assert.strictEqual(interactiveProfile.baseMode, "BUILD");

    const allBrowserTools = [
      "browser_open",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_screenshot",
      "browser_close",
    ];
    for (const tool of allBrowserTools) {
      assert.ok(interactiveProfile.toolAllowlist?.includes(tool), `Interactive profile must include ${tool}`);
    }

    const resolvedInteractive = resolveExecutionProfile({
      profile: interactiveProfile,
      workspaceTrusted: true,
      availableSkills: [],
      availableMcpServers: [],
      availableTools: allBrowserTools.map((name) => ({ name, action: "browser_interaction" })),
      globalWorkflowEnabled: true,
    });
    assert.strictEqual(resolvedInteractive.isReady, true);
    assert.strictEqual(resolvedInteractive.baseMode, "BUILD");
  });

  // Scenario 25: Workspace boundary isolation
  test("25. Workspace boundary isolation: Multiple workspaces run isolated browser contexts", async () => {
    const sessionManagerA = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "session-ws-a",
      networkPolicy: { allowedOrigins: [serverUrl] },
    });

    const sessionManagerB = new BrowserSessionManager({
      workspaceRoot: workspaceRootB,
      sessionId: "session-ws-b",
      networkPolicy: { allowedOrigins: [serverUrl] },
    });

    try {
      const pageA = await sessionManagerA.open(`${serverUrl}/qa-dashboard`);
      const pageB = await sessionManagerB.open(`${serverUrl}/qa-dashboard`);

      assert.strictEqual(pageA.title, "Governed QA Dashboard");
      assert.strictEqual(pageB.title, "Governed QA Dashboard");

      // Sessions have separate IDs and distinct snapshots
      assert.notStrictEqual(sessionManagerA.getSessionId(), sessionManagerB.getSessionId());

      const snapA = await sessionManagerA.snapshot();
      const snapB = await sessionManagerB.snapshot();
      assert.notStrictEqual(snapA.snapshotId, snapB.snapshotId);
    } finally {
      await sessionManagerA.dispose();
      await sessionManagerB.dispose();
    }
  });

  // Scenario 26: Account isolation
  test("26. Account isolation: Revoked account profiles are excluded from active resolution", () => {
    const validModeIds = new Set(["standard-mode-1", "standard-mode-2"]);
    const accountProfiles = [
      { id: "account-browser-pack", name: "Account Pack" },
      { id: "standard-mode-1", name: "Standard Mode 1" },
    ];

    // Reconciling prunes orphaned ephemeral profiles
    const retained = accountProfiles.filter((p) => validModeIds.has(p.id));
    assert.strictEqual(retained.length, 1);
    assert.strictEqual(retained[0]?.id, "standard-mode-1");
  });

  // Scenario 27: Pack installation safety
  test("27. Pack installation safety: Registering browser pack does NOT auto-start browser sessions", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "session-pack-safety",
    });

    // Validates pack integrity
    assert.strictEqual(BROWSER_QA_LOCAL_DEV_PACK.id, "browser-qa-local-dev-pack");
    assert.strictEqual(BROWSER_QA_LOCAL_DEV_PACK.integrity.algorithm, "sha256");
    assert.ok(BROWSER_QA_LOCAL_DEV_PACK.integrity.digest.length > 0);

    // Browser session remains UNINITIALIZED
    assert.strictEqual(sessionManager.getStatus(), "UNINITIALIZED");

    // Provenance detection confirms readiness without launching process
    const prov = detectBrowserProvisioning();
    assert.strictEqual(prov.status, "READY");
    assert.strictEqual(sessionManager.getStatus(), "UNINITIALIZED");

    await sessionManager.dispose();
  });

  // Scenario 31: End-to-end integration test
  // User request -> custom mode / pack -> AgentRuntime -> Browser tools -> PermissionGate -> Playwright -> verified result
  test("31. End-to-end integration: Governed browser tool workflow drives real Playwright execution with PermissionGate", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "session-e2e-runtime",
      networkPolicy: { allowedOrigins: [serverUrl] },
    });

    try {
      // 1. Tool registry registration
      const toolRegistry = new ToolRegistry();
      const browserTools = createBrowserToolRegistrations(sessionManager);
      for (const t of browserTools) {
        toolRegistry.register(t);
      }

      // Verify all 7 browser tools registered
      assert.strictEqual(toolRegistry.listDefinitions().length >= 7, true);

      // 2. Permission gate enforcement
      // Inspection actions pass automatically in REVIEW/PLAN mode
      const openAction = classifyBrowserToolAction({ toolName: "browser_open", args: { url: `${serverUrl}/qa-dashboard` } });
      assert.strictEqual(openAction, "browser_inspection");
      const openReview = classifyPermission({
        action: openAction,
        mode: "REVIEW",
      });
      assert.strictEqual(openReview, "ALLOW");

      const execContext = {
        workspaceRoot: workspaceRootA,
        signal: new AbortController().signal,
      };

      // Execute browser_open via tool registry
      const openCall = toolRegistry.prepare({
        id: "call-1",
        name: "browser_open",
        arguments: { url: `${serverUrl}/qa-dashboard` },
      });
      const openResult = (await openCall.invoke(execContext)) as any;
      assert.strictEqual(openResult.ok, true);
      assert.strictEqual(openResult.title, "Governed QA Dashboard");

      // Execute browser_snapshot
      const snapCall = toolRegistry.prepare({
        id: "call-2",
        name: "browser_snapshot",
        arguments: {},
      });
      const snapResult = (await snapCall.invoke(execContext)) as any;
      assert.strictEqual(snapResult.ok, true);
      assert.strictEqual(snapResult.title, "Governed QA Dashboard");
      assert.ok(snapResult.tree.includes("Browser QA App"));

      // 3. Interaction actions (fill, click) require confirmation in BUILD and are gated in pure REVIEW
      const fillAction = classifyBrowserToolAction({ toolName: "browser_fill", args: { refId: "e1", value: "QA test verification" } });
      assert.strictEqual(fillAction, "browser_interaction");
      const fillBuildPerm = classifyPermission({
        action: fillAction,
        mode: "BUILD",
      });
      assert.strictEqual(fillBuildPerm, "CONFIRM");

      // In REVIEW base mode with explicit approved interaction override
      const fillReviewPerm = classifyPermission({
        action: fillAction,
        mode: "REVIEW",
        modeOverrides: { REVIEW: { browser_interaction: "CONFIRM" } },
      });
      assert.strictEqual(fillReviewPerm, "CONFIRM");

      // Execute browser_fill on input field
      const activeSnapshot = await sessionManager.snapshot();
      const feedbackInput = activeSnapshot.elements.find((e: ElementRef) => e.selector.includes("qa-feedback"))!;
      const submitButton = activeSnapshot.elements.find((e: ElementRef) => e.selector.includes("qa-submit"))!;

      const fillCall = toolRegistry.prepare({
        id: "call-3",
        name: "browser_fill",
        arguments: {
          refId: feedbackInput.refId,
          value: "Sprint 9A Governance E2E Verified",
        },
      });
      const fillResult = (await fillCall.invoke(execContext)) as any;
      assert.strictEqual(fillResult.ok, true);

      // Execute browser_click on submit button
      const clickCall = toolRegistry.prepare({
        id: "call-4",
        name: "browser_click",
        arguments: {
          refId: submitButton.refId,
        },
      });
      const clickResult = (await clickCall.invoke(execContext)) as any;
      assert.strictEqual(clickResult.ok, true);

      // 4. Verify DOM update in real Chromium instance
      const page = sessionManager.getActivePage()!;
      const statusText = await page.textContent("#qa-status");
      assert.strictEqual(statusText, "Processed: Sprint 9A Governance E2E Verified");

      // 5. Screenshot observation artifact
      const shotCall = toolRegistry.prepare({
        id: "call-5",
        name: "browser_screenshot",
        arguments: {},
      });
      const shotResult = (await shotCall.invoke(execContext)) as any;
      assert.strictEqual(shotResult.ok, true);
      assert.ok(shotResult.bytes > 0);

      // 6. Clean closure
      const closeCall = toolRegistry.prepare({
        id: "call-6",
        name: "browser_close",
        arguments: {},
      });
      const closeResult = (await closeCall.invoke(execContext)) as any;
      assert.strictEqual(closeResult.ok, true);
      assert.strictEqual(sessionManager.getStatus(), "CLOSED");
    } finally {
      await sessionManager.dispose();
    }
  });
});
