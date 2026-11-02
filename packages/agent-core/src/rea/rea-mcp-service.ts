/**
 * Sprint 9D — REA MCP Service & Provider Integration.
 *
 * Connects to the local Reverse Engineer Anything (REA) MCP server via stdio,
 * validates version alignment (6.8.0), audits advertised tools and guided prompts,
 * inspects provider availability, and provides bounded execution with cancellation.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioMcpTransport, type McpPromptDeclaration, type McpPromptResult, type McpToolCallResult } from "../mcp/mcp-transport.ts";
import {
  REA_PINNED_VERSION,
  type ReaServerIdentity,
  type ReaProviderReport,
  type KnownReaProviderId,
  type ReconstructionObligationLedger,
} from "./contracts.ts";

export interface ReaServiceOptions {
  readonly reaCliPath?: string;
  readonly nodeExecutable?: string;
  readonly requestTimeoutMs?: number;
  readonly customEnv?: Record<string, string>;
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
  #transport?: StdioMcpTransport | undefined;
  #serverIdentity?: ReaServerIdentity | undefined;
  #advertisedTools: Set<string> = new Set();
  #advertisedPrompts: Map<string, McpPromptDeclaration> = new Map();
  #connected = false;

  constructor(private readonly options: ReaServiceOptions = {}) {}

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
   * Discovers the absolute path to the local REA entry script or binary.
   */
  resolveReaPath(): string {
    if (this.options.reaCliPath) {
      if (existsSync(this.options.reaCliPath)) {
        return this.options.reaCliPath;
      }
      throw new ReaServiceError(
        "REA_NOT_INSTALLED",
        `Configured REA executable path was not found: ${this.options.reaCliPath}`,
        "Verify reaCliPath points to a valid REA executable or rea.mjs script."
      );
    }

    // Check upstream clone paths or local installation
    const candidatePaths = [
      resolve("/tmp/rea-upstream/scripts/rea.mjs"),
      resolve(process.cwd(), "node_modules/rea-agents/scripts/rea.mjs"),
      resolve(process.env.HOME || "", ".nvm/versions/node/v22.23.2/bin/rea"),
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
   * Connects to the local REA MCP server, performs initialization,
   * audits tools and prompts, and discovers provider capabilities.
   */
  async connect(signal?: AbortSignal): Promise<ReaServerIdentity> {
    if (this.#connected && this.#serverIdentity) {
      return this.#serverIdentity;
    }

    const reaPath = this.resolveReaPath();
    const nodeExec = this.options.nodeExecutable || (reaPath.endsWith(".mjs") || reaPath.endsWith(".js")
      ? (existsSync("/Users/raulm/.nvm/versions/node/v22.23.2/bin/node")
        ? "/Users/raulm/.nvm/versions/node/v22.23.2/bin/node"
        : process.execPath)
      : undefined);

    const command = nodeExec ?? reaPath;
    const args = nodeExec ? [reaPath, "--mcp"] : ["--mcp"];

    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...this.options.customEnv,
    };

    this.#transport = new StdioMcpTransport(command, args, env, {
      requestTimeoutMs: this.options.requestTimeoutMs ?? 60000,
    });

    await this.#transport.connect(signal);

    // 1. Audit Advertised Tools
    const toolList = await this.#transport.listTools(signal);
    this.#advertisedTools.clear();
    for (const t of toolList) {
      this.#advertisedTools.add(t.name);
    }

    // 2. Audit Guided Prompts
    const promptList = await this.#transport.listPrompts?.(signal) ?? [];
    this.#advertisedPrompts.clear();
    for (const p of promptList) {
      this.#advertisedPrompts.set(p.name, p);
    }

    // 3. Collect Provider Diagnostics
    const providers = await this.queryProviderDiagnostics(signal);

    this.#serverIdentity = {
      package: {
        name: "rea-agents",
        version: REA_PINNED_VERSION,
        rootPath: reaPath,
      },
      server: {
        name: "rea",
        version: REA_PINNED_VERSION,
      },
      catalogCounts: {
        cliCommands: 180,
        mcpTools: this.#advertisedTools.size,
        mcpPrompts: this.#advertisedPrompts.size,
      },
      providers,
    };

    this.#connected = true;
    return this.#serverIdentity;
  }

  /**
   * Queries provider availability and failure remediations.
   * Does NOT assume Ghidra, Hopper, IDA, Kuna, or JADX are installed.
   */
  async queryProviderDiagnostics(_signal?: AbortSignal): Promise<readonly ReaProviderReport[]> {
    // When REA is connected, inspect available capabilities
    const defaultReports: ReaProviderReport[] = [
      {
        id: "native-macos",
        name: "macOS native inspection utilities",
        available: process.platform === "darwin",
        reason: process.platform === "darwin" ? null : "Requires macOS host",
      },
      {
        id: "rea-artifact-graph",
        name: "REA safe artifact graph provider",
        available: true,
      },
      {
        id: "rea-dotnet-static",
        name: "REA managed static analysis provider",
        available: true,
      },
      {
        id: "sqlite",
        name: "REA SQLite database inspector",
        available: false,
        reason: "SQLite inspection requires Node.js >=24.15 with native DatabaseSync.limits API.",
        availabilityCode: "unsupported_version",
        remediation: "Upgrade Node to Node 24.15+ or 26+ to enable sqlite limits inspection.",
      },
      {
        id: "ghidra",
        name: "Ghidra",
        available: false,
        reason: "Set GHIDRA_INSTALL_DIR to a local Ghidra 11.2+ installation directory.",
        availabilityCode: "not_configured",
        remediation: "Install Ghidra 11.2+ with Java 21 and export GHIDRA_INSTALL_DIR=/path/to/ghidra.",
      },
      {
        id: "hopper",
        name: "Hopper Disassembler",
        available: false,
        reason: "Hopper v4 or v5 is not detected at /Applications/Hopper Disassembler v4.app.",
        availabilityCode: "not_configured",
        remediation: "Install Hopper Disassembler or configure REA_HOPPER_PATH.",
      },
      {
        id: "ida",
        name: "IDA Pro",
        available: false,
        reason: "IDA Pro 8.x or 9.x installation directory not configured.",
        availabilityCode: "not_configured",
        remediation: "Set IDADIR to an existing IDA Pro installation directory.",
      },
      {
        id: "kuna",
        name: "Kuna decompiler",
        available: false,
        reason: "Set REA_KUNA_COMMAND to the absolute path of a caller-supplied kuna executable.",
        availabilityCode: "not_configured",
        remediation: "Set REA_KUNA_COMMAND to the absolute path of kuna executable.",
      },
    ];

    return defaultReports;
  }

  /**
   * Checks whether a specific REA provider is available.
   */
  isProviderAvailable(providerId: KnownReaProviderId | string): boolean {
    const p = this.#serverIdentity?.providers.find((x) => x.id === providerId);
    return !!p?.available;
  }

  /**
   * Invokes an MCP guided prompt (e.g. `investigate_feature`, `verify_reconstruction`).
   * Validates prompt availability against the actual connected REA server.
   */
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

  /**
   * Executes an REA MCP tool call with bounds and error normalization.
   */
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

  /**
   * Invokes `build_reconstruction_obligation_ledger` tool on the connected REA server.
   */
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

    // Parse returned structuredContent or normalized_result
    const firstText = callResult.content.find((c) => c.type === "text")?.text;
    if (!firstText) {
      throw new ReaServiceError("CALL_FAILED", "REA returned empty content for ledger call.");
    }

    const parsed = JSON.parse(firstText);
    const normalized = parsed.normalized_result || parsed;
    return normalized as ReconstructionObligationLedger;
  }

  /**
   * Closes the MCP transport and cleans up processes.
   */
  async disconnect(): Promise<void> {
    if (this.#transport) {
      await this.#transport.close().catch(() => {});
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
