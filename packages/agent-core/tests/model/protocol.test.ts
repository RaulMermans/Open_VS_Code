import test from "node:test"
import assert from "node:assert/strict"
import { normalizeWireResponse, formatWireTools, formatWireMessages } from "../../src/model/protocol.ts"
import { ModelProviderError } from "../../src/model/openai-compatible.ts"
import { PROTOCOL_FIXTURES } from "../fixtures/protocol-fixtures.ts"
import type { ToolDefinition } from "../../src/contracts/tools.ts"

test("protocol normalizer handles normal assistant response with usage", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.normalAssistantResponse)
  assert.equal(normalized.model, "qwen2.5-coder:7b")
  assert.equal(normalized.message.role, "assistant")
  assert.equal(normalized.message.content, "Hello! I am ready to inspect the repository.")
  assert.equal(normalized.finishReason, "stop")
  assert.deepEqual(normalized.usage, { inputTokens: 150, outputTokens: 12 })
  assert.equal(normalized.toolCalls, undefined)
  assert.equal(normalized.metadata?.id, "chatcmpl-001")
})

test("protocol normalizer decodes single tool call with JSON string arguments", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.singleToolCallJsonString)
  assert.equal(normalized.model, "qwen2.5-coder:7b")
  assert.equal(normalized.message.role, "assistant")
  assert.equal(normalized.message.content, "")
  assert.equal(normalized.finishReason, "tool_calls")
  assert.deepEqual(normalized.usage, { inputTokens: 220, outputTokens: 24 })
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.id, "call_read_001")
  assert.equal(normalized.toolCalls[0]!.name, "read_file")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { path: "README.md" })
})

test("protocol normalizer decodes single tool call with already structured object arguments", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.singleToolCallStructuredObject)
  assert.equal(normalized.model, "local-proxy-model")
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.name, "search_text")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { query: "authenticateUser" })
})

test("protocol normalizer decodes multiple tool calls in one turn", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.multipleToolCalls)
  assert.equal(normalized.message.content, "Let me check both files at once.")
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 2)
  assert.equal(normalized.toolCalls[0]!.id, "call_multi_1")
  assert.equal(normalized.toolCalls[0]!.name, "read_file")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { path: "src/a.ts" })
  assert.equal(normalized.toolCalls[1]!.id, "call_multi_2")
  assert.equal(normalized.toolCalls[1]!.name, "read_file")
  assert.deepEqual(normalized.toolCalls[1]!.arguments, { path: "src/b.ts" })
})

test("protocol normalizer handles null content with tool call", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.nullContentWithToolCall)
  assert.equal(normalized.message.content, "")
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.name, "find_files")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, {})
})

test("protocol normalizer generates synthetic ID when backend omits tool call ID", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.toolCallMissingId)
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.id, "call_1")
  assert.equal(normalized.toolCalls[0]!.name, "list_directory")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { path: "." })
})

test("protocol normalizer decodes legacy function_call format", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.legacyFunctionCall)
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.id, "call_1")
  assert.equal(normalized.toolCalls[0]!.name, "read_file")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { path: "package.json" })
})

test("protocol normalizer preserves extra unknown metadata safely", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.extraUnknownMetadata)
  assert.equal(normalized.metadata?.systemFingerprint, "fp_ollama_v032")
  assert.equal(normalized.metadata?.id, "chatcmpl-009")
})

test("protocol normalizer safely tags unparseable JSON tool arguments", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.malformedArgumentsJson)
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls[0]!.name, "read_file")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { __malformedJson: "{ path: unquoted_invalid_json }" })
})

test("protocol normalizer decodes concatenated JSON tool calls from local models", () => {
  const normalized = normalizeWireResponse({
    model: "qwen2.5-coder:7b",
    choices: [{
      message: {
        role: "assistant",
        content: "{\"name\": \"read_file\", \"arguments\": {\"path\": \"src/format-note.ts\"}}\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"package.json\"}}",
      },
    }],
  })
  assert.equal(normalized.toolCalls?.length, 2)
  assert.equal(normalized.toolCalls?.[0]?.name, "read_file")
  assert.deepEqual(normalized.toolCalls?.[0]?.arguments, { path: "src/format-note.ts" })
  assert.equal(normalized.toolCalls?.[1]?.name, "read_file")
  assert.deepEqual(normalized.toolCalls?.[1]?.arguments, { path: "package.json" })
  assert.equal(normalized.message.content, "")
})

test("protocol normalizer leaves prose that merely contains JSON as text", () => {
  const content = "The file starts with { \"name\": \"notes\" } and then continues."
  const normalized = normalizeWireResponse({
    model: "qwen2.5-coder:7b",
    choices: [{ message: { role: "assistant", content } }],
  })
  assert.equal(normalized.toolCalls, undefined)
  assert.equal(normalized.message.content, content)
})

test("protocol normalizer decodes content JSON tool call", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.contentJsonToolCall)
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.id, "call_1")
  assert.equal(normalized.toolCalls[0]!.name, "list_directory")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { path: "." })
})

test("protocol normalizer decodes tool call from <tool_call> tags", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.contentToolCallTags)
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.id, "call_1")
  assert.equal(normalized.toolCalls[0]!.name, "read_file")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { path: "README.md" })
})

test("protocol normalizer decodes tool call from markdown code fence", () => {
  const normalized = normalizeWireResponse(PROTOCOL_FIXTURES.contentMarkdownJsonToolCall)
  assert.ok(normalized.toolCalls)
  assert.equal(normalized.toolCalls.length, 1)
  assert.equal(normalized.toolCalls[0]!.id, "call_1")
  assert.equal(normalized.toolCalls[0]!.name, "search_text")
  assert.deepEqual(normalized.toolCalls[0]!.arguments, { query: "test" })
})

test("protocol normalizer rejects malformed choices, non-array tool_calls, and backend errors", () => {
  assert.throws(() => normalizeWireResponse(PROTOCOL_FIXTURES.backendErrorResponse), (err) => {
    return err instanceof ModelProviderError && err.code === "HTTP_ERROR" && err.status === 404
  })

  assert.throws(() => normalizeWireResponse(PROTOCOL_FIXTURES.missingChoices), (err) => {
    return err instanceof ModelProviderError && err.code === "MALFORMED_RESPONSE"
  })

  assert.throws(() => normalizeWireResponse(PROTOCOL_FIXTURES.malformedToolCallsNotArray), (err) => {
    return err instanceof ModelProviderError && err.code === "MALFORMED_RESPONSE"
  })

  assert.throws(() => normalizeWireResponse(PROTOCOL_FIXTURES.malformedToolCallMissingName), (err) => {
    return err instanceof ModelProviderError && err.code === "MALFORMED_RESPONSE"
  })

  assert.throws(() => normalizeWireResponse(PROTOCOL_FIXTURES.emptyAssistantMessageWithoutTools), (err) => {
    return err instanceof ModelProviderError && err.code === "MALFORMED_RESPONSE"
  })
})

test("formatWireTools formats tool definitions into OpenAI function schema", () => {
  const tools: readonly ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read file contents",
      action: "read_repository",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ]
  const formatted = formatWireTools(tools)
  assert.ok(formatted)
  assert.equal(formatted.length, 1)
  assert.equal(formatted[0]!.type, "function")
  assert.equal(formatted[0]!.function.name, "read_file")
  assert.equal(formatted[0]!.function.description, "Read file contents")
  assert.deepEqual(formatted[0]!.function.parameters, tools[0]!.inputSchema)
})

test("formatWireMessages converts messages preserving roles and tool_call_id", () => {
  const formatted = formatWireMessages([
    { role: "system", content: "You are an assistant" },
    { role: "user", content: "Check file" },
    { role: "assistant", content: "" },
    { role: "tool", content: "file content", toolCallId: "call_123" },
  ])
  assert.equal(formatted.length, 4)
  assert.equal(formatted[3]!.role, "tool")
  assert.equal(formatted[3]!.tool_call_id, "call_123")
  assert.equal(formatted[3]!.content, "file content")
})
