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
  const wire = formatWireMessages(messages) as ReadonlyArray<{ tool_calls?: ReadonlyArray<{ function?: { name?: string; arguments?: string } }>; tool_call_id?: string }>
  assert.equal(wire[1]?.tool_calls?.[0]?.function?.name, "read_file")
  assert.equal(wire[1]?.tool_calls?.[0]?.function?.arguments, JSON.stringify({ path: "src/add.js" }))
  assert.equal(wire[2]?.tool_call_id, "call-1")
})

test("runner gate notices are user messages, never fabricated assistant tool calls (HALO rejects unknown call names)", () => {
  const messages = buildNativeToolMessages({
    promptContent: "Fix sum.ts",
    toolCalls: [{ id: "call_r1", name: "read_file", outcome: "COMPLETED", arguments: { path: "src/sum.ts" } }],
    observations: [
      { toolName: "read_file", callId: "call_r1", ok: true, content: "export function sum() {}", truncated: false, provenance: { kind: "tool", paths: ["src/sum.ts"] } },
      { toolName: "coding_gate", callId: "edit-gate-1", ok: false, content: "[EDIT REQUIRED] apply the change", truncated: false, provenance: { kind: "tool", paths: [] }, errorCategory: "EDIT_REQUIRED" },
    ],
  })
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "user"])
  assert.equal(messages.some((message) => message.toolCalls?.some((call) => call.name === "coding_gate")), false)
  assert.match(messages[3]?.content || "", /^\[coding_gate\] ERROR EDIT_REQUIRED: /)
})
