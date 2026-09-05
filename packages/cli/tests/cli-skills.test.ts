import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import { runCLI } from "../src/app.ts"
import { ScriptedModelProvider } from "@open-vs-code/agent-core"
import url from "node:url"
import { cp } from "node:fs/promises"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const REAL_ROOT = path.resolve(__dirname, "../../..")
const FIXTURES_DIR = path.resolve(__dirname, "../tests/fixtures")

async function setupWorkspace(name: string) {
  const ws = path.join(FIXTURES_DIR, name)
  await fs.rm(ws, { recursive: true, force: true })
  await fs.mkdir(ws, { recursive: true })
  await cp(path.join(REAL_ROOT, ".agents"), path.join(ws, ".agents"), { recursive: true })
  return ws
}

test("T-734: DIRECT CLI SKILL E2E: DEBUG", async () => {
  const ws = await setupWorkspace("e2e-skill-debug")
  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "Done" } }
  ])

  const result = await runCLI({
    mode: "DEBUG",
    instruction: "Fix the parser crash when config is null",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "APPROVE"
  }) as any;

  assert.equal(result.exitCode, 0)
  assert.equal(result.skillDiagnostics.primarySkill, "BUG_TRIAGE_LOOP")
  assert.ok(result.skillDiagnostics.loadedSections.length > 0)
})

test("T-735: DIRECT CLI SKILL E2E: BUILD", async () => {
  const ws = await setupWorkspace("e2e-skill-build")
  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "Done" } }
  ])

  const result = await runCLI({
    mode: "BUILD",
    instruction: "Add CSV export with regression tests",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "APPROVE"
  }) as any;

  assert.equal(result.exitCode, 0)
  assert.equal(result.skillDiagnostics.primarySkill, "ADD_FEATURE_WITH_TESTS")
  assert.ok(result.skillDiagnostics.loadedSections.length > 0)
})

test("T-736: DIRECT CLI SKILL E2E: REVIEW", async () => {
  const ws = await setupWorkspace("e2e-skill-review")
  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "Done" } }
  ])

  const result = await runCLI({
    mode: "REVIEW",
    instruction: "Review path handling for traversal and secret leakage",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "APPROVE"
  }) as any;

  assert.equal(result.exitCode, 0)
  assert.equal(result.skillDiagnostics.primarySkill, "SECURITY_HARDENING_PASS")
  assert.ok(result.skillDiagnostics.loadedSections.length > 0)
})

test("T-737: DIRECT CLI NO-SKILL E2E", async () => {
  const ws = await setupWorkspace("e2e-skill-none")
  const provider = new ScriptedModelProvider([
    { model: "scripted", message: { role: "assistant", content: "Done" } }
  ])

  const result = await runCLI({
    mode: "BUILD",
    instruction: "Rename local variable idx to index",
    workspaceRoot: ws,
    json: true,
    provider,
    mockApproval: "APPROVE"
  }) as any;

  assert.equal(result.exitCode, 0)
  assert.equal(result.skillDiagnostics.primarySkill, undefined)
  assert.equal(result.skillDiagnostics.actualCompiledSkillTokens, 0)
  assert.equal(result.skillDiagnostics.skillsSelected, 0)
})
