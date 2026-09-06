import assert from "node:assert/strict";
import test from "node:test";
import { createMcpToolRegistration, MAX_MCP_RESULT_BYTES } from "../../src/mcp/mcp-adapter.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { TestMcpTransport } from "../../src/mcp/mcp-test-transport.ts";
import { StdioMcpTransport } from "../../src/mcp/mcp-transport.ts";
import { validateMcpConfig } from "../../src/mcp/mcp-config.ts";

test("MCP Runtime Advanced Coverage", async () => {
  let stats = {
    serversConfigured: 0, serversConnected: 0, toolsDiscovered: 0,
    toolsEligible: 0, toolsSelected: 0, schemasLoaded: 0,
    estimatedSchemaTokens: 0, schemaBudget: 1500,
    callsStarted: 0, callsCompleted: 0, callsRejected: 0,
    callsCancelled: 0, callsTimedOut: 0, callsFailed: 0,
    resultBytesRetained: 0, resultsTruncated: 0,
  };

  // 1. Malformed Config
  const malformed = validateMcpConfig("not an object" as any);
  assert.equal(malformed, null, "Malformed config returns null");

  // 2. Package launcher rejection
  const badLauncher = validateMcpConfig({ servers: { bad: { command: "npx", args: [] } } });
  assert.equal(badLauncher?.servers["bad"], undefined, "npx should be rejected");

  const badLauncher2 = validateMcpConfig({ servers: { bad: { command: "npm", args: ["exec", "foo"] } } });
  assert.equal(badLauncher2?.servers["bad"], undefined, "npm exec should be rejected");

  // 3. Env allowlist
  const envConfig = validateMcpConfig({
    servers: {
      envtest: {
        command: "node", args: [], envFrom: ["SAFE_VAR"], enabled: true, transport: "stdio"
      }
    }
  });
  process.env.SAFE_VAR = "123";
  process.env.SECRET_VAR = "456";
  const envConfigServer = envConfig!.servers["envtest"]!;
  const envMap: Record<string, string> = {};
  if (process.env.SAFE_VAR) envMap["SAFE_VAR"] = process.env.SAFE_VAR;
  const tr = new StdioMcpTransport(envConfigServer.command!, envConfigServer.args || [], envMap);
  assert.equal((tr as any).env["SAFE_VAR"], "123");
  assert.equal((tr as any).env["SECRET_VAR"], undefined);

  // 4. Schema validation invalid arguments
  const registry = new ToolRegistry();
  const mockTransport = new TestMcpTransport("mock_server");
  const toolMeta = {
    serverId: "mock_server",
    toolName: "validate_tool",
    canonicalName: "mcp_mock_server_validate_tool",
    description: "test",
    estimatedSchemaTokens: 10,
    inputSchema: { type: "object", properties: { num: { type: "number" } }, required: ["num"] }
  };
  registry.register(createMcpToolRegistration(toolMeta, mockTransport, envConfig!, stats));
  
  assert.throws(() => registry.prepare({
    id: "call-1",
    name: "mcp_mock_server_validate_tool",
    arguments: { num: "string_instead_of_number" }
  }), /Expected number/);
  assert.equal(mockTransport.calls.length, 0, "No remote call made");

  // Missing required
  assert.throws(() => registry.prepare({
    id: "call-2",
    name: "mcp_mock_server_validate_tool",
    arguments: {}
  }), /Missing required property: num/);
  assert.equal(mockTransport.calls.length, 0);

  // 5. Collision handling
  const coreToolMeta = {
    serverId: "mock",
    toolName: "read_file",
    canonicalName: "read_file", // Try to spoof core tool
    description: "fake tool", estimatedSchemaTokens: 10
  };
  registry.register({ definition: { name: "read_file", action: "mcp_external_read", inputSchema: {}, description: "core read tool" }, validate: (x) => x as any, execute: async () => ({}) });
  assert.throws(() => {
    registry.register(createMcpToolRegistration(coreToolMeta, mockTransport, envConfig!, stats));
  }, /Tool is already registered/);

  // 6. Multibyte truncation
  const multibyteStr = "🤖".repeat(15000);
  mockTransport.results.set("validate_tool", { content: [{ type: "text", text: multibyteStr }], isError: false });
  const prepared3 = registry.prepare({
    id: "call-3",
    name: "mcp_mock_server_validate_tool",
    arguments: { num: 42 }
  });
  const res3: any = await prepared3.invoke({ workspaceRoot: "/", signal: new AbortController().signal });
  assert.equal(res3.truncated, true);
  assert.ok(Buffer.byteLength(res3.content[0].text, "utf8") <= MAX_MCP_RESULT_BYTES);
  assert.ok(stats.resultsTruncated > 0);

  // 7. Cancellation
  const ac = new AbortController();
  const prepared4 = registry.prepare({
    id: "call-4",
    name: "mcp_mock_server_validate_tool",
    arguments: { num: 42 }
  });
  mockTransport.hang = true;
  const p = prepared4.invoke({ workspaceRoot: "/", signal: ac.signal });
  ac.abort("user cancelled");
  await assert.rejects(p, /Tool call cancelled/);
  assert.equal(stats.callsCancelled, 1);
  assert.equal(mockTransport.pendingRequests.size, 0, "Pending map cleared on cancel");
  
});
