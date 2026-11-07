import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeConfiguredRoute, loadRoutingConfigSync, ModelRouter } from "@open-vs-code/agent-core"
import { applyChatModelSelection, parseOllamaTags } from "../src/local-model-selection.ts"

const starter = {
  providers: [
    { id: "local-inference", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" },
  ],
  models: [
    {
      id: "qwen2.5-coder-7b",
      displayName: "Qwen 2.5 Coder 7B",
      family: "qwen",
      contextWindow: 32768,
      capabilities: ["toolUse", "coding", "autocomplete", "fim"],
      specialization: "coding",
      fimStrategy: "qwen",
    },
  ],
  deployments: [
    { id: "local-chat", providerId: "local-inference", modelId: "qwen2.5-coder-7b", modelName: "qwen2.5-coder:7b", enabled: true, priority: 10 },
    { id: "local-fim", providerId: "local-inference", modelId: "qwen2.5-coder-7b", modelName: "qwen2.5-coder:7b", enabled: true, priority: 10, fimStrategy: "qwen" },
    { id: "special-research", providerId: "local-inference", modelId: "qwen2.5-coder-7b", modelName: "research-model", enabled: true, priority: 5 },
  ],
  routes: {
    coding: ["local-chat"],
    debugging: ["local-chat"],
    default: ["local-chat"],
    autocomplete: ["local-fim"],
    research: ["special-research"],
  },
}

test("ollama tag payload becomes model choices", () => {
  const choices = parseOllamaTags({ models: [{ name: "qwen2.5-coder:7b", size: 100 }, { name: "  " }, { nope: true }] })
  assert.deepEqual(choices, [{ name: "qwen2.5-coder:7b", sizeBytes: 100 }])
})

test("chat selection changes the routed coding model and leaves autocomplete", async () => {
  const selected = applyChatModelSelection(starter, "qwen2.5-coder:14b")
  const root = await mkdtemp(join(tmpdir(), "ovsc-models-"))
  await mkdir(join(root, ".open-vs-code"))
  await writeFile(join(root, ".open-vs-code", "models.json"), JSON.stringify(selected))
  const loaded = loadRoutingConfigSync(root)
  assert.ok(loaded)
  const coding = await describeConfiguredRoute(loaded, "BUILD")
  const asking = await describeConfiguredRoute(loaded, "ASK")
  assert.equal(coding?.servedModelName, "qwen2.5-coder:14b")
  assert.equal(asking?.servedModelName, "qwen2.5-coder:14b")
  assert.equal(coding?.deploymentId, "open-vs-code-chat")

  const router = new ModelRouter(loaded)
  const autocomplete = await router.route({
    mode: "ASK",
    taskClass: "autocomplete",
    needsTools: false,
    needsStructuredOutput: false,
    estimatedInputTokens: 100,
    requiredContextWindow: 2048,
    requiredCapabilities: ["autocomplete"],
  }, { async checkHealth() { return "unknown" } })
  assert.equal(autocomplete.deploymentId, "local-fim")
  assert.equal(loaded.deployments.find((entry) => entry.id === "local-fim")?.modelName, "qwen2.5-coder:7b")
  assert.deepEqual(loaded.routes.research, ["special-research"])
  assert.deepEqual(loaded.routes.autocomplete, ["local-fim"])
})

test("a cloud-only configuration cannot be selected as a local model", () => {
  assert.throws(
    () => applyChatModelSelection({
      providers: [{ id: "remote", kind: "fake" }],
      models: [{ id: "m", contextWindow: 8192, capabilities: ["coding"], specialization: "coding" }],
      deployments: [{ id: "d", providerId: "remote", modelId: "m", enabled: true }],
      routes: { default: ["d"] },
    }, "cloud-model"),
    /NO_LOCAL_PROVIDER/,
  )
})
