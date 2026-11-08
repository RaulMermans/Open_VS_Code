import type { ModelDeployment, ModelDescriptor, RoutingConfiguration } from "@open-vs-code/agent-core"

export const CHAT_MODEL_DEPLOYMENT_ID = "open-vs-code-chat"
export const PREFERRED_CODING_MODEL = "qwen3-coder:30b"
export const PREFERRED_AUTOCOMPLETE_MODEL = "qwen2.5-coder:7b"

/** Routes the chat picker is allowed to retarget. Autocomplete and any other key stay put. */
const CHAT_ROUTE_KEYS = new Set(["default", "general", "planning", "coding", "debugging", "review"])

export interface LocalModelChoice {
  readonly name: string
  readonly sizeBytes?: number
}

export async function fetchLocalModelCatalog(baseUrl: string, timeoutMs = 2500): Promise<{ models: LocalModelChoice[]; error?: string }> {
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { models: [], error: `The local endpoint returned HTTP ${response.status}.` }
    return { models: parseOllamaTags(await response.json()) }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The local endpoint is unreachable."
    return { models: [], error: message }
  }
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

/** First installed name that equals a preference, then one that starts with its family. */
export function chooseInstalledModel(installed: readonly string[], preferences: readonly string[]): string | undefined {
  const names = installed.map((name) => name.trim()).filter((name) => name.length > 0)
  for (const preference of preferences) {
    const exact = names.find((name) => name === preference)
    if (exact) return exact
  }
  for (const preference of preferences) {
    const family = preference.split(":")[0] ?? preference
    const prefixed = names.find((name) => name === family || name.startsWith(`${family}:`))
    if (prefixed) return prefixed
  }
  return undefined
}

/**
 * Fresh local routing. Chat prefers Qwen3-Coder 30B when that tag is installed.
 * Autocomplete stays on Qwen2.5-Coder 7B when that tag is installed.
 * An empty catalog keeps the offline starter, which still does not point at a cloud model.
 */
export function buildStarterRoutingConfig(installed: readonly string[]): RoutingConfiguration {
  const coding = chooseInstalledModel(installed, [PREFERRED_CODING_MODEL, PREFERRED_AUTOCOMPLETE_MODEL]) ?? PREFERRED_AUTOCOMPLETE_MODEL
  const autocomplete = chooseInstalledModel(installed, [PREFERRED_AUTOCOMPLETE_MODEL, PREFERRED_CODING_MODEL]) ?? PREFERRED_AUTOCOMPLETE_MODEL
  const model = (name: string, id: string, fim: boolean): ModelDescriptor => ({
    id,
    displayName: name,
    family: "qwen",
    contextWindow: 32768,
    capabilities: fim ? ["toolUse", "coding", "autocomplete", "fim"] : ["toolUse", "coding"],
    specialization: "coding",
    provenance: "Selected from the local inference endpoint",
    modelName: name,
    ...(fim ? { fimStrategy: "qwen" as const } : {}),
  })
  const codingId = `local-${slugModelId(coding)}`
  const autocompleteId = coding === autocomplete ? codingId : `local-${slugModelId(autocomplete)}`
  const models = [model(coding, codingId, coding === autocomplete)]
  if (autocompleteId !== codingId) models.push(model(autocomplete, autocompleteId, true))
  return {
    providers: [{ id: "local-inference", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" }],
    models,
    deployments: [
      { id: "local-chat", providerId: "local-inference", modelId: codingId, modelName: coding, enabled: true, priority: 10 },
      { id: "local-fim", providerId: "local-inference", modelId: autocompleteId, modelName: autocomplete, enabled: true, priority: 10, fimStrategy: "qwen" },
    ],
    routes: {
      coding: ["local-chat"],
      debugging: ["local-chat"],
      planning: ["local-chat"],
      review: ["local-chat"],
      default: ["local-chat"],
      autocomplete: ["local-fim"],
    },
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
