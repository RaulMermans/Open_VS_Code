import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { ProjectMemoryLoader } from "../../src/context/memory-loader.ts"
import { MemoryRetriever } from "../../src/context/memory-retriever.ts"
import { SessionSummaryStorage } from "../../src/context/session-storage.ts"

const fixDir = join(new URL(".", import.meta.url).pathname, "..", "fixtures", "memory-test")

async function setupFixture(name: string, files: Record<string, string>) {
  const dir = join(fixDir, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const fPath = join(dir, file)
    await mkdir(join(fPath, ".."), { recursive: true })
    await writeFile(fPath, content, "utf8")
  }
  return dir
}

test("new project, no memory", async () => {
  const dir = await setupFixture("empty", {})
  const loader = new ProjectMemoryLoader(dir)
  const snap = await loader.load()
  assert.equal(snap.projectGoal, undefined)
  assert.deepEqual(snap.decisions, [])
})

test("project with PROJECT + ARCHITECTURE", async () => {
  const dir = await setupFixture("proj", {
    "PROJECT.md": "# North star\nWe build an agent.",
    "ARCHITECTURE.md": "# Component map\nAgent -> LLM"
  })
  const loader = new ProjectMemoryLoader(dir)
  const snap = await loader.load()
  assert.equal(snap.projectGoal?.content, "# North star\nWe build an agent.")
})

test("project with decisions", async () => {
  const dir = await setupFixture("dec", {
    "DECISIONS.md": "# Decision Index\n| [ADR-001](..) | Do X | Accepted |\n| ADR-002 | Do Y | Rejected |"
  })
  const loader = new ProjectMemoryLoader(dir)
  const snap = await loader.load()
  assert.equal(snap.decisions.length, 2)
  assert.equal(snap.decisions[0]!.id, "ADR-001")
  assert.equal(snap.decisions[1]!.id, "ADR-002")
})

test("project with active PLAN", async () => {
  const dir = await setupFixture("plan", {
    "PLAN.md": "## Current milestone\nFinish memory"
  })
  const loader = new ProjectMemoryLoader(dir)
  const snap = await loader.load()
  assert.equal(snap.activeTasks.length, 1)
  assert.equal(snap.activeTasks[0]!.summary, "## Current milestone\nFinish memory")
})

test("recent prior session", async () => {
  const dir = await setupFixture("session", {})
  const storage = new SessionSummaryStorage({ workspaceRoot: dir })
  await storage.append({
    sessionId: "123", mode: "ASK", task: "Say hi", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: []
  })
  const { sessions } = await storage.load()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.task, "Say hi")
})

test("secret-like data not persisted", async () => {
  const dir = await setupFixture("secret", {})
  const storage = new SessionSummaryStorage({ workspaceRoot: dir })
  await storage.append({
    sessionId: "123", mode: "ASK", task: "Use token: secret123", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [],
    verification: "test with password='abc'"
  })
  const { sessions } = await storage.load()
  assert.equal(sessions[0]!.task, "Use token: ***REDACTED***")
  assert.equal(sessions[0]!.verification, "test with password='***REDACTED***'")
})

test("memory retrieval selects tier 0 and recent sessions", async () => {
  const dir = await setupFixture("retrieval", {
    "PROJECT.md": "## North star\nStar\n## Primary constraints\nConst",
    "PLAN.md": "## Current milestone\nTask1"
  })
  const loader = new ProjectMemoryLoader(dir)
  const snap = await loader.load()

  const storage = new SessionSummaryStorage({ workspaceRoot: dir })
  for(let i=0; i<10; i++) {
    await storage.append({
      sessionId: `s${i}`, mode: "BUILD", task: `t${i}`, completedAt: "2026-08-31T00:00:0" + i, outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: []
    })
  }
  const { sessions } = await storage.load()

  const retriever = new MemoryRetriever(snap, sessions)
  const selection = retriever.select({ task: "do it", mode: "BUILD", tokenBudget: 500 }) // mode overlaps so score > 0

  assert.equal(selection.projectFacts.length, 2)
  assert.equal(selection.activeTasks.length, 1)
  assert.ok(selection.sessionSummaries.length <= 5, "Should bound session summaries")
  assert.equal(selection.sessionSummaries[0]!.sessionId, "s9", "Should pick most recent")
})

test("memory retrieval deduplicates facts", async () => {
  const dir = await setupFixture("dedup", {
    "PROJECT.md": "# North star\nNode 22",
    "ARCHITECTURE.md": "# Component map\nNode 22"
  })
  const loader = new ProjectMemoryLoader(dir)
  const snap = await loader.load()
  const retriever = new MemoryRetriever(snap, [])
  const selection = retriever.select({ task: "do it", mode: "BUILD", tokenBudget: 500 })
  assert.equal(selection.projectFacts.length, 1)
  assert.equal(selection.duplicatesDropped, 1)
})

test("corrupt session memory ignores bad lines", async () => {
  const dir = await setupFixture("corrupt", {})
  const storagePath = join(dir, ".open-vs-code", "sessions.jsonl")
  await mkdir(join(dir, ".open-vs-code"), { recursive: true })
  await writeFile(storagePath, `{"sessionId": "1", "task": "a"}\n{bad json}\n{"sessionId": "2", "task": "b"}`, "utf8")
  const storage = new SessionSummaryStorage({ workspaceRoot: dir })
  const { sessions } = await storage.load()
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0]!.sessionId, "1")
  assert.equal(sessions[1]!.sessionId, "2")
})

test("session relevance favors overlap", async () => {
  const dir = await setupFixture("relevance", {})
  const storage = new SessionSummaryStorage({ workspaceRoot: dir })
  await storage.append({ sessionId: "1", mode: "BUILD", task: "fix UI button", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  await storage.append({ sessionId: "2", mode: "DEBUG", task: "debug parser config", outcome: "FAILED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  const { sessions } = await storage.load()

  const retriever = new MemoryRetriever({ decisions: [], activeTasks: [], knownIssues: [] }, sessions)
  const selection = retriever.select({ task: "fix parser config values", mode: "BUILD", tokenBudget: 500 })
  assert.equal(selection.sessionSummaries.length, 2)
  assert.equal(selection.sessionSummaries[0]!.sessionId, "2")
})



import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"

test("SessionSummaryStorage atomic write failure leaves existing intact (T-584)", async () => {
  const ws = path.join(os.tmpdir(), "test-atomic-" + Date.now())
  await fs.mkdir(ws, { recursive: true })

  const storage = new SessionSummaryStorage({ workspaceRoot: ws })
  await storage.append({ sessionId: "1", task: "initial", mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })

  // mock rename to fail
  const originalRename = fs.rename
  let failed = false
  try {
    fs.rename = async () => { throw new Error("Disk full") }
    await storage.append({ sessionId: "2", task: "should fail", mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  } catch {
    failed = true
  } finally {
    fs.rename = originalRename
  }

  assert.equal(failed, true)
  const { sessions } = await storage.load()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.task, "initial")
})

test("SessionSummaryStorage enforces per-session limit (T-587)", async () => {
  const ws = path.join(os.tmpdir(), "test-limit-" + Date.now())
  const storage = new SessionSummaryStorage({ workspaceRoot: ws, maxSessionBytes: 500 })

  const hugeText = "A".repeat(1000)
  await storage.append({
    sessionId: "1",
    task: "do " + hugeText,
    nextAction: "action " + hugeText,
    verification: "verify " + hugeText,
    mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: []
  })

  const { sessions } = await storage.load()
  assert.equal(sessions.length, 1)
  const s = sessions[0]!
  assert.ok(s.task.length < 500)
  assert.ok(s.task.endsWith("..."))
})

test("SessionSummaryStorage fails closed on corruption (T-573)", async () => {
  const ws = path.join(os.tmpdir(), "test-corrupt-" + Date.now())
  await fs.mkdir(path.join(ws, ".open-vs-code"), { recursive: true })
  await fs.writeFile(path.join(ws, ".open-vs-code", "sessions.jsonl"), '{"valid":true}\nCORRUPT\n{"valid2":true}\n')

  const storage = new SessionSummaryStorage({ workspaceRoot: ws })
  const loadRes = await storage.load()
  assert.equal(loadRes.hasCorruption, true)
  assert.equal(loadRes.corruptEntries, 1)
  assert.equal(loadRes.sessions.length, 2)

  let appendFailed = false
  try {
    await storage.append({ sessionId: "1", task: "x", mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  } catch(e: any) {
    if (e.message.includes("MEMORY_CORRUPT")) {
       appendFailed = true
    }
  }
  assert.equal(appendFailed, true)
})

test("SessionSummaryStorage enforces total storage limit (T-571)", async () => {
  const ws = path.join(os.tmpdir(), "test-total-" + Date.now())
  const storage = new SessionSummaryStorage({ workspaceRoot: ws, maxTotalStorageBytes: 1000 })

  for (let i = 0; i < 20; i++) {
    await storage.append({ sessionId: String(i), task: "Task " + "B".repeat(100), mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  }

  const { sessions } = await storage.load()
  assert.ok(sessions.length > 0)
  assert.ok(sessions.length < 20)
  // verify oldest are gone
  assert.equal(sessions[0]!.sessionId, String(19 - sessions.length + 1))
})

