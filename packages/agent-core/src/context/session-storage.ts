import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { join, dirname } from "node:path"
import type { SessionSummary } from "./memory.ts"

export interface SessionStorageOptions {
  readonly workspaceRoot: string
  readonly maxRetained?: number
}

const REDACTED_KEYS = ["password", "secret", "token", "key", "authorization", "bearer"]

function redactSecrets(summary: SessionSummary): SessionSummary {
  // basic heuristic redaction on task and nextAction
  const redact = (text: string) => {
    let result = text
    for (const key of REDACTED_KEYS) {
      const regex = new RegExp(`(?<=${key}['"]?\\s*[:=]\\s*['"]?)[^\\s'"]+`, "gi")
      result = result.replace(regex, "***REDACTED***")
    }
    return result
  }

  
  const result: any = { ...summary, task: redact(summary.task) }
  if (summary.nextAction) result.nextAction = redact(summary.nextAction)
  if (summary.verification) result.verification = redact(summary.verification)
  return result as SessionSummary

}

export class SessionSummaryStorage {
  private readonly path: string
  private readonly maxRetained: number

  constructor(options: SessionStorageOptions) {
    this.path = join(options.workspaceRoot, ".open-vs-code", "sessions.jsonl")
    this.maxRetained = options.maxRetained ?? 50
  }

  async load(): Promise<SessionSummary[]> {
    try {
      const content = await readFile(this.path, "utf8")
      const lines = content.split("\n").filter(line => line.trim())
      return lines.map(line => JSON.parse(line) as SessionSummary)
    } catch (e: any) {
      if (e.code === "ENOENT") return []
      console.warn("Failed to load session memory or corruption found, returning empty", e.message)
      return []
    }
  }

  async append(summary: SessionSummary): Promise<void> {
    const safeSummary = redactSecrets(summary)
    
    let existing: SessionSummary[] = []
    try {
      existing = await this.load()
    } catch (e) {
      // ignore
    }

    existing.push(safeSummary)
    if (existing.length > this.maxRetained) {
      existing = existing.slice(existing.length - this.maxRetained)
    }

    const content = existing.map(s => JSON.stringify(s)).join("\n") + "\n"
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true })
    
    // Atomic write
    const tempPath = this.path + ".tmp"
    await writeFile(tempPath, content, "utf8")
    
    // Rename
    await rename(tempPath, this.path)
  }
}
