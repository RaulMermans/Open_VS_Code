import { estimateTokens } from "../../src/context/budget.ts"
import type { ContextBudget } from "../../src/contracts/context.ts"
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../../src/skills/registry.ts"
import { fitSkillGuidance, prepareSkillGuidance, renderSkillIndex } from "../../src/skills/runtime.ts"
import { selectSkill } from "../../src/skills/selector.ts"
import { FULL_TOOLS, READONLY_TOOLS, SKILL_SELECTION_CASES, type SkillSelectionCase } from "./skill-selection-cases.ts"

/** Shared by `npm run eval:skills` and the deterministic test suite. Pure: no model, no network. */

export const EVAL_BUDGET: ContextBudget = { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500, availableContext: 6500 }

export interface SelectionCaseResult {
  readonly id: string
  readonly kind: SkillSelectionCase["kind"]
  readonly mode: string
  readonly acceptable: readonly (string | null)[]
  readonly selected: string | null
  readonly correct: boolean
}

export interface SelectionReport {
  readonly total: number
  readonly correct: number
  readonly accuracy: number
  readonly positiveCases: number
  readonly positiveCorrect: number
  readonly noSkillCases: number
  readonly noSkillCorrect: number
  readonly noSkillAccuracy: number
  readonly falsePositives: number
  readonly falsePositiveRate: number
  readonly falseNegatives: number
  readonly wrongSkill: number
  readonly results: readonly SelectionCaseResult[]
}

export interface EfficiencyReport {
  readonly totalSkills: number
  readonly totalBodyTokens: number
  readonly eagerTokens: number
  readonly indexTokens: number
  readonly averageSelectedSkillTokens: number
  readonly maxSelectedSkillTokens: number
  readonly averageLazyPromptTokens: number
  readonly averageLazyWithIndexTokens: number
  readonly tokensAvoidedPerTask: number
  readonly reductionPercent: number
  readonly reductionWithIndexPercent: number
  readonly perSkill: readonly { readonly id: string; readonly bodyTokens: number }[]
}

export async function loadBuiltinRegistry(): Promise<SkillRegistry> {
  const builtinRoot = defaultBuiltinSkillsRoot()
  if (!builtinRoot) throw new Error("Built-in skills root is unavailable")
  return SkillRegistry.discover({ builtinRoot, workspaceTrusted: true })
}

export function runSelectionEval(registry: SkillRegistry, cases: readonly SkillSelectionCase[] = SKILL_SELECTION_CASES): SelectionReport {
  const results = cases.map((testCase): SelectionCaseResult => {
    const selection = selectSkill({
      task: testCase.task,
      mode: testCase.mode,
      entries: registry.entries,
      availableTools: testCase.tools === "readonly" ? READONLY_TOOLS : FULL_TOOLS,
    })
    const selected = selection.selected[0]?.id ?? null
    return { id: testCase.id, kind: testCase.kind, mode: testCase.mode, acceptable: testCase.acceptable, selected, correct: testCase.acceptable.includes(selected) }
  })
  const noSkill = results.filter((result) => result.kind === "no-skill")
  const positives = results.filter((result) => result.kind === "positive")
  const falsePositives = results.filter((result) => result.selected !== null && !result.acceptable.includes(result.selected) && result.acceptable.includes(null)).length
  const wrongSkill = results.filter((result) => result.selected !== null && !result.acceptable.includes(result.selected) && !result.acceptable.includes(null)).length
  const falseNegatives = results.filter((result) => result.selected === null && !result.acceptable.includes(null)).length
  const casesAllowingNoSkill = results.filter((result) => result.acceptable.includes(null)).length
  const correct = results.filter((result) => result.correct).length
  return {
    total: results.length,
    correct,
    accuracy: correct / results.length,
    positiveCases: positives.length,
    positiveCorrect: positives.filter((result) => result.correct).length,
    noSkillCases: noSkill.length,
    noSkillCorrect: noSkill.filter((result) => result.correct).length,
    noSkillAccuracy: noSkill.length === 0 ? 1 : noSkill.filter((result) => result.correct).length / noSkill.length,
    falsePositives,
    falsePositiveRate: casesAllowingNoSkill === 0 ? 0 : falsePositives / casesAllowingNoSkill,
    falseNegatives,
    wrongSkill,
    results,
  }
}

/**
 * Eager baseline: every seed skill body injected, framed exactly as the lazy runtime frames one.
 * Lazy runtime: the selected skill only (0 tokens when no skill is selected). The "with index"
 * variant also charges the compact metadata index, as a model-assisted selector would need it.
 */
export async function runEfficiencyBenchmark(registry: SkillRegistry, cases: readonly SkillSelectionCase[] = SKILL_SELECTION_CASES): Promise<EfficiencyReport> {
  const perSkill: { id: string; bodyTokens: number }[] = []
  for (const entry of registry.entries) {
    const fitted = fitSkillGuidance(await registry.loadBody(entry.id), Number.MAX_SAFE_INTEGER)
    perSkill.push({ id: entry.id, bodyTokens: fitted.guidance!.estimatedTokens })
  }
  const totalBodyTokens = perSkill.reduce((total, skill) => total + skill.bodyTokens, 0)
  const indexTokens = estimateTokens(renderSkillIndex(registry.entries))

  const lazyTokens: number[] = []
  for (const testCase of cases) {
    const prepared = await prepareSkillGuidance({
      enabled: true,
      registry,
      task: testCase.task,
      mode: testCase.mode,
      availableTools: testCase.tools === "readonly" ? READONLY_TOOLS : FULL_TOOLS,
      budget: EVAL_BUDGET,
    })
    lazyTokens.push(prepared.evidence.skillContextTokens)
  }
  const averageLazyPromptTokens = lazyTokens.reduce((total, value) => total + value, 0) / lazyTokens.length
  const selectedOnly = lazyTokens.filter((value) => value > 0)
  const averageLazyWithIndexTokens = averageLazyPromptTokens + indexTokens
  return {
    totalSkills: perSkill.length,
    totalBodyTokens,
    eagerTokens: totalBodyTokens,
    indexTokens,
    averageSelectedSkillTokens: selectedOnly.length === 0 ? 0 : selectedOnly.reduce((total, value) => total + value, 0) / selectedOnly.length,
    maxSelectedSkillTokens: Math.max(0, ...lazyTokens),
    averageLazyPromptTokens,
    averageLazyWithIndexTokens,
    tokensAvoidedPerTask: totalBodyTokens - averageLazyPromptTokens,
    reductionPercent: totalBodyTokens === 0 ? 0 : ((totalBodyTokens - averageLazyPromptTokens) / totalBodyTokens) * 100,
    reductionWithIndexPercent: totalBodyTokens === 0 ? 0 : ((totalBodyTokens - averageLazyWithIndexTokens) / totalBodyTokens) * 100,
    perSkill,
  }
}
