/**
 * Sprint 10A.1C — REA Production Verifier Adapter.
 *
 * Connects ComparativeWebVerifier, VerificationEngine, and BrowserSessionManager
 * to the production GovernedReaWorkflow.
 *
 * Guarantees:
 * - Automated verification restricted to approved, disposable local loopback fixtures (127.0.0.1).
 * - Spawns a disposable local server strictly confined to workspaceRoot.
 * - Runs controlled behavioral scenarios against reference and reconstructed apps.
 * - Maps passing/failing results to specific obligations.
 * - Accurately reports unsupported capabilities for non-web targets (native / Electron).
 * - Fails closed if verifier, reference app, or reconstructed app is missing or failing.
 */

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { BrowserSessionManager } from "../browser/browser-session-manager.ts";
import type { VerificationEngine } from "../tools/verification-engine.ts";
import { ComparativeWebVerifier, type ComparativeVerificationResult } from "./comparative-verifier.ts";
import type { InvestigationTargetCategory, ReconstructionObligation } from "./contracts.ts";

export interface CreateReaProductionTestRunnerOptions {
  readonly workspaceRoot: string;
  readonly browserSessionManager?: BrowserSessionManager | undefined;
  readonly verificationEngine?: VerificationEngine | undefined;
  readonly referenceUrl?: string | undefined;
  readonly targetCategory?: InvestigationTargetCategory | undefined;
  readonly signal?: AbortSignal | undefined;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Spawns an ephemeral static file server bound exclusively to 127.0.0.1 for the workspaceRoot.
 */
async function startEphemeralWorkspaceServer(
  workspaceRoot: string
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const canonicalRoot = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);

  const server = createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      let reqPath = parsedUrl.pathname;
      if (reqPath === "/" || reqPath === "") {
        reqPath = "/index.html";
      }

      const cleanPath = reqPath.replace(/^\/+/, "");
      let resolvedPath = resolve(canonicalRoot, cleanPath);
      if (!existsSync(resolvedPath) && existsSync(resolve(canonicalRoot, "src", cleanPath))) {
        resolvedPath = resolve(canonicalRoot, "src", cleanPath);
      }

      // Path containment check
      if (!resolvedPath.startsWith(canonicalRoot)) {
        res.writeHead(403);
        res.end("Forbidden: Path traversal outside workspace");
        return;
      }

      if (!existsSync(resolvedPath)) {
        // Fallback to index.html for SPA routes if index.html exists
        const indexPath = join(canonicalRoot, "index.html");
        if (existsSync(indexPath)) {
          res.writeHead(200, { "Content-Type": MIME_TYPES[".html"]! });
          res.end(readFileSync(indexPath));
          return;
        }
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = extname(resolvedPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "text/plain; charset=utf-8";
      const content = readFileSync(resolvedPath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch (err: any) {
      res.writeHead(500);
      res.end(`Internal Server Error: ${err?.message || "unknown"}`);
    }
  });

  await new Promise<void>((res, rej) => {
    server.listen(0, "127.0.0.1", () => res());
    server.once("error", rej);
  });

  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}`;

  const close = (): Promise<void> =>
    new Promise((res) => {
      server.close(() => res());
    });

  return { server, url, close };
}

/**
 * Creates the production testRunner adapter for GovernedReaWorkflow.
 */
export function createReaProductionTestRunner(options: CreateReaProductionTestRunnerOptions) {
  let cachedComparativeResult: ComparativeVerificationResult | undefined;
  let cachedVerificationError: Error | undefined;

  return async (
    obligation: ReconstructionObligation,
    workspaceRoot: string
  ): Promise<{
    passed: boolean;
    output: string;
    details?: {
      verifier?: string;
      testIdentity?: string;
      inputFixture?: string;
      expectedBehavior?: string;
      observedResult?: string;
      limitations?: readonly string[];
    };
  }> => {
    const targetCategory = options.targetCategory ?? "running_web_app";

    // Non-web targets cannot be verified via ComparativeWebVerifier
    if (targetCategory !== "running_web_app") {
      return {
        passed: false,
        output: `Target category "${targetCategory}" does not support automatic web comparative verification. Native and Electron investigations require dedicated offline analysis and are reported accurately as UNVERIFIED.`,
        details: {
          verifier: "open-vs-code.rea.unsupported_verifier",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: targetCategory,
          expectedBehavior: "Non-web target verification",
          observedResult: "UNSUPPORTED_VERIFIER",
          limitations: [`Automatic browser verification is unsupported for target category: ${targetCategory}`],
        },
      };
    }

    if (!options.browserSessionManager) {
      return {
        passed: false,
        output: "No BrowserSessionManager configured. Independent browser verification cannot execute (UNVERIFIED).",
        details: {
          verifier: "open-vs-code.rea.no_browser_manager",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: "none",
          expectedBehavior: "Independent browser verification",
          observedResult: "INSUFFICIENT_EVIDENCE",
          limitations: ["BrowserSessionManager is undefined"],
        },
      };
    }

    const referenceUrl = options.referenceUrl;
    if (!referenceUrl) {
      return {
        passed: false,
        output: "Reference URL is missing. Reference application cannot be observed for comparative verification (UNVERIFIED).",
        details: {
          verifier: "open-vs-code.rea.missing_reference",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: "none",
          expectedBehavior: "Comparative observation of reference application",
          observedResult: "INSUFFICIENT_EVIDENCE",
          limitations: ["Reference URL was not provided or recorded"],
        },
      };
    }

    // Security check: only local fixtures permitted
    let parsedRef: URL;
    try {
      parsedRef = new URL(referenceUrl);
      const host = parsedRef.hostname.toLowerCase();
      const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
      if (!isLoopback) {
        return {
          passed: false,
          output: `Comparative verification is restricted to explicit local loopback fixtures (127.0.0.1/localhost). Remote target "${referenceUrl}" is rejected for security.`,
          details: {
            verifier: "open-vs-code.rea.remote_target_rejected",
            testIdentity: `verifier_${obligation.obligationId}`,
            inputFixture: referenceUrl,
            expectedBehavior: "Local loopback target",
            observedResult: "REMOTE_TARGET_REJECTED",
            limitations: ["Automated testing against remote third-party URLs is strictly prohibited"],
          },
        };
      }
    } catch (err: any) {
      return {
        passed: false,
        output: `Malformed reference URL: "${referenceUrl}": ${err.message}`,
        details: {
          verifier: "open-vs-code.rea.invalid_url",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: referenceUrl,
          expectedBehavior: "Valid local URL",
          observedResult: "MALFORMED_URL",
        },
      };
    }

    // Check that reconstructed entrypoint exists in workspaceRoot
    const hasIndex =
      existsSync(join(workspaceRoot, "index.html")) ||
      existsSync(join(workspaceRoot, "src", "index.html"));
    if (!hasIndex) {
      return {
        passed: false,
        output: `Reconstructed application entrypoint "index.html" does not exist in "${workspaceRoot}". Reconstructed application failed to launch.`,
        details: {
          verifier: "open-vs-code.rea.missing_entrypoint",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: workspaceRoot,
          expectedBehavior: "index.html present in reconstructed workspace",
          observedResult: "ENTRYPOINT_MISSING",
        },
      };
    }

    // Run or reuse comparative verification run
    if (!cachedComparativeResult && !cachedVerificationError) {
      let fixtureServer: { server: Server; url: string; close: () => Promise<void> } | undefined;
      try {
        fixtureServer = await startEphemeralWorkspaceServer(workspaceRoot);

        const verifier = new ComparativeWebVerifier({
          referenceUrl,
          reconstructedUrl: fixtureServer.url,
          browserSessionManager: options.browserSessionManager,
          ...(options.signal ? { signal: options.signal } : {}),
        });

        cachedComparativeResult = await verifier.runComparativeVerification();
      } catch (err: any) {
        cachedVerificationError = err;
      } finally {
        if (fixtureServer) {
          await fixtureServer.close().catch(() => {});
        }
      }
    }

    if (cachedVerificationError) {
      return {
        passed: false,
        output: `Comparative verification failed with execution error: ${cachedVerificationError.message} (UNVERIFIED)`,
        details: {
          verifier: "ComparativeWebVerifier",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
          expectedBehavior: "Executable comparative verification scenarios",
          observedResult: `Error: ${cachedVerificationError.message}`,
        },
      };
    }

    const compResult = cachedComparativeResult!;

    // Map scenarios to obligation:
    // Determine whether this obligation maps to a specific scenario
    const oblText = `${obligation.title} ${obligation.family} ${(obligation.positiveCases ?? []).join(" ")} ${(obligation.negativeCases ?? []).join(" ")}`.toLowerCase();

    let relevantMismatches: string[] = [];
    if (oblText.includes("route") || oblText.includes("landmark") || oblText.includes("navigation")) {
      const s = compResult.comparisons.find((c) => c.category === "route");
      if (s && !s.match) relevantMismatches.push(s.details);
    } else if (oblText.includes("validat") || oblText.includes("error") || oblText.includes("form")) {
      const s = compResult.comparisons.find((c) => c.category === "form_validation" || c.name === "negative_form_validation");
      if (s && !s.match) relevantMismatches.push(s.details);
    } else if (oblText.includes("state") || oblText.includes("add") || oblText.includes("submit")) {
      const s = compResult.comparisons.find((c) => c.category === "state_change");
      if (s && !s.match) relevantMismatches.push(s.details);
    } else if (oblText.includes("sequence") || oblText.includes("multi") || oblText.includes("item")) {
      const s = compResult.comparisons.find((c) => c.category === "visible_output" || c.name === "sequential_mutation_parity");
      if (s && !s.match) relevantMismatches.push(s.details);
    } else {
      // General or core obligation: all comparisons must match
      relevantMismatches = [...compResult.mismatches];
    }

    const obligationPassed = relevantMismatches.length === 0;

    if (!obligationPassed) {
      const failureReason = relevantMismatches.length > 0 ? relevantMismatches.join("; ") : compResult.summary;
      return {
        passed: false,
        output: `Comparative verification FAILED for "${obligation.title}": ${failureReason}`,
        details: {
          verifier: "ComparativeWebVerifier",
          testIdentity: `comparative_web_${obligation.obligationId}`,
          inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
          expectedBehavior: "All behavioral scenarios match reference implementation",
          observedResult: failureReason,
          limitations: compResult.mismatches,
        },
      };
    }

    return {
      passed: true,
      output: `Comparative verification PASSED for "${obligation.title}": ${compResult.summary}`,
      details: {
        verifier: "ComparativeWebVerifier",
        testIdentity: `comparative_web_${obligation.obligationId}`,
        inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
        expectedBehavior: "Observable behavior matches reference application",
        observedResult: `${compResult.matchedScenarios}/${compResult.totalScenarios} behavioral scenarios matched (digest: ${compResult.digest.slice(0, 16)})`,
      },
    };
  };
}
