/**
 * Canonical Endpoint Resolution & Local Endpoint Policy — Sprint 4E.1.
 *
 * Establishes ONE authoritative contract for self-hosted OpenAI-compatible inference.
 *
 * Rules:
 *   1. Only http: and https: protocols are permitted.
 *   2. Queries (?) and fragments (#) are strictly rejected.
 *   3. Proprietary cloud API hostnames (OpenAI, Anthropic, Google, etc.) are strictly rejected.
 *      Self-hosted/local deployments only.
 *   4. URL normalization is deterministic:
 *      - Host root (e.g. "http://127.0.0.1:11434" or "http://127.0.0.1:11434/")
 *      - Explicit /v1 (e.g. "http://127.0.0.1:11434/v1" or "http://127.0.0.1:11434/v1/")
 *      Both resolve to:
 *        chatEndpoint:        http://127.0.0.1:11434/v1/chat/completions
 *        completionsEndpoint: http://127.0.0.1:11434/v1/completions
 *        modelsEndpoint:      http://127.0.0.1:11434/v1/models
 *      No missing /v1, no duplicated /v1/v1.
 */

export class EndpointPolicyError extends Error {
  readonly code: string

  constructor(message: string, code: string = "ENDPOINT_POLICY_VIOLATION") {
    super(message)
    this.name = "EndpointPolicyError"
    this.code = code
  }
}

/** Known proprietary cloud API endpoints that violate the local-first open-weight policy. */
export const FORBIDDEN_CLOUD_HOSTS: ReadonlySet<string> = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.mistral.ai",
  "api.cohere.com",
  "api.groq.com",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.deepseek.com",
  "api.perplexity.ai",
  "chatgpt.com",
  "claude.ai",
])

export interface CanonicalEndpoints {
  /** The normalized origin + base path (without /v1 and without trailing slash). */
  readonly baseRoot: string
  /** The normalized base URL ending with /v1 (without trailing slash). */
  readonly baseV1Url: string
  /** Canonical /v1/chat/completions endpoint URL string. */
  readonly chatEndpoint: string
  /** Canonical /v1/completions endpoint URL string (for FIM). */
  readonly completionsEndpoint: string
  /** Canonical /v1/models endpoint URL string (for health probes). */
  readonly modelsEndpoint: string
}

/**
 * Validate and resolve an OpenAI-compatible endpoint URL into canonical subpaths.
 *
 * @throws TypeError If the URL is malformed, uses an unsupported protocol, or contains query/fragment.
 * @throws EndpointPolicyError If the endpoint points to a known proprietary cloud LLM service.
 */
export function resolveCanonicalEndpoints(input: string | URL): CanonicalEndpoints {
  const url = typeof input === "string" ? new URL(input) : new URL(input.href)

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointPolicyError(`Endpoint must use HTTP or HTTPS protocol (received: '${url.protocol}')`, "INVALID_PROTOCOL")
  }

  if (url.search) {
    throw new EndpointPolicyError("Endpoint URL cannot contain a query", "QUERY_NOT_ALLOWED")
  }

  if (url.hash) {
    throw new EndpointPolicyError("Endpoint URL cannot contain a fragment", "FRAGMENT_NOT_ALLOWED")
  }

  const hostname = url.hostname.toLowerCase()
  if (FORBIDDEN_CLOUD_HOSTS.has(hostname)) {
    throw new EndpointPolicyError(
      `Proprietary cloud endpoint '${hostname}' is forbidden. ` +
      `Open VS Code requires self-hosted, local open-weight model endpoints.`,
      "PROPRIETARY_CLOUD_FORBIDDEN"
    )
  }

  // Normalize pathname: remove trailing slashes
  let pathname = url.pathname.replace(/\/+$/, "")

  // If path ends with /v1, strip it to get baseRoot
  if (pathname.endsWith("/v1")) {
    pathname = pathname.slice(0, -3)
  }

  const origin = url.origin
  const baseRoot = pathname ? `${origin}${pathname}` : origin
  const baseV1Url = `${baseRoot}/v1`

  return {
    baseRoot,
    baseV1Url,
    chatEndpoint: `${baseV1Url}/chat/completions`,
    completionsEndpoint: `${baseV1Url}/completions`,
    modelsEndpoint: `${baseV1Url}/models`,
  }
}
