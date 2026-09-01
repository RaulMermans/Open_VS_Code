import { readMarkdownSection, MarkdownError, discoverCanonicalMarkdown } from "./markdown.ts"
import type { ProjectMemorySnapshot, Decision, Task, KnownIssue } from "./memory.ts"

export class ProjectMemoryLoader {
  constructor(private readonly workspaceRoot: string) {}

  async load(): Promise<ProjectMemorySnapshot> {
    const discovered = await discoverCanonicalMarkdown(this.workspaceRoot)
    const fileNames = new Set(discovered.map(f => f.name))

    const projectGoal = await this.readSectionSafely("PROJECT.md", "North star", fileNames)
    const constraints = await this.readSectionSafely("PROJECT.md", "Primary constraints", fileNames)
    const taskGraph = await this.readSectionSafely("PLAN.md", "Task graph", fileNames)
    const currentMilestone = await this.readSectionSafely("PLAN.md", "Current milestone", fileNames)
    const decisionsTable = await this.readSectionSafely("DECISIONS.md", "Decision Index", fileNames)

    const activeTasks: Task[] = []
    if (currentMilestone) {
      activeTasks.push({ summary: currentMilestone.content, status: "active", source: "PLAN.md:Current milestone" })
    }
    if (taskGraph) {
      activeTasks.push({ summary: taskGraph.content, status: "planned", source: "PLAN.md:Task graph" })
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
            source: "DECISIONS.md"
          })
        }
      }
    }

    
    const result: any = { decisions, activeTasks, knownIssues: [] }
    if (projectGoal) result.projectGoal = projectGoal
    if (constraints) result.constraints = constraints
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
