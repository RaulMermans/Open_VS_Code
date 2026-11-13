import type { AgentToolCallRecord } from "../contracts/agent.ts"
import type { ModelMessage } from "../contracts/model.ts"
import type { ToolObservation } from "./observations.ts"

export type ConversationEncoding = "compiled-user" | "native-tool-messages"

const DEFAULT_OBSERVATION_LIMIT = 6

/**
 * OpenAI-compatible tool transcript. Observations stay attributed as `tool`
 * messages instead of being recompiled into one user blob.
 *
 * Default execution still uses `compiled-user`. Enable with
 * `conversationEncoding: "native-tool-messages"` or
 * `OPEN_VS_CODE_NATIVE_TOOL_MESSAGES=1`.
 */
export function resolveConversationEncoding(
  explicit?: ConversationEncoding,
  env: NodeJS.ProcessEnv = process.env,
): ConversationEncoding {
  if (explicit === "native-tool-messages" || explicit === "compiled-user") return explicit
  return env.OPEN_VS_CODE_NATIVE_TOOL_MESSAGES === "1" ? "native-tool-messages" : "compiled-user"
}

export function buildNativeToolMessages(input: {
  readonly promptContent: string
  readonly observations?: readonly ToolObservation[]
  readonly toolCalls?: readonly AgentToolCallRecord[]
  readonly maxObservations?: number
}): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: input.promptContent }]
  const limit = input.maxObservations ?? DEFAULT_OBSERVATION_LIMIT
  const observations = (input.observations ?? []).slice(-limit)
  const argumentsByCall = new Map(
    (input.toolCalls ?? [])
      .filter((call) => call.arguments)
      .map((call) => [call.id, call.arguments ?? {}]),
  )
  for (const observation of observations) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: observation.callId,
        name: observation.toolName,
        arguments: observation.arguments ?? argumentsByCall.get(observation.callId) ?? {},
      }],
    })
    messages.push({
      role: "tool",
      name: observation.toolName,
      toolCallId: observation.callId,
      content: observation.ok
        ? observation.content
        : `ERROR ${observation.errorCategory ?? "TOOL"}: ${observation.content}`,
    })
  }
  return messages
}
