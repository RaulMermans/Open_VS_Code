import type { ModelProvider, ModelRequest, ModelResponse, ModelCapability } from "../contracts/model.ts"
import type { RouteDecision, RoutingConfiguration, ProviderHealthState, ModelRouteHint } from "../contracts/routing.ts"
import type { ContextBudget } from "../contracts/context.ts"
import type { AgentMode } from "../contracts/agent.ts"
import type { ModelPerformanceLedger } from "./performance-ledger.ts"
import { ModelRouter, type HealthChecker } from "./router.ts"
import { buildModelRouteRequirements, type RouteRequirementsInput } from "./route-requirements.ts"

/**
 * Route provenance attached to each model response.
 * Compact — no chain-of-thought, no full config, no secrets.
 */
export interface RouteProvenance {
  readonly deploymentId: string
  readonly providerId: string
  readonly modelId: string
  readonly taskClass: string
  readonly reasonCodes: readonly string[]
  readonly fallbackLevel: number
}

/**
 * Usage provenance: preserves truthful usage data.
 * If provider does not report usage, reported values remain undefined.
 */
export interface UsageProvenance {
  readonly estimatedInputTokens: number
  readonly reportedInputTokens: number | undefined
  readonly reportedOutputTokens: number | undefined
  readonly totalTokens: number | undefined
}

/**
 * Compact route diagnostics exposed to operators.
 * Does not contain full prompts, full config, secrets, or huge registry dumps.
 */
export interface RouteDiagnostics {
  readonly route: RouteProvenance
  readonly usage: UsageProvenance
  readonly requiredContext: number
  readonly selectedContext: number
}

/**
 * Provider registry: maps provider IDs to ModelProvider instances.
 * For tests: scripted-a, scripted-b.
 * For future target machine: local-openai-compatible.
 * The router does not instantiate arbitrary executables from model output.
 */
export type ProviderRegistry = ReadonlyMap<string, ModelProvider>

/**
 * Static health checker that returns pre-configured health states.
 * For production use, extend with actual endpoint probing.
 */
export class StaticHealthChecker implements HealthChecker {
  readonly #states: ReadonlyMap<string, ProviderHealthState>

  constructor(states?: ReadonlyMap<string, ProviderHealthState>) {
    this.#states = states ?? new Map()
  }

  async checkHealth(deploymentId: string): Promise<ProviderHealthState> {
    return this.#states.get(deploymentId) ?? "unknown"
  }
}

export interface RoutedGatewayOptions {
  readonly config: RoutingConfiguration
  readonly providers: ProviderRegistry
  readonly healthChecker?: HealthChecker
  readonly performanceLedger?: ModelPerformanceLedger | undefined
  readonly mode: AgentMode
  readonly hasTools: boolean
  readonly hasStructuredOutput: boolean
  readonly budget?: ContextBudget
  readonly preferredDeploymentId?: string | undefined
}

/**
 * RoutedModelGateway: the production integration seam.
 * Implements ModelProvider, so it's a drop-in replacement.
 *
 * Flow:
 * 1. Build route requirements from runtime facts
 * 2. Call ModelRouter
 * 3. Resolve selected configured provider
 * 4. Invoke existing provider
 * 5. Retain RouteDecision and usage provenance
 *
 * Does NOT own: permissions, tools, repair, verification, mutation, session memory, MCP.
 *
 * Cancellation policy: AbortSignal propagated to provider. Cancellation does NOT trigger fallback.
 * Side-effect replay protection: Fallback only occurs before provider invocation. Once a provider
 * is called, its result (success or failure) is final for that request.
 */
export class RoutedModelGateway implements ModelProvider {
  readonly capabilities: ReadonlySet<ModelCapability>
  readonly #router: ModelRouter
  readonly #providers: ProviderRegistry
  readonly #healthChecker: HealthChecker
  readonly #performanceLedger?: ModelPerformanceLedger | undefined
  readonly #mode: AgentMode
  readonly #hasTools: boolean
  readonly #hasStructuredOutput: boolean
  readonly #budget: ContextBudget | undefined
  readonly #preferredDeploymentId: string | undefined

  #lastDecision?: RouteDecision
  #lastDiagnostics?: RouteDiagnostics

  constructor(options: RoutedGatewayOptions) {
    this.#router = new ModelRouter(
      options.config,
      options.performanceLedger ? { performanceLedger: options.performanceLedger } : undefined,
    )
    this.#providers = options.providers
    this.#healthChecker = options.healthChecker ?? new StaticHealthChecker()
    this.#performanceLedger = options.performanceLedger
    this.#mode = options.mode
    this.#hasTools = options.hasTools
    this.#hasStructuredOutput = options.hasStructuredOutput
    this.#budget = options.budget
    this.#preferredDeploymentId = options.preferredDeploymentId

    // Aggregate capabilities from all registered providers
    const allCaps = new Set<ModelCapability>()
    for (const provider of options.providers.values()) {
      for (const cap of provider.capabilities) {
        allCaps.add(cap as ModelCapability)
      }
    }
    this.capabilities = allCaps
  }

  get lastDecision(): RouteDecision | undefined { return this.#lastDecision }
  get lastDiagnostics(): RouteDiagnostics | undefined { return this.#lastDiagnostics }
  get performanceLedger(): ModelPerformanceLedger | undefined { return this.#performanceLedger }
  get preferredDeploymentId(): string | undefined { return this.#preferredDeploymentId }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Step 1: Estimate input tokens from request
    const estimatedInputTokens = this.#estimateInputTokens(request)

    // Step 2: Build route requirements from actual runtime facts
    const baseHint = request.metadata?.routeHint as ModelRouteHint | undefined
    const hint: ModelRouteHint | undefined = this.#preferredDeploymentId
      ? { preferredDeploymentId: this.#preferredDeploymentId, ...baseHint }
      : baseHint
    const reqInput: RouteRequirementsInput = {
      mode: this.#mode,
      estimatedInputTokens,
      hasTools: this.#hasTools,
      hasStructuredOutput: this.#hasStructuredOutput,
      ...(this.#budget ? { budget: this.#budget } : {}),
      ...(hint ? { hint } : {}),
    }
    const requirements = buildModelRouteRequirements(reqInput)

    // Step 3: Route through ModelRouter (deterministic)
    const decision = await this.#router.route(requirements, this.#healthChecker, request.signal)
    this.#lastDecision = decision

    // Step 4: Resolve provider from registry
    const provider = this.#providers.get(decision.deploymentId) ?? this.#providers.get(decision.providerId)
    if (!provider) {
      throw new Error(`Provider '${decision.providerId}' not found in registry`)
    }

    // Step 5: Cancellation check — AbortSignal observed, no fallback
    if (request.signal?.aborted) {
      throw new Error("Request aborted")
    }

    // Step 6: Invoke provider — this is the point of no return for side effects
    // After this call, NO automatic fallback occurs.
    const response = await provider.complete(request)

    // Step 7: Build usage provenance (truthful — unknown stays unknown)
    const usage: UsageProvenance = {
      estimatedInputTokens,
      reportedInputTokens: response.usage?.inputTokens,
      reportedOutputTokens: response.usage?.outputTokens,
      totalTokens: response.usage?.inputTokens !== undefined && response.usage?.outputTokens !== undefined
        ? response.usage.inputTokens + response.usage.outputTokens
        : undefined,
    }

    // Step 8: Build route provenance (compact — no chain-of-thought)
    const routeProvenance: RouteProvenance = {
      deploymentId: decision.deploymentId,
      providerId: decision.providerId,
      modelId: decision.modelId,
      taskClass: decision.taskClass,
      reasonCodes: decision.reasons,
      fallbackLevel: decision.fallbackLevel,
    }

    this.#lastDiagnostics = {
      route: routeProvenance,
      usage,
      requiredContext: decision.requiredContext,
      selectedContext: decision.selectedContext,
    }

    // Step 9: Return response with provenance metadata
    // Endpoint response model-name spoofing does NOT replace configured route identity
    return {
      ...response,
      metadata: {
        ...response.metadata,
        routeProvenance,
        usageProvenance: usage,
      },
    }
  }

  /**
   * Estimate input tokens from model request.
   * Reuses the existing ~4 chars/token estimate from ContextBudget.
   */
  #estimateInputTokens(request: ModelRequest): number {
    let chars = 0
    for (const msg of request.messages) {
      chars += msg.content.length
    }
    // Include tool definitions in estimate if present
    if (request.tools) {
      for (const tool of request.tools) {
        chars += JSON.stringify(tool).length
      }
    }
    return Math.ceil(chars / 4)
  }
}
