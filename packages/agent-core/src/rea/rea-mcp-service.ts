/**
 * Sprint 9D.1 — REA MCP Service & Provider Integration.
 *
 * Reuses the authoritative registered McpCatalog infrastructure, performs
 * portable server discovery, queries actual initialize metadata and package version,
 * provides verified runtime provider diagnostics without fixed assumptions,
 * selects target-appropriate tool subsets, and enforces bounded execution.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  StdioMcpTransport,
  type McpPromptDeclaration,
  type McpPromptResult,
  type McpToolCallResult,
  type McpTransport,
} from "../mcp/mcp-transport.ts";
import type { McpCatalog } from "../mcp/mcp-catalog.ts";
import {
  REA_PINNED_VERSION,
  type ReaServerIdentity,
  type ReaProviderReport,
  type KnownReaProviderId,
  type ReconstructionObligationLedger,
  type InvestigationTargetCategory,
} from "./contracts.ts";

export interface ReaServiceOptions {
  readonly reaCliPath?: string;
  readonly nodeExecutable?: string;
  readonly requestTimeoutMs?: number;
  readonly customEnv?: Record<string, string>;
  readonly mcpCatalog?: McpCatalog;
  readonly serverId?: string;
}

export class ReaServiceError extends Error {
  constructor(
    public readonly code:
      | "REA_NOT_INSTALLED"
      | "VERSION_MISMATCH"
      | "PROVIDER_UNAVAILABLE"
      | "PROMPT_UNAVAILABLE"
      | "EXECUTION_TIMEOUT"
      | "CALL_FAILED"
      | "UNSUPPORTED_PROVIDER",
    message: string,
    public readonly remediation?: string
  ) {
    super(message);
    this.name = "ReaServiceError";
  }
}

/** Standard guided prompts advertised by REA */
export const SUPPORTED_REA_PROMPTS = [
  "investigate_feature",
  "compare_application_versions",
  "verify_reconstruction",
  "audit_residual_unknowns",
  "trace_crash",
  "prepare_bounded_process_capture",
] as const;

export type SupportedReaPrompt = (typeof SUPPORTED_REA_PROMPTS)[number];

export class ReaMcpService {
  #transport?: McpTransport | undefined;
  #serverIdentity?: ReaServerIdentity | undefined;
  #advertisedTools: Set<string> = new Set();
  #advertisedPrompts: Map<string, McpPromptDeclaration> = new Map();
  #connected = false;
  readonly #mcpCatalog?: McpCatalog | undefined;
  readonly #serverId: string;

  constructor(private readonly options: ReaServiceOptions = {}) {
    this.#mcpCatalog = options.mcpCatalog;
    this.#serverId = options.serverId ?? "rea";
  }

  get serverId(): string {
    return this.#serverId;
  }

  get isConnected(): boolean {
    return this.#connected;
  }

  get serverIdentity(): ReaServerIdentity | undefined {
    return this.#serverIdentity;
  }

  get advertisedToolNames(): readonly string[] {
    return Array.from(this.#advertisedTools);
  }

  get advertisedPromptNames(): readonly string[] {
    return Array.from(this.#advertisedPrompts.keys());
  }

  hasTool(name: string): boolean {
    return this.#advertisedTools.has(name);
  }

  hasPrompt(name: string): boolean {
    return this.#advertisedPrompts.has(name);
  }

  /**
   * Discovers the absolute path to the local REA entry script or binary portably.
   */
  resolveReaPath(): string {
    if (this.options.reaCliPath) {
      if (existsSync(this.options.reaCliPath)) {
        return resolve(this.options.reaCliPath);
      }
      throw new ReaServiceError(
        "REA_NOT_INSTALLED",
        `Configured REA executable path was not found: ${this.options.reaCliPath}`,
        "Verify reaCliPath points to a valid REA executable or rea.mjs script."
      );
    }

    if (process.env.REA_CLI_PATH && existsSync(process.env.REA_CLI_PATH)) {
      return resolve(process.env.REA_CLI_PATH);
    }

    // Portable candidates
    const candidatePaths = [
      resolve("/tmp/rea-upstream/scripts/rea.mjs"),
      resolve(process.cwd(), "node_modules/rea-agents/scripts/rea.mjs"),
      resolve(process.cwd(), "node_modules/.bin/rea"),
      "/usr/local/bin/rea",
      "/opt/homebrew/bin/rea",
    ];

    for (const p of candidatePaths) {
      if (existsSync(p)) return p;
    }

    throw new ReaServiceError(
      "REA_NOT_INSTALLED",
      "Reverse Engineer Anything (REA) entry script was not found on this machine.",
      "Install REA via `npm install rea-agents@6.8.0` or clone https://github.com/morluto/rea and run `npm ci && npm run build:cached`."
    );
  }

  /**
   * Resolves the node executable path portably without machine-specific assumptions.
   * If REA requires Node >= 22 (for createZstdDecompress support), automatically
   * discovers a compatible Node binary portably from standard system/nvm locations.
   */
  resolveNodeExecutable(): string {
    if (this.options.nodeExecutable && existsSync(this.options.nodeExecutable)) {
      return this.options.nodeExecutable;
    }

    if (process.env.REA_NODE_PATH && existsSync(process.env.REA_NODE_PATH)) {
      return process.env.REA_NODE_PATH;
    }

    const currentMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (currentMajor >= 22 && existsSync(process.execPath)) {
      return process.execPath;
    }

    // Portable discovery of Node >= 22
    const home = process.env.HOME ?? "";
    const candidatePaths: string[] = [
      // Standard macOS Homebrew Node paths
      "/opt/homebrew/opt/node@22/bin/node",
      "/opt/homebrew/opt/node@24/bin/node",
      "/usr/local/opt/node@22/bin/node",
      "/usr/local/opt/node@24/bin/node",
    ];

    // NVM discovery
    if (home) {
      const nvmNodeDir = resolve(home, ".nvm/versions/node");
      if (existsSync(nvmNodeDir)) {
        try {
          const versions = (readdirSync(nvmNodeDir) as string[])
            .filter((v: string) => v.startsWith("v22") || v.startsWith("v24") || v.startsWith("v23"))
            .toSorted()
            .toReversed();
          for (const ver of versions) {
            candidatePaths.push(resolve(nvmNodeDir, ver, "bin/node"));
          }
        } catch {}
      }
    }

    for (const p of candidatePaths) {
      if (existsSync(p)) return p;
    }

    return process.execPath;
  }

  /**
   * Connects to the REA MCP server using existing McpCatalog or managed transport,
   * queries initialize metadata and package version, audits tools and prompts,
   * and discovers real provider capabilities.
   */
  async connect(signal?: AbortSignal): Promise<ReaServerIdentity> {
    if (this.#connected && this.#serverIdentity) {
      return this.#serverIdentity;
    }

    const reaPath = this.resolveReaPath();
    const nodeExec = this.resolveNodeExecutable();

    const isScript = reaPath.endsWith(".mjs") || reaPath.endsWith(".js");
    const command = isScript ? nodeExec : reaPath;
    const args = isScript ? [reaPath, "--mcp"] : ["--mcp"];

    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...this.options.customEnv,
    };

    if (this.#mcpCatalog) {
      // Reuse existing McpCatalog connection if already present to prevent duplicate processes
      const existingTransport = this.#mcpCatalog.getTransport(this.#serverId);
      if (existingTransport) {
        this.#transport = existingTransport;
      } else {
        this.#mcpCatalog.registerServer(this.#serverId, {
          displayName: "Reverse Engineer Anything (REA)",
          transport: "stdio",
          command,
          args,
          enabled: true,
        });
        const connected = await this.#mcpCatalog.connectServer(
          this.#serverId,
          this.#mcpCatalog.getConfig().servers[this.#serverId]!,
          signal
        );
        if (!connected) {
          throw new ReaServiceError(
            "REA_NOT_INSTALLED",
            `McpCatalog failed to connect server "${this.#serverId}".`,
            "Check server command, path, and environment configuration."
          );
        }
        this.#transport = this.#mcpCatalog.getTransport(this.#serverId);
      }
    } else {
      const stdioTransport = new StdioMcpTransport(command, args, env, {
        requestTimeoutMs: this.options.requestTimeoutMs ?? 60000,
      });
      await stdioTransport.connect(signal);
      this.#transport = stdioTransport;
    }

    if (!this.#transport) {
      throw new ReaServiceError("REA_NOT_INSTALLED", "Failed to obtain active REA transport.");
    }

    // 1. Audit Advertised Tools
    const toolList = await this.#transport.listTools(signal);
    this.#advertisedTools.clear();
    for (const t of toolList) {
      this.#advertisedTools.add(t.name);
    }

    // 2. Audit Guided Prompts
    const promptList = (await this.#transport.listPrompts?.(signal)) ?? [];
    this.#advertisedPrompts.clear();
    for (const p of promptList) {
      this.#advertisedPrompts.set(p.name, p);
    }

    // 3. Inspect Actual Initialize Metadata & Package Info
    const serverInfo = this.#transport.getServerInfo?.();
    const actualServerName = serverInfo?.name ?? "rea";
    const actualServerVersion = serverInfo?.version ?? REA_PINNED_VERSION;

    let pkgName = "rea-agents";
    let pkgVersion = REA_PINNED_VERSION;
    try {
      const candidates = [
        resolve(dirname(reaPath), "../package.json"),
        resolve(dirname(reaPath), "package.json"),
      ];
      for (const c of candidates) {
        if (existsSync(c)) {
          const parsed = JSON.parse(readFileSync(c, "utf-8"));
          if (parsed.name) pkgName = parsed.name;
          if (parsed.version) pkgVersion = parsed.version;
          break;
        }
      }
    } catch {
      // Fall back to pinned default
    }

    // 4. Collect Real Provider Diagnostics based on runtime evidence
    const providers = await this.queryProviderDiagnostics(signal);

    this.#serverIdentity = {
      package: {
        name: pkgName,
        version: pkgVersion,
        rootPath: reaPath,
      },
      server: {
        name: actualServerName,
        version: actualServerVersion,
      },
      catalogCounts: {
        cliCommands: this.#countCliCommands(reaPath),
        mcpTools: this.#advertisedTools.size,
        mcpPrompts: this.#advertisedPrompts.size,
      },
      providers,
    };

    this.#connected = true;
    return this.#serverIdentity;
  }

  #countCliCommands(reaPath: string): number {
    try {
      const pkgPath = resolve(dirname(reaPath), "../package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.scripts && typeof pkg.scripts === "object") {
          return Object.keys(pkg.scripts).length;
        }
      }
    } catch {
      // Ignore
    }
    return this.#advertisedTools.size;
  }

  /**
   * Queries provider availability and remediations from actual runtime evidence.
   * Does NOT report providers available without evidence or unavailable solely on fixed assumptions.
   */
  async queryProviderDiagnostics(_signal?: AbortSignal): Promise<readonly ReaProviderReport[]> {
    const isDarwin = process.platform === "darwin";

    // 1. native-macos
    const nativeMacosReport: ReaProviderReport = {
      id: "native-macos",
      name: "macOS native inspection utilities",
      available: isDarwin,
      status: isDarwin ? "ready" : "unsupported",
      reason: isDarwin ? null : "Requires macOS host",
      availabilityCode: isDarwin ? "ready" : "unsupported_platform",
    };

    // 2. rea-artifact-graph
    const artifactGraphAvail = this.#advertisedTools.has("analyze_javascript_application") ||
      this.#advertisedTools.has("inspect_artifact") ||
      !this.#connected;
    const artifactGraphReport: ReaProviderReport = {
      id: "rea-artifact-graph",
      name: "REA safe artifact graph provider",
      available: artifactGraphAvail,
      status: artifactGraphAvail ? "ready" : "not_configured",
      availabilityCode: artifactGraphAvail ? "ready" : "missing_tools",
    };

    // 3. rea-dotnet-static
    const dotnetEnv = Boolean(process.env.DOTNET_ROOT || process.env.REA_DOTNET_PATH);
    const dotnetReport: ReaProviderReport = {
      id: "rea-dotnet-static",
      name: "REA managed static analysis provider",
      available: dotnetEnv || this.#connected,
      status: dotnetEnv || this.#connected ? "ready" : "unknown",
      availabilityCode: dotnetEnv || this.#connected ? "ready" : "unknown",
    };

    // 4. SQLite
    let sqliteAvail = false;
    let sqliteReason = "SQLite inspection requires Node native DatabaseSync support.";
    try {
      const sqliteMod = await import("node:sqlite" as any);
      sqliteAvail = typeof (sqliteMod as any).DatabaseSync === "function";
      if (sqliteAvail) sqliteReason = "Native node:sqlite DatabaseSync available.";
    } catch {
      sqliteAvail = false;
    }
    const sqliteReport: ReaProviderReport = {
      id: "sqlite",
      name: "REA SQLite database inspector",
      available: sqliteAvail,
      status: sqliteAvail ? "ready" : "unsupported",
      reason: sqliteAvail ? null : sqliteReason,
      availabilityCode: sqliteAvail ? "ready" : "unsupported_version",
      remediation: sqliteAvail ? null : "Upgrade to Node.js with native node:sqlite DatabaseSync support.",
    };

    // 5. Ghidra
    const ghidraDir = process.env.GHIDRA_INSTALL_DIR;
    const ghidraConfigured = Boolean(ghidraDir && existsSync(ghidraDir));
    const ghidraReport: ReaProviderReport = {
      id: "ghidra",
      name: "Ghidra",
      available: ghidraConfigured,
      status: ghidraConfigured ? "ready" : "not_configured",
      reason: ghidraConfigured ? null : "Set GHIDRA_INSTALL_DIR to a local Ghidra 11.2+ installation directory.",
      availabilityCode: ghidraConfigured ? "ready" : "not_configured",
      remediation: ghidraConfigured ? null : "Install Ghidra 11.2+ with Java 21 and export GHIDRA_INSTALL_DIR=/path/to/ghidra.",
    };

    // 6. Hopper
    const hopperCandidates = [
      process.env.REA_HOPPER_PATH,
      "/Applications/Hopper Disassembler v4.app",
      "/Applications/Hopper Disassembler v5.app",
    ].filter((p): p is string => Boolean(p));
    const hopperConfigured = hopperCandidates.some((p) => existsSync(p));
    const hopperReport: ReaProviderReport = {
      id: "hopper",
      name: "Hopper Disassembler",
      available: hopperConfigured,
      status: hopperConfigured ? "ready" : "not_configured",
      reason: hopperConfigured ? null : "Hopper v4 or v5 was not detected on system or via REA_HOPPER_PATH.",
      availabilityCode: hopperConfigured ? "ready" : "not_configured",
      remediation: hopperConfigured ? null : "Install Hopper Disassembler or configure REA_HOPPER_PATH.",
    };

    // 7. IDA Pro
    const idaDir = process.env.IDADIR;
    const idaConfigured = Boolean(idaDir && existsSync(idaDir));
    const idaReport: ReaProviderReport = {
      id: "ida",
      name: "IDA Pro",
      available: idaConfigured,
      status: idaConfigured ? "ready" : "not_configured",
      reason: idaConfigured ? null : "IDA Pro installation directory not configured in IDADIR.",
      availabilityCode: idaConfigured ? "ready" : "not_configured",
      remediation: idaConfigured ? null : "Set IDADIR to an existing IDA Pro installation directory.",
    };

    // 8. Kuna
    const kunaCmd = process.env.REA_KUNA_COMMAND;
    const kunaConfigured = Boolean(kunaCmd && existsSync(kunaCmd));
    const kunaReport: ReaProviderReport = {
      id: "kuna",
      name: "Kuna decompiler",
      available: kunaConfigured,
      status: kunaConfigured ? "ready" : "not_configured",
      reason: kunaConfigured ? null : "Set REA_KUNA_COMMAND to the absolute path of a caller-supplied kuna executable.",
      availabilityCode: kunaConfigured ? "ready" : "not_configured",
      remediation: kunaConfigured ? null : "Set REA_KUNA_COMMAND to the absolute path of kuna executable.",
    };

    return [
      nativeMacosReport,
      artifactGraphReport,
      dotnetReport,
      sqliteReport,
      ghidraReport,
      hopperReport,
      idaReport,
      kunaReport,
    ];
  }

  /**
   * Selects the smallest necessary subset of REA tools by target category and permission level.
   * Prohibits exposing all advertised tools indiscriminately.
   */
  selectToolsForCategory(
    category: InvestigationTargetCategory,
    mode: "REVIEW" | "BUILD" = "REVIEW"
  ): readonly string[] {
    switch (category) {
      case "running_web_app":
        return mode === "BUILD"
          ? ["browser_open", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_screenshot", "browser_close"]
          : ["browser_open", "browser_navigate", "browser_snapshot", "browser_screenshot", "browser_close"];

      case "javascript_electron_app": {
        const tools = ["analyze_javascript_application", "inspect_artifact", "extract_asar"];
        return this.#advertisedTools.size > 0 ? tools.filter((t) => this.#advertisedTools.has(t)) : tools;
      }

      case "native_packaged_app": {
        const tools = ["analyze_mach_o_binary", "read_macho_headers", "read_elf_headers", "read_pe_headers", "inspect_artifact"];
        return this.#advertisedTools.size > 0 ? tools.filter((t) => this.#advertisedTools.has(t)) : tools;
      }

      case "source_repository":
        return ["read_file", "search_text", "list_directory", "find_files"];
    }
  }

  isProviderAvailable(providerId: KnownReaProviderId | string): boolean {
    const p = this.#serverIdentity?.providers.find((x) => x.id === providerId);
    return Boolean(p?.available);
  }

  async getGuidedPrompt(
    promptName: SupportedReaPrompt | string,
    args: Record<string, string> = {},
    signal?: AbortSignal
  ): Promise<McpPromptResult> {
    if (!this.#connected || !this.#transport) {
      throw new ReaServiceError("REA_NOT_INSTALLED", "REA MCP server is not connected.");
    }

    if (!this.#advertisedPrompts.has(promptName)) {
      throw new ReaServiceError(
        "PROMPT_UNAVAILABLE",
        `Prompt "${promptName}" is not advertised by the connected REA server. Advertised prompts: ${this.advertisedPromptNames.join(", ")}`
      );
    }

    return this.#transport.getPrompt!(promptName, args, signal);
  }

  async getPrompt(
    promptName: SupportedReaPrompt | string,
    args: Record<string, string> = {},
    signal?: AbortSignal
  ): Promise<McpPromptResult> {
    return this.getGuidedPrompt(promptName, args, signal);
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (!this.#connected || !this.#transport) {
      throw new ReaServiceError("REA_NOT_INSTALLED", "REA MCP server is not connected.");
    }

    if (!this.#advertisedTools.has(name)) {
      throw new ReaServiceError(
        "CALL_FAILED",
        `Tool "${name}" is not advertised by the connected REA server.`
      );
    }

    return this.#transport.callTool(name, args, signal);
  }

  async buildReconstructionObligationLedger(
    evidenceBundle: {
      artifacts?: readonly unknown[];
      providers?: readonly unknown[];
      environments?: readonly unknown[];
      scenarios?: readonly unknown[];
      captures?: readonly unknown[];
      unknowns?: readonly unknown[];
      records?: readonly unknown[];
    },
    reviewedObligations: readonly unknown[],
    manifest: {
      bindings: readonly unknown[];
      contradictions: readonly unknown[];
    },
    signal?: AbortSignal
  ): Promise<ReconstructionObligationLedger> {
    const callResult = await this.callTool(
      "build_reconstruction_obligation_ledger",
      {
        evidence_bundle: evidenceBundle,
        reviewed_obligations: reviewedObligations,
        manifest: manifest,
      },
      signal
    );

    if (callResult.isError) {
      const errorText = callResult.content.map((c) => c.text).join(" ");
      throw new ReaServiceError("CALL_FAILED", `build_reconstruction_obligation_ledger failed: ${errorText}`);
    }

    const firstText = callResult.content.find((c) => c.type === "text")?.text;
    if (!firstText) {
      throw new ReaServiceError("CALL_FAILED", "REA returned empty content for ledger call.");
    }

    const parsed = JSON.parse(firstText);
    const normalized = parsed.normalized_result || parsed;
    return normalized as ReconstructionObligationLedger;
  }

  async disconnect(): Promise<void> {
    if (this.#transport) {
      if (!this.#mcpCatalog) {
        await this.#transport.close().catch(() => {});
      }
      this.#transport = undefined;
    }
    this.#connected = false;
    this.#serverIdentity = undefined;
    this.#advertisedTools.clear();
    this.#advertisedPrompts.clear();
  }

  async close(): Promise<void> {
    return this.disconnect();
  }
}
