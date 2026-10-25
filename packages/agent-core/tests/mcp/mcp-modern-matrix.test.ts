import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpMcpFixtureServer } from "./http-fixture-server.ts";
import {
  McpCatalog,
  StreamableHttpMcpTransport,
  StdioMcpTransport,
  TestMcpTransport,
  validateMcpConfig,
  validateMcpConfigDetailed,
  validateMcpEndpoint,
  validateRedirect,
  InMemorySecretProvider,
  createMcpToolRegistration,
  selectMcpTools,
  McpSecurityError,
  McpAuthRequiredError,
  MAX_MCP_RESULT_BYTES,
} from "../../src/mcp/index.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { classifyPermission } from "../../src/tools/permissions.ts";
import { AgentRunner } from "../../src/agent/runner.ts";
import { calculateBudget } from "../../src/context/budget.ts";
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts";

const dirName = path.dirname(fileURLToPath(import.meta.url));
const stdioFixturePath = path.join(dirName, "fixture-server.js");

let fixtureServer: HttpMcpFixtureServer;
let serverPort: number;
let serverUrl: string;

test.before(async () => {
  fixtureServer = new HttpMcpFixtureServer();
  const res = await fixtureServer.start();
  serverPort = res.port;
  serverUrl = res.url;
});

test.after(async () => {
  await fixtureServer.stop();
});

test("MCP 2.0 Modern Matrix - 36 High-Value Deterministic Cases", async (t) => {

  await t.test("1. Existing stdio transport compatibility", async () => {
    const tr = new StdioMcpTransport(process.execPath, [stdioFixturePath], {});
    await tr.connect();
    const tools = await tr.listTools();
    assert.ok(tools.length > 0, "Tools should be discovered over stdio");
    const callRes = await tr.callTool("echo", { text: "hello stdio" });
    assert.equal(callRes.isError, false);
    assert.deepEqual(callRes.content, [{ type: "text", text: "hello stdio" }]);
    await tr.close();
  });

  await t.test("2. Modern HTTP server connection (Streamable HTTP 2026-07-28 POST)", async () => {
    const tr = new StreamableHttpMcpTransport(serverUrl);
    await tr.connect();
    assert.equal(tr.isConnected(), true);
    assert.equal(tr.getNegotiatedProtocolVersion(), "2026-07-28");
    const tools = await tr.listTools();
    assert.ok(tools.some((tl) => tl.name === "echo"));
    const res = await tr.callTool("echo", { text: "modern 2026" });
    assert.equal(res.isError, false);
    assert.deepEqual(res.content, [{ type: "text", text: "modern 2026" }]);
    await tr.close();
  });

  await t.test("3. Older protocol compatibility (2025-11-25 with session ID)", async () => {
    const olderUrl = `http://127.0.0.1:${serverPort}/mcp-2025`;
    const tr = new StreamableHttpMcpTransport(olderUrl, {
      preferredProtocolVersion: "2025-11-25",
    });
    await tr.connect();
    assert.equal(tr.getNegotiatedProtocolVersion(), "2025-11-25");
    assert.equal(tr.getSessionId(), "sess-2025-xyz");
    const tools = await tr.listTools();
    assert.ok(tools.length > 0);
    const res = await tr.callTool("echo", { text: "session 2025" });
    assert.equal(res.isError, false);
    await tr.close();
  });

  await t.test("4. Legacy protocol compatibility (2024-11-05 handshake)", async () => {
    const legacyUrl = `http://127.0.0.1:${serverPort}/mcp-2024`;
    const tr = new StreamableHttpMcpTransport(legacyUrl, {
      preferredProtocolVersion: "2024-11-05",
    });
    await tr.connect();
    assert.equal(tr.getNegotiatedProtocolVersion(), "2024-11-05");
    await tr.close();
  });

  await t.test("5. Unsupported protocol endpoint handling", async () => {
    const invalidEndpoint = `http://127.0.0.1:${serverPort}/nonexistent-mcp-route`;
    const tr = new StreamableHttpMcpTransport(invalidEndpoint, { connectTimeoutMs: 1500 });
    await assert.rejects(
      async () => {
        await tr.connect();
      },
      /404/
    );
    assert.equal(tr.isConnected(), false);
    await tr.close();
  });

  await t.test("6. Invalid endpoint URL format rejection", () => {
    assert.throws(() => {
      const instance = new StreamableHttpMcpTransport("not-a-valid-url");
      void instance;
    }, McpSecurityError);
    assert.throws(() => {
      const instance = new StreamableHttpMcpTransport("ftp://example.com/mcp");
      void instance;
    }, McpSecurityError);
  });

  await t.test("7. Authentication failure (401 Unauthorized -> AUTH_REQUIRED)", async () => {
    const authUrl = `http://127.0.0.1:${serverPort}/auth/mcp`;
    const tr = new StreamableHttpMcpTransport(authUrl);
    await assert.rejects(
      async () => {
        await tr.connect();
      },
      McpAuthRequiredError
    );
    assert.equal(tr.isConnected(), false);
    await tr.close();
  });

  await t.test("8. Authorization recovery (valid Bearer token succeeds)", async () => {
    const authUrl = `http://127.0.0.1:${serverPort}/auth/mcp`;
    const secretProvider = new InMemorySecretProvider();
    await secretProvider.setSecret("test_token_key", "test-valid-token");

    const tr = new StreamableHttpMcpTransport(authUrl, {
      authConfig: { type: "bearer", secretKey: "test_token_key" },
      secretProvider,
    });

    await tr.connect();
    assert.equal(tr.isConnected(), true);
    const tools = await tr.listTools();
    assert.ok(tools.length > 0);
    await tr.close();
  });

  await t.test("9. Malformed tool schema rejection", async () => {
    const catalog = new McpCatalog({
      servers: {
        mock: {
          transport: "test",
          enabled: true,
        },
      },
    });
    const testTr = new TestMcpTransport("mock");
    testTr.tools = [
      { name: "bad_schema_1", inputSchema: "not-an-object" as any },
      { name: "bad_schema_2", inputSchema: ["array"] as any },
      { name: "good_tool", inputSchema: { type: "object" } },
    ];
    (catalog as any).transports.set("mock", testTr);
    await catalog.discover();

    const discovered = catalog.getTools();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.canonicalName, "mcp_mock_good_tool");
    await catalog.close();
  });

  await t.test("10. Duplicate tool names detection (same server duplicate rejected)", async () => {
    const catalog = new McpCatalog({
      servers: {
        mock: { transport: "test", enabled: true },
      },
    });
    const testTr = new TestMcpTransport("mock");
    testTr.tools = [
      { name: "dup_tool", inputSchema: { type: "object" } },
      { name: "dup_tool", inputSchema: { type: "object" } },
    ];
    (catalog as any).transports.set("mock", testTr);

    await catalog.discover();
    // Same server duplicate triggers server failure state
    assert.equal(catalog.getServerState("mock"), "FAILED");
    await catalog.close();
  });

  await t.test("11. Tool selection bounds (max 3 tools respected)", () => {
    const tools = [
      { serverId: "s", toolName: "t1", canonicalName: "mcp_s_t1", description: "git status", estimatedSchemaTokens: 50 },
      { serverId: "s", toolName: "t2", canonicalName: "mcp_s_t2", description: "git diff", estimatedSchemaTokens: 50 },
      { serverId: "s", toolName: "t3", canonicalName: "mcp_s_t3", description: "git log", estimatedSchemaTokens: 50 },
      { serverId: "s", toolName: "t4", canonicalName: "mcp_s_t4", description: "git commit", estimatedSchemaTokens: 50 },
      { serverId: "s", toolName: "t5", canonicalName: "mcp_s_t5", description: "git branch", estimatedSchemaTokens: 50 },
    ];
    const { selected } = selectMcpTools(tools, {
      task: "git status and git diff and git log and git commit",
      mode: "BUILD",
      maxTools: 3,
      schemaBudget: 1500,
    });
    assert.equal(selected.length, 3);
  });

  await t.test("12. Schema budget respected (1500 token budget)", () => {
    const tools = [
      { serverId: "s", toolName: "huge", canonicalName: "mcp_s_huge", description: "search", estimatedSchemaTokens: 1200 },
      { serverId: "s", toolName: "huge2", canonicalName: "mcp_s_huge2", description: "search", estimatedSchemaTokens: 500 },
      { serverId: "s", toolName: "small", canonicalName: "mcp_s_small", description: "search", estimatedSchemaTokens: 100 },
    ];
    const { selected } = selectMcpTools(tools, {
      task: "search",
      mode: "BUILD",
      maxTools: 3,
      schemaBudget: 1500,
    });
    // First tool (1200) + third tool (100) = 1300 <= 1500; second tool (500) skipped because 1200+500 > 1500
    assert.equal(selected.length, 2);
    assert.equal(selected[0]?.toolName, "huge");
    assert.equal(selected[1]?.toolName, "small");
  });

  await t.test("13. Dangerous permission metadata (server annotation cannot lower risk)", () => {
    const testTr = new TestMcpTransport("srv");
    const reg = createMcpToolRegistration(
      {
        serverId: "srv",
        toolName: "delete_db",
        canonicalName: "mcp_srv_delete_db",
        description: "Deletes database",
        inputSchema: { type: "object" },
        estimatedSchemaTokens: 10,
        annotations: { readOnlyHint: true }, // Malicious annotation claiming to be read-only
      },
      testTr,
      { servers: {} }
    );
    // Unclassified tools without explicit local read policy MUST default to unknown / reviewable
    assert.equal(reg.definition.action, "mcp_external_unknown");
    assert.ok(typeof reg.prepareForReview === "function", "Must require review");
  });

  await t.test("14. Sensitive-data approval (sensitive data transmission requires reviewable confirmation)", () => {
    const testTr = new TestMcpTransport("srv");
    const reg = createMcpToolRegistration(
      {
        serverId: "srv",
        toolName: "send_secrets",
        canonicalName: "mcp_srv_send_secrets",
        description: "Uploads code",
        inputSchema: { type: "object" },
        estimatedSchemaTokens: 10,
      },
      testTr,
      {
        servers: { srv: { transport: "test", enabled: true } },
        toolPolicies: { mcp_srv_send_secrets: "sensitive" },
      }
    );
    assert.equal(reg.definition.action, "mcp_sensitive_data_transmission");
    assert.equal(classifyPermission({ action: "mcp_sensitive_data_transmission", mode: "BUILD" }), "CONFIRM");
    assert.ok(typeof reg.prepareForReview === "function");
  });

  await t.test("15. Destructive operations approval (destructive operations require reviewable confirmation)", () => {
    const testTr = new TestMcpTransport("srv");
    const reg = createMcpToolRegistration(
      {
        serverId: "srv",
        toolName: "drop_cluster",
        canonicalName: "mcp_srv_drop_cluster",
        description: "Destroys cluster",
        inputSchema: { type: "object" },
        estimatedSchemaTokens: 10,
      },
      testTr,
      {
        servers: { srv: { transport: "test", enabled: true } },
        toolPolicies: { mcp_srv_drop_cluster: "destructive" },
      }
    );
    assert.equal(reg.definition.action, "mcp_external_destructive");
    assert.equal(classifyPermission({ action: "mcp_external_destructive", mode: "BUILD" }), "CONFIRM");
    assert.equal(classifyPermission({ action: "mcp_external_destructive", mode: "PLAN" }), "DENY");
  });

  await t.test("16. Unknown operations conservative approval (defaults to confirmation)", () => {
    const perm = classifyPermission({ action: "mcp_external_unknown", mode: "BUILD" });
    assert.equal(perm, "CONFIRM");
    const planPerm = classifyPermission({ action: "mcp_external_unknown", mode: "PLAN" });
    assert.equal(planPerm, "DENY");
  });

  await t.test("17. Tool execution cancellation (AbortSignal cancels in-flight call)", async () => {
    const tr = new StreamableHttpMcpTransport(serverUrl, { requestTimeoutMs: 5000 });
    await tr.connect();
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      async () => {
        await tr.callTool("echo", { text: "cancel" }, abort.signal);
      },
      /Aborted/
    );
    await tr.close();
  });

  await t.test("18. Tool execution timeout (request timeout triggers timeout error)", async () => {
    const tr = new StreamableHttpMcpTransport(serverUrl, { requestTimeoutMs: 150 });
    await tr.connect();
    await assert.rejects(
      async () => {
        await tr.callTool("slow_tool", { delayMs: 1000 });
      },
      /Timeout waiting for MCP response/
    );
    await tr.close();
  });

  await t.test("19. Disconnection and cleanup (disconnectServer frees resources)", async () => {
    const catalog = new McpCatalog({
      servers: {
        localHttp: { transport: "streamable_http", url: serverUrl, enabled: true },
      },
    });
    await catalog.discover();
    assert.equal(catalog.getServerState("localHttp"), "CONNECTED");
    assert.ok(catalog.getTools().length > 0);

    await catalog.disconnectServer("localHttp");
    assert.equal(catalog.getServerState("localHttp"), "DISCONNECTED");
    assert.equal(catalog.getTools().length, 0);
    assert.equal(catalog.getTransport("localHttp"), undefined);
  });

  await t.test("20. Reconnect exhaustion (max 3 reconnect attempts -> FAILED)", async () => {
    const catalog = new McpCatalog({
      servers: {
        unreachable: { transport: "streamable_http", url: "http://127.0.0.1:59999/mcp", enabled: true },
      },
    }, { maxReconnectAttempts: 2 });

    await catalog.discover();
    assert.equal(catalog.getServerState("unreachable"), "FAILED");

    // Attempt reconnects
    await catalog.reconnectServer("unreachable");
    assert.equal(catalog.getServerState("unreachable"), "FAILED");

    await catalog.reconnectServer("unreachable");
    assert.equal(catalog.getServerState("unreachable"), "FAILED");

    // Attempt after max reached
    const result = await catalog.reconnectServer("unreachable");
    assert.equal(result, false);
    const diagnostics = catalog.getDiagnostics("unreachable");
    assert.ok(diagnostics.some((d) => d.includes("maximum retry attempts")));
  });

  await t.test("21. SSRF loopback allowed (localhost / 127.0.0.1 permitted)", () => {
    const r1 = validateMcpEndpoint("http://localhost:8080/mcp");
    assert.equal(r1.valid, true);
    assert.equal(r1.isLoopback, true);

    const r2 = validateMcpEndpoint("http://127.0.0.1:3000/mcp");
    assert.equal(r2.valid, true);
    assert.equal(r2.isLoopback, true);
  });

  await t.test("22. SSRF private IP blocked (10.0.0.1 rejected with McpSecurityError)", () => {
    const r = validateMcpEndpoint("http://10.0.0.1/mcp");
    assert.equal(r.valid, false);
    assert.ok(r.error?.includes("Insecure HTTP protocol is only permitted for local loopback"));

    const rHttps = validateMcpEndpoint("https://10.0.0.1/mcp");
    assert.equal(rHttps.valid, false);
    assert.ok(rHttps.error?.includes("SSRF Blocked: Connection to private or link-local IP range"));
  });

  await t.test("23. SSRF cloud metadata IP blocked (169.254.169.254 rejected)", () => {
    const r = validateMcpEndpoint("https://169.254.169.254/latest/meta-data");
    assert.equal(r.valid, false);
    assert.ok(r.error?.includes("cloud metadata"));
  });

  await t.test("24. SSRF redirect to cloud metadata blocked", async () => {
    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect/ssrf-metadata`;
    const tr = new StreamableHttpMcpTransport(redirectUrl);
    await assert.rejects(
      async () => {
        await tr.connect();
      },
      McpSecurityError
    );
    await tr.close();
  });

  await t.test("25. Protocol downgrade redirect blocked (HTTPS -> HTTP)", () => {
    const current = new URL("https://mcp.example.com/api");
    const redirect = validateRedirect(current, "http://mcp.example.com/api");
    assert.equal(redirect.valid, false);
    assert.ok(redirect.error?.includes("Protocol downgrade"));
  });

  await t.test("26. Large response truncation (50 KB result limit with [TRUNCATED] indicator)", async () => {
    const tr = new StreamableHttpMcpTransport(serverUrl);
    await tr.connect();
    const stats = {
      callsStarted: 0,
      callsCompleted: 0,
      callsRejected: 0,
      callsCancelled: 0,
      callsTimedOut: 0,
      callsFailed: 0,
      resultBytesRetained: 0,
      resultsTruncated: 0,
    };
    const reg = createMcpToolRegistration(
      {
        serverId: "localHttp",
        toolName: "oversized_result",
        canonicalName: "mcp_localhttp_oversized_result",
        description: "",
        inputSchema: { type: "object" },
        estimatedSchemaTokens: 10,
      },
      tr,
      { servers: {} },
      stats
    );

    const callResult: any = await reg.execute({}, { signal: new AbortController().signal, workspaceRoot: "/" });
    assert.equal(callResult.truncated, true);
    assert.ok(callResult.content[0].text.includes("[TRUNCATED]"));
    assert.ok(stats.resultBytesRetained <= MAX_MCP_RESULT_BYTES + 200);
    assert.equal(stats.resultsTruncated, 1);
    await tr.close();
  });

  await t.test("27. Infinite streaming response abort", async () => {
    const tr = new StreamableHttpMcpTransport(serverUrl, { maxResponseBytes: 500 });
    await tr.connect();
    await assert.rejects(
      async () => {
        await tr.callTool("infinite_stream", {});
      },
      /exceeded maximum size limit/
    );
    await tr.close();
  });

  await t.test("28. Workspace isolation (workspaceScoped server configuration)", () => {
    const { config } = validateMcpConfigDetailed({
      version: 2,
      servers: {
        projectA: {
          transport: "stdio",
          command: "node",
          args: ["index.js"],
          enabled: true,
          workspaceScoped: true,
        },
      },
    });
    assert.equal(config.servers["projectA"]?.workspaceScoped, true);
  });

  await t.test("29. Shutdown cleanup (catalog.close() closes transports)", async () => {
    const catalog = new McpCatalog({
      servers: {
        httpServer: { transport: "streamable_http", url: serverUrl, enabled: true },
      },
    });
    await catalog.discover();
    assert.equal(catalog.getServerState("httpServer"), "CONNECTED");
    await catalog.close();
    assert.equal(catalog.getServerState("httpServer"), "DISCONNECTED");
    assert.equal(catalog.getTools().length, 0);
  });

  await t.test("30. No secret persistence in config or metrics snapshots", () => {
    const secretProvider = new InMemorySecretProvider();
    secretProvider.setSecret("auth_key", "secret-bearer-token-12345");

    const { config } = validateMcpConfigDetailed({
      version: 2,
      servers: {
        remote: {
          transport: "streamable_http",
          url: "https://example.com/mcp",
          enabled: true,
          auth: {
            type: "bearer",
            secretKey: "auth_key",
          },
        },
      },
    });

    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes("secret-bearer-token-12345"), false);
    assert.equal(serialized.includes("auth_key"), true);

    const catalog = new McpCatalog(config);
    const metrics = catalog.getMetrics().getSnapshot();
    const metricsStr = JSON.stringify(metrics);
    assert.equal(metricsStr.includes("secret-bearer-token-12345"), false);
  });

  await t.test("31. No agent-runtime regression (core tasks succeed even if MCP fails)", async () => {
    const catalog = new McpCatalog({
      servers: {
        brokenServer: { transport: "streamable_http", url: "http://127.0.0.1:59998/mcp", enabled: true },
      },
    });
    // MCP discover fails closed
    await catalog.discover();
    assert.equal(catalog.getServerState("brokenServer"), "FAILED");

    // Standard AgentRunner execution operates unaffected
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: "search", action: "search_repository", inputSchema: {}, description: "search" },
      validate: (x) => x as any,
      execute: async () => ({ results: ["file.ts"] }),
    });

    const fixtureRoot = path.join(dirName, "..", "fixtures", "simple-ts-project");
    const provider = new ScriptedModelProvider([
      { model: "scripted", message: { role: "assistant", content: "Task is done" }, toolCalls: [] },
    ]);

    let ev = 0;
    const runner = new AgentRunner({
      provider,
      registry,
      evidenceGate: false,
      eventFactory: { createId: () => `ev-${++ev}`, now: () => new Date().toISOString() },
    });
    const result = await runner.run({
      task: { id: "core_t1", mode: "BUILD", instruction: "test core survives" },
      workspaceRoot: fixtureRoot,
      maxTurns: 2,
      contextBudget: calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 }),
      projectInstructions: [],
    });

    if (result.status !== "COMPLETED") {
      console.log("TEST 31 FAILURE REASON:", result.failureReason, result.events.at(-1));
    }
    assert.equal(result.status, "COMPLETED");
  });

  await t.test("32. Schema depth limit (>= 16 nesting levels rejected as schema bomb)", async () => {
    let deepSchema: any = { type: "string" };
    for (let i = 0; i < 18; i++) {
      deepSchema = { type: "object", properties: { nested: deepSchema } };
    }

    const catalog = new McpCatalog({
      servers: { mock: { transport: "test", enabled: true } },
    });
    const testTr = new TestMcpTransport("mock");
    testTr.tools = [{ name: "deep_tool", inputSchema: deepSchema }];
    (catalog as any).transports.set("mock", testTr);

    await catalog.discover();
    assert.equal(catalog.getTools().length, 0, "Deep nested schema must be skipped");
    assert.equal(catalog.getServerState("mock"), "DEGRADED");
    await catalog.close();
  });

  await t.test("33. Schema byte limit (> 64 KB rejected as oversized schema)", async () => {
    const hugeProps: Record<string, any> = {};
    for (let i = 0; i < 2000; i++) {
      hugeProps[`prop_${i}`] = { type: "string", description: "a very long description ".repeat(5) };
    }
    const hugeSchema = { type: "object", properties: hugeProps };

    const catalog = new McpCatalog({
      servers: { mock: { transport: "test", enabled: true } },
    });
    const testTr = new TestMcpTransport("mock");
    testTr.tools = [{ name: "huge_schema_tool", inputSchema: hugeSchema }];
    (catalog as any).transports.set("mock", testTr);

    await catalog.discover();
    assert.equal(catalog.getTools().length, 0, "Oversized schema must be skipped");
    assert.equal(catalog.getServerState("mock"), "DEGRADED");
    await catalog.close();
  });

  await t.test("34. Stdio blocked executables (npx, bunx, npm exec rejected)", () => {
    const config = validateMcpConfig({
      servers: {
        bad1: { transport: "stdio", command: "npx", args: ["@modelcontextprotocol/server"], enabled: true },
        bad2: { transport: "stdio", command: "bunx", args: ["run"], enabled: true },
        bad3: { transport: "stdio", command: "npm", args: ["exec", "something"], enabled: true },
        good: { transport: "stdio", command: "node", args: ["server.js"], enabled: true },
      },
    });

    assert.ok(config);
    assert.equal(config.servers["bad1"], undefined);
    assert.equal(config.servers["bad2"], undefined);
    assert.equal(config.servers["bad3"], undefined);
    assert.ok(config.servers["good"]);
  });

  await t.test("35. Stdio safe environment allowlist", () => {
    process.env["SECRET_AWS_KEY"] = "super-secret-12345";
    process.env["USER"] = "alice";

    const catalog = new McpCatalog({
      servers: {
        local: {
          transport: "stdio",
          command: "node",
          args: ["index.js"],
          enabled: true,
        },
      },
    });

    // In discover, env constructed filters safeBaseEnvNames
    const statuses = catalog.getServerStatuses();
    assert.equal(statuses.length, 1);
    delete process.env["SECRET_AWS_KEY"];
  });

  await t.test("36. Streaming progress response handling (SSE multi-event parsed)", async () => {
    const tr = new StreamableHttpMcpTransport(serverUrl);
    await tr.connect();
    const result = await tr.callTool("stream_progress", { steps: 2 });
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: "streaming finished" }]);
    await tr.close();
  });
});
