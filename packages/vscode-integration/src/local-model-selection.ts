import type { ModelDeployment, ModelDescriptor, RoutingConfiguration } from "@open-vs-code/agent-core"

export const CHAT_MODEL_DEPLOYMENT_ID = "open-vs-code-chat"

/** Routes the chat picker is allowed to retarget. Autocomplete and any other key stay put. */
const CHAT_ROUTE_KEYS = new Set(["default", "general", "planning", "coding", "debugging", "review"])

export interface LocalModelChoice {
  readonly name: string
  readonly sizeBytes?: number
}

export function parseOllamaTags(body: unknown): LocalModelChoice[] {
  const record = asRecord(body)
  const models = record?.models
  if (!Array.isArray(models)) return []
  const choices: LocalModelChoice[] = []
  for (const entry of models) {
    const item = asRecord(entry)
    if (!item) continue
    const rawName = item.name
    const name = typeof rawName === "string" ? rawName.trim() : ""
    if (!name) continue
    const sizeBytes = typeof item.size === "number" && Number.isFinite(item.size) ? item.size : undefined
    choices.push(sizeBytes === undefined ? { name } : { name, sizeBytes })
  }
  return choices
}

export function localProviderBaseUrl(config: RoutingConfiguration): string | undefined {
  const provider = config.providers.find((entry) => entry.kind === "openai_compatible_local" && entry.baseUrl)
  return provider?.baseUrl
}

/**
 * Point chat and coding routes at one local model.
 * Autocomplete routes and their deployments stay as configured.
 */
export function applyChatModelSelection(config: RoutingConfiguration, servedModelName: string): RoutingConfiguration {
  const name = servedModelName.trim()
  if (!name) throw new Error("MODEL_NAME_REQUIRED")
  const provider = config.providers.find((entry) => entry.kind === "openai_compatible_local" && entry.baseUrl)
  if (!provider) throw new Error("NO_LOCAL_PROVIDER")
  const modelId = `local-${slugModelId(name)}`
  const model: ModelDescriptor = {
    id: modelId,
    displayName: name,
    family: "local",
    contextWindow: 32768,
    capabilities: ["toolUse", "coding"],
    specialization: "coding",
    provenance: "Selected from the local inference endpoint",
    modelName: name,
  }
  const deployment: ModelDeployment = {
    id: CHAT_MODEL_DEPLOYMENT_ID,
    providerId: provider.id,
    modelId,
    modelName: name,
    enabled: true,
    priority: 100,
  }
  const routes: Record<string, readonly string[]> = {}
  for (const [key, value] of Object.entries(config.routes)) {
    if (!value) continue
    routes[key] = CHAT_ROUTE_KEYS.has(key) ? [CHAT_MODEL_DEPLOYMENT_ID] : [...value]
  }
  if (!routes.default) routes.default = [CHAT_MODEL_DEPLOYMENT_ID]
  if (!routes.coding) routes.coding = [CHAT_MODEL_DEPLOYMENT_ID]
  return {
    ...(config.$schema ? { $schema: config.$schema } : {}),
    providers: config.providers,
    models: [...config.models.filter((entry) => entry.id !== modelId), model],
    deployments: [...config.deployments.filter((entry) => entry.id !== CHAT_MODEL_DEPLOYMENT_ID), deployment],
    routes,
  }
}

export function slugModelId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return slug.slice(0, 64) || "model"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}
