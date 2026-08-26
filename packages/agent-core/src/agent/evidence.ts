import type { EvidenceRequirement } from "./task-profile.ts"

export interface FileReadRecord {
  readonly path: string
  readonly bytes: number
  readonly callId: string
}

export interface SearchRecord {
  readonly query: string
  readonly hitCount: number
  readonly tool: "search_text" | "find_files"
  readonly callId: string
}

export interface DirectoryRecord {
  readonly path: string
  readonly entryCount: number
  readonly callId: string
}

export interface EvidenceEvaluation {
  readonly satisfied: boolean
  readonly missing: readonly EvidenceRequirement[]
  readonly filesInspected: readonly string[]
  readonly totalEvidenceCount: number
  readonly summary: string
}

export class EvidenceLedger {
  readonly #filesRead = new Map<string, FileReadRecord>()
  readonly #searches: SearchRecord[] = []
  readonly #directoriesListed = new Map<string, DirectoryRecord>()
  #totalObservations = 0

  recordObservation(
    toolName: string,
    callId: string,
    inputArgs: Record<string, unknown>,
    ok: boolean,
    output: unknown,
  ): void {
    if (!ok) return
    this.#totalObservations++

    if (toolName === "read_file" && typeof inputArgs.path === "string") {
      const normalizedPath = inputArgs.path.replace(/^\.\//, "")
      const content =
        typeof output === "string"
          ? output
          : typeof (output as { content?: string })?.content === "string"
            ? (output as { content: string }).content
            : ""
      this.#filesRead.set(normalizedPath, {
        path: normalizedPath,
        bytes: content.length,
        callId,
      })
    } else if (toolName === "search_text" && typeof inputArgs.query === "string") {
      const results = Array.isArray(output)
        ? output
        : Array.isArray((output as { results?: unknown[] })?.results)
          ? (output as { results: unknown[] }).results
          : []
      this.#searches.push({
        query: inputArgs.query,
        hitCount: results.length,
        tool: "search_text",
        callId,
      })
    } else if (toolName === "find_files" && typeof inputArgs.pattern === "string") {
      const matches = Array.isArray(output)
        ? output
        : Array.isArray((output as { paths?: unknown[] })?.paths)
          ? (output as { paths: unknown[] }).paths
          : []
      this.#searches.push({
        query: inputArgs.pattern,
        hitCount: matches.length,
        tool: "find_files",
        callId,
      })
    } else if (toolName === "list_directory") {
      const dirPath = typeof inputArgs.path === "string" ? inputArgs.path.replace(/^\.\//, "") : "."
      const entries = Array.isArray(output)
        ? output
        : Array.isArray((output as { entries?: unknown[] })?.entries)
          ? (output as { entries: unknown[] }).entries
          : []
      this.#directoriesListed.set(dirPath, {
        path: dirPath,
        entryCount: entries.length,
        callId,
      })
    }
  }

  get filesRead(): readonly string[] {
    return Array.from(this.#filesRead.keys())
  }

  get searches(): readonly SearchRecord[] {
    return this.#searches
  }

  get directoriesListed(): readonly string[] {
    return Array.from(this.#directoriesListed.keys())
  }

  get totalObservations(): number {
    return this.#totalObservations
  }

  evaluate(
    requirements: readonly EvidenceRequirement[],
    explicitFiles?: readonly string[],
  ): EvidenceEvaluation {
    const missing: EvidenceRequirement[] = []
    const filesReadList = this.filesRead

    // If explicit files are mentioned in task, ensure at least one is read if 1 file, or all if multiple
    if (explicitFiles && explicitFiles.length > 0) {
      const unreadExplicit = explicitFiles.filter(
        (f) => !filesReadList.some((rf) => {
          const fBase = f.split("/").pop()
          const rfBase = rf.split("/").pop()
          return rf === f || rf.endsWith(`/${f}`) || f.endsWith(`/${rf}`) || (fBase && fBase === rfBase)
        }),
      )
      if (unreadExplicit.length > 0 && filesReadList.length < explicitFiles.length) {
        missing.push({
          id: "explicit-files-unread",
          kind: "FILE_READ",
          minCount: unreadExplicit.length,
          description: `Read the required file(s): ${unreadExplicit.join(", ")} using read_file`,
        })
      }
    }

    for (const req of requirements) {
      const minCount = req.minCount ?? 1
      switch (req.kind) {
        case "FILE_READ": {
          if (filesReadList.length < minCount) {
            missing.push(req)
          }
          break
        }
        case "SEARCH_PERFORMED": {
          const totalSearches = this.#searches.length + (this.#directoriesListed.size > 0 ? 1 : 0) + this.#filesRead.size
          if (totalSearches < minCount) {
            missing.push(req)
          }
          break
        }
        case "CROSS_FILE_EVIDENCE": {
          if (filesReadList.length < minCount && this.#totalObservations < minCount) {
            missing.push(req)
          }
          break
        }
        case "TEST_AND_IMPLEMENTATION": {
          const hasTest = filesReadList.some((f) => /test|spec/i.test(f))
          const hasImpl = filesReadList.some((f) => !/test|spec/i.test(f))
          if (!(hasTest && hasImpl) && filesReadList.length < 2 && this.#totalObservations < 2) {
            missing.push(req)
          }
          break
        }
        case "DIRECTORY_LISTED": {
          if (this.#directoriesListed.size < minCount) {
            missing.push(req)
          }
          break
        }
        case "ANY_TOOL_OBSERVATION": {
          if (this.#totalObservations < minCount) {
            missing.push(req)
          }
          break
        }
      }
    }

    const satisfied =
      missing.length === 0 &&
      (this.#totalObservations > 0 ||
        (requirements.length === 0 && (!explicitFiles || explicitFiles.length === 0)))

    const summary = satisfied
      ? `Evidence satisfied (${filesReadList.length} files read, ${this.#searches.length} searches, ${this.#totalObservations} observations)`
      : `Missing evidence: ${missing.map((m) => m.description).join("; ")}`

    return {
      satisfied,
      missing,
      filesInspected: filesReadList,
      totalEvidenceCount: this.#totalObservations,
      summary,
    }
  }
}
