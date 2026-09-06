import assert from "node:assert/strict";
import test from "node:test";
import { McpCatalog } from "../../src/mcp/mcp-catalog.ts";
import { selectMcpTools } from "../../src/mcp/mcp-selector.ts";
import { createMcpToolRegistration, MAX_MCP_RESULT_BYTES } from "../../src/mcp/mcp-adapter.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { TestMcpTransport } from "../../src/mcp/mcp-test-transport.ts";
import type { McpConfig } from "../../src/mcp/mcp-config.ts";

test("MCP Runtime Scorecard and structural identity", async () => {
  const config: McpConfig = {
    servers: {
      "mock_server": {
        command: "node",
        args: ["dummy.js"],
        transport: "stdio",
        enabled: true
      }
    },
    toolPolicies: {
      "mcp_mock_server_test_tool": "side_effect",
      "mcp_mock_server_read_tool": "read"
    }
  };

  const stats = {
    callsStarted: 0,
    callsCompleted: 0,
    callsRejected: 0,
    callsCancelled: 0,
    callsTimedOut: 0, callsFailed: 0,
    resultBytesRetained: 0,
    resultsTruncated: 0,
  };

  // Mock catalog to return TestMcpTransport instead of real Stdio
  class MockCatalog extends McpCatalog {
    public mockTransport = new TestMcpTransport("mock_server");
    
    constructor(cfg: McpConfig) {
      super(cfg);
      this.mockTransport.tools = [
        {
          name: "test_tool",
          description: "A test tool",
          inputSchema: { type: "object", properties: { x: { type: "string" } } }
        },
        {
          name: "read_tool",
          description: "A read tool",
          inputSchema: { type: "object", properties: { y: { type: "string" } } }
        }
      ];
      // Map it to transport
      (this as any).transports.set("mock_server", this.mockTransport);
    }
    
    async discover() {
      // Simulate discovery bypassing stdio
      const discovered = [];
      const serverId = "mock_server";
      for (const t of this.mockTransport.tools) {
        const canonicalName = `mcp_${serverId}_${t.name}`;
        const meta = {
          serverId,
          toolName: t.name,
          canonicalName,
          description: t.description || "",
          inputSchema: t.inputSchema || {},
          estimatedSchemaTokens: 10,
        };
        (this as any).tools.set(canonicalName, meta);
        discovered.push(meta);
      }
    }
  }

  const catalog = new MockCatalog(config);
  await catalog.discover();
  
  const allMcpTools = catalog.getTools();
  assert.equal(allMcpTools.length, 2);

  const selected = selectMcpTools(allMcpTools, {
    task: "test_tool read_tool",
    mode: "BUILD",
    maxTools: 3
  }).selected;
  
  assert.equal(selected.length, 2);

  const registry = new ToolRegistry();
  for (const mcpTool of selected) {
    const transport = catalog.getTransport(mcpTool.serverId);
    if (transport) {
      registry.register(createMcpToolRegistration(mcpTool, transport, config, stats));
    }
  }

  const defs = registry.listDefinitions();
  assert.equal(defs.length, 2);
  const readDef = defs.find(d => d.name === "mcp_mock_server_read_tool");
  assert.ok(readDef);
  assert.equal(readDef.action, "mcp_external_read"); // per toolPolicies
  
  const writeDef = defs.find(d => d.name === "mcp_mock_server_test_tool");
  assert.ok(writeDef);
  assert.equal(writeDef.action, "mcp_external_side_effect"); // per toolPolicies

  // Execute read
  const preparedRead = registry.prepare({
    id: "call-1",
    name: "mcp_mock_server_read_tool",
    arguments: { y: "hello" }
  });
  const readResult: any = await preparedRead.invoke({ workspaceRoot: "/", signal: new AbortController().signal });
  assert.equal(readResult.content[0].text, "Success");
  assert.equal(stats.callsStarted, 1);
  assert.equal(stats.callsCompleted, 1);

  // Execute write
  const preparedWrite = registry.prepare({
    id: "call-2",
    name: "mcp_mock_server_test_tool",
    arguments: { x: "world" }
  });
  
  assert.ok(preparedWrite.prepareForReview, "Side effect must have prepareForReview");
  const reviewable = await preparedWrite.prepareForReview({ workspaceRoot: "/", signal: new AbortController().signal });
  assert.equal((reviewable.reviewPayload as any).risk, "mcp_external_side_effect");

  const writeResult: any = await reviewable.apply({ workspaceRoot: "/", signal: new AbortController().signal });
  assert.equal(writeResult.content[0].text, "Success");
  assert.equal(stats.callsStarted, 2);
  assert.equal(stats.callsCompleted, 2);

  // Test truncation
  catalog.mockTransport.results.set("read_tool", {
    content: [{ type: "text", text: "x".repeat(MAX_MCP_RESULT_BYTES + 10000) }],
    isError: false
  });
  
  const preparedTruncated = registry.prepare({
    id: "call-3",
    name: "mcp_mock_server_read_tool",
    arguments: { y: "hello" }
  });
  const truncResult: any = await preparedTruncated.invoke({ workspaceRoot: "/", signal: new AbortController().signal });
  assert.equal(truncResult.truncated, true);
  assert.ok(truncResult.content[0].text.includes("[TRUNCATED]"));
  assert.equal(stats.resultsTruncated, 1);

});
