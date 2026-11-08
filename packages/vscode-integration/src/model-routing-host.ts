import * as vscode from "vscode"
import { loadRoutingConfigSync, validateRoutingConfig, type RoutingConfiguration } from "@open-vs-code/agent-core"
import { fetchLocalModelCatalog, localProviderBaseUrl } from "./local-model-selection.js"
import {
  DEFAULT_LOCAL_ENDPOINT,
  LOCAL_INFERENCE_SECRET_KEY,
  LOCAL_INFERENCE_TOKEN_ENV,
  MODEL_OVERRIDE_SUSPENDED_KEY,
  MODEL_PREFERENCES_KEY,
  parseStoredModelPreferences,
  planAutocompleteSelection,
  planChatSelection,
  preferencesFromDiscovery,
  resolveModelRouting,
  routeModelName,
  snapshotFromResolution,
  type GlobalModelPreferences,
  type ModelRoutingSnapshot,
  type RoutingResolution,
} from "./model-routing.js"

export interface ModelRoutingRefresh {
  readonly resolution: RoutingResolution
  readonly snapshot: ModelRoutingSnapshot
  readonly config: RoutingConfiguration | null
}

/**
 * Global model preferences live in extension storage.
 * Workspace `models.json` is read only as a trusted override and is never written here.
 */
function readStored(store: { get?: (key: string) => unknown } | undefined, key: string): unknown {
  if (!store || typeof store.get !== "function") return undefined
  return store.get(key)
}

export class ModelRoutingHost {
  #snapshot: ModelRoutingSnapshot | null = null
  #resolution: RoutingResolution | null = null
  #credentialOwned = false
  #preserved = false

  constructor(private readonly context: vscode.ExtensionContext) {}

  get resolution(): RoutingResolution | null {
    return this.#resolution
  }

  get config(): RoutingConfiguration | null {
    return this.#resolution?.config ?? null
  }

  snapshot(): ModelRoutingSnapshot | null {
    return this.#snapshot
  }

  async refresh(): Promise<ModelRoutingRefresh> {
    const trusted = vscode.workspace.isTrusted === true
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    let workspaceConfig: RoutingConfiguration | null = null
    let workspaceConfigInvalid = false
    if (root) {
      try {
        workspaceConfig = loadRoutingConfigSync(root)
      } catch {
        workspaceConfigInvalid = true
      }
    }
    const stored = parseStoredModelPreferences(readStored(this.context.globalState, MODEL_PREFERENCES_KEY))
    this.#preserved = stored.preserved
    const suspended = readStored(this.context.workspaceState, MODEL_OVERRIDE_SUSPENDED_KEY) === true
    const credentialConfigured = await this.#syncCredential()
    const globalEndpoint = stored.preferences?.endpoint || DEFAULT_LOCAL_ENDPOINT
    const overrideActive = trusted && !suspended && workspaceConfig !== null && !workspaceConfigInvalid
    const probeEndpoint = overrideActive && workspaceConfig
      ? (localProviderBaseUrl(workspaceConfig) || globalEndpoint)
      : globalEndpoint
    const catalog = await fetchLocalModelCatalog(probeEndpoint, 2000)
    let preferences = stored.preferences
    let savedDiscovery = false
    let resolution = resolveModelRouting({
      workspaceTrusted: trusted,
      workspaceConfig,
      workspaceConfigInvalid,
      overrideSuspended: suspended,
      globalPreferences: preferences,
      discoveredModelNames: catalog.error ? [] : catalog.models.map((model) => model.name),
      credentialConfigured,
    })
    if (resolution.source === "discovered" && !stored.preserved && resolution.chatModel && resolution.autocompleteModel && resolution.endpoint) {
      const discovered = preferencesFromDiscovery(resolution.endpoint, catalog.models.map((model) => model.name))
      if (discovered && typeof this.context.globalState?.update === "function") {
        await this.context.globalState.update(MODEL_PREFERENCES_KEY, discovered)
        preferences = discovered
        savedDiscovery = true
        resolution = resolveModelRouting({
          workspaceTrusted: trusted,
          workspaceConfig,
          workspaceConfigInvalid,
          overrideSuspended: suspended,
          globalPreferences: preferences,
          discoveredModelNames: catalog.models.map((model) => model.name),
          credentialConfigured,
        })
      }
    }
    const snapshot = snapshotFromResolution({
      resolution,
      installedModels: catalog.error ? [] : catalog.models.map((model) => model.name),
      ...(catalog.error ? { endpointError: catalog.error } : {}),
      workspaceTrusted: trusted,
      credentialConfigured,
      advancedActive: Boolean(preferences?.advanced) && resolution.source === "global",
      probedEndpoint: probeEndpoint,
    })
    const baseNotice = savedDiscovery
      ? "Saved the discovered local models as the global default. No project file was written."
      : snapshot.notice
    const notice = stored.notice && stored.preserved ? `${stored.notice} ${baseNotice}` : baseNotice
    const withNotice = { ...snapshot, notice }
    this.#resolution = resolution
    this.#snapshot = withNotice
    return { resolution, snapshot: withNotice, config: resolution.config }
  }

  async setChatModel(name: string): Promise<string | undefined> {
    return this.#saveSelection("chat", name)
  }

  async setAutocompleteModel(name: string): Promise<string | undefined> {
    return this.#saveSelection("autocomplete", name)
  }

  async setEndpoint(endpoint: string): Promise<string | undefined> {
    const current = this.#currentPreferences()
    const chatModel = current?.chatModel || this.#snapshot?.chatModel
    const autocompleteModel = current?.autocompleteModel || this.#snapshot?.autocompleteModel || chatModel
    if (!chatModel || !autocompleteModel) return "Choose a chat model before changing the endpoint."
    try {
      const plan = planChatSelection({
        current,
        endpoint,
        chatModel,
        autocompleteModel,
        overrideActive: false,
      })
      await this.context.globalState.update(MODEL_PREFERENCES_KEY, plan.preferences)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : "The endpoint was rejected."
    }
  }

  async setAdvanced(raw: string): Promise<string | undefined> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return "Advanced routing is not valid JSON. Nothing was saved."
    }
    let advancedConfig: RoutingConfiguration
    try {
      advancedConfig = validateRoutingConfig(parsed)
    } catch (error) {
      return error instanceof Error ? error.message : "Advanced routing was rejected."
    }
    const chatModel = routeModelName(advancedConfig, "default")
    const autocompleteModel = routeModelName(advancedConfig, "autocomplete")
    const endpoint = localProviderBaseUrl(advancedConfig) || this.#snapshot?.endpoint || DEFAULT_LOCAL_ENDPOINT
    const next: GlobalModelPreferences = {
      version: 1,
      endpoint,
      ...(chatModel ? { chatModel } : {}),
      ...(autocompleteModel ? { autocompleteModel } : {}),
      advanced: advancedConfig,
    }
    await this.context.globalState.update(MODEL_PREFERENCES_KEY, next)
    if (this.#snapshot?.workspaceOverrideActive) {
      await this.context.workspaceState.update(MODEL_OVERRIDE_SUSPENDED_KEY, true)
    }
    return undefined
  }

  async clearAdvanced(): Promise<void> {
    const current = this.#currentPreferences()
    if (!current?.advanced) return
    const rest: GlobalModelPreferences = {
      version: 1,
      endpoint: current.endpoint,
      ...(current.chatModel ? { chatModel: current.chatModel } : {}),
      ...(current.autocompleteModel ? { autocompleteModel: current.autocompleteModel } : {}),
    }
    await this.context.globalState.update(MODEL_PREFERENCES_KEY, { ...rest, version: 1 })
  }

  async suspendOverride(): Promise<void> {
    await this.context.workspaceState.update(MODEL_OVERRIDE_SUSPENDED_KEY, true)
  }

  async useWorkspaceOverride(): Promise<string | undefined> {
    if (vscode.workspace.isTrusted !== true) {
      return "The workspace model file stays unused until you trust this folder. Trust was not granted automatically."
    }
    if (!this.#snapshot?.workspaceOverridePresent || this.#snapshot.workspaceConfigInvalid) {
      return "There is no valid workspace models.json to use."
    }
    await this.context.workspaceState.update(MODEL_OVERRIDE_SUSPENDED_KEY, false)
    return undefined
  }

  async setCredential(token: string): Promise<void> {
    const trimmed = token.trim()
    if (!trimmed) {
      await this.context.secrets.delete(LOCAL_INFERENCE_SECRET_KEY)
      if (this.#credentialOwned) delete process.env[LOCAL_INFERENCE_TOKEN_ENV]
      this.#credentialOwned = false
      return
    }
    await this.context.secrets.store(LOCAL_INFERENCE_SECRET_KEY, trimmed)
    process.env[LOCAL_INFERENCE_TOKEN_ENV] = trimmed
    this.#credentialOwned = true
  }

  async #saveSelection(kind: "chat" | "autocomplete", name: string): Promise<string | undefined> {
    const installed = this.#snapshot?.installedModels || []
    if (this.#snapshot?.endpointError) return `Ollama is offline at ${this.#snapshot.endpoint}. ${this.#snapshot.endpointError}`
    if (!installed.includes(name)) return `${name} is not installed at ${this.#snapshot?.endpoint || DEFAULT_LOCAL_ENDPOINT}.`
    const current = this.#currentPreferences()
    const endpoint = current?.endpoint || this.#snapshot?.endpoint || DEFAULT_LOCAL_ENDPOINT
    const plan = kind === "chat"
      ? planChatSelection({
        current,
        endpoint,
        chatModel: name,
        autocompleteModel: this.#snapshot?.autocompleteModel,
        overrideActive: this.#snapshot?.workspaceOverrideActive === true,
      })
      : planAutocompleteSelection({
        current,
        endpoint,
        autocompleteModel: name,
        chatModel: this.#snapshot?.chatModel,
        overrideActive: this.#snapshot?.workspaceOverrideActive === true,
      })
    await this.context.globalState.update(MODEL_PREFERENCES_KEY, plan.preferences)
    if (plan.suspendWorkspaceOverride) {
      await this.context.workspaceState.update(MODEL_OVERRIDE_SUSPENDED_KEY, true)
    }
    return undefined
  }

  #currentPreferences(): GlobalModelPreferences | null {
    if (this.#preserved) return null
    return parseStoredModelPreferences(readStored(this.context.globalState, MODEL_PREFERENCES_KEY)).preferences
  }

  async #syncCredential(): Promise<boolean> {
    const secrets = this.context.secrets
    if (!secrets || typeof secrets.get !== "function") return Boolean(process.env[LOCAL_INFERENCE_TOKEN_ENV]?.trim())
    const stored = (await secrets.get(LOCAL_INFERENCE_SECRET_KEY))?.trim()
    if (stored) {
      process.env[LOCAL_INFERENCE_TOKEN_ENV] = stored
      this.#credentialOwned = true
      return true
    }
    if (this.#credentialOwned) {
      delete process.env[LOCAL_INFERENCE_TOKEN_ENV]
      this.#credentialOwned = false
    }
    return Boolean(process.env[LOCAL_INFERENCE_TOKEN_ENV]?.trim())
  }
}
