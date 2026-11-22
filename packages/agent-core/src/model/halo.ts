import type { ModelCapability, ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "../contracts/model.ts"
import { validateModelRequest } from "./provider.ts"

export type HaloCapability = "coding" | "reasoning"

export type HaloProviderErrorCode =
  | "HALO_AUTH_REQUIRED"
  | "HALO_UNAVAILABLE"
  | "HALO_TIMEOUT"
  | "HALO_CANCELLED"
  | "HALO_INVALID_REQUEST"
  | "HALO_INVALID_RESPONSE"
  | "APPLICATION_UNAUTHORIZED"
  | "APPLICATION_DISABLED"
  | "APPLICATION_CAPABILITY_FORBIDDEN"
  | "ROUTE_NOT_CONFIGURED"
  | "INFERENCE_DISABLED"
  | "INFERENCE_PROVIDER_UNAVAILABLE"
  | "INFERENCE_TIMEOUT"
  | "INFERENCE_UPSTREAM_ERROR"
  | "INFERENCE_INVALID_RESPONSE"
  | "HALO_REQUEST_FAILED"
  | "HALO_ADMISSION_REJECTED"
  | "HALO_UNCERTAIN_COMPLETION"
  | "HALO_UNSUPPORTED_FEATURE"

const SAFE_MESSAGES: Record<HaloProviderErrorCode, string> = {
  HALO_AUTH_REQUIRED: "HALO authentication is not configured.",
  HALO_UNAVAILABLE: "HALO Core is unreachable.",
  HALO_TIMEOUT: "HALO Core did not respond before the request timed out.",
  HALO_CANCELLED: "HALO request was cancelled.",
  HALO_INVALID_REQUEST: "HALO rejected the inference request.",
  HALO_INVALID_RESPONSE: "HALO returned an invalid inference response.",
  APPLICATION_UNAUTHORIZED: "HALO authentication failed.",
  APPLICATION_DISABLED: "Open VS Code access is disabled in HALO.",
  APPLICATION_CAPABILITY_FORBIDDEN: "Open VS Code is not permitted to request this HALO capability.",
  ROUTE_NOT_CONFIGURED: "No HALO route is configured for this capability.",
  INFERENCE_DISABLED: "HALO inference is disabled.",
  INFERENCE_PROVIDER_UNAVAILABLE: "HALO's inference provider is unavailable.",
  INFERENCE_TIMEOUT: "HALO's inference provider timed out.",
  INFERENCE_UPSTREAM_ERROR: "HALO's inference provider returned an error.",
  INFERENCE_INVALID_RESPONSE: "HALO's inference provider returned an invalid response.",
  HALO_REQUEST_FAILED: "HALO request failed.",
  HALO_ADMISSION_REJECTED: "HALO admission rejected this request.",
  HALO_UNCERTAIN_COMPLETION: "HALO completion is uncertain; the request was not replayed.",
  HALO_UNSUPPORTED_FEATURE: "HALO does not qualify this inference feature.",
}

export class HaloProviderError extends Error {
  readonly code: HaloProviderErrorCode
  readonly status?: number

  constructor(code: HaloProviderErrorCode, status?: number, options?: ErrorOptions) {
    super(SAFE_MESSAGES[code], options)
    this.name = "HaloProviderError"
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function capabilityForAgentMode(mode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW"): HaloCapability {
  switch (mode) {
    case "ASK":
    case "BUILD":
      return "coding"
    case "PLAN":
    case "DEBUG":
    case "REVIEW":
      return "reasoning"
  }
}

export interface HaloProviderConfig {
  readonly coreUrl: string | URL
  readonly capability: HaloCapability
  readonly token: string | (() => string | undefined | Promise<string | undefined>)
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
  /** Optional HALO registry model ID. When set, chat uses POST /inference/chat instead of capability routing. */
  readonly modelId?: string
}

/** Cheap connectivity probe; it never creates an inference activity. */
export async function probeHalo(coreUrl: string | URL, requestFetch: typeof fetch = globalThis.fetch): Promise<boolean> {
  const response = await requestFetch(new URL("health", parseCoreUrl(coreUrl)))
  return response.ok
}

export interface HaloConnectionInspection {
  readonly coreReachable: boolean
  readonly authenticationConfigured: boolean
  readonly applicationAuthorized: boolean | null
  readonly selectedModelRegistered: boolean | null
  readonly capabilityAllowed: boolean | null
  readonly inferenceStatus: string | null
  readonly streamingSupported: false
  readonly toolsSupported: false
  readonly summary: string
}

/**
 * Connection check that does not dispatch inference. A healthy Core is not proof the selected model can serve.
 */
export async function inspectHaloConnection(options: {
  readonly coreUrl: string | URL
  readonly token?: string
  readonly capability?: HaloCapability
  readonly modelId?: string
  readonly fetch?: typeof fetch
}): Promise<HaloConnectionInspection> {
  const requestFetch = options.fetch ?? globalThis.fetch
  const base = parseCoreUrl(options.coreUrl)
  const authenticationConfigured = Boolean(options.token?.trim())
  let coreReachable = false
  let applicationAuthorized: boolean | null = null
  let selectedModelRegistered: boolean | null = options.modelId ? false : null
  let capabilityAllowed: boolean | null = null
  let inferenceStatus: string | null = null
  try {
    const health = await requestFetch(new URL("health", base))
    coreReachable = health.ok
  } catch {
    return failInspection(authenticationConfigured, "HALO Core is unreachable.")
  }
  if (!coreReachable) return failInspection(authenticationConfigured, "HALO Core is unreachable.")
  try {
    const status = await requestFetch(new URL("inference/status", base))
    if (status.ok) {
      const body = await status.json() as { status?: unknown; features?: { streaming?: unknown; tools?: unknown } }
      inferenceStatus = typeof body.status === "string" ? body.status : null
      if (body.features?.streaming === true || body.features?.tools === true) {
        return failInspection(authenticationConfigured, "HALO advertised unsupported streaming or tools.", {
          coreReachable, authenticationConfigured, inferenceStatus,
        })
      }
    }
  } catch {
    inferenceStatus = null
  }
  try {
    const access = await requestFetch(new URL("applications/open-vscode/access", base))
    if (access.ok) {
      const body = await access.json() as { allowedCapabilities?: unknown }
      const allowed = Array.isArray(body.allowedCapabilities) ? body.allowedCapabilities.filter((item): item is string => typeof item === "string") : []
      applicationAuthorized = true
      if (options.capability) capabilityAllowed = allowed.includes(options.capability)
    } else if (access.status === 404) {
      applicationAuthorized = false
    }
  } catch {
    applicationAuthorized = null
  }
  if (options.modelId) {
    try {
      const model = await requestFetch(new URL(`models/${encodeURIComponent(options.modelId)}`, base))
      selectedModelRegistered = model.ok
    } catch {
      selectedModelRegistered = false
    }
  }
  const ready = coreReachable
    && (applicationAuthorized !== false)
    && (selectedModelRegistered !== false)
    && (capabilityAllowed !== false)
    && inferenceStatus !== "disabled"
  const summary = ready
    ? "HALO Core is reachable; selected model and capability still require a governed inference request."
    : "HALO connection check failed; select Direct Ollama explicitly if you need local inference."
  return {
    coreReachable,
    authenticationConfigured,
    applicationAuthorized,
    selectedModelRegistered,
    capabilityAllowed,
    inferenceStatus,
    streamingSupported: false,
    toolsSupported: false,
    summary,
  }
}

function failInspection(
  authenticationConfigured: boolean,
  summary: string,
  extra: Partial<HaloConnectionInspection> = {},
): HaloConnectionInspection {
  return {
    coreReachable: extra.coreReachable ?? false,
    authenticationConfigured,
    applicationAuthorized: extra.applicationAuthorized ?? null,
    selectedModelRegistered: extra.selectedModelRegistered ?? null,
    capabilityAllowed: extra.capabilityAllowed ?? null,
    inferenceStatus: extra.inferenceStatus ?? null,
    streamingSupported: false,
    toolsSupported: false,
    summary,
  }
}

interface HaloFailureBody {
  readonly code?: unknown
  readonly error?: unknown
  readonly reason?: unknown
}

interface HaloChatResponse {
  readonly modelId: unknown
  readonly output: { readonly role?: unknown; readonly content?: unknown } | null
  readonly finishReason?: unknown
  readonly usage?: { readonly inputTokens?: unknown; readonly outputTokens?: unknown }
  readonly provider?: { readonly id?: unknown; readonly type?: unknown }
}

const HALO_ERROR_CODES = new Set<HaloProviderErrorCode>([
  "APPLICATION_UNAUTHORIZED",
  "APPLICATION_DISABLED",
  "APPLICATION_CAPABILITY_FORBIDDEN",
  "ROUTE_NOT_CONFIGURED",
  "INFERENCE_DISABLED",
  "INFERENCE_PROVIDER_UNAVAILABLE",
  "INFERENCE_TIMEOUT",
  "INFERENCE_UPSTREAM_ERROR",
  "INFERENCE_INVALID_RESPONSE",
])

function parseCoreUrl(value: string | URL): URL {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("HALO Core URL must use HTTP or HTTPS")
  if (url.search || url.hash) throw new TypeError("HALO Core URL cannot contain a query or fragment")
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}

function isHaloMessage(message: ModelMessage): message is ModelMessage & { role: "system" | "user" | "assistant" } {
  return message.role === "system" || message.role === "user" || message.role === "assistant"
}

function asUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

export class HaloProvider implements ModelProvider {
  readonly capabilities: ReadonlySet<ModelCapability> = new Set(["chat", "reasoning", "usage_reporting"])
  readonly #base: URL
  readonly #endpoint: URL
  readonly #capability: HaloCapability
  readonly #modelId: string | undefined
  readonly #token: HaloProviderConfig["token"]
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(config: HaloProviderConfig) {
    this.#base = parseCoreUrl(config.coreUrl)
    this.#modelId = config.modelId?.trim() || undefined
    this.#endpoint = this.#modelId
      ? new URL("inference/chat", this.#base)
      : new URL("inference/capability/chat", this.#base)
    this.#capability = config.capability
    this.#token = config.token
    this.#timeoutMs = config.timeoutMs ?? 30_000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new TypeError("HALO timeout must be a positive integer")
    this.#fetch = config.fetch ?? globalThis.fetch
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      validateModelRequest(request)
    } catch (error) {
      throw new HaloProviderError("HALO_INVALID_REQUEST", undefined, { cause: error })
    }
    if (!request.messages.every(isHaloMessage)) throw new HaloProviderError("HALO_INVALID_REQUEST")

    const token = typeof this.#token === "function" ? await this.#token() : this.#token
    if (!token?.trim()) throw new HaloProviderError("HALO_AUTH_REQUIRED")

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
    const body = this.#modelId
      ? {
        modelId: this.#modelId,
        messages: request.messages.map(({ role, content }) => ({ role, content })),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
      }
      : {
        capability: this.#capability,
        messages: request.messages.map(({ role, content }) => ({ role, content })),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
      }

    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (request.signal?.aborted) throw new HaloProviderError("HALO_CANCELLED", undefined, { cause: error })
      if (timeoutSignal.aborted) throw new HaloProviderError("HALO_TIMEOUT", undefined, { cause: error })
      throw new HaloProviderError("HALO_UNAVAILABLE", undefined, { cause: error })
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new HaloProviderError(response.ok ? "HALO_INVALID_RESPONSE" : "HALO_REQUEST_FAILED", response.status, { cause: error })
    }
    if (!response.ok) throw this.#errorFromResponse(payload, response.status)
    return this.#parseResponse(payload)
  }

  #errorFromResponse(payload: unknown, status: number): HaloProviderError {
    const body = typeof payload === "object" && payload !== null ? payload as HaloFailureBody : {}
    if (body.error === "AdmissionError") {
      if (body.reason === "REJECTED_CAPACITY_UNCERTAIN") return new HaloProviderError("HALO_UNCERTAIN_COMPLETION", status)
      return new HaloProviderError("HALO_ADMISSION_REJECTED", status)
    }
    if (body.code === "INFERENCE_TIMEOUT" || body.code === "INFERENCE_PROVIDER_UNAVAILABLE") {
      return new HaloProviderError("HALO_UNCERTAIN_COMPLETION", status)
    }
    const code = body.code
    if (typeof code === "string" && HALO_ERROR_CODES.has(code as HaloProviderErrorCode)) {
      return new HaloProviderError(code as HaloProviderErrorCode, status)
    }
    if (status === 401) return new HaloProviderError("APPLICATION_UNAUTHORIZED", status)
    return new HaloProviderError("HALO_REQUEST_FAILED", status)
  }

  #parseResponse(payload: unknown): ModelResponse {
    if (typeof payload !== "object" || payload === null) throw new HaloProviderError("HALO_INVALID_RESPONSE")
    const response = payload as HaloChatResponse & { tool_calls?: unknown; toolCalls?: unknown; object?: unknown }
    if (response.tool_calls !== undefined || response.toolCalls !== undefined || response.object === "chat.completion") {
      throw new HaloProviderError("HALO_UNSUPPORTED_FEATURE")
    }
    if (typeof response.modelId !== "string" || !response.modelId.trim() || response.output === null || response.output.role !== "assistant" || typeof response.output.content !== "string") {
      throw new HaloProviderError("HALO_INVALID_RESPONSE")
    }
    if (this.#modelId && response.modelId !== this.#modelId) throw new HaloProviderError("HALO_INVALID_RESPONSE")
    const inputTokens = asUsageNumber(response.usage?.inputTokens)
    const outputTokens = asUsageNumber(response.usage?.outputTokens)
    return {
      model: response.modelId,
      message: { role: "assistant", content: response.output.content },
      ...(typeof response.finishReason === "string" ? { finishReason: response.finishReason } : {}),
      ...((inputTokens !== undefined || outputTokens !== undefined) ? { usage: { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } } : {}),
      metadata: {
        backend: "halo",
        capability: this.#capability,
        streaming: false,
        tools: false,
        ...(this.#modelId ? { modelId: this.#modelId } : {}),
        ...(typeof response.provider?.id === "string" ? { providerId: response.provider.id } : {}),
      },
    }
  }
}

export type InferenceBackend = "halo" | "standalone-local"

export function selectInferenceBackend(options: {
  readonly backend: InferenceBackend
  readonly halo: ModelProvider
  readonly standalone: ModelProvider
}): ModelProvider {
  return options.backend === "halo" ? options.halo : options.standalone
}
