import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
import type { BrowserProvisioningDiagnostic } from "./browser-contracts.ts";

export const PINNED_SUPPORTED_PLAYWRIGHT_VERSIONS = Object.freeze([
  "1.50.0",
  "1.50.1",
  "1.51.0",
  "1.61.1",
  "1.64.1",
]);

function getPlaywrightCacheDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "ms-playwright")
      : path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  } else if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  } else {
    return process.env.XDG_CACHE_HOME
      ? path.join(process.env.XDG_CACHE_HOME, "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright");
  }
}

function findExecutableInDirectory(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;

  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      path.join(dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      path.join(dir, "chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      path.join(dir, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(dir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      path.join(dir, "Chromium.app", "Contents", "MacOS", "Chromium")
    );
  } else if (platform === "linux") {
    candidates.push(
      path.join(dir, "chrome-linux", "chrome"),
      path.join(dir, "chrome-linux64", "chrome"),
      path.join(dir, "chrome")
    );
  } else if (platform === "win32") {
    candidates.push(
      path.join(dir, "chrome-win", "chrome.exe"),
      path.join(dir, "chrome-win64", "chrome.exe"),
      path.join(dir, "chrome.exe")
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        fs.accessSync(c, fs.constants.X_OK);
        return c;
      } catch {
        // Fallback for Windows or non-executable
        return c;
      }
    }
  }

  return undefined;
}

function scanPlaywrightCache(): string | undefined {
  const cacheDir = getPlaywrightCacheDir();
  if (!fs.existsSync(cacheDir)) return undefined;

  try {
    const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
    // Prioritize chromium directories
    const subdirs = entries
      .filter((e) => e.isDirectory() && (e.name.startsWith("chromium-") || e.name.startsWith("chrome-")))
      .map((e) => path.join(cacheDir, e.name));

    for (const subdir of subdirs) {
      const found = findExecutableInDirectory(subdir);
      if (found) return found;
    }
  } catch {
    // Non-fatal filesystem read error
  }

  return undefined;
}

function scanSystemPaths(): string | undefined {
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (platform === "linux") {
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium"
    );
  } else if (platform === "win32") {
    const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidates.push(
      path.join(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(progFilesX86, "Google", "Chrome", "Application", "chrome.exe")
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  return undefined;
}

export interface BrowserProvisioningOptions {
  readonly overrideExecutablePath?: string | undefined;
  readonly skipPlaywrightCacheScan?: boolean | undefined;
}

export function detectBrowserProvisioning(
  override?: string | BrowserProvisioningOptions
): BrowserProvisioningDiagnostic {
  const now = new Date().toISOString();
  const overrideExecutable =
    typeof override === "string" ? override : override?.overrideExecutablePath;
  const skipPlaywrightCache =
    typeof override === "object" ? Boolean(override?.skipPlaywrightCacheScan) : false;

  // 1. Explicit override passed or in environment
  const envPath = overrideExecutable || process.env.OPEN_VS_CODE_BROWSER_EXECUTABLE;
  if (envPath) {
    if (fs.existsSync(envPath)) {
      return {
        status: "READY",
        executable: {
          path: envPath,
          source: overrideExecutable ? "custom" : "env",
          detectedAt: now,
        },
        supportedVersions: PINNED_SUPPORTED_PLAYWRIGHT_VERSIONS,
        details: [`Configured browser executable detected at "${envPath}".`],
      };
    } else {
      return {
        status: "NOT_CONFIGURED",
        supportedVersions: PINNED_SUPPORTED_PLAYWRIGHT_VERSIONS,
        details: [
          `Configured browser executable path "${envPath}" does not exist on disk.`,
          "Operator provisioning required: run 'npx playwright install chromium' or set OPEN_VS_CODE_BROWSER_EXECUTABLE.",
        ],
      };
    }
  }

  // 2. Playwright cache scan
  const cachedPath = skipPlaywrightCache ? undefined : scanPlaywrightCache();
  if (cachedPath) {
    return {
      status: "READY",
      executable: {
        path: cachedPath,
        source: "playwright_cache",
        detectedAt: now,
      },
      supportedVersions: PINNED_SUPPORTED_PLAYWRIGHT_VERSIONS,
      details: [`Playwright cached browser detected at "${cachedPath}".`],
    };
  }

  // 3. Playwright default executablePath
  try {
    const pw = nodeRequire("playwright-core");
    const defaultPath = pw?.chromium?.executablePath?.();
    if (defaultPath && fs.existsSync(defaultPath)) {
      return {
        status: "READY",
        executable: {
          path: defaultPath,
          source: "playwright_cache",
          detectedAt: now,
        },
        supportedVersions: PINNED_SUPPORTED_PLAYWRIGHT_VERSIONS,
        details: [`Playwright default browser executable detected at "${defaultPath}".`],
      };
    }
  } catch {
    // Expected if not installed in default revision
  }

  // 4. System browser detection
  const systemPath = scanSystemPaths();
  if (systemPath) {
    return {
      status: "READY",
      executable: {
        path: systemPath,
        source: "system",
        detectedAt: now,
      },
      supportedVersions: PINNED_SUPPORTED_PLAYWRIGHT_VERSIONS,
      details: [`System browser executable detected at "${systemPath}".`],
    };
  }

  // 5. Not configured
  return {
    status: "NOT_CONFIGURED",
    supportedVersions: PINNED_SUPPORTED_PLAYWRIGHT_VERSIONS,
    details: [
      "No supported browser binary detected in Playwright cache or system paths.",
      "Never execute uncontrolled npm/npx installation from the agent.",
      "Operator provisioning required: run 'npx playwright install chromium' or set OPEN_VS_CODE_BROWSER_EXECUTABLE.",
    ],
  };
}
