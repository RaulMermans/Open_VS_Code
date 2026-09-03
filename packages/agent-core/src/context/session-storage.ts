import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { join, dirname, relative, isAbsolute } from "node:path"
import { realpath } from "node:fs/promises"
import type { SessionSummary } from "./memory.ts"

export interface SessionStorageOptions {
  readonly workspaceRoot: string
  readonly maxRetainedSessions?: number
  readonly maxRestoredSessions?: number
  readonly maxSessionBytes?: number
  readonly maxTotalStorageBytes?: number
}

export interface SessionLoadResult {
  readonly sessions: SessionSummary[]
  readonly corruptEntries: number
  readonly hasCorruption: boolean
}

export type AppendResult = "SAVED" | "SKIPPED_CORRUPT_STATE" | "FAILED" | "REJECTED_OVERSIZED";

const REDACTED_KEYS = ["password", "secret", "token", "key", "authorization", "bearer", "api_key", "aws_access_key", "credential"]

export function redactSecrets(summary: SessionSummary): SessionSummary {
  const redact = (text: string) => {
    let result = text
    for (const key of REDACTED_KEYS) {
      // General key-value matching
      const regex = new RegExp(`(${key}['"]?\\s*[:=]\\s*['"]?)[^\\s'"]+`, "gi")
      result = result.replace(regex, "$1***REDACTED***")
    }

    // Explicitly handle "Authorization: Bearer <secret>" or "Bearer <secret>"
    // Make sure we catch "Authorization: Bearer <secret>" as a single block or standalone "Bearer"
    const authRegex = new RegExp(`(Authorization:\\s*Bearer\\s+)[^\\s'"]+`, "gi")
    result = result.replace(authRegex, "$1***REDACTED***")

    const bearerRegex = new RegExp(`(Bearer\\s+)[^\\s'"]+`, "gi")
    result = result.replace(bearerRegex, "$1***REDACTED***")

    return result
  }

  const result: any = { ...summary, task: redact(summary.task) }
  if (summary.nextAction) result.nextAction = redact(summary.nextAction)
  if (summary.verification) result.verification = redact(summary.verification)
  if (summary.decisions) result.decisions = summary.decisions.map(redact)
  if (summary.unresolvedIssues) result.unresolvedIssues = summary.unresolvedIssues.map(redact)

  return result as SessionSummary
}

function truncateToLimit(summary: SessionSummary, limitBytes: number): SessionSummary {
  const s = { ...summary }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  // Order of keeping: outcome, task, changedFiles, verification, unresolvedIssues, decisions, nextAction
  if (s.nextAction) {
    s.nextAction = s.nextAction.substring(0, 100) + "..."
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.decisions && s.decisions.length > 0) {
    s.decisions = s.decisions.slice(0, 3).map(d => d.substring(0, 100) + "...")
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.unresolvedIssues && s.unresolvedIssues.length > 0) {
    s.unresolvedIssues = s.unresolvedIssues.slice(0, 3).map(i => i.substring(0, 100) + "...")
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.verification) {
    s.verification = s.verification.substring(0, 100) + "..."
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.changedFiles && s.changedFiles.length > 10) {
    s.changedFiles = s.changedFiles.slice(0, 10)
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.task) {
    s.task = s.task.substring(0, 200) + "..."
  }
  return s
}

function validateSchema(obj: any): obj is SessionSummary {
  if (!obj || typeof obj !== "object") return false
  if (typeof obj.sessionId !== "string") return false
  if (typeof obj.mode !== "string") return false
  if (typeof obj.task !== "string") return false
  if (typeof obj.outcome !== "string") return false
  if (!Array.isArray(obj.changedFiles)) return false
  return true
}

export class SessionSummaryStorage {
  private readonly path: string
  private readonly maxRetainedSessions: number
  private readonly maxSessionBytes: number
  private readonly maxTotalStorageBytes: number
  private readonly workspaceRoot: string

  constructor(options: SessionStorageOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.path = join(options.workspaceRoot, ".open-vs-code", "sessions.jsonl")
    this.maxRetainedSessions = options.maxRetainedSessions ?? 50
    this.maxSessionBytes = options.maxSessionBytes ?? 16384 // 16 KB
    this.maxTotalStorageBytes = options.maxTotalStorageBytes ?? 524288 // 512 KB
  }

  async load(): Promise<SessionLoadResult> {
    try {
      const content = await readFile(this.path, "utf8")
      const lines = content.split("\n").filter(line => line.trim())
      const valid: SessionSummary[] = []
      let corruptEntries = 0
      for (const line of lines) {
         try {
             const parsed = JSON.parse(line)
             if (validateSchema(parsed)) {
                 valid.push(parsed)
             } else {
                 corruptEntries++
             }
         } catch {
             corruptEntries++
         }
      }
      return { sessions: valid, corruptEntries, hasCorruption: corruptEntries > 0 }
    } catch (e: any) {
      if (e.code === "ENOENT") {
         return { sessions: [], corruptEntries: 0, hasCorruption: false }
      }
      return { sessions: [], corruptEntries: 1, hasCorruption: true }
    }
  }

  private async ensureSafePath(): Promise<void> {
    let root: string
    try {
      root = await realpath(this.workspaceRoot)
    } catch {
      return
    }
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true })
    const resolvedDir = await realpath(dir)
    const pathFromRoot = relative(root, resolvedDir)
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
       throw new Error("Path is outside workspace: " + this.path)
    }
  }

  async append(summary: SessionSummary): Promise<AppendResult> {
    const loadResult = await this.load()
    if (loadResult.hasCorruption) {
       return "SKIPPED_CORRUPT_STATE"
    }

    let existing = loadResult.sessions
    let safeSummary = redactSecrets(summary)
    safeSummary = truncateToLimit(safeSummary, this.maxSessionBytes)

    if (Buffer.byteLength(JSON.stringify(safeSummary), "utf8") > this.maxSessionBytes) {
      return "REJECTED_OVERSIZED"
    }

    existing.push(safeSummary)
    if (existing.length > this.maxRetainedSessions) {
      existing = existing.slice(existing.length - this.maxRetainedSessions)
    }

    let lines = existing.map(s => JSON.stringify(s))
    while (lines.length > 0) {
      const totalBytes = lines.reduce((acc, l) => acc + Buffer.byteLength(l, "utf8") + 1, 0)
      if (totalBytes <= this.maxTotalStorageBytes) {
        break
      }
      lines.shift()
      existing.shift()
    }

    const content = lines.join("\n") + (lines.length > 0 ? "\n" : "")

    try {
      await this.ensureSafePath()
      const tempPath = this.path + "." + Date.now() + ".tmp"
      await writeFile(tempPath, content, "utf8")
      await rename(tempPath, this.path)
      return "SAVED"
    } catch {
      return "FAILED"
    }
  }
}
