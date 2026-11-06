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
import { ComparativeWebVerifier } from "../../src/rea/comparative-verifier.ts";
import { skipWithoutChromiumSandbox } from "../browser/chromium-host.ts";

test("Demo A — Black-Box Software Investigation, Governed Reconstruction & Comparative Verification", { skip: skipWithoutChromiumSandbox }, async () => {
  const browserProvisioning = detectBrowserProvisioning();
  assert.equal(browserProvisioning.status, "READY", "Playwright Chromium must be provisioned and ready");

  const workspaceRoot = mkdtempSync(join(tmpdir(), "rea-demo-a-ws-"));
  const cleanRoomDir = mkdtempSync(join(tmpdir(), "rea-demo-a-cleanroom-"));

  // 1. Launch Reference Web Application (App A)
  let portA = 0;
  const serverA = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/tasks-app" || url.pathname === "/") {
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
    <div id="app">
      <form id="task-form">
        <label for="task-input">Task Title</label>
        <input type="text" id="task-input" name="title" required placeholder="Enter task title...">
        <button type="submit" id="add-task-btn">Add Task</button>
      </form>
      <ul id="task-list" role="list"></ul>
    </div>
  </main>
  <footer><p>Local-First Application</p></footer>
  <script>
    const form = document.getElementById("task-form");
    const input = document.getElementById("task-input");
    const list = document.getElementById("task-list");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) {
        let err = document.getElementById("form-error");
        if (!err) {
          err = document.createElement("p");
          err.id = "form-error";
          err.style.color = "red";
          err.textContent = "Task title is required";
          form.appendChild(err);
        }
        return;
      }
      const existingErr = document.getElementById("form-error");
      if (existingErr) existingErr.remove();
      const li = document.createElement("li");
      li.role = "listitem";
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
    serverA.listen(0, "127.0.0.1", () => {
      const addr = serverA.address() as any;
      portA = addr.port;
      resolve();
    });
  });

  // 2. Launch Reconstructed Web Application (App B) serving from cleanRoomDir
  let portB = 0;
  const serverB = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/tasks-app") {
      const p = join(cleanRoomDir, "index.html");
      if (existsSync(p)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(p));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    } else if (url.pathname === "/src/app.js") {
      const p = join(cleanRoomDir, "src", "app.js");
      if (existsSync(p)) {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(readFileSync(p));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    } else if (url.pathname === "/src/styles.css") {
      const p = join(cleanRoomDir, "src", "styles.css");
      if (existsSync(p)) {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(readFileSync(p));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => {
    serverB.listen(0, "127.0.0.1", () => {
      const addr = serverB.address() as any;
      portB = addr.port;
      resolve();
    });
  });

  const appUrlA = `http://127.0.0.1:${portA}/tasks-app`;
  const appUrlB = `http://127.0.0.1:${portB}/`;

  // Shared BrowserSessionManager initialized with both authorized local application origins
  const uniqueSessionId = `demo-a-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const browserManager = new BrowserSessionManager({
    workspaceRoot,
    sessionId: uniqueSessionId,
    networkPolicy: {
      allowedOrigins: [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`],
    },
  });

  try {
    // 3. Step 1: Receive User Request & Classify Target (URL only)
    const target = classifyInvestigationTarget(appUrlA, {
      allowedOrigins: [`http://127.0.0.1:${portA}`],
    });
    assert.equal(target.category, "running_web_app");
    assert.equal(target.authorized, true);

    // 4. Step 2: Governed Investigation via Chromium
    // Verify that in REVIEW mode, investigation is strictly read-only
    const readOnlyEngine = new InvestigationEngine({
      browserSessionManager: browserManager,
      mode: "REVIEW",
      interactiveModeAllowed: false,
    });
    const readOnlyResult = await readOnlyEngine.runInvestigation(target);
    assert.equal(readOnlyResult.stateTransitions.length, 0, "REVIEW mode must not perform mutating clicks/fills");

    // Execute interactive governed investigation with permission checks
    const interactiveEngine = new InvestigationEngine({
      browserSessionManager: browserManager,
      mode: "BUILD",
      interactiveModeAllowed: true,
      autoApproveInteractions: true,
      maxInteractions: 3,
    });

    const investigationResult = await interactiveEngine.runInvestigation(target);

    // Verify gathered evidence and epistemic discipline
    assert.ok(investigationResult.evidenceLedger.length > 0);
    assert.ok(investigationResult.stateTransitions.length > 0);
    const primaryTransition = investigationResult.stateTransitions[0];
    assert.ok(primaryTransition);
    assert.equal(primaryTransition.confidence, "observed");
    assert.ok(primaryTransition.evidenceId.length > 0);

    // Verify synthesized specification
    const spec = investigationResult.specification;
    assert.ok(spec.featureInventory.length > 0);
    assert.ok(spec.pageAndRouteMap.length > 0);
    assert.ok(spec.formAndValidationBehavior.length > 0);
    assert.ok(spec.unknowns.length > 0);

    // Unknowns must explain why unobservable
    for (const unk of spec.unknowns) {
      assert.ok(unk.whyUnobservable);
    }

    const initialLedger = investigationResult.obligationLedger;
    assert.ok(initialLedger.obligations.length >= 2);
    for (const obl of initialLedger.obligations) {
      assert.equal(obl.status, "characterized");
    }

    // 5. Step 3: Governed Clean-Room Reconstruction
    // Failure closed without explicit user authorization
    const unauthEngine = new ReconstructionEngine({ workspaceRoot: cleanRoomDir });
    await assert.rejects(
      () =>
        unauthEngine.runReconstruction(spec, initialLedger, {
          userAuthorized: false,
        }),
      (err: any) => err.code === "RECONSTRUCTION_UNAUTHORIZED"
    );

    // Reconstruct with explicit authorization using canonical MutationEngine
    const reconEngine = new ReconstructionEngine({
      workspaceRoot: cleanRoomDir,
      autoApproveMutations: true,
      // Independent Verifier: executes ComparativeWebVerifier against App A and App B
      testRunner: async (obligation) => {
        const comparativeVerifier = new ComparativeWebVerifier({
          referenceUrl: appUrlA,
          reconstructedUrl: appUrlB,
          browserSessionManager: browserManager,
        });

        const compResult = await comparativeVerifier.runComparativeVerification();
        if (!compResult.passed) {
          return {
            passed: false,
            output: compResult.summary,
            details: {
              verifier: "ComparativeWebVerifier",
              testIdentity: "comparative_web_verifier_suite",
              inputFixture: `${appUrlA} vs ${appUrlB}`,
              expectedBehavior: "All behavioral scenarios match",
              observedResult: `Mismatches: ${compResult.mismatches.join("; ")}`,
            },
          };
        }

        return {
          passed: true,
          output: `Comparative verification PASSED for ${obligation.title}: ${compResult.summary}`,
          details: {
            verifier: "ComparativeWebVerifier",
            testIdentity: "comparative_web_verifier_suite",
            inputFixture: `${appUrlA} vs ${appUrlB}`,
            expectedBehavior: "All behavioral scenarios match",
            observedResult: `${compResult.matchedScenarios}/${compResult.totalScenarios} scenarios matched (digest: ${compResult.digest})`,
          },
        };
      },
    });

    // 6. Generate clean-room implementation files via MutationEngine into cleanRoomDir
    const cleanRoomGenEngine = new ReconstructionEngine({
      workspaceRoot: cleanRoomDir,
      autoApproveMutations: true,
    });
    await cleanRoomGenEngine.runReconstruction(spec, initialLedger, {
      userAuthorized: true,
    });

    // Verify generated clean-room files exist in cleanRoomDir
    assert.ok(existsSync(join(cleanRoomDir, "index.html")));
    assert.ok(existsSync(join(cleanRoomDir, "src", "app.js")));
    assert.ok(existsSync(join(cleanRoomDir, "src", "styles.css")));

    // 7. Execute Genuine Comparative Verification across App A and App B directly
    const directVerifier = new ComparativeWebVerifier({
      referenceUrl: appUrlA,
      reconstructedUrl: appUrlB,
      browserSessionManager: browserManager,
    });

    const comparativeResult = await directVerifier.runComparativeVerification();
    assert.equal(comparativeResult.passed, true, `Comparative verification must pass: ${comparativeResult.summary}`);
    assert.equal(comparativeResult.mismatches.length, 0);
    assert.equal(comparativeResult.matchedScenarios, 4);
    assert.ok(comparativeResult.digest.length === 64);

    // 8. Execute Reconstruction with Verifier to Close Obligations with Evidence
    const verifiedReconResult = await reconEngine.runReconstruction(spec, initialLedger, {
      userAuthorized: true,
    });

    assert.equal(verifiedReconResult.verifiedObligationsCount, initialLedger.obligations.length);
    assert.equal(verifiedReconResult.remainingOpenCount, 0);
    assert.equal(verifiedReconResult.updatedLedger.status, "verified");
    assert.equal(verifiedReconResult.updatedLedger.coverage.status, "complete");

    // Every closed obligation must carry an independent ObligationVerificationRecord
    for (const obl of verifiedReconResult.updatedLedger.obligations) {
      assert.equal(obl.status, "verified");
      assert.ok(obl.testEvidence, "Closed obligation must have testEvidence");
      assert.equal(obl.testEvidence?.result, "PASS");
      assert.ok(obl.testEvidence?.artifactDigest);
      assert.ok(obl.testEvidence?.verifier);
      assert.ok(obl.testEvidence?.timestamp);
    }

    // Surviving unknowns must remain audited and recorded
    assert.ok(verifiedReconResult.updatedLedger.reports.residualUnknownIds.length > 0);

    // Closure digest must be updated deterministically
    assert.notEqual(verifiedReconResult.closureDigest, initialLedger.closureDigest);
  } finally {
    await browserManager.close();
    await new Promise<void>((resolve) => serverB.close(() => resolve()));
    await new Promise<void>((resolve) => serverA.close(() => resolve()));
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(cleanRoomDir, { recursive: true, force: true });
  }
});
