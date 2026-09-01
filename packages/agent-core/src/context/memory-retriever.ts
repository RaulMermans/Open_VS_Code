import type { MemoryQuery, MemorySelection, ProjectMemorySnapshot, SessionSummary } from "./memory.ts"
import { estimateTokens } from "./budget.ts"

export class MemoryRetriever {
  constructor(
    private readonly projectSnapshot: ProjectMemorySnapshot,
    private readonly sessions: SessionSummary[]
  ) {}

  select(query: MemoryQuery): MemorySelection {
    const selection: any = {
      projectFacts: [],
      decisions: [],
      activeTasks: [],
      knownIssues: [],
      sessionSummaries: [],
      estimatedTokens: 0
    }

    const addFact = (content: string, source: string) => {
      const tokens = estimateTokens(content)
      if (selection.estimatedTokens + tokens <= query.tokenBudget) {
        selection.projectFacts.push({ content, source })
        selection.estimatedTokens += tokens
      }
    }

    // Tier 0: project goal, hard constraints
    if (this.projectSnapshot.projectGoal) {
      addFact(this.projectSnapshot.projectGoal.content, this.projectSnapshot.projectGoal.source)
    }
    if (this.projectSnapshot.constraints) {
      addFact(this.projectSnapshot.constraints.content, this.projectSnapshot.constraints.source)
    }

    // Tier 1: relevant PLAN entries (we include all active tasks as facts)
    for (const task of this.projectSnapshot.activeTasks) {
       const content = `Task: ${task.summary}\nStatus: ${task.status}`
       const tokens = estimateTokens(content)
       if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.activeTasks.push(task)
         selection.estimatedTokens += tokens
       }
    }
    
    // Tier 1: relevant decisions. We can just take the first few or relevant ones.
    // For now, take up to budget.
    for (const decision of this.projectSnapshot.decisions) {
       const content = `Decision [${decision.id}]: ${decision.summary}`
       const tokens = estimateTokens(content)
       if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.decisions.push(decision)
         selection.estimatedTokens += tokens
       }
    }

    // Tier 3: relevant session summaries. We prioritize the most recent ones that fit.
    // T-511 relevance signals: same mode, overlap with active task, recentness
    // T-510 maximum restored: 3-5 summaries
    
    // filter to mostly relevant or just most recent
    const relevantSessions = this.sessions
      .filter(s => s.outcome !== "CANCELLED") // perhaps include rejected?
      .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""))
      .slice(0, 5)

    for (const s of relevantSessions) {
      const content = JSON.stringify(s)
      const tokens = estimateTokens(content)
      if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.sessionSummaries.push(s)
         selection.estimatedTokens += tokens
      }
    }

    return selection
  }
}
