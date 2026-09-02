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
      // If it looks like a markdown heading on the first line, skip it for fingerprinting
      const body = (lines.length > 1 && lines[0]!.startsWith("#")) ? lines.slice(1).join("\n") : content
      const fingerprint = body.toLowerCase().replace(/[\s\W]+/g, "")
      
      if (!fingerprint) return // ignore empty content
      
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

    // Tier 0: project goal, hard constraints
    if (this.projectSnapshot.projectGoal) {
      addFact(this.projectSnapshot.projectGoal.content, this.projectSnapshot.projectGoal.source, "Tier 0")
    }
    if (this.projectSnapshot.constraints) {
      addFact(this.projectSnapshot.constraints.content, this.projectSnapshot.constraints.source, "Tier 0")
    }
    // New Tier 0: agents
    if (this.projectSnapshot.environmentNotes) {
      addFact(this.projectSnapshot.environmentNotes.content, this.projectSnapshot.environmentNotes.source, "Tier 0")
    }

    // Tier 1: relevant PLAN entries (we include all active tasks as facts)
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
    
    // Tier 1: relevant decisions. We can just take the first few or relevant ones.
    for (const decision of this.projectSnapshot.decisions) {
       const content = `Decision [${decision.id}]: ${decision.summary}`
       const tokens = estimateTokens(content)
       if (selection.estimatedTokens + tokens <= query.tokenBudget) {
         selection.decisions.push(decision)
         selection.estimatedTokens += tokens
         if (decision.source) markSource(decision.source)
         if (!selection.tiersUsed.includes("Tier 1")) selection.tiersUsed.push("Tier 1")
       }
    }

    // Tier 2: architecture, scratchpad
    if (this.projectSnapshot.repoNotes) {
      addFact(this.projectSnapshot.repoNotes.content, this.projectSnapshot.repoNotes.source, "Tier 2")
    }
    if (this.projectSnapshot.recentChanges) {
      addFact(this.projectSnapshot.recentChanges.content, this.projectSnapshot.recentChanges.source, "Tier 2")
    }

    // Tier 3: relevant session summaries. We prioritize the most recent ones that fit.
    const score = (s: SessionSummary) => {
        let sc = 0;
        if (s.mode === query.mode) sc += 1;
        
        // simple overlap
        const queryTokens = new Set(query.task.toLowerCase().split(/\W+/).filter(x => x.length > 2))
        const taskTokens = s.task.toLowerCase().split(/\W+/)
        for (const t of taskTokens) if (queryTokens.has(t)) sc += 2;
        
        return sc
    }
    
    console.log("THIS SESSIONS:", this.sessions);
const relevantSessions = this.sessions
      .filter(s => s.outcome !== "CANCELLED") 
      .map(s => ({ session: s, score: score(s) }))
      .filter(s => s.score > 0) // exclude completely irrelevant
      .toSorted((a, b) => {
         if (a.score !== b.score) return b.score - a.score;
         return (b.session.completedAt || "").localeCompare(a.session.completedAt || "")
      })
      .map(x => x.session)
      .slice(0, 5);
console.log("RELEVANT:", relevantSessions);

    for (const s of relevantSessions) {
      const content = JSON.stringify(s)
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
