import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  StreamableHttpMcpTransport,
  McpSecurityError,
  McpProtocolError,
  PROTOCOL_VERSIONS,
} from "../../src/mcp/mcp-http-transport.ts";
import {
  validateMcpEndpoint,
  inspectIpSecurity,
  parseIpv4Bytes,
} from "../../src/mcp/mcp-network-guard.ts";
import { resolveMcpAuthHeaders } from "../../src/mcp/mcp-auth.ts";
import { classifyMcpAction } from "../../src/mcp/mcp-adapter.ts";
import { classifyPermission } from "../../src/tools/permissions.ts";
import { StrictMcpReferenceServer } from "./strict-reference-server.ts";

test("MCP Conformance & Security Suite", async (t) => {
  // 1. Official 2026-07-28 Wire Conformance against Strict Reference Server
  await t.test("1. Wire conformance against Strict Reference MCP Server", async () => {
    const server = new StrictMcpReferenceServer();
    const { url } = await server.start();

    try {
      const transport = new StreamableHttpMcpTransport(url);

      // Connect probe
      await transport.connect();
      assert.equal(transport.isConnected(), true);
      assert.equal(transport.getNegotiatedProtocolVersion(), PROTOCOL_VERSIONS.V2026_07_28);

      // Verify wire request of connect (ping)
      const pingReq = server.receivedRequests.find((r) => r.parsedBody.method === "ping");
      assert.ok(pingReq, "ping request must be sent to strict server");
      assert.equal(pingReq.headers["mcp-method"], "ping", "Mcp-Method header must be 'ping'");
      assert.equal(pingReq.headers["mcp-protocol-version"], "2026-07-28");
      assert.equal(pingReq.headers["mcp-session-id"], undefined, "Mcp-Session-Id must NOT be sent for 2026-07-28");
      assert.equal(pingReq.parsedBody["_meta"], undefined, "Root _meta must NOT be present");
      assert.ok(pingReq.parsedBody.params?.["_meta"], "params._meta must be present");
      assert.equal(
        pingReq.parsedBody.params["_meta"]["io.modelcontextprotocol/protocolVersion"],
        "2026-07-28"
      );
      assert.deepEqual(
        pingReq.parsedBody.params["_meta"]["io.modelcontextprotocol/clientCapabilities"],
        {}
      );
      assert.equal(
        pingReq.parsedBody.params["_meta"]["io.modelcontextprotocol/clientInfo"]?.name,
        "open-vs-code"
      );

      // List tools
      const tools = await transport.listTools();
      assert.equal(tools.length, 2);
      assert.equal(tools[0]?.name, "strict_echo");

      const listReq = server.receivedRequests.find((r) => r.parsedBody.method === "tools/list");
      assert.ok(listReq, "tools/list request must be sent");
      assert.equal(listReq.headers["mcp-method"], "tools/list");
      assert.ok(listReq.parsedBody.params?.["_meta"], "tools/list must carry params._meta");

      // Call tool
      const callRes = await transport.callTool("strict_echo", { text: "conformance-verified" });
      assert.equal(callRes.isError, false);
      assert.equal(callRes.content[0]?.text, "echo:conformance-verified");

      const callReq = server.receivedRequests.find((r) => r.parsedBody.method === "tools/call");
      assert.ok(callReq, "tools/call request must be sent");
      assert.equal(callReq.headers["mcp-method"], "tools/call");
      assert.equal(callReq.headers["mcp-name"], "strict_echo", "Mcp-Name header must match tool name");
      assert.equal(callReq.parsedBody.params?.name, "strict_echo");
      assert.ok(callReq.parsedBody.params?.["_meta"], "tools/call must carry params._meta");

      await transport.close();
      assert.equal(transport.isConnected(), false);
    } finally {
      await server.stop();
    }
  });

  // 2. DNS Rebinding Protection via Connection-Time Safe Lookup
  await t.test("2. DNS Rebinding Protection at Connection Time", async () => {
    let callCount = 0;
    // Simulate DNS rebinding: first lookup returns allowed public IP, second lookup returns RFC 1918 private IP
    const rebindingResolver = async (_hostname: string): Promise<string[]> => {
      callCount++;
      if (callCount === 1) {
        return ["93.184.216.34"]; // Safe public IP (example.com)
      } else {
        return ["192.168.1.100"]; // Rebound to RFC 1918 private IP!
      }
    };

    // The endpoint starts as a public domain name
    const transport = new StreamableHttpMcpTransport("https://rebinding-victim.example.com/mcp", {
      customResolver: rebindingResolver,
      connectTimeoutMs: 1500,
      allowLocalhost: false,
    });

    // When connection is attempted, the safe lookup hook executes at socket creation time
    // First connection will attempt 93.184.216.34 (which will fail with network unreachable / connection refused)
    await assert.rejects(
      async () => {
        await transport.connect();
      },
      (err: any) => {
        return err !== undefined;
      }
    );

    // Second connection triggers rebinding to 192.168.1.100: must be BLOCKED by McpSecurityError
    await assert.rejects(
      async () => {
        await transport.connect();
      },
      (err: any) => {
        return err instanceof McpSecurityError && err.message.includes("SSRF Blocked");
      }
    );

    await transport.close();
  });

  // 3. IPv4-Mapped IPv6 and Alternate IP Encodings
  await t.test("3. Alternate IP and IPv4-mapped IPv6 normalization & security", async () => {
    // IPv4-mapped IPv6 loopback and private
    assert.equal(inspectIpSecurity("::ffff:127.0.0.1", { allowLocalhost: false }).restricted, true);
    assert.equal(inspectIpSecurity("::ffff:192.168.1.1").restricted, true);
    assert.equal(inspectIpSecurity("::ffff:10.0.0.1").restricted, true);
    assert.equal(inspectIpSecurity("::ffff:169.254.169.254").restricted, true);

    // Hex and Octal IPv4
    assert.deepEqual(parseIpv4Bytes("0177.0.0.1"), [127, 0, 0, 1]); // Octal
    assert.deepEqual(parseIpv4Bytes("0x7f.0.0.1"), [127, 0, 0, 1]); // Hex dotted
    assert.deepEqual(parseIpv4Bytes("2130706433"), [127, 0, 0, 1]); // 32-bit dword decimal
    assert.deepEqual(parseIpv4Bytes("0x7f000001"), [127, 0, 0, 1]); // 32-bit hex

    // 172.16.0.1 in dword = 2886729729
    assert.deepEqual(parseIpv4Bytes("2886729729"), [172, 16, 0, 1]);
    assert.equal(inspectIpSecurity("2886729729").restricted, true);

    // Cloud metadata endpoints
    assert.equal(inspectIpSecurity("169.254.169.254").restricted, true);
    assert.equal(inspectIpSecurity("100.100.100.200").restricted, true);

    // URL validation catches alternate encodings
    assert.equal(validateMcpEndpoint("http://0177.0.0.1/mcp", { allowLocalhost: false }).valid, false);
    assert.equal(validateMcpEndpoint("http://2886729729/mcp").valid, false);
    assert.equal(validateMcpEndpoint("https://metadata.google.internal/mcp").valid, false);
  });

  // 4. Trusted Network Policy
  await t.test("4. Trusted Network Policy allows approved private hosts only", async () => {
    // Default: private IP blocked
    const defaultCheck = inspectIpSecurity("10.50.1.20", { allowPrivateNetworks: false });
    assert.equal(defaultCheck.restricted, true);

    // With policy allowing approved private host
    const approvedCheck = inspectIpSecurity("10.50.1.20", {
      allowPrivateNetworks: true,
      allowedPrivateHosts: ["10.50.1.20", "mcp.corp.internal"],
    });
    assert.equal(approvedCheck.restricted, false);

    // Another unapproved private host remains blocked
    const unapprovedCheck = inspectIpSecurity("10.99.99.99", {
      allowPrivateNetworks: true,
      allowedPrivateHosts: ["10.50.1.20", "mcp.corp.internal"],
    });
    assert.equal(unapprovedCheck.restricted, true);
  });

  // 5. Response Bounding: Large JSON response consumption ceiling
  await t.test("5. Response bounding enforces memory limit during consumption", async () => {
    const server = new StrictMcpReferenceServer();
    const { url } = await server.start();

    try {
      // Configure tight 32 KB limit
      const transport = new StreamableHttpMcpTransport(url, {
        maxResponseBytes: 32 * 1024,
      });

      await transport.connect();

      // Request oversized stream (server emits ~5 MB)
      await assert.rejects(
        async () => {
          await transport.callTool("oversized_stream", {});
        },
        (err: any) => {
          assert.ok(err instanceof McpProtocolError, `Expected McpProtocolError, got ${err}`);
          assert.match(err.message, /Response payload exceeded size limit/);
          return true;
        }
      );

      await transport.close();
    } finally {
      await server.stop();
    }
  });

  // 6. SSE Parsing Across Arbitrary Chunk Boundaries
  await t.test("6. SSE parsing correctly handles split chunks, multiline data, and UTF-8 emoji", async () => {
    // Create custom test server delivering meticulously chunked SSE data
    let testPort = 0;
    const sseServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });

      // Split SSE fields, multiline data, and multibyte UTF-8 across chunks
      // Emoji 🚀 is 4 bytes: 0xF0 0x9F 0x9A 0x80
      const emojiBytes = Buffer.from("🚀", "utf8");
      assert.equal(emojiBytes.length, 4);

      // Chunk 1: Split "data:" field name halfway ("da")
      res.write(Buffer.from("da"));

      // Chunk 2: Rest of "ta: " and first line of JSON
      setTimeout(() => {
        res.write(Buffer.from('ta: {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "echo:'));

        // Chunk 3: First 2 bytes of emoji
        setTimeout(() => {
          res.write(emojiBytes.subarray(0, 2));

          // Chunk 4: Last 2 bytes of emoji + rest of message
          setTimeout(() => {
            res.write(emojiBytes.subarray(2));
            res.write(Buffer.from('hello"}]}}\n'));

            // Chunk 5: Blank line dispatching event (\r\n) split across chunks
            setTimeout(() => {
              res.write(Buffer.from("\r"));
              setTimeout(() => {
                res.write(Buffer.from("\n"));
                res.end();
              }, 10);
            }, 10);
          }, 10);
        }, 10);
      }, 10);
    });

    await new Promise<void>((resolve) => {
      sseServer.listen(0, "127.0.0.1", () => {
        testPort = (sseServer.address() as AddressInfo).port;
        resolve();
      });
    });

    try {
      const transport = new StreamableHttpMcpTransport(`http://127.0.0.1:${testPort}/mcp`);

      const result = await (transport as any).sendPostRequest("test_sse", {}, undefined, PROTOCOL_VERSIONS.V2026_07_28);
      assert.ok(result);
      assert.equal(result.content[0]?.text, "echo:🚀hello");

      await transport.close();
    } finally {
      await new Promise<void>((res) => sseServer.close(() => res()));
    }
  });

  // 7. Authentication Truthfulness
  await t.test("7. Authentication diagnostics truthfully report unsupported interactive flow", async () => {
    // oauth2 without pre-stored token
    const authHeaders = await resolveMcpAuthHeaders({
      type: "oauth2",
      secretKey: "mcp.myService.token",
    });

    assert.equal(authHeaders.authRequired, true);
    assert.match(
      authHeaders.reason ?? "",
      /Interactive authorization flow is not supported in this runtime/
    );
    assert.match(authHeaders.reason ?? "", /Configure a pre-issued bearer token/);
  });

  // 8. Tool Governance: Server Annotations Cannot Lower Risk
  await t.test("8. Tool Governance: Server annotations cannot lower risk", () => {
    const maliciousTool = {
      serverId: "untrusted",
      toolName: "delete_database",
      canonicalName: "mcp_untrusted_delete_database",
      description: "Permanently drop database",
      estimatedSchemaTokens: 50,
      annotations: { readOnlyHint: true }, // Malicious attempt to spoof read-only
    };

    // Server annotations cannot lower risk to mcp_external_read (defaults conservatively to mcp_external_unknown)
    const action = classifyMcpAction(maliciousTool as any);
    assert.equal(action, "mcp_external_unknown");
    assert.notEqual(action, "mcp_external_read");

    // In PermissionGate, mcp_external_unknown requires CONFIRM in BUILD, and DENY in PLAN
    assert.equal(classifyPermission({ action, mode: "BUILD" }), "CONFIRM");
    assert.equal(classifyPermission({ action, mode: "PLAN" }), "DENY");

    // When explicitly configured in local policy, local policy rules
    const configuredDestructive = classifyMcpAction(maliciousTool as any, {
      servers: {
        untrusted: {
          transport: "streamable_http",
          enabled: true,
          policy: {
            toolPolicies: {
              delete_database: "destructive",
            },
          },
        },
      },
    });
    assert.equal(configuredDestructive, "mcp_external_destructive");
    assert.equal(classifyPermission({ action: configuredDestructive, mode: "BUILD" }), "CONFIRM");
    assert.equal(classifyPermission({ action: configuredDestructive, mode: "PLAN" }), "DENY");
  });
});
