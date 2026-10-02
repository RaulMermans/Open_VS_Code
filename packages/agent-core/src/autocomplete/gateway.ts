/**
 * AutocompleteGateway — Sprint 3E.
 *
 * This is the ONLY path autocomplete uses to reach a model.
 *
 * Deliberately NOT a ModelProvider / RoutedModelGateway.  It speaks
 * AutocompleteRequest → AutocompleteResponse, not ModelRequest → ModelResponse.
 * There is no AgentRunner, no tools, no MCP, no mutation, no memory.
 *
 * Flow:
 *   AutocompleteGateway.complete(request)
 *     → ModelRouter.route(requirements)          (reuses existing router)
 *     → resolve AutocompleteProvider from registry
 *     → provider.complete(request)               (FIM or autocomplete capable)
 *     → AutocompleteResponse
 *
 * If no compatible route exists:
 *   → throw RouteUnavailableError (caller returns empty completion, no UI error)
 *
 * Cancellation:
 *   → request.signal is propagated into ModelRouter and provider
 *   → cancellation does NOT trigger fallback (side-effect replay protection)
 *
 * No cloud fallback — if no local route exists, throw.
 */

import { join } from "node:path"
import type { AutocompleteRequest, AutocompleteResponse, AutocompleteProvider } from "./contracts.ts"
import type { RoutingConfiguration } from "../contracts/routing.ts"
import { ModelPerformanceLedger } from "../model/performance-ledger.ts"
import { ModelRouter, RouteUnavailableError, type HealthChecker } from "../model/router.ts"
import { StaticHealthChecker } from "../model/routed-gateway.ts"
import { EndpointHealthChecker } from "../model/endpoint-health.ts"
import { LocalFimProvider } from "./local-fim-provider.ts"
import { MAX_OUTPUT_TOKENS, estimateTokensFromChars } from "./budget.ts"
import { loadRoutingConfigSync, resolveProviderApiKey } from "../model/config-loader.ts"
import { resolveDeploymentEndpoint, resolveServedModelId } from "../model/canonical-endpoint.ts"

export type AutocompleteProviderRegistry = ReadonlyMap<string, AutocompleteProvider>


export interface AutocompleteGatewayOptions {
  readonly config: RoutingConfiguration
  readonly providers: AutocompleteProviderRegistry
  readonly healthChecker?: HealthChecker
  readonly performanceLedger?: ModelPerformanceLedger | undefined
}

/**
 * AutocompleteGateway.
 *
 * Thread model: one gateway shared by the AutocompleteController.
 * Concurrent requests each carry their own AbortSignal; the gateway does not
 * serialize them.
 */
export class AutocompleteGateway {
  readonly #router: ModelRouter
  readonly #providers: AutocompleteProviderRegistry
  readonly #healthChecker: HealthChecker
  readonly #performanceLedger?: ModelPerformanceLedger | undefined

  constructor(options: AutocompleteGatewayOptions) {
    this.#router = new ModelRouter(
      options.config,
      options.performanceLedger ? { performanceLedger: options.performanceLedger } : undefined,
    )
    this.#providers = options.providers
    this.#healthChecker = options.healthChecker ?? new StaticHealthChecker()
    this.#performanceLedger = options.performanceLedger
  }

  get performanceLedger(): ModelPerformanceLedger | undefined {
    return this.#performanceLedger
  }

  get providerRegistry(): AutocompleteProviderRegistry {
    return this.#providers
  }

  get healthChecker(): HealthChecker {
    return this.#healthChecker
  }

  /** Resolves when performance ledger (if configured) has finished loading. */
  get ready(): Promise<void> {
    return this.#performanceLedger?.ready ?? Promise.resolve()
  }

  /**
   * Route and complete one autocomplete request.
   *
   * @throws RouteUnavailableError  No compatible healthy deployment.
   * @throws Error                  Provider error, timeout, or abort.
   */
  async complete(request: AutocompleteRequest): Promise<AutocompleteResponse> {
    // Ensure ledger evidence is loaded before routing decisions
    await this.ready

    // Abort check before routing overhead
    if (request.signal.aborted) {
      throw new Error("Autocomplete request aborted before routing")
    }

    const estimatedInput = estimateTokensFromChars(request.prefix.length + request.suffix.length)

    const requirements = {
      taskClass: "autocomplete" as const,
      needsTools: false,
      needsStructuredOutput: false,
      estimatedInputTokens: estimatedInput,
      // Context window = estimated input + max output
      requiredContextWindow: estimatedInput + MAX_OUTPUT_TOKENS,
      // Require at least one of fim or autocomplete capability
      requiredCapabilities: ["autocomplete"] as const,
    }

    // Route — throws RouteUnavailableError if no compatible deployment
    const decision = await this.#router.route(requirements, this.#healthChecker, request.signal)

    // Abort check after routing, before provider invocation
    if (request.signal.aborted) {
      throw new Error("Autocomplete request aborted after routing")
    }

    // Resolve provider from registry — prefer deploymentId, fall back to providerId
    const provider = this.#providers.get(decision.deploymentId) ?? this.#providers.get(decision.providerId)
    if (!provider) {
      throw new RouteUnavailableError(
        `AutocompleteGateway: provider '${decision.providerId}' not found in registry`
      )
    }

    // Invoke — no fallback after this point
    return provider.complete(request)
  }
}

export { RouteUnavailableError }

const EMPTY_ROUTING_CONFIG: RoutingConfiguration = {
  providers: [],
  models: [],
  deployments: [],
  routes: {},
}

/**
 * Construct a production AutocompleteGateway from workspace routing config.
 *
 * If workspaceRoot is provided and contains a valid .open-vs-code/models.json,
 * that routing configuration is loaded. Otherwise, a safe empty configuration
 * (0 autocomplete deployments) is used.
 *
 * In production:
 *   - ScriptedAutocompleteProvider is NEVER instantiated
 *   - Real models are NEVER downloaded or eagerly invoked
 *   - If no compatible autocomplete route exists, queries throw RouteUnavailableError,
 *     which AutocompleteService quietly swallows without UI error or crash.
 */
export function createProductionAutocompleteGateway(
  workspaceRootOrConfig?: string | RoutingConfiguration,
  customProviders?: AutocompleteProviderRegistry,
  performanceLedger?: ModelPerformanceLedger,
  healthChecker?: HealthChecker,
): AutocompleteGateway {
  let config: RoutingConfiguration = EMPTY_ROUTING_CONFIG
  const workspaceRoot = typeof workspaceRootOrConfig === "string" ? workspaceRootOrConfig : undefined

  if (workspaceRootOrConfig && typeof workspaceRootOrConfig === "object") {
    config = workspaceRootOrConfig
  } else if (workspaceRoot) {
    try {
      const loaded = loadRoutingConfigSync(workspaceRoot)
      if (loaded) {
        config = loaded
      }
    } catch {
      // Malformed or missing models.json falls back safely to empty config
      config = EMPTY_ROUTING_CONFIG
    }
  }

  // Populate providers: preserve customProviders if passed, and construct real LocalFimProvider
  // for any eligible local autocomplete deployments configured in models.json.
  const providers = new Map<string, AutocompleteProvider>(customProviders ?? [])

  const endpointMap = new Map<string, string>()
  const authHeadersMap = new Map<string, Record<string, string>>()

  for (const deployment of config.deployments) {
    const providerConfig = config.providers.find(p => p.id === deployment.providerId)
    let ep: string | undefined
    try {
      if (providerConfig?.kind === "openai_compatible_local") {
        ep = resolveDeploymentEndpoint(deployment, providerConfig)
        endpointMap.set(deployment.id, ep)
      }
    } catch {
      // Endpoint resolution failed; deployment will not be healthy/routable
    }

    // Only instantiate if not already provided via customProviders
    if (providers.has(deployment.id) || providers.has(deployment.providerId)) {
      continue
    }

    const modelConfig = config.models.find(m => m.id === deployment.modelId)

    const hasFimCapability = modelConfig?.capabilities.some(
      cap => cap === "autocomplete" || cap === "fim"
    )

    const fimStrategy = deployment.fimStrategy ?? modelConfig?.fimStrategy

    if (
      deployment.enabled &&
      providerConfig?.kind === "openai_compatible_local" &&
      hasFimCapability &&
      ep &&
      fimStrategy // Explicit strategy required — no guessing
    ) {
      const wireModel = resolveServedModelId(deployment, modelConfig)
      const apiKey = resolveProviderApiKey(providerConfig)
      const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined
      if (headers) authHeadersMap.set(deployment.id, headers)
      providers.set(
        deployment.id,
        new LocalFimProvider({
          providerId: deployment.providerId,
          modelId: deployment.modelId,
          deploymentId: deployment.id,
          baseUrl: ep,
          model: wireModel,
          fimStrategy,
          ...(headers ? { headers } : {}),
        })
      )
    }
  }

  const resolvedHealthChecker = healthChecker ?? (
    endpointMap.size > 0
      ? new EndpointHealthChecker({ endpoints: endpointMap, headers: authHeadersMap })
      : new StaticHealthChecker()
  )

  const resolvedLedger = performanceLedger ?? (
    workspaceRoot
      ? new ModelPerformanceLedger({
          persistPath: join(workspaceRoot, ".open-vs-code", "model-performance-ledger.json"),
        })
      : new ModelPerformanceLedger()
  )
  if (resolvedLedger && !performanceLedger) {
    void resolvedLedger.load().catch(() => {})
  }

  return new AutocompleteGateway({
    config,
    providers,
    healthChecker: resolvedHealthChecker,
    ...(resolvedLedger ? { performanceLedger: resolvedLedger } : {}),
  })
}
