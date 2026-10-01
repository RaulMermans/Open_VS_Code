/**
 * LocalFimProvider — Sprint 4E Production FIM Adapter.
 *
 * This is the production autocomplete/FIM provider for self-hosted local models
 * accessed via an OpenAI-compatible /v1/completions endpoint.
 *
 * Design principles:
 *   - Provider-specific FIM token formatting is ISOLATED here, never in
 *     AutocompleteService or ModelRouter.
 *   - Uses /v1/completions (not /v1/chat/completions) for FIM.
 *   - Supports multiple FIM strategies via fimStrategy config.
 *   - Respects AbortSignal — throws on cancellation.
 *   - Bounded output: maxOutputTokens is enforced in the request.
 *   - No AgentRunner, no tools, no MCP, no ProjectMemory.
 *   - Cloud endpoint forbidden: must be a local/self-hosted URL.
 *
 * FIM strategies:
 *   "prefix-suffix-middle" — uses <PRE>, <SUF>, <MID> tokens (llama.cpp style)
 *   "qwen"                 — uses <|fim_prefix|>, <|fim_suffix|>, <|fim_middle|> (Qwen Coder)
 *   "starcoder"            — uses <fim_prefix>, <fim_suffix>, <fim_middle> (StarCoder)
 *   "deepseek"             — uses <｜fim▁begin｜>, <｜fim▁hole｜>, <｜fim▁end｜> (DeepSeek Coder)
 *   "raw-prefix"           — sends only prefix as prompt (basic models without FIM)
 */

import type { AutocompleteProvider, AutocompleteRequest, AutocompleteResponse } from "./contracts.ts"
import { resolveCanonicalEndpoints, type CanonicalEndpoints } from "../model/canonical-endpoint.ts"
import { assertInferenceAuthorized, InferenceNotAuthorizedError } from "../model/inference-gate.ts"
import type { FimStrategy } from "../contracts/routing.ts"

export type { FimStrategy }

export interface LocalFimProviderConfig {
  readonly providerId: string
  readonly modelId: string
  readonly deploymentId: string
  /**
   * Base URL of the OpenAI-compatible local endpoint.
   * Must be http:// or https:// pointing to a self-hosted server.
   * Cloud endpoints are forbidden by the endpoint policy.
   */
  readonly baseUrl: string | URL
  /** Model name to pass in the completions request. */
  readonly model: string
  /** FIM formatting strategy. Default: "prefix-suffix-middle". */
  readonly fimStrategy?: FimStrategy
  /** Timeout in milliseconds. Default: 15_000. */
  readonly timeoutMs?: number
  /** Additional HTTP headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Fetch implementation — injectable for tests. */
  readonly fetch?: typeof fetch
}

/**
 * Build a FIM-formatted prompt string from prefix/suffix using the given strategy.
 * Provider-specific token sequences are ONLY emitted here.
 */
export function buildFimPrompt(
  prefix: string,
  suffix: string,
  strategy: FimStrategy,
): string {
  switch (strategy) {
    case "qwen":
      // Qwen2.5-Coder FIM format
      return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
    case "starcoder":
      // StarCoder / CodeLlama PSM format
      return `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`
    case "deepseek":
      // DeepSeek Coder FIM format
      return `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`
    case "raw-prefix":
      // Basic models: just send prefix
      return prefix
    case "prefix-suffix-middle":
    default:
      // llama.cpp server default
      return `<PRE> ${prefix} <SUF>${suffix} <MID>`
  }
}

/**
 * Strip FIM stop tokens from the model's completion output.
 * Provider-specific stop sequences are isolated here.
 */
export function stripFimStopTokens(text: string, strategy: FimStrategy): string {
  let result = text
  const stopTokens: string[] = []

  switch (strategy) {
    case "qwen":
      stopTokens.push("<|endoftext|>", "<|fim_pad|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>")
      break
    case "starcoder":
      stopTokens.push("<|endoftext|>", "<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<fim_pad>")
      break
    case "deepseek":
      stopTokens.push("<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<|eos_token|>")
      break
    case "prefix-suffix-middle":
      stopTokens.push("</s>", "<EOT>")
      break
    case "raw-prefix":
      break
  }

  for (const token of stopTokens) {
    const idx = result.indexOf(token)
    if (idx !== -1) {
      result = result.slice(0, idx)
    }
  }

  return result
}

export class LocalFimProviderError extends Error {
  readonly code: string
  readonly status?: number | undefined

  constructor(code: string, message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = "LocalFimProviderError"
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/**
 * Production FIM/autocomplete provider for local self-hosted models.
 *
 * Uses POST /v1/completions (not /v1/chat/completions).
 * FIM prompt construction is isolated inside this provider.
 */
export class LocalFimProvider implements AutocompleteProvider {
  readonly providerId: string
  readonly modelId: string
  readonly deploymentId: string

  readonly #endpoint: URL
  readonly #canonical: CanonicalEndpoints
  readonly #model: string
  readonly #fimStrategy: FimStrategy
  readonly #timeoutMs: number
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: typeof fetch
  readonly #isCustomFetch: boolean

  constructor(config: LocalFimProviderConfig) {
    this.providerId = config.providerId
    this.modelId = config.modelId
    this.deploymentId = config.deploymentId
    this.#canonical = resolveCanonicalEndpoints(config.baseUrl)
    this.#endpoint = new URL(this.#canonical.completionsEndpoint)
    this.#model = config.model.trim()
    if (!this.#model) throw new TypeError("LocalFimProvider model must not be empty")
    this.#fimStrategy = config.fimStrategy ?? "prefix-suffix-middle"
    this.#timeoutMs = config.timeoutMs ?? 15_000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new TypeError("LocalFimProvider timeoutMs must be a positive integer")
    }
    this.#headers = { ...config.headers }
    this.#isCustomFetch = config.fetch !== undefined
    this.#fetch = config.fetch ?? globalThis.fetch
  }

  get canonicalEndpoints(): CanonicalEndpoints {
    return this.#canonical
  }

  get fimStrategy(): FimStrategy {
    return this.#fimStrategy
  }

  async complete(request: AutocompleteRequest): Promise<AutocompleteResponse> {
    // Abort check before any work
    if (request.signal?.aborted) {
      throw new LocalFimProviderError("CANCELLED", "FIM request was cancelled before start")
    }

    const prompt = buildFimPrompt(request.prefix, request.suffix, this.#fimStrategy)

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal

    const requestBody: Record<string, unknown> = {
      model: this.#model,
      prompt,
      max_tokens: request.maxOutputTokens,
      temperature: 0,
      stream: false,
    }

    let response: Response
    try {
      assertInferenceAuthorized(this.#isCustomFetch)
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#headers },
        body: JSON.stringify(requestBody),
        signal,
      })
    } catch (error) {
      if (error instanceof InferenceNotAuthorizedError) {
        throw new LocalFimProviderError("INFERENCE_NOT_AUTHORIZED", error.message, undefined, { cause: error })
      }
      if (request.signal.aborted) {
        throw new LocalFimProviderError("CANCELLED", "FIM request was cancelled", undefined, { cause: error })
      }
      if (timeoutSignal.aborted) {
        throw new LocalFimProviderError("TIMEOUT", `FIM request exceeded ${this.#timeoutMs}ms`, undefined, { cause: error })
      }
      throw new LocalFimProviderError("NETWORK_ERROR", "FIM request failed", undefined, { cause: error })
    }

    if (!response.ok) {
      throw new LocalFimProviderError(
        "HTTP_ERROR",
        `FIM endpoint returned HTTP ${response.status}`,
        response.status,
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new LocalFimProviderError("MALFORMED_RESPONSE", "FIM endpoint returned invalid JSON", undefined, { cause: error })
    }

    return this.#normalizeResponse(payload, request)
  }

  #normalizeResponse(payload: unknown, request: AutocompleteRequest): AutocompleteResponse {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new LocalFimProviderError("MALFORMED_RESPONSE", "FIM response is not an object")
    }

    const raw = payload as Record<string, unknown>

    // /v1/completions response: choices[0].text
    if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
      throw new LocalFimProviderError("MALFORMED_RESPONSE", "FIM response missing choices array")
    }

    const choice = raw.choices[0] as Record<string, unknown>
    if (typeof choice.text !== "string") {
      throw new LocalFimProviderError("MALFORMED_RESPONSE", "FIM response choice missing text field")
    }

    const rawText = choice.text as string
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined

    // Strip provider-specific stop/FIM tokens
    const cleanText = stripFimStopTokens(rawText, this.#fimStrategy)

    // Parse usage if present
    let usage: { inputTokens?: number; outputTokens?: number } | undefined
    if (raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage)) {
      const u = raw.usage as Record<string, unknown>
      usage = {
        ...(typeof u.prompt_tokens === "number" ? { inputTokens: u.prompt_tokens } : {}),
        ...(typeof u.completion_tokens === "number" ? { outputTokens: u.completion_tokens } : {}),
      }
    }

    // Model identity from response (use configured model ID for provenance)
    const reportedModel = typeof raw.model === "string" ? raw.model : this.#model
    void reportedModel // provenance is from config, not endpoint spoofing

    // Suppress unused variable warning
    void request

    return {
      text: cleanText,
      deploymentId: this.deploymentId,
      providerId: this.providerId,
      modelId: this.modelId,
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }
  }
}

/**
 * Create a LocalFimProvider from routing configuration fields.
 * The endpoint is taken from the deployment configuration, never hardcoded.
 */
export function createLocalFimProvider(config: {
  readonly providerId: string
  readonly modelId: string
  readonly deploymentId: string
  readonly baseUrl: string
  readonly model: string
  readonly fimStrategy?: FimStrategy
  readonly timeoutMs?: number
}): LocalFimProvider {
  return new LocalFimProvider(config)
}
