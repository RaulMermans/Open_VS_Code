import type { ModelCapability, ModelProvider, ModelRequest, ModelResponse, ModelRole } from "../contracts/model.ts"
import { validateModelRequest } from "./provider.ts"

export type ModelProviderErrorCode = "INVALID_REQUEST" | "HTTP_ERROR" | "MALFORMED_RESPONSE" | "TIMEOUT" | "CANCELLED" | "NETWORK_ERROR"

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
  readonly fetch?: typeof fetch
}

function parseBaseUrl(value: string | URL): URL {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Model base URL must use HTTP or HTTPS")
  if (url.search || url.hash) throw new TypeError("Model base URL cannot contain a query or fragment")
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}

function parseResponse(value: unknown): ModelResponse {
  if (!value || typeof value !== "object") throw new ModelProviderError("MALFORMED_RESPONSE", "Model response must be an object")
  const record = value as Record<string, unknown>
  const choices = record.choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    throw new ModelProviderError("MALFORMED_RESPONSE", "Model response does not contain a completion choice")
  }
  const choice = choices[0] as Record<string, unknown>
  const message = choice.message
  if (!message || typeof message !== "object") throw new ModelProviderError("MALFORMED_RESPONSE", "Completion choice does not contain a message")
  const messageRecord = message as Record<string, unknown>
  if (messageRecord.role !== "assistant" || typeof messageRecord.content !== "string") {
    throw new ModelProviderError("MALFORMED_RESPONSE", "Completion message must contain assistant text")
  }
  const usage = record.usage
  const usageRecord = usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined
  const result: ModelResponse = {
    model: typeof record.model === "string" ? record.model : "unknown",
    message: { role: messageRecord.role as ModelRole, content: messageRecord.content },
    ...(typeof choice.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
    ...(usageRecord ? {
      usage: {
        ...(typeof usageRecord.prompt_tokens === "number" ? { inputTokens: usageRecord.prompt_tokens } : {}),
        ...(typeof usageRecord.completion_tokens === "number" ? { outputTokens: usageRecord.completion_tokens } : {}),
      },
    } : {}),
  }
  return result
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly capabilities: ReadonlySet<ModelCapability> = new Set(["chat"])
  readonly #endpoint: URL
  readonly #model: string
  readonly #timeoutMs: number
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: typeof fetch

  constructor(config: OpenAICompatibleProviderConfig) {
    this.#endpoint = new URL("chat/completions", parseBaseUrl(config.baseUrl))
    this.#model = config.model.trim()
    if (!this.#model) throw new TypeError("Model ID must not be empty")
    this.#timeoutMs = config.timeoutMs ?? 30_000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new TypeError("Model timeout must be a positive integer")
    this.#headers = { ...config.headers }
    this.#fetch = config.fetch ?? globalThis.fetch
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      validateModelRequest(request)
    } catch (error) {
      throw new ModelProviderError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid model request", undefined, { cause: error })
    }

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#headers },
        body: JSON.stringify({
          model: this.#model,
          messages: request.messages,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        }),
        signal,
      })
    } catch (error) {
      if (request.signal?.aborted) throw new ModelProviderError("CANCELLED", "Model request was cancelled", undefined, { cause: error })
      if (timeoutSignal.aborted) throw new ModelProviderError("TIMEOUT", `Model request exceeded ${this.#timeoutMs}ms`, undefined, { cause: error })
      throw new ModelProviderError("NETWORK_ERROR", "Model request failed", undefined, { cause: error })
    }

    if (!response.ok) throw new ModelProviderError("HTTP_ERROR", `Model endpoint returned HTTP ${response.status}`, response.status)
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ModelProviderError("MALFORMED_RESPONSE", "Model endpoint returned invalid JSON", undefined, { cause: error })
    }
    return parseResponse(payload)
  }
}
