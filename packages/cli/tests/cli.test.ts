import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import { runCLI } from "../src/app.ts"
import { ScriptedModelProvider } from "@open-vs-code/agent-core"

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures")

async function setupWorkspace(name: string) {
  const ws = path.join(FIXTURES_DIR, name)
  await fs.mkdir(ws, { recursive: true })
  return ws
}

test("ASK mode completes successfully without tools", async () => {
  const ws = await setupWorkspace("ask-test")
  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "Hello from ASK mode!" } }
  ])

  const result = await runCLI({
    mode: "ASK",
    instruction: "Say hello",
    workspaceRoot: ws,
    json: true,
    provider
  })
  assert.equal(result.exitCode, 0)
})

test("PLAN mode completes successfully", async () => {
  const ws = await setupWorkspace("plan-test")
  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "Here is the plan." } }
  ])

  const result = await runCLI({
    mode: "PLAN",
    instruction: "Make a plan",
    workspaceRoot: ws,
    json: true,
    provider
  })
  assert.equal(result.exitCode, 0)
})

test("BUILD mode with approved mutation", async () => {
  const ws = await setupWorkspace("build-test")
  await fs.writeFile(path.join(ws, "file.txt"), "hello\n")

  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{
         id: "call_1",
         name: "apply_patch",
           arguments: {
             path: "file.txt",
             search: "hello\n",
             replace: "world\n"
           } }]
    },
    { model: "scripted", message: { role: "assistant", content: "Done." } }
  ])

  const result = await runCLI({
    mode: "BUILD",
    instruction: "Change hello to world",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "APPROVE"
  })
  assert.equal(result.exitCode, 0)
  const content = await fs.readFile(path.join(ws, "file.txt"), "utf8")
  assert.equal(content, "world\n")
})

test("DEBUG mode hands off to RepairOrchestrator and succeeds", async () => {
  const ws = await setupWorkspace("debug-test")
  await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }))
  await fs.writeFile(path.join(ws, "test.sh"), "exit 1")

  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{
         id: "call_1",
         name: "run_verification",
           arguments: {
             action: "TEST"
           } }]
    },
    // Repair loop turn 1 (after test fails)
    { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{
         id: "call_2",
         name: "apply_patch",
           arguments: {
             path: "package.json",
             search: "\"exit 1\"",
             replace: "\"exit 0\""
           } }]
    },
    // Repair loop turn 2 (after mutation success, it runs test again, test passes)
    { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "call_3", name: "run_verification", arguments: { action: "TEST" } }] },
    // Turn 3: completed
    { model: "scripted", message: { role: "assistant", content: "Fixed!" } }
  ])

  const result = await runCLI({
    mode: "DEBUG",
    instruction: "Fix the test",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "APPROVE"
  })
  assert.equal(result.exitCode, 0)
  const content = await fs.readFile(path.join(ws, "package.json"), "utf8")
  assert.equal(content.includes("exit 0"), true)
})

test("REVIEW mode completes successfully", async () => {
  const ws = await setupWorkspace("review-test")
  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "Looks good." } }
  ])

  const result = await runCLI({
    mode: "REVIEW",
    instruction: "Review the code",
    workspaceRoot: ws,
    json: true,
    provider
  })
  assert.equal(result.exitCode, 0)
})

test("BUILD mode with rejected mutation fails", async () => {
  const ws = await setupWorkspace("build-reject-test")
  await fs.writeFile(path.join(ws, "file.txt"), "hello\n")

  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{
         id: "call_1",
         name: "apply_patch",
           arguments: {
             path: "file.txt",
             search: "hello\n",
             replace: "world\n"
           } }]
    },
    { model: "scripted", message: { role: "assistant", content: "Ah, rejected." } }
  ])

  const result = await runCLI({
    mode: "BUILD",
    instruction: "Change hello to world",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "REJECT"
  })
  assert.equal(result.exitCode, 0) // runner still completes because it handled the rejection
  const content = await fs.readFile(path.join(ws, "file.txt"), "utf8")
  assert.equal(content, "hello\n")
})


test("BUILD mode with STALE_VERIFICATION", async () => {
  const ws = await setupWorkspace("stale-verif-test")
  await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }))

  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{
         id: "call_1",
         name: "run_verification",
           arguments: {
             action: "TEST"
           } }]
    },
    { model: "scripted", message: { role: "assistant", content: "Done." } }
  ])

  const result = await runCLI({
    mode: "BUILD",
    instruction: "Run test",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: async () => {
      // Modify package.json to trigger STALE_VERIFICATION
      await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }))
      return "APPROVE";
    }
  })

  assert.equal(result.exitCode, 1)

  // Find the verification result in events
  const verifEvent = result.events.find((e: any) => e.type === "repair.verification_completed" || e.type === "verification.completed")
  assert.ok(verifEvent, "Expected a verification.completed event")
  assert.equal(verifEvent.status || verifEvent.payload?.result?.status, "STALE_VERIFICATION")
})

test("BUILD mode cancellation", async () => {
  const ws = await setupWorkspace("cancel-test")
  await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "sleep 10" } }))

  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{
         id: "call_1",
         name: "run_verification",
           arguments: {
             action: "TEST"
           } }]
    },
    { model: "scripted", message: { role: "assistant", content: "Done." } }
  ])

  const resultPromise = runCLI({
    mode: "BUILD",
    instruction: "Run test",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "APPROVE"
  })

  // Wait a little bit for the process to start, then send SIGINT
  await new Promise(resolve => setTimeout(resolve, 500))
  process.emit("SIGINT" as any)

  const result = await resultPromise

  assert.equal(result.exitCode, 2)
  assert.equal(result.status, "CANCELLED")
})
