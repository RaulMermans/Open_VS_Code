import { calculateBudget } from "../../src/context/budget.ts";

import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { compileContext } from "../../src/context/compiler.ts"
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

test("T-629: full redaction regression matrix", async () => {
  const dir = await setupFixture("secret-matrix", {})
  const storage = new SessionSummaryStorage({ workspaceRoot: dir })
  await storage.append({
    sessionId: "123", mode: "ASK", 
    task: "Use token: secret123 and Authorization: Bearer BIG_SECRET", 
    outcome: "COMPLETED", changedFiles: [], 
    decisions: ["chose AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "authorization: basic abc123def"], 
    unresolvedIssues: ["password=xyz", "Bearer anothersecret"],
    nextAction: "Try api_key='sk-123'",
    verification: "test with secret = 'abc'"
  })
  const { sessions } = await storage.load()
  const s = sessions[0]!
  
  // T-628: Verify 'Authorization: Bearer' doesn't leak tail
  assert.equal(s.task, "Use token: ***REDACTED*** and Authorization: ***REDACTED***")
  
  assert.equal(s.decisions[0], "chose AWS_ACCESS_KEY_ID=***REDACTED***")
  assert.equal(s.decisions[1], "authorization: ***REDACTED***")
  
  assert.equal(s.unresolvedIssues[0], "password=***REDACTED***")
  assert.equal(s.unresolvedIssues[1], "Bearer ***REDACTED***")
  
  assert.equal(s.nextAction, "Try api_key='***REDACTED***'")
  assert.equal(s.verification, "test with secret = '***REDACTED***'")
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
  await writeFile(storagePath, `{"sessionId": "1", "mode": "ASK", "task": "a", "outcome": "COMPLETED", "changedFiles": []}\n{bad json}\n{"sessionId": "2", "mode": "ASK", "task": "b", "outcome": "COMPLETED", "changedFiles": []}`, "utf8")
  const storage = new SessionSummaryStorage({ workspaceRoot: dir })
  const { sessions, corruptEntries } = await storage.load()
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0]!.sessionId, "1")
  assert.equal(sessions[1]!.sessionId, "2")
  assert.equal(corruptEntries, 1)
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

  // Make the directory read-only to force a failure
  const dirPath = path.join(ws, ".open-vs-code")
  await fs.chmod(dirPath, 0o555)

  let appendRes = "UNKNOWN"
  try {
    appendRes = await storage.append({ sessionId: "2", task: "should fail", mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  } finally {
    // Restore permissions
    await fs.chmod(dirPath, 0o777)
  }

  assert.equal(appendRes, "FAILED")
  const { sessions } = await storage.load()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.task, "initial")
})

test("SessionSummaryStorage enforces per-session limit (T-587)", async () => {
  const ws = path.join(os.tmpdir(), "test-limit-" + Date.now())
  await fs.mkdir(ws, { recursive: true })
  const storage = new SessionSummaryStorage({ workspaceRoot: ws, maxSessionBytes: 500 })

  const hugeText = "A".repeat(1000)
  const appendRes = await storage.append({
    sessionId: "1",
    task: "do " + hugeText,
    nextAction: "action " + hugeText,
    verification: "verify " + hugeText,
    mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: []
  })

  assert.equal(appendRes, "REJECTED_OVERSIZED")
  const { sessions } = await storage.load()
  assert.equal(sessions.length, 0)
})

test("SessionSummaryStorage fails closed on corruption (T-573)", async () => {
  const ws = path.join(os.tmpdir(), "test-corrupt-" + Date.now())
  await fs.mkdir(path.join(ws, ".open-vs-code"), { recursive: true })
  await fs.writeFile(path.join(ws, ".open-vs-code", "sessions.jsonl"), '{"valid":true}\nCORRUPT\n{"valid2":true}\n')

  const storage = new SessionSummaryStorage({ workspaceRoot: ws })
  const loadRes = await storage.load()
  assert.equal(loadRes.hasCorruption, true)
  assert.equal(loadRes.corruptEntries, 3)
  assert.equal(loadRes.sessions.length, 0) // because we check valid schema now

  const appendRes = await storage.append({ sessionId: "1", task: "x", mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  assert.equal(appendRes, "SKIPPED_CORRUPT_STATE")
})

test("SessionSummaryStorage enforces total storage limit (T-571)", async () => {
  const ws = path.join(os.tmpdir(), "test-total-" + Date.now())
  await fs.mkdir(ws, { recursive: true })
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


test("SessionSummaryStorage blocks path traversal outside workspace (T-621)", async () => {
  const ws = path.join(os.tmpdir(), "test-path-" + Date.now())
  await fs.mkdir(ws, { recursive: true })

  // Create a storage that tries to point outside workspace via symlink or sibling
  // But wait, SessionSummaryStorage constructor takes `workspaceRoot` and forces path inside.
  // It forces `this.path = join(options.workspaceRoot, ".open-vs-code", "sessions.jsonl")`
  // We can't actually pass a bad path directly to the constructor since it doesn't take one.
  // BUT what if the workspaceRoot contains something tricky, or .open-vs-code is a symlink pointing outside?

  const extPath = path.join(os.tmpdir(), "test-path-ext-" + Date.now())
  await fs.mkdir(extPath, { recursive: true })
  await fs.symlink(extPath, path.join(ws, ".open-vs-code"))

  const storage = new SessionSummaryStorage({ workspaceRoot: ws })
  const res = await storage.append({ sessionId: "1", task: "x", mode: "ASK", outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  assert.equal(res, "FAILED")
})

test("T-632: schema-invalid JSON matrix and compileContext safety", async () => {
  const ws = path.join(os.tmpdir(), "test-schema-matrix-" + Date.now())
  await fs.mkdir(path.join(ws, ".open-vs-code"), { recursive: true })

  // Write all test cases for T-632 and T-634
  await fs.writeFile(
    path.join(ws, ".open-vs-code", "sessions.jsonl"),
    `{"valid":true}
{}
[]
null
{"task":"x"}
{"sessionId":12}
{"sessionId":"x","mode":"ASK","task":"x","outcome":"COMPLETED","changedFiles":"not-array"}
{"sessionId":"x","mode":"ASK","task":"x","outcome":"COMPLETED","changedFiles":[]}
{"sessionId":"y","mode":"ASK","task":"y","outcome":"COMPLETED","changedFiles":[],"decisions":"not-array"}
{"sessionId":"z","mode":"ASK","task":"z","outcome":"COMPLETED","changedFiles":[],"unresolvedIssues":"not-array"}
{"sessionId":"legacy","mode":"ASK","task":"l","outcome":"COMPLETED","changedFiles":[]}
{"sessionId":"complete","mode":"ASK","task":"c","outcome":"COMPLETED","changedFiles":[],"decisions":["d1"],"unresolvedIssues":["u1"]}
`, "utf8")

  const storage = new SessionSummaryStorage({ workspaceRoot: ws })
  const loadRes = await storage.load()
  
  // We expect:
  // 3 valid/normalized sessions: "x" (gets normalized), "legacy" (gets normalized), "complete" (is complete)
  // 9 invalid/corrupt entries
  assert.equal(loadRes.corruptEntries, 9)
  assert.equal(loadRes.sessions.length, 3)

  assert.equal(loadRes.sessions[0]!.sessionId, "x")
  assert.deepEqual(loadRes.sessions[0]!.decisions, [])
  assert.deepEqual(loadRes.sessions[0]!.unresolvedIssues, [])

  assert.equal(loadRes.sessions[1]!.sessionId, "legacy")
  assert.deepEqual(loadRes.sessions[1]!.decisions, [])
  assert.deepEqual(loadRes.sessions[1]!.unresolvedIssues, [])

  assert.equal(loadRes.sessions[2]!.sessionId, "complete")
  assert.deepEqual(loadRes.sessions[2]!.decisions, ["d1"])
  assert.deepEqual(loadRes.sessions[2]!.unresolvedIssues, ["u1"])

  // T-634: compileContext safety
  // If we pass these to compileContext, it should not crash
  const snap = {
    decisions: [], activeTasks: [], knownIssues: []
  }
  const retriever = new MemoryRetriever(snap, loadRes.sessions)
  const memory = retriever.select({ task: "do it", mode: "ASK", tokenBudget: 5000 })
  
  const required = compileContext({
    task: "do it",
    projectInstructions: [],
    memory,
    budget: calculateBudget({ contextWindow: 10000, reservedOutput: 1000, reservedToolHistory: 1000 })
  }).items

  const hist = required.filter((r: any) => r.source.kind === "historical-session")
  assert.equal(hist.length, 3)
})

test("Large corpus bounds selected memory (T-622)", async () => {
  const ws = path.join(os.tmpdir(), "test-large-" + Date.now())

  const content = "A".repeat(1000)
  const hugeMd = `# North star\n${content}\n# Component map\n${content}\n# Tech stack\n${content}\n`
  const files: Record<string, string> = {
    "PROJECT.md": hugeMd,
    "ARCHITECTURE.md": hugeMd,
    "DECISIONS.md": hugeMd,
    "PLAN.md": hugeMd,
    "SCRATCHPAD.md": hugeMd,
    "AGENTS.md": hugeMd
  }

  await fs.mkdir(ws, { recursive: true })
  for (const [k, v] of Object.entries(files)) {
    await fs.writeFile(path.join(ws, k), v, "utf8")
  }

  const loader = new ProjectMemoryLoader(ws)
  const snap = await loader.load()

  const storage = new SessionSummaryStorage({ workspaceRoot: ws })
  for(let i=0; i<50; i++) {
    await storage.append({ sessionId: String(i), mode: "BUILD", task: "huge " + i, outcome: "COMPLETED", changedFiles: [], decisions: [], unresolvedIssues: [] })
  }
  const { sessions } = await storage.load()

  const retriever = new MemoryRetriever(snap, sessions)
  const selection = retriever.select({ task: "do it", mode: "BUILD", tokenBudget: 2000 })

  assert.ok(selection.estimatedTokens <= 2000)
  assert.ok(selection.documentsSelected <= 6)
  assert.ok(selection.sessionSummariesSelected <= 5)
})
