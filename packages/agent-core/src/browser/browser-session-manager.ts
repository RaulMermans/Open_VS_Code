import * as crypto from "node:crypto";
import { createRequire } from "node:module";

type Browser = any;
type BrowserContext = any;
type Page = any;

const nodeRequire = createRequire(import.meta.url);
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
  attachNetworkPolicyToPage,
  BrowserNetworkPolicyError,
  DEFAULT_ALLOWED_LOCAL_ORIGINS,
} from "./browser-network-policy.ts";
import { isDestructiveElement, isSensitiveField } from "./browser-action-classifier.ts";
import { killProcessTree } from "../tools/kill-process-tree.ts";

export class BrowserSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserSessionError";
    this.code = code;
  }
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
      text: text.slice(0, 2000), // Bound individual message length
      timestamp: Date.now(),
    };
    this.#consoleBuffer.push(entry);
    if (this.#consoleBuffer.length > this.#maxConsoleMessages) {
      this.#consoleBuffer.shift();
    }
    this.#emit("console_message", { type, text: entry.text });
  }

  #recordNetworkFailure(failure: BrowserNetworkFailure): void {
    this.#networkFailures.push(failure);
    if (this.#networkFailures.length > this.#maxNetworkEvents) {
      this.#networkFailures.shift();
    }
    this.#emit("network_failure", { ...failure });
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

    // 1. Determine executable
    const diagnostic = detectBrowserProvisioning(this.#config.executablePath);
    if (diagnostic.status !== "READY" || !diagnostic.executable) {
      this.#status = "ERROR";
      throw new BrowserSessionError(
        "NOT_CONFIGURED",
        `Browser is not configured or executable was not found. Diagnostics: ${diagnostic.details.join("; ")}`
      );
    }

    const execPath = diagnostic.executable.path;

    try {
      const pw = nodeRequire("playwright-core");
      this.#browser = await pw.chromium.launch({
        executablePath: execPath,
        headless: this.#config.headless ?? true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      this.#context = await this.#browser.newContext({
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
        viewport: this.#config.viewport ?? { width: 1280, height: 800 },
      });

      this.#status = "READY";
      this.#emit("session_started", {
        executablePath: execPath,
        source: diagnostic.executable.source,
        headless: this.#config.headless ?? true,
      });
    } catch (err: any) {
      this.#status = "ERROR";
      this.#emit("process_cleanup", { error: err?.message || String(err) });
      throw new BrowserSessionError("LAUNCH_FAILED", `Failed to launch browser: ${err?.message || String(err)}`, {
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

      // Attach request interception network policy to the page
      await attachNetworkPolicyToPage(page, policyConfig, (f) => this.#recordNetworkFailure(f));

      // Attach console listeners
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
      // If no page open, open it
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

    // Query interactive elements on page
    const rawElements = await page.evaluate(() => {
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
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.placeholder ||
          el.innerText?.trim() ||
          el.value ||
          "";

        let selector = "";
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.getAttribute("name")) {
          selector = `${tag}[name="${el.getAttribute("name")}"]`;
        } else {
          selector = `${tag}:nth-of-type(${i + 1})`;
        }

        const item: {
          tag: string;
          role: string;
          name: string;
          selector: string;
          value?: string;
          type?: string;
        } = {
          tag,
          role,
          name: name.slice(0, 100),
          selector,
        };
        const elVal = el.value;
        if (elVal) {
          item.value = String(elVal).slice(0, 100);
        }
        const elType = el.type;
        if (elType) {
          item.type = elType;
        }
        found.push(item);
      }
      return found;
    });

    const elements: ElementRef[] = [];
    const treeLines: string[] = [`Page: "${title}" (${url})`];

    // Build element references
    this.#elementRefs.clear();
    for (let idx = 0; idx < rawElements.length; idx++) {
      const raw = rawElements[idx];
      const refId = `e${idx + 1}`;
      const isSens = isSensitiveField({
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

      const ref: ElementRef = {
        refId,
        role: raw.role,
        name: raw.name,
        selector: raw.selector,
        snapshotId,
        tag: raw.tag,
        value: raw.value,
        sensitive: isSens,
        destructive: isDest,
      };

      elements.push(ref);
      this.#elementRefs.set(refId, ref);

      const flags = [
        isSens ? "[SENSITIVE]" : "",
        isDest ? "[DESTRUCTIVE]" : "",
      ]
        .filter(Boolean)
        .join(" ");

      treeLines.push(
        `  [ref=${refId}] <${raw.tag}> ${raw.role} "${raw.name}"${raw.value ? ` value="${raw.value}"` : ""} ${flags}`.trimEnd()
      );
    }

    this.#activeSnapshotId = snapshotId;

    let treeText = treeLines.join("\n");
    let truncated = false;
    let bytes = Buffer.byteLength(treeText, "utf8");

    if (bytes > this.#maxSnapshotBytes) {
      truncated = true;
      const budget = this.#maxSnapshotBytes - 120;
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
      const locator = this.#activePage.locator(element.selector).first();
      await locator.click({
        timeout: this.#config.timeoutMs ?? 10000,
      });

      this.#emit("action_approved", { tool: "browser_click", refId });
      return { success: true, target: element };
    } catch (err: any) {
      if (signal?.aborted) {
        this.#emit("cancellation", { tool: "browser_click", refId });
        throw new DOMException("Click cancelled", "AbortError");
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
      const locator = this.#activePage.locator(element.selector).first();
      await locator.fill(value, {
        timeout: this.#config.timeoutMs ?? 10000,
      });

      this.#emit("action_approved", { tool: "browser_fill", refId });
      return { success: true, target: element };
    } catch (err: any) {
      if (signal?.aborted) {
        this.#emit("cancellation", { tool: "browser_fill", refId });
        throw new DOMException("Fill cancelled", "AbortError");
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

    const buffer = await this.#activePage.screenshot({
      fullPage: options?.fullPage ?? false,
      type: "png",
    });

    const bytes = buffer.length;
    // For token efficiency, provide base64 representation only when reasonable in size (< 1MB)
    const base64 = bytes <= 1048576 ? buffer.toString("base64") : undefined;

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
    this.#emit("process_cleanup", { sessionId: this.#sessionId });
    this.#eventListeners.clear();
    this.#elementRefs.clear();
  }
}
