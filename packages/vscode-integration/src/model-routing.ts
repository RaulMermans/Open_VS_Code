import { resolveCanonicalEndpoints, validateRoutingConfig, type RoutingConfiguration } from "@open-vs-code/agent-core"
import {
  applyAutocompleteModelSelection,
  applyChatModelSelection,
  buildStarterRoutingConfig,
  chooseInstalledModel,
  localProviderBaseUrl,
  PREFERRED_AUTOCOMPLETE_MODEL,
  PREFERRED_CODING_MODEL,
} from "./local-model-selection.js"

/**
 * Configuration precedence, first match wins:
 * 1. Trusted workspace `.open-vs-code/models.json`, unless the user suspended that override.
 *    The file is never rewritten by model selection.
 * 2. Global model preferences in extension storage.
 * 3. Models discovered from the user's global endpoint, until a preference is saved.
 * 4. No route. Inference is not attempted.
 *
 * An untrusted workspace file never supplies an endpoint, a model, or a credential.
 * Credentials are not stored in this record. A secret key name is not an endpoint.
 */
export const MODEL_ROUTING_PRECEDENCE = [
  "Trusted workspace .open-vs-code/models.json, unless that override is suspended. The file is not modified.",
  "Global model preferences in extension storage.",
  "Models discovered from the global endpoint, in memory until the user saves them.",
  "No route.",
] as const

export const MODEL_PREFERENCES_KEY = "open-vs-code.modelPreferences.v1"
export const MODEL_OVERRIDE_SUSPENDED_KEY = "open-vs-code.modelOverride.suspended"
export const LOCAL_INFERENCE_SECRET_KEY = "open-vs-code.model.localToken"
export const LOCAL_INFERENCE_TOKEN_ENV = "OPEN_VS_CODE_LOCAL_INFERENCE_TOKEN"
export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:11434"

export type RoutingSource = "workspace-override" | "global" | "discovered" | "none"

export interface GlobalModelPreferences {
  readonly version: 1
  readonly endpoint: string
  readonly chatModel?: string
  readonly autocompleteModel?: string
  /** Validated routing document. It replaces the simple model pair for the global source. */
  readonly advanced?: RoutingConfiguration
}

export interface PreferenceRead {
  readonly preferences: GlobalModelPreferences | null
  /** Stored bytes were not applied and must not be overwritten automatically. */
  readonly preserved: boolean
  readonly notice?: string
}

export interface RoutingResolutionInput {
  readonly workspaceTrusted: boolean
  readonly workspaceConfig: RoutingConfiguration | null
  readonly workspaceConfigInvalid: boolean
  readonly overrideSuspended: boolean
  readonly globalPreferences: GlobalModelPreferences | null
  readonly discoveredModelNames: readonly string[]
  readonly credentialConfigured: boolean
}

export interface RoutingResolution {
  readonly config: RoutingConfiguration | null
  readonly source: RoutingSource
  readonly workspaceOverridePresent: boolean
  readonly workspaceOverrideActive: boolean
  readonly workspaceOverrideIgnored: boolean
  readonly workspaceConfigInvalid: boolean
  readonly endpoint?: string
  readonly chatModel?: string
  readonly autocompleteModel?: string
  readonly notice: string
}

export interface ModelRoutingSnapshot {
  readonly source: RoutingSource
  readonly endpoint: string
  readonly endpointReachable: boolean
  readonly endpointError?: string
  readonly installedModels: readonly string[]
  readonly chatModel?: string
  readonly autocompleteModel?: string
  readonly workspaceOverridePresent: boolean
  readonly workspaceOverrideActive: boolean
  readonly workspaceOverrideIgnored: boolean
  readonly workspaceConfigInvalid: boolean
  readonly workspaceTrusted: boolean
  readonly credentialConfigured: boolean
  readonly advancedActive: boolean
  readonly notice: string
  readonly trustNotice?: string
}

export function executionModeAvailable(mode: string, workspaceTrusted: boolean): boolean {
  if (workspaceTrusted) return true
  return mode === "ASK" || mode === "PLAN" || mode === "REVIEW"
}

export function parseStoredModelPreferences(raw: unknown): PreferenceRead {
  if (raw == null) return { preferences: null, preserved: false }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { preferences: null, preserved: true, notice: "Saved model settings were not a configuration object and were left unchanged." }
  }
  const record = raw as Record<string, unknown>
  if ("apiKey" in record || "token" in record || "password" in record || "secret" in record) {
    return {
      preferences: null,
      preserved: true,
      notice: "Saved model settings contained a credential field and were left unchanged. Tokens belong in secure storage.",
    }
  }
  const endpoint = typeof record.endpoint === "string" && record.endpoint.trim() ? record.endpoint.trim() : DEFAULT_LOCAL_ENDPOINT
  try {
    resolveCanonicalEndpoints(endpoint)
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid endpoint"
    return { preferences: null, preserved: true, notice: `Saved model endpoint was left unchanged (${message}).` }
  }
  const chatModel = optionalName(record.chatModel) || optionalName(record.selectedModel)
  const autocompleteModel = optionalName(record.autocompleteModel)
  let advanced: RoutingConfiguration | undefined
  if (record.advanced !== undefined) {
    try {
      advanced = validateRoutingConfig(record.advanced)
    } catch {
      return { preferences: null, preserved: true, notice: "Saved advanced routing was invalid and was left unchanged." }
    }
  }
  if (!chatModel && !advanced) {
    if (record.version !== undefined) {
      return { preferences: null, preserved: true, notice: "Saved model settings did not name a model and were left unchanged." }
    }
    return { preferences: null, preserved: false }
  }
  return {
    preferences: {
      version: 1,
      endpoint,
      ...(chatModel ? { chatModel } : {}),
      ...(autocompleteModel ? { autocompleteModel } : {}),
      ...(advanced ? { advanced } : {}),
    },
    preserved: false,
  }
}

export function routingFromSelection(options: {
  endpoint: string
  chatModel: string
  autocompleteModel: string
  credentialConfigured: boolean
}): RoutingConfiguration {
  const endpoint = options.endpoint.trim()
  resolveCanonicalEndpoints(endpoint)
  const chatModel = options.chatModel.trim()
  const autocompleteModel = options.autocompleteModel.trim()
  if (!chatModel || !autocompleteModel) throw new Error("MODEL_NAME_REQUIRED")
  let config = buildStarterRoutingConfig([chatModel, autocompleteModel])
  config = {
    ...config,
    providers: config.providers.map((provider) => {
      if (provider.kind !== "openai_compatible_local") return provider
      return {
        ...provider,
        baseUrl: endpoint,
        ...(options.credentialConfigured ? { apiKeyEnv: LOCAL_INFERENCE_TOKEN_ENV } : {}),
      }
    }),
  }
  config = applyChatModelSelection(config, chatModel)
  config = applyAutocompleteModelSelection(config, autocompleteModel)
  return validateRoutingConfig(config)
}

export function resolveModelRouting(input: RoutingResolutionInput): RoutingResolution {
  const filePresent = input.workspaceConfig !== null || input.workspaceConfigInvalid
  const trusted = input.workspaceTrusted === true
  const ignored = filePresent && !trusted
  const invalid = input.workspaceConfigInvalid
  const useFile = trusted && !input.overrideSuspended && input.workspaceConfig !== null && !invalid
  if (useFile && input.workspaceConfig) {
    const endpoint = localProviderBaseUrl(input.workspaceConfig)
    return {
      config: input.workspaceConfig,
      source: "workspace-override",
      workspaceOverridePresent: true,
      workspaceOverrideActive: true,
      workspaceOverrideIgnored: false,
      workspaceConfigInvalid: false,
      endpoint,
      chatModel: routeModelName(input.workspaceConfig, "default") || routeModelName(input.workspaceConfig, "coding"),
      autocompleteModel: routeModelName(input.workspaceConfig, "autocomplete"),
      notice: "Workspace models.json is the active route. Model choices in the panel do not edit that file.",
    }
  }
  const globalConfig = configFromPreferences(input.globalPreferences, input.credentialConfigured)
  if (globalConfig) {
    const endpoint = localProviderBaseUrl(globalConfig) || input.globalPreferences?.endpoint
    return {
      config: globalConfig,
      source: "global",
      workspaceOverridePresent: filePresent,
      workspaceOverrideActive: false,
      workspaceOverrideIgnored: ignored,
      workspaceConfigInvalid: invalid,
      endpoint,
      chatModel: routeModelName(globalConfig, "default") || routeModelName(globalConfig, "coding"),
      autocompleteModel: routeModelName(globalConfig, "autocomplete"),
      notice: globalNotice(ignored, invalid, input.overrideSuspended && filePresent && trusted),
    }
  }
  if (input.discoveredModelNames.length > 0) {
    const discovered = buildStarterRoutingConfig(input.discoveredModelNames)
    return {
      config: discovered,
      source: "discovered",
      workspaceOverridePresent: filePresent,
      workspaceOverrideActive: false,
      workspaceOverrideIgnored: ignored,
      workspaceConfigInvalid: invalid,
      endpoint: localProviderBaseUrl(discovered) || DEFAULT_LOCAL_ENDPOINT,
      chatModel: routeModelName(discovered, "default"),
      autocompleteModel: routeModelName(discovered, "autocomplete"),
      notice: ignored
        ? "This folder is untrusted, so its model file was ignored. Discovered local models are in use."
        : "Using models discovered from the local endpoint. No project file was read.",
    }
  }
  return {
    config: null,
    source: "none",
    workspaceOverridePresent: filePresent,
    workspaceOverrideActive: false,
    workspaceOverrideIgnored: ignored,
    workspaceConfigInvalid: invalid,
    notice: ignored
      ? "This folder is untrusted, so its model file was ignored. Choose a model in Models."
      : "No model selected. Choose one in Models. A project file is optional.",
  }
}

export function preferencesFromDiscovery(endpoint: string, installed: readonly string[]): GlobalModelPreferences | null {
  const names = installed.map((name) => name.trim()).filter((name) => name.length > 0)
  if (names.length === 0) return null
  resolveCanonicalEndpoints(endpoint)
  const chatModel = chooseInstalledModel(names, [PREFERRED_CODING_MODEL, PREFERRED_AUTOCOMPLETE_MODEL]) ?? names[0]
  const autocompleteModel = chooseInstalledModel(names, [PREFERRED_AUTOCOMPLETE_MODEL, PREFERRED_CODING_MODEL]) ?? chatModel
  if (!chatModel || !autocompleteModel) return null
  return { version: 1, endpoint: endpoint.trim(), chatModel, autocompleteModel }
}

export function planChatSelection(input: {
  current: GlobalModelPreferences | null
  endpoint: string
  chatModel: string
  autocompleteModel?: string
  overrideActive: boolean
}): { preferences: GlobalModelPreferences; suspendWorkspaceOverride: boolean; writesWorkspaceFile: false } {
  const endpoint = input.endpoint.trim() || input.current?.endpoint || DEFAULT_LOCAL_ENDPOINT
  resolveCanonicalEndpoints(endpoint)
  const chatModel = input.chatModel.trim()
  if (!chatModel) throw new Error("MODEL_NAME_REQUIRED")
  const autocompleteModel = (input.autocompleteModel || input.current?.autocompleteModel || chatModel).trim()
  return {
    preferences: { version: 1, endpoint, chatModel, autocompleteModel },
    suspendWorkspaceOverride: input.overrideActive,
    writesWorkspaceFile: false,
  }
}

export function planAutocompleteSelection(input: {
  current: GlobalModelPreferences | null
  endpoint: string
  autocompleteModel: string
  chatModel?: string
  overrideActive: boolean
}): { preferences: GlobalModelPreferences; suspendWorkspaceOverride: boolean; writesWorkspaceFile: false } {
  const endpoint = input.endpoint.trim() || input.current?.endpoint || DEFAULT_LOCAL_ENDPOINT
  resolveCanonicalEndpoints(endpoint)
  const autocompleteModel = input.autocompleteModel.trim()
  if (!autocompleteModel) throw new Error("MODEL_NAME_REQUIRED")
  const chatModel = (input.chatModel || input.current?.chatModel || autocompleteModel).trim()
  return {
    preferences: { version: 1, endpoint, chatModel, autocompleteModel },
    suspendWorkspaceOverride: input.overrideActive,
    writesWorkspaceFile: false,
  }
}

export function routeModelName(config: RoutingConfiguration, routeKey: string): string | undefined {
  const ids = config.routes[routeKey]
  const id = ids?.[0]
  if (!id) return undefined
  const deployment = config.deployments.find((entry) => entry.id === id)
  if (!deployment) return undefined
  if (deployment.modelName && deployment.modelName.trim()) return deployment.modelName.trim()
  const model = config.models.find((entry) => entry.id === deployment.modelId)
  return model?.modelName?.trim() || undefined
}

export function snapshotFromResolution(input: {
  resolution: RoutingResolution
  installedModels: readonly string[]
  endpointError?: string
  workspaceTrusted: boolean
  credentialConfigured: boolean
  advancedActive: boolean
  probedEndpoint: string
}): ModelRoutingSnapshot {
  const trustNotice = input.workspaceTrusted
    ? undefined
    : "This folder is not trusted. Ask can read. Agent and Debug stay unavailable until you trust the folder yourself."
  return {
    source: input.resolution.source,
    endpoint: input.resolution.endpoint || input.probedEndpoint,
    endpointReachable: input.endpointError === undefined && input.resolution.config !== null,
    ...(input.endpointError ? { endpointError: input.endpointError } : {}),
    installedModels: input.installedModels,
    ...(input.resolution.chatModel ? { chatModel: input.resolution.chatModel } : {}),
    ...(input.resolution.autocompleteModel ? { autocompleteModel: input.resolution.autocompleteModel } : {}),
    workspaceOverridePresent: input.resolution.workspaceOverridePresent,
    workspaceOverrideActive: input.resolution.workspaceOverrideActive,
    workspaceOverrideIgnored: input.resolution.workspaceOverrideIgnored,
    workspaceConfigInvalid: input.resolution.workspaceConfigInvalid,
    workspaceTrusted: input.workspaceTrusted,
    credentialConfigured: input.credentialConfigured,
    advancedActive: input.advancedActive,
    notice: input.resolution.notice,
    ...(trustNotice ? { trustNotice } : {}),
  }
}

function configFromPreferences(preferences: GlobalModelPreferences | null, credentialConfigured: boolean): RoutingConfiguration | null {
  if (!preferences) return null
  if (preferences.advanced) return preferences.advanced
  if (!preferences.chatModel) return null
  const autocompleteModel = preferences.autocompleteModel || preferences.chatModel
  try {
    return routingFromSelection({
      endpoint: preferences.endpoint,
      chatModel: preferences.chatModel,
      autocompleteModel,
      credentialConfigured,
    })
  } catch {
    return null
  }
}

function globalNotice(ignored: boolean, invalid: boolean, suspended: boolean): string {
  if (ignored) return "This folder is untrusted, so its model file was ignored. The global model is in use."
  if (invalid) return "The workspace model file is invalid and was not applied. The global model is in use."
  if (suspended) return "Workspace models.json is present and suspended. The global model is in use. The file was not modified."
  return "Global model preferences are in use. No project file is required."
}

export function connectionFromSnapshot(snapshot: ModelRoutingSnapshot): {
  configStatus: "present" | "missing" | "invalid"
  lastError?: "disconnected" | "model-unavailable"
  modelLabel?: string
  selectedModel?: string
  endpoint?: string
  installedModels: readonly string[]
  endpointVerified: boolean
  routingSource: RoutingSource
  workspaceOverrideActive: boolean
  autocompleteModel?: string
  workspaceTrusted: boolean
} {
  const configStatus = snapshot.source === "none"
    ? (snapshot.workspaceConfigInvalid && snapshot.workspaceTrusted ? "invalid" : "missing")
    : "present"
  let lastError: "disconnected" | "model-unavailable" | undefined
  if (snapshot.endpointError) lastError = "disconnected"
  else if (snapshot.endpointReachable && snapshot.chatModel && !snapshot.installedModels.includes(snapshot.chatModel)) {
    lastError = "model-unavailable"
  }
  return {
    configStatus,
    ...(lastError ? { lastError } : {}),
    ...(snapshot.chatModel ? { modelLabel: snapshot.chatModel, selectedModel: snapshot.chatModel } : {}),
    endpoint: snapshot.endpoint,
    installedModels: snapshot.installedModels,
    endpointVerified: snapshot.endpointReachable && !lastError,
    routingSource: snapshot.source,
    workspaceOverrideActive: snapshot.workspaceOverrideActive,
    ...(snapshot.autocompleteModel ? { autocompleteModel: snapshot.autocompleteModel } : {}),
    workspaceTrusted: snapshot.workspaceTrusted,
  }
}

function optionalName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9_.:@+-]{1,128}$/.test(trimmed)) return undefined
  return trimmed
}
