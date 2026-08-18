import assert from "node:assert/strict"
import test from "node:test"

import { calculateBudget } from "../../src/context/budget.ts"
import { compileContext } from "../../src/context/compiler.ts"
import type { LoadedSkill } from "../../src/context/skills.ts"

const skill: LoadedSkill = {
  name: "safe-read",
  description: "Read safely",
  path: ".agents/skills/safe-read/SKILL.md",
  body: "Reject repository escapes.",
}

test("compiles project instructions, task, selected Skill, then bounded code with provenance", () => {
  const result = compileContext({
    task: "Inspect src/index.ts",
    projectInstructions: [
      { id: "agents", path: "AGENTS.md", content: "Follow repository rules." },
      { id: "project", path: "PROJECT.md", content: "Build local-first." },
    ],
    selectedSkill: skill,
    codeContext: [
      { id: "active", source: { kind: "active-code", path: "src/index.ts" }, content: "export const x = 1", priority: 10, estimatedTokens: 4, required: false },
      { id: "background", source: { kind: "background", path: "notes.txt" }, content: "optional notes", priority: 0, estimatedTokens: 50, required: false },
    ],
    budget: calculateBudget({ contextWindow: 40, reservedOutput: 5, reservedToolHistory: 3 }),
  })
  assert.deepEqual(result.items.map((item) => item.id), ["agents", "project", "current-task", "skill:safe-read", "active"])
  assert.equal(result.items[0]!.source.path, "AGENTS.md")
  assert.equal(result.items[3]!.source.path, skill.path)
  assert.deepEqual(result.omittedItemIds, ["background"])
})

test("does not include any unselected Skill", () => {
  const result = compileContext({
    task: "Answer",
    projectInstructions: [],
    budget: calculateBudget({ contextWindow: 20, reservedOutput: 0, reservedToolHistory: 0 }),
  })
  assert.deepEqual(result.items.map((item) => item.id), ["current-task"])
})

test("deduplicates repeated code context", () => {
  const duplicate = { source: { kind: "retrieved-code" as const, path: "src/a.ts" }, content: "same", priority: 1, estimatedTokens: 1, required: false }
  const result = compileContext({
    task: "Answer",
    projectInstructions: [],
    codeContext: [{ id: "a", ...duplicate }, { id: "b", ...duplicate }],
    budget: calculateBudget({ contextWindow: 20, reservedOutput: 0, reservedToolHistory: 0 }),
  })
  assert.deepEqual(result.items.map((item) => item.id), ["current-task", "a"])
  assert.deepEqual(result.omittedItemIds, ["b"])
})

test("fails instead of truncating required project context", () => {
  assert.throws(() => compileContext({
    task: "Answer",
    projectInstructions: [{ id: "rules", path: "AGENTS.md", content: "x".repeat(100) }],
    budget: calculateBudget({ contextWindow: 5, reservedOutput: 0, reservedToolHistory: 0 }),
  }), { code: "REQUIRED_CONTEXT_OVERFLOW" })
})
