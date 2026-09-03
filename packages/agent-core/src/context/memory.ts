export interface Provenance {
  readonly source: string
}

export interface Decision extends Provenance {
  readonly id: string
  readonly summary: string
  readonly reason?: string
  readonly updatedAt?: string
}

export interface Task extends Provenance {
  readonly id?: string
  readonly summary: string
  readonly status: string
  readonly acceptance?: string
}

export interface KnownIssue extends Provenance {
  readonly summary: string
  readonly severity?: string
}

export interface ProjectMemorySnapshot {
  readonly projectGoal?: { content: string; source: string }
  readonly stack?: { content: string; source: string }
  readonly constraints?: { content: string; source: string }
  readonly decisions: readonly Decision[]
  readonly activeTasks: readonly Task[]
  readonly knownIssues: readonly KnownIssue[]
  readonly recentChanges?: { content: string; source: string }
  readonly environmentNotes?: { content: string; source: string }
  readonly repoNotes?: { content: string; source: string }
}

export interface SessionSummary {
  readonly sessionId: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly mode: string
  readonly task: string
  readonly outcome: string
  readonly changedFiles: readonly string[]
  readonly verification?: string
  readonly decisions: readonly string[]
  readonly unresolvedIssues: readonly string[]
  readonly nextAction?: string
}

export interface MemoryQuery {
  readonly task: string
  readonly mode: string
  readonly relevantFiles?: string[]
  readonly tokenBudget: number
}

export interface MemorySelection {
  readonly projectFacts: readonly { content: string; source: string }[]
  readonly decisions: readonly Decision[]
  readonly activeTasks: readonly Task[]
  readonly knownIssues: readonly KnownIssue[]
  readonly sessionSummaries: readonly SessionSummary[]
  readonly estimatedTokens: number
  readonly documentsDiscovered: number
  readonly documentsSelected: number
  readonly sectionsSelected: number
  readonly sessionSummariesConsidered: number
  readonly sessionSummariesSelected: number
  readonly duplicatesDropped: number
  readonly tiersUsed: readonly string[]
}
