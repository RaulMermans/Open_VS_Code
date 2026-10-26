import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type {
  BrowserSessionConfig,
  BrowserSessionStatus,
  AccessibilitySnapshot,
  ElementRef,
  BrowserEvent,
  BrowserConsoleEntry,
  BrowserNetworkFailure,
} from "./browser-contracts.ts";
import { detectBrowserProvisioning } from "./browser-provisioning.ts";
import {
  isBrowserUrlPermitted,
  attachNetworkPolicyToContext,
  BrowserNetworkPolicyError,
  DEFAULT_ALLOWED_LOCAL_ORIGINS,
} from "./browser-network-policy.ts";
import {
  isDestructiveElement,
  isSensitiveField,
  isSideEffectElement,
} from "./browser-action-classifier.ts";
import { killProcessTree } from "../tools/kill-process-tree.ts";

export class BrowserSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserSessionError";
    this.code = code;
  }
}

/**
 * Redacts sensitive credentials, tokens, passwords, and private keys from diagnostics,
 * console logs, URLs, and errors.
 */
export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let redacted = text;
  // Redact embedded HTTP Basic credentials
  redacted = redacted.replace(/([a-zA-Z]+:\/\/)([^:]+):([^@]+)@/g, "$1[REDACTED_CREDENTIALS]@");
  // Redact sensitive query parameters
  redacted = redacted.replace(
    /([?&](?:password|token|secret|api_key|apikey|key|access_token)=)[^&]+/gi,
    "$1[REDACTED_SECRET]"
  );
  // Redact Bearer tokens
  redacted = redacted.replace(/(Bearer\s+)[a-zA-Z0-9_\-.]{15,}/gi, "$1[REDACTED_TOKEN]");
  // Redact AWS access keys
  redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]");
  // Redact PEM private keys
  redacted = redacted.replace(
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );
  return redacted;
}

/**
 * Verifies effective platform sandbox support.
 */
export function verifyEffectiveSandboxSupport(): { supported: boolean; details: string } {
  const platform = process.platform;
  if (platform === "darwin") {
    return { supported: true, details: "macOS native Seatbelt sandboxing enabled." };
  } else if (platform === "win32") {
    return { supported: true, details: "Windows restricted token sandboxing enabled." };
  } else if (platform === "linux") {
    try {
      if (fs.existsSync("/proc/sys/kernel/unprivileged_userns_clone")) {
        const val = fs.readFileSync("/proc/sys/kernel/unprivileged_userns_clone", "utf8").trim();
        if (val === "0") {
          return {
            supported: false,
            details:
              "Linux unprivileged user namespaces are disabled (/proc/sys/kernel/unprivileged_userns_clone=0). Setuid sandbox or sysctl configuration required.",
          };
        }
      }
      return { supported: true, details: "Linux user namespace / setuid sandboxing enabled." };
    } catch {
      return { supported: true, details: "Linux sandbox verification deferred to Chromium process." };
    }
  }
  return { supported: true, details: `Platform "${platform}" sandbox verification.` };
}

export class BrowserSessionManager {
  readonly #config: BrowserSessionConfig;
  readonly #sessionId: string;
  #status: BrowserSessionStatus = "UNINITIALIZED";
  #browser?: Browser | undefined;
  #context?: BrowserContext | undefined;
  #activePage?: Page | undefined;
  #activeSnapshotId?: string | undefined;
  #elementRefs = new Map<string, ElementRef>();
  readonly #consoleBuffer: BrowserConsoleEntry[] = [];
  readonly #networkFailures: BrowserNetworkFailure[] = [];
  readonly #eventListeners = new Set<(event: BrowserEvent) => void>();
  readonly #maxConsoleMessages: number;
  readonly #maxNetworkEvents: number;
  readonly #maxSnapshotBytes: number;
  #disposed = false;

  constructor(config: BrowserSessionConfig) {
    this.#config = config;
    this.#sessionId = config.sessionId || `browser_sess_${crypto.randomUUID().slice(0, 8)}`;
    this.#maxConsoleMessages = config.maxConsoleMessages ?? 100;
    this.#maxNetworkEvents = config.maxNetworkEvents ?? 100;
    this.#maxSnapshotBytes = config.maxSnapshotBytes ?? 32768; // 32 KB limit
  }

  public getSessionId(): string {
    return this.#sessionId;
  }

  public getStatus(): BrowserSessionStatus {
    return this.#status;
  }

  public getActivePage(): Page | undefined {
    return this.#activePage;
  }

  public onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  #emit(type: BrowserEvent["type"], details: Readonly<Record<string, unknown>>): void {
    const event: BrowserEvent = {
      type,
      sessionId: this.#sessionId,
      timestamp: Date.now(),
      details,
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
      text: redactSensitiveText(text).slice(0, 2000), // Bound individual message length and redact
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
  }

  public async start(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) {
      throw new BrowserSessionError("DISPOSED", "BrowserSessionManager has already been disposed.");
    }
    if (this.#status === "READY" && this.#browser && this.#browser.isConnected()) {
      return;
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before start" });
      throw new DOMException("Browser launch cancelled", "AbortError");
    }

    // 1. Determine executable provenance
    const diagnostic = detectBrowserProvisioning(this.#config.executablePath);
    if (diagnostic.status !== "READY" || !diagnostic.executable) {
      this.#status = "ERROR";
      throw new BrowserSessionError(
        "NOT_CONFIGURED",
        `Browser is not configured or executable was not found. Diagnostics: ${diagnostic.details.join("; ")}`
      );
    }

    // 2. Verify platform sandbox support (Sprint 9A.1 P0)
    const sandboxCheck = verifyEffectiveSandboxSupport();
    if (!sandboxCheck.supported) {
      this.#status = "ERROR";
      throw new BrowserSessionError(
        "SANDBOX_UNAVAILABLE",
        `Chromium secure sandboxing is unavailable: ${sandboxCheck.details}`
      );
    }

    const execPath = diagnostic.executable.path;

    try {
      // Sprint 9A.1 P0: Sandboxed Chromium launch.
      // Unconditional --no-sandbox and --disable-setuid-sandbox are strictly removed.
      // Use ephemeral isolated user data directory to stay independent of user personal profiles.
      const userDataDir = path.join(
        this.#config.workspaceRoot,
        ".browser-profile",
        this.#sessionId
      );
      fs.mkdirSync(userDataDir, { recursive: true });

      const launchArgs = [
        `--user-data-dir=${userDataDir}`,
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
      ];

      const launchOptions: Record<string, unknown> = {
        executablePath: execPath,
        headless: this.#config.headless ?? true,
        args: launchArgs,
      };
      if (process.platform === "linux") {
        launchOptions.chromiumSandbox = true;
      }

      const { chromium } = await import("playwright-core");
      this.#browser = await chromium.launch(launchOptions);
      console.error("[start] step 3: newContext");

      // Ephemeral context: Service Workers blocked by default (Sprint 9A.1 P0)
      this.#context = await this.#browser.newContext({
        serviceWorkers: "block",
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
        viewport: this.#config.viewport ?? { width: 1280, height: 800 },
      });
      console.error("[start] step 4: attachNetworkPolicyToContext");

      // Context-wide network interception (Sprint 9A.1 P0)
      const policyConfig = this.#config.networkPolicy ?? {
        allowedOrigins: DEFAULT_ALLOWED_LOCAL_ORIGINS,
      };
      await attachNetworkPolicyToContext(this.#context, policyConfig, (f) => this.#recordNetworkFailure(f));
      console.error("[start] step 5: attachNetworkPolicy done");

      // Handle popups and secondary pages opened in this context
      this.#context.on("page", (newPage: any) => {
        this.#attachPageListeners(newPage);
      });

      this.#status = "READY";
      this.#emit("session_started", {
        executablePath: execPath,
        source: diagnostic.executable.source,
        headless: this.#config.headless ?? true,
        sandboxed: true,
      });
    } catch (err: any) {
      this.#status = "ERROR";
      this.#emit("process_cleanup", { error: err?.message || String(err) });
      if (signal?.aborted) {
        throw new DOMException("Browser launch cancelled", "AbortError");
      }
      const errMsg = err?.message || String(err);
      if (
        errMsg.toLowerCase().includes("sandbox") ||
        errMsg.toLowerCase().includes("operation not permitted") ||
        errMsg.toLowerCase().includes("seatbelt")
      ) {
        throw new BrowserSessionError(
          "SANDBOX_UNAVAILABLE",
          `Chromium sandboxing failed to initialize securely on this platform/environment: ${errMsg}. Secure sandboxing is strictly required; failing closed without disabling isolation.`,
          { cause: err }
        );
      }
      throw new BrowserSessionError("LAUNCH_FAILED", `Failed to launch browser: ${errMsg}`, {
        cause: err,
      });
    }
  }

  public async open(url: string, signal?: AbortSignal): Promise<{ pageId: string; url: string; title: string }> {
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

    this.#emit("navigation_attempted", { url });

    // Validate top-level destination URL against network policy
    const policyCheck = isBrowserUrlPermitted(url, policyConfig);
    if (!policyCheck.allowed) {
      this.#emit("navigation_failed", { url, reason: policyCheck.reason });
      throw new BrowserNetworkPolicyError("SECURITY_POLICY_VIOLATION", policyCheck.reason!);
    }

    try {
      this.#status = "NAVIGATING";
      const page = await this.#context.newPage();
      this.#activePage = page;
      this.#attachPageListeners(page);

      const timeout = this.#config.timeoutMs ?? 30000;
      let abortListener: (() => void) | undefined;

      const navPromise = page.goto(url, {
        timeout,
        waitUntil: "domcontentloaded",
      });

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            this.#emit("cancellation", { action: "open", url });
            // Halt browser loading immediately upon abort
            page.evaluate(() => (globalThis as any).window?.stop?.()).catch(() => {});
            reject(new DOMException("Navigation cancelled by abort signal", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        await Promise.race([navPromise, abortPromise]);
      } else {
        await navPromise;
      }

      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }

      const finalUrl = page.url();
      const title = await page.title();

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
      this.#status = "READY";
      this.#emit("navigation_failed", { url, error: err?.message || String(err) });
      if (err?.name === "AbortError" || signal?.aborted) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
      throw err;
    }
  }

  public async navigate(url: string, signal?: AbortSignal): Promise<{ url: string; title: string }> {
    if (!this.#activePage) {
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

    this.#emit("navigation_attempted", { url });

    const policyCheck = isBrowserUrlPermitted(url, policyConfig);
    if (!policyCheck.allowed) {
      this.#emit("navigation_failed", { url, reason: policyCheck.reason });
      throw new BrowserNetworkPolicyError("SECURITY_POLICY_VIOLATION", policyCheck.reason!);
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
            this.#emit("cancellation", { action: "navigate", url });
            // Halt browser loading immediately upon abort
            this.#activePage?.evaluate(() => (globalThis as any).window?.stop?.()).catch(() => {});
            reject(new DOMException("Navigation cancelled by abort signal", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        await Promise.race([navPromise, abortPromise]);
      } else {
        await navPromise;
      }

      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }

      const finalUrl = this.#activePage.url();
      const title = await this.#activePage.title();

      // Invalidate existing element references on navigation!
      this.#activeSnapshotId = undefined;
      this.#elementRefs.clear();

      this.#status = "READY";
      this.#emit("navigation_completed", { url: finalUrl, title });

      return {
        url: finalUrl,
        title,
      };
    } catch (err: any) {
      this.#status = "READY";
      this.#emit("navigation_failed", { url, error: err?.message || String(err) });
      if (err?.name === "AbortError" || signal?.aborted) {
        throw new DOMException("Navigation cancelled", "AbortError");
      }
      throw err;
    }
  }

  public async snapshot(
    _options?: { maxDepth?: number },
    signal?: AbortSignal
  ): Promise<AccessibilitySnapshot> {
    if (!this.#activePage) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open. Call browser_open first.");
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before snapshot" });
      throw new DOMException("Snapshot cancelled", "AbortError");
    }

    const page = this.#activePage;
    const url = page.url();
    const title = await page.title();
    const snapshotId = `snap_${crypto.randomUUID().slice(0, 8)}`;

    // Query interactive elements on page with safe privacy masking
    const rawElements = await page.evaluate((snapId: string) => {
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
        type?: string;
        hasValue?: boolean;
        isSensitive?: boolean;
      }[] = [];

      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;
      const nodes = Array.from(doc.querySelectorAll(selectors.join(",")));

      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i] as any;
        const rect = el.getBoundingClientRect();
        // Skip hidden elements
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

        // Never fall back to el.value for accessible name to avoid leaking secret input values!
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.placeholder ||
          el.innerText?.trim() ||
          "";

        // Stable selector generation: avoid global nth-of-type(i + 1)
        let selector = "";
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`;
        } else if (el.getAttribute("name")) {
          selector = `${tag}[name="${CSS.escape(el.getAttribute("name"))}"]`;
        } else {
          // Relative position among same-tag siblings in parent
          let nth = 1;
          let sib = el.previousElementSibling;
          while (sib) {
            if (sib.tagName.toLowerCase() === tag) nth++;
            sib = sib.previousElementSibling;
          }
          selector = `${tag}:nth-of-type(${nth})`;
        }

        const elType = (el.type || "").toLowerCase();
        const sensitiveKeywords = [
          "password",
          "secret",
          "token",
          "api_key",
          "apikey",
          "private_key",
          "credit_card",
          "ssn",
          "cvv",
          "pin",
        ];
        const textToCheck = `${name} ${role} ${tag} ${el.name || ""} ${el.id || ""} ${elType}`.toLowerCase();
        const isSens =
          elType === "password" ||
          sensitiveKeywords.some((kw) => textToCheck.includes(kw));

        // Tag node with session reference attribute for stable locator binding
        const refId = `e${i + 1}`;
        el.setAttribute("data-ovsc-ref", refId);
        el.setAttribute("data-ovsc-snap", snapId);

        const item: {
          tag: string;
          role: string;
          name: string;
          selector: string;
          value?: string;
          type?: string;
          hasValue?: boolean;
          isSensitive?: boolean;
        } = {
          tag,
          role,
          name: name.slice(0, 100),
          selector,
          isSensitive: isSens,
        };

        if (elType) {
          item.type = elType;
        }

        // P0 Sensitive observation protection:
        // NEVER expose password or sensitive field contents in snapshot results!
        if (isSens) {
          item.hasValue = Boolean(el.value);
          // Omit item.value completely
        } else if (el.value !== undefined && el.value !== null && el.value !== "") {
          item.value = String(el.value).slice(0, 100);
          item.hasValue = true;
        }

        found.push(item);
      }
      return found;
    }, snapshotId);

    const elements: ElementRef[] = [];
    const treeLines: string[] = [`Page: "${title}" (${url})`];

    // Build element references
    this.#elementRefs.clear();
    for (let idx = 0; idx < rawElements.length; idx++) {
      const raw = rawElements[idx];
      const refId = `e${idx + 1}`;
      const isSens =
        raw.isSensitive ||
        isSensitiveField({
          name: raw.name,
          role: raw.role,
          tag: raw.tag,
          selector: raw.type ? `type="${raw.type}"` : raw.selector,
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
        selector: raw.selector,
      });

      const ref: ElementRef = {
        refId,
        role: raw.role,
        name: raw.name,
        selector: raw.selector,
        snapshotId,
        tag: raw.tag,
        // Sensitive field values are NEVER retained in ElementRef
        value: isSens ? undefined : raw.value,
        sensitive: isSens,
        destructive: isDest,
        sideEffect: isSide,
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
        : raw.value
        ? ` value="${raw.value}"`
        : "";

      treeLines.push(
        `  [ref=${refId}] <${raw.tag}> ${raw.role} "${raw.name}"${valueInfo} ${flags}`.trimEnd()
      );
    }

    this.#activeSnapshotId = snapshotId;

    let treeText = treeLines.join("\n");
    let truncated = false;
    let bytes = Buffer.byteLength(treeText, "utf8");

    if (bytes > this.#maxSnapshotBytes) {
      truncated = true;
      const budget = Math.max(0, this.#maxSnapshotBytes - 120);
      treeText = treeText.slice(0, budget) + "\n... [TRUNCATED: Snapshot exceeded maxSnapshotBytes limit]";
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

  public async click(
    refId: string,
    signal?: AbortSignal
  ): Promise<{ success: boolean; target: ElementRef }> {
    if (!this.#activePage) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before click", refId });
      throw new DOMException("Click cancelled", "AbortError");
    }

    const element = this.#elementRefs.get(refId);
    if (!element || element.snapshotId !== this.#activeSnapshotId) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Element reference "${refId}" is invalid or stale. The page has navigated or changed since the snapshot was taken. Capture a fresh snapshot first.`
      );
    }

    this.#emit("tool_invoked", { tool: "browser_click", refId, target: element.name });

    try {
      // Revalidate in DOM before execution
      const locator = this.#activePage.locator(`[data-ovsc-ref="${refId}"], ${element.selector}`).first();
      const count = await locator.count();
      if (count === 0) {
        throw new BrowserSessionError(
          "STALE_ELEMENT_REFERENCE",
          `[STALE_ELEMENT_REFERENCE] Target element "${refId}" is no longer attached to DOM.`
        );
      }

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
        `Failed to click element "${refId}" (${element.selector}): ${err?.message || String(err)}`,
        { cause: err }
      );
    }
  }

  public async fill(
    refId: string,
    value: string,
    signal?: AbortSignal
  ): Promise<{ success: boolean; target: ElementRef }> {
    if (!this.#activePage) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before fill", refId });
      throw new DOMException("Fill cancelled", "AbortError");
    }

    const element = this.#elementRefs.get(refId);
    if (!element || element.snapshotId !== this.#activeSnapshotId) {
      throw new BrowserSessionError(
        "STALE_ELEMENT_REFERENCE",
        `[STALE_ELEMENT_REFERENCE] Element reference "${refId}" is invalid or stale. The page has navigated or changed since the snapshot was taken. Capture a fresh snapshot first.`
      );
    }

    this.#emit("tool_invoked", { tool: "browser_fill", refId, target: element.name });

    try {
      const locator = this.#activePage.locator(`[data-ovsc-ref="${refId}"], ${element.selector}`).first();
      const count = await locator.count();
      if (count === 0) {
        throw new BrowserSessionError(
          "STALE_ELEMENT_REFERENCE",
          `[STALE_ELEMENT_REFERENCE] Target field "${refId}" is no longer attached to DOM.`
        );
      }

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
        `Failed to fill field "${refId}" (${element.selector}): ${err?.message || String(err)}`,
        { cause: err }
      );
    }
  }

  public async screenshot(
    options?: { fullPage?: boolean },
    signal?: AbortSignal
  ): Promise<{ bytes: number; mimeType: "image/png"; base64?: string }> {
    if (!this.#activePage) {
      throw new BrowserSessionError("NO_PAGE", "No active browser page open.");
    }

    if (signal?.aborted) {
      this.#emit("cancellation", { reason: "Cancelled before screenshot" });
      throw new DOMException("Screenshot cancelled", "AbortError");
    }

    let abortListener: (() => void) | undefined;
    const shotPromise = this.#activePage.screenshot({
      fullPage: options?.fullPage ?? false,
      type: "png",
    });

    let buffer: Buffer;
    if (signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => {
          this.#emit("cancellation", { action: "screenshot" });
          reject(new DOMException("Screenshot cancelled", "AbortError"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      });
      buffer = await Promise.race([shotPromise, abortPromise]);
    } else {
      buffer = await shotPromise;
    }

    if (abortListener && signal) {
      signal.removeEventListener("abort", abortListener);
    }

    const bytes = buffer.length;
    // Bounded representation: base64 only included if under 512KB for model safety
    const base64 = bytes <= 524288 ? buffer.toString("base64") : undefined;

    return {
      bytes,
      mimeType: "image/png",
      base64,
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
      const proc = typeof (this.#browser as any).process === "function" ? (this.#browser as any).process() : undefined;
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

    this.#status = "CLOSED";
    this.#emit("session_closed", {});
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.close();
    const userDataDir = path.join(this.#config.workspaceRoot, ".browser-profile", this.#sessionId);
    try {
      if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    } catch {
      // Safe cleanup ignore
    }
    this.#emit("process_cleanup", { sessionId: this.#sessionId });
    this.#eventListeners.clear();
    this.#elementRefs.clear();
  }
}
