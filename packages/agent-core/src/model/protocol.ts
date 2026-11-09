import type { ModelMessage, ModelResponse, ModelRole } from "../contracts/model.ts"
import type { ToolCall, ToolDefinition } from "../contracts/tools.ts"
import { ModelProviderError } from "./openai-compatible.ts"

export interface WireFunctionDefinition {
  readonly name: string
  readonly description?: string
  readonly parameters?: Readonly<Record<string, unknown>>
}

export interface WireToolDefinition {
  readonly type: "function"
  readonly function: WireFunctionDefinition
}

export interface WireToolCall {
  readonly id?: string
  readonly type?: string
  readonly function?: {
    readonly name?: string
    readonly arguments?: unknown
  }
  readonly name?: string
  readonly arguments?: unknown
}

export function formatWireTools(tools?: readonly ToolDefinition[]): readonly WireToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

export function formatWireMessages(messages: readonly ModelMessage[]): readonly Record<string, unknown>[] {
  return messages.map((message) => {
    const formatted: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    }
    if (message.toolCallId) formatted.tool_call_id = message.toolCallId
    if (message.name) formatted.name = message.name
    return formatted
  })
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      return JSON.parse(trimmed)
    } catch {
      // Return raw string so tool validation/registry safely rejects it as invalid arguments
      return { __malformedJson: raw }
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw
  }
  if (raw === undefined || raw === null) {
    return {}
  }
  return { __invalidType: raw }
}

function extractQwenFunctionCalls(rawContent: string): { readonly toolCalls: readonly ToolCall[]; readonly remainingContent: string } | undefined {
  const functionRegex = /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/function>/gi
  const matches = [...rawContent.matchAll(functionRegex)]
  if (matches.length === 0) return undefined
  const calls: ToolCall[] = []
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const name = match?.[1]?.trim()
    const body = match?.[2] ?? ""
    if (!name) return undefined
    const args: Record<string, unknown> = {}
    const paramRegex = /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/gi
    for (const param of body.matchAll(paramRegex)) {
      const key = param[1]?.trim()
      if (!key) continue
      args[key] = param[2] ?? ""
    }
    calls.push({
      id: `call_${i + 1}`,
      name,
      arguments: Object.keys(args).length > 0 ? args : {},
    })
  }
  const remaining = rawContent
    .replace(functionRegex, "")
    .replace(/<\/?tool_call>/gi, "")
    .trim()
  return { toolCalls: calls, remainingContent: remaining }
}

function extractToolCallsFromContent(rawContent: string): { readonly toolCalls: readonly ToolCall[]; readonly remainingContent: string } {
  const trimmed = rawContent.trim()
  if (!trimmed) return { toolCalls: [], remainingContent: rawContent }

  const qwen = extractQwenFunctionCalls(trimmed)
  if (qwen && qwen.toolCalls.length > 0) return qwen

  // Check 1: <tool_call>...</tool_call> tags
  const toolCallTagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi
  const tagMatches = [...trimmed.matchAll(toolCallTagRegex)]
  if (tagMatches.length > 0) {
    const calls: ToolCall[] = []
    let valid = true
    for (let i = 0; i < tagMatches.length; i++) {
      const match = tagMatches[i]
      const inner = match && match[1] ? match[1].trim() : ""
      if (!inner) {
        valid = false
        break
      }
      try {
        const parsed = JSON.parse(inner) as Record<string, unknown>
        if (parsed && typeof parsed === "object" && typeof parsed.name === "string" && parsed.name.trim()) {
          const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : `call_${i + 1}`
          const rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.input
          calls.push({
            id,
            name: parsed.name.trim(),
            arguments: parseToolArguments(rawArgs),
          })
        } else {
          valid = false
          break
        }
      } catch {
        valid = false
        break
      }
    }
    if (valid && calls.length > 0) {
      const remaining = trimmed.replace(toolCallTagRegex, "").trim()
      return { toolCalls: calls, remainingContent: remaining }
    }
  }

  // Check 2: Markdown code fence ```json ... ```
  const codeBlockMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidateJson = (codeBlockMatch && codeBlockMatch[1]) ? codeBlockMatch[1].trim() : trimmed

  // Check 3: Raw JSON object or array
  if ((candidateJson.startsWith("{") && candidateJson.endsWith("}")) || (candidateJson.startsWith("[") && candidateJson.endsWith("]"))) {
    try {
      const parsed = JSON.parse(candidateJson) as unknown
      if (Array.isArray(parsed) && parsed.length > 0) {
        const calls: ToolCall[] = []
        let allValid = true
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i] as Record<string, unknown>
          if (item && typeof item === "object" && typeof item.name === "string" && item.name.trim()) {
            const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `call_${i + 1}`
            const rawArgs = item.arguments ?? item.parameters ?? item.input
            calls.push({
              id,
              name: item.name.trim(),
              arguments: parseToolArguments(rawArgs),
            })
          } else {
            allValid = false
            break
          }
        }
        if (allValid && calls.length > 0) {
          return { toolCalls: calls, remainingContent: "" }
        }
      } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const item = parsed as Record<string, unknown>
        if (typeof item.name === "string" && item.name.trim()) {
          const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "call_1"
          const rawArgs = item.arguments ?? item.parameters ?? item.input
          return {
            toolCalls: [{
              id,
              name: item.name.trim(),
              arguments: parseToolArguments(rawArgs),
            }],
            remainingContent: "",
          }
        }
      }
    } catch {
      const concatenated = parseConcatenatedToolCallObjects(candidateJson)
      if (concatenated) return { toolCalls: concatenated, remainingContent: "" }
    }
  }

  return { toolCalls: [], remainingContent: rawContent }
}

/** Local models sometimes emit several tool-call objects back to back instead of one JSON value. */
function parseConcatenatedToolCallObjects(source: string): ToolCall[] | null {
  const text = source.trim()
  if (!text.startsWith("{")) return null
  const calls: ToolCall[] = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index] ?? "")) index += 1
    if (index >= text.length) break
    if (text[index] !== "{") return null
    const end = scanJsonObjectEnd(text, index)
    if (end === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text.slice(index, end))
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const item = parsed as Record<string, unknown>
    if (typeof item.name !== "string" || !item.name.trim()) return null
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `call_${calls.length + 1}`
    calls.push({
      id,
      name: item.name.trim(),
      arguments: parseToolArguments(item.arguments ?? item.parameters ?? item.input),
    })
    index = end
  }
  return calls.length > 1 ? calls : null
}

const UNPARSED_ENVELOPE_START = /<tool_call\b|<function=[A-Za-z0-9_.:-]+>/i

/**
 * A local model sometimes appends an unfinished tool envelope after the answer.
 * Only an opening tool envelope is protocol. A closing tag or parameter tag
 * quoted in an answer stays, because that text is not a call.
 * Text before the opening marker stays. The marker and everything after it is
 * dropped here, before the runner stores the assistant message.
 */
export function separateUnparsedProtocolEnvelope(content: string): { readonly content: string; readonly discarded: boolean } {
  const match = UNPARSED_ENVELOPE_START.exec(content)
  if (match?.index === undefined) return { content, discarded: false }
  return { content: content.slice(0, match.index).trim(), discarded: true }
}

/**
 * Qwen-family replies sometimes wrap private reasoning in think tags.
 * Fenced code is left intact so an answer can show the syntax.
 * The removed text is not returned.
 */
export function separateHiddenReasoning(content: string): { readonly content: string; readonly discarded: boolean } {
  const hiddenBlock = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi
  const hiddenOpen = /<(think|thinking|reasoning)\b[^>]*>/i
  const parts = content.split(/(```[\s\S]*?```)/g)
  let discarded = false
  const next = parts.map((part, index) => {
    if (index % 2 === 1) return part
    const withoutBlocks = part.replace(hiddenBlock, () => {
      discarded = true
      return ""
    })
    const open = hiddenOpen.exec(withoutBlocks)
    if (open?.index === undefined) return withoutBlocks
    discarded = true
    return withoutBlocks.slice(0, open.index)
  }).join("")
  return { content: next.trim(), discarded }
}

function scanJsonObjectEnd(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] ?? ""
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === "\\") {
        escape = true
        continue
      }
      if (ch === "\"") inString = false
      continue
    }
    if (ch === "\"") {
      inString = true
      continue
    }
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return null
}

export function normalizeWireResponse(payload: unknown, fallbackModel = "unknown"): ModelResponse {
  if (!payload || typeof payload !== "object") {
    throw new ModelProviderError("MALFORMED_RESPONSE", "Model response must be an object")
  }

  const record = payload as Record<string, unknown>

  // Check for backend error envelope
  if (record.error && typeof record.error === "object") {
    const errorObj = record.error as Record<string, unknown>
    const message = typeof errorObj.message === "string" ? errorObj.message : "Backend returned an error"
    const code = typeof errorObj.code === "number" ? errorObj.code : undefined
    throw new ModelProviderError("HTTP_ERROR", message, code)
  }

  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0 || !choices[0] || typeof choices[0] !== "object") {
    throw new ModelProviderError("MALFORMED_RESPONSE", "Model response does not contain a valid completion choice")
  }

  const choice = choices[0] as Record<string, unknown>
  const message = choice.message
  if (!message || typeof message !== "object") {
    throw new ModelProviderError("MALFORMED_RESPONSE", "Completion choice does not contain a message object")
  }

  const messageRecord = message as Record<string, unknown>
  if (messageRecord.role !== "assistant") {
    throw new ModelProviderError("MALFORMED_RESPONSE", `Expected assistant message role, got '${String(messageRecord.role)}'`)
  }

  // Extract tool calls from message.tool_calls or legacy message.function_call
  const toolCalls: ToolCall[] = []

  if (messageRecord.tool_calls !== undefined && messageRecord.tool_calls !== null) {
    if (!Array.isArray(messageRecord.tool_calls)) {
      throw new ModelProviderError("MALFORMED_RESPONSE", "message.tool_calls must be an array")
    }

    for (let i = 0; i < messageRecord.tool_calls.length; i++) {
      const callItem = messageRecord.tool_calls[i]
      if (!callItem || typeof callItem !== "object") {
        throw new ModelProviderError("MALFORMED_RESPONSE", `tool_calls[${i}] must be an object`)
      }
      const itemRecord = callItem as Record<string, unknown>
      const funcRecord = itemRecord.function && typeof itemRecord.function === "object"
        ? itemRecord.function as Record<string, unknown>
        : undefined

      const name = typeof funcRecord?.name === "string" && funcRecord.name.trim()
        ? funcRecord.name.trim()
        : typeof itemRecord.name === "string" && itemRecord.name.trim()
          ? itemRecord.name.trim()
          : undefined

      if (!name) {
        throw new ModelProviderError("MALFORMED_RESPONSE", `tool_calls[${i}] is missing a valid function name`)
      }

      const rawArguments = funcRecord ? funcRecord.arguments : itemRecord.arguments
      const parsedArguments = parseToolArguments(rawArguments)

      const id = typeof itemRecord.id === "string" && itemRecord.id.trim()
        ? itemRecord.id.trim()
        : `call_${i + 1}`

      toolCalls.push({
        id,
        name,
        arguments: parsedArguments,
      })
    }
  } else if (messageRecord.function_call && typeof messageRecord.function_call === "object") {
    const funcRecord = messageRecord.function_call as Record<string, unknown>
    const name = typeof funcRecord.name === "string" && funcRecord.name.trim() ? funcRecord.name.trim() : undefined
    if (!name) {
      throw new ModelProviderError("MALFORMED_RESPONSE", "function_call is missing a valid function name")
    }
    const parsedArguments = parseToolArguments(funcRecord.arguments)
    toolCalls.push({
      id: "call_1",
      name,
      arguments: parsedArguments,
    })
  }

  // Extract content
  let content = ""
  if (typeof messageRecord.content === "string") {
    content = messageRecord.content
  } else if (messageRecord.content === null || messageRecord.content === undefined) {
    if (toolCalls.length === 0) {
      throw new ModelProviderError("MALFORMED_RESPONSE", "Completion message must contain assistant text or tool calls")
    }
    content = ""
  } else {
    throw new ModelProviderError("MALFORMED_RESPONSE", "Completion message content must be a string or null")
  }

  // If no wire tool_calls were present, check if assistant outputted a JSON tool call in content
  if (toolCalls.length === 0 && content.trim()) {
    const extracted = extractToolCallsFromContent(content)
    if (extracted.toolCalls.length > 0) {
      toolCalls.push(...extracted.toolCalls)
      content = extracted.remainingContent
    }
  }

  const hidden = separateHiddenReasoning(content)
  content = hidden.content
  const separated = separateUnparsedProtocolEnvelope(content)
  content = separated.content
  if ((separated.discarded || hidden.discarded) && !content.trim() && toolCalls.length === 0) {
    throw new ModelProviderError(
      "MALFORMED_RESPONSE",
      separated.discarded
        ? "Assistant message contained an incomplete tool-call envelope and no answer"
        : "Assistant message contained hidden reasoning and no answer",
    )
  }

  // Extract usage
  const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : undefined
  const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined
  const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined

  // Extract finish reason
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined

  // Collect metadata
  const metadata: Record<string, unknown> = {}
  if (typeof record.id === "string") metadata.id = record.id
  if (typeof record.created === "number") metadata.created = record.created
  if (typeof record.system_fingerprint === "string") metadata.systemFingerprint = record.system_fingerprint
  if (typeof choice.index === "number") metadata.choiceIndex = choice.index
  if (separated.discarded) metadata.protocolEnvelopeDiscarded = true
  if (hidden.discarded) metadata.reasoningDiscarded = true
  if (typeof messageRecord.reasoning_content === "string" || typeof messageRecord.thinking === "string") {
    metadata.reasoningPresent = true
  }

  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : fallbackModel

  return {
    model,
    message: {
      role: "assistant" as ModelRole,
      content,
    },
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(inputTokens !== undefined || outputTokens !== undefined ? {
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}
