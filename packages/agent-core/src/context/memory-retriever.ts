import type { MemoryQuery, MemorySelection, ProjectMemorySnapshot, SessionSummary } from "./memory.ts"
import { estimateTokens } from "./budget.ts"

export interface MemoryRetrieverOptions {
  readonly maxRestoredSessions?: number
}

export class MemoryRetriever {
  private readonly maxRestoredSessions: number

  constructor(
    private readonly projectSnapshot: ProjectMemorySnapshot,
    private readonly sessions: SessionSummary[],
    options?: MemoryRetrieverOptions
  ) {
    this.maxRestoredSessions = options?.maxRestoredSessions ?? 5
  }

  select(query: MemoryQuery): MemorySelection {
    const selection: any = {
      projectFacts: [],
      decisions: [],
      activeTasks: [],
      knownIssues: [],
      sessionSummaries: [],
      estimatedTokens: 0,
      documentsDiscovered: (this.projectSnapshot as any).discoveredCount || 0,
      documentsSelected: 0,
      sectionsSelected: 0,
      sessionSummariesConsidered: this.sessions.length,
      sessionSummariesSelected: 0,
      duplicatesDropped: 0,
      tiersUsed: []
    }

    const seenSources = new Set<string>()
    const markSource = (source: string) => {
      const doc = source.split('#')[0]!
      if (doc && !seenSources.has(doc)) {
        seenSources.add(doc)
        selection.documentsSelected++
      }
      selection.sectionsSelected++
    }

    const normalized = new Set<string>()
    const addFact = (content: string, source: string, tier: string) => {
      const lines = content.split("\n")
      const body = (lines.length > 1 && lines[0]!.startsWith("#")) ? lines.slice(1).join("\n") : content
      const fingerprint = body.toLowerCase().replace(/[\s\W]+/g, "")

      if (!fingerprint) return

      let isDuplicate = false
      for (const existing of normalized) {
        if (existing.includes(fingerprint) || fingerprint.includes(existing)) {
          isDuplicate = true
          break
        }
      }

      if (isDuplicate) {
        selection.duplicatesDropped++
        return
      }
      const tokens = estimateTokens(content)
      if (selection.estimatedTokens + tokens <= query.tokenBudget) {
        selection.projectFacts.push({ content, source })
        selection.estimatedTokens += tokens
        normalized.add(fingerprint)
        markSource(source)
        if (!selection.tiersUsed.includes(tier)) selection.tiersUsed.push(tier)
      }
    }

    if (this.projectSnapshot.projectGoal) {
      addFact(this.projectSnapshot.projectGoal.content, this.projectSnapshot.projectGoal.source, "Tier 0")
    }
    if (this.projectSnapshot.constraints) {
      addFact(this.projectSnapshot.constraints.content, this.projectSnapshot.constraints.source, "Tier 0")
    }
    if (this.projectSnapshot.environmentNotes) {
      addFact(this.projectSnapshot.environmentNotes.content, this.projectSnapshot.environmentNotes.source, "Tier 0")
    }
    if (this.projectSnapshot.stack) {
      addFact(this.projectSnapshot.stack.content, this.projectSnapshot.stack.source, "Tier 0")
    }

    for (const task of this.projectSnapshot.activeTasks) {
       const content = `Task: ${task.summary}\nStatus: ${task.status}`
       const fingerprint = content.toLowerCase().replace(/[\s\W]+/g, "")
       if (normalized.has(fingerprint)) {
         selection.duplicatesDropped++
         continue
       }
       const tokens = estimateTokens(content)
       if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.activeTasks.push(task)
         selection.estimatedTokens += tokens
         normalized.add(fingerprint)
         if (task.source) markSource(task.source)
         if (!selection.tiersUsed.includes("Tier 1")) selection.tiersUsed.push("Tier 1")
       }
    }

    for (const decision of this.projectSnapshot.decisions) {
       const content = `Decision [${decision.id}]: ${decision.summary}`
       const fingerprint = content.toLowerCase().replace(/[\s\W]+/g, "")
       if (normalized.has(fingerprint)) {
         selection.duplicatesDropped++
         continue
       }
       const tokens = estimateTokens(content)
       if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.decisions.push(decision)
         selection.estimatedTokens += tokens
         normalized.add(fingerprint)
         if (decision.source) markSource(decision.source)
         if (!selection.tiersUsed.includes("Tier 1")) selection.tiersUsed.push("Tier 1")
       }
    }

    for (const issue of this.projectSnapshot.knownIssues) {
       const content = `Known Issue: ${issue.summary}`
       const fingerprint = content.toLowerCase().replace(/[\s\W]+/g, "")
       if (normalized.has(fingerprint)) {
         selection.duplicatesDropped++
         continue
       }
       const tokens = estimateTokens(content)
       if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.knownIssues.push(issue)
         selection.estimatedTokens += tokens
         normalized.add(fingerprint)
         if (issue.source) markSource(issue.source)
         if (!selection.tiersUsed.includes("Tier 1")) selection.tiersUsed.push("Tier 1")
       }
    }

    if (this.projectSnapshot.repoNotes) {
      addFact(this.projectSnapshot.repoNotes.content, this.projectSnapshot.repoNotes.source, "Tier 2")
    }
    if (this.projectSnapshot.recentChanges) {
      addFact(this.projectSnapshot.recentChanges.content, this.projectSnapshot.recentChanges.source, "Tier 2")
    }

    const score = (s: SessionSummary) => {
        let sc = 0;
        if (s.mode === query.mode) sc += 1;

        const queryTokens = new Set(query.task.toLowerCase().split(/\W+/).filter(x => x.length > 2))
        const taskTokens = s.task.toLowerCase().split(/\W+/)
        for (const t of taskTokens) if (queryTokens.has(t)) sc += 2;

        return sc
    }

    const relevantSessions = this.sessions
      .map(s => ({ session: s, score: score(s) }))
      .filter(s => s.score > 0)
      .toSorted((a, b) => {
         if (a.score !== b.score) return b.score - a.score;
         return (b.session.completedAt || "").localeCompare(a.session.completedAt || "")
      })
      .map(x => x.session)
      .slice(0, this.maxRestoredSessions);

    for (const s of relevantSessions) {
      let isDuplicate = false

      const sTask = s.task.toLowerCase().replace(/[\s\W]+/g, "")

      // Historical nextAction is ALWAYS superseded by current authoritative Markdown
      // so we don't even try to include it or compare it. It's skipped.

      if (sTask) {
        for (const existing of normalized) {
           if (existing.includes(sTask) || sTask.includes(existing)) {
              isDuplicate = true
              break
           }
        }
      }

      if (isDuplicate) {
        selection.duplicatesDropped++
        continue
      }

      const content = JSON.stringify({
        sessionId: s.sessionId,
        mode: s.mode,
        outcome: s.outcome,
        task: s.task,
        changedFiles: s.changedFiles,
        unresolvedIssues: s.unresolvedIssues,
        // intentionally omitting nextAction to avoid conflicts with PLAN.md
      })
      const tokens = estimateTokens(content)
      if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.sessionSummaries.push(s)
         selection.estimatedTokens += tokens
         selection.sessionSummariesSelected++
         if (!selection.tiersUsed.includes("Tier 3")) selection.tiersUsed.push("Tier 3")
      }
    }

    return selection
  }
}
