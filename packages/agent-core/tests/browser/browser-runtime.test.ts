import { test, describe, before, after } from "node:test";
import * as assert from "node:assert";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  BrowserSessionManager,
  detectBrowserProvisioning,
  type AccessibilitySnapshot,
} from "../../src/browser/index.ts";
import { skipWithoutChromiumSandbox } from "./chromium-host.ts";

describe("Sprint 9A — Governed Playwright Browser Runtime", { skip: skipWithoutChromiumSandbox }, () => {
  let server: http.Server;
  let serverUrl: string;
  let serverPort: number;
  let tmpWorkspace: string;
  let sessionManager: BrowserSessionManager;

  before(async () => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "browser-runtime-test-"));

    // Set up local controlled HTTP test server
    server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://${req.headers.host}`);
      if (u.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
  <head><title>Local QA Home</title></head>
  <body>
    <h1>Local QA Dashboard</h1>
    <p>Welcome to governed test application</p>
    <a href="/form" id="nav-form">Go to Form</a>
  </body>
</html>`);
      } else if (u.pathname === "/form") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
  <head><title>Form Page</title></head>
  <body>
    <h1>User Profile Form</h1>
    <form id="test-form">
      <label>Username: <input id="username" name="username" type="text" placeholder="Your username" /></label>
      <label>Email: <input id="email" name="email" type="email" placeholder="Your email" /></label>
      <button id="btn-submit" type="button" onclick="document.getElementById('result').innerText = 'Submitted: ' + document.getElementById('username').value;">Submit Form</button>
      <div id="result">Pending</div>
    </form>
    <script>
      console.log("Console diagnostic log message");
      console.warn("Console diagnostic warning message");
      console.error("Console diagnostic error message");
    </script>
  </body>
</html>`);
      } else if (u.pathname === "/oversized") {
        res.writeHead(200, { "Content-Type": "text/html" });
        let items = "";
        for (let i = 1; i <= 1500; i++) {
          items += `<button id="btn-${i}">Button Number ${i} with very long descriptive label for testing bounds</button>\n`;
        }
        res.end(`<!DOCTYPE html><html><head><title>Oversized Page</title></head><body><h1>Many Elements</h1>${items}</body></html>`);
      } else if (u.pathname === "/fail-resource") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    sessionManager = new BrowserSessionManager({
      workspaceRoot: tmpWorkspace,
      headless: true,
      maxSnapshotBytes: 4096, // Low limit to test bounds
      networkPolicy: {
        allowedOrigins: [`http://127.0.0.1:${serverPort}`],
      },
    });
  });

  after(async () => {
    if (sessionManager) {
      await sessionManager.dispose();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fs.existsSync(tmpWorkspace)) {
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    }
  });

  // Scenario 1: Launch browser
  test("1. Launch browser: verifies installed executable provenance and starts isolated session", async () => {
    const diag = detectBrowserProvisioning();
    assert.strictEqual(diag.status, "READY", "Browser must be provisioned and ready");
    assert.ok(diag.executable?.path, "Browser executable path must be present");
    assert.ok(fs.existsSync(diag.executable.path), "Executable file must exist on disk");

    let startedEvent = false;
    sessionManager.onEvent((ev) => {
      if (ev.type === "session_started") startedEvent = true;
    });

    await sessionManager.start();
    assert.strictEqual(sessionManager.getStatus(), "READY");
    assert.strictEqual(startedEvent, true, "session_started event must be emitted");
  });

  // Scenario 2: Open authorized local page
  test("2. Open authorized local page: navigates to test page and returns title and URL", async () => {
    const result = await sessionManager.open(`${serverUrl}/`);
    assert.strictEqual(result.url, `${serverUrl}/`);
    assert.strictEqual(result.title, "Local QA Home");
  });

  // Scenario 3: Navigate between local pages
  test("3. Navigate between local pages: navigates to /form page safely", async () => {
    const result = await sessionManager.navigate(`${serverUrl}/form`);
    assert.strictEqual(result.url, `${serverUrl}/form`);
    assert.strictEqual(result.title, "Form Page");
  });

  // Scenario 4: Read accessibility snapshot
  test("4. Read accessibility snapshot: produces structured, compact element tree", async () => {
    const snap: AccessibilitySnapshot = await sessionManager.snapshot();
    assert.ok(snap.snapshotId.startsWith("snap_"));
    assert.strictEqual(snap.title, "Form Page");
    assert.ok(snap.tree.includes("User Profile Form"));
    assert.ok(snap.elements.length >= 3);
  });

  // Scenario 5: Identify form elements
  test("5. Identify form elements: extracts element references, tags, and roles", async () => {
    const snap = await sessionManager.snapshot();
    const usernameEl = snap.elements.find((e) => e.selector.includes("username"));
    const emailEl = snap.elements.find((e) => e.selector.includes("email"));
    const submitBtn = snap.elements.find((e) => e.selector.includes("btn-submit"));

    assert.ok(usernameEl, "Username input must be identified");
    assert.ok(emailEl, "Email input must be identified");
    assert.ok(submitBtn, "Submit button must be identified");
    assert.strictEqual(submitBtn.tag, "button");
  });

  // Scenario 6: Fill a permitted field
  test("6. Fill a permitted field: enters text into username input via refId", async () => {
    const snap = await sessionManager.snapshot();
    const usernameEl = snap.elements.find((e) => e.selector.includes("username"))!;

    const fillRes = await sessionManager.fill(usernameEl.refId, "developer-alice");
    assert.strictEqual(fillRes.success, true);
    assert.strictEqual(fillRes.target.refId, usernameEl.refId);
  });

  // Scenario 7: Click a permitted button
  test("7. Click a permitted button: triggers form submission and updates DOM", async () => {
    const snap = await sessionManager.snapshot();
    const submitBtn = snap.elements.find((e) => e.selector.includes("btn-submit"))!;

    const clickRes = await sessionManager.click(submitBtn.refId);
    assert.strictEqual(clickRes.success, true);

    // Verify DOM state updated
    const page = sessionManager.getActivePage()!;
    const text = await page.textContent("#result");
    assert.strictEqual(text, "Submitted: developer-alice");
  });

  // Scenario 8: Capture screenshot
  test("8. Capture screenshot: produces bounded PNG image observation", async () => {
    const shot = await sessionManager.screenshot({ fullPage: false });
    assert.strictEqual(shot.mimeType, "image/png");
    assert.ok(shot.bytes > 100, "Screenshot bytes must be non-empty");
    assert.ok(shot.base64, "Base64 representation must be available for reasonable sizes");
  });

  // Scenario 9: Read console diagnostic
  test("9. Read console diagnostic: captures console logs, warnings, and errors in ring buffer", async () => {
    const diags = sessionManager.getConsoleDiagnostics();
    assert.ok(diags.length > 0, "Console diagnostics must contain entries");
    assert.ok(diags.some((d) => d.type === "log" && d.text.includes("diagnostic log message")));
    assert.ok(diags.some((d) => d.type === "warn" && d.text.includes("diagnostic warning message")));
    assert.ok(diags.some((d) => d.type === "error" && d.text.includes("diagnostic error message")));
  });

  // Scenario 10: Observe network request failures
  test("10. Observe network request failures: tracks blocked or failed network requests", async () => {
    const page = sessionManager.getActivePage()!;
    // Trigger request that network policy blocks (e.g. to unauthorized host)
    await page.evaluate(() => {
      fetch("http://unauthorized.external.test/data").catch(() => {});
    });

    // Short wait for route abortion
    await new Promise((r) => setTimeout(r, 100));

    const failures = sessionManager.getNetworkDiagnostics();
    assert.ok(failures.length > 0, "Network diagnostics must record blocked requests");
    assert.ok(failures.some((f) => f.url.includes("unauthorized.external.test")));
  });

  // Scenario 11: Cancel navigation
  test("11. Cancel navigation: AbortSignal aborts in-flight navigation cleanly", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await sessionManager.navigate(`${serverUrl}/`, controller.signal);
      },
      (err: any) => err.name === "AbortError"
    );
  });

  // Scenario 12: Cancel mid-action
  test("12. Cancel mid-action: AbortSignal aborts click or fill before completion", async () => {
    const snap = await sessionManager.snapshot();
    const btn = snap.elements[0]!;

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await sessionManager.click(btn.refId, controller.signal);
      },
      (err: any) => err.name === "AbortError"
    );
  });

  // Scenario 22: Bound oversized snapshots
  test("22. Bound oversized snapshots: truncates snapshot exceeding byte budget cleanly", async () => {
    await sessionManager.navigate(`${serverUrl}/oversized`);
    const snap = await sessionManager.snapshot();

    assert.strictEqual(snap.truncated, true, "Snapshot exceeding byte budget must be marked truncated");
    assert.ok(snap.tree.includes("[TRUNCATED: Snapshot exceeded maxSnapshotBytes limit]"));
    assert.ok(snap.bytes <= 4096, "Returned bytes must not exceed maxSnapshotBytes");
  });

  // Scenario 23: Reject stale element references
  test("23. Reject stale element references: rejects refs after page navigates", async () => {
    // 1. Capture snapshot on /oversized
    const oldSnap = await sessionManager.snapshot();
    const oldRef = oldSnap.elements[0]!.refId;

    // 2. Navigate away to /form
    await sessionManager.navigate(`${serverUrl}/form`);

    // 3. Attempting to click old element reference must fail with STALE_ELEMENT_REFERENCE
    await assert.rejects(
      async () => {
        await sessionManager.click(oldRef);
      },
      /STALE_ELEMENT_REFERENCE/
    );

    // 4. Attempting to fill old element reference must fail with STALE_ELEMENT_REFERENCE
    await assert.rejects(
      async () => {
        await sessionManager.fill(oldRef, "test-value");
      },
      /STALE_ELEMENT_REFERENCE/
    );
  });

  // Scenario 13: Close browser
  test("13. Close browser: cleanly closes active pages, contexts, and browser instance", async () => {
    await sessionManager.close();
    assert.strictEqual(sessionManager.getStatus(), "CLOSED");
    assert.strictEqual(sessionManager.getActivePage(), undefined);
  });

  // Scenario 14: Kill process tree on shutdown
  test("14. Kill process tree on shutdown: dispose() terminates browser process and cleans resources", async () => {
    const freshManager = new BrowserSessionManager({
      workspaceRoot: tmpWorkspace,
      headless: true,
      networkPolicy: { allowedOrigins: [serverUrl] },
    });

    await freshManager.start();
    assert.strictEqual(freshManager.getStatus(), "READY");

    let cleanupEvent = false;
    freshManager.onEvent((ev) => {
      if (ev.type === "process_cleanup") cleanupEvent = true;
    });

    await freshManager.dispose();
    assert.strictEqual(cleanupEvent, true, "process_cleanup event must be emitted");
  });
});
