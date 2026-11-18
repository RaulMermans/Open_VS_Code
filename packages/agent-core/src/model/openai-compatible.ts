import type { ModelCapability, ModelProvider, ModelRequest, ModelResponse } from "../contracts/model.ts"
import type { ToolDefinition } from "../contracts/tools.ts"
import { validateModelRequest } from "./provider.ts"
import { formatWireMessages, formatWireTools, normalizeWireResponse } from "./protocol.ts"
import { resolveCanonicalEndpoints, type CanonicalEndpoints } from "./canonical-endpoint.ts"
import { assertInferenceAuthorized, InferenceNotAuthorizedError } from "./inference-gate.ts"

export type ModelProviderErrorCode =
  | "INVALID_REQUEST"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "TIMEOUT"
  | "CANCELLED"
  | "NETWORK_ERROR"
  | "INFERENCE_NOT_AUTHORIZED"

export class ModelProviderError extends Error {
  readonly code: ModelProviderErrorCode
  readonly status?: number

  constructor(code: ModelProviderErrorCode, message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = "ModelProviderError"
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export interface OpenAICompatibleProviderConfig {
  readonly baseUrl: string | URL
  readonly model: string
  readonly timeoutMs?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly capabilities?: ReadonlySet<ModelCapability> | readonly ModelCapability[]
  readonly contextWindow?: number
  readonly fetch?: typeof fetch
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly capabilities: ReadonlySet<ModelCapability>
  readonly contextWindow?: number | undefined
  readonly model: string
  readonly #endpoint: URL
  readonly #canonical: CanonicalEndpoints
  readonly #timeoutMs: number
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: typeof fetch
  readonly #isCustomFetch: boolean

  constructor(config: OpenAICompatibleProviderConfig) {
    this.#canonical = resolveCanonicalEndpoints(config.baseUrl)
    this.#endpoint = new URL(this.#canonical.chatEndpoint)
    this.model = config.model.trim()
    if (!this.model) throw new TypeError("Model ID must not be empty")
    this.#timeoutMs = config.timeoutMs ?? 180_000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new TypeError("Model timeout must be a positive integer")
    if (config.contextWindow !== undefined && (!Number.isInteger(config.contextWindow) || config.contextWindow <= 0)) {
      throw new TypeError("Context window must be a positive integer")
    }
    this.contextWindow = config.contextWindow
    this.capabilities = config.capabilities instanceof Set
      ? config.capabilities
      : new Set(config.capabilities ?? ["chat", "tools"])
    this.#headers = { ...config.headers }
    this.#isCustomFetch = config.fetch !== undefined
    this.#fetch = config.fetch ?? globalThis.fetch
  }

  get canonicalEndpoints(): CanonicalEndpoints {
    return this.#canonical
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      validateModelRequest(request)
    } catch (error) {
      throw new ModelProviderError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid model request", undefined, { cause: error })
    }

    const tools = request.tools ?? (
      Array.isArray(request.metadata?.tools) ? request.metadata.tools as readonly ToolDefinition[] : undefined
    )

    const wireTools = this.capabilities.has("tools") ? formatWireTools(tools) : undefined
    const wireMessages = formatWireMessages(request.messages)

    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages: wireMessages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      ...(wireTools ? { tools: wireTools, tool_choice: "auto" } : {}),
      ...(this.contextWindow ? { options: { num_ctx: this.contextWindow } } : {}),
    }
    // Agent turns (with tools) get an output cap, so a runaway reasoning chain ends by itself instead of
    // running into the request timeout. Measured normal turns: 50-1,500 tokens, p99 about 5,000.
    const capped = wireTools !== undefined && request.maxOutputTokens === undefined
    if (capped) requestBody.max_tokens = AGENT_TURN_MAX_OUTPUT_TOKENS
    let first: ModelResponse
    try {
      first = await this.#attempt(request, requestBody, wireMessages, wireTools)
    } catch (error) {
      if (!capped || !(error instanceof ModelProviderError) || error.code !== "TIMEOUT") throw error
      // One retry of this turn without reasoning; if that fails too, the timeout stands.
      return this.#attempt(request, { ...requestBody, reasoning_effort: "none" }, wireMessages, wireTools).catch(() => { throw error })
    }
    if (capped && first.finishReason === "length" && !first.toolCalls?.length && !first.message.content.trim()) {
      // The cap cut the turn off while it was still reasoning: retry once without reasoning.
      return this.#attempt(request, { ...requestBody, reasoning_effort: "none" }, wireMessages, wireTools).catch(() => first)
    }
    return first
  }

  /** One request with its own timeout (and the existing bounded retry of transient endpoint failures). */
  async #attempt(request: ModelRequest, requestBody: Record<string, unknown>, wireMessages: ReturnType<typeof formatWireMessages>, wireTools: ReturnType<typeof formatWireTools>): Promise<ModelResponse> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
    if (process.env["OPEN_VS_CODE_MODEL_TRACE"] === "1") {
      const lastMessage = wireMessages.at(-1)
      const lastContent = lastMessage?.content
      process.stderr.write(`${JSON.stringify({
        phase: "request",
        model: this.model,
        toolNames: wireTools?.map((tool) => tool.function.name) ?? [],
        toolChoice: wireTools ? "auto" : null,
        messageCount: wireMessages.length,
        lastRole: lastMessage?.role,
        lastContentChars: typeof lastContent === "string" ? lastContent.length : 0,
      })}\n`)
    }

    // A local endpoint restarting (service restart, model reload) returns 5xx or drops the connection for a
    // moment; one such blip must not discard a long task. Bounded, abortable, never on 4xx or cancellation.
    let response: Response | undefined
    for (let attempt = 0; ; attempt += 1) {
      let failure: ModelProviderError
      try {
        assertInferenceAuthorized(this.#isCustomFetch)
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.#headers },
          body: JSON.stringify(requestBody),
          signal,
        })
        if (response.ok) break
        failure = new ModelProviderError("HTTP_ERROR", `Model endpoint returned HTTP ${response.status}`, response.status)
        if (response.status !== 429 && response.status < 500) throw failure
      } catch (error) {
        if (error instanceof ModelProviderError) throw error
        if (error instanceof InferenceNotAuthorizedError) {
          throw new ModelProviderError("INFERENCE_NOT_AUTHORIZED", error.message, undefined, { cause: error })
        }
        if (request.signal?.aborted) throw new ModelProviderError("CANCELLED", "Model request was cancelled", undefined, { cause: error })
        if (timeoutSignal.aborted) throw new ModelProviderError("TIMEOUT", `Model request exceeded ${this.#timeoutMs}ms`, undefined, { cause: error })
        failure = new ModelProviderError("NETWORK_ERROR", "Model request failed", undefined, { cause: error })
      }
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw failure
      await abortableDelay(TRANSIENT_RETRY_DELAYS_MS[attempt]!, signal).catch((error) => {
        if (request.signal?.aborted) throw new ModelProviderError("CANCELLED", "Model request was cancelled", undefined, { cause: error })
        throw new ModelProviderError("TIMEOUT", `Model request exceeded ${this.#timeoutMs}ms`, undefined, { cause: error })
      })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ModelProviderError("MALFORMED_RESPONSE", "Model endpoint returned invalid JSON", undefined, { cause: error })
    }
    const normalized = normalizeWireResponse(payload, this.model)
    if (process.env["OPEN_VS_CODE_MODEL_TRACE"] === "1") {
      const choice = payload && typeof payload === "object" ? (payload as { choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown } }[] }).choices?.[0] : undefined
      process.stderr.write(`${JSON.stringify({
        phase: "response",
        finishReason: choice?.finish_reason ?? normalized.finishReason,
        parsedToolCalls: normalized.toolCalls?.map((call) => call.name) ?? [],
        rawToolCallCount: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls.length : 0,
        contentChars: normalized.message.content.length,
        contentPrefix: normalized.message.content.slice(0, 400),
        reasoningOff: requestBody.reasoning_effort === "none",
      })}\n`)
    }
    return normalized
  }
}

/** Output cap for agent turns: at the measured ~40-80 tokens/s on the local endpoint, well under the timeout. */
export const AGENT_TURN_MAX_OUTPUT_TOKENS = 6_144

/** Waits between retries of a transient model endpoint failure. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000]

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
