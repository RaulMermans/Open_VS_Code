import type {
  RoutingConfiguration,
  ModelRouteRequirements,
  RouteDecision,
  RejectedCandidate,
  RouteReasonCode,
  ProviderHealthState,
  ModelDeployment,
  ModelDescriptor,
} from "../contracts/routing.ts"
import type { ModelPerformanceLedger } from "./performance-ledger.ts"

export interface HealthChecker {
  checkHealth(deploymentId: string, signal?: AbortSignal): Promise<ProviderHealthState>
}

export interface ModelRouterOptions {
  readonly performanceLedger?: ModelPerformanceLedger | undefined
}

interface ScoredCandidate {
  deployment: ModelDeployment
  model: ModelDescriptor
  effectiveContext: number
  health: ProviderHealthState
  specializationScore: number
  priority: number
  isAvoided: boolean
  isPreferred: boolean
  rejectedReason?: RouteReasonCode
  performanceAdjustment?: number
}

const candidateSorter = (a: ScoredCandidate, b: ScoredCandidate) => {
  if (a.isAvoided !== b.isAvoided) {
    return a.isAvoided ? 1 : -1
  }
  if (a.isPreferred !== b.isPreferred) {
    return a.isPreferred ? -1 : 1
  }
  if (a.specializationScore !== b.specializationScore) {
    return b.specializationScore - a.specializationScore
  }
  if (a.priority !== b.priority) {
    return b.priority - a.priority
  }
  return a.deployment.id.localeCompare(b.deployment.id)
}


export class RouteUnavailableError extends Error {
  public readonly rejectedCandidates: readonly RejectedCandidate[] | undefined
  
  constructor(message: string, rejectedCandidates?: readonly RejectedCandidate[]) {
    super(message)
    this.name = "RouteUnavailableError"
    this.rejectedCandidates = rejectedCandidates
  }
}

export class ModelRouter {
  readonly #config: RoutingConfiguration
  readonly #performanceLedger?: ModelPerformanceLedger | undefined

  constructor(config: RoutingConfiguration, options?: ModelRouterOptions) {
    this.#validateConfig(config)
    this.#config = config
    this.#performanceLedger = options?.performanceLedger
  }

  #validateConfig(config: RoutingConfiguration) {
    const providerIds = new Set(config.providers.map(p => p.id))
    const modelIds = new Set(config.models.map(m => m.id))
    const deploymentIds = new Set<string>()

    for (const d of config.deployments) {
      if (deploymentIds.has(d.id)) {
        throw new Error(`Duplicate deployment ID: ${d.id}`)
      }
      deploymentIds.add(d.id)
      if (!providerIds.has(d.providerId)) {
        throw new Error(`Unknown provider ID '${d.providerId}' in deployment '${d.id}'`)
      }
      if (!modelIds.has(d.modelId)) {
        throw new Error(`Unknown model ID '${d.modelId}' in deployment '${d.id}'`)
      }
    }
  }

  async route(requirements: ModelRouteRequirements, healthChecker: HealthChecker, signal?: AbortSignal): Promise<RouteDecision> {
    const candidateIds = this.#config.routes[requirements.taskClass] ?? this.#config.routes.default ?? []
    
    if (candidateIds.length === 0) {
      throw new RouteUnavailableError("ROUTE_UNAVAILABLE: No candidates configured for task class")
    }


    const scored: ScoredCandidate[] = []
    const rejected: RejectedCandidate[] = []

    for (const deploymentId of candidateIds) {
      const deployment = this.#config.deployments.find(d => d.id === deploymentId)
      if (!deployment) continue

      if (!deployment.enabled) {
        rejected.push({ deploymentId, reason: "disabled" })
        continue
      }

      const model = this.#config.models.find(m => m.id === deployment.modelId)!
      const effectiveContext = deployment.contextWindow ?? model.contextWindow
      
      let rejectReason: RouteReasonCode | undefined

      if (effectiveContext < requirements.requiredContextWindow) {
        rejectReason = "insufficient_context"
      } else if (requirements.needsTools && !model.capabilities.includes("toolUse")) {
        rejectReason = "missing_tool_use"
      } else if (requirements.needsStructuredOutput && !model.capabilities.includes("structuredOutput")) {
        rejectReason = "missing_structured_output"
      } else if (requirements.requiredCapabilities && requirements.requiredCapabilities.length > 0) {
        const missing = requirements.requiredCapabilities.find(cap => !model.capabilities.includes(cap))
        if (missing) {
          rejectReason = "missing_required_capability"
        }
      }

      const isAvoided = Boolean(requirements.hint?.avoidDeploymentId && requirements.hint.avoidDeploymentId === deployment.id)
      const isPreferred = Boolean(
        (requirements.hint?.preferredDeploymentId && requirements.hint.preferredDeploymentId === deployment.id) ||
        (requirements.hint?.preferredCapabilities && requirements.hint.preferredCapabilities.some(cap => model.capabilities.includes(cap)))
      )

      if (rejectReason) {
        rejected.push({ deploymentId, reason: rejectReason })
        scored.push({
          deployment,
          model,
          effectiveContext,
          health: "unknown",
          specializationScore: -1,
          priority: -1,
          isAvoided,
          isPreferred,
          rejectedReason: rejectReason
        })
        continue
      }

      // Check health
      const health = await healthChecker.checkHealth(deploymentId, signal)
      
      let specScore = 0
      if (requirements.specialization && model.specialization === requirements.specialization) {
        specScore = 1
      }
      const priority = deployment.priority ?? 0

      if (health === "unavailable") {
        rejected.push({ deploymentId, reason: "unhealthy" })
        scored.push({
          deployment,
          model,
          effectiveContext,
          health,
          specializationScore: specScore,
          priority,
          isAvoided,
          isPreferred,
          rejectedReason: "unhealthy"
        })
        continue
      }

      scored.push({
        deployment,
        model,
        effectiveContext,
        health,
        specializationScore: specScore,
        priority,
        isAvoided,
        isPreferred
      })
    }

    const eligible = scored.filter(c => !c.rejectedReason)

    if (eligible.length === 0) {
      throw new RouteUnavailableError("ROUTE_UNAVAILABLE: No compatible healthy deployment found in the permitted fallback chain", rejected)
    }

    // Apply performance ledger adjustments if available and active
    if (this.#performanceLedger && this.#performanceLedger.adaptiveRoutingActive) {
      const adjustments = this.#performanceLedger.getRoutingAdjustments(
        eligible.map(c => c.deployment.id),
        requirements.taskClass,
      )
      const adjustmentMap = new Map(adjustments.map(a => [a.deploymentId, a.adjustment]))
      for (const candidate of eligible) {
        const adj = adjustmentMap.get(candidate.deployment.id)
        if (adj !== undefined) {
          candidate.priority += adj
          candidate.performanceAdjustment = adj
        }
      }
    }

    // Sort: specializationScore (desc) > priority (desc) > stable ID tie-break (asc)
    eligible.sort(candidateSorter)

    const selected = eligible[0]!
    
    const allCompatible = scored
      .filter(c => !c.rejectedReason || c.rejectedReason === "unhealthy")
      .toSorted(candidateSorter)

    const fallbackLevel = allCompatible.findIndex(c => c.deployment.id === selected.deployment.id)

    const reasons: RouteReasonCode[] = ["context_fit"]
    if (selected.health === "ready") reasons.push("health_ready")
    if (selected.health === "unknown") reasons.push("health_unknown")
    if (requirements.needsTools) reasons.push("tool_use_required")
    if (requirements.needsStructuredOutput) reasons.push("structured_output_required")
    if (selected.specializationScore > 0) reasons.push("coding_specialization")
    if (selected.deployment.priority !== undefined) reasons.push("priority")
    if (selected.isPreferred) reasons.push("hint_preferred")
    if (requirements.hint?.avoidDeploymentId && eligible.some(c => c.isAvoided && c.deployment.id !== selected.deployment.id)) {
      reasons.push("hint_avoided")
    }
    if (selected.performanceAdjustment !== undefined && Math.abs(selected.performanceAdjustment) > 0) {
      reasons.push(selected.performanceAdjustment > 0 ? "performance_score" : "performance_penalty")
    }

    return {
      deploymentId: selected.deployment.id,
      providerId: selected.deployment.providerId,
      modelId: selected.deployment.modelId,
      taskClass: requirements.taskClass,
      reasons,
      rejectedCandidates: rejected,
      fallbackLevel: Math.max(0, fallbackLevel),
      requiredContext: requirements.requiredContextWindow,
      selectedContext: selected.effectiveContext,
      healthState: selected.health,
      ...(selected.performanceAdjustment !== undefined ? { performanceAdjustment: selected.performanceAdjustment } : {}),
    }
  }
}
