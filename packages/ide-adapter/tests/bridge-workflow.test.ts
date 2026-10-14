import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ScriptedModelProvider } from "@open-vs-code/agent-core"
import { AgentSessionBridge } from "../src/bridge.js"
import { TestIdeHost } from "./test-host.js"

const plan = { goal: "Add subtract", files: ["src/math.ts"], steps: ["Add subtract"], tests: ["npm test"], risks: [], acceptanceCriteria: ["subtract(a, b) returns a - b"] }

async function workspace(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovsc-bridge-workflow-")))
  await fs.mkdir(path.join(root, "src"))
  await fs.writeFile(path.join(root, "src/math.ts"), "// subtract: TODO\n")
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fx", private: true, scripts: { test: "node -e \"process.exit(0)\"" } }))
  return root
}

function provider() {
  return new ScriptedModelProvider([
    { model: "s", message: { role: "assistant", content: JSON.stringify(plan) } },
    { model: "s", message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "src/math.ts", search: "// subtract: TODO\n", replace: "export const subtract = (a: number, b: number) => a - b\n" } }] },
    { model: "s", message: { role: "assistant", content: "Added subtract." } },
    { model: "s", message: { role: "assistant", content: JSON.stringify({ verdict: "NO_FINDINGS", findings: [] }) } },
  ])
}

test("BRIDGE-WF-1: with workflow enabled, every change and check is confirmed through the host and stages are shown", async () => {
  const root = await workspace()
  const host = new TestIdeHost()
  const bridge = new AgentSessionBridge({ host, workspaceRoot: root, providerOverride: provider(), workflow: { enabled: true } })
  const result = await bridge.runTask("Add a subtract function to src/math.ts", "BUILD", new AbortController().signal)
  assert.equal(result.status, "COMPLETED")
  assert.equal(bridge.workflowState?.currentStage, "COMPLETE")
  assert.equal(host.confirmationsRequested.length, 3, "mutation, TEST checks, VERIFY checks")
  assert.ok(host.confirmationsRequested[0]!.prompt.startsWith("Approve mutation on src/math.ts"))
  assert.ok(host.outputs.includes("Stage: REVIEW") && host.outputs.includes("Stage: VERIFY") && host.outputs.includes("Stage: COMPLETE"))
})

test("BRIDGE-WF-2: rejecting the TEST checks blocks the workflow instead of completing it", async () => {
  const root = await workspace()
  const host = new TestIdeHost()
  let calls = 0
  host.requestConfirmation = async (prompt, payload) => {
    host.confirmationsRequested.push({ prompt, payload })
    calls += 1
    return calls === 1 ? "APPROVE" : "REJECT"
  }
  const bridge = new AgentSessionBridge({ host, workspaceRoot: root, providerOverride: provider(), workflow: { enabled: true } })
  const result = await bridge.runTask("Add a subtract function to src/math.ts", "BUILD", new AbortController().signal)
  assert.equal(result.status, "FAILED")
  assert.equal(bridge.workflowState?.blocker, "VERIFICATION_REJECTED")
  assert.equal(bridge.workflowState?.reviews.length, 0)
})
