import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCLI, runLearningCLI } from "../src/app.ts"
import { ScriptedModelProvider } from "@open-vs-code/agent-core"

const plan = { goal: "Add subtract", files: ["src/math.ts"], steps: ["Add subtract"], tests: ["npm test"], risks: [], acceptanceCriteria: ["subtract(a, b) returns a - b"] }

async function workspace(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovsc-cli-learning-")))
  await fs.mkdir(path.join(root, "src"))
  await fs.writeFile(path.join(root, "src/math.ts"), "// subtract: TODO\n")
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fx", private: true, scripts: { test: "node -e \"process.exit(0)\"" } }))
  await fs.writeFile(path.join(root, "package-lock.json"), "{}")
  return root
}

const provider = () => new ScriptedModelProvider([
  { model: "s", message: { role: "assistant", content: JSON.stringify(plan) } },
  { model: "s", message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "src/math.ts", search: "// subtract: TODO\n", replace: "export const subtract = (a: number, b: number) => a - b\n" } }] },
  { model: "s", message: { role: "assistant", content: "Added subtract." } },
  { model: "s", message: { role: "assistant", content: JSON.stringify({ verdict: "NO_FINDINGS", findings: [] }) } },
])

async function runOnce(root: string, learning: boolean): Promise<any> {
  await fs.writeFile(path.join(root, "src/math.ts"), "// subtract: TODO\n")
  await new Promise((resolve) => setTimeout(resolve, 5))
  return runCLI({ mode: "BUILD", instruction: "Add a subtract function to src/math.ts", workspaceRoot: root, json: true, provider: provider(), mockApproval: "APPROVE", workflow: true, ...(learning ? { learning: true } : {}) })
}

test("CLI-LEARN-1: --learning records evidence after a verified workflow; the review gate approves explicitly", async () => {
  const root = await workspace()
  const first = await runOnce(root, true)
  assert.equal(first.status, "COMPLETE")
  assert.equal(first.learningStep.ran, true)
  assert.equal(first.learningStep.error, undefined)
  await runOnce(root, true)

  const listed = await runLearningCLI({ workspaceRoot: root, action: "list", json: true }) as any
  const candidates = listed.output.records.filter((record: any) => record.status === "CANDIDATE")
  assert.ok(candidates.some((record: any) => record.patternKey === "project:toolchain:npm"), "two verified tasks make the toolchain fact a candidate")
  assert.ok(listed.output.records.every((record: any) => record.status !== "APPROVED"), "nothing is approved automatically")

  const fact = candidates.find((record: any) => record.patternKey === "project:toolchain:npm")
  const shown = await runLearningCLI({ workspaceRoot: root, action: "show", id: fact.id, json: true }) as any
  assert.equal(shown.output.successes, 2)
  assert.match(shown.output.ifApproved, /grants no permission/)
  const approved = await runLearningCLI({ workspaceRoot: root, action: "approve", id: fact.id, json: true }) as any
  assert.equal(approved.exitCode, 0)
  assert.equal((await runLearningCLI({ workspaceRoot: root, action: "approve", id: "lr-missing", json: true })).exitCode, 1)
  assert.equal((await runLearningCLI({ workspaceRoot: root, action: "reject", id: "lr-missing", json: true })).exitCode, 1)
  const store = await fs.readFile(path.join(root, ".open-vs-code/learning/learning.json"), "utf8")
  assert.ok(!store.includes("Add a subtract function"), "the task text is not stored")
})

test("CLI-LEARN-2: without --learning nothing is written", async () => {
  const root = await workspace()
  const result = await runOnce(root, false)
  assert.equal(result.status, "COMPLETE")
  assert.equal(result.learningStep.ran, false)
  await assert.rejects(fs.access(path.join(root, ".open-vs-code/learning")))
})
