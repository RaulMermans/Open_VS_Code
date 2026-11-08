import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRoutingConfigSync, type RoutingConfiguration } from "@open-vs-code/agent-core"
import { shouldShowModelConfiguration } from "../src/model-config-open.ts"
import { applyAutocompleteModelSelection, applyChatModelSelection } from "../src/local-model-selection.ts"
import {
  connectionFromSnapshot,
  executionModeAvailable,
  parseStoredModelPreferences,
  planAutocompleteSelection,
  planChatSelection,
  preferencesFromDiscovery,
  resolveModelRouting,
  routingFromSelection,
  snapshotFromResolution,
  type GlobalModelPreferences,
} from "../src/model-routing.ts"
import { renderModelManager, renderTrustNotice } from "../src/webview-render-helpers.ts"

const globalPrefs: GlobalModelPreferences = {
  version: 1,
  endpoint: "http://127.0.0.1:11434",
  chatModel: "qwen3-coder:30b",
  autocompleteModel: "qwen2.5-coder:7b",
}

function fileConfig(baseUrl: string): RoutingConfiguration {
  return routingFromSelection({
    endpoint: baseUrl,
    chatModel: "workspace-chat",
    autocompleteModel: "workspace-complete",
    credentialConfigured: false,
  })
}

test("discovered models route without a workspace file", () => {
  const resolved = resolveModelRouting({
    workspaceTrusted: true,
    workspaceConfig: null,
    workspaceConfigInvalid: false,
    overrideSuspended: false,
    globalPreferences: null,
    discoveredModelNames: ["qwen2.5-coder:7b", "qwen3-coder:30b"],
    credentialConfigured: false,
  })
  assert.equal(resolved.source, "discovered")
  assert.equal(resolved.chatModel, "qwen3-coder:30b")
  assert.equal(resolved.autocompleteModel, "qwen2.5-coder:7b")
  assert.equal(resolved.workspaceOverrideActive, false)
})

test("the same global preference resolves for two folders", () => {
  const first = resolveModelRouting({
    workspaceTrusted: true,
    workspaceConfig: null,
    workspaceConfigInvalid: false,
    overrideSuspended: false,
    globalPreferences: globalPrefs,
    discoveredModelNames: [],
    credentialConfigured: false,
  })
  const second = resolveModelRouting({
    workspaceTrusted: true,
    workspaceConfig: null,
    workspaceConfigInvalid: false,
    overrideSuspended: false,
    globalPreferences: globalPrefs,
    discoveredModelNames: ["other:7b"],
    credentialConfigured: false,
  })
  assert.equal(first.source, "global")
  assert.equal(second.source, "global")
  assert.equal(first.chatModel, second.chatModel)
  assert.equal(first.autocompleteModel, second.autocompleteModel)
  assert.equal(first.endpoint, second.endpoint)
})

test("chat selection does not write a workspace file and leaves autocomplete independent", () => {
  const plan = planChatSelection({
    current: globalPrefs,
    endpoint: globalPrefs.endpoint,
    chatModel: "llama3.1:8b",
    autocompleteModel: globalPrefs.autocompleteModel,
    overrideActive: true,
  })
  assert.equal(plan.writesWorkspaceFile, false)
  assert.equal(plan.suspendWorkspaceOverride, true)
  assert.equal(plan.preferences.chatModel, "llama3.1:8b")
  assert.equal(plan.preferences.autocompleteModel, "qwen2.5-coder:7b")
  assert.equal("advanced" in plan.preferences, false)
  const routed = routingFromSelection({ ...plan.preferences, credentialConfigured: false, chatModel: plan.preferences.chatModel || "", autocompleteModel: plan.preferences.autocompleteModel || "" })
  assert.notEqual(routed.routes.default?.[0], routed.routes.autocomplete?.[0])
  const autocompletePlan = planAutocompleteSelection({
    current: plan.preferences,
    endpoint: globalPrefs.endpoint,
    autocompleteModel: "qwen2.5-coder:7b",
    chatModel: plan.preferences.chatModel,
    overrideActive: false,
  })
  assert.equal(autocompletePlan.preferences.chatModel, "llama3.1:8b")
  assert.equal(autocompletePlan.writesWorkspaceFile, false)
})

test("a trusted workspace file overrides the global model and is not mutated", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-models-"))
  const override = fileConfig("http://127.0.0.1:11434")
  const raw = JSON.stringify(override, null, 2) + "\n"
  await mkdir(join(root, ".open-vs-code"))
  const path = join(root, ".open-vs-code", "models.json")
  await writeFile(path, raw)
  const loaded = loadRoutingConfigSync(root)
  const resolved = resolveModelRouting({
    workspaceTrusted: true,
    workspaceConfig: loaded,
    workspaceConfigInvalid: false,
    overrideSuspended: false,
    globalPreferences: globalPrefs,
    discoveredModelNames: ["qwen3-coder:30b"],
    credentialConfigured: false,
  })
  assert.equal(resolved.source, "workspace-override")
  assert.equal(resolved.workspaceOverrideActive, true)
  assert.equal(resolved.chatModel, "workspace-chat")
  assert.equal(await readFile(path, "utf8"), raw)
})

test("an untrusted workspace file cannot redirect inference", () => {
  const evil = fileConfig("http://127.0.0.1:9")
  const resolved = resolveModelRouting({
    workspaceTrusted: false,
    workspaceConfig: evil,
    workspaceConfigInvalid: false,
    overrideSuspended: false,
    globalPreferences: globalPrefs,
    discoveredModelNames: [],
    credentialConfigured: false,
  })
  assert.equal(resolved.source, "global")
  assert.equal(resolved.workspaceOverrideIgnored, true)
  assert.equal(resolved.workspaceOverrideActive, false)
  assert.equal(resolved.endpoint, "http://127.0.0.1:11434")
  assert.equal(resolved.chatModel, "qwen3-coder:30b")
  assert.notEqual(resolved.config, evil)
})

test("an invalid trusted file is not applied", () => {
  const resolved = resolveModelRouting({
    workspaceTrusted: true,
    workspaceConfig: null,
    workspaceConfigInvalid: true,
    overrideSuspended: false,
    globalPreferences: globalPrefs,
    discoveredModelNames: [],
    credentialConfigured: false,
  })
  assert.equal(resolved.source, "global")
  assert.equal(resolved.workspaceOverrideActive, false)
  assert.match(resolved.notice, /invalid/)
})

test("stored credentials and unreadable settings are left untouched", () => {
  const secret = parseStoredModelPreferences({ endpoint: "http://127.0.0.1:11434", chatModel: "qwen3-coder:30b", apiKey: "sk-test" })
  assert.equal(secret.preferences, null)
  assert.equal(secret.preserved, true)
  const migrated = parseStoredModelPreferences({ selectedModel: "qwen3-coder:30b", autocompleteModel: "qwen2.5-coder:7b" })
  assert.equal(migrated.preserved, false)
  assert.equal(migrated.preferences?.version, 1)
  assert.equal(migrated.preferences?.chatModel, "qwen3-coder:30b")
  assert.equal(JSON.stringify(migrated.preferences).includes("apiKey"), false)
})

test("a configured token is an environment name, not a stored secret", () => {
  const routed = routingFromSelection({ ...globalPrefs, credentialConfigured: true })
  const serialized = JSON.stringify(routed)
  assert.match(serialized, /OPEN_VS_CODE_LOCAL_INFERENCE_TOKEN/)
  assert.equal(serialized.includes("sk-"), false)
  assert.equal(serialized.includes("apiKey\""), false)
})

test("opening a model file is explicit and session restore is left alone", () => {
  assert.equal(shouldShowModelConfiguration("explicit-command"), true)
  assert.equal(shouldShowModelConfiguration("starter-created"), false)
  assert.equal(shouldShowModelConfiguration("session-restore"), false)
})

test("untrusted folders keep ask and withhold agent", () => {
  assert.equal(executionModeAvailable("ASK", false), true)
  assert.equal(executionModeAvailable("PLAN", false), true)
  assert.equal(executionModeAvailable("REVIEW", false), true)
  assert.equal(executionModeAvailable("BUILD", false), false)
  assert.equal(executionModeAvailable("DEBUG", false), false)
  assert.equal(executionModeAvailable("BUILD", true), true)
})

test("offline ollama and a missing model are distinct", () => {
  const offlineResolution = resolveModelRouting({
    workspaceTrusted: true,
    workspaceConfig: null,
    workspaceConfigInvalid: false,
    overrideSuspended: false,
    globalPreferences: globalPrefs,
    discoveredModelNames: [],
    credentialConfigured: false,
  })
  const offline = connectionFromSnapshot(snapshotFromResolution({
    resolution: offlineResolution,
    installedModels: [],
    endpointError: "The local endpoint is unreachable.",
    workspaceTrusted: true,
    credentialConfigured: false,
    advancedActive: false,
    probedEndpoint: globalPrefs.endpoint,
  }))
  assert.equal(offline.lastError, "disconnected")
  const missing = connectionFromSnapshot(snapshotFromResolution({
    resolution: offlineResolution,
    installedModels: ["qwen2.5-coder:7b"],
    workspaceTrusted: true,
    credentialConfigured: false,
    advancedActive: false,
    probedEndpoint: globalPrefs.endpoint,
  }))
  assert.equal(missing.lastError, "model-unavailable")
  assert.equal(missing.selectedModel, "qwen3-coder:30b")
})

test("discovery chooses a stable pair", () => {
  const prefs = preferencesFromDiscovery("http://127.0.0.1:11434", ["qwen2.5-coder:7b", "qwen3-coder:30b"])
  assert.equal(prefs?.chatModel, "qwen3-coder:30b")
  assert.equal(prefs?.autocompleteModel, "qwen2.5-coder:7b")
})

test("autocomplete selection does not retarget chat routes", () => {
  const starter = routingFromSelection({ ...globalPrefs, credentialConfigured: false })
  const chatRoutes = starter.routes.default
  const next = applyAutocompleteModelSelection(starter, "qwen2.5-coder:7b")
  assert.deepEqual(next.routes.default, chatRoutes)
  assert.notEqual(next.routes.autocomplete?.[0], chatRoutes?.[0])
  const chatOnly = applyChatModelSelection(next, "qwen3-coder:30b")
  assert.deepEqual(chatOnly.routes.autocomplete, next.routes.autocomplete)
})

class MockElement {
  public textContent = ""
  public className = ""
  public children: MockElement[] = []
  public attrs: Record<string, string> = {}
  public value = ""
  public disabled = false
  public selected = false
  public placeholder = ""
  public type = ""
  constructor(public tagName = "div") {}
  set innerHTML(val: string) { if (val === "") this.children = [] }
  get innerHTML() { return "" }
  appendChild(child: MockElement) { this.children.push(child); return child }
  setAttribute(name: string, value: string) { this.attrs[name] = value }
  addEventListener() {}
}

test("model manager and trust banner describe the active limit", () => {
  const doc = { createElement: (tag: string) => new MockElement(tag) }
  const root = new MockElement("div")
  const resolution = resolveModelRouting({
    workspaceTrusted: false,
    workspaceConfig: fileConfig("http://10.0.0.8:11434"),
    workspaceConfigInvalid: false,
    overrideSuspended: false,
    globalPreferences: globalPrefs,
    discoveredModelNames: ["qwen3-coder:30b", "qwen2.5-coder:7b"],
    credentialConfigured: false,
  })
  const snapshot = {
    ...snapshotFromResolution({
      resolution,
      installedModels: ["qwen3-coder:30b", "qwen2.5-coder:7b"],
      workspaceTrusted: false,
      credentialConfigured: false,
      advancedActive: false,
      probedEndpoint: globalPrefs.endpoint,
    }),
    open: true,
  }
  renderModelManager(root, snapshot, doc, () => {})
  const text = JSON.stringify(root)
  assert.match(text, /untrusted/)
  assert.match(text, /qwen3-coder:30b/)
  assert.match(text, /Autocomplete/)
  const trust = new MockElement("div")
  renderTrustNotice(trust, { workspaceTrusted: false, modelManager: snapshot }, doc, () => {})
  assert.match(JSON.stringify(trust), /Manage Workspace Trust/)
  const trusted = new MockElement("div")
  renderTrustNotice(trusted, { workspaceTrusted: true }, doc, () => {})
  assert.equal(trusted.children.length, 0)
})
