import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { join, dirname, relative, isAbsolute } from "node:path"
import { realpath } from "node:fs/promises"
import type { SessionSummary } from "./memory.ts"

export interface SessionStorageOptions {
  readonly workspaceRoot: string
  readonly maxRetained?: number
}

const REDACTED_KEYS = ["password", "secret", "token", "key", "authorization", "bearer", "api_key", "aws_access_key"]

function redactSecrets(summary: SessionSummary): SessionSummary {
  const redact = (text: string) => {
    let result = text
    for (const key of REDACTED_KEYS) {
      const regex = new RegExp(`(${key}['"]?\\s*[:=]\\s*['"]?)[^\\s'"]+`, "gi")
      result = result.replace(regex, "$1***REDACTED***")
      
      if (key === "bearer") {
        const bearerRegex = new RegExp(`(bearer\\s+)[^\\s'"]+`, "gi")
        result = result.replace(bearerRegex, "$1***REDACTED***")
      }
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
  private readonly workspaceRoot: string

  constructor(options: SessionStorageOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.path = join(options.workspaceRoot, ".open-vs-code", "sessions.jsonl")
    this.maxRetained = options.maxRetained ?? 50
  }

  async load(): Promise<SessionSummary[]> {
    try {
      const content = await readFile(this.path, "utf8")
      const lines = content.split("\n").filter(line => line.trim())
      const valid: SessionSummary[] = []
      for (const line of lines) {
         try {
             valid.push(JSON.parse(line))
         } catch {
             // corrupt line, skip
console.log("CORRUPT LINE")
         }
      }
      console.log("LOADED:", valid.length);
      return valid
    } catch (e: any) {
      if (e.code === "ENOENT") { console.log("ENOENT LOAD"); return [] } else { console.log("LOAD ERR", e.message) }
      console.warn("Failed to load session memory or corruption found, returning empty", e.message)
      return []
    }
  }

  private async ensureSafePath(): Promise<void> {
    const root = await realpath(this.workspaceRoot)
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true })
    const resolvedDir = await realpath(dir)
    const pathFromRoot = relative(root, resolvedDir)
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
       throw new Error("Path is outside workspace: " + this.path)
    }
  }

  async append(summary: SessionSummary): Promise<void> {
    const safeSummary = redactSecrets(summary)
    
    let existing: SessionSummary[] = []
    try {
      existing = await this.load()
    } catch {
      // ignore
    }

    existing.push(safeSummary)
    if (existing.length > this.maxRetained) {
      existing = existing.slice(existing.length - this.maxRetained)
    }

    const content = existing.map(s => JSON.stringify(s)).join("\n") + "\n"
    await this.ensureSafePath()
    
    // Atomic write
    const tempPath = this.path + ".tmp"
    await writeFile(tempPath, content, "utf8")
    
    // Rename
    await rename(tempPath, this.path)
  }
}
