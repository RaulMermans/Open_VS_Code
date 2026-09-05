import type { McpTransport, McpToolDeclaration, McpToolCallResult } from "./mcp-transport.ts";

export class TestMcpTransport implements McpTransport {
  public tools: McpToolDeclaration[] = [];
  public calls: Array<{ name: string; args: unknown }> = [];
  public results = new Map<string, McpToolCallResult | Error>();

  constructor(public serverId: string) {}

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Aborted");
    // Simulate connection delay
    await new Promise(r => setTimeout(r, 10));
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDeclaration[]> {
    if (signal?.aborted) throw new Error("Aborted");
    return this.tools;
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
