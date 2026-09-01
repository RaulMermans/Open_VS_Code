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
  const sessions = await storage.load()
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
  const sessions = await storage.load()
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
      sessionId: `s${i}`, mode: "ASK", task: `t${i}`, completedAt: "2026-08-31T00:00:0" + i, outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: []
    })
  }
  const sessions = await storage.load()
  
  const retriever = new MemoryRetriever(snap, sessions)
  const selection = retriever.select({ task: "do it", mode: "BUILD", tokenBudget: 500 })
  
  assert.equal(selection.projectFacts.length, 2)
  assert.equal(selection.activeTasks.length, 1)
  assert.ok(selection.sessionSummaries.length <= 5, "Should bound session summaries")
  assert.equal(selection.sessionSummaries[0]!.sessionId, "s9", "Should pick most recent")
})
