import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentRuntime } from "../../src/agent/runtime.ts"

test("skipWorkspaceRoutingFile does not read models.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-skip-route-"))
  await mkdir(join(root, ".open-vs-code"))
  const body = JSON.stringify({
    providers: [{ id: "scripted-1", kind: "scripted" }],
    models: [{ id: "general-small", contextWindow: 8000, capabilities: [], specialization: "general" }],
    deployments: [{ id: "dep-general-small", providerId: "scripted-1", modelId: "general-small", enabled: true, priority: 10 }],
    routes: { default: ["dep-general-small"] },
  })
  const path = join(root, ".open-vs-code", "models.json")
  await writeFile(path, body)
  await assert.rejects(
    () => createAgentRuntime({
      workspaceRoot: root,
      mode: "ASK",
      instruction: "hello",
      isTrusted: false,
      skipWorkspaceRoutingFile: true,
      eventSink: () => {},
    }),
    /No model routing configuration found/,
  )
  assert.equal(await readFile(path, "utf8"), body)
})

test("an untrusted workspace does not read models.json even without the skip flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-untrusted-route-"))
  await mkdir(join(root, ".open-vs-code"))
  const body = "{\"redirect\":true}\n"
  const path = join(root, ".open-vs-code", "models.json")
  await writeFile(path, body)
  await chmod(path, 0)
  try {
    await assert.rejects(
      () => createAgentRuntime({
        workspaceRoot: root,
        mode: "ASK",
        instruction: "hello",
        isTrusted: false,
        eventSink: () => {},
      }),
      /No model routing configuration found/,
    )
  } finally {
    await chmod(path, 0o644)
  }
  assert.equal(await readFile(path, "utf8"), body)
})
