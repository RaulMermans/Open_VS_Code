import type { McpTransport, McpToolDeclaration, McpToolCallResult, McpPromptDeclaration, McpPromptResult } from "./mcp-transport.ts";

export class TestMcpTransport implements McpTransport {
  public tools: McpToolDeclaration[] = [];
  public prompts: McpPromptDeclaration[] = [];
  public calls: Array<{ name: string; args: unknown }> = [];
  public promptCalls: Array<{ name: string; args?: Record<string, string> }> = [];
  public results = new Map<string, McpToolCallResult | Error>();
  public promptResults = new Map<string, McpPromptResult | Error>();

  constructor(public serverId: string) {}

  public serverInfo?: { name: string; version: string } = { name: "test-server", version: "1.0.0" };
  public initResult?: unknown = { serverInfo: { name: "test-server", version: "1.0.0" } };

  getServerInfo(): { name: string; version: string } | undefined {
    return this.serverInfo;
  }

  getInitializeResult(): unknown {
    return this.initResult;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Aborted");
    // Simulate connection delay
    await new Promise(r => setTimeout(r, 10));
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDeclaration[]> {
    if (signal?.aborted) throw new Error("Aborted");
    return this.tools;
  }

  async listPrompts(signal?: AbortSignal): Promise<McpPromptDeclaration[]> {
    if (signal?.aborted) throw new Error("Aborted");
    return this.prompts;
  }

  async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult> {
    if (signal?.aborted) throw new Error("Aborted");
    if (args !== undefined) {
      this.promptCalls.push({ name, args });
    } else {
      this.promptCalls.push({ name });
    }
    const res = this.promptResults.get(name);
    if (!res) {
      return {
        description: `Mock prompt ${name}`,
        messages: [{ role: "user", content: { type: "text", text: `Guidance for ${name}` } }],
      };
    }
    if (res instanceof Error) throw res;
    return res;
  }

  public hang = false;
  public pendingRequests = new Set<string>();

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (signal?.aborted) throw new Error("Aborted");
    this.calls.push({ name, args });

    if (this.hang) {
      this.pendingRequests.add(name);
      return new Promise<McpToolCallResult>((resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => {
            this.pendingRequests.delete(name);
            reject(new Error(signal.reason || "Aborted"));
          });
        }
      });
    }
    const result = this.results.get(name);
    if (!result) {
      return { content: [{ type: "text", text: "Success" }], isError: false };
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  async close(): Promise<void> {
    // noop
  }
}
