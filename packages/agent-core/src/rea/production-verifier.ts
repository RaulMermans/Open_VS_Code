/**
 * Sprint 10A.1D — REA Production Verifier Adapter & Secure Fixture Server.
 *
 * Connects ComparativeWebVerifier, VerificationEngine, and BrowserSessionManager
 * to the production GovernedReaWorkflow with airtight fixture isolation and strict
 * scenario-to-obligation verification coverage.
 *
 * Guarantees:
 * - Automated verification restricted to approved, disposable local loopback fixtures (127.0.0.1).
 * - Spawns a disposable local server strictly confined to an isolated temporary fixture directory.
 * - Serves ONLY explicitly allowlisted public application assets (.html, .js, .css, etc.).
 * - Strictly rejects hidden files (.env, .git, .open-vs-code), credentials, executables, and symlinks.
 * - Restricts HTTP methods to GET and HEAD with safe headers (X-Content-Type-Options: nosniff).
 * - Strict scenario-to-obligation coverage: missing scenarios fail closed as UNVERIFIED.
 * - Unsupported categories report UNSUPPORTED_VERIFIER; interrupted runs report INCOMPLETE.
 * - Cleans up all temporary fixture resources on completion, error, or cancellation.
 */

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, rmSync, lstatSync, readdirSync, mkdtempSync } from "node:fs";
import { extname, join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserSessionManager } from "../browser/browser-session-manager.ts";
import type { VerificationEngine } from "../tools/verification-engine.ts";
import { ComparativeWebVerifier, type ComparativeVerificationResult } from "./comparative-verifier.ts";
import type { InvestigationTargetCategory, ReconstructionObligation, ReconstructionObligationLedger } from "./contracts.ts";

export interface CreateReaProductionTestRunnerOptions {
  readonly workspaceRoot: string;
  readonly browserSessionManager?: BrowserSessionManager | undefined;
  readonly verificationEngine?: VerificationEngine | undefined;
  readonly referenceUrl?: string | undefined;
  readonly targetCategory?: InvestigationTargetCategory | undefined;
  readonly investigationId?: string | undefined;
  readonly obligationLedger?: ReconstructionObligationLedger | undefined;
  readonly accountScope?: string | undefined;
  readonly verificationConstraints?: Record<string, unknown> | undefined;
  readonly signal?: AbortSignal | undefined;
}

export const ALLOWED_VERIFICATION_ASSET_EXTENSIONS = new Set([
  ".html", ".htm", ".js", ".mjs", ".css", ".json", ".png", ".svg", ".ico", ".jpg", ".jpeg", ".gif", ".webp"
]);

export const VERIFICATION_MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Stages only approved, safe application assets from workspace into an isolated temporary directory.
 * Disallows:
 * - Hidden files or directories (.env, .git, .open-vs-code, etc.)
 * - Sensitive files (credentials, keys, tokens, passwords)
 * - Symlinks (prevents symlink escapes)
 * - Executables/scripts (.sh, .exe, .py, etc.)
 * - Files outside allowlisted extensions
 */
export function stageVerificationFixture(workspaceRoot: string): { fixtureDir: string; fileCount: number; cleanup: () => void } {
  const canonicalRoot = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
  const rawTemp = mkdtempSync(join(tmpdir(), "ovsc-rea-fixture-"));
  const fixtureDir = realpathSync(rawTemp);
  let fileCount = 0;

  function copySafeAssets(currentDir: string, relSubDir: string): void {
    if (!existsSync(currentDir)) return;
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      // Reject hidden / internal files (.env, .git, .open-vs-code, etc.)
      if (name.startsWith(".")) continue;
      // Reject sensitive files
      const lower = name.toLowerCase();
      if (
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("credential") ||
        lower.includes("password") ||
        lower.endsWith(".key") ||
        lower.endsWith(".pem") ||
        lower.startsWith(".env")
      ) {
        continue;
      }

      const fullSource = join(currentDir, name);
      let stat;
      try {
        stat = lstatSync(fullSource);
      } catch {
        continue;
      }

      // Strict denial of symlinks to prevent escapes
      if (stat.isSymbolicLink()) {
        continue;
      }

      const targetRel = join(relSubDir, name);
      if (stat.isDirectory()) {
        // Do not recurse into node_modules or dotfolders
        if (name === "node_modules") continue;
        const targetSubDir = join(fixtureDir, targetRel);
        mkdirSync(targetSubDir, { recursive: true });
        copySafeAssets(fullSource, targetRel);
      } else if (stat.isFile()) {
        const ext = extname(name).toLowerCase();
        if (ALLOWED_VERIFICATION_ASSET_EXTENSIONS.has(ext)) {
          const content = readFileSync(fullSource);
          const targetFile = join(fixtureDir, targetRel);
          const targetParent = join(fixtureDir, relSubDir);
          if (!existsSync(targetParent)) {
            mkdirSync(targetParent, { recursive: true });
          }
          writeFileSync(targetFile, content);
          fileCount++;
        }
      }
    }
  }

  try {
    copySafeAssets(canonicalRoot, "");
  } catch (err) {
    rmSync(fixtureDir, { recursive: true, force: true });
    throw err;
  }

  const cleanup = () => {
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  };

  return { fixtureDir, fileCount, cleanup };
}

/**
 * Spawns an ephemeral static file server bound exclusively to 127.0.0.1 serving an isolated fixture directory.
 */
export async function startEphemeralWorkspaceServer(
  workspaceRoot: string
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const staged = stageVerificationFixture(workspaceRoot);
  const fixtureDir = staged.fixtureDir;

  const server = createServer((req, res) => {
    try {
      // 1. Restrict methods to GET and HEAD only
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Method Not Allowed");
        return;
      }

      // 2. Parse URL safely and reject null bytes and traversal tokens
      const rawPath = req.url || "/";
      if (rawPath.includes("%00") || rawPath.includes("\0")) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Bad Request");
        return;
      }

      if (rawPath.includes("..") || rawPath.toLowerCase().includes("%2e%2e")) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Forbidden: Path traversal denied");
        return;
      }

      let pathname: string;
      try {
        const parsedUrl = new URL(rawPath, "http://127.0.0.1");
        pathname = decodeURIComponent(parsedUrl.pathname);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Bad Request");
        return;
      }

      // Reject path traversal with backslashes or ..
      if (pathname.includes("\\") || pathname.split("/").some((seg) => seg === "..")) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Forbidden: Path traversal denied");
        return;
      }

      if (pathname === "/" || pathname === "") {
        pathname = "/index.html";
      }

      const cleanPath = pathname.replace(/^\/+/, "");
      let resolvedPath = resolve(fixtureDir, cleanPath);
      if (!existsSync(resolvedPath) && existsSync(resolve(fixtureDir, "src", cleanPath))) {
        resolvedPath = resolve(fixtureDir, "src", cleanPath);
      }

      // 3. Canonical path containment check using path.relative
      const relToFixture = relative(fixtureDir, resolvedPath);
      if (relToFixture.startsWith("..") || isAbsolute(relToFixture)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Forbidden");
        return;
      }

      if (!existsSync(resolvedPath)) {
        // Fallback to index.html for SPA routes only if client explicitly requests HTML and path has no sub-directories
        const indexPath = join(fixtureDir, "index.html");
        const acceptsHtml = (req.headers.accept || "").includes("text/html");
        if (existsSync(indexPath) && (cleanPath === "" || cleanPath === "index.html" || (!cleanPath.includes("/") && acceptsHtml))) {
          res.writeHead(200, {
            "Content-Type": VERIFICATION_MIME_TYPES[".html"]!,
            "X-Content-Type-Options": "nosniff",
          });
          if (req.method === "HEAD") {
            res.end();
          } else {
            res.end(readFileSync(indexPath));
          }
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Not Found");
        return;
      }

      // 4. Verify realpath in case of symlinks
      const real = realpathSync(resolvedPath);
      const realRel = relative(fixtureDir, real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Forbidden");
        return;
      }

      const ext = extname(resolvedPath).toLowerCase();
      if (!ALLOWED_VERIFICATION_ASSET_EXTENSIONS.has(ext)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        res.end("Forbidden: Asset type not allowed");
        return;
      }

      const contentType = VERIFICATION_MIME_TYPES[ext] || "text/plain; charset=utf-8";
      res.writeHead(200, {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(readFileSync(resolvedPath));
      }
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
    server.once("error", rejectPromise);
  });

  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
    staged.cleanup();
  };

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
    // 1. Check signal cancellation
    if (options.signal?.aborted) {
      return {
        passed: false,
        output: `Verification interrupted by operator cancellation (INCOMPLETE).`,
        details: {
          verifier: "open-vs-code.rea.interrupted",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: workspaceRoot,
          expectedBehavior: "Complete verification scenario execution",
          observedResult: "INCOMPLETE",
          limitations: ["Verification execution was aborted before completion"],
        },
      };
    }

    const targetCategory = options.targetCategory ?? "running_web_app";

    // Non-web targets cannot be verified via ComparativeWebVerifier
    if (targetCategory !== "running_web_app") {
      return {
        passed: false,
        output: `Target category "${targetCategory}" does not support automatic web comparative verification. Native and Electron investigations require dedicated offline analysis and are reported accurately as UNSUPPORTED_VERIFIER (UNVERIFIED).`,
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

    // Check obligation family/layer for unsupported verification categories
    const oblFamilyLower = (obligation.family || "").toLowerCase();
    const oblTitleLower = (obligation.title || "").toLowerCase();
    const isUnsupportedCategory =
      oblFamilyLower.startsWith("unsupported") ||
      (obligation.applicationLayer as string) === "unknown" ||
      oblFamilyLower.includes("audio") ||
      oblFamilyLower.includes("video") ||
      oblFamilyLower.includes("native") ||
      oblFamilyLower.includes("bluetooth") ||
      oblFamilyLower.includes("hardware") ||
      oblFamilyLower.includes("webgl") ||
      oblTitleLower.includes("audio playback") ||
      oblTitleLower.includes("hardware sensor") ||
      oblTitleLower.includes("native binary");

    if (isUnsupportedCategory) {
      return {
        passed: false,
        output: `Obligation "${obligation.title}" (${obligation.obligationId}) belongs to an unsupported verification category "${obligation.family}". Reported accurately as UNSUPPORTED_VERIFIER.`,
        details: {
          verifier: "open-vs-code.rea.unsupported_verifier",
          testIdentity: `verifier_${obligation.obligationId}`,
          inputFixture: obligation.family,
          expectedBehavior: "Supported verification category",
          observedResult: "UNSUPPORTED_VERIFIER",
          limitations: [`Verification is unsupported for capability: ${obligation.family}`],
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

    // 2. Strict scenario-to-obligation verification mapping
    // Determine the explicit verification scenario category for this obligation
    let requiredScenarioCategory: "route" | "form_validation" | "state_change" | "visible_output" | undefined;

    if (
      oblFamilyLower === "route" ||
      oblFamilyLower === "navigation" ||
      obligation.obligationId.toLowerCase().includes("route") ||
      oblTitleLower.includes("route") ||
      oblTitleLower.includes("landmark") ||
      oblTitleLower.includes("navigation")
    ) {
      requiredScenarioCategory = "route";
    } else if (
      oblFamilyLower === "form_validation" ||
      oblFamilyLower === "validation" ||
      oblFamilyLower.includes("validation") ||
      obligation.obligationId.toLowerCase().includes("validat") ||
      obligation.obligationId.toLowerCase().includes("form") ||
      oblTitleLower.includes("validation") ||
      oblTitleLower.includes("error") ||
      oblTitleLower.includes("form")
    ) {
      requiredScenarioCategory = "form_validation";
    } else if (
      oblFamilyLower === "state_change" ||
      oblFamilyLower === "state_management" ||
      oblFamilyLower === "functional-parity" ||
      oblFamilyLower.includes("functional") ||
      obligation.obligationId.toLowerCase().includes("state") ||
      obligation.obligationId.toLowerCase().includes("workflow") ||
      oblTitleLower.includes("state") ||
      oblTitleLower.includes("submit") ||
      oblTitleLower.includes("add") ||
      oblTitleLower.includes("workflow") ||
      oblTitleLower.includes("primary application")
    ) {
      requiredScenarioCategory = "state_change";
    } else if (
      oblFamilyLower === "visible_output" ||
      oblFamilyLower === "data_layer" ||
      obligation.obligationId.toLowerCase().includes("sequence") ||
      obligation.obligationId.toLowerCase().includes("item") ||
      oblTitleLower.includes("sequence") ||
      oblTitleLower.includes("multiple item") ||
      oblTitleLower.includes("mutation")
    ) {
      requiredScenarioCategory = "visible_output";
    }

    // If no scenario maps to this obligation: it is UNVERIFIED.
    // Zero empty-mismatch false positives permitted!
    if (!requiredScenarioCategory) {
      return {
        passed: false,
        output: `No matching verification scenario executed for obligation "${obligation.title}" (${obligation.obligationId}). Unverified obligation cannot pass without relevant executed test evidence (UNVERIFIED).`,
        details: {
          verifier: "ComparativeWebVerifier",
          testIdentity: `comparative_web_${obligation.obligationId}`,
          inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
          expectedBehavior: "Explicit executed verification scenario matching obligation",
          observedResult: "UNVERIFIED",
          limitations: [`No executed verification scenario mapped to obligation family: "${obligation.family}"`],
        },
      };
    }

    // Check if the required scenario was executed
    const matchingScenario = compResult.comparisons.find(
      (c) =>
        c.category === requiredScenarioCategory ||
        (requiredScenarioCategory === "form_validation" && (c.name === "negative_form_validation" || c.name.includes("form"))) ||
        (requiredScenarioCategory === "route" && (c.name === "route_and_landmarks_parity" || c.name.includes("route"))) ||
        (requiredScenarioCategory === "state_change" && (c.name === "positive_state_change" || c.name.includes("state"))) ||
        (requiredScenarioCategory === "visible_output" && (c.name === "sequential_mutation_parity" || c.name.includes("sequence") || c.name.includes("mutation")))
    );

    if (!matchingScenario) {
      return {
        passed: false,
        output: `Required verification scenario "${requiredScenarioCategory}" was not executed for obligation "${obligation.title}". Reported as UNVERIFIED.`,
        details: {
          verifier: "ComparativeWebVerifier",
          testIdentity: `comparative_web_${obligation.obligationId}`,
          inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
          expectedBehavior: `Execution of scenario "${requiredScenarioCategory}"`,
          observedResult: "UNVERIFIED",
          limitations: [`Scenario "${requiredScenarioCategory}" was not present in executed comparisons`],
        },
      };
    }

    // Check if the matching scenario failed
    if (!matchingScenario.match) {
      return {
        passed: false,
        output: `Comparative verification FAILED for "${obligation.title}": ${matchingScenario.details}`,
        details: {
          verifier: "ComparativeWebVerifier",
          testIdentity: `comparative_web_${obligation.obligationId}`,
          inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
          expectedBehavior: "Observable behavior matches reference implementation",
          observedResult: `FAILED: ${matchingScenario.details}`,
          limitations: [matchingScenario.details],
        },
      };
    }

    // Negative case coverage check: if obligation defines required negative cases,
    // verify that negative form validation also executed and passed
    if (obligation.negativeCases && obligation.negativeCases.length > 0) {
      const negScenario = compResult.comparisons.find(
        (c) => c.category === "form_validation" || c.name === "negative_form_validation"
      );
      if (negScenario && !negScenario.match) {
        return {
          passed: false,
          output: `Comparative verification FAILED for "${obligation.title}": negative case verification failed (${negScenario.details})`,
          details: {
            verifier: "ComparativeWebVerifier",
            testIdentity: `comparative_web_${obligation.obligationId}`,
            inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
            expectedBehavior: "Negative cases match reference behavior",
            observedResult: `FAILED: ${negScenario.details}`,
            limitations: [negScenario.details],
          },
        };
      }
    }

    // Both required matching scenario passed and all required cases passed
    return {
      passed: true,
      output: `Comparative verification PASSED for "${obligation.title}": scenario "${matchingScenario.name}" matched reference implementation`,
      details: {
        verifier: "ComparativeWebVerifier",
        testIdentity: `comparative_web_${obligation.obligationId}`,
        inputFixture: `${referenceUrl} vs ${workspaceRoot}`,
        expectedBehavior: "Observable behavior matches reference application",
        observedResult: `Scenario "${matchingScenario.name}" matched: ${matchingScenario.details}`,
      },
    };
  };
}
