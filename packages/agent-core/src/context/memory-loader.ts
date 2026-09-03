import { readMarkdownSection, MarkdownError, discoverCanonicalMarkdown } from "./markdown.ts"
import type { ProjectMemorySnapshot, Decision, Task, KnownIssue } from "./memory.ts"

export class ProjectMemoryLoader {
  constructor(private readonly workspaceRoot: string) {}

  async load(): Promise<ProjectMemorySnapshot> {
    const discovered = await discoverCanonicalMarkdown(this.workspaceRoot)
    const fileNames = new Set(discovered.map(f => f.name))

    const projectGoal = await this.readSectionSafely("PROJECT.md", "North star", fileNames)
    const constraints = await this.readSectionSafely("PROJECT.md", "Primary constraints", fileNames)
    const stack = await this.readSectionSafely("PROJECT.md", "Tech stack", fileNames)
    const knownIssuesList = await this.readSectionSafely("PROJECT.md", "Known issues", fileNames)

    const taskGraph = await this.readSectionSafely("PLAN.md", "Task graph", fileNames)
    const currentMilestone = await this.readSectionSafely("PLAN.md", "Current milestone", fileNames)
    const decisionsTable = await this.readSectionSafely("DECISIONS.md", "Decision Index", fileNames)
    
    const environmentNotes = await this.readSectionSafely("AGENTS.md", "Environment", fileNames) || await this.readSectionSafely("AGENTS.md", "Workflow", fileNames)
    const repoNotes = await this.readSectionSafely("ARCHITECTURE.md", "Component map", fileNames) || await this.readSectionSafely("ARCHITECTURE.md", "Architecture", fileNames)
    const recentChanges = await this.readSectionSafely("SCRATCHPAD.md", "Recent changes", fileNames) || await this.readSectionSafely("SCRATCHPAD.md", "Current state", fileNames)

    const activeTasks: Task[] = []
    if (currentMilestone) {
      activeTasks.push({ summary: currentMilestone.content, status: "active", source: "PLAN.md#Current milestone" })
    }
    if (taskGraph) {
      activeTasks.push({ summary: taskGraph.content, status: "planned", source: "PLAN.md#Task graph" })
    }

    const decisions: Decision[] = []
    if (decisionsTable) {
      // simple table parser
      const lines = decisionsTable.content.split("\n")
      for (const line of lines) {
        const parts = line.split("|").map(p => p.trim()).filter(Boolean)
        if (parts.length >= 3 && !parts[0]!.includes("---") && parts[0] !== "ADR") {
          // format: [ADR-001](...) | Decision | Status
          const p0 = parts[0] as string;
          const idMatch = /\[(.*?)\]/.exec(p0)
          const id = idMatch ? idMatch[1]! : p0
          decisions.push({
            id,
            summary: parts[1]!,
            reason: parts[2]!, // actually status
            source: "DECISIONS.md#Decision Index"
          })
        }
      }
    }
    
    const knownIssues: KnownIssue[] = []
    if (knownIssuesList) {
       knownIssues.push({ summary: knownIssuesList.content, source: knownIssuesList.source })
    }

    const result: any = { decisions, activeTasks, knownIssues }
    if (projectGoal) result.projectGoal = projectGoal
    if (constraints) result.constraints = constraints
    if (stack) result.stack = stack
    if (environmentNotes) result.environmentNotes = environmentNotes
    if (repoNotes) result.repoNotes = repoNotes
    if (recentChanges) result.recentChanges = recentChanges
    
    result.discoveredCount = discovered.length
    return result

  }

  private async readSectionSafely(path: string, heading: string, available: Set<string>) {
    if (!available.has(path)) return undefined
    try {
      const content = await readMarkdownSection(this.workspaceRoot, path, heading)
      if (content.trim()) return { content: content.trim(), source: `${path}#${heading}` }
    } catch (e: any) {
      if (e instanceof MarkdownError && e.code === "SECTION_NOT_FOUND") return undefined
      throw e
    }
    return undefined
  }
}

