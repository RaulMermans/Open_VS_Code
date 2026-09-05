import type { SkillMetadata } from "./skills.ts"

export interface SkillSelectionInput {
  readonly task: string
  readonly mode: string
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

  const legacyIds = new Set(["repo-intake", "upstream-audit", "change-with-tests"]);
  if (legacyIds.has(skill.id)) {
     if (!task.includes(skill.id)) {
         return { score: 0, isEligible: false, reason: "legacy_excluded" }
     } else {
         score += 50
         reason = "explicit_request"
     }
  }

  if (skill.modes.length > 0) {
    if (!skill.modes.includes(mode)) {
      isEligible = false
      return { score, isEligible, reason: "mode_mismatch" }
    }
    score += 10
  }

  const stopWords = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "how", "why", "can", "you", "not", "but", "are", "have", "has", "had", "will", "would", "could", "should", "does", "did"]);
  const terms = lowerTask.split(/\W+/).filter(t => t.length > 2 && !stopWords.has(t))
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
        reason = "trigger_match"
      }
    }
  }

  if (matchedTags > 0 && !reason) {
    reason = "tag_overlap"
  }

  // Task-term overlap with title/summary
  const metadataText = `${skill.title} ${skill.summary}`.toLowerCase()
  let overlap = 0
  for (const term of terms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i')
    if (regex.test(metadataText)) {
      overlap++
    }
  }
  score += overlap * 2
  
  if (overlap > 0 && !reason) {
     reason = "text_overlap"
  }
  
  if (score > 0 && !reason) {
     reason = "mode_compatible"
  }
  
  // Enforce minimum meaningful relevance
  if ((skill.modes.includes(mode) && score <= 10) || (!skill.modes.includes(mode) && score === 0)) {
     isEligible = false
     reason = "no_relevance"
  }

  return { score, isEligible, reason }
}

export function selectSkills(input: SkillSelectionInput): SkillSelectionResult {
  const eligibleCandidates = input.catalog
    .map(skill => ({ skill, ...calculateScore(skill, input.task, input.mode) }))
    .filter(c => c.isEligible)
    .toSorted((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))

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
    ...(primary ? { primarySkill: primary } : {}),
    supportingSkills: supporting,
    estimatedSkillTokens: usedTokens,
    skillBudget: input.budgetTokens,
    skillsDroppedForBudget: dropped
  }
}
