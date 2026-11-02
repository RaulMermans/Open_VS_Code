import assert from "node:assert/strict"
import { test } from "node:test"

import { compileContext } from "../../src/context/compiler.ts"
import { estimateTokens } from "../../src/context/budget.ts"
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../../src/skills/registry.ts"
import { DEFAULT_SKILL_BUDGET_FRACTION, fitSkillGuidance, prepareSkillGuidance, renderSkillIndex } from "../../src/skills/runtime.ts"
import { selectSkill } from "../../src/skills/selector.ts"
import { SKILL_CORE_SECTION_COUNT, SKILL_SECTION_PRIORITY } from "../../src/skills/contracts.ts"
import { loadBuiltinRegistry, runEfficiencyBenchmark, runSelectionEval } from "../evals/skill-eval.ts"
import { BUDGET, FULL_TOOLS, READONLY_TOOLS, countingFileSystem, skillDocument, tempDir, writeSkill } from "./helpers.ts"

async function builtins(fs = countingFileSystem()) {
  return { fs, registry: await SkillRegistry.discover({ builtinRoot: defaultBuiltinSkillsRoot()!, workspaceTrusted: true, fs }) }
}

test("5A-09: only the selected skill body is read and enters context", async () => {
  const { fs, registry } = await builtins()
  const prepared = await prepareSkillGuidance({ enabled: true, registry, task: "The app crashes on startup", mode: "DEBUG", availableTools: FULL_TOOLS, budget: BUDGET })
  assert.deepEqual(prepared.guidance.map((item) => item.id), ["bug-triage"])
  assert.equal(fs.bodyReads.length, 1)
  assert.ok(fs.bodyReads[0]!.includes("bug-triage"))

  const compiled = compileContext({ task: "The app crashes on startup", projectInstructions: [], skillGuidance: prepared.guidance, budget: BUDGET })
  const skillItems = compiled.items.filter((item) => item.source.kind === "skill")
  assert.deepEqual(skillItems.map((item) => item.id), ["skill:bug-triage"])
  const rendered = compiled.items.map((item) => item.content).join("\n")
  for (const other of ["Restructure code in small", "RED, then GREEN", "injection: input concatenated", "READY, NOT READY"]) {
    assert.ok(!rendered.includes(other), `unselected skill text leaked: ${other}`)
  }
  assert.ok(!rendered.includes("context_budget:") && !rendered.includes("allowed_modes:"), "frontmatter is never injected")
})

test("5A-10: a mode-incompatible skill is rejected", async () => {
  const { registry } = await builtins()
  const selection = selectSkill({ task: "Refactor the payment service", mode: "REVIEW", entries: registry.entries, availableTools: FULL_TOOLS })
  assert.deepEqual(selection.selected, [])
  assert.equal(selection.candidates.find((candidate) => candidate.id === "refactor-with-guards")?.reason, "MODE_INCOMPATIBLE")
})

test("5A-11: a missing required tool rejects selection", async () => {
  const { registry } = await builtins()
  const selection = selectSkill({ task: "Add pagination using tests first", mode: "BUILD", entries: registry.entries, availableTools: READONLY_TOOLS })
  assert.deepEqual(selection.selected, [])
  assert.equal(selection.candidates.find((candidate) => candidate.id === "tdd")?.reason, "MISSING_REQUIRED_TOOL")
})

test("5A-12: context-budget overflow fails safely and degrades by whole sections only", async () => {
  const { registry } = await builtins()
  const loaded = await registry.loadBody("bug-triage")
  const full = fitSkillGuidance(loaded, Number.MAX_SAFE_INTEGER)
  assert.equal(full.partial, false)

  const partial = fitSkillGuidance(loaded, full.guidance!.estimatedTokens - 40)
  assert.equal(partial.partial, true)
  assert.ok(partial.guidance!.estimatedTokens <= full.guidance!.estimatedTokens - 40)
  for (const core of SKILL_SECTION_PRIORITY.slice(0, SKILL_CORE_SECTION_COUNT)) assert.ok(partial.guidance!.sections.includes(core), `core section ${core} kept`)
  assert.ok(!partial.guidance!.sections.includes("Inputs"), "lowest-priority section dropped first")

  assert.equal(fitSkillGuidance(loaded, 60).guidance, undefined, "core that cannot fit is not injected at all")

  const tight = await prepareSkillGuidance({
    enabled: true, registry, task: "The app crashes on startup", mode: "DEBUG", availableTools: FULL_TOOLS,
    budget: { contextWindow: 1200, reservedOutput: 400, reservedToolHistory: 200, availableContext: 600 },
  })
  assert.equal(tight.evidence.skillLoadStatus, "FAILED_BUDGET")
  assert.deepEqual(tight.guidance, [])
  assert.equal(tight.evidence.skillContextTokens, 0)
  assert.equal(tight.evidence.selectedSkill, "bug-triage", "the attempted skill stays observable")

  const crowded = await prepareSkillGuidance({ enabled: true, registry, task: "The app crashes on startup", mode: "DEBUG", availableTools: FULL_TOOLS, budget: BUDGET, reservedTokens: BUDGET.availableContext - 10 })
  assert.equal(crowded.evidence.skillLoadStatus, "FAILED_BUDGET", "required context already claimed the budget")
})

test("5A-12b: skill guidance is optional context that never displaces required items or active code", () => {
  const guidance = [{ id: "bug-triage", version: 1, source: "builtin" as const, sections: ["Intent"], content: "g".repeat(2000), estimatedTokens: 500 }]
  const instructions = [{ id: "security", path: "SECURITY.md", content: "s".repeat(1600) }]
  const budget = { contextWindow: 1200, reservedOutput: 0, reservedToolHistory: 0, availableContext: 1000 }
  const active = [{ id: "active", source: { kind: "active-code" as const }, content: "a".repeat(1200), priority: 1, estimatedTokens: 300, required: false }]
  const compiled = compileContext({ task: "Fix the crash", projectInstructions: instructions, skillGuidance: guidance, codeContext: active, budget })
  const ids = compiled.items.map((item) => item.id)
  assert.ok(ids.includes("security") && ids.includes("current-task") && ids.includes("active"))
  assert.ok(!ids.includes("skill:bug-triage"))
  assert.ok(compiled.omittedItemIds.includes("skill:bug-triage"))

  const roomy = compileContext({ task: "Fix the crash", projectInstructions: [], skillGuidance: guidance, budget: BUDGET })
  assert.deepEqual(roomy.items.map((item) => item.id), ["current-task", "skill:bug-triage"])
  assert.equal(roomy.items[1]!.required, false)
})

test("5A-13: one selected skill fits the expected token budget", async () => {
  const { registry } = await builtins()
  for (const [task, mode] of [["The app crashes on startup", "DEBUG"], ["Add pagination using tests first", "BUILD"], ["Clean up this module without changing behavior", "BUILD"], ["Review this auth diff for vulnerabilities", "REVIEW"], ["Check whether this change is ready", "REVIEW"]] as const) {
    const prepared = await prepareSkillGuidance({ enabled: true, registry, task, mode, availableTools: FULL_TOOLS, budget: BUDGET })
    const [guidance] = prepared.guidance
    assert.ok(guidance, `${task} selects a skill`)
    assert.equal(prepared.evidence.skillLoadStatus, "LOADED")
    assert.ok(guidance.estimatedTokens <= registry.get(guidance.id)!.contextBudget)
    assert.ok(guidance.estimatedTokens <= Math.floor(BUDGET.availableContext * DEFAULT_SKILL_BUDGET_FRACTION))
    assert.equal(guidance.estimatedTokens, estimateTokens(guidance.content))
  }
})

test("5A-14: at most one skill by default and never more than two, only via composes_with", async () => {
  const root = await tempDir("compose")
  const triggers = ["widget crash"]
  await writeSkill(root, "alpha-skill", skillDocument({ id: "alpha-skill", triggers: [...triggers, "alpha"], composes_with: ["beta-skill", "gamma-skill"] }))
  await writeSkill(root, "beta-skill", skillDocument({ id: "beta-skill", triggers }))
  await writeSkill(root, "gamma-skill", skillDocument({ id: "gamma-skill", triggers }))
  await writeSkill(root, "delta-skill", skillDocument({ id: "delta-skill", triggers }))
  const registry = await SkillRegistry.discover({ builtinRoot: root, workspaceTrusted: true })
  const task = "alpha widget crash"
  const select = (maxSkills?: number) => selectSkill({ task, mode: "DEBUG", entries: registry.entries, availableTools: FULL_TOOLS, ...(maxSkills === undefined ? {} : { maxSkills }) }).selected.map((entry) => entry.id)

  assert.deepEqual(select(), ["alpha-skill"])
  assert.deepEqual(select(2), ["alpha-skill", "beta-skill"])
  assert.deepEqual(select(50), ["alpha-skill", "beta-skill"], "hard cap of two")
  assert.deepEqual(select(0), [])

  const noRule = await tempDir("no-rule")
  await writeSkill(noRule, "alpha-skill", skillDocument({ id: "alpha-skill", triggers: [...triggers, "alpha"] }))
  await writeSkill(noRule, "beta-skill", skillDocument({ id: "beta-skill", triggers }))
  const plain = await SkillRegistry.discover({ builtinRoot: noRule, workspaceTrusted: true })
  assert.deepEqual(selectSkill({ task, mode: "DEBUG", entries: plain.entries, availableTools: FULL_TOOLS, maxSkills: 2 }).selected.map((entry) => entry.id), ["alpha-skill"])

  const prepared = await prepareSkillGuidance({ enabled: true, registry, task, mode: "DEBUG", availableTools: FULL_TOOLS, budget: BUDGET, maxSkills: 9 })
  assert.equal(prepared.guidance.length, 2)
})

test("5A: no skill is a first-class outcome for weak or ambiguous matches", async () => {
  const { registry, fs } = await builtins()
  for (const [task, mode] of [["What does parseConfig return?", "ASK"], ["Rename the local variable idx to index", "BUILD"], ["Review this PR", "REVIEW"]] as const) {
    const prepared = await prepareSkillGuidance({ enabled: true, registry, task, mode, availableTools: FULL_TOOLS, budget: BUDGET })
    assert.equal(prepared.evidence.skillLoadStatus, "NO_SKILL_SELECTED")
    assert.deepEqual(prepared.guidance, [])
  }
  assert.deepEqual(fs.bodyReads, [], "no body read when no skill is selected")

  const root = await tempDir("tie")
  await writeSkill(root, "alpha-skill", skillDocument({ id: "alpha-skill", triggers: ["widget crash"] }))
  await writeSkill(root, "beta-skill", skillDocument({ id: "beta-skill", triggers: ["widget crash"] }))
  const tie = await SkillRegistry.discover({ builtinRoot: root, workspaceTrusted: true })
  const selection = selectSkill({ task: "widget crash", mode: "DEBUG", entries: tie.entries, availableTools: FULL_TOOLS })
  assert.deepEqual(selection.selected, [])
  assert.ok(selection.candidates.every((candidate) => candidate.reason === "AMBIGUOUS"))
})

test("5A: an explicit skill:<id> request selects a compatible skill and never an incompatible one", async () => {
  const { registry } = await builtins()
  assert.deepEqual(selectSkill({ task: "skill:verification look around", mode: "REVIEW", entries: registry.entries, availableTools: FULL_TOOLS }).selected.map((entry) => entry.id), ["verification"])
  assert.deepEqual(selectSkill({ task: "skill:tdd please", mode: "REVIEW", entries: registry.entries, availableTools: FULL_TOOLS }).selected, [])
})

test("5A-17: selected skill id, version, source and reason appear in evidence", async () => {
  const { registry } = await builtins()
  const prepared = await prepareSkillGuidance({ enabled: true, registry, task: "Review this auth diff for vulnerabilities", mode: "REVIEW", availableTools: FULL_TOOLS, budget: BUDGET })
  const evidence = prepared.evidence
  assert.equal(evidence.enabled, true)
  assert.equal(evidence.selectedSkill, "security-review")
  assert.equal(evidence.skillVersion, 1)
  assert.equal(evidence.skillSource, "builtin")
  assert.equal(evidence.selectionReason, "trigger_match")
  assert.equal(evidence.skillLoadStatus, "LOADED")
  assert.equal(evidence.skillsIndexed, 21)
  assert.equal(evidence.indexTokens, estimateTokens(renderSkillIndex(registry.entries)))
  assert.ok(evidence.candidateSkills.includes("security-review"))
  assert.ok(evidence.skillContextTokens > 0)
  assert.equal(evidence.loadedSections.length, 7)
})

test("5A-18: skill telemetry carries no raw prompt, source code, secrets or skill body", async () => {
  const { registry } = await builtins()
  const task = "The app crashes in function leakMe() { return process.env.API_KEY } with key sk-live-ABCDEFGH12345678"
  const prepared = await prepareSkillGuidance({ enabled: true, registry, task, mode: "DEBUG", availableTools: FULL_TOOLS, budget: BUDGET })
  assert.equal(prepared.evidence.selectedSkill, "bug-triage")
  const serialized = JSON.stringify(prepared.evidence)
  for (const forbidden of ["leakMe", "process.env", "sk-live", "ABCDEFGH", "crashes in function", "Find the cause of a failure", "Reproduce:"]) {
    assert.ok(!serialized.includes(forbidden), `evidence leaked: ${forbidden}`)
  }
  assert.ok(serialized.length < 2000, "evidence stays bounded")
})

test("5A-19b: zero skills and disabled skills are valid runtime states", async () => {
  const none = await prepareSkillGuidance({ enabled: true, registry: SkillRegistry.empty(), task: "Fix the crash", mode: "DEBUG", availableTools: FULL_TOOLS, budget: BUDGET })
  assert.equal(none.evidence.skillLoadStatus, "NO_SKILL_SELECTED")
  assert.equal(none.evidence.skillsIndexed, 0)
  assert.equal(renderSkillIndex([]), "Available skills: none")

  const { registry, fs } = await builtins()
  const disabled = await prepareSkillGuidance({ enabled: false, registry, task: "Fix the crash", mode: "DEBUG", availableTools: FULL_TOOLS, budget: BUDGET })
  assert.equal(disabled.evidence.skillLoadStatus, "DISABLED")
  assert.equal(disabled.evidence.enabled, false)
  assert.deepEqual(disabled.guidance, [])
  assert.deepEqual(fs.bodyReads, [])
})

test("5A-22: deterministic selection evaluation meets its acceptance thresholds", async () => {
  const registry = await loadBuiltinRegistry()
  const first = runSelectionEval(registry)
  const second = runSelectionEval(registry)
  assert.deepEqual(first, second, "selection is deterministic")
  assert.equal(first.total, 40)
  assert.ok(first.accuracy >= 0.9, `accuracy ${first.accuracy}`)
  assert.equal(first.noSkillAccuracy, 1, "no skill is forced onto tasks that need none")
  assert.equal(first.wrongSkill, 0, "never a wrong skill where one specific skill was required")
})

test("5A-23: lazy loading materially reduces skill context versus eager injection", async () => {
  const registry = await loadBuiltinRegistry()
  const report = await runEfficiencyBenchmark(registry)
  assert.equal(report.totalSkills, 21)
  assert.ok(report.indexTokens < report.eagerTokens / 10, "metadata index is an order of magnitude smaller than the bodies")
  assert.ok(report.maxSelectedSkillTokens < report.eagerTokens / 4)
  assert.ok(report.reductionPercent >= 70, `reduction ${report.reductionPercent}%`)
  assert.ok(report.reductionWithIndexPercent >= 70, `reduction incl. index ${report.reductionWithIndexPercent}%`)
})
