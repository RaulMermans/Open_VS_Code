import type { SkillMetadata } from "./skills.ts"

export interface SkillSelectionInput {
  readonly task: string
  readonly mode: string
  readonly relevantFiles?: readonly string[]
  readonly catalog: readonly SkillMetadata[]
  readonly budgetTokens: number
}

export interface SelectedSkill {
  readonly metadata: SkillMetadata
  readonly sections: readonly string[]
  readonly estimatedTokens: number
  readonly isPrimary: boolean
  readonly reason: string
}

export interface SkillSelectionResult {
  readonly skillsDiscovered: number
  readonly skillsEligible: number
  readonly skillsSelected: number
  readonly primarySkill?: SelectedSkill
  readonly supportingSkills: readonly SelectedSkill[]
  readonly estimatedSkillTokens: number
  readonly skillBudget: number
  readonly skillsDroppedForBudget: number
}

function calculateScore(skill: SkillMetadata, task: string, mode: string): { score: number; isEligible: boolean; reason: string } {
  const lowerTask = task.toLowerCase()
  let score = 0
  let isEligible = true
  let reason = ""

  if (skill.modes.length > 0) {
    if (!skill.modes.includes(mode)) {
      isEligible = false
      return { score, isEligible, reason: `Mode mismatch: ${mode} not in ${skill.modes.join(",")}` }
    }
    score += 10
  }

  const terms = lowerTask.split(/\W+/).filter(t => t.length > 2)
  let matchedTags = 0
  for (const tag of skill.tags) {
    if (terms.includes(tag.toLowerCase())) {
      matchedTags++
      score += 5
    }
  }

  if (skill.triggers) {
    for (const trigger of skill.triggers) {
      if (lowerTask.includes(trigger.toLowerCase())) {
        score += 15
        reason = `Trigger matched: ${trigger}`
      }
    }
  }

  if (matchedTags > 0 && !reason) {
    reason = `Matched ${matchedTags} tags`
  }

  // Task-term overlap with title/summary
  const metadataText = `${skill.title} ${skill.summary}`.toLowerCase()
  let overlap = 0
  for (const term of terms) {
    if (metadataText.includes(term)) {
      overlap++
    }
  }
  score += overlap * 2
  
  if (overlap > 0 && !reason) {
     reason = `Text overlap`
  }
  
  if (score > 0 && !reason) {
     reason = `Mode matched`
  }
  if (score === 0 && skill.modes.includes(mode)) {
     score += 1 // Base score for mode match
     reason = "Mode fallback"
  } else if (score === 0) {
     isEligible = false
     reason = "No signals matched"
  }

  return { score, isEligible, reason }
}

export function selectSkills(input: SkillSelectionInput): SkillSelectionResult {
  const eligibleCandidates = input.catalog
    .map(skill => ({ skill, ...calculateScore(skill, input.task, input.mode) }))
    .filter(c => c.isEligible)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))

  let primary: SelectedSkill | undefined
  const supporting: SelectedSkill[] = []
  let usedTokens = 0
  let dropped = 0

  const s2Sections = ["Intent", "When", "Inputs", "Procedure", "Template", "Expected Output"]
  const s3Sections = [...s2Sections, "Failure Modes", "Recovery Prompts"]

  for (const candidate of eligibleCandidates) {
    if (!primary) {
       const costS3 = candidate.skill.estimatedTokens
       const costS2 = Math.floor(costS3 * 0.75) // estimate S2 cost
       let chosenSections = s3Sections
       let cost = costS3
       
       if (usedTokens + cost > input.budgetTokens) {
          cost = costS2
          chosenSections = s2Sections
       }
       
       if (usedTokens + cost <= input.budgetTokens) {
         primary = {
           metadata: candidate.skill,
           sections: chosenSections,
           estimatedTokens: cost,
           isPrimary: true,
           reason: candidate.reason
         }
         usedTokens += cost
       } else {
         dropped++
       }
    } else if (supporting.length < 2) {
       const costS1 = Math.floor(candidate.skill.estimatedTokens * 0.3)
       if (usedTokens + costS1 <= input.budgetTokens) {
         supporting.push({
           metadata: candidate.skill,
           sections: ["Intent", "When", "Procedure"], // S1
           estimatedTokens: costS1,
           isPrimary: false,
           reason: candidate.reason
         })
         usedTokens += costS1
       } else {
         dropped++
       }
    }
  }

  return {
    skillsDiscovered: input.catalog.length,
    skillsEligible: eligibleCandidates.length,
    skillsSelected: (primary ? 1 : 0) + supporting.length,
    primarySkill: primary,
    supportingSkills: supporting,
    estimatedSkillTokens: usedTokens,
    skillBudget: input.budgetTokens,
    skillsDroppedForBudget: dropped
  }
}
