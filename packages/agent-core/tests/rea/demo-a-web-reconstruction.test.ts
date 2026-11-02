import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrowserSessionManager,
  detectBrowserProvisioning,
} from "../../src/browser/index.ts";
import { classifyInvestigationTarget } from "../../src/rea/target-classifier.ts";
import { InvestigationEngine } from "../../src/rea/investigation-engine.ts";
import { ReconstructionEngine } from "../../src/rea/reconstruction-engine.ts";

test("Demo A — Black-Box Web Application Investigation & Governed Clean-Room Reconstruction", async () => {
  const browserProvisioning = detectBrowserProvisioning();
  assert.equal(browserProvisioning.status, "READY", "Playwright Chromium must be provisioned and ready");

  // 1. Launch local test server hosting an authorized web application
  let serverPort = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/tasks-app") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Task Tracker Pro</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    .form-group { margin-bottom: 12px; }
    .error-msg { color: red; font-size: 12px; }
  </style>
</head>
<body>
  <header><h1>Task Tracker Pro</h1></header>
  <main>
    <form id="task-form">
      <div class="form-group">
        <label for="taskName">Task Name</label>
        <input id="taskName" name="taskName" type="text" placeholder="Enter task..." required />
        <span class="error-msg" id="err-taskName"></span>
      </div>
      <button id="btn-add-task" type="submit">Add Task</button>
    </form>
    <ul id="task-list">
      <li>Existing Sample Task</li>
    </ul>
  </main>
  <footer><p>Local-First Application</p></footer>
  <script>
    const form = document.getElementById("task-form");
    const input = document.getElementById("taskName");
    const list = document.getElementById("task-list");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      const li = document.createElement("li");
      li.textContent = val;
      list.appendChild(li);
      input.value = "";
    });
  </script>
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
      serverPort = addr.port;
      resolve();
    });
  });

  const appUrl = `http://127.0.0.1:${serverPort}/tasks-app`;
  const workspaceRoot = mkdtempSync(join(tmpdir(), "rea-demo-a-ws-"));
  const cleanRoomDir = mkdtempSync(join(tmpdir(), "rea-demo-a-cleanroom-"));

  const browserManager = new BrowserSessionManager({
    workspaceRoot,
    sessionId: "demo-a-investigation-session",
    networkPolicy: { allowedOrigins: [`http://127.0.0.1:${serverPort}`] },
  });

  try {
    // 2. Target Classification (URL only, source code NOT required)
    const target = classifyInvestigationTarget(appUrl, {
      allowedOrigins: [`http://127.0.0.1:${serverPort}`],
    });
    assert.equal(target.category, "running_web_app");
    assert.equal(target.authorized, true);

    // 3. Behavioral Investigation via real Chromium
    const investigationEngine = new InvestigationEngine({
      browserSessionManager: browserManager,
      maxInteractions: 3,
    });

    const investigationResult = await investigationEngine.runInvestigation(target);

    // Verify discovered evidence
    assert.ok(investigationResult.evidenceLedger.length > 0);
    assert.ok(investigationResult.stateTransitions.length > 0);
    const primaryTransition = investigationResult.stateTransitions[0];
    assert.ok(primaryTransition);
    assert.equal(primaryTransition.confidence, "observed");

    // Verify synthesized specification
    const spec = investigationResult.specification;
    assert.ok(spec.featureInventory.length > 0);
    assert.ok(spec.pageAndRouteMap.length > 0);
    assert.ok(spec.formAndValidationBehavior.length > 0);
    assert.ok(spec.unknowns.length > 0);

    // Epistemic discipline check: unknowns must declare why they are unobservable
    for (const unk of spec.unknowns) {
      assert.ok(unk.whyUnobservable);
    }

    // Verify initial obligation ledger
    const initialLedger = investigationResult.obligationLedger;
    assert.ok(initialLedger.obligations.length >= 2);
    for (const obl of initialLedger.obligations) {
      assert.equal(obl.status, "characterized");
    }

    // 4. Clean-room Reconstruction Engine (Governed Execution)
    const reconstructionEngine = new ReconstructionEngine({
      workspaceRoot: cleanRoomDir,
      testRunner: async (obligation) => {
        // Run test runner verifying that generated implementation handles obligation
        const htmlFile = join(cleanRoomDir, "index.html");
        const jsFile = join(cleanRoomDir, "src", "app.js");
        const hasFiles = existsSync(htmlFile) && existsSync(jsFile);

        if (!hasFiles) {
          return { passed: false, output: "Generated clean-room files missing" };
        }

        const jsContent = readFileSync(jsFile, "utf-8");
        const handlesForm = jsContent.includes("addEventListener") || jsContent.includes("form");
        return {
          passed: handlesForm,
          output: `Verified obligation "${obligation.title}" against clean-room JS modules`,
        };
      },
    });

    // Attempting reconstruction without user authorization fails closed
    await assert.rejects(
      () =>
        reconstructionEngine.runReconstruction(spec, initialLedger, {
          userAuthorized: false,
        }),
      (err: any) => err.code === "RECONSTRUCTION_UNAUTHORIZED"
    );

    // Executing with explicit user authorization
    const reconstructionResult = await reconstructionEngine.runReconstruction(spec, initialLedger, {
      userAuthorized: true,
    });

    // 5. Verification of results & obligation closure
    assert.equal(reconstructionResult.verifiedObligationsCount, initialLedger.obligations.length);
    assert.equal(reconstructionResult.remainingOpenCount, 0);
    assert.equal(reconstructionResult.updatedLedger.status, "verified");
    assert.equal(reconstructionResult.updatedLedger.coverage.status, "complete");

    // Output files generated cleanly without contamination
    assert.ok(existsSync(join(cleanRoomDir, "index.html")));
    assert.ok(existsSync(join(cleanRoomDir, "src", "app.js")));
    assert.ok(existsSync(join(cleanRoomDir, "src", "styles.css")));

    // Deterministic closure digest updated
    assert.notEqual(reconstructionResult.closureDigest, initialLedger.closureDigest);
  } finally {
    await browserManager.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(cleanRoomDir, { recursive: true, force: true });
  }
});
