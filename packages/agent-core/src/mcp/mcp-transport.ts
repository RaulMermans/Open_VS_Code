import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { killProcessTree } from "../tools/kill-process-tree.ts";

export interface McpToolDeclaration {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: any }>;
  isError: boolean;
}

export interface McpTransport {
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<McpToolDeclaration[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

class JsonRpcError extends Error {
  constructor(public code: number, message: string, public data?: any) {
    super(message);
  }
}

export interface StdioMcpTransportOptions {
  requestTimeoutMs?: number;
}

export class StdioMcpTransport implements McpTransport {
  private child?: ChildProcess | undefined;
  private rl?: readline.Interface | undefined;
  private messageId = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private initialized = false;

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string | undefined>,
    private options?: StdioMcpTransportOptions
  ) {}

  getPendingRequestCountForDiagnostics(): number {
    return this.pendingRequests.size;
  }


  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Aborted");

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for MCP server to start"));
        this.close();
      }, 5000);

      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("Aborted"));
        this.close();
      };
      signal?.addEventListener("abort", onAbort);

      try {
        this.child = spawn(this.command, this.args, {
          shell: false,
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32"
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }

      this.child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
        this.cleanup(err);
      });

      this.child.on("exit", (code, signalStr) => {
        const err = new Error(`MCP server exited with code ${code} signal ${signalStr}`);
        (err as any).code = "MCP_SERVER_EXITED";
        this.cleanup(err);
      });

      this.child.stderr?.on("data", (_chunk) => {
        // Just discard stderr for now
      });

      if (!this.child.stdout || !this.child.stdin) {
        clearTimeout(timeout);
        reject(new Error("Failed to open stdio pipes"));
        return;
      }

      this.rl = readline.createInterface({
        input: this.child.stdout,
        terminal: false,
      });

      this.rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const req = this.pendingRequests.get(msg.id)!;
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              req.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
            } else {
              req.resolve(msg.result);
            }
          }
        } catch (e: any) {
          // A malformed protocol message means we can't reliably match responses to requests.
          // Reject all pending requests with a protocol error to prevent hanging.
          const error = new Error(`invalid protocol data: ${e.message}`);
          for (const [_id, req] of this.pendingRequests.entries()) {
            req.reject(error);
          }
          this.pendingRequests.clear();
        }
      });

      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-core", version: "0.1.0" }
      }).then((_result) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.initialized = true;
        this.sendNotification("notifications/initialized", {});
        resolve();
      }).catch((err) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
        this.close();
      });
    });
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDeclaration[]> {
    if (!this.initialized) throw new Error("Not initialized");
    const result = await this.sendRequestWithSignal("tools/list", {}, signal, 10000);
    return result.tools || [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (!this.initialized) throw new Error("Not initialized");
    const result = await this.sendRequestWithSignal("tools/call", { name, arguments: args }, signal, 30000);
    return {
      content: result.content || [],
      isError: !!result.isError
    };
  }

  async close(): Promise<void> {
    this.cleanup(new Error("Client closed"));
  }

  private sendRequestWithSignal(method: string, params: any, signal?: AbortSignal, defaultTimeoutMs: number = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Aborted"));
      
      let id: number | undefined;

      const timeoutMs = this.options?.requestTimeoutMs ?? defaultTimeoutMs;
      const timeout = setTimeout(() => {
        if (id !== undefined) this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for MCP method ${method}`));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timeout);
        if (id !== undefined) this.pendingRequests.delete(id);
        reject(new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort);

      this.sendRequest(method, params, (newId) => { id = newId; }).then(res => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        resolve(res);
      }).catch(err => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  }

  private sendRequest(method: string, params: any, onIdAssigned?: (id: number) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) return reject(new Error("Not connected"));
      const id = this.messageId++;
      if (onIdAssigned) onIdAssigned(id);
      this.pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(msg, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private sendNotification(method: string, params: any): void {
    if (!this.child?.stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child.stdin.write(msg);
  }

  private cleanup(err: Error) {
    this.initialized = false;
    if (this.rl) {
      this.rl.close();
      this.rl = undefined;
    }
    if (this.child) {
      killProcessTree(this.child);
      this.child = undefined;
    }
    for (const [_id, req] of this.pendingRequests.entries()) {
      req.reject(err);
    }
    this.pendingRequests.clear();
  }
}
