import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { join } from "node:path"
import type {
  RoutingConfiguration,
  ProviderDescriptor,
  ModelDescriptor,
  ModelDeployment,
  ProviderKind,
  RoutingModelCapability,
  ModelSpecialization,
} from "../contracts/routing.ts"

export class ConfigValidationError extends Error {
  readonly code = "INVALID_ROUTING_CONFIG"
  readonly violations: readonly string[]

  constructor(violations: string[]) {
    super(`Invalid routing configuration: ${violations.join("; ")}`)
    this.name = "ConfigValidationError"
    this.violations = violations
  }
}

const VALID_PROVIDER_KINDS: readonly ProviderKind[] = ["scripted", "openai_compatible_local", "fake"]
const VALID_CAPABILITIES: readonly RoutingModelCapability[] = [

  "toolUse",
  "structuredOutput",
  "coding",
  "reasoning",
  "longContext",
  "vision",
  "fim",
  "autocomplete",
]

const VALID_SPECIALIZATIONS: readonly ModelSpecialization[] = ["general", "coding", "reasoning"]

/**
 * Validate a routing configuration deterministically.
 * Rejects duplicate IDs, unknown references, invalid values.
 * Never requires literal API secrets.
 */
export function validateRoutingConfig(config: unknown): RoutingConfiguration {
  const violations: string[] = []

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigValidationError(["Configuration must be a non-null object"])
  }

  const raw = config as Record<string, unknown>

  // Validate providers
  if (!Array.isArray(raw.providers)) {
    violations.push("providers must be an array")
  }
  const providerIds = new Set<string>()
  const providers: ProviderDescriptor[] = []
  if (Array.isArray(raw.providers)) {
    for (const p of raw.providers) {
      if (!p || typeof p !== "object") { violations.push("Each provider must be an object"); continue }
      const pd = p as Record<string, unknown>
      if (typeof pd.id !== "string" || !pd.id.trim()) { violations.push("Provider id must be a non-empty string"); continue }
      if (providerIds.has(pd.id as string)) { violations.push(`Duplicate provider ID: ${pd.id}`); continue }
      if (!VALID_PROVIDER_KINDS.includes(pd.kind as ProviderKind)) { violations.push(`Unsupported provider kind '${pd.kind}' in provider '${pd.id}'`); continue }
      providerIds.add(pd.id as string)
      providers.push({ id: pd.id as string, kind: pd.kind as ProviderKind, ...(pd.protocol ? { protocol: pd.protocol as string } : {}) })
    }
  }

  // Validate models
  if (!Array.isArray(raw.models)) {
    violations.push("models must be an array")
  }
  const modelIds = new Set<string>()
  const models: ModelDescriptor[] = []
  if (Array.isArray(raw.models)) {
    for (const m of raw.models) {
      if (!m || typeof m !== "object") { violations.push("Each model must be an object"); continue }
      const md = m as Record<string, unknown>
      if (typeof md.id !== "string" || !md.id.trim()) { violations.push("Model id must be a non-empty string"); continue }
      if (modelIds.has(md.id as string)) { violations.push(`Duplicate model ID: ${md.id}`); continue }
      if (typeof md.contextWindow !== "number" || md.contextWindow <= 0 || !Number.isInteger(md.contextWindow)) {
        violations.push(`Invalid contextWindow for model '${md.id}'`); continue
      }
      if (!Array.isArray(md.capabilities)) { violations.push(`Model '${md.id}' capabilities must be an array`); continue }
      for (const cap of md.capabilities as unknown[]) {
        if (!VALID_CAPABILITIES.includes(cap as RoutingModelCapability)) {
          violations.push(`Unknown capability '${cap}' in model '${md.id}'`)
        }
      }
      if (!VALID_SPECIALIZATIONS.includes(md.specialization as ModelSpecialization)) {
        violations.push(`Invalid specialization '${md.specialization}' in model '${md.id}'`); continue
      }
      modelIds.add(md.id as string)
      models.push({
        id: md.id as string,
        contextWindow: md.contextWindow as number,
        capabilities: (md.capabilities as RoutingModelCapability[]).filter(c => VALID_CAPABILITIES.includes(c)),
        specialization: md.specialization as ModelSpecialization,
        ...(md.displayName ? { displayName: md.displayName as string } : {}),
        ...(md.family ? { family: md.family as string } : {}),
        ...(md.maxOutputTokens && typeof md.maxOutputTokens === "number" ? { maxOutputTokens: md.maxOutputTokens } : {}),
        ...(md.provenance ? { provenance: md.provenance as string } : {}),
      })
    }
  }

  // Validate deployments
  if (!Array.isArray(raw.deployments)) {
    violations.push("deployments must be an array")
  }
  const deploymentIds = new Set<string>()
  const deployments: ModelDeployment[] = []
  if (Array.isArray(raw.deployments)) {
    for (const d of raw.deployments) {
      if (!d || typeof d !== "object") { violations.push("Each deployment must be an object"); continue }
      const dd = d as Record<string, unknown>
      if (typeof dd.id !== "string" || !dd.id.trim()) { violations.push("Deployment id must be a non-empty string"); continue }
      if (deploymentIds.has(dd.id as string)) { violations.push(`Duplicate deployment ID: ${dd.id}`); continue }
      if (!providerIds.has(dd.providerId as string)) { violations.push(`Unknown provider reference '${dd.providerId}' in deployment '${dd.id}'`); continue }
      if (!modelIds.has(dd.modelId as string)) { violations.push(`Unknown model reference '${dd.modelId}' in deployment '${dd.id}'`); continue }
      if (dd.contextWindow !== undefined && (typeof dd.contextWindow !== "number" || dd.contextWindow <= 0)) {
        violations.push(`Invalid contextWindow override in deployment '${dd.id}'`); continue
      }
      if (dd.priority !== undefined && (typeof dd.priority !== "number" || !Number.isFinite(dd.priority))) {
        violations.push(`Invalid priority in deployment '${dd.id}'`); continue
      }
      deploymentIds.add(dd.id as string)
      deployments.push({
        id: dd.id as string,
        providerId: dd.providerId as string,
        modelId: dd.modelId as string,
        enabled: dd.enabled !== false,
        ...(dd.endpoint ? { endpoint: dd.endpoint as string } : {}),
        ...(dd.contextWindow ? { contextWindow: dd.contextWindow as number } : {}),
        ...(dd.priority !== undefined ? { priority: dd.priority as number } : {}),
        ...(dd.tags && Array.isArray(dd.tags) ? { tags: dd.tags as string[] } : {}),
      })
    }
  }

  // Validate routes
  if (!raw.routes || typeof raw.routes !== "object" || Array.isArray(raw.routes)) {
    violations.push("routes must be an object")
  }
  const routes: Record<string, readonly string[]> = {}
  if (raw.routes && typeof raw.routes === "object" && !Array.isArray(raw.routes)) {
    for (const [key, value] of Object.entries(raw.routes as Record<string, unknown>)) {
      if (!Array.isArray(value)) { violations.push(`Route '${key}' must be an array of deployment IDs`); continue }
      for (const depId of value) {
        if (typeof depId !== "string") { violations.push(`Route '${key}' contains non-string deployment ID`); continue }
        if (!deploymentIds.has(depId)) { violations.push(`Unknown deployment '${depId}' in route '${key}'`); continue }
        // Check for disabled deployments in routes (warn but allow)
        const dep = deployments.find(d => d.id === depId)
        if (dep && !dep.enabled) {
          // Disabled deployments in routes are filtered at routing time, not config time
        }
      }
      routes[key] = value as string[]
    }
  }

  if (violations.length > 0) {
    throw new ConfigValidationError(violations)
  }

  return { providers, models, deployments, routes }
}

/**
 * Load and validate routing configuration from a JSON file.
 * Returns null if no config file exists (routing is optional).
 * Throws ConfigValidationError for malformed config.
 */
export async function loadRoutingConfig(workspaceRoot: string): Promise<RoutingConfiguration | null> {
  const configPath = join(workspaceRoot, ".open-vs-code", "models.json")
  let raw: string
  try {
    raw = await readFile(configPath, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigValidationError(["models.json is not valid JSON"])
  }

  return validateRoutingConfig(parsed)
}

/**
 * Synchronous version of loadRoutingConfig for extension startup.
 * Returns null if no config file exists (routing is optional).
 * Throws ConfigValidationError for malformed config.
 */
export function loadRoutingConfigSync(workspaceRoot: string): RoutingConfiguration | null {
  const configPath = join(workspaceRoot, ".open-vs-code", "models.json")
  let raw: string
  try {
    raw = readFileSync(configPath, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigValidationError(["models.json is not valid JSON"])
  }

  return validateRoutingConfig(parsed)
}
