import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCLI } from "../src/app.ts"
import { ScriptedModelProvider } from "@open-vs-code/agent-core"

const plan = { goal: "Add subtract", files: ["src/math.ts"], steps: ["Add subtract"], tests: ["npm test"], risks: [], acceptanceCriteria: ["subtract(a, b) returns a - b"] }

async function workspace(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovsc-cli-workflow-")))
  await fs.mkdir(path.join(root, "src"))
  await fs.writeFile(path.join(root, "src/math.ts"), "// subtract: TODO\n")
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fx", private: true, scripts: { test: "node -e \"process.exit(0)\"" } }))
  return root
}

test("CLI-WF-1: --workflow drives an eligible BUILD task PLAN → IMPLEMENT → TEST → REVIEW → VERIFY → COMPLETE", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    { model: "s", message: { role: "assistant", content: JSON.stringify(plan) } },
    { model: "s", message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "src/math.ts", search: "// subtract: TODO\n", replace: "export const subtract = (a: number, b: number) => a - b\n" } }] },
    { model: "s", message: { role: "assistant", content: "Added subtract." } },
    { model: "s", message: { role: "assistant", content: JSON.stringify({ verdict: "NO_FINDINGS", findings: [] }) } },
  ])
  const result = await runCLI({ mode: "BUILD", instruction: "Add a subtract function to src/math.ts", workspaceRoot: root, json: true, provider, mockApproval: "APPROVE", workflow: true }) as any
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, "COMPLETE")
  assert.deepEqual(result.workflow.stages.map((record: any) => record.stage), ["PLAN", "IMPLEMENT", "TEST", "REVIEW", "VERIFY"])
  assert.equal(result.workflow.verification.verdict, "READY")
  assert.match(await fs.readFile(path.join(root, "src/math.ts"), "utf8"), /a - b/)
})

test("CLI-WF-2: without --workflow the same task takes the direct path", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([{ model: "s", message: { role: "assistant", content: "Done" } }])
  const result = await runCLI({ mode: "BUILD", instruction: "Add a subtract function to src/math.ts", workspaceRoot: root, json: true, provider, mockApproval: "APPROVE" }) as any
  assert.equal(result.workflow, undefined)
  assert.equal(result.status, "COMPLETED")
})
