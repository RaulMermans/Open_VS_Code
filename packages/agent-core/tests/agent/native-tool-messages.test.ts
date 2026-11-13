import test from "node:test"
import assert from "node:assert/strict"
import { buildNativeToolMessages, resolveConversationEncoding } from "../../src/agent/native-tool-messages.ts"
import { formatWireMessages } from "../../src/model/protocol.ts"

test("native tool messages stay off unless explicitly selected", () => {
  assert.equal(resolveConversationEncoding(undefined, {}), "compiled-user")
  assert.equal(resolveConversationEncoding(undefined, { OPEN_VS_CODE_NATIVE_TOOL_MESSAGES: "1" }), "native-tool-messages")
  assert.equal(resolveConversationEncoding("compiled-user", { OPEN_VS_CODE_NATIVE_TOOL_MESSAGES: "1" }), "compiled-user")
})

test("tool results are attributed as tool messages instead of one user blob", () => {
  const messages = buildNativeToolMessages({
    promptContent: "Fix add.js",
    observations: [
      {
        toolName: "read_file",
        callId: "call-1",
        ok: true,
        content: "export function add(a, b) { return a + b + 1 }",
        truncated: false,
        provenance: { kind: "tool", paths: ["src/add.js"] },
        arguments: { path: "src/add.js" },
      },
      {
        toolName: "run_verification",
        callId: "call-2",
        ok: false,
        content: "not ok 1",
        truncated: false,
        provenance: { kind: "tool", paths: [] },
        errorCategory: "VERIFICATION_FAILED",
      },
    ],
  })
  assert.equal(messages[0]?.role, "user")
  assert.equal(messages[1]?.role, "assistant")
  assert.equal(messages[1]?.toolCalls?.[0]?.id, "call-1")
  assert.equal(messages[2]?.role, "tool")
  assert.equal(messages[2]?.toolCallId, "call-1")
  assert.equal(messages[3]?.role, "assistant")
  assert.equal(messages[4]?.role, "tool")
  assert.match(messages[4]?.content || "", /VERIFICATION_FAILED/)
  const wire = formatWireMessages(messages)
  assert.equal(wire[1]?.tool_calls?.[0]?.function?.name, "read_file")
  assert.equal(wire[1]?.tool_calls?.[0]?.function?.arguments, JSON.stringify({ path: "src/add.js" }))
  assert.equal(wire[2]?.tool_call_id, "call-1")
})
