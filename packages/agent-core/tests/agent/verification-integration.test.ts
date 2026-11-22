import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"

import { AgentRunner } from "../../src/agent/runner.ts"
import { ModelProvider, ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { createVerificationToolRegistry } from "../../src/tools/verification-registry.ts"
import { classifyPermission } from "../../src/tools/permissions.ts"

const dummyBudget = {
  contextWindow: 128000,
  reservedOutput: 8000,
  reservedToolHistory: 20000,
  availableContext: 100000,
}

const dummyCapabilities = new Set<any>(["TOOL_CALLING", "SYSTEM_MESSAGES"])

test("Verification Integration - E2E scripted mutation -> verification scenario", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: {
        test: "node test.js",
      },
    }))
    await fs.writeFile(path.join(tmpDir, "test.js"), "console.log('PASS')")

    const registry = createVerificationToolRegistry(tmpDir)

    // Mock Model Provider that requests verification
    const provider: ModelProvider = {
      capabilities: dummyCapabilities,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        if (request.metadata?.turn === 1) {
          return {
            model: "test-model",
            message: { role: "assistant", content: "Running tests" },
            toolCalls: [{ id: "call1", name: "run_verification", arguments: { action: "TEST" } }]
          }
        }
        return {
          model: "test-model",
          message: { role: "assistant", content: "Final Answer" },
        }
      }
    }

    const runner = new AgentRunner({ provider, registry })
    const task = { id: "t1", instruction: "test something", mode: "BUILD" as const }
    let result = await runner.run({
      workspaceRoot: tmpDir,
      task,
      projectInstructions: [],
      maxTurns: 5,
      contextBudget: dummyBudget,
    })

    assert.equal(result.finalState.status, "WAITING_FOR_CONFIRMATION")
    
    // Check events correctly emitted for verification
    const verificationRequested = result.events.find((e: any) => e.type === "verification.confirmation_requested")
    assert.ok(verificationRequested)

    result = await runner.resume("APPROVE")

    assert.equal(result.finalState.status, "COMPLETED")
    
    const verificationCompleted = result.events.find((e: any) => e.type === "verification.completed")
    assert.ok(verificationCompleted)

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Integration - Node fallback still waits for approval", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    await fs.mkdir(path.join(tmpDir, "test"))
    const marker = path.join(tmpDir, "ran.txt")
    await fs.writeFile(path.join(tmpDir, "test", "add.test.js"), `import test from 'node:test'\nimport fs from 'node:fs'\ntest('side effect', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'ran') })\n`)
    assert.equal(classifyPermission({ action: "run_known_test", mode: "BUILD" }), "CONFIRM")

    const registry = createVerificationToolRegistry(tmpDir)
    const prepared = registry.prepare({ id: "call1", name: "run_verification", arguments: { action: "TEST" } })
    await assert.rejects(
      prepared.invoke({ workspaceRoot: tmpDir, signal: new AbortController().signal }),
      /requires a two-phase review process/
    )
    await assert.rejects(fs.access(marker))

    const provider: ModelProvider = {
      capabilities: dummyCapabilities,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        if (request.metadata?.turn === 1) {
          return {
            model: "test-model",
            message: { role: "assistant", content: "Running tests" },
            toolCalls: [{ id: "call1", name: "run_verification", arguments: { action: "TEST" } }],
          }
        }
        return { model: "test-model", message: { role: "assistant", content: "Final Answer" } }
      },
    }
    const runner = new AgentRunner({ provider, registry })
    const result = await runner.run({
      workspaceRoot: tmpDir,
      task: { id: "t-node", instruction: "run the tests", mode: "BUILD" },
      projectInstructions: [],
      maxTurns: 5,
      contextBudget: dummyBudget,
    })
    assert.equal(result.finalState.status, "WAITING_FOR_CONFIRMATION")
    assert.ok(result.events.find((event: { type?: string }) => event.type === "verification.confirmation_requested"))
    await assert.rejects(fs.access(marker))

    const rejected = await runner.resume("REJECT")
    assert.equal(rejected.finalState.status, "COMPLETED")
    await assert.rejects(fs.access(marker))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Integration - Reject approval binding", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: {
        test: "node test.js",
      },
    }))

    const registry = createVerificationToolRegistry(tmpDir)

    const provider: ModelProvider = {
      capabilities: dummyCapabilities,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        if (request.metadata?.turn === 1) {
          return {
            model: "test-model",
            message: { role: "assistant", content: "Running tests" },
            toolCalls: [{ id: "call1", name: "run_verification", arguments: { action: "TEST" } }]
          }
        }
        return {
          model: "test-model",
          message: { role: "assistant", content: "Final Answer" },
        }
      }
    }

    const runner = new AgentRunner({ provider, registry })
    const task = { id: "t1", instruction: "test something", mode: "BUILD" as const }
    let result = await runner.run({
      workspaceRoot: tmpDir,
      task,
      projectInstructions: [],
      maxTurns: 5,
      contextBudget: dummyBudget,
    })

    assert.equal(result.finalState.status, "WAITING_FOR_CONFIRMATION")
    
    result = await runner.resume("REJECT")

    // The tool is rejected, the model is called again.
    assert.equal(result.finalState.status, "COMPLETED")
    
    const verificationRejected = result.events.find((e: any) => e.type === "verification.rejected")
    assert.ok(verificationRejected)

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
