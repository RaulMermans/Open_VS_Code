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

import type { AutocompleteRequest, AutocompleteResponse, AutocompleteProvider } from "./contracts.ts"
import type { RoutingConfiguration } from "../contracts/routing.ts"
import { ModelRouter, RouteUnavailableError, type HealthChecker } from "../model/router.ts"
import { StaticHealthChecker } from "../model/routed-gateway.ts"
import { MAX_OUTPUT_TOKENS, estimateTokensFromChars } from "./budget.ts"
import { loadRoutingConfigSync } from "../model/config-loader.ts"

export type AutocompleteProviderRegistry = ReadonlyMap<string, AutocompleteProvider>


export interface AutocompleteGatewayOptions {
  readonly config: RoutingConfiguration
  readonly providers: AutocompleteProviderRegistry
  readonly healthChecker?: HealthChecker
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

  constructor(options: AutocompleteGatewayOptions) {
    this.#router = new ModelRouter(options.config)
    this.#providers = options.providers
    this.#healthChecker = options.healthChecker ?? new StaticHealthChecker()
  }

  /**
   * Route and complete one autocomplete request.
   *
   * @throws RouteUnavailableError  No compatible healthy deployment.
   * @throws Error                  Provider error, timeout, or abort.
   */
  async complete(request: AutocompleteRequest): Promise<AutocompleteResponse> {
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
  workspaceRoot?: string,
  customProviders?: AutocompleteProviderRegistry,
): AutocompleteGateway {
  let config: RoutingConfiguration = EMPTY_ROUTING_CONFIG
  if (workspaceRoot) {
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

  // In production with 0 configured autocomplete deployments or no provider instances,
  // the provider registry is empty.
  const providers = customProviders ?? new Map<string, AutocompleteProvider>()

  return new AutocompleteGateway({
    config,
    providers,
  })
}
