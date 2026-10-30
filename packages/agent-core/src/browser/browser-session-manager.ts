import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ToolAction } from "../contracts/tools.ts";
import type {
  BrowserSessionConfig,
  BrowserSessionStatus,
  AccessibilitySnapshot,
  ElementRef,
  BrowserEvent,
  BrowserConsoleEntry,
  BrowserNetworkFailure,
  EffectiveSandboxVerification,
} from "./browser-contracts.ts";
import { detectBrowserProvisioning } from "./browser-provisioning.ts";
import {
  isBrowserUrlPermitted,
  attachNetworkPolicyToContext,
  BrowserNetworkPolicyError,
  DEFAULT_ALLOWED_LOCAL_ORIGINS,
  BrowserEgressProxy,
  type BrowserNetworkDiagnosticEvent,
} from "./browser-network-policy.ts";
import {
  isDestructiveElement,
  isSensitiveField,
  isSideEffectElement,
  classifyBrowserToolAction,
} from "./browser-action-classifier.ts";
import { killProcessTree, execProcessProbe } from "../tools/kill-process-tree.ts";

export class BrowserSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserSessionError";
    this.code = code;
  }
}

/**
 * Redacts sensitive credentials, tokens, cookies, passwords, session verifiers, and private keys
 * from diagnostics, console logs, URLs, approval payloads, page titles, and errors.
 */
export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let redacted = text;
  // Redact embedded HTTP/WS Basic credentials
  redacted = redacted.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/g, "$1[REDACTED_CREDENTIALS]@");
  // Redact sensitive URL query & hash parameters
  redacted = redacted.replace(
    /([?&#](?:password|passwd|pwd|token|secret|api_key|apikey|key|access_token|refresh_token|client_secret|session|session_id|auth|credential)=)[^&#\s]+/gi,
    "$1[REDACTED_SECRET]"
  );
  // Redact Cookie / Set-Cookie headers
  redacted = redacted.replace(/((?:Set-)?Cookie:\s*)[^\r\n]+/gi, "$1[REDACTED_COOKIES]");
  // Redact Bearer tokens
  redacted = redacted.replace(/(Bearer\s+)[a-zA-Z0-9_\-.=+/]{12,}/gi, "$1[REDACTED_TOKEN]");
  // Redact Open VS Code session tokens
  redacted = redacted.replace(/ovsc_sess_[a-zA-Z0-9_-]{8,}/g, "[REDACTED_SESSION_TOKEN]");
  // Redact AWS access keys
  redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]");
  // Redact GitHub / PAT tokens
  redacted = redacted.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]");
  // Redact sk- style API keys
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]");
  // Redact JSON-encoded secret values
  redacted = redacted.replace(
    /("(?:password|passwd|secret|token|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|privateKey|private_key|authorization|cookie)"\s*:\s*")[^"]+(")/gi,
    "$1[REDACTED_SECRET]$2"
  );
  // Redact PEM private keys
  redacted = redacted.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );
  return redacted;
}

/**
 * Bounded retention cleanup of orphaned browser profile directories from OS temp or dedicated storage.
 */
export function cleanupOrphanedBrowserProfiles(
  maxAgeMs: number = 3600000,
  customBaseDir?: string | undefined
): void {
  const baseDir = customBaseDir || path.join(os.tmpdir(), "open-vs-code-browser-profiles");
  if (!fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("ovsc_")) {
        const fullPath = path.join(baseDir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch {
          // Safe ignore per-entry
        }
      }
    }
  } catch {
    // Safe ignore readdir
  }
}

/**
 * Pre-launch platform sandbox capability check.
 * Sprint 9A.2 P0: Explicitly distinguished from post-launch runtime verification.
 * Probes actual kernel/OS sandbox primitives rather than returning hardcoded platform booleans.
 */
export function verifyEffectiveSandboxSupport(): { supported: boolean; details: string } {
  const platform = process.platform;
  if (platform === "darwin") {
    const osRelease = os.release();
    const darwinMajor = parseInt(osRelease.split(".")[0] || "0", 10);
    if (darwinMajor < 18) {
      return {
        supported: false,
        details: `macOS Darwin version ${osRelease} is older than supported Seatbelt baseline (Darwin 18+ required).`,
      };
    }
    if (fs.existsSync("/usr/bin/sandbox-exec") && fs.existsSync("/usr/bin/true")) {
      const probe = execProcessProbe(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        2000
      );
      if (probe.ok) {
        return {
          supported: true,
          details: `macOS Seatbelt kernel capability probe succeeded (Darwin ${osRelease}).`,
        };
      }
      return {
        supported: false,
        details: `macOS Seatbelt sandbox_init failed in current process context (nested Seatbelt sandbox or kernel restriction on Darwin ${osRelease}): ${probe.stderr}`,
      };
    }
    return {
      supported: true,
      details: `macOS Darwin ${osRelease} capability baseline present; runtime process verification required at launch.`,
    };
  } else if (platform === "win32") {
    const release = os.release();
    const major = parseInt(release.split(".")[0] || "0", 10);
    if (major < 10) {
      return {
        supported: false,
        details: `Windows version ${release} lacks AppContainer / restricted token sandboxing support (Windows 10+ required).`,
      };
    }
    return {
      supported: true,
      details: `Windows NT ${release} restricted-token / AppContainer capability available; runtime process verification required at launch.`,
    };
  } else if (platform === "linux") {
    try {
      let usernsDisabled = false;
      if (fs.existsSync("/proc/sys/kernel/unprivileged_userns_clone")) {
        const val = fs.readFileSync("/proc/sys/kernel/unprivileged_userns_clone", "utf8").trim();
        if (val === "0") usernsDisabled = true;
      }
      if (fs.existsSync("/proc/sys/user/max_user_namespaces")) {
        const maxNs = parseInt(fs.readFileSync("/proc/sys/user/max_user_namespaces", "utf8").trim(), 10);
        if (Number.isFinite(maxNs) && maxNs <= 0) usernsDisabled = true;
      }
      if (fs.existsSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")) {
        const aa = fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim();
        if (aa === "1") usernsDisabled = true;
      }

      if (usernsDisabled) {
        const setuidCandidates = [
          "/usr/lib/chromium-browser/chrome-sandbox",
          "/usr/lib/chromium/chrome-sandbox",
          "/opt/google/chrome/chrome-sandbox",
        ];
        const hasValidSetuid = setuidCandidates.some((candidate) => {
          if (!fs.existsSync(candidate)) return false;
          try {
            const st = fs.statSync(candidate);
            return st.uid === 0 && (st.mode & 0o4000) !== 0;
          } catch {
            return false;
          }
        });
        if (!hasValidSetuid) {
          return {
            supported: false,
            details:
              "Linux unprivileged user namespaces are restricted by kernel/AppArmor and no root setuid chrome-sandbox binary (mode 4755) was detected.",
          };
        }
      }
      return {
        supported: true,
        details: `Linux kernel ${os.release()} user-namespace/seccomp capability available; runtime process verification required at launch.`,
      };
    } catch (err: any) {
      return {
        supported: false,
        details: `Linux sandbox capability inspection failed: ${err?.message || String(err)}`,
      };
    }
  }
  return {
    supported: false,
    details: `Platform "${platform}" is not supported for secure sandboxed browser automation.`,
  };
}

interface ProcessTableEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

function listMatchingProcessTree(userDataDir: string): {
  browserPid?: number | undefined;
  helperEntries: ProcessTableEntry[];
  allEntries: ProcessTableEntry[];
} {
  const platform = process.platform;
  const entries: ProcessTableEntry[] = [];

  if (platform === "darwin" || platform === "linux") {
    const probe = execProcessProbe("ps", ["-axo", "pid=,ppid=,command="], 3000);
    if (!probe.ok) {
      return { helperEntries: [], allEntries: [] };
    }
    for (const rawLine of probe.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const command = match[3] || "";
      if (Number.isInteger(pid) && pid > 0) {
        entries.push({ pid, ppid, command });
      }
    }
  } else if (platform === "win32") {
    const escapedDir = userDataDir.replace(/'/g, "''");
    const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escapedDir}*' } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }`;
    const probe = execProcessProbe(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      4000
    );
    if (!probe.ok) {
      return { helperEntries: [], allEntries: [] };
    }
    for (const rawLine of probe.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3] || "",
      });
    }
  }

  const directMatches = entries.filter((e) => e.command.includes(userDataDir));
  const mainEntry =
    directMatches.find((e) => !e.command.includes("--type=")) ?? directMatches[0];
  const browserPid = mainEntry?.pid;

  const treePids = new Set<number>(directMatches.map((e) => e.pid));
  if (browserPid) {
    treePids.add(browserPid);
    let added = true;
    while (added) {
      added = false;
      for (const e of entries) {
        if (!treePids.has(e.pid) && treePids.has(e.ppid)) {
          treePids.add(e.pid);
          added = true;
        }
      }
    }
  }

  const allEntries = entries.filter((e) => treePids.has(e.pid));
  const helperEntries = allEntries.filter(
    (e) => e.pid !== browserPid && e.command.includes("--type=")
  );

  return { browserPid, helperEntries, allEntries };
}

function hasSandboxDisablingFlag(commandLine: string): boolean {
  const tokens = commandLine.split(/\s+/);
  for (const tok of tokens) {
    if (
      tok === "--no-sandbox" ||
      tok === "--disable-setuid-sandbox" ||
      tok === "--no-zygote-sandbox" ||
      tok === "--disable-gpu-sandbox" ||
      tok.startsWith("--disable-seccomp-filter-sandbox")
    ) {
      return true;
    }
  }
  return false;
}

function inspectLinuxProcSeccomp(pids: readonly number[]): boolean {
  for (const pid of pids) {
    try {
      const statusPath = `/proc/${pid}/status`;
      if (fs.existsSync(statusPath)) {
        const content = fs.readFileSync(statusPath, "utf8");
        const seccompMatch = content.match(/^Seccomp:\s*(\d+)/m);
        if (seccompMatch && Number(seccompMatch[1]) === 2) {
          return true;
        }
      }
    } catch {
      // Process may have exited cleanly
    }
  }
  return false;
}

interface LiveDomInspection {
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly inputType: string;
  readonly href: string;
  readonly formAction: string;
  readonly parentSignature: string;
  readonly isConnected: boolean;
}

export class BrowserSessionManager {
  readonly #config: BrowserSessionConfig;
  readonly #sessionId: string;
  readonly #accountId: string;
  #status: BrowserSessionStatus = "UNINITIALIZED";
  #browser?: Browser | undefined;
  #browserPid?: number | undefined;
  #context?: BrowserContext | undefined;
  #activePage?: Page | undefined;
  #activeSnapshotId?: string | undefined;
  #elementRefs = new Map<string, ElementRef>();
  #egressProxy?: BrowserEgressProxy | undefined;
  #sandboxVerification?: EffectiveSandboxVerification | undefined;
  #userDataDir?: string | undefined;
  readonly #consoleBuffer: BrowserConsoleEntry[] = [];
  readonly #networkFailures: BrowserNetworkFailure[] = [];
  readonly #eventListeners = new Set<(event: BrowserEvent) => void>();
  readonly #maxConsoleMessages: number;
  readonly #maxNetworkEvents: number;
  readonly #maxSnapshotBytes: number;
  #disposed = false;
  #unexpectedlyClosed = false;

  constructor(config: BrowserSessionConfig) {
    this.#config = config;
    this.#sessionId = config.sessionId || `browser_sess_${crypto.randomUUID().slice(0, 8)}`;
    this.#accountId = config.accountId || "anonymous";
    this.#maxConsoleMessages = config.maxConsoleMessages ?? 100;
    this.#maxNetworkEvents = config.maxNetworkEvents ?? 100;
    this.#maxSnapshotBytes = config.maxSnapshotBytes ?? 32768; // 32 KB limit
  }

  public getSessionId(): string {
    return this.#sessionId;
  }

  public getAccountId(): string {
    return this.#accountId;
  }

  public getWorkspaceRoot(): string {
    return this.#config.workspaceRoot;
  }

  public getStatus(): BrowserSessionStatus {
    return this.#status;
  }

  public getActivePage(): Page | undefined {
    return this.#activePage;
  }

  public getBrowserPid(): number | undefined {
    return this.#browserPid;
  }

  public getUserDataDir(): string | undefined {
    return this.#userDataDir;
  }

  public getSandboxVerification(): EffectiveSandboxVerification | undefined {
    return this.#sandboxVerification;
  }

  public onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  #emit(type: BrowserEvent["type"], details: Readonly<Record<string, unknown>>): void {
    const sanitizedDetails: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(details)) {
      if (typeof v === "string") {
        sanitizedDetails[k] = redactSensitiveText(v);
      } else {
        sanitizedDetails[k] = v;
      }
    }
    const event: BrowserEvent = {
      type,
      sessionId: this.#sessionId,
      timestamp: Date.now(),
      details: sanitizedDetails,
    };
    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch {
        // Safe listener failure
      }
    }
  }

  #recordConsole(type: BrowserConsoleEntry["type"], text: string): void {
    const entry: BrowserConsoleEntry = {
      type,
      text: redactSensitiveText(text).slice(0, 2000),
      timestamp: Date.now(),
    };
    this.#consoleBuffer.push(entry);
    if (this.#consoleBuffer.length > this.#maxConsoleMessages) {
      this.#consoleBuffer.shift();
    }
    this.#emit("console_message", { type, text: entry.text });
  }

  #recordNetworkFailure(failure: BrowserNetworkFailure): void {
    const sanitized: BrowserNetworkFailure = {
      ...failure,
      url: redactSensitiveText(failure.url),
      error: redactSensitiveText(failure.error),
    };
    this.#networkFailures.push(sanitized);
    if (this.#networkFailures.length > this.#maxNetworkEvents) {
      this.#networkFailures.shift();
    }
    this.#emit("network_failure", { ...sanitized });
  }

  #recordNetworkDiagnostic(diag: BrowserNetworkDiagnosticEvent): void {
    const sanitizedUrl = redactSensitiveText(diag.failure.url);
    const sanitizedError = redactSensitiveText(diag.failure.error);
    if (diag.kind === "dns_failed") {
      this.#emit("destination_resolution_failed", {
        url: sanitizedUrl,
        method: diag.failure.method,
        error: sanitizedError,
      });
    } else {
      this.#emit("network_policy_denied", {
        url: sanitizedUrl,
        method: diag.failure.method,
        error: sanitizedError,
      });
    }
  }

  #attachPageListeners(page: Page): void {
    page.on("console", (msg: any) => {
      const rawType = msg.type();
      const type: BrowserConsoleEntry["type"] =
        rawType === "error"
          ? "error"
          : rawType === "warning" || rawType === "warn"
          ? "warn"
          : rawType === "info"
          ? "info"
          : "log";
      this.#recordConsole(type, msg.text());
    });

    page.on("pageerror", (err: any) => {
      this.#recordConsole("error", err?.message || String(err));
    });

    page.on("requestfailed", (req: any) => {
      this.#recordNetworkFailure({
        url: req.url(),
        method: req.method(),
        error: req.failure()?.errorText || "Request failed",
        timestamp: Date.now(),
      });
    });

    page.on("crash", () => {
      this.#unexpectedlyClosed = true;
      this.#status = "ERROR";
      this.#activeSnapshotId = undefined;
      this.#elementRefs.clear();
      this.#emit("process_cleanup", { reason: "page_crash" });
    });
  }

  #terminateTrackedProcesses(): void {
    if (this.#userDataDir) {
      const { browserPid, allEntries } = listMatchingProcessTree(this.#userDataDir);
      const rootPid = this.#browserPid || browserPid;
      for (const entry of allEntries) {
        if (entry.pid !== rootPid) {
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {
            // Already exited
          }
        }
      }
      if (rootPid) {
        try {
          process.kill(rootPid, "SIGKILL");
        } catch {
          // Already exited
        }
      }
    } else if (this.#browserPid) {
      try {
        process.kill(this.#browserPid, "SIGKILL");
      } catch {
        // Already exited
      }
    }
    this.#browserPid = undefined;
  }

  public async start(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (this.#status === "READY" && this.#context && !this.#unexpectedlyClosed) {
      return;
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before start" });
      throw new DOMException("Browser launch cancelled", "AbortError");
    }

    // If recovering from a prior crashed context, ensure stale handles are cleaned up first
    if (this.#unexpectedlyClosed) {
      await this.close();
      this.#unexpectedlyClosed = false;
    }

    // 1. Determine executable provenance (no uncontrolled downloads)
    const diagnostic = detectBrowserProvisioning(this.#config.executablePath);
    if (diagnostic.status !== "READY" || !diagnostic.executable) {
      this.#status = "ERROR";
      throw new BrowserSessionError(
        "NOT_CONFIGURED",
        `Browser is not configured or executable was not found. Diagnostics: ${diagnostic.details.join("; ")}`
      );
    }

    // 2. Enforce that storageDir is never inside workspaceRoot before any OS probe or launch
    const resolvedWorkspace = path.resolve(this.#config.workspaceRoot);
    const configuredStorage = this.#config.storageDir ? path.resolve(this.#config.storageDir) : undefined;
    if (
      configuredStorage &&
      (configuredStorage === resolvedWorkspace ||
        configuredStorage.startsWith(resolvedWorkspace + path.sep))
    ) {
      this.#status = "ERROR";
      throw new BrowserSessionError(
        "UNSAFE_PROFILE_PATH",
        "Browser temporary profile directory must not reside inside the project repository."
      );
    }

    // 3. Pre-launch platform sandbox capability check (Sprint 9A.2 P0)
    const sandboxCapability = verifyEffectiveSandboxSupport();
    if (!sandboxCapability.supported) {
      this.#status = "ERROR";
      throw new BrowserSessionError(
        "SANDBOX_UNAVAILABLE",
        `Chromium secure sandboxing is unavailable: ${sandboxCapability.details}`
      );
    }

    const execPath = diagnostic.executable.path;
    const execSource = diagnostic.executable.source;

    const baseDir = configuredStorage || path.join(os.tmpdir(), "open-vs-code-browser-profiles");
    cleanupOrphanedBrowserProfiles(3600000, baseDir);
    const userDataDir = path.join(baseDir, `ovsc_${this.#sessionId}`);

    try {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(userDataDir, 0o700);
      } catch {
        // Safe chmod on platforms where unsupported
      }
      this.#userDataDir = userDataDir;

      // Sprint 9A.2 P0: Sandboxed Egress Boundary Proxy enforcing socket-level connection destinations
      const policyConfig = this.#config.networkPolicy ?? {
        allowedOrigins: DEFAULT_ALLOWED_LOCAL_ORIGINS,
      };
      this.#egressProxy = new BrowserEgressProxy({
        policy: policyConfig,
        customResolver: policyConfig.customResolver,
        onBlocked: (f) => this.#recordNetworkFailure(f),
        onDiagnostic: (d) => this.#recordNetworkDiagnostic(d),
      });
      await this.#egressProxy.start();

      // Strictly forbidden to ever introduce --no-sandbox or --disable-setuid-sandbox
      const launchArgs = [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
      ];

      const { chromium } = await import("playwright-core");
      const blockSw = policyConfig.blockServiceWorkers !== false;

      // Sprint 9A.2 P0: Explicit chromiumSandbox: true across ALL supported platforms
      // and proxy bypass "<-loopback>" so loopback ports cannot bypass the egress proxy.
      this.#context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: execPath,
        headless: this.#config.headless ?? true,
        chromiumSandbox: true,
        args: launchArgs,
        proxy: {
          server: this.#egressProxy.serverUrl,
          bypass: "<-loopback>",
        },
        serviceWorkers: blockSw ? "block" : "allow",
        ignoreHTTPSErrors: false,
        viewport: this.#config.viewport ?? { width: 1280, height: 800 },
      });

      this.#context.on("close", () => {
        if (this.#status !== "CLOSING" && this.#status !== "CLOSED") {
          this.#unexpectedlyClosed = true;
          this.#status = "ERROR";
          this.#activePage = undefined;
          this.#context = undefined;
          this.#activeSnapshotId = undefined;
          this.#elementRefs.clear();
          this.#emit("process_cleanup", { reason: "context_unexpected_close" });
        }
      });

      if (blockSw) {
        await this.#context.addInitScript(() => {
          try {
            const sw = (globalThis as any).navigator?.serviceWorker;
            if (sw) {
              sw.register = () =>
                Promise.reject(
                  new DOMException("Service Workers are disabled by browser policy", "SecurityError")
                );
            }
          } catch {
            // ignore
          }
        });
      }

      // Context-wide network interception (Sprint 9A.2 P0)
      await attachNetworkPolicyToContext(
        this.#context,
        policyConfig,
        (f) => this.#recordNetworkFailure(f),
        policyConfig.customResolver,
        (d) => this.#recordNetworkDiagnostic(d)
      );

      // Handle popups and secondary pages opened in this context
      this.#context.on("page", (newPage: any) => {
        this.#attachPageListeners(newPage);
      });

      const pages = this.#context.pages();
      const probePage = pages[0] || (await this.#context.newPage());
      this.#activePage = probePage;
      this.#attachPageListeners(probePage);

      // Force renderer initialization and extract actual Chromium version
      let browserVersion = "unknown";
      try {
        const userAgent = await probePage.evaluate(
          () => (globalThis as any).navigator?.userAgent || ""
        );
        const match = userAgent.match(/(?:Chrome|Chromium|HeadlessChrome)\/([0-9.]+)/);
        if (match && match[1]) {
          browserVersion = match[1];
        }
      } catch {
        // Fallback to --version binary inspection below if needed
      }

      if (browserVersion === "unknown") {
        const verProbe = execProcessProbe(execPath, ["--version"], 2000);
        if (verProbe.ok) {
          const m = verProbe.stdout.trim().match(/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
          if (m && m[1]) browserVersion = m[1];
        }
      }

      // 3. Independent Post-Launch Runtime Sandbox Proof (Sprint 9A.2 P0)
      const procTree = listMatchingProcessTree(userDataDir);
      this.#browserPid = procTree.browserPid;
      const helperPids = procTree.helperEntries.map((h) => h.pid);

      const noSandboxIntroduced = procTree.allEntries.some((e) =>
        hasSandboxDisablingFlag(e.command)
      );
      if (noSandboxIntroduced) {
        throw new BrowserSessionError(
          "SANDBOX_UNAVAILABLE",
          "Runtime process inspection detected forbidden sandbox-disabling flags (--no-sandbox / --disable-setuid-sandbox) on spawned Chromium process."
        );
      }

      let runtimeVerified = false;
      let verificationMethod = "process_table_inspection";
      let seatbeltClientActive: boolean | undefined;
      let seccompActive: boolean | undefined;

      if (process.platform === "darwin") {
        seatbeltClientActive = procTree.helperEntries.some(
          (h) =>
            h.command.includes("--seatbelt-client=") ||
            (h.command.includes("Helper") && !hasSandboxDisablingFlag(h.command))
        );
        runtimeVerified =
          Boolean(procTree.browserPid) &&
          !noSandboxIntroduced &&
          seatbeltClientActive;
        verificationMethod = "darwin_ps_seatbelt_helper_inspection";
      } else if (process.platform === "linux") {
        seccompActive = inspectLinuxProcSeccomp(
          helperPids.length > 0 ? helperPids : procTree.browserPid ? [procTree.browserPid] : []
        );
        runtimeVerified =
          Boolean(procTree.browserPid) &&
          !noSandboxIntroduced &&
          (seccompActive || helperPids.length > 0);
        verificationMethod = seccompActive
          ? "linux_proc_seccomp_filter_inspection"
          : "linux_ps_helper_inspection";
      } else if (process.platform === "win32") {
        runtimeVerified =
          Boolean(procTree.browserPid) &&
          !noSandboxIntroduced &&
          helperPids.length > 0;
        verificationMethod = "win32_cim_process_inspection";
      }

      if (!runtimeVerified) {
        throw new BrowserSessionError(
          "SANDBOX_UNAVAILABLE",
          `Independent runtime sandbox verification could not confirm active sandboxed Chromium helpers (browserPid=${procTree.browserPid ?? "none"}, helpers=${helperPids.length}). Failing closed.`
        );
      }

      this.#sandboxVerification = {
        supported: sandboxCapability.supported,
        capabilitySupported: sandboxCapability.supported,
        runtimeVerified,
        platform: process.platform,
        osRelease: os.release(),
        browserVersion,
        executablePath: execPath,
        executableSource: execSource,
        ...(procTree.browserPid !== undefined ? { browserPid: procTree.browserPid } : {}),
        helperPids,
        verificationMethod,
        details: `Chromium ${browserVersion} verified at runtime via ${verificationMethod} on ${process.platform} ${os.release()} (browserPid=${procTree.browserPid}, helpers=${helperPids.length}, noSandboxIntroduced=false).`,
        processFlags: {
          noSandboxIntroduced: false,
          chromiumSandboxOption: true,
          ...(seatbeltClientActive !== undefined ? { seatbeltClientActive } : {}),
          ...(seccompActive !== undefined ? { seccompActive } : {}),
        },
      };

      this.#status = "READY";
      this.#emit("session_started", {
        executablePath: execPath,
        source: execSource,
        headless: this.#config.headless ?? true,
        sandboxed: true,
        runtimeVerified,
        browserVersion,
        browserPid: procTree.browserPid,
        profileDir: userDataDir,
        accountId: this.#accountId,
      });
      this.#emit("sandbox_verified", {
        supported: true,
        capabilitySupported: true,
        runtimeVerified,
        platform: process.platform,
        osRelease: os.release(),
        browserVersion,
        executableSource: execSource,
        browserPid: procTree.browserPid,
        helperCount: helperPids.length,
        verificationMethod,
        noSandboxIntroduced: false,
      });
    } catch (err: any) {
      this.#status = "ERROR";
      // Fail-closed cleanup: never leak egress proxy ports, crashed Chromium processes, or temp profiles
      if (this.#egressProxy) {
        try {
          await this.#egressProxy.stop();
        } catch {
          // ignore
        }
        this.#egressProxy = undefined;
      }
      if (this.#context) {
        try {
          await this.#context.close();
        } catch {
          // ignore
        }
        this.#context = undefined;
      }
      this.#activePage = undefined;
      this.#terminateTrackedProcesses();
      if (this.#userDataDir) {
        try {
          if (fs.existsSync(this.#userDataDir)) {
            fs.rmSync(this.#userDataDir, { recursive: true, force: true });
          }
        } catch {
          // ignore
        }
        this.#userDataDir = undefined;
      }

      const rawErrMsg = redactSensitiveText(err?.message || String(err));
      this.#emit("process_cleanup", { reason: "launch_failed", error: rawErrMsg.slice(0, 500) });

      if (signal?.aborted) {
        throw new DOMException("Browser launch cancelled", "AbortError");
      }
      if (err instanceof BrowserSessionError && err.code === "SANDBOX_UNAVAILABLE") {
        throw err;
      }
      if (
        rawErrMsg.toLowerCase().includes("sandbox") ||
        rawErrMsg.toLowerCase().includes("operation not permitted") ||
        rawErrMsg.toLowerCase().includes("seatbelt")
      ) {
        throw new BrowserSessionError(
          "SANDBOX_UNAVAILABLE",
          `Chromium sandboxing failed to initialize securely on this platform/environment: ${rawErrMsg}. Secure sandboxing is strictly required; failing closed without disabling isolation.`,
          { cause: err }
        );
      }
      throw new BrowserSessionError("LAUNCH_FAILED", `Failed to launch browser: ${rawErrMsg}`, {
        cause: err,
      });
    }
  }

  public async open(
    url: string,
    signal?: AbortSignal
  ): Promise<{ pageId: string; url: string; title: string }> {
    await this.start(signal);
    if (!this.#context) {
      throw new BrowserSessionError("NO_CONTEXT", "Browser context is unavailable.");
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before open" });
      throw new DOMException("Browser open cancelled", "AbortError");
    }

    const policyConfig = this.#config.networkPolicy ?? {
      allowedOrigins: DEFAULT_ALLOWED_LOCAL_ORIGINS,
    };

    const redactedTarget = redactSensitiveText(url);
    this.#emit("navigation_attempted", { url: redactedTarget });

    const policyCheck = isBrowserUrlPermitted(url, policyConfig);
    if (!policyCheck.allowed) {
      const reason = redactSensitiveText(policyCheck.reason || "Blocked by policy");
      this.#emit("network_policy_denied", { url: redactedTarget, method: "NAVIGATE", error: reason });
      this.#emit("navigation_failed", { url: redactedTarget, reason });
      throw new BrowserNetworkPolicyError("SECURITY_POLICY_VIOLATION", reason);
    }

    try {
      this.#status = "NAVIGATING";
      let page = this.#activePage;
      if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
        const pages = this.#context.pages();
        page = pages.find((p: any) => !p.isClosed()) || (await this.#context.newPage());
        this.#activePage = page;
        this.#attachPageListeners(page);
      }

      const timeout = this.#config.timeoutMs ?? 30000;
      let abortListener: (() => void) | undefined;

      const navPromise = page.goto(url, {
        timeout,
        waitUntil: "domcontentloaded",
      });

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            this.#emit("cancellation", { action: "open", url: redactedTarget });
            page.evaluate(() => (globalThis as any).window?.stop?.()).catch(() => {});
            reject(new DOMException("Navigation cancelled by abort signal", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        // Prevent unhandled rejection on navPromise if abortPromise wins the race
        navPromise.catch(() => {});
        await Promise.race([navPromise, abortPromise]);
      } else {
        await navPromise;
      }

      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }

      const rawFinalUrl = page.url();
      const finalPolicyCheck = isBrowserUrlPermitted(rawFinalUrl, policyConfig);
      const finalUrl = redactSensitiveText(rawFinalUrl);
      if (!finalPolicyCheck.allowed) {
        const reason = redactSensitiveText(finalPolicyCheck.reason || "Blocked destination");
        this.#emit("network_policy_denied", { url: finalUrl, method: "REDIRECT", error: reason });
        this.#emit("navigation_failed", { url: finalUrl, reason });
        throw new BrowserNetworkPolicyError(
          "SECURITY_POLICY_VIOLATION",
          `Navigation terminated at unauthorized or blocked destination "${finalUrl}": ${reason}`
        );
      }
      const title = redactSensitiveText(await page.title());

      // Invalidate existing element references on navigation
      this.#activeSnapshotId = undefined;
      this.#elementRefs.clear();

      this.#status = "READY";
      this.#emit("navigation_completed", { url: finalUrl, title });

      return {
        pageId: "page_main",
        url: finalUrl,
        title,
      };
    } catch (err: any) {
      if (!this.#unexpectedlyClosed) {
        this.#status = "READY";
      }
      const cleanErr = redactSensitiveText(err?.message || String(err));
      this.#emit("navigation_failed", { url: redactedTarget, error: cleanErr });
      if (err?.name === "AbortError" || signal?.aborted) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
      if (err instanceof BrowserNetworkPolicyError || err instanceof BrowserSessionError) {
        throw err;
      }
      throw new BrowserSessionError("NAVIGATION_FAILED", cleanErr, { cause: err });
    }
  }

  public async navigate(
    url: string,
    signal?: AbortSignal
  ): Promise<{ url: string; title: string }> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (!this.#activePage || this.#unexpectedlyClosed) {
      const res = await this.open(url, signal);
      return { url: res.url, title: res.title };
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before navigate" });
      throw new DOMException("Navigation cancelled", "AbortError");
    }

    const policyConfig = this.#config.networkPolicy ?? {
      allowedOrigins: DEFAULT_ALLOWED_LOCAL_ORIGINS,
    };

    const redactedTarget = redactSensitiveText(url);
    this.#emit("navigation_attempted", { url: redactedTarget });

    const policyCheck = isBrowserUrlPermitted(url, policyConfig);
    if (!policyCheck.allowed) {
      const reason = redactSensitiveText(policyCheck.reason || "Blocked by policy");
      this.#emit("network_policy_denied", { url: redactedTarget, method: "NAVIGATE", error: reason });
      this.#emit("navigation_failed", { url: redactedTarget, reason });
      throw new BrowserNetworkPolicyError("SECURITY_POLICY_VIOLATION", reason);
    }

    try {
      this.#status = "NAVIGATING";
      const timeout = this.#config.timeoutMs ?? 30000;
      let abortListener: (() => void) | undefined;

      const navPromise = this.#activePage.goto(url, {
        timeout,
        waitUntil: "domcontentloaded",
      });

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            this.#emit("cancellation", { action: "navigate", url: redactedTarget });
            this.#activePage?.evaluate(() => (globalThis as any).window?.stop?.()).catch(() => {});
            reject(new DOMException("Navigation cancelled by abort signal", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        navPromise.catch(() => {});
        await Promise.race([navPromise, abortPromise]);
      } else {
        await navPromise;
      }

      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }

      const rawFinalUrl = this.#activePage.url();
      const finalPolicyCheck = isBrowserUrlPermitted(rawFinalUrl, policyConfig);
      const finalUrl = redactSensitiveText(rawFinalUrl);
      if (!finalPolicyCheck.allowed) {
        const reason = redactSensitiveText(finalPolicyCheck.reason || "Blocked destination");
        this.#emit("network_policy_denied", { url: finalUrl, method: "REDIRECT", error: reason });
        this.#emit("navigation_failed", { url: finalUrl, reason });
        throw new BrowserNetworkPolicyError(
          "SECURITY_POLICY_VIOLATION",
          `Navigation terminated at unauthorized or blocked destination "${finalUrl}": ${reason}`
        );
      }
      const title = redactSensitiveText(await this.#activePage.title());

      // Invalidate existing element references on navigation
      this.#activeSnapshotId = undefined;
      this.#elementRefs.clear();

      this.#status = "READY";
      this.#emit("navigation_completed", { url: finalUrl, title });

      return {
        url: finalUrl,
        title,
      };
    } catch (err: any) {
      if (!this.#unexpectedlyClosed) {
        this.#status = "READY";
      }
      const cleanErr = redactSensitiveText(err?.message || String(err));
      this.#emit("navigation_failed", { url: redactedTarget, error: cleanErr });
      if (err?.name === "AbortError" || signal?.aborted) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
      if (err instanceof BrowserNetworkPolicyError || err instanceof BrowserSessionError) {
        throw err;
      }
      throw new BrowserSessionError("NAVIGATION_FAILED", cleanErr, { cause: err });
    }
  }

  public async snapshot(
    _options?: { maxDepth?: number },
    signal?: AbortSignal
  ): Promise<AccessibilitySnapshot> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (
      !this.#activePage ||
      this.#unexpectedlyClosed ||
      (typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      throw new BrowserSessionError(
        "NO_PAGE",
        "No active browser page open or browser page closed unexpectedly. Call browser_open first."
      );
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before snapshot" });
      throw new DOMException("Snapshot cancelled", "AbortError");
    }

    const page = this.#activePage;
    let url: string;
    let title: string;
    const snapshotId = `snap_${crypto.randomBytes(12).toString("hex")}`;

    let rawElements: {
      tag: string;
      role: string;
      name: string;
      selector: string;
      value?: string;
      inputType: string;
      href: string;
      formAction: string;
      parentSignature: string;
      hasValue?: boolean;
      isSensitive?: boolean;
    }[];

    try {
      url = redactSensitiveText(page.url());
      title = redactSensitiveText(await page.title());

      rawElements = await page.evaluate(
        (args: { snapId: string; sessId: string }) => {
          const doc = (globalThis as any).document;
          const win = (globalThis as any).window;

          // Strip any pre-existing or maliciously injected data-ovsc-* attributes across the entire document first
          const staleTagged = Array.from(
            doc.querySelectorAll("[data-ovsc-ref],[data-ovsc-snap],[data-ovsc-session]")
          );
          for (const stale of staleTagged as any[]) {
            stale.removeAttribute("data-ovsc-ref");
            stale.removeAttribute("data-ovsc-snap");
            stale.removeAttribute("data-ovsc-session");
          }

          const selectors = [
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "button",
            "a[href]",
            "input",
            "select",
            "textarea",
            "[role='button']",
            "[role='link']",
            "[role='checkbox']",
            "[role='textbox']",
            "[role='combobox']",
            "[role='menuitem']",
            "[role='heading']",
          ];
          const found: {
            tag: string;
            role: string;
            name: string;
            selector: string;
            value?: string;
            inputType: string;
            href: string;
            formAction: string;
            parentSignature: string;
            hasValue?: boolean;
            isSensitive?: boolean;
          }[] = [];

          const nodes = Array.from(doc.querySelectorAll(selectors.join(",")));
          let visibleCount = 0;

          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i] as any;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            const style = win.getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none") continue;

            const tag = el.tagName.toLowerCase();
            const role =
              el.getAttribute("role") ||
              (tag === "a"
                ? "link"
                : tag === "input"
                ? "textbox"
                : tag.startsWith("h") && !isNaN(Number(tag[1]))
                ? "heading"
                : tag);

            // Never fall back to el.value for accessible name to prevent leaking secret input values
            const rawName =
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.placeholder ||
              el.innerText?.trim() ||
              "";
            const name = String(rawName).slice(0, 100);

            let selector = "";
            const gCss = (globalThis as any).CSS;
            if (el.id) {
              const escId =
                typeof gCss?.escape === "function" ? gCss.escape(el.id) : String(el.id).replace(/["\\]/g, "\\$&");
              selector = `#${escId}`;
            } else if (el.getAttribute("name")) {
              const rawAttr = el.getAttribute("name") || "";
              const escName =
                typeof gCss?.escape === "function" ? gCss.escape(rawAttr) : String(rawAttr).replace(/["\\]/g, "\\$&");
              selector = `${tag}[name="${escName}"]`;
            } else {
              let nth = 1;
              let sib = el.previousElementSibling;
              while (sib) {
                if (sib.tagName.toLowerCase() === tag) nth++;
                sib = sib.previousElementSibling;
              }
              selector = `${tag}:nth-of-type(${nth})`;
            }

            const inputType = String(el.getAttribute("type") || el.type || "").toLowerCase();
            const href = String(el.getAttribute("href") || "");
            const owningForm = el.form || el.closest?.("form");
            const formAction = String(
              el.getAttribute("formaction") || owningForm?.getAttribute?.("action") || ""
            );
            const parent = el.parentElement;
            const parentSig = `${parent ? parent.tagName.toLowerCase() : "none"}#${parent?.id || ""}|form#${owningForm?.id || ""}:${formAction}`;

            const sensitiveKeywords = [
              "password",
              "secret",
              "token",
              "api_key",
              "apikey",
              "private_key",
              "credit_card",
              "card_number",
              "ssn",
              "cvv",
              "pin",
            ];
            const textToCheck = `${name} ${role} ${tag} ${el.name || ""} ${el.id || ""} ${inputType}`.toLowerCase();
            const isSens =
              inputType === "password" ||
              sensitiveKeywords.some((kw) => textToCheck.includes(kw));

            visibleCount++;
            const refId = `e${visibleCount}`;
            el.setAttribute("data-ovsc-ref", refId);
            el.setAttribute("data-ovsc-snap", args.snapId);
            el.setAttribute("data-ovsc-session", args.sessId);

            const item: {
              tag: string;
              role: string;
              name: string;
              selector: string;
              value?: string;
              inputType: string;
              href: string;
              formAction: string;
              parentSignature: string;
              hasValue?: boolean;
              isSensitive?: boolean;
            } = {
              tag,
              role,
              name,
              selector,
              inputType,
              href,
              formAction,
              parentSignature: parentSig,
              isSensitive: isSens,
            };

            // P0 Sensitive observation protection: NEVER expose password or sensitive field values!
            if (isSens) {
              item.hasValue = Boolean(el.value);
            } else if (el.value !== undefined && el.value !== null && el.value !== "") {
              item.value = String(el.value).slice(0, 100);
              item.hasValue = true;
            }

            found.push(item);
          }
          return found;
        },
        { snapId: snapshotId, sessId: this.#sessionId }
      );
    } catch (err: any) {
      const msg = redactSensitiveText(err?.message || String(err));
      throw new BrowserSessionError(
        "NO_PAGE",
        `Browser page unavailable during snapshot: ${msg}`,
        { cause: err }
      );
    }

    const elements: ElementRef[] = [];
    const treeLines: string[] = [`Page: "${title}" (${url})`];

    this.#elementRefs.clear();
    for (let idx = 0; idx < rawElements.length; idx++) {
      const raw = rawElements[idx];
      if (!raw) continue;
      const refId = `e${idx + 1}`;
      const redactedName = redactSensitiveText(raw.name);
      const redactedValue = raw.value !== undefined ? redactSensitiveText(raw.value) : undefined;
      const typeSelectorHint = raw.inputType ? `${raw.selector} type="${raw.inputType}"` : raw.selector;

      const isSens =
        raw.isSensitive ||
        isSensitiveField({
          name: raw.name,
          role: raw.role,
          tag: raw.tag,
          selector: typeSelectorHint,
        });
      const isDest = isDestructiveElement({
        name: raw.name,
        role: raw.role,
        tag: raw.tag,
      });
      const isSide = isSideEffectElement({
        name: raw.name,
        role: raw.role,
        tag: raw.tag,
        selector: typeSelectorHint,
      });

      const targetFingerprint = crypto
        .createHash("sha256")
        .update(
          `${this.#sessionId}:${snapshotId}:${refId}:${raw.tag}:${raw.role}:${raw.name}:${raw.inputType}:${raw.href}:${raw.formAction}:${raw.parentSignature}:${isDest}:${isSens}:${isSide}`
        )
        .digest("hex");

      const ref: ElementRef = {
        refId,
        role: raw.role,
        name: redactedName,
        selector: raw.selector,
        snapshotId,
        tag: raw.tag,
        value: isSens ? undefined : redactedValue,
        sensitive: isSens,
        destructive: isDest,
        sideEffect: isSide,
        targetFingerprint,
        inputType: raw.inputType,
        href: redactSensitiveText(raw.href),
        formAction: redactSensitiveText(raw.formAction),
        parentSignature: raw.parentSignature,
      };

      elements.push(ref);
      this.#elementRefs.set(refId, ref);

      const flags = [
        isSens ? "[SENSITIVE]" : "",
        isDest ? "[DESTRUCTIVE]" : "",
        isSide ? "[SIDE_EFFECT]" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const valueInfo = isSens
        ? raw.hasValue
          ? " [hasValue]"
          : ""
        : redactedValue
        ? ` value="${redactedValue}"`
        : "";

      treeLines.push(
        `  [ref=${refId}] <${raw.tag}> ${raw.role} "${redactedName}"${valueInfo} ${flags}`.trimEnd()
      );
    }

    this.#activeSnapshotId = snapshotId;

    let treeText = treeLines.join("\n");
    let truncated = false;
    let bytes = Buffer.byteLength(treeText, "utf8");

    if (bytes > this.#maxSnapshotBytes) {
      truncated = true;
      const budget = Math.max(0, this.#maxSnapshotBytes - 120);
      treeText =
        treeText.slice(0, budget) + "\n... [TRUNCATED: Snapshot exceeded maxSnapshotBytes limit]";
      bytes = Buffer.byteLength(treeText, "utf8");
    }

    const snapshot: AccessibilitySnapshot = {
      snapshotId,
      url,
      title,
      tree: treeText,
      elements,
      elementCount: elements.length,
      truncated,
      bytes,
    };

    this.#emit("snapshot_taken", {
      snapshotId,
      url,
      elementCount: elements.length,
      bytes,
      truncated,
    });

    return snapshot;
  }

  public getElementRef(refId: string): ElementRef | undefined {
    return this.#elementRefs.get(refId);
  }

  public getActiveSnapshotId(): string | undefined {
    return this.#activeSnapshotId;
  }

  async #validateLiveTarget(
    toolName: "browser_click" | "browser_fill",
    refId: string,
    fillValue?: string | undefined
  ): Promise<{ locator: any; element: ElementRef; live: LiveDomInspection; liveAction: ToolAction }> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (
      !this.#activePage ||
      this.#unexpectedlyClosed ||
      (typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    const element = this.#elementRefs.get(refId);
    if (!element || element.snapshotId !== this.#activeSnapshotId) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Element reference "${refId}" is invalid or stale. The page has navigated or changed since the snapshot was taken. Capture a fresh snapshot first.`
      );
    }

    // Strict attribute binding to (refId, snapshotId, sessionId) — NO positional or CSS fallback!
    const locator = this.#activePage.locator(
      `[data-ovsc-ref="${refId}"][data-ovsc-snap="${element.snapshotId}"][data-ovsc-session="${this.#sessionId}"]`
    );
    const count = await locator.count();
    if (count === 0) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Target element "${refId}" is detached or replaced in DOM.`
      );
    }
    if (count > 1) {
      throw new BrowserSessionError(
        "AMBIGUOUS_TARGET_REFERENCE",
        `[AMBIGUOUS_TARGET_REFERENCE] Multiple elements (${count}) match reference "${refId}". Aborting due to ambiguous or malicious duplicate reference attributes.`
      );
    }

    const live: LiveDomInspection = await locator.evaluate((el: any) => {
      const anyEl = el;
      const tag = el.tagName.toLowerCase();
      const role =
        el.getAttribute("role") ||
        (tag === "a"
          ? "link"
          : tag === "input"
          ? "textbox"
          : tag.startsWith("h") && !isNaN(Number(tag[1]))
          ? "heading"
          : tag);
      const rawName =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        anyEl.placeholder ||
        anyEl.innerText?.trim() ||
        "";
      const name = String(rawName).slice(0, 100);
      const inputType = String(el.getAttribute("type") || anyEl.type || "").toLowerCase();
      const href = String(el.getAttribute("href") || "");
      const owningForm = anyEl.form || el.closest?.("form");
      const formAction = String(
        el.getAttribute("formaction") || owningForm?.getAttribute?.("action") || ""
      );
      const parent = el.parentElement;
      const parentSignature = `${parent ? parent.tagName.toLowerCase() : "none"}#${parent?.id || ""}|form#${owningForm?.id || ""}:${formAction}`;
      return {
        tag,
        role,
        name,
        inputType,
        href,
        formAction,
        parentSignature,
        isConnected: el.isConnected,
      };
    });

    if (!live.isConnected) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Target element "${refId}" is detached from DOM.`
      );
    }

    if (live.tag !== element.tag || live.role !== element.role) {
      throw new BrowserSessionError(
        "TARGET_MUTATION_DETECTED",
        `[TARGET_MUTATION_DETECTED] Target element "${refId}" mutated from <${element.tag}> ${element.role} to <${live.tag}> ${live.role}. Action aborted.`
      );
    }

    const liveRedactedName = redactSensitiveText(live.name);
    if (liveRedactedName !== element.name) {
      // Check if accessible name escalation also turned target destructive/side-effect
      const escalatedDest = !element.destructive && isDestructiveElement({ name: live.name, role: live.role, tag: live.tag });
      if (escalatedDest) {
        throw new BrowserSessionError(
          "ACTION_RISK_ESCALATED",
          `[ACTION_RISK_ESCALATED] Formerly harmless control "${refId}" mutated into DESTRUCTIVE target ("${liveRedactedName}"). Approval invalidated.`
        );
      }
      throw new BrowserSessionError(
        "TARGET_CONTENT_CHANGED",
        `[TARGET_CONTENT_CHANGED] Target accessible name changed from "${element.name}" to "${liveRedactedName}". Approval invalidated.`
      );
    }

    // Reclassify live risk (including inputType, href, formAction, sideEffect, sensitive, destructive)
    const liveTypeSelectorHint = live.inputType
      ? `${element.selector} type="${live.inputType}"`
      : element.selector;
    const liveDest = isDestructiveElement({ name: live.name, role: live.role, tag: live.tag });
    const liveSens = isSensitiveField({
      name: live.name,
      role: live.role,
      tag: live.tag,
      selector: liveTypeSelectorHint,
    });
    const liveSide = isSideEffectElement({
      name: live.name,
      role: live.role,
      tag: live.tag,
      selector: liveTypeSelectorHint,
    });

    if (!element.destructive && liveDest) {
      throw new BrowserSessionError(
        "ACTION_RISK_ESCALATED",
        `[ACTION_RISK_ESCALATED] Formerly harmless control "${refId}" has become DESTRUCTIVE. Action blocked.`
      );
    }
    if (!element.sensitive && liveSens) {
      throw new BrowserSessionError(
        "ACTION_RISK_ESCALATED",
        `[ACTION_RISK_ESCALATED] Formerly non-sensitive control "${refId}" has become SENSITIVE. Action blocked.`
      );
    }
    if (!element.sideEffect && liveSide) {
      throw new BrowserSessionError(
        "ACTION_RISK_ESCALATED",
        `[ACTION_RISK_ESCALATED] Control "${refId}" escalated to SIDE_EFFECT semantics (e.g. submit button). Action blocked.`
      );
    }

    if (
      (element.inputType !== undefined && live.inputType !== element.inputType) ||
      (element.href !== undefined && redactSensitiveText(live.href) !== element.href) ||
      (element.formAction !== undefined && redactSensitiveText(live.formAction) !== element.formAction) ||
      (element.parentSignature !== undefined && live.parentSignature !== element.parentSignature)
    ) {
      throw new BrowserSessionError(
        "TARGET_MUTATION_DETECTED",
        `[TARGET_MUTATION_DETECTED] Target element "${refId}" structural attributes (type, href, formAction, or container) mutated since snapshot. Approval invalidated.`
      );
    }

    const liveElementRef: ElementRef = {
      ...element,
      name: liveRedactedName,
      role: live.role,
      tag: live.tag,
      destructive: liveDest,
      sensitive: liveSens,
      sideEffect: liveSide,
    };

    const liveAction = classifyBrowserToolAction({
      toolName,
      args: fillValue !== undefined ? { refId, value: fillValue } : { refId },
      targetElement: liveElementRef,
    });

    this.#emit("target_validated", {
      tool: toolName,
      refId,
      snapshotId: element.snapshotId,
      role: live.role,
      destructive: liveDest,
      sensitive: liveSens,
      sideEffect: liveSide,
      effectiveAction: liveAction,
    });

    return { locator, element, live, liveAction };
  }

  /**
   * Revalidates a previously granted tool approval immediately prior to execution.
   * Rejects stale snapshots, URL drifts, replaced/detached DOM nodes, duplicate refs,
   * changed accessible content, or escalated risk semantics.
   */
  public async revalidateApproval(params: {
    readonly toolName: "browser_click" | "browser_fill";
    readonly refId: string;
    readonly approvedSnapshotId: string | undefined;
    readonly approvedPageUrl: string;
    readonly approvedFingerprint: string | undefined;
    readonly approvedAction: ToolAction;
    readonly fillValue?: string | undefined;
  }): Promise<void> {
    if (this.#disposed) {
      this.#emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "SESSION_DISPOSED" });
      throw new BrowserSessionError("DISPOSED", "Browser session was disposed after approval.");
    }
    const currentPage = this.#activePage;
    if (
      !currentPage ||
      this.#unexpectedlyClosed ||
      (typeof currentPage.isClosed === "function" && currentPage.isClosed())
    ) {
      this.#emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "NO_PAGE" });
      throw new BrowserSessionError("NO_PAGE", "Active browser page closed since approval was granted.");
    }
    if (!params.approvedSnapshotId || !params.approvedFingerprint) {
      this.#emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "MISSING_SNAPSHOT_BINDING" });
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Approval for "${params.refId}" lacks valid snapshot target binding.`
      );
    }
    if (currentPage.url() !== params.approvedPageUrl) {
      this.#emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "PAGE_URL_CHANGED" });
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        "[STALE_ELEMENT_REFERENCE] Page URL changed since approval was granted. Target action aborted."
      );
    }
    if (this.#activeSnapshotId !== params.approvedSnapshotId) {
      this.#emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "SNAPSHOT_CHANGED" });
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        "[STALE_ELEMENT_REFERENCE] Snapshot changed or expired since approval was granted. Target action aborted."
      );
    }
    const storedTarget = this.#elementRefs.get(params.refId);
    if (!storedTarget || storedTarget.targetFingerprint !== params.approvedFingerprint) {
      this.#emit("action_denied", { tool: params.toolName, refId: params.refId, reason: "FINGERPRINT_MISMATCH" });
      throw new BrowserSessionError(
        "TARGET_MUTATION_DETECTED",
        "[TARGET_MUTATION_DETECTED] Target fingerprint changed since approval was granted. Target action aborted."
      );
    }

    try {
      const { liveAction } = await this.#validateLiveTarget(
        params.toolName,
        params.refId,
        params.fillValue
      );
      if (liveAction !== params.approvedAction) {
        throw new BrowserSessionError(
          "ACTION_RISK_ESCALATED",
          `[ACTION_RISK_ESCALATED] Target action classification changed from "${params.approvedAction}" to "${liveAction}" after approval. Action aborted.`
        );
      }
      this.#emit("approval_revalidated", {
        tool: params.toolName,
        refId: params.refId,
        snapshotId: params.approvedSnapshotId,
        effectiveAction: liveAction,
      });
    } catch (err: any) {
      this.#emit("action_denied", {
        tool: params.toolName,
        refId: params.refId,
        reason: err?.code || "REVALIDATION_FAILED",
      });
      throw err;
    }
  }

  public async click(
    refId: string,
    signal?: AbortSignal
  ): Promise<{ success: boolean; target: ElementRef }> {
    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before click", refId });
      throw new DOMException("Click cancelled", "AbortError");
    }

    try {
      const { locator, element } = await this.#validateLiveTarget("browser_click", refId);
      this.#emit("tool_invoked", { tool: "browser_click", refId, target: element.name });

      let abortListener: (() => void) | undefined;
      const clickPromise = locator.click({
        timeout: this.#config.timeoutMs ?? 10000,
      });

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            this.#emit("cancellation", { tool: "browser_click", refId });
            reject(new DOMException("Click cancelled", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        clickPromise.catch(() => {});
        await Promise.race([clickPromise, abortPromise]);
      } else {
        await clickPromise;
      }

      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }

      this.#emit("action_approved", { tool: "browser_click", refId });
      return { success: true, target: element };
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        this.#emit("cancellation", { tool: "browser_click", refId });
        throw new DOMException("Click cancelled", "AbortError");
      }
      if (err instanceof BrowserSessionError) {
        throw err;
      }
      throw new BrowserSessionError(
        "CLICK_FAILED",
        `Failed to click element "${refId}": ${redactSensitiveText(err?.message || String(err))}`,
        { cause: err }
      );
    }
  }

  public async fill(
    refId: string,
    value: string,
    signal?: AbortSignal
  ): Promise<{ success: boolean; target: ElementRef }> {
    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before fill", refId });
      throw new DOMException("Fill cancelled", "AbortError");
    }

    try {
      const { locator, element } = await this.#validateLiveTarget("browser_fill", refId, value);
      this.#emit("tool_invoked", { tool: "browser_fill", refId, target: element.name });

      let abortListener: (() => void) | undefined;
      const fillPromise = locator.fill(value, {
        timeout: this.#config.timeoutMs ?? 10000,
      });

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            this.#emit("cancellation", { tool: "browser_fill", refId });
            reject(new DOMException("Fill cancelled", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        fillPromise.catch(() => {});
        await Promise.race([fillPromise, abortPromise]);
      } else {
        await fillPromise;
      }

      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }

      this.#emit("action_approved", { tool: "browser_fill", refId });
      return { success: true, target: element };
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        this.#emit("cancellation", { tool: "browser_fill", refId });
        throw new DOMException("Fill cancelled", "AbortError");
      }
      if (err instanceof BrowserSessionError) {
        throw err;
      }
      throw new BrowserSessionError(
        "FILL_FAILED",
        `Failed to fill field "${refId}": ${redactSensitiveText(err?.message || String(err))}`,
        { cause: err }
      );
    }
  }

  public async screenshot(
    options?: { fullPage?: boolean },
    signal?: AbortSignal
  ): Promise<{ bytes: number; mimeType: "image/png"; base64?: string }> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (
      !this.#activePage ||
      this.#unexpectedlyClosed ||
      (typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before screenshot" });
      throw new DOMException("Screenshot cancelled", "AbortError");
    }

    // Visually mask sensitive inputs before capturing PNG pixels, then restore cleanly
    let maskedCount = 0;
    const maskStyleId = `ovsc-mask-${crypto.randomUUID().slice(0, 8)}`;
    try {
      maskedCount = await this.#activePage.evaluate((styleId: string) => {
        const doc = (globalThis as any).document;
        if (!doc?.head) return 0;
        const sensitiveKws = [
          "password",
          "secret",
          "token",
          "api_key",
          "apikey",
          "private_key",
          "credit_card",
          "card_number",
          "ssn",
          "cvv",
          "pin",
        ];
        let count = 0;
        for (const el of Array.from(doc.querySelectorAll("input, textarea")) as any[]) {
          const check = `${el.type || ""} ${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
          if (el.type === "password" || sensitiveKws.some((k) => check.includes(k))) {
            el.setAttribute("data-ovsc-masked-shot", styleId);
            count++;
          }
        }
        if (count > 0) {
          const styleEl = doc.createElement("style");
          styleEl.id = styleId;
          styleEl.textContent = `[data-ovsc-masked-shot="${styleId}"] { color: transparent !important; -webkit-text-security: disc !important; text-shadow: none !important; }`;
          doc.head.appendChild(styleEl);
        }
        return count;
      }, maskStyleId);
    } catch {
      // Proceed safely if DOM styling fails
    }

    let buffer: Buffer;
    let abortListener: (() => void) | undefined;
    try {
      const shotPromise = this.#activePage.screenshot({
        fullPage: options?.fullPage ?? false,
        type: "png",
      });

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            this.#emit("cancellation", { action: "screenshot" });
            reject(new DOMException("Screenshot cancelled", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        shotPromise.catch(() => {});
        buffer = await Promise.race([shotPromise, abortPromise]);
      } else {
        buffer = await shotPromise;
      }
    } finally {
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
      if (maskedCount > 0 && this.#activePage) {
        await this.#activePage
          .evaluate((styleId: string) => {
            const doc = (globalThis as any).document;
            doc?.getElementById(styleId)?.remove();
            for (const el of Array.from(doc?.querySelectorAll(`[data-ovsc-masked-shot="${styleId}"]`) || []) as any[]) {
              el.removeAttribute("data-ovsc-masked-shot");
            }
          }, maskStyleId)
          .catch(() => {});
      }
    }

    const bytes = buffer.length;
    const base64 = bytes <= 524288 ? buffer.toString("base64") : undefined;

    // Never log raw screenshot bytes in event stream
    this.#emit("screenshot_taken", {
      bytes,
      mimeType: "image/png",
      fullPage: options?.fullPage ?? false,
      maskedSensitiveFields: maskedCount,
    });

    return {
      bytes,
      mimeType: "image/png",
      ...(base64 !== undefined ? { base64 } : {}),
    };
  }

  public getConsoleDiagnostics(): readonly BrowserConsoleEntry[] {
    return [...this.#consoleBuffer];
  }

  public getNetworkDiagnostics(): readonly BrowserNetworkFailure[] {
    return [...this.#networkFailures];
  }

  public async close(): Promise<void> {
    this.#status = "CLOSING";
    this.#activeSnapshotId = undefined;
    this.#elementRefs.clear();

    if (this.#egressProxy) {
      try {
        await this.#egressProxy.stop();
      } catch {
        // Safe egress proxy stop failure
      }
      this.#egressProxy = undefined;
    }

    if (this.#activePage) {
      try {
        await this.#activePage.close();
      } catch {
        // Safe page close
      }
      this.#activePage = undefined;
    }

    if (this.#context) {
      try {
        await this.#context.close();
      } catch {
        // Safe context close
      }
      this.#context = undefined;
    }

    if (this.#browser) {
      const proc =
        typeof (this.#browser as any).process === "function"
          ? (this.#browser as any).process()
          : undefined;
      try {
        await this.#browser.close();
      } catch {
        // Safe browser close
      }
      if (proc) {
        killProcessTree(proc);
      }
      this.#browser = undefined;
    }

    this.#terminateTrackedProcesses();
    this.#unexpectedlyClosed = false;
    this.#status = "CLOSED";
    this.#emit("session_closed", {});
  }

  public async invalidate(reason: string): Promise<void> {
    if (this.#disposed) return;
    this.#emit("session_invalidated", {
      reason,
      accountId: this.#accountId,
    });
    await this.dispose();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.close();
    const removedProfileDir = this.#userDataDir;
    if (this.#userDataDir) {
      try {
        if (fs.existsSync(this.#userDataDir)) {
          fs.rmSync(this.#userDataDir, { recursive: true, force: true });
        }
      } catch {
        // Safe cleanup ignore
      }
      this.#userDataDir = undefined;
    }
    this.#emit("process_cleanup", {
      sessionId: this.#sessionId,
      profileRemoved: removedProfileDir ? !fs.existsSync(removedProfileDir) : true,
    });
    this.#eventListeners.clear();
    this.#elementRefs.clear();
  }
}
