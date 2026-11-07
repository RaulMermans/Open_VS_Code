import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ToolAction } from "../contracts/tools.ts";
import type {
  BrowserSessionConfig,
  BrowserSessionStatus,
  BrowserNetworkPolicyConfig,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  AccessibilitySnapshot,
  ElementRef,
  BrowserEvent,
  BrowserConsoleEntry,
  BrowserNetworkFailure,
  EffectiveSandboxVerification,
} from "./browser-contracts.ts";
import {
  resolveViewportPresetId,
  type AnimationObservation,
  type BrowserEventCorrelation,
  type BrowserViewportDimensions,
  type ElementBoundingBox,
  type ElementDesignMetadata,
  type ElementInteractiveState,
  type ObservedVisualQaState,
} from "./browser-observation-contracts.ts";
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
  redactSensitiveText,
  sanitizeBrowserUrl,
} from "./browser-action-classifier.ts";
import { killProcessTree, execProcessProbe } from "../tools/kill-process-tree.ts";
import { evaluateMotionObservations } from "../design/motion-evaluator.ts";
import type { MeasuredMotionObservation } from "../design/contracts.ts";

export { redactSensitiveText, sanitizeBrowserUrl };

export class BrowserSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserSessionError";
    this.code = code;
  }
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
      // Chromium's setuid sandbox host is started with --no-zygote-sandbox.
      // The sandboxed zygote is the chrome-sandbox child. That flag is not --no-sandbox.
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
  #viewport: BrowserViewportDimensions;
  #currentUrl = "";
  #currentTitle = "";
  #latestSnapshot?: AccessibilitySnapshot | undefined;
  readonly #correlationStack: BrowserEventCorrelation[] = [];
  #disposed = false;
  #unexpectedlyClosed = false;

  constructor(config: BrowserSessionConfig) {
    this.#config = config;
    this.#sessionId = config.sessionId || `browser_sess_${crypto.randomUUID().slice(0, 8)}`;
    this.#accountId = config.accountId || "anonymous";
    this.#maxConsoleMessages = config.maxConsoleMessages ?? 100;
    this.#maxNetworkEvents = config.maxNetworkEvents ?? 100;
    this.#maxSnapshotBytes = config.maxSnapshotBytes ?? 32768; // 32 KB limit
    this.#viewport = config.viewport
      ? { width: config.viewport.width, height: config.viewport.height }
      : { width: 1280, height: 800 };
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

  public isDisposed(): boolean {
    return this.#disposed;
  }

  public hasUnexpectedCrash(): boolean {
    return this.#unexpectedlyClosed;
  }

  public getCurrentUrl(): string {
    if (
      this.#activePage &&
      !this.#unexpectedlyClosed &&
      !(typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      try {
        const raw = this.#activePage.url();
        if (raw && raw !== "about:blank") {
          this.#currentUrl = sanitizeBrowserUrl(raw);
        }
      } catch {
        // Safe fallback to cached URL
      }
    }
    return this.#currentUrl;
  }

  public getCurrentTitle(): string {
    return this.#currentTitle;
  }

  public getViewport(): BrowserViewportDimensions {
    return { ...this.#viewport };
  }

  public getLatestSnapshot(): AccessibilitySnapshot | undefined {
    return this.#latestSnapshot;
  }

  public isSnapshotFresh(snapshotId?: string): boolean {
    if (!this.#activeSnapshotId || this.#disposed || this.#unexpectedlyClosed) {
      return false;
    }
    if (snapshotId && snapshotId !== this.#activeSnapshotId) {
      return false;
    }
    return true;
  }

  public getNetworkPolicyConfig(): BrowserNetworkPolicyConfig {
    return (
      this.#config.networkPolicy ?? {
        allowedOrigins: DEFAULT_ALLOWED_LOCAL_ORIGINS,
      }
    );
  }

  public async withCorrelation<T>(
    correlation: BrowserEventCorrelation,
    fn: () => Promise<T>
  ): Promise<T> {
    this.#correlationStack.push(correlation);
    try {
      return await fn();
    } finally {
      this.#correlationStack.pop();
    }
  }

  public recordApprovalRequested(
    details: {
      readonly tool: string;
      readonly action: ToolAction;
      readonly target?: string | undefined;
      readonly refId?: string | undefined;
      readonly confirmationId?: string | undefined;
    },
    correlation?: BrowserEventCorrelation
  ): void {
    this.#emit("approval_requested", { ...details }, correlation);
  }

  public recordApprovalResolved(
    details: {
      readonly tool: string;
      readonly action: ToolAction;
      readonly approved: boolean;
      readonly target?: string | undefined;
      readonly refId?: string | undefined;
      readonly reason?: string | undefined;
      readonly confirmationId?: string | undefined;
    },
    correlation?: BrowserEventCorrelation
  ): void {
    this.#emit("approval_resolved", { ...details }, correlation);
    if (!details.approved) {
      this.#emit(
        "action_denied",
        {
          tool: details.tool,
          action: details.action,
          ...(details.refId ? { refId: details.refId } : {}),
          ...(details.target ? { target: details.target } : {}),
          reason: details.reason || "USER_REJECTED",
        },
        correlation
      );
    }
  }

  public recordActionDenied(
    details: {
      readonly tool: string;
      readonly action: ToolAction;
      readonly target?: string | undefined;
      readonly refId?: string | undefined;
      readonly reason: string;
    },
    correlation?: BrowserEventCorrelation
  ): void {
    this.#emit("action_denied", { ...details }, correlation);
  }

  public async setViewport(dimensions: BrowserViewportDimensions): Promise<BrowserViewportDimensions> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    const width = Math.round(Number(dimensions.width));
    const height = Math.round(Number(dimensions.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 240 || width > 3840 || height < 240 || height > 2160) {
      throw new BrowserSessionError(
        "INVALID_VIEWPORT",
        `Viewport dimensions must be between 240×240 and 3840×2160 (received ${dimensions.width}×${dimensions.height}).`
      );
    }
    this.#viewport = { width, height };
    this.#activeSnapshotId = undefined;
    this.#elementRefs.clear();

    if (
      this.#activePage &&
      !this.#unexpectedlyClosed &&
      !(typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed()) &&
      typeof (this.#activePage as any).setViewportSize === "function"
    ) {
      await (this.#activePage as any).setViewportSize({ width, height });
    }

    this.#emit("viewport_changed", {
      width,
      height,
      presetId: resolveViewportPresetId(this.#viewport),
    });
    return { ...this.#viewport };
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

  #emit(
    type: BrowserEvent["type"],
    details: Readonly<Record<string, unknown>>,
    correlationOverride?: BrowserEventCorrelation
  ): void {
    const sanitizedDetails: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(details)) {
      if (typeof v === "string") {
        sanitizedDetails[k] = redactSensitiveText(v);
      } else {
        sanitizedDetails[k] = v;
      }
    }
    const activeCorrelation =
      correlationOverride ?? this.#correlationStack[this.#correlationStack.length - 1];
    const event: BrowserEvent = {
      type,
      sessionId: this.#sessionId,
      timestamp: Date.now(),
      details: sanitizedDetails,
      ...(activeCorrelation ? { correlation: activeCorrelation } : {}),
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
      this.#emit("browser_crashed", { reason: "page_crash", url: this.#currentUrl });
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

      // Strictly forbidden to ever introduce --no-sandbox or --disable-setuid-sandbox.
      // Headless macOS runners deliver requestAnimationFrame at about 10–30Hz even
      // with background throttling disabled. A headed window on that platform uses
      // the display clock. Vsync stays enabled so the sample cannot invent frames.
      const measureFrames = this.#config.foregroundFrames === true;
      const headedMotion = measureFrames && process.platform === "darwin";
      const launchArgs = [
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        ...(measureFrames
          ? [
              "--disable-background-timer-throttling",
              "--disable-renderer-backgrounding",
              "--disable-backgrounding-occluded-windows",
              "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
            ]
          : ["--disable-gpu"]),
      ];

      const { chromium } = await import("playwright-core");
      const blockSw = policyConfig.blockServiceWorkers !== false;

      // Sprint 9A.2 P0: Explicit chromiumSandbox: true across ALL supported platforms
      // and proxy bypass "<-loopback>" so loopback ports cannot bypass the egress proxy.
      this.#context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: execPath,
        headless: headedMotion ? false : (this.#config.headless ?? true),
        chromiumSandbox: true,
        args: launchArgs,
        proxy: {
          server: this.#egressProxy.serverUrl,
          bypass: "<-loopback>",
        },
        serviceWorkers: blockSw ? "block" : "allow",
        ignoreHTTPSErrors: false,
        viewport: { ...this.#viewport },
      });

      this.#context.on("close", () => {
        if (this.#status !== "CLOSING" && this.#status !== "CLOSED") {
          this.#unexpectedlyClosed = true;
          this.#status = "ERROR";
          this.#activePage = undefined;
          this.#context = undefined;
          this.#activeSnapshotId = undefined;
          this.#elementRefs.clear();
          this.#emit("browser_crashed", { reason: "context_unexpected_close", url: this.#currentUrl });
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
        headless: headedMotion ? false : (this.#config.headless ?? true),
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
      this.#currentUrl = finalUrl;
      this.#currentTitle = title;

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
      if (err?.name === "TimeoutError" || /timeout\s+\d+ms\s+exceeded/i.test(cleanErr)) {
        this.#emit("timeout", { action: "open", url: redactedTarget, error: cleanErr });
      }
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
      this.#currentUrl = finalUrl;
      this.#currentTitle = title;

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
      if (err?.name === "TimeoutError" || /timeout\s+\d+ms\s+exceeded/i.test(cleanErr)) {
        this.#emit("timeout", { action: "navigate", url: redactedTarget, error: cleanErr });
      }
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
      bounds: ElementBoundingBox;
      interactiveState: ElementInteractiveState;
    }[];

    try {
      url = redactSensitiveText(page.url());
      title = redactSensitiveText(await page.title());
      this.#currentUrl = url;
      this.#currentTitle = title;

      rawElements = await page.evaluate(
        (args: { snapId: string; sessId: string; fallbackW: number; fallbackH: number }) => {
          const doc = (globalThis as any).document;
          const win = (globalThis as any).window;
          const vpWidth = Math.round(Number(win.innerWidth) || args.fallbackW);
          const vpHeight = Math.round(Number(win.innerHeight) || args.fallbackH);

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
            "li",
            "[role='button']",
            "[role='link']",
            "[role='checkbox']",
            "[role='textbox']",
            "[role='combobox']",
            "[role='menuitem']",
            "[role='heading']",
            "[role='listitem']",
            "[role='alert']",
            "[role='status']",
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
            bounds: {
              x: number;
              y: number;
              width: number;
              height: number;
              viewportWidth: number;
              viewportHeight: number;
            };
            interactiveState: {
              disabled: boolean;
              checked?: boolean;
              expanded?: boolean;
              readonly: boolean;
              required: boolean;
              focused: boolean;
              editable: boolean;
            };
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
                : tag === "li"
                ? "listitem"
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

            const ariaChecked = el.getAttribute("aria-checked");
            const ariaExpanded = el.getAttribute("aria-expanded");
            const isEditableTag =
              (tag === "input" &&
                !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(
                  inputType
                )) ||
              tag === "textarea" ||
              role === "textbox" ||
              Boolean(el.isContentEditable);
            const disabled = Boolean(el.disabled || el.getAttribute("aria-disabled") === "true");
            const readonly = Boolean(el.readOnly || el.getAttribute("aria-readonly") === "true");
            const required = Boolean(el.required || el.getAttribute("aria-required") === "true");
            const focused = doc.activeElement === el;

            const interactiveState: {
              disabled: boolean;
              checked?: boolean;
              expanded?: boolean;
              readonly: boolean;
              required: boolean;
              focused: boolean;
              editable: boolean;
            } = {
              disabled,
              readonly,
              required,
              focused,
              editable: isEditableTag && !disabled && !readonly,
              ...(typeof el.checked === "boolean" && (inputType === "checkbox" || inputType === "radio")
                ? { checked: el.checked }
                : ariaChecked === "true" || ariaChecked === "false"
                ? { checked: ariaChecked === "true" }
                : {}),
              ...(ariaExpanded === "true" || ariaExpanded === "false"
                ? { expanded: ariaExpanded === "true" }
                : {}),
            };

            const bounds = {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.max(0, Math.round(rect.width)),
              height: Math.max(0, Math.round(rect.height)),
              viewportWidth: vpWidth,
              viewportHeight: vpHeight,
            };

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
              bounds: typeof bounds;
              interactiveState: typeof interactiveState;
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
              bounds,
              interactiveState,
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
        {
          snapId: snapshotId,
          sessId: this.#sessionId,
          fallbackW: this.#viewport.width,
          fallbackH: this.#viewport.height,
        }
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
        bounds: raw.bounds,
        interactiveState: raw.interactiveState,
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

    const capturedAt = Date.now();
    const snapshot: AccessibilitySnapshot = {
      snapshotId,
      url,
      title,
      tree: treeText,
      elements,
      elementCount: elements.length,
      truncated,
      bytes,
      capturedAt,
      viewport: { ...this.#viewport },
    };
    this.#latestSnapshot = snapshot;

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

      if (this.#activePage) {
        try {
          const updatedUrl = redactSensitiveText(this.#activePage.url());
          const updatedTitle = redactSensitiveText(await this.#activePage.title());
          if (updatedUrl && updatedUrl !== this.#currentUrl) {
            this.#currentUrl = updatedUrl;
            this.#activeSnapshotId = undefined;
            this.#elementRefs.clear();
          }
          this.#currentTitle = updatedTitle;
        } catch {
          // Safe post-click URL/title probe
        }
      }

      this.#emit("action_approved", { tool: "browser_click", refId, target: element.name });
      return { success: true, target: element };
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        this.#emit("cancellation", { tool: "browser_click", refId });
        throw new DOMException("Click cancelled", "AbortError");
      }
      const cleanErr = redactSensitiveText(err?.message || String(err));
      if (err?.name === "TimeoutError" || /timeout\s+\d+ms\s+exceeded/i.test(cleanErr)) {
        this.#emit("timeout", { action: "browser_click", refId, error: cleanErr });
      }
      if (err instanceof BrowserSessionError) {
        throw err;
      }
      throw new BrowserSessionError(
        "CLICK_FAILED",
        `Failed to click element "${refId}": ${cleanErr}`,
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

      this.#emit("action_approved", { tool: "browser_fill", refId, target: element.name });
      return { success: true, target: element };
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        this.#emit("cancellation", { tool: "browser_fill", refId });
        throw new DOMException("Fill cancelled", "AbortError");
      }
      const cleanErr = redactSensitiveText(err?.message || String(err));
      if (err?.name === "TimeoutError" || /timeout\s+\d+ms\s+exceeded/i.test(cleanErr)) {
        this.#emit("timeout", { action: "browser_fill", refId, error: cleanErr });
      }
      if (err instanceof BrowserSessionError) {
        throw err;
      }
      throw new BrowserSessionError(
        "FILL_FAILED",
        `Failed to fill field "${refId}": ${cleanErr}`,
        { cause: err }
      );
    }
  }

  public async screenshot(
    options?: BrowserScreenshotOptions,
    signal?: AbortSignal
  ): Promise<BrowserScreenshotResult> {
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

    let resolvedOutputPath: string | undefined;
    if (options?.outputPath) {
      resolvedOutputPath = path.resolve(options.outputPath);
      const resolvedWorkspace = path.resolve(this.#config.workspaceRoot);
      if (
        !options.allowWorkspaceExport &&
        (resolvedOutputPath === resolvedWorkspace ||
          resolvedOutputPath.startsWith(resolvedWorkspace + path.sep))
      ) {
        throw new BrowserSessionError(
          "UNSAFE_ARTIFACT_PATH",
          "Browser screenshot artifacts must not be written inside the workspace repository unless explicitly exported."
        );
      }
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

    const maxHeightPx = Math.max(240, Math.min(options?.maxHeightPx ?? 4096, 8192));
    const maxBytes = Math.max(65536, Math.min(options?.maxBytes ?? 6 * 1024 * 1024, 16 * 1024 * 1024));

    let buffer: Buffer;
    let abortListener: (() => void) | undefined;
    try {
      let clip: { x: number; y: number; width: number; height: number } | undefined;
      if (options?.fullPage) {
        try {
          const docDim = await this.#activePage.evaluate(() => {
            const doc = (globalThis as any).document;
            const win = (globalThis as any).window;
            return {
              width: Math.max(win?.innerWidth || 0, doc?.documentElement?.scrollWidth || 0),
              height: Math.max(win?.innerHeight || 0, doc?.documentElement?.scrollHeight || 0),
            };
          });
          if (docDim.height > maxHeightPx && docDim.width > 0) {
            clip = {
              x: 0,
              y: 0,
              width: Math.min(docDim.width, 3840),
              height: maxHeightPx,
            };
          }
        } catch {
          // Proceed with standard Playwright screenshot
        }
      }

      const shotPromise = this.#activePage.screenshot({
        fullPage: clip ? false : (options?.fullPage ?? false),
        ...(clip ? { clip } : {}),
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
    if (bytes > maxBytes) {
      throw new BrowserSessionError(
        "SCREENSHOT_TOO_LARGE",
        `Captured screenshot (${bytes} bytes) exceeds maximum allowed preview budget (${maxBytes} bytes).`
      );
    }

    // Parse PNG IHDR width & height (bytes 16..24 of a valid PNG file)
    let width = this.#viewport.width;
    let height = this.#viewport.height;
    if (
      buffer.length >= 24 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    }

    if (resolvedOutputPath) {
      const parentDir = path.dirname(resolvedOutputPath);
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(resolvedOutputPath, buffer, { mode: 0o600 });
    }

    const capturedAt = Date.now();
    let url = this.#currentUrl;
    let pageTitle = this.#currentTitle;
    try {
      url = redactSensitiveText(this.#activePage.url());
      pageTitle = redactSensitiveText(await this.#activePage.title());
      this.#currentUrl = url;
      this.#currentTitle = pageTitle;
    } catch {
      // Safe fallback to cached url/title
    }

    const base64 =
      !options?.omitBase64 && bytes <= 524288 ? buffer.toString("base64") : undefined;

    // Never log raw screenshot bytes in event stream
    this.#emit("screenshot_taken", {
      bytes,
      width,
      height,
      mimeType: "image/png",
      fullPage: options?.fullPage ?? false,
      maskedSensitiveFields: maskedCount,
      url,
      ...(this.#activeSnapshotId ? { snapshotId: this.#activeSnapshotId } : {}),
    });

    return {
      bytes,
      mimeType: "image/png",
      width,
      height,
      capturedAt,
      url,
      pageTitle,
      viewport: { ...this.#viewport },
      ...(this.#activeSnapshotId ? { snapshotId: this.#activeSnapshotId } : {}),
      maskedSensitiveFields: maskedCount,
      ...(resolvedOutputPath ? { filePath: resolvedOutputPath } : {}),
      ...(base64 !== undefined ? { base64 } : {}),
    };
  }

  /**
   * Sprint 9C Design Observation preparation: read-only computed typography, spacing, and layout
   * metadata for an inspected element tied to the current fresh snapshot and viewport.
   */
  public async inspectElementDesign(
    refId: string,
    signal?: AbortSignal
  ): Promise<ElementDesignMetadata> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (signal?.aborted) {
      throw new DOMException("Design inspection cancelled", "AbortError");
    }
    if (
      !this.#activePage ||
      this.#unexpectedlyClosed ||
      (typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }
    if (!this.#activeSnapshotId) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        "[STALE_ELEMENT_REFERENCE] Snapshot is stale or missing. Refresh observation before inspecting design metadata."
      );
    }
    const element = this.#elementRefs.get(refId);
    if (!element || element.snapshotId !== this.#activeSnapshotId) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Element "${refId}" does not belong to the active snapshot.`
      );
    }

    const activeSnapshotId = this.#activeSnapshotId;
    const rawMeta = await this.#activePage.evaluate(
      (args: { sessId: string; snapId: string; ref: string; fallbackW: number; fallbackH: number }) => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const selector = `[data-ovsc-session="${args.sessId}"][data-ovsc-snap="${args.snapId}"][data-ovsc-ref="${args.ref}"]`;
        const matches = doc.querySelectorAll(selector);
        if (matches.length !== 1) {
          return null;
        }
        const el = matches[0] as any;
        const style = win.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
            viewportWidth: Math.round(Number(win.innerWidth) || args.fallbackW),
            viewportHeight: Math.round(Number(win.innerHeight) || args.fallbackH),
          },
          typography: {
            fontFamily: String(style.fontFamily || "").slice(0, 120),
            fontSize: String(style.fontSize || ""),
            fontWeight: String(style.fontWeight || ""),
            lineHeight: String(style.lineHeight || ""),
            letterSpacing: String(style.letterSpacing || ""),
            color: String(style.color || ""),
            textAlign: String(style.textAlign || ""),
          },
          spacing: {
            marginTop: String(style.marginTop || ""),
            marginRight: String(style.marginRight || ""),
            marginBottom: String(style.marginBottom || ""),
            marginLeft: String(style.marginLeft || ""),
            paddingTop: String(style.paddingTop || ""),
            paddingRight: String(style.paddingRight || ""),
            paddingBottom: String(style.paddingBottom || ""),
            paddingLeft: String(style.paddingLeft || ""),
            gap: String(style.gap || ""),
          },
          layout: {
            display: String(style.display || ""),
            position: String(style.position || ""),
            ...(style.display.includes("flex")
              ? {
                  flexDirection: String(style.flexDirection || ""),
                  alignItems: String(style.alignItems || ""),
                  justifyContent: String(style.justifyContent || ""),
                }
              : {}),
            ...(style.display.includes("grid")
              ? {
                  gridTemplateColumns: String(style.gridTemplateColumns || "").slice(0, 120),
                }
              : {}),
            backgroundColor: String(style.backgroundColor || ""),
            borderRadius: String(style.borderRadius || ""),
            opacity: String(style.opacity || ""),
            overflow: String(style.overflow || ""),
          },
        };
      },
      {
        sessId: this.#sessionId,
        snapId: activeSnapshotId,
        ref: refId,
        fallbackW: this.#viewport.width,
        fallbackH: this.#viewport.height,
      }
    );

    if (!rawMeta) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Element "${refId}" is no longer uniquely bound in the live DOM.`
      );
    }

    const url = sanitizeBrowserUrl(this.#activePage.url());
    return {
      sessionId: this.#sessionId,
      snapshotId: activeSnapshotId,
      refId,
      url,
      viewport: { ...this.#viewport },
      presetId: resolveViewportPresetId(this.#viewport),
      capturedAt: Date.now(),
      role: element.role,
      tag: element.tag,
      accessibleName: element.name,
      bounds: rawMeta.bounds,
      typography: rawMeta.typography,
      spacing: rawMeta.spacing,
      layout: rawMeta.layout,
    };
  }

  /**
   * Sprint 9C Motion Observation preparation: collects declared CSS animation/transition metadata
   * while explicitly forbidding motion-quality claims from static screenshots or declaration probes.
   */
  public async observeAnimations(signal?: AbortSignal): Promise<AnimationObservation> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (signal?.aborted) {
      throw new DOMException("Animation observation cancelled", "AbortError");
    }
    if (
      !this.#activePage ||
      this.#unexpectedlyClosed ||
      (typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    const probe = await this.#activePage.evaluate(() => {
      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;
      const reducedMotion = Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
      const nodes = Array.from(doc?.querySelectorAll?.("*") || []).slice(0, 600);
      const samples: {
        tag: string;
        role: string;
        accessibleName: string;
        animationName: string;
        animationDuration: string;
        transitionProperty: string;
        transitionDuration: string;
        prefersReducedMotionActive: boolean;
      }[] = [];
      let total = 0;

      for (const raw of nodes as any[]) {
        const style = win.getComputedStyle(raw);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const animName = String(style.animationName || "none");
        const animDur = String(style.animationDuration || "0s");
        const transDur = String(style.transitionDuration || "0s");
        const transProp = String(style.transitionProperty || "none");
        const hasAnim = animName !== "none" && animDur !== "0s";
        const hasTrans =
          transProp !== "none" &&
          transDur
            .split(",")
            .some((part: string) => parseFloat(part.trim()) > 0);
        if (!hasAnim && !hasTrans) continue;
        total += 1;
        if (samples.length < 20) {
          const tag = String(raw.tagName || "").toLowerCase();
          const role = String(raw.getAttribute?.("role") || tag);
          const name = String(
            raw.getAttribute?.("aria-label") || raw.getAttribute?.("title") || raw.id || ""
          ).slice(0, 80);
          samples.push({
            tag,
            role,
            accessibleName: name,
            animationName: animName.slice(0, 80),
            animationDuration: animDur.slice(0, 40),
            transitionProperty: transProp.slice(0, 80),
            transitionDuration: transDur.slice(0, 40),
            prefersReducedMotionActive: reducedMotion,
          });
        }
      }
      return { reducedMotion, total, samples };
    });

    const sanitizedSamples = probe.samples.map((s) => ({
      ...s,
      accessibleName: redactSensitiveText(s.accessibleName),
    }));

    return {
      sessionId: this.#sessionId,
      url: sanitizeBrowserUrl(this.#activePage.url()),
      viewport: { ...this.#viewport },
      capturedAt: Date.now(),
      evidenceKind: "static_css_declaration_probe",
      prefersReducedMotion: probe.reducedMotion,
      animatedElementCount: probe.total,
      samples: sanitizedSamples,
      motionQualityClaimAllowed: false,
      limitationNotice:
        "Static screenshot preview and CSS declaration probe only; frame-rate, easing smoothness, and runtime motion quality cannot be claimed from static captures.",
    };
  }

  /**
   * Sprint 9C Real Measured Motion: executes temporal frame sampling (rAF) and animation
   * introspection inside the active Chromium page, then runs evaluateMotionObservations.
   */
  public async measureMotion(options?: {
    durationMs?: number;
    signal?: AbortSignal;
  }): Promise<MeasuredMotionObservation> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (options?.signal?.aborted) {
      throw new DOMException("Motion measurement cancelled", "AbortError");
    }
    if (
      !this.#activePage ||
      this.#unexpectedlyClosed ||
      (typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    const duration = Math.max(200, Math.min(options?.durationMs ?? 600, 1500));

    const rawData = await this.#activePage.evaluate((sampleDuration: number) => {
      return new Promise<{
        reducedMotion: boolean;
        frameTimings: { frameIndex: number; timestampMs: number; deltaMs: number }[];
        activeAnimations: {
          elementTag: string;
          elementRole: string;
          accessibleName: string;
          animationName: string;
          propertyName: string;
          durationMs: number;
          easing: string;
          isComposited: boolean;
          causesLayoutShift: boolean;
        }[];
        layoutShifts: { value: number; timestampMs: number }[];
      }>((resolve) => {
        // Define __name helper in page context in case of transpiled helper references
        const g = globalThis as any;
        if (typeof g["__name"] === "undefined") {
          g["__name"] = (f: any) => f;
        }
        const win = (globalThis as any).window;
        const doc = (globalThis as any).document;
        const reducedMotion = Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

        const frameTimings: { frameIndex: number; timestampMs: number; deltaMs: number }[] = [];
        const layoutShifts: { value: number; timestampMs: number }[] = [];

        let observer: any;
        try {
          if (typeof win.PerformanceObserver !== "undefined") {
            observer = new win.PerformanceObserver((list: any) => {
              for (const entry of list.getEntries()) {
                if (entry.entryType === "layout-shift" && !entry.hadRecentInput) {
                  layoutShifts.push({ value: entry.value, timestampMs: entry.startTime });
                }
              }
            });
            observer.observe({ type: "layout-shift", buffered: true });
          }
        } catch {
          // ignore if layout-shift observer is unsupported
        }

        let origin = 0;
        let lastTime = 0;
        let frameCount = 0;
        let started = false;
        // Discard the frames spent compiling the animation. They are not part of
        // the steady compositor rate the sample is supposed to measure.
        let warmupFrames = 4;

        const recordFrame = (now: number) => {
          if (warmupFrames > 0) {
            warmupFrames -= 1;
            win.requestAnimationFrame(recordFrame);
            return;
          }
          // The wait for the first frame is not an animation interval. Starting
          // the sample clock here keeps a delayed first rAF from consuming the
          // requested duration and under-counting a smooth animation.
          if (!started) {
            started = true;
            origin = now;
            lastTime = now;
            frameTimings.push({ frameIndex: frameCount++, timestampMs: 0, deltaMs: 0 });
            win.requestAnimationFrame(recordFrame);
            return;
          }
          const delta = now - lastTime;
          lastTime = now;
          frameTimings.push({
            frameIndex: frameCount++,
            timestampMs: Math.round(now - origin),
            deltaMs: Math.round(delta * 10) / 10,
          });

          if (now - origin < sampleDuration && frameCount < 90) {
            win.requestAnimationFrame(recordFrame);
          } else {
            try {
              observer?.disconnect();
            } catch {}

            // Inspect active animations via Web Animations API and CSS
            const activeAnimations: any[] = [];
            try {
              if (typeof doc.getAnimations === "function") {
                const anims = doc.getAnimations().slice(0, 30);
                const metaKeys = ["offset", "computedOffset", "easing", "composite"];
                for (const a of anims) {
                  const target = a.effect?.target;
                  if (target) {
                    const tag = String(target.tagName || "").toLowerCase();
                    const name = String(target.getAttribute?.("aria-label") || target.id || tag);
                    const animTiming = a.effect?.getComputedTiming?.() || {};
                    const keyframes = a.effect?.getKeyframes?.() || [];
                    const foundProps: string[] = [];
                    for (const kf of keyframes) {
                      for (const k of Object.keys(kf)) {
                        if (!metaKeys.includes(k) && !foundProps.includes(k)) {
                          foundProps.push(k);
                        }
                      }
                    }
                    const propList = foundProps.length > 0 ? foundProps : ["transform"];
                    for (const prop of propList) {
                      activeAnimations.push({
                        elementTag: tag,
                        elementRole: String(target.getAttribute?.("role") || tag),
                        accessibleName: name,
                        animationName: a.animationName || a.id || "web-animation",
                        propertyName: prop,
                        durationMs: typeof animTiming.duration === "number" ? animTiming.duration : 300,
                        easing: String(animTiming.easing || "ease"),
                        isComposited: prop === "transform" || prop === "opacity",
                        causesLayoutShift:
                          prop.includes("width") ||
                          prop.includes("height") ||
                          prop.includes("top") ||
                          prop.includes("left"),
                      });
                    }
                  }
                }
              }
            } catch {}

            // Fallback to inspecting elements with computed animations/transitions
            if (activeAnimations.length === 0) {
              const nodes = Array.from(doc?.querySelectorAll?.("*") || []).slice(0, 300);
              for (const node of nodes as any[]) {
                const s = win.getComputedStyle(node);
                const hasAnim = s.animationName && s.animationName !== "none";
                const hasTrans =
                  s.transitionProperty &&
                  s.transitionProperty !== "none" &&
                  parseFloat(s.transitionDuration || "0") > 0;
                if (hasAnim || hasTrans) {
                  const tag = String(node.tagName || "").toLowerCase();
                  const name = String(node.getAttribute?.("aria-label") || node.id || tag);
                  const prop = hasTrans ? String(s.transitionProperty) : "transform";
                  activeAnimations.push({
                    elementTag: tag,
                    elementRole: String(node.getAttribute?.("role") || tag),
                    accessibleName: name,
                    animationName: hasAnim ? String(s.animationName) : "transition",
                    propertyName: prop,
                    durationMs: parseFloat(s.transitionDuration || s.animationDuration || "0.3") * 1000,
                    easing: String(s.transitionTimingFunction || s.animationTimingFunction || "ease"),
                    isComposited: prop === "transform" || prop === "opacity",
                    causesLayoutShift:
                      prop.includes("width") ||
                      prop.includes("height") ||
                      prop.includes("top") ||
                      prop.includes("left"),
                  });
                  if (activeAnimations.length >= 20) break;
                }
              }
            }

            resolve({
              reducedMotion,
              frameTimings,
              activeAnimations,
              layoutShifts,
            });
          }
        };

        win.requestAnimationFrame(recordFrame);
      });
    }, duration);

    return evaluateMotionObservations({
      sessionId: this.#sessionId,
      url: sanitizeBrowserUrl(this.#activePage.url()),
      viewport: { ...this.#viewport },
      prefersReducedMotion: rawData.reducedMotion,
      frameTimings: rawData.frameTimings,
      animations: rawData.activeAnimations,
      layoutShifts: rawData.layoutShifts,
    });
  }

  /**
   * Sprint 9C.1 — Bounded Read-Only Visual QA State Observation.
   * Extracts real computed styles, effective backgrounds, overflow metrics, visible bounds,
   * focus indicators, and console errors without exposing arbitrary page.evaluate to the model.
   */
  public async observeVisualQaState(options?: {
    signal?: AbortSignal;
  }): Promise<ObservedVisualQaState> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (options?.signal?.aborted) {
      throw new DOMException("Visual QA observation cancelled", "AbortError");
    }
    if (
      !this.#activePage ||
      this.#unexpectedlyClosed ||
      (typeof this.#activePage.isClosed === "function" && this.#activePage.isClosed())
    ) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    const raw = await this.#activePage.evaluate(() => {
      const g = globalThis as any;
      if (typeof g["__name"] === "undefined") {
        g["__name"] = (f: any) => f;
      }
      const win = (globalThis as any).window;
      const doc = (globalThis as any).document;

      const scrollWidth = Math.max(doc.documentElement.scrollWidth || 0, doc.body ? doc.body.scrollWidth : 0);
      const clientWidth = doc.documentElement.clientWidth || win.innerWidth || 0;
      const scrollHeight = Math.max(doc.documentElement.scrollHeight || 0, doc.body ? doc.body.scrollHeight : 0);
      const clientHeight = doc.documentElement.clientHeight || win.innerHeight || 0;

      const candidateNodes = Array.from(
        doc.querySelectorAll(
          "body, header, nav, main, article, section, footer, div, p, h1, h2, h3, h4, h5, h6, button, a, input, select, textarea, img, span, strong, em"
        ) || []
      ).slice(0, 300);

      const resolveEffectiveBg = (el: any): { color: string; opacity: number } => {
        let curr: any = el;
        let combinedOpacity = 1;
        while (curr && curr !== doc.documentElement) {
          const s = win.getComputedStyle(curr);
          const op = parseFloat(s.opacity || "1");
          if (!isNaN(op)) combinedOpacity *= op;
          const bg = s.backgroundColor;
          if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {
            return { color: bg, opacity: combinedOpacity };
          }
          curr = curr.parentElement;
        }
        const rootStyle = win.getComputedStyle(doc.documentElement);
        if (rootStyle.backgroundColor && rootStyle.backgroundColor !== "transparent" && rootStyle.backgroundColor !== "rgba(0, 0, 0, 0)") {
          return { color: rootStyle.backgroundColor, opacity: combinedOpacity };
        }
        const bodyStyle = doc.body ? win.getComputedStyle(doc.body) : null;
        if (bodyStyle?.backgroundColor && bodyStyle.backgroundColor !== "transparent" && bodyStyle.backgroundColor !== "rgba(0, 0, 0, 0)") {
          return { color: bodyStyle.backgroundColor, opacity: combinedOpacity };
        }
        return { color: "rgb(255, 255, 255)", opacity: combinedOpacity };
      };

      const elements: any[] = [];
      let seq = 0;
      for (const node of candidateNodes as any[]) {
        const s = win.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 && s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity || "1") > 0;
        if (!isVisible) continue;

        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute("role") || "";
        const isInteractive =
          tag === "button" ||
          tag === "a" ||
          tag === "input" ||
          tag === "select" ||
          tag === "textarea" ||
          node.hasAttribute("tabindex") ||
          role === "button" ||
          role === "link";
        const textContent = (node.textContent || "").trim().slice(0, 200);
        const accessibleName = (node.getAttribute("aria-label") || (node as any).alt || (tag === "img" ? "" : textContent)).slice(0, 100);

        const effectiveBg = resolveEffectiveBg(node);

        elements.push({
          refId: `vqa-${++seq}`,
          tag,
          role,
          accessibleName,
          textContent,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          isVisible: true,
          isInteractive,
          computedStyle: {
            color: s.color,
            backgroundColor: s.backgroundColor,
            effectiveBackgroundColor: effectiveBg.color,
            opacity: s.opacity,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            lineHeight: s.lineHeight,
            fontFamily: s.fontFamily,
            display: s.display,
            position: s.position,
            overflow: s.overflow,
            outlineStyle: s.outlineStyle,
            outlineWidth: s.outlineWidth,
            outlineColor: s.outlineColor,
          },
          hasFocusVisibleStyle: s.outlineStyle !== "none" && s.outlineWidth !== "0px",
          focusBehavior: isInteractive ? (s.outlineStyle === "none" && s.outlineWidth === "0px" ? "outline_suppressed" : "standard") : undefined,
        });
      }

      return {
        scrollWidth,
        clientWidth,
        scrollHeight,
        clientHeight,
        elements,
      };
    });

    const consoleErrors = this.#consoleBuffer
      .filter((e) => e.type === "error")
      .map((e) => e.text);

    const vp = { ...this.#viewport };

    return {
      targetUrl: sanitizeBrowserUrl(this.#activePage.url()),
      viewport: vp,
      presetId: resolveViewportPresetId(vp),
      clientWidth: raw.clientWidth,
      scrollWidth: raw.scrollWidth,
      clientHeight: raw.clientHeight,
      scrollHeight: raw.scrollHeight,
      elements: raw.elements,
      consoleErrors,
      capturedAt: Date.now(),
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
    this.#latestSnapshot = undefined;
    this.#currentUrl = "";
    this.#currentTitle = "";
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
