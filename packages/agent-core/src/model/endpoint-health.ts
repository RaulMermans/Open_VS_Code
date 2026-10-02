/**
 * EndpointHealthChecker — Sprint 4E.
 *
 * Probes local inference endpoint health with:
 *   - short bounded timeout (default 3s)
 *   - cancellable via AbortSignal
 *   - bounded caching of availability state (TTL-based)
 *   - no model generation required (uses GET /v1/models or HEAD)
 *
 * This avoids health storms: the checker caches results for cacheTtlMs.
 * If caching is not desired, set cacheTtlMs to 0.
 *
 * Security: only probes explicitly configured local endpoints.
 * Does not accept arbitrary URLs from model output.
 */

import type { HealthChecker } from "./router.ts"
import type { ProviderHealthState } from "../contracts/routing.ts"
import { resolveCanonicalEndpoints } from "./canonical-endpoint.ts"

export interface EndpointHealthConfig {
  /**
   * Map of deploymentId → local endpoint URL to probe.
   * Endpoints must be operator-configured — never constructed from model output.
   */
  readonly endpoints: ReadonlyMap<string, string>
  /** Optional headers per deploymentId or default headers to send with probes. */
  readonly headers?: ReadonlyMap<string, Readonly<Record<string, string>>> | Readonly<Record<string, string>>
  /** Probe timeout in ms. Default: 3000. */
  readonly probeTimeoutMs?: number
  /** Cache TTL in ms. Default: 30_000 (30s). Set to 0 to disable caching. */
  readonly cacheTtlMs?: number
  /** Fetch implementation — injectable for tests. */
  readonly fetch?: typeof fetch
}

interface CachedState {
  readonly state: ProviderHealthState
  readonly expiresAt: number
}

/**
 * EndpointHealthChecker: probes OpenAI-compatible local endpoints via GET /v1/models.
 *
 * Falls back gracefully:
 *   - No cheap probe available → returns "unknown" (routing proceeds).
 *   - Endpoint unavailable → returns "unavailable" (deployment excluded).
 *   - Probe succeeds → returns "ready".
 */
export class EndpointHealthChecker implements HealthChecker {
  readonly #config: EndpointHealthConfig
  readonly #cache = new Map<string, CachedState>()
  readonly #probeTimeoutMs: number
  readonly #cacheTtlMs: number
  readonly #fetch: typeof fetch

  constructor(config: EndpointHealthConfig) {
    this.#config = config
    this.#probeTimeoutMs = config.probeTimeoutMs ?? 3_000
    this.#cacheTtlMs = config.cacheTtlMs ?? 30_000
    this.#fetch = config.fetch ?? globalThis.fetch
  }

  async checkHealth(deploymentId: string, signal?: AbortSignal): Promise<ProviderHealthState> {
    const endpointUrl = this.#config.endpoints.get(deploymentId)
    if (!endpointUrl) {
      // No endpoint configured for this deployment — pass through as unknown
      return "unknown"
    }

    // Check cache
    if (this.#cacheTtlMs > 0) {
      const cached = this.#cache.get(deploymentId)
      if (cached && Date.now() < cached.expiresAt) {
        return cached.state
      }
    }

    const state = await this.#probe(deploymentId, endpointUrl, signal)

    // Cache result
    if (this.#cacheTtlMs > 0) {
      this.#cache.set(deploymentId, { state, expiresAt: Date.now() + this.#cacheTtlMs })
    }

    return state
  }

  async #probe(deploymentId: string, endpointUrl: string, signal?: AbortSignal): Promise<ProviderHealthState> {
    const timeoutSignal = AbortSignal.timeout(this.#probeTimeoutMs)
    const probeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    try {
      // Probe via GET /v1/models — cheap, no inference, standard for Ollama/vLLM
      const canonical = resolveCanonicalEndpoints(endpointUrl)
      const url = new URL(canonical.modelsEndpoint)
      const deploymentHeaders = this.#config.headers instanceof Map
        ? this.#config.headers.get(deploymentId)
        : this.#config.headers
      const response = await this.#fetch(url, {
        method: "GET",
        headers: deploymentHeaders ? { ...deploymentHeaders } : undefined,
        signal: probeSignal,
      })
      if (response.ok) return "ready"
      if (response.status >= 500) return "unavailable"
      // 4xx — endpoint is up but returns error — treat as degraded
      return "degraded"
    } catch (error) {
      if (signal?.aborted) return "unknown"
      if (timeoutSignal.aborted) return "unavailable"
      // Network error — endpoint is unavailable
      void deploymentId // suppress unused var lint
      void error
      return "unavailable"
    }
  }

  /** Invalidate cache for a specific deployment. */
  invalidate(deploymentId: string): void {
    this.#cache.delete(deploymentId)
  }

  /** Clear entire health cache. */
  clearCache(): void {
    this.#cache.clear()
  }
}
