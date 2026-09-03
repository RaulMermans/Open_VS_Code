import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises"
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

const REDACTED_KEYS = ["password", "secret", "token", "key", "authorization", "bearer", "api_key", "aws_access_key", "credential"]

export function redactSecrets(summary: SessionSummary): SessionSummary {
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
  if (summary.decisions) result.decisions = summary.decisions.map(redact)
  if (summary.unresolvedIssues) result.unresolvedIssues = summary.unresolvedIssues.map(redact)

  return result as SessionSummary
}

function truncateToLimit(summary: SessionSummary, limitBytes: number): SessionSummary {
  const s = { ...summary }
  let json = JSON.stringify(s)
  if (Buffer.byteLength(json, "utf8") <= limitBytes) return s

  // Truncate fields structurally if too large.
  // Order of keeping: task, outcome, changedFiles, verification, decisions, unresolvedIssues, nextAction
  if (s.nextAction) {
    s.nextAction = s.nextAction.substring(0, 100) + "..."
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.unresolvedIssues && s.unresolvedIssues.length > 0) {
    s.unresolvedIssues = s.unresolvedIssues.slice(0, 3)
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.decisions && s.decisions.length > 0) {
    s.decisions = s.decisions.slice(0, 3)
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.verification) {
    s.verification = s.verification.substring(0, 100) + "..."
  }
  if (Buffer.byteLength(JSON.stringify(s), "utf8") <= limitBytes) return s

  if (s.task) {
    s.task = s.task.substring(0, 200) + "..."
  }
  return s
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
             valid.push(JSON.parse(line))
         } catch {
             corruptEntries++
         }
      }
      return { sessions: valid, corruptEntries, hasCorruption: corruptEntries > 0 }
    } catch (e: any) {
      if (e.code === "ENOENT") {
         return { sessions: [], corruptEntries: 0, hasCorruption: false }
      }
      // If we cannot even read the file, treat as corrupted.
      return { sessions: [], corruptEntries: 1, hasCorruption: true }
    }
  }

  private async ensureSafePath(): Promise<void> {
    // Basic root check
    let root: string
    try {
      root = await realpath(this.workspaceRoot)
    } catch {
      // If root doesn't exist, we can't write anyway, but path.resolve is safe.
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

  async append(summary: SessionSummary): Promise<void> {
    const loadResult = await this.load()
    if (loadResult.hasCorruption) {
       throw new Error("MEMORY_CORRUPT: Cannot append to session storage with unresolved corruption.")
    }

    let existing = loadResult.sessions

    let safeSummary = redactSecrets(summary)
    safeSummary = truncateToLimit(safeSummary, this.maxSessionBytes)

    existing.push(safeSummary)
    if (existing.length > this.maxRetainedSessions) {
      existing = existing.slice(existing.length - this.maxRetainedSessions)
    }

    // Apply total storage bytes logic
    let lines = existing.map(s => JSON.stringify(s))
    while (lines.length > 0) {
      const totalBytes = lines.reduce((acc, l) => acc + Buffer.byteLength(l, "utf8") + 1, 0)
      if (totalBytes <= this.maxTotalStorageBytes) {
        break
      }
      // Drop oldest
      lines.shift()
      existing.shift()
    }

    const content = lines.join("\n") + (lines.length > 0 ? "\n" : "")
    await this.ensureSafePath()

    const tempPath = this.path + "." + Date.now() + ".tmp"
    try {
      await writeFile(tempPath, content, "utf8")
      await rename(tempPath, this.path)
    } catch (e) {
      try {
        await rm(tempPath, { force: true })
      } catch {
        // Ignore
      }
      throw e
    }
  }
}
