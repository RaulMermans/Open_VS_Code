/**
 * Sprint 9C — Real Chromium Measured Motion Test Suite
 *
 * Launches operator-provisioned Chromium, renders real hardware-accelerated animations,
 * runs in-page requestAnimationFrame temporal sampling and Web Animations API inspection,
 * and asserts against evaluateMotionObservations and motionQualityClaimAllowed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowserSessionManager,
  detectBrowserProvisioning,
  verifyEffectiveSandboxSupport,
} from "../../src/browser/index.ts";
import { skipWithoutChromiumSandbox } from "./chromium-host.ts";

function closeHttpServer(srv?: http.Server): Promise<void> {
  return srv
    ? new Promise<void>((resolve) => {
        (srv as any).closeAllConnections?.();
        srv.close(() => resolve());
      })
    : Promise.resolve();
}

describe("Sprint 9C — Real Chromium Measured Motion Verification", { skip: skipWithoutChromiumSandbox }, () => {
  let tmpRoot: string;
  let appServer: http.Server;
  let appOrigin: string;

  before(async () => {
    const preflight = verifyEffectiveSandboxSupport();
    assert.equal(preflight.supported, true, "Chromium sandbox must be supported");
    const prov = detectBrowserProvisioning();
    assert.equal(prov.status, "READY", "Operator Chromium must be READY");

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9c-motion-"));

    // Spin up local HTTP server serving animated test pages
    appServer = http.createServer((req, res) => {
      const url = req.url || "/";
      if (url === "/smooth") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                .smooth-box {
                  width: 100px;
                  height: 100px;
                  background: #2563eb;
                  animation: pulse 300ms ease-in-out infinite alternate;
                }
                @keyframes pulse {
                  from { transform: scale(1); opacity: 0.8; }
                  to { transform: scale(1.1); opacity: 1; }
                }
                @media (prefers-reduced-motion: reduce) {
                  .smooth-box {
                    animation: none !important;
                  }
                }
              </style>
            </head>
            <body>
              <div class="smooth-box" role="region" aria-label="Smooth pulse widget"></div>
            </body>
          </html>
        `);
        return;
      }

      if (url === "/thrashing") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                .thrash-box {
                  height: 100px;
                  background: #dc2626;
                  animation: widen 300ms ease-in-out infinite alternate;
                }
                @keyframes widen {
                  from { width: 100px; }
                  to { width: 300px; }
                }
              </style>
            </head>
            <body>
              <aside class="thrash-box" role="complementary" aria-label="Layout thrashing sidebar"></aside>
            </body>
          </html>
        `);
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    await new Promise<void>((resolve) => {
      appServer.listen(0, "127.0.0.1", () => {
        const addr = appServer.address() as any;
        appOrigin = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await closeHttpServer(appServer);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("1. Measures smooth 60 FPS motion in real Chromium, verifies composited properties, and grants claim", async () => {
    const session = new BrowserSessionManager({
      workspaceRoot: tmpRoot,
      networkPolicy: { allowedOrigins: [appOrigin] },
      foregroundFrames: true,
    });

    try {
      await session.open(`${appOrigin}/smooth`);
      const motion = await session.measureMotion({ durationMs: 1000 });
      const detail = `frames=${motion.report.totalFrames} fps=${motion.report.measuredFps} jank=${motion.report.jankCount} ${motion.report.summary}`;

      assert.equal(motion.evidenceKind, "multi_frame_sample");
      assert.ok(motion.report.totalFrames > 10, `Expected >10 frames, got ${motion.report.totalFrames}. ${detail}`);
      assert.ok(motion.report.measuredFps >= 30, `Expected >=30 FPS in Chromium, got ${motion.report.measuredFps}. ${detail}`);
      assert.equal(motion.report.layoutThrashingProperties.length, 0);
      assert.equal(motion.report.motionQualityClaimAllowed, true, detail);
    } finally {
      await session.dispose();
    }
  });

  it("2. Audits in-page animations and flags layout-thrashing width property as blocker failure", async () => {
    const session = new BrowserSessionManager({
      workspaceRoot: tmpRoot,
      networkPolicy: { allowedOrigins: [appOrigin] },
    });

    try {
      await session.open(`${appOrigin}/thrashing`);
      const motion = await session.measureMotion({ durationMs: 400 });

      assert.equal(motion.evidenceKind, "multi_frame_sample");
      assert.ok(motion.report.layoutThrashingProperties.includes("width"));
      assert.equal(motion.report.motionQualityClaimAllowed, false);
      const thrashFailure = motion.report.failures.find((f) => f.failureCode === "LAYOUT_THRASHING_PROPERTY");
      assert.ok(thrashFailure);
      assert.equal(thrashFailure?.severity, "blocker");
    } finally {
      await session.dispose();
    }
  });
});
