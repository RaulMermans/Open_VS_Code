import type { CompiledContext, ContextBudget, ContextItem, ConversationTurn } from "../contracts/context.ts"
import { estimateTokens, fitContext } from "./budget.ts"
import type { LoadedSkill } from "./skills.ts"
import type { MemorySelection } from "./memory.ts"
import type { ToolObservation } from "../agent/observations.ts"

export interface ProjectInstruction {
  readonly id: string
  readonly path: string
  readonly content: string
}


export interface ContextCompilerInput {
  readonly task: string
  readonly projectInstructions: readonly ProjectInstruction[]
  readonly memory?: MemorySelection
  readonly selectedSkills?: readonly LoadedSkill[]
  readonly codeContext?: readonly ContextItem[]
  readonly observations?: readonly ToolObservation[]
  readonly recentTurns?: readonly ConversationTurn[]
  readonly maxObservations?: number
  readonly budget: ContextBudget
}

function recentObservations(observations: readonly ToolObservation[], limit: number): ToolObservation[] {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError("maxObservations must be a non-negative integer")
  const selected: ToolObservation[] = []
  const seen = new Set<string>()
  for (let index = observations.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const observation = observations[index]!
    const key = `${observation.toolName}\0${observation.ok}\0${observation.content}`
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(observation)
  }
  return selected
}

export function compileContext(input: ContextCompilerInput): CompiledContext {
  if (!input.task.trim()) throw new TypeError("Context compiler task must not be empty")
  const required: ContextItem[] = input.projectInstructions.map((instruction) => ({
    id: instruction.id,
    source: { kind: "project-instruction", path: instruction.path },
    content: instruction.content,
    priority: 1_000,
    estimatedTokens: estimateTokens(instruction.content),
    required: true,
  }))
  required.push({
    id: "current-task",
    source: { kind: "task" },
    content: input.task,
    priority: 1_000,
    estimatedTokens: estimateTokens(input.task),
    required: true,
  })
  
  if (input.memory) {
    for (const fact of input.memory.projectFacts) {
      required.push({
        id: `memory:fact:${fact.source}`,
        source: { kind: "project-instruction", path: fact.source.split("#")[0] as string },
        content: fact.content,
        priority: 900,
        estimatedTokens: estimateTokens(fact.content),
        required: true,
      })
    }
    for (const task of input.memory.activeTasks) {
      required.push({
        id: `memory:task:${task.source}`,
        source: { kind: "project-instruction", path: task.source.split("#")[0] as string },
        content: `Active Task:\n${task.summary}\nStatus: ${task.status}`,
        priority: 850,
        estimatedTokens: estimateTokens(task.summary),
        required: true,
      })
    }
    for (const decision of input.memory.decisions) {
      required.push({
        id: `memory:decision:${decision.id}`,
        source: { kind: "project-instruction", path: decision.source.split("#")[0] as string },
        content: `Decision [${decision.id}]: ${decision.summary}`,
        priority: 800,
        estimatedTokens: estimateTokens(decision.summary),
        required: true,
      })
    }
    for (const issue of (input.memory.knownIssues || [])) {
      required.push({
        id: `memory:known-issue:${issue.source}`,
        source: { kind: "project-instruction", path: issue.source.split("#")[0] as string },
        content: `Known Issue:\n${issue.summary}`,
        priority: 825,
        estimatedTokens: estimateTokens(issue.summary),
        required: true,
      })
    }
    for (const s of input.memory.sessionSummaries) {
      const content = `Historical session context (Task: ${s.task}):\nOutcome: ${s.outcome}\nMode: ${s.mode}\nChanged Files: ${s.changedFiles.join(', ')}\nUnresolved: ${s.unresolvedIssues.join(', ')}`;
      required.push({
        id: `memory:session:${s.sessionId}`,
        source: { kind: "historical-session" },
        content,
        priority: 700,
        estimatedTokens: estimateTokens(content),
        required: true,
      })
    }
  }

  if (input.selectedSkills) {
    for (const skill of input.selectedSkills) {
      required.push({
        id: `skill:${skill.id}`,
        source: { kind: "skill", path: skill.path },
        content: skill.body,
        priority: 950,
        estimatedTokens: estimateTokens(skill.body),
        required: true,
        metadata: { id: skill.id, title: skill.title, summary: skill.summary, sections: skill.sections, estimatedTokens: estimateTokens(skill.body) },
      })
    }
  }
  
  if (input.recentTurns && input.recentTurns.length > 0) {
    const groups: ConversationTurn[][] = [];
    let currentGroup: ConversationTurn[] = [];
    for (const turn of input.recentTurns) {
      if (turn.role === "user" && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      currentGroup.push(turn);
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    
    // Reverse to process newest first, they get the highest priority
    const reversedGroups = [...groups].reverse();
    for (let i = 0; i < reversedGroups.length; i++) {
      const group = reversedGroups[i];
      if (!group) continue;
      let content = "";
      for (const turn of group) {
        content += `[Turn ${turn.role}]: ${turn.content}\n\n`;
      }
      required.push({
        id: `recent-turn-group:${i}`,
        source: { kind: "historical-session" },
        content: content.trim(),
        priority: 749 - i,
        estimatedTokens: estimateTokens(content.trim()),
        required: false, // Make it optional
      });
    }
  }

  const observations = recentObservations(input.observations ?? [], input.maxObservations ?? 6).map((observation, index): ContextItem => ({
    id: `observation:${observation.callId}`,
    source: { kind: "observation", ...(observation.provenance.paths[0] ? { path: observation.provenance.paths[0] } : {}) },
    content: observation.content,
    priority: 100 - index,
    estimatedTokens: estimateTokens(observation.content),
    required: false,
    metadata: {
      toolName: observation.toolName,
      callId: observation.callId,
      ok: observation.ok,
      truncated: observation.truncated,
      paths: observation.provenance.paths,
      ...(observation.errorCategory ? { errorCategory: observation.errorCategory } : {}),
    },
  }))
  return fitContext([...required, ...(input.codeContext ?? []), ...observations], input.budget)
}
