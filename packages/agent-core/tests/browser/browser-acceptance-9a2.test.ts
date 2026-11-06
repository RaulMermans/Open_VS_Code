import { test, describe, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  BrowserSessionManager,
  BrowserSessionError,
  BrowserEgressProxy,
  detectBrowserProvisioning,
  verifyEffectiveSandboxSupport,
  cleanupOrphanedBrowserProfiles,
  createBrowserToolRegistrations,
  type BrowserEvent,
} from "../../src/browser/index.ts";
import { createAgentRuntime } from "../../src/agent/runtime.ts";
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts";
import type { AgentEvent } from "../../src/contracts/agent.ts";
import { skipWithoutChromiumSandbox } from "./chromium-host.ts";

function acceptWebSocketHandshake(req: http.IncomingMessage, socket: any): void {
  const key = req.headers["sec-websocket-key"];
  if (!key || typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n")
  );
  socket.unref?.();
  socket.on("data", () => socket.destroy());
  socket.on("end", () => socket.destroy());
  socket.on("error", () => socket.destroy());
}

function closeHttpServer(srv?: http.Server): Promise<void> {
  return srv
    ? new Promise<void>((r) => {
        (srv as any).closeAllConnections?.();
        srv.close(() => r());
      })
    : Promise.resolve();
}

describe("Sprint 9A.2 — Real Chromium Security Proof, Network Isolation & Runtime Reliability", { skip: skipWithoutChromiumSandbox }, () => {
  let tmpRoot: string;
  let workspaceRootA: string;
  let workspaceRootB: string;

  // Independent adversarial HTTP & WebSocket servers
  let authServer: http.Server;
  let authServerUrl: string;
  let authServerPort: number;
  let authServerRequests = 0;
  let authWsUpgradeRequests = 0;
  let swScriptRequests = 0;
  let formActionSubmissions = 0;

  let unauthServer: http.Server;
  let unauthServerUrl: string;
  let unauthServerPort: number;
  let unauthServerRequests = 0;
  let unauthWsUpgradeRequests = 0;

  let metadataMockServer: http.Server;
  let metadataMockUrl: string;
  let metadataServerRequests = 0;

  let wsBServer: http.Server;
  let wsBServerUrl: string;
  let wsBServerRequests = 0;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-9a2-root-"));
    workspaceRootA = path.join(tmpRoot, "ws-a");
    workspaceRootB = path.join(tmpRoot, "ws-b");
    fs.mkdirSync(workspaceRootA, { recursive: true });
    fs.mkdirSync(workspaceRootB, { recursive: true });

    // 1. Authorized local development server
    authServer = http.createServer((req, res) => {
      authServerRequests++;
      const u = new URL(req.url || "/", `http://${req.headers.host}`);

      if (u.pathname === "/safe") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!DOCTYPE html><html><head><title>Safe Authorized Page</title></head><body><h1>Authorized</h1></body></html>"
        );
      } else if (u.pathname === "/sw.js") {
        swScriptRequests++;
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("self.addEventListener('fetch', () => {});");
      } else if (u.pathname === "/slow-hang") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.write("<!DOCTYPE html><html><head><title>Loading</title>");
        const timer = setTimeout(() => {
          res.end("</head><body>Done</body></html>");
        }, 15000);
        req.on("close", () => clearTimeout(timer));
      } else if (u.pathname === "/secret-echo") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
  <head><title>Auth Callback ?token=TitleSecretToken999 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9</title></head>
  <body>
    <h1>Secret Audit</h1>
    <script>
      console.log("Debug auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
      console.error("AWS leak AKIAIOSFODNN7EXAMPLE and session ovsc_sess_998877665544");
    </script>
  </body>
</html>`);
      } else if (u.pathname === "/submit-endpoint") {
        formActionSubmissions++;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html><html><body>Submitted</body></html>");
      } else if (u.pathname === "/form") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
  <head><title>Form Page</title></head>
  <body>
    <h1>Security Test Form</h1>
    <form id="sec-form" action="/submit-endpoint">
      <label>User: <input id="username" name="username" type="text" placeholder="Username" value="alice" /></label>
      <label>Password: <input id="password" name="password" type="password" aria-label="Account Password" value="SuperSecretP@ss99" /></label>
      <label>API Key: <input id="apikey" name="token" type="text" aria-label="API Key Token" value="sec_tok_998877" /></label>
      <button id="btn-submit" type="button" onclick="document.getElementById('out').innerText = 'Submitted';">Submit Order</button>
      <button id="btn-harmless" type="button" onclick="document.getElementById('out').innerText = 'HarmlessClicked';">Harmless Info</button>
      <button id="btn-delete" type="button" onclick="document.getElementById('out').innerText = 'DeletedAll';">Delete Everything</button>
      <div id="out">Ready</div>
    </form>
  </body>
</html>`);
      } else if (u.pathname === "/redirect-to-metadata") {
        res.writeHead(302, { Location: `${metadataMockUrl}/latest/meta-data/iam` });
        res.end();
      } else if (u.pathname === "/redirect-to-aws-ip") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (u.pathname === "/redirect-loop") {
        res.writeHead(302, { Location: `${authServerUrl}/redirect-loop` });
        res.end();
      } else if (u.pathname === "/with-unauth-subresources") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
  <head><title>Subresources</title></head>
  <body>
    <iframe src="${unauthServerUrl}/iframe-leak"></iframe>
    <img src="${unauthServerUrl}/image-leak.png" alt="tracker" />
    <script>
      fetch("${unauthServerUrl}/fetch-leak").catch(() => {});
    </script>
  </body>
</html>`);
      } else if (u.pathname === "/popup-trigger") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
  <head><title>Popup Page</title></head>
  <body>
    <button id="btn-popup" onclick="window.open('${unauthServerUrl}/popup-target');">Open Popup</button>
  </body>
</html>`);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    authServer.on("upgrade", (req, socket) => {
      authWsUpgradeRequests++;
      acceptWebSocketHandshake(req, socket);
    });

    await new Promise<void>((r) => {
      authServer.listen(0, "127.0.0.1", () => {
        authServerPort = (authServer.address() as any).port;
        authServerUrl = `http://127.0.0.1:${authServerPort}`;
        r();
      });
    });

    // 2. Unauthorized server (live HTTP + WebSocket listener on unapproved local port)
    unauthServer = http.createServer((_req, res) => {
      unauthServerRequests++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Unauthorized Port Secret Data");
    });

    unauthServer.on("upgrade", (req, socket) => {
      unauthWsUpgradeRequests++;
      acceptWebSocketHandshake(req, socket);
    });

    await new Promise<void>((r) => {
      unauthServer.listen(0, "127.0.0.1", () => {
        unauthServerPort = (unauthServer.address() as any).port;
        unauthServerUrl = `http://127.0.0.1:${unauthServerPort}`;
        r();
      });
    });

    // 3. Metadata mock server
    metadataMockServer = http.createServer((_req, res) => {
      metadataServerRequests++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("iam/security-credentials/admin-role");
    });

    await new Promise<void>((r) => {
      metadataMockServer.listen(0, "127.0.0.1", () => {
        metadataMockUrl = `http://127.0.0.1:${(metadataMockServer.address() as any).port}`;
        r();
      });
    });

    // 4. Workspace B dedicated server
    wsBServer = http.createServer((_req, res) => {
      wsBServerRequests++;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><head><title>Workspace B App</title></head><body><h1>WS-B</h1></body></html>");
    });

    await new Promise<void>((r) => {
      wsBServer.listen(0, "127.0.0.1", () => {
        wsBServerUrl = `http://127.0.0.1:${(wsBServer.address() as any).port}`;
        r();
      });
    });
  });

  after(async () => {
    await Promise.all([
      closeHttpServer(authServer),
      closeHttpServer(unauthServer),
      closeHttpServer(metadataMockServer),
      closeHttpServer(wsBServer),
    ]);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Scenario 1: Browser launches with the intended sandbox configuration & independent runtime proof
  test("1. Browser launches with intended sandbox configuration and records independent OS process runtime verification", async (t) => {
    const preflightCap = verifyEffectiveSandboxSupport();
    assert.strictEqual(preflightCap.supported, true, `Sandbox capability must be supported: ${preflightCap.details}`);

    const prov = detectBrowserProvisioning();
    assert.strictEqual(prov.status, "READY");
    assert.ok(prov.executable?.path);

    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    let sandboxVerifiedEvent: BrowserEvent | undefined;
    sessionManager.onEvent((ev) => {
      if (ev.type === "sandbox_verified") sandboxVerifiedEvent = ev;
    });

    try {
      await sessionManager.start();
      const verification = sessionManager.getSandboxVerification();
      assert.ok(verification, "Effective sandbox verification must be recorded");
      assert.strictEqual(verification.capabilitySupported, true);
      assert.strictEqual(verification.supported, true);
      assert.strictEqual(verification.runtimeVerified, true, "Runtime process verification must succeed");
      assert.strictEqual(verification.platform, process.platform);
      assert.strictEqual(verification.osRelease, os.release());
      assert.strictEqual(verification.processFlags.chromiumSandboxOption, true);
      assert.strictEqual(verification.processFlags.noSandboxIntroduced, false);
      assert.ok(verification.browserPid && verification.browserPid > 0, "Live Chromium main PID must be recorded");
      assert.ok(verification.helperPids && verification.helperPids.length >= 1, "At least one sandboxed helper PID must be verified");
      assert.ok(verification.browserVersion && verification.browserVersion !== "unknown", "Actual Chromium version must be recorded");
      assert.ok(verification.executablePath && fs.existsSync(verification.executablePath));
      if (process.platform === "darwin") {
        assert.strictEqual(verification.processFlags.seatbeltClientActive, true, "macOS Seatbelt helper flag must be verified");
      }
      assert.ok(sandboxVerifiedEvent, "sandbox_verified observability event must be emitted");

      t.diagnostic(
        `Provenance: OS=${verification.platform} ${verification.osRelease} | Chromium=${verification.browserVersion} | Source=${verification.executableSource} | Method=${verification.verificationMethod} | Exec=${verification.executablePath}`
      );
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 2: Browser starts with an isolated temporary profile outside repository with 0700 permissions
  test("2. Browser starts with isolated temporary profile outside workspace repository, 0700 permissions, and orphan cleanup", async () => {
    // Reject configuring storageDir inside workspaceRoot
    const unsafeMgr = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      storageDir: path.join(workspaceRootA, ".browser-profile"),
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });
    await assert.rejects(
      () => unsafeMgr.start(),
      (err: any) => err instanceof BrowserSessionError && err.code === "UNSAFE_PROFILE_PATH"
    );
    await unsafeMgr.dispose();

    // Seed an expired orphan profile directory (> 2 hours old) and verify bounded retention cleanup
    const orphanBase = path.join(os.tmpdir(), "open-vs-code-browser-profiles");
    fs.mkdirSync(orphanBase, { recursive: true });
    const staleOrphan = path.join(orphanBase, "ovsc_stale_orphan_test");
    fs.mkdirSync(staleOrphan, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 7200 * 1000);
    fs.utimesSync(staleOrphan, twoHoursAgo, twoHoursAgo);
    cleanupOrphanedBrowserProfiles(3600000, orphanBase);
    assert.strictEqual(fs.existsSync(staleOrphan), false, "Expired orphan profile must be cleaned up");

    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "test-profile-iso",
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    let startedProfileDir: string | undefined;
    sessionManager.onEvent((ev) => {
      if (ev.type === "session_started") {
        startedProfileDir = ev.details.profileDir as string;
      }
    });

    try {
      await sessionManager.start();
      assert.ok(startedProfileDir);
      assert.strictEqual(startedProfileDir.startsWith(workspaceRootA), false);
      assert.strictEqual(fs.existsSync(path.join(workspaceRootA, ".browser-profile")), false);
      assert.ok(startedProfileDir.startsWith(os.tmpdir()));
      assert.ok(fs.existsSync(startedProfileDir));
      if (process.platform !== "win32") {
        const mode = fs.statSync(startedProfileDir).mode & 0o777;
        assert.strictEqual(mode, 0o700, "Temporary profile directory must enforce 0700 permissions");
      }
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 3: Authorized local origin loads successfully
  test("3. Authorized local origin loads successfully and increments independent server counter", async () => {
    const initialCount = authServerRequests;
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      const page = await sessionManager.open(`${authServerUrl}/safe`);
      assert.strictEqual(page.title, "Safe Authorized Page");
      assert.ok(authServerRequests > initialCount, "Authorized server must receive real HTTP request");
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 4: Unauthorized local port is blocked
  test("4. Unauthorized local port is blocked fail-closed; target server receives 0 requests", async () => {
    const unauthCountBefore = unauthServerRequests;
    const deniedEvents: BrowserEvent[] = [];
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });
    sessionManager.onEvent((ev) => {
      if (ev.type === "network_policy_denied") deniedEvents.push(ev);
    });

    try {
      await assert.rejects(
        () => sessionManager.open(`${unauthServerUrl}/unauthorized-data`),
        /not authorized under the effective browser network policy/
      );
      assert.strictEqual(unauthServerRequests, unauthCountBefore, "Unauthorized port must receive 0 requests");
      assert.ok(deniedEvents.length >= 1, "network_policy_denied event must be recorded");
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 5: An allowlisted hostname resolving to a prohibited address is rejected
  test("5. Allowlisted hostname resolving to prohibited IP (cloud metadata / private RFC1918 / IPv6 ULA) is rejected", async () => {
    for (const prohibitedIp of ["169.254.169.254", "10.24.0.5", "fc00::1", "::ffff:169.254.169.254"]) {
      const fakeAllowedOrigin = `http://dev-service.local:${unauthServerPort}`;
      const dnsEvents: BrowserEvent[] = [];
      const sessionManager = new BrowserSessionManager({
        workspaceRoot: workspaceRootA,
        networkPolicy: {
          allowedOrigins: [fakeAllowedOrigin],
          customResolver: async () => [prohibitedIp],
        },
      });
      sessionManager.onEvent((ev) => {
        if (ev.type === "destination_resolution_failed") dnsEvents.push(ev);
      });

      try {
        await assert.rejects(
          () => sessionManager.open(`${fakeAllowedOrigin}/secret`),
          /ERR_BLOCKED_BY_CLIENT|DNS Rebinding Blocked|restricted/
        );
        assert.strictEqual(unauthServerRequests, 0, "Prohibited resolution must never connect locally");
        assert.ok(dnsEvents.length >= 1, `destination_resolution_failed must be emitted for ${prohibitedIp}`);
      } finally {
        await sessionManager.dispose();
      }
    }
  });

  // Scenario 6: DNS rebinding cannot bypass connection policy (validation-to-connect TOCTOU + socket IP pinning)
  test("6. DNS rebinding cannot bypass connection policy (preflight returns public IP, connect-time rebinds to 127.0.0.1)", async () => {
    const unauthBefore = unauthServerRequests;
    let lookupCount = 0;

    // Adversarial TOCTOU DNS resolver:
    // Lookup #1 (context preflight check) returns a safe public IP (93.184.216.34), passing preflight!
    // Lookup #2+ (connection-time check at BrowserEgressProxy) rebinds to 127.0.0.1 targeting live unauthServerPort!
    const rebindingResolver = async (_host: string) => {
      lookupCount++;
      if (lookupCount === 1) {
        return ["93.184.216.34"];
      }
      return ["127.0.0.1"];
    };

    const rebindOrigin = `http://rebinding-attacker.example:${unauthServerPort}`;
    const dnsFailureEvents: BrowserEvent[] = [];
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: {
        allowedOrigins: [rebindOrigin],
        customResolver: rebindingResolver,
      },
    });
    sessionManager.onEvent((ev) => {
      if (ev.type === "destination_resolution_failed") dnsFailureEvents.push(ev);
    });

    try {
      // Because preflight sees 93.184.216.34, Chromium issues the HTTP request through BrowserEgressProxy,
      // which catches Lookup #2 (127.0.0.1 rebinding!) with HTTP 403 and NEVER touches unauthServer!
      await sessionManager.open(`${rebindOrigin}/steal-local-secret`).catch(() => {});
      const snap = await sessionManager.snapshot().catch(() => undefined);
      if (snap) {
        assert.strictEqual(
          snap.tree.includes("Unauthorized Port Secret Data"),
          false,
          "Rebound response body must never be loaded"
        );
      }
      assert.ok(lookupCount >= 2, "Both preflight and connection-time egress proxy checks must run");
      assert.ok(dnsFailureEvents.length >= 1, "Egress proxy must emit destination_resolution_failed on rebind");
      assert.strictEqual(
        unauthServerRequests,
        unauthBefore,
        "Live server on rebound port must receive 0 requests"
      );

      // Also verify socket-level IP pinning in BrowserEgressProxy: resolver consulted once per proxy connection
      let proxyLookups = 0;
      const proxy = new BrowserEgressProxy({
        policy: { allowedOrigins: ["http://pinned.example:80"] },
        customResolver: async () => {
          proxyLookups++;
          return proxyLookups === 1 ? ["203.0.113.7"] : ["127.0.0.1"];
        },
      });
      await proxy.start();
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port: proxy.port,
              path: "http://pinned.example/test",
              headers: { Host: "pinned.example" },
              timeout: 1500,
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            }
          );
          req.on("timeout", () => {
            req.destroy();
            resolve(504);
          });
          req.on("error", reject);
          req.end();
        });
        assert.notStrictEqual(status, 200);
        assert.strictEqual(proxyLookups, 1, "Socket must be pinned to verified IP with zero second lookup");
      } finally {
        await proxy.stop();
      }
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 7: Redirects to metadata endpoints and excessive redirect chains are blocked
  test("7. Redirects to metadata endpoints and redirect loops are blocked; metadata server receives 0 requests", async () => {
    const metaCountBefore = metadataServerRequests;
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl], maxRedirects: 4 },
    });

    try {
      await assert.rejects(
        () => sessionManager.open(`${authServerUrl}/redirect-to-metadata`),
        /ERR_BLOCKED_BY_CLIENT|Navigation terminated at unauthorized|not authorized/
      );
      assert.strictEqual(metadataServerRequests, metaCountBefore, "Metadata mock server must receive 0 requests");

      await assert.rejects(
        () => sessionManager.open(`${authServerUrl}/redirect-to-aws-ip`),
        /ERR_BLOCKED_BY_CLIENT|Navigation terminated at unauthorized|cloud metadata/
      );

      await assert.rejects(
        () => sessionManager.open(`${authServerUrl}/redirect-loop`),
        /ERR_BLOCKED_BY_CLIENT|ERR_TOO_MANY_REDIRECTS|Redirect chain/
      );
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 8: Popups cannot escape destination restrictions
  test("8. Popups cannot escape destination restrictions; unauthorized popup server receives 0 requests", async () => {
    const unauthCountBefore = unauthServerRequests;
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      await sessionManager.open(`${authServerUrl}/popup-trigger`);
      const snap = await sessionManager.snapshot();
      const popupRef = snap.elements.find((e) => e.name.includes("Open Popup"));
      assert.ok(popupRef);

      await sessionManager.click(popupRef.refId);
      await new Promise((r) => setTimeout(r, 250));

      assert.strictEqual(unauthServerRequests, unauthCountBefore, "Unauthorized popup server received 0 requests");
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 9: Iframes and subresources obey restrictions
  test("9. Iframes, images, and fetch subresources obey restrictions; unapproved server receives 0 requests", async () => {
    const unauthCountBefore = unauthServerRequests;
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      await sessionManager.open(`${authServerUrl}/with-unauth-subresources`);
      await new Promise((r) => setTimeout(r, 250));

      assert.strictEqual(unauthServerRequests, unauthCountBefore, "Unauthorized subresource server received 0 requests");
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 10: WebSocket restrictions apply to real connections (verified via live server upgrade counters)
  test("10. WebSocket restrictions apply to real connections; live unauthorized WS upgrade server receives 0 upgrades", async () => {
    const unauthWsBefore = unauthWsUpgradeRequests;
    const authWsBefore = authWsUpgradeRequests;

    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      await sessionManager.open(`${authServerUrl}/safe`);
      const page = sessionManager.getActivePage();
      assert.ok(page);

      // 10a: Authorized WS to live authServer succeeds (proving WebSocket plumbing works when authorized)
      const authWsResult = await page.evaluate(async (wsUrl: string) => {
        return new Promise<string>((resolve) => {
          const ws = new WebSocket(wsUrl);
          ws.addEventListener("open", () => {
            ws.close();
            resolve("WS_OPEN");
          });
          ws.addEventListener("error", () => resolve("WS_ERROR"));
          setTimeout(() => resolve("WS_TIMEOUT"), 2000);
        });
      }, `ws://127.0.0.1:${authServerPort}/authorized-ws`);
      assert.strictEqual(authWsResult, "WS_OPEN", "Authorized WebSocket should connect cleanly");
      assert.strictEqual(authWsUpgradeRequests, authWsBefore + 1);

      // 10b: Unauthorized WS to live unauthServer MUST be blocked with 0 server-side upgrade requests
      const unauthWsResult = await page.evaluate(async (wsUrl: string) => {
        return new Promise<string>((resolve) => {
          try {
            const ws = new WebSocket(wsUrl);
            ws.addEventListener("open", () => resolve("WS_OPEN_LEAK"));
            ws.addEventListener("error", () => resolve("WS_ERROR"));
            ws.addEventListener("close", () => resolve("WS_CLOSED"));
            setTimeout(() => resolve("WS_TIMEOUT"), 1500);
          } catch (e: any) {
            resolve(`WS_THREW:${e.message}`);
          }
        });
      }, `ws://127.0.0.1:${unauthServerPort}/unauth-ws`);
      assert.notStrictEqual(unauthWsResult, "WS_OPEN_LEAK");
      assert.strictEqual(
        unauthWsUpgradeRequests,
        unauthWsBefore,
        "Live unauthorized WebSocket server must receive 0 upgrade requests"
      );
    } finally {
      await sessionManager.dispose();
    }

    // 10c: Policy with blockWebSockets: true blocks WS even on authorized origin
    const authWsCountBeforeBlock = authWsUpgradeRequests;
    const wsBlockedMgr = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl], blockWebSockets: true },
    });
    try {
      await wsBlockedMgr.open(`${authServerUrl}/safe`);
      const page = wsBlockedMgr.getActivePage()!;
      const blockedRes = await page.evaluate(async (wsUrl: string) => {
        return new Promise<string>((resolve) => {
          const ws = new WebSocket(wsUrl);
          ws.addEventListener("open", () => resolve("WS_OPEN_LEAK"));
          ws.addEventListener("error", () => resolve("WS_BLOCKED"));
          ws.addEventListener("close", () => resolve("WS_BLOCKED"));
          setTimeout(() => resolve("WS_TIMEOUT"), 1500);
        });
      }, `ws://127.0.0.1:${authServerPort}/blocked-ws`);
      assert.notStrictEqual(blockedRes, "WS_OPEN_LEAK");
      assert.strictEqual(authWsUpgradeRequests, authWsCountBeforeBlock, "Blocked WS policy must prevent server upgrade");
    } finally {
      await wsBlockedMgr.dispose();
    }
  });

  // Scenario 11: Service Workers cannot bypass effective policy
  test("11. Service Workers cannot bypass effective policy; live /sw.js endpoint receives 0 requests", async () => {
    const swBefore = swScriptRequests;
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      await sessionManager.open(`${authServerUrl}/safe`);
      const page = sessionManager.getActivePage()!;

      const swAttempt = await page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) return "NO_SW_API";
        try {
          await navigator.serviceWorker.register("/sw.js");
          return "REGISTERED";
        } catch (err: any) {
          return `REJECTED:${err.message}`;
        }
      });

      assert.notStrictEqual(swAttempt, "REGISTERED");
      assert.strictEqual(swScriptRequests, swBefore, "Service Worker script endpoint must receive 0 requests");
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 12: DOM replacement invalidates a previously approved click
  test("12. DOM replacement invalidates a previously approved click in prepareForReview.apply()", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      await sessionManager.open(`${authServerUrl}/form`);
      const snap = await sessionManager.snapshot();
      const harmlessRef = snap.elements.find((e) => e.name === "Harmless Info")!;
      assert.ok(harmlessRef);

      const tools = createBrowserToolRegistrations(sessionManager);
      const clickTool = tools.find((t) => t.definition.name === "browser_click")!;
      const ctx = { workspaceRoot: workspaceRootA, signal: new AbortController().signal };

      // Obtain approval while element is intact
      const approvedReview = await clickTool.prepareForReview!({ refId: harmlessRef.refId }, ctx);

      // Replace the DOM node with a brand-new button carrying the same ID
      const page = sessionManager.getActivePage()!;
      await page.evaluate(() => {
        const oldBtn = document.getElementById("btn-harmless")!;
        const replacement = document.createElement("button");
        replacement.id = "btn-harmless";
        replacement.type = "button";
        replacement.innerText = "Harmless Info";
        replacement.addEventListener("click", () => {
          document.getElementById("out")!.innerText = "ReplacedExecuted";
        });
        oldBtn.replaceWith(replacement);
      });

      // Applying the prior approval MUST reject with STALE_ELEMENT_REFERENCE and NOT click the replacement
      await assert.rejects(
        () => approvedReview.apply(ctx),
        (err: any) => err instanceof BrowserSessionError && err.code === "STALE_ELEMENT_REFERENCE"
      );
      const outText = await page.locator("#out").innerText();
      assert.strictEqual(outText, "Ready", "Replaced control must never be clicked");
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 13: Destructive target substitution, reordered controls, duplicate refs, and async risk escalation
  test("13. Target binding blocks destructive substitution, reordered controls, malicious duplicate refs, and async side-effect/sensitive escalation", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      const tools = createBrowserToolRegistrations(sessionManager);
      const clickTool = tools.find((t) => t.definition.name === "browser_click")!;
      const fillTool = tools.find((t) => t.definition.name === "browser_fill")!;
      const ctx = { workspaceRoot: workspaceRootA, signal: new AbortController().signal };

      // 13a: Formerly harmless control renamed to destructive after approval
      await sessionManager.open(`${authServerUrl}/form`);
      let snap = await sessionManager.snapshot();
      let harmlessRef = snap.elements.find((e) => e.name === "Harmless Info")!;
      const approved13a = await clickTool.prepareForReview!({ refId: harmlessRef.refId }, ctx);

      const page = sessionManager.getActivePage()!;
      await page.evaluate(() => {
        const btn = document.getElementById("btn-harmless")!;
        btn.innerText = "Delete Production Cluster";
        btn.setAttribute("aria-label", "Delete Production Cluster");
      });

      await assert.rejects(
        () => approved13a.apply(ctx),
        (err: any) => err instanceof BrowserSessionError && err.code === "ACTION_RISK_ESCALATED"
      );

      // 13b: Reordered controls — swapping [Delete Everything, Harmless Info] in DOM must NEVER click Delete Everything,
      // and moving Harmless Info into a malicious external form invalidates approval with TARGET_MUTATION_DETECTED
      await sessionManager.open(`${authServerUrl}/form`);
      snap = await sessionManager.snapshot();
      harmlessRef = snap.elements.find((e) => e.name === "Harmless Info")!;
      const approved13b = await clickTool.prepareForReview!({ refId: harmlessRef.refId }, ctx);

      await page.evaluate(() => {
        const form = document.getElementById("sec-form")!;
        const delBtn = document.getElementById("btn-delete")!;
        const harmBtn = document.getElementById("btn-harmless")!;
        // Put Delete button first in DOM order
        form.insertBefore(delBtn, form.firstChild);
        // Move Harmless button into a newly injected form with different formAction
        const rogueForm = document.createElement("form");
        rogueForm.id = "rogue-form";
        rogueForm.action = "/submit-endpoint";
        document.body.appendChild(rogueForm);
        rogueForm.appendChild(harmBtn);
      });

      await assert.rejects(
        () => approved13b.apply(ctx),
        (err: any) => err instanceof BrowserSessionError && err.code === "TARGET_MUTATION_DETECTED"
      );
      assert.strictEqual(await page.locator("#out").innerText(), "Ready");

      // 13c: Malicious duplicate data-ovsc-ref / data-ovsc-snap / data-ovsc-session attributes injected by page JS
      await sessionManager.open(`${authServerUrl}/form`);
      snap = await sessionManager.snapshot();
      harmlessRef = snap.elements.find((e) => e.name === "Harmless Info")!;
      const approved13c = await clickTool.prepareForReview!({ refId: harmlessRef.refId }, ctx);

      await page.evaluate(() => {
        const harmBtn = document.getElementById("btn-harmless")!;
        const delBtn = document.getElementById("btn-delete")!;
        delBtn.setAttribute("data-ovsc-ref", harmBtn.getAttribute("data-ovsc-ref")!);
        delBtn.setAttribute("data-ovsc-snap", harmBtn.getAttribute("data-ovsc-snap")!);
        delBtn.setAttribute("data-ovsc-session", harmBtn.getAttribute("data-ovsc-session")!);
      });

      await assert.rejects(
        () => approved13c.apply(ctx),
        (err: any) => err instanceof BrowserSessionError && err.code === "AMBIGUOUS_TARGET_REFERENCE"
      );
      assert.strictEqual(await page.locator("#out").innerText(), "Ready");

      // 13d: Asynchronous mutation escalating button type="button" -> type="submit" (side-effect escalation)
      await sessionManager.open(`${authServerUrl}/form`);
      snap = await sessionManager.snapshot();
      harmlessRef = snap.elements.find((e) => e.name === "Harmless Info")!;
      assert.strictEqual(harmlessRef.sideEffect, false);
      const approved13d = await clickTool.prepareForReview!({ refId: harmlessRef.refId }, ctx);

      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              const harmBtn = document.getElementById("btn-harmless") as HTMLButtonElement;
              harmBtn.type = "submit";
              resolve();
            }, 30);
          })
      );

      const submissionsBefore = formActionSubmissions;
      await assert.rejects(
        () => approved13d.apply(ctx),
        (err: any) => err instanceof BrowserSessionError && err.code === "ACTION_RISK_ESCALATED"
      );
      assert.strictEqual(formActionSubmissions, submissionsBefore, "Escalated submit must not fire");

      // 13e: browser_fill target mutating from ordinary text input to password field after approval
      await sessionManager.open(`${authServerUrl}/form`);
      snap = await sessionManager.snapshot();
      const userField = snap.elements.find((e) => e.selector === "#username")!;
      assert.strictEqual(userField.sensitive, false);
      const approvedFill = await fillTool.prepareForReview!(
        { refId: userField.refId, value: "bob" },
        ctx
      );

      await page.evaluate(() => {
        const inp = document.getElementById("username") as HTMLInputElement;
        inp.type = "password";
      });

      await assert.rejects(
        () => approvedFill.apply(ctx),
        (err: any) => err instanceof BrowserSessionError && err.code === "ACTION_RISK_ESCALATED"
      );
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 14: Password contents and secrets do not appear across snapshots, URLs, titles, console, diagnostics, screenshots, or approval payloads
  test("14. Sensitive data redaction across form values, URLs, titles, console, network diagnostics, screenshots, and approval payloads", async () => {
    const events: BrowserEvent[] = [];
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });
    sessionManager.onEvent((ev) => events.push(ev));

    try {
      // 1. Form values & approval payloads & screenshot masking
      await sessionManager.open(`${authServerUrl}/form?token=RawQuerySecret777`);
      const snap = await sessionManager.snapshot();

      assert.strictEqual(snap.tree.includes("SuperSecretP@ss99"), false);
      assert.strictEqual(snap.tree.includes("sec_tok_998877"), false);
      assert.strictEqual(snap.url.includes("RawQuerySecret777"), false);
      assert.ok(snap.url.includes("[REDACTED_SECRET]"));

      const pwdEl = snap.elements.find((e) => e.selector === "#password")!;
      assert.strictEqual(pwdEl.sensitive, true);
      assert.strictEqual(pwdEl.value, undefined);
      assert.ok(snap.tree.includes("[hasValue]"));

      const tokenEl = snap.elements.find((e) => e.selector === "#apikey")!;
      assert.strictEqual(tokenEl.sensitive, true);
      assert.strictEqual(tokenEl.value, undefined);

      const tools = createBrowserToolRegistrations(sessionManager);
      const fillTool = tools.find((t) => t.definition.name === "browser_fill")!;
      const screenshotTool = tools.find((t) => t.definition.name === "browser_screenshot")!;
      const ctx = { workspaceRoot: workspaceRootA, signal: new AbortController().signal };

      const fillReview = await fillTool.prepareForReview!(
        { refId: pwdEl.refId, value: "MyNewTopSecretPass!123" },
        ctx
      );
      const payloadJson = JSON.stringify(fillReview.reviewPayload);
      assert.strictEqual(payloadJson.includes("MyNewTopSecretPass!123"), false);
      assert.strictEqual(payloadJson.includes("RawQuerySecret777"), false);
      assert.strictEqual(fillReview.reviewPayload.displayValue, "[REDACTED SENSITIVE DATA]");

      // Screenshot tool output exposes bounded metadata only, never raw image bytes in JSON/events
      const shotOut = (await screenshotTool.execute({ fullPage: false }, ctx)) as Record<string, unknown>;
      assert.strictEqual(shotOut.ok, true);
      assert.strictEqual("base64" in shotOut, false, "Tool output must not dump raw screenshot base64 into logs/JSON");
      const shotEvent = events.find((e) => e.type === "screenshot_taken");
      assert.ok(shotEvent);
      assert.strictEqual("base64" in shotEvent.details, false);
      assert.ok((shotEvent.details.maskedSensitiveFields as number) >= 2);

      // 2. Page titles, console buffers, and network diagnostics
      await sessionManager.open(`${authServerUrl}/secret-echo?api_key=UrlKeyLeak888`);
      const echoSnap = await sessionManager.snapshot();
      assert.strictEqual(echoSnap.title.includes("TitleSecretToken999"), false);
      assert.strictEqual(echoSnap.title.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);

      const consoleLogs = JSON.stringify(sessionManager.getConsoleDiagnostics());
      assert.strictEqual(consoleLogs.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);
      assert.strictEqual(consoleLogs.includes("AKIAIOSFODNN7EXAMPLE"), false);
      assert.strictEqual(consoleLogs.includes("ovsc_sess_998877665544"), false);

      // Trigger blocked request with secret query param and verify network diagnostics redaction
      await assert.rejects(() =>
        sessionManager.open(`${unauthServerUrl}/steal?password=PlaintextUrlPassword111`)
      );
      const netLogs = JSON.stringify(sessionManager.getNetworkDiagnostics());
      assert.strictEqual(netLogs.includes("PlaintextUrlPassword111"), false);
      const allEventsSerialized = JSON.stringify(events);
      assert.strictEqual(allEventsSerialized.includes("PlaintextUrlPassword111"), false);
      assert.strictEqual(allEventsSerialized.includes("SuperSecretP@ss99"), false);
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 15: Account switching terminates and invalidates sessions across two account identities
  test("15. Account switching across two account identities terminates process, removes profile, and invalidates authority", async () => {
    const managerAlice = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      accountId: "account-alice",
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });
    const managerBob = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      accountId: "account-bob",
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    const aliceEvents: BrowserEvent[] = [];
    managerAlice.onEvent((ev) => aliceEvents.push(ev));

    try {
      await managerAlice.open(`${authServerUrl}/safe`);
      const alicePage = managerAlice.getActivePage()!;
      await alicePage.evaluate(() => localStorage.setItem("acctSecret", "alice-only-token"));
      const alicePid = managerAlice.getBrowserPid()!;
      const aliceProfile = managerAlice.getUserDataDir()!;
      assert.ok(alicePid > 0);
      assert.strictEqual(fs.existsSync(aliceProfile), true);

      // Simulate account switch Alice -> Bob
      await managerAlice.invalidate("account_switch");
      assert.strictEqual(managerAlice.getStatus(), "CLOSED");
      assert.ok(aliceEvents.some((e) => e.type === "session_invalidated" && e.details.reason === "account_switch"));
      assert.strictEqual(fs.existsSync(aliceProfile), false, "Alice profile must be wiped on account switch");

      await assert.rejects(
        () => managerAlice.open(`${authServerUrl}/safe`),
        (err: any) => err instanceof BrowserSessionError && err.code === "DISPOSED"
      );

      // Bob starts clean in the same workspace with zero access to Alice's localStorage
      await managerBob.open(`${authServerUrl}/safe`);
      const bobVal = await managerBob.getActivePage()!.evaluate(() => localStorage.getItem("acctSecret"));
      assert.strictEqual(bobVal, null, "Bob must never inherit Alice storage state");
      assert.notStrictEqual(managerBob.getBrowserPid(), alicePid);
    } finally {
      await managerAlice.dispose();
      await managerBob.dispose();
    }
  });

  // Scenario 16: Workspace switching does not reuse browser authority or storage
  test("16. Workspace switching isolates origin authority and storage across two real workspaces", async () => {
    const managerWsA = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      accountId: "account-alice",
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });
    const managerWsB = new BrowserSessionManager({
      workspaceRoot: workspaceRootB,
      accountId: "account-alice",
      networkPolicy: { allowedOrigins: [wsBServerUrl] },
    });

    try {
      const wsBBefore = wsBServerRequests;
      await managerWsA.open(`${authServerUrl}/safe`);
      await managerWsB.open(`${wsBServerUrl}/`);
      assert.ok(wsBServerRequests > wsBBefore, "Workspace B must reach its own authorized server");

      // Workspace B manager MUST NOT permit Workspace A's authorized origin!
      const authBefore = authServerRequests;
      await assert.rejects(
        () => managerWsB.open(`${authServerUrl}/safe`),
        /not authorized under the effective browser network policy/
      );
      assert.strictEqual(authServerRequests, authBefore, "Workspace B must not carry over Workspace A origin authority");
    } finally {
      await managerWsA.dispose();
      await managerWsB.dispose();
    }
  });

  // Scenario 17: Temporary profiles and OS processes are completely removed after disposal
  test("17. Temporary profiles are purged from disk and Chromium PID terminates on disposal", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      sessionId: "clean-profile-test",
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    await sessionManager.start();
    const profileDir = sessionManager.getUserDataDir()!;
    const pid = sessionManager.getBrowserPid()!;
    assert.ok(profileDir && fs.existsSync(profileDir));
    assert.ok(pid > 0);

    await sessionManager.dispose();
    assert.strictEqual(fs.existsSync(profileDir), false, "Temporary profile directory must be deleted");

    // Verify OS process exited
    let alive = true;
    for (let i = 0; i < 10; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
        break;
      }
    }
    assert.strictEqual(alive, false, "Chromium browser OS process must be terminated on dispose");
  });

  // Scenario 18: Cancellation stops active in-flight browser operations promptly
  test("18. Cancellation aborts active in-flight navigation via AbortSignal without waiting for full timeout", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    let cancellationEvent = false;
    sessionManager.onEvent((ev) => {
      if (ev.type === "cancellation") cancellationEvent = true;
    });

    try {
      await sessionManager.open(`${authServerUrl}/safe`);
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 150);
      const t0 = Date.now();

      await assert.rejects(
        () => sessionManager.navigate(`${authServerUrl}/slow-hang`, controller.signal),
        (err: any) => err.name === "AbortError"
      );
      clearTimeout(abortTimer);

      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 4000, `In-flight navigation must abort promptly (took ${elapsed}ms vs 15000ms hang)`);
      assert.strictEqual(cancellationEvent, true);
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 19: Real Chromium process crash produces bounded error and clean recovery
  test("19. Real Chromium SIGKILL crash produces bounded error without hang and recovers cleanly on next open()", async () => {
    const sessionManager = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });

    try {
      await sessionManager.open(`${authServerUrl}/safe`);
      const initialPid = sessionManager.getBrowserPid()!;
      assert.ok(initialPid > 0);

      // Force-kill the real Chromium main OS process
      process.kill(initialPid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));

      // Snapshot on crashed browser must fail fast with structured error (no infinite hang)
      await assert.rejects(
        () => sessionManager.snapshot(),
        (err: any) => err instanceof BrowserSessionError && err.code === "NO_PAGE"
      );

      // Bounded recovery: calling open() launches a fresh sandboxed Chromium instance
      const recovered = await sessionManager.open(`${authServerUrl}/safe`);
      assert.strictEqual(recovered.title, "Safe Authorized Page");
      const newPid = sessionManager.getBrowserPid()!;
      assert.ok(newPid > 0 && newPid !== initialPid, "Recovered browser must run under a fresh PID");
      assert.strictEqual(sessionManager.getSandboxVerification()?.runtimeVerified, true);
    } finally {
      await sessionManager.dispose();
    }
  });

  // Scenario 20: Production AgentRuntime + AgentRunner + PermissionGate invokes real Playwright tools
  test("20. Production AgentRuntime & AgentRunner enforce effectiveAction with PermissionGate (DENY in PLAN, CONFIRM + revalidate in BUILD)", async () => {
    // 20a: PLAN mode — allows browser_open & browser_snapshot, DENIES browser_click (browser_side_effect)
    const planBrowser = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });
    const planEvents: AgentEvent[] = [];

    try {
      const planProvider = new ScriptedModelProvider([
        {
          model: "scripted-plan",
          message: { role: "assistant", content: "Opening page." },
          toolCalls: [{ id: "tc-open-1", name: "browser_open", arguments: { url: `${authServerUrl}/form` } }],
        },
        {
          model: "scripted-plan",
          message: { role: "assistant", content: "Taking snapshot." },
          toolCalls: [{ id: "tc-snap-1", name: "browser_snapshot", arguments: {} }],
        },
        (req) => {
          const fullPrompt = req.messages.map((m) => m.content).join("\n");
          const match = fullPrompt.match(/\[ref=(e\d+)\]\s*<button>[^[]*Submit Order/);
          assert.ok(match?.[1], "Submit Order refId must appear in compiled model prompt");
          return {
            model: "scripted-plan",
            message: { role: "assistant", content: "Attempting submit click in PLAN mode." },
            toolCalls: [{ id: "tc-click-plan", name: "browser_click", arguments: { refId: match[1] } }],
          };
        },
        {
          model: "scripted-plan",
          message: { role: "assistant", content: "Click was denied by PLAN mode policy as expected." },
        },
      ]);

      const planRuntime = await createAgentRuntime({
        workspaceRoot: workspaceRootA,
        mode: "PLAN",
        instruction: "Inspect form page in PLAN mode",
        isTrusted: true,
        providerOverride: planProvider,
        browserSessionManager: planBrowser,
        eventSink: (ev) => planEvents.push(ev),
      });

      try {
        const planResult = await planRuntime.runner.run(planRuntime.runnerInput);
        assert.ok(
          planResult.status === "COMPLETED" || planResult.status === "FAILED",
          `Unexpected PLAN mode terminal status: ${planResult.status}`
        );

        const deniedEvent = planEvents.find(
          (e) => e.type === "permission.denied" && (e.payload as any)?.name === "browser_click"
        );
        assert.ok(deniedEvent, "PermissionGate must emit permission.denied for browser_click in PLAN mode");
        assert.strictEqual(
          (deniedEvent.payload as any)?.action,
          "browser_side_effect",
          "AgentRunner must classify Submit Order as browser_side_effect before PermissionGate"
        );
        const outText = await planBrowser.getActivePage()!.locator("#out").innerText();
        assert.strictEqual(outText, "Ready", "Denied click in PLAN mode must never mutate page");
      } finally {
        await planRuntime.cleanup();
      }
    } finally {
      await planBrowser.dispose();
    }

    // 20b: BUILD mode — pauses at WAITING_FOR_CONFIRMATION with effectiveAction: "browser_side_effect",
    // revalidates target on APPROVE, and executes real Chromium click!
    const buildBrowser = new BrowserSessionManager({
      workspaceRoot: workspaceRootA,
      networkPolicy: { allowedOrigins: [authServerUrl] },
    });
    const buildAgentEvents: AgentEvent[] = [];
    const buildBrowserEvents: BrowserEvent[] = [];
    buildBrowser.onEvent((ev) => buildBrowserEvents.push(ev));

    try {
      const buildProvider = new ScriptedModelProvider([
        {
          model: "scripted-build",
          message: { role: "assistant", content: "Opening form." },
          toolCalls: [{ id: "tc-open-b", name: "browser_open", arguments: { url: `${authServerUrl}/form` } }],
        },
        {
          model: "scripted-build",
          message: { role: "assistant", content: "Snapshotting form." },
          toolCalls: [{ id: "tc-snap-b", name: "browser_snapshot", arguments: {} }],
        },
        (req) => {
          const fullPrompt = req.messages.map((m) => m.content).join("\n");
          const match = fullPrompt.match(/\[ref=(e\d+)\]\s*<button>[^[]*Submit Order/);
          assert.ok(match?.[1], "Submit Order refId must appear in compiled model prompt");
          return {
            model: "scripted-build",
            message: { role: "assistant", content: "Requesting click on Submit Order." },
            toolCalls: [{ id: "tc-click-b", name: "browser_click", arguments: { refId: match[1] } }],
          };
        },
        {
          model: "scripted-build",
          message: { role: "assistant", content: "Submit Order completed after human approval." },
        },
      ]);

      const buildRuntime = await createAgentRuntime({
        workspaceRoot: workspaceRootA,
        mode: "BUILD",
        instruction: "Open form and click Submit Order with confirmation",
        isTrusted: true,
        providerOverride: buildProvider,
        browserSessionManager: buildBrowser,
        eventSink: (ev) => buildAgentEvents.push(ev),
      });

      try {
        const paused = await buildRuntime.runner.run(buildRuntime.runnerInput);
        assert.strictEqual(
          paused.status,
          "PAUSED",
          "AgentRunner result.status must be PAUSED when awaiting human confirmation"
        );
        assert.strictEqual(
          paused.finalState.status,
          "WAITING_FOR_CONFIRMATION",
          "AgentRunner finalState.status must be WAITING_FOR_CONFIRMATION on browser_side_effect"
        );

        const confirmReq = buildAgentEvents.find(
          (e) => e.type === "mutation.confirmation_requested" && (e.payload as any)?.name === "browser_click"
        );
        assert.ok(confirmReq, "mutation.confirmation_requested event must be emitted via prepareForReview");

        // Before approving, verify page has NOT been clicked yet
        assert.strictEqual(await buildBrowser.getActivePage()!.locator("#out").innerText(), "Ready");

        // Approve and resume run
        const resumed = await buildRuntime.runner.resume("APPROVE");
        assert.strictEqual(resumed.status, "COMPLETED");
        assert.strictEqual(
          await buildBrowser.getActivePage()!.locator("#out").innerText(),
          "Submitted",
          "Real Chromium click must execute after approval and revalidation"
        );
        assert.ok(
          buildBrowserEvents.some((e) => e.type === "approval_revalidated"),
          "approval_revalidated event must be recorded"
        );
      } finally {
        await buildRuntime.cleanup();
      }
    } finally {
      await buildBrowser.dispose();
    }
  });
});
