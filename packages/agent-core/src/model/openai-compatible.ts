import type { ModelCapability, ModelProvider, ModelRequest, ModelResponse } from "../contracts/model.ts"
import type { ToolDefinition } from "../contracts/tools.ts"
import { validateModelRequest } from "./provider.ts"
import { formatWireMessages, formatWireTools, normalizeWireResponse } from "./protocol.ts"

export type ModelProviderErrorCode =
  | "INVALID_REQUEST"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "TIMEOUT"
  | "CANCELLED"
  | "NETWORK_ERROR"

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

function parseBaseUrl(value: string | URL): URL {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Model base URL must use HTTP or HTTPS")
  if (url.search || url.hash) throw new TypeError("Model base URL cannot contain a query or fragment")
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly capabilities: ReadonlySet<ModelCapability>
  readonly contextWindow?: number | undefined
  readonly model: string
  readonly #endpoint: URL
  readonly #timeoutMs: number
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: typeof fetch

  constructor(config: OpenAICompatibleProviderConfig) {
    this.#endpoint = new URL("chat/completions", parseBaseUrl(config.baseUrl))
    this.model = config.model.trim()
    if (!this.model) throw new TypeError("Model ID must not be empty")
    this.#timeoutMs = config.timeoutMs ?? 30_000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new TypeError("Model timeout must be a positive integer")
    if (config.contextWindow !== undefined && (!Number.isInteger(config.contextWindow) || config.contextWindow <= 0)) {
      throw new TypeError("Context window must be a positive integer")
    }
    this.contextWindow = config.contextWindow
    this.capabilities = config.capabilities instanceof Set
      ? config.capabilities
      : new Set(config.capabilities ?? ["chat", "tools"])
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
      ...(wireTools ? { tools: wireTools } : {}),
    }

    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#headers },
        body: JSON.stringify(requestBody),
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
    return normalizeWireResponse(payload, this.model)
  }
}
