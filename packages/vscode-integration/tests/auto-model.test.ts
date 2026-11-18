import assert from "node:assert/strict"
import test from "node:test"
import { ModelRouter } from "@open-vs-code/agent-core"
import { AUTO_MODEL, autoEligibleModels } from "../src/local-model-selection.ts"
import { planChatSelection, resolveModelRouting, routingFromSelection } from "../src/model-routing.ts"

const INSTALLED = ["qwen2.5-coder:7b", "qwen3-coder:30b", "qwen3.6:35b", "qwen3-embedding:0.6b", "qwen3.5:4b"]
const selection = (installed = INSTALLED) => routingFromSelection({ endpoint: "http://127.0.0.1:11434", chatModel: AUTO_MODEL, autocompleteModel: "qwen2.5-coder:7b", credentialConfigured: false, installed })
const req = { taskClass: "coding", needsTools: true, needsStructuredOutput: false, estimatedInputTokens: 4000, requiredContextWindow: 8000 } as const
const health = (down: readonly string[]) => ({ checkHealth: async (id: string) => (down.includes(id) ? "unavailable" : "ready") as "ready" | "unavailable" })

test("Auto offers only large coding models, Qwen3.6 first; the 7B, 4B and embedding models are never eligible", () => {
  assert.deepEqual(autoEligibleModels(INSTALLED), ["qwen3.6:35b", "qwen3-coder:30b"])
  assert.throws(() => selection(["qwen2.5-coder:7b", "qwen3.5:4b"]), /NO_AUTO_MODEL/)
})

test("the real router picks Qwen3.6 for coding, falls back only to Qwen3-Coder, and fails closed rather than using the 7B", async () => {
  const config = selection()
  const router = new ModelRouter(config)
  const name = async (down: string[]) => {
    const d = await router.route(req, health(down))
    return config.deployments.find((x) => x.id === d.deploymentId)!.modelName
  }
  assert.equal(await name([]), "qwen3.6:35b")
  const first = config.routes.coding![0]!
  assert.equal(await name([first]), "qwen3-coder:30b")
  await assert.rejects(router.route(req, health([...config.routes.coding!])), /ROUTE_UNAVAILABLE|unavailable|No/i)
  assert.equal(config.deployments.find((x) => x.id === config.routes.autocomplete![0])!.modelName, "qwen2.5-coder:7b")
  assert.ok(!config.routes.coding!.some((id) => config.deployments.find((x) => x.id === id)!.modelName === "qwen2.5-coder:7b"))
})

test("choosing Auto never makes the autocomplete model 'auto', and manual selection is unchanged", () => {
  const plan = planChatSelection({ current: null, endpoint: "http://127.0.0.1:11434", chatModel: AUTO_MODEL, overrideActive: false })
  assert.equal(plan.preferences.autocompleteModel, "qwen2.5-coder:7b")
  const manual = routingFromSelection({ endpoint: "http://127.0.0.1:11434", chatModel: "qwen3-coder:30b", autocompleteModel: "qwen2.5-coder:7b", credentialConfigured: false })
  assert.deepEqual(manual.routes.coding, ["open-vs-code-chat"])
})

test("a stored Auto preference resolves to Auto and keeps the user's explicit workspace/manual choices intact", () => {
  const r = resolveModelRouting({ globalPreferences: { version: 1, endpoint: "http://127.0.0.1:11434", chatModel: AUTO_MODEL, autocompleteModel: "qwen2.5-coder:7b" }, workspaceConfig: null, workspaceConfigInvalid: false, workspaceTrusted: true, credentialConfigured: false, discoveredModelNames: INSTALLED } as never)
  assert.equal(r.chatModel, AUTO_MODEL)
  assert.equal(r.config!.routes.coding!.length, 2)
})
