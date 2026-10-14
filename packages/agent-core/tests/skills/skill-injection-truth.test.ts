import assert from "node:assert/strict"
import { test } from "node:test"

import { createAgentRuntime } from "../../src/agent/runtime.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { compileContext } from "../../src/context/compiler.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import type { SkillEvidence, SkillGuidance } from "../../src/skills/contracts.ts"
import { SkillInjectionTracker, isSkillApplied } from "../../src/skills/runtime.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { tempDir } from "./helpers.ts"

// Sprint 5A closure: SELECTED → LOADED → INJECTED. A skill is "applied" only if the final compiled
// context that reached the model actually carried its guidance.

const final: ModelResponse = { message: { role: "assistant", content: "Done" }, model: "test", usage: { inputTokens: 1, outputTokens: 1 } }
const TASK = "The parser crash needs a fix"

async function run(instruction: string, skills?: { enabled: boolean; builtinRoot?: string }) {
  const workspaceRoot = await tempDir("injection")
  const provider = new ScriptedModelProvider([final])
  const runtime = await createAgentRuntime({ workspaceRoot, mode: "DEBUG", instruction, eventSink: () => {}, isTrusted: true, providerOverride: provider, ...(skills ? { skills } : {}) })
  const before = runtime.skillEvidence
  const result = await runtime.runner.run(runtime.runnerInput as never)
  await runtime.cleanup()
  return { before, after: runtime.skillEvidence, result, prompt: String(provider.requests[0]?.messages[0]?.content ?? "") }
}

test("5A-INJ-1: a skill that reaches the model request is reported INJECTED with final-context tokens", async () => {
  const { before, after, result, prompt } = await run(TASK, { enabled: true })
  assert.equal(result.status, "COMPLETED")
  assert.equal(before.injectionStatus, "PENDING", "not yet injected before any request is compiled")
  assert.equal(isSkillApplied(before), false)
  assert.equal(after.selectedSkill, "bug-triage")
  assert.equal(after.skillLoadStatus, "LOADED")
  assert.equal(after.injectionStatus, "INJECTED")
  assert.deepEqual(after.injectedSkills, ["bug-triage"])
  assert.deepEqual(after.omittedSkills, [])
  assert.equal(after.injectedSkillTokens, after.skillContextTokens)
  assert.equal(after.compiledRequests, 1)
  assert.equal(after.requestsWithSkill, 1)
  assert.ok(prompt.includes("[Skill: bug-triage v1 · built-in]"))
  assert.equal(isSkillApplied(after), true)
})

test("5A-INJ-2: preliminary skill budget passes but final compile drops the skill → OMITTED_BY_FINAL_BUDGET, never applied", async () => {
  const probe = await run(TASK, { enabled: true })
  const skillTokens = probe.after.skillContextTokens
  assert.ok(skillTokens > 0)
  // Leave exactly enough headroom for the skill in the preliminary (pre-compile) budget. The runner's
  // own required operating guidance is not part of that reservation, so the final compile must drop it.
  const available = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 }).availableContext
  const instruction = TASK + " ".repeat((available - skillTokens) * 4 - TASK.length)

  const { after, result, prompt } = await run(instruction, { enabled: true })
  assert.equal(result.status, "COMPLETED")
  assert.equal(after.selectedSkill, "bug-triage", "selected")
  assert.equal(after.skillLoadStatus, "LOADED", "loaded and fitted by the preliminary budget")
  assert.equal(after.injectionStatus, "OMITTED_BY_FINAL_BUDGET", "but never injected")
  assert.deepEqual(after.injectedSkills, [])
  assert.deepEqual(after.omittedSkills, ["bug-triage"])
  assert.equal(after.injectedSkillTokens, 0)
  assert.equal(after.requestsWithSkill, 0)
  assert.ok(!prompt.includes("[Skill:"), "the model never received the skill")
  assert.equal(isSkillApplied(after), false)
})

test("5A-INJ-3: zero skills and disabled skills remain valid NOT_APPLICABLE states", async () => {
  const emptyBuiltins = await tempDir("injection-empty")
  const zero = await run(TASK, { enabled: true, builtinRoot: emptyBuiltins })
  assert.equal(zero.result.status, "COMPLETED")
  assert.equal(zero.after.skillLoadStatus, "NO_SKILL_SELECTED")
  assert.equal(zero.after.injectionStatus, "NOT_APPLICABLE")
  assert.deepEqual(zero.after.injectedSkills, [])

  const disabled = await run(TASK)
  assert.equal(disabled.after.skillLoadStatus, "DISABLED")
  assert.equal(disabled.after.injectionStatus, "NOT_APPLICABLE")
  assert.equal(isSkillApplied(disabled.after), false)
})

test("5A-INJ-4: a skill kept in some requests and dropped from others is PARTIALLY_INJECTED with last-request tokens", () => {
  const guidance: SkillGuidance = { id: "tdd", version: 1, source: "builtin", sections: ["Intent"], content: "g".repeat(400), estimatedTokens: 100 }
  const prepared = { selectedSkill: "tdd", injectionStatus: "PENDING", injectedSkills: [], omittedSkills: [] } as unknown as SkillEvidence
  const tracker = new SkillInjectionTracker(prepared, [guidance])
  const roomy = calculateBudget({ contextWindow: 1000, reservedOutput: 0, reservedToolHistory: 0 })
  const tight = calculateBudget({ contextWindow: 60, reservedOutput: 0, reservedToolHistory: 0 })
  tracker.observe(compileContext({ task: "write a test", projectInstructions: [], skillGuidance: [guidance], budget: roomy }))
  assert.equal(tracker.evidence.injectionStatus, "INJECTED")
  assert.equal(tracker.evidence.injectedSkillTokens, 100)
  tracker.observe(compileContext({ task: "write a test", projectInstructions: [], skillGuidance: [guidance], budget: tight }))
  const evidence = tracker.evidence
  assert.equal(evidence.injectionStatus, "PARTIALLY_INJECTED")
  assert.deepEqual(evidence.injectedSkills, ["tdd"])
  assert.deepEqual(evidence.omittedSkills, ["tdd"])
  assert.equal(evidence.injectedSkillTokens, 0, "the final request carried no skill tokens")
  assert.equal(evidence.compiledRequests, 2)
  assert.equal(evidence.requestsWithSkill, 1)
})
