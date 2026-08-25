import assert from "node:assert/strict"
import test from "node:test"

import { AGENT_MODES, type AgentTask } from "../../src/contracts/agent.ts"
import type { ContextItem } from "../../src/contracts/context.ts"
import type { EditorAdapter } from "../../src/contracts/editor.ts"
import type { ModelCapability, ModelProvider } from "../../src/contracts/model.ts"
import type { ToolDefinition } from "../../src/contracts/tools.ts"

test("agent modes expose the five initial workflows", () => {
  assert.deepEqual(AGENT_MODES, ["ASK", "PLAN", "BUILD", "DEBUG", "REVIEW"])
})

test("contracts represent capabilities without vendor or editor coupling", () => {
  const capabilities = ["chat", "reasoning", "tools", "fim", "embeddings", "streaming"] satisfies ModelCapability[]
  const provider: ModelProvider = {
    capabilities: new Set(capabilities),
    complete: async () => ({ model: "local", message: { role: "assistant", content: "ok" } }),
  }
  const item: ContextItem = {
    id: "task",
    source: { kind: "task" },
    content: "Implement contracts",
    priority: 100,
    estimatedTokens: 5,
    required: true,
    metadata: { path: "PLAN.md" },
  }
  const tool: ToolDefinition = {
    name: "read_file",
    description: "Read one repository file",
    inputSchema: { type: "object" },
    action: "read_repository",
  }
  const task: AgentTask = { id: "t-011", mode: "BUILD", instruction: item.content }
  const editor: EditorAdapter = { getActiveFile: async () => undefined }

  assert.equal(provider.capabilities.has("fim"), true)
  assert.equal(tool.action, "read_repository")
  assert.equal(task.mode, "BUILD")
  assert.equal(typeof editor.getActiveFile, "function")
})
