import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { describeConfiguredRoute } from "../../src/model/router.ts"
import type { RoutingConfiguration } from "../../src/contracts/routing.ts"

const config: RoutingConfiguration = {
  providers: [
    { id: "ollama-local", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11434" },
    { id: "other-local", kind: "openai_compatible_local", baseUrl: "http://127.0.0.1:11435" },
  ],
  models: [
    {
      id: "catalog-first",
      displayName: "Catalog First",
      contextWindow: 8192,
      capabilities: ["toolUse", "coding"],
      specialization: "coding",
    },
    {
      id: "qwen2.5-coder-7b",
      displayName: "Qwen 2.5 Coder 7B",
      contextWindow: 32768,
      capabilities: ["toolUse", "coding"],
      specialization: "coding",
    },
  ],
  deployments: [
    {
      id: "unused-first",
      providerId: "other-local",
      modelId: "catalog-first",
      modelName: "catalog-first:latest",
      enabled: true,
      priority: 100,
    },
    {
      id: "qwen-chat",
      providerId: "ollama-local",
      modelId: "qwen2.5-coder-7b",
      modelName: "qwen2.5-coder:7b",
      enabled: true,
      priority: 10,
    },
  ],
  routes: {
    default: ["qwen-chat"],
    coding: ["qwen-chat"],
  },
}

describe("configured route identity", () => {
  test("reports the routed deployment instead of the first models.json entry", async () => {
    const identity = await describeConfiguredRoute(config, "ASK")
    assert.ok(identity)
    assert.equal(identity.deploymentId, "qwen-chat")
    assert.equal(identity.providerId, "ollama-local")
    assert.equal(identity.modelId, "qwen2.5-coder-7b")
    assert.equal(identity.servedModelName, "qwen2.5-coder:7b")
    assert.equal(identity.modelLabel, "Qwen 2.5 Coder 7B · qwen2.5-coder:7b")
    assert.notEqual(identity.modelId, config.models[0]?.id)
  })

  test("returns null when no route can serve a tool-using turn", async () => {
    const blocked: RoutingConfiguration = {
      ...config,
      routes: { default: ["unused-first"] },
      models: config.models.map((model) =>
        model.id === "catalog-first" ? { ...model, capabilities: ["coding"] } : model,
      ),
    }
    const identity = await describeConfiguredRoute(blocked, "ASK")
    assert.equal(identity, null)
  })
})
