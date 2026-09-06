export type ProviderKind = "scripted" | "openai_compatible_local" | "fake"

export interface ProviderDescriptor {
  readonly id: string
  readonly kind: ProviderKind
  readonly protocol?: string
}

export type ModelCapability = "toolUse" | "structuredOutput" | "coding" | "reasoning" | "longContext" | "vision"
export type ModelSpecialization = "general" | "coding" | "reasoning"

export interface ModelDescriptor {
  readonly id: string
  readonly displayName?: string
  readonly family?: string
  readonly contextWindow: number
  readonly maxOutputTokens?: number
  readonly capabilities: readonly ModelCapability[]
  readonly specialization: ModelSpecialization
  readonly provenance?: string
}

export interface ModelDeployment {
  readonly id: string
  readonly providerId: string
  readonly modelId: string
  readonly endpoint?: string // Env var reference or literal if testing
  readonly enabled: boolean
  readonly contextWindow?: number
  readonly priority?: number
  readonly tags?: readonly string[]
}

export type TaskClass = "general" | "planning" | "coding" | "debugging" | "review" | "structured_generation" | "tool_using"

export interface ModelRouteRequirements {
  readonly mode?: string
  readonly taskClass: TaskClass
  readonly needsTools: boolean
  readonly needsStructuredOutput: boolean
  readonly estimatedInputTokens: number
  readonly requiredContextWindow: number
  readonly specialization?: ModelSpecialization
}

export type RouteReasonCode = 
  | "disabled" 
  | "unhealthy" 
  | "insufficient_context" 
  | "missing_tool_use" 
  | "missing_structured_output" 
  | "provider_unavailable"
  | "coding_specialization"
  | "tool_use_required"
  | "structured_output_required"
  | "context_fit"
  | "priority"
  | "health_ready"

export interface RejectedCandidate {
  readonly deploymentId: string
  readonly reason: RouteReasonCode
}

export interface RouteDecision {
  readonly deploymentId: string
  readonly providerId: string
  readonly modelId: string
  readonly taskClass: TaskClass
  readonly reasons: readonly RouteReasonCode[]
  readonly rejectedCandidates?: readonly RejectedCandidate[]
  readonly fallbackLevel: number
  readonly requiredContext: number
  readonly selectedContext: number
  readonly healthState: ProviderHealthState
}

export type ProviderHealthState = "unknown" | "ready" | "unavailable" | "degraded"

export interface RoutingConfiguration {
  readonly providers: readonly ProviderDescriptor[]
  readonly models: readonly ModelDescriptor[]
  readonly deployments: readonly ModelDeployment[]
  readonly routes: {
    readonly default?: readonly string[] // Array of deployment IDs for fallback chain
    readonly [taskClass: string]: readonly string[] | undefined
  }
}
