import { readFile, writeFile, rename, unlink, mkdir, realpath, access, lstat } from "node:fs/promises"
import { resolve, relative, dirname, isAbsolute, join, basename } from "node:path"
import { createHash } from "node:crypto"
import { danglingRenamedBinding } from "../agent/tool-contract.ts"
import {
  type MutationRequest,
  type PreparedMutation,
  type MutationResult,
  type MutationSnapshot,
  type MutationDiff,
  type FileChange,
  type MutationBudgets,
  type MutationPolicy,
  MutationFailure,
  DEFAULT_MUTATION_BUDGETS,
  DEFAULT_MUTATION_POLICY,
} from "./mutation-contracts.ts"

// --- Hashing ---

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

/** Unique search/replace that yields `after` from `before` without replacing the whole file. */
export function deriveUniquePatch(before: string, after: string): { search: string; replace: string } | undefined {
  if (before === after || before.length === 0 || after.length === 0) return undefined
  const nonempty = before.split("\n").filter((line) => line.trim().length > 0)
  if (nonempty.length > 0) {
    const retained = nonempty.filter((line) => after.includes(line)).length
    if (retained / nonempty.length < 0.5) return undefined
  }
  let prefix = 0
  const shared = Math.min(before.length, after.length)
  while (prefix < shared && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  if (prefix === 0 && suffix === 0) return undefined
  let left = prefix
  let right = suffix
  const slice = () => ({
    search: before.slice(left, before.length - right),
    replace: after.slice(left, after.length - right),
  })
  let { search, replace } = slice()
  if (search.length === 0) {
    if (prefix > 0) left = Math.max(0, prefix - Math.min(32, prefix))
    else if (suffix > 0) right = Math.max(0, suffix - Math.min(32, suffix))
    else return undefined
    ;({ search, replace } = slice())
  }
  const occurrenceCount = (needle: string): number => {
    if (!needle) return 0
    let count = 0
    let from = 0
    while (from <= before.length - needle.length) {
      const at = before.indexOf(needle, from)
      if (at === -1) break
      count += 1
      from = at + 1
    }
    return count
  }
  while (occurrenceCount(search) !== 1 && (left > 0 || right > 0)) {
    if (left > 0) left -= 1
    else right -= 1
    ;({ search, replace } = slice())
  }
  if (occurrenceCount(search) !== 1 || search === before) return undefined
  const at = before.indexOf(search)
  const applied = before.slice(0, at) + replace + before.slice(at + search.length)
  if (applied !== after) return undefined
  return { search, replace }
}

export function existingFileCreateObservation(path: string, content: string): string {
  const maxBytes = 2048
  let bounded = content
  let truncated = false
  if (Buffer.byteLength(content) > maxBytes) {
    truncated = true
    bounded = ""
    let bytes = 0
    for (const character of content) {
      const size = Buffer.byteLength(character)
      if (bytes + size > maxBytes) break
      bounded += character
      bytes += size
    }
  }
  return [
    `FILE_ALREADY_EXISTS: create_file cannot overwrite ${path}. The file already exists.`,
    "Do not call create_file again for this path. Do not overwrite it.",
    `Read ${path} if you need more of the file, then call apply_patch with path ${path}, a search string copied exactly from the current file, and a replace string that keeps unrelated existing code.`,
    `Current contents of ${path}${truncated ? " (truncated)" : ""}:`,
    bounded,
  ].join("\n")
}

/** The first exported function name that the text declares more than once. */
export function duplicateExportFunction(source: string): string | undefined {
  const counts = new Map<string, number>()
  for (const match of source.matchAll(/^export function ([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1]
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  for (const [name, count] of counts) {
    if (count > 1) return name
  }
  return undefined
}

// --- Path Safety for Writes ---

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export async function resolveWritePath(
  workspaceRoot: string,
  requestedPath: string,
  options: { mustExist: boolean },
): Promise<string> {
  const root = await realpath(workspaceRoot)
  let normPath = requestedPath
  if (isAbsolute(requestedPath)) {
    let relCandidate = relative(workspaceRoot, requestedPath)
    if (relCandidate.startsWith("..") || isAbsolute(relCandidate)) {
      relCandidate = relative(root, requestedPath)
    }
    if (relCandidate.startsWith("..") || isAbsolute(relCandidate)) {
      try {
        const realParent = await realpath(dirname(requestedPath))
        const resolvedAbs = join(realParent, basename(requestedPath))
        relCandidate = relative(root, resolvedAbs)
      } catch {}
    }
    if (!relCandidate.startsWith("..") && !isAbsolute(relCandidate)) {
      normPath = relCandidate
    }
  }
  const candidate = resolve(root, normPath)

  // Check pre-resolution containment
  if (!isContainedPath(root, candidate)) {
    throw new MutationFailure("OUTSIDE_WORKSPACE", `Path is outside workspace: ${requestedPath}`)
  }

  if (options.mustExist) {
    // File must exist - resolve symlinks and recheck
    let resolved: string
    try {
      resolved = await realpath(candidate)
    } catch {
      throw new MutationFailure("FILE_NOT_FOUND", `File does not exist: ${requestedPath}`)
    }
    if (!isContainedPath(root, resolved)) {
      throw new MutationFailure("SYMLINK_ESCAPE", `Resolved path escapes workspace: ${requestedPath}`)
    }
    return resolved
  }

  // File should NOT exist. A missing parent inside the workspace is created on apply.
  // An existing parent that resolves outside the workspace is rejected.
  const parentDir = dirname(candidate)
  let cursor = parentDir
  const missing: string[] = []
  while (true) {
    try {
      const resolvedParent = await realpath(cursor)
      if (!isContainedPath(root, resolvedParent)) {
        throw new MutationFailure("SYMLINK_ESCAPE", `Parent directory resolves outside workspace: ${requestedPath}`)
      }
      const resolvedCandidate = join(resolvedParent, ...missing.slice().toReversed(), basename(candidate))
      if (!isContainedPath(root, resolvedCandidate)) {
        throw new MutationFailure("PATH_ESCAPE", `Resolved path escapes workspace: ${requestedPath}`)
      }
      return resolvedCandidate
    } catch (error) {
      if (error instanceof MutationFailure) throw error
      const missingParent = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
      if (!missingParent) throw error
      if (cursor === root || cursor === dirname(cursor)) {
        throw new MutationFailure("PARENT_NOT_FOUND", `Parent directory does not exist: ${requestedPath}`)
      }
      missing.push(basename(cursor))
      const next = dirname(cursor)
      if (!isContainedPath(root, next)) {
        throw new MutationFailure("OUTSIDE_WORKSPACE", `Path is outside workspace: ${requestedPath}`)
      }
      cursor = next
    }
  }
}

// --- Policy Checks ---

export function checkMutationPolicy(
  workspaceRoot: string,
  resolvedPath: string,
  policy: MutationPolicy,
): MutationFailure | null {
  const rel = relative(workspaceRoot, resolvedPath).replaceAll("\\", "/")

  // Check excluded directories
  for (const exclusion of policy.mutationExclusions) {
    const normalized = exclusion.replaceAll("\\", "/")
    if (rel.startsWith(normalized) || rel.includes(`/${normalized}`)) {
      return new MutationFailure("SENSITIVE_PATH", `Path is in excluded directory: ${rel}`)
    }
  }

  return null  // no policy violation - sensitive patterns handled at permission level
}

export function isSensitivePath(workspaceRoot: string, resolvedPath: string, policy: MutationPolicy): boolean {
  const rel = relative(workspaceRoot, resolvedPath).replaceAll("\\", "/")
  const filename = rel.split("/").pop() ?? ""
  return policy.sensitivePatterns.some((pattern) => pattern.test(filename) || pattern.test(rel))
}

// --- Binary Detection ---

const BINARY_EXTENSIONS = new Set([".bin", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".webp", ".zip", ".gz", ".tar", ".gguf", ".safetensors", ".ckpt", ".exe", ".dll", ".so", ".dylib", ".wasm"])

function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function containsBinaryBytes(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8192))
  return sample.includes(0)
}

// --- Diff Generation ---

export function generateUnifiedDiff(
  path: string,
  beforeContent: string,
  afterContent: string,
  maxBytes: number,
): MutationDiff {
  const beforeLines = beforeContent.split("\n")
  const afterLines = afterContent.split("\n")

  // Simple unified diff generation
  const diffLines: string[] = []
  diffLines.push(`--- a/${path}`)
  diffLines.push(`+++ b/${path}`)

  let linesAdded = 0
  let linesRemoved = 0

  // Find first difference
  let firstDiff = 0
  while (firstDiff < beforeLines.length && firstDiff < afterLines.length && beforeLines[firstDiff] === afterLines[firstDiff]) {
    firstDiff++
  }

  // Find last difference
  let lastDiffBefore = beforeLines.length - 1
  let lastDiffAfter = afterLines.length - 1
  while (lastDiffBefore > firstDiff && lastDiffAfter > firstDiff && beforeLines[lastDiffBefore] === afterLines[lastDiffAfter]) {
    lastDiffBefore--
    lastDiffAfter--
  }

  // Context lines
  const contextSize = 3
  const hunkStartBefore = Math.max(0, firstDiff - contextSize)
  const hunkEndBefore = Math.min(beforeLines.length - 1, lastDiffBefore + contextSize)
  const hunkStartAfter = Math.max(0, firstDiff - contextSize)
  const hunkEndAfter = Math.min(afterLines.length - 1, lastDiffAfter + contextSize)

  const hunkLenBefore = hunkEndBefore - hunkStartBefore + 1
  const hunkLenAfter = hunkEndAfter - hunkStartAfter + 1

  if (firstDiff <= lastDiffBefore || firstDiff <= lastDiffAfter || beforeContent !== afterContent) {
    diffLines.push(`@@ -${hunkStartBefore + 1},${hunkLenBefore} +${hunkStartAfter + 1},${hunkLenAfter} @@`)

    // Context before change
    for (let i = hunkStartBefore; i < firstDiff; i++) {
      diffLines.push(` ${beforeLines[i]}`)
    }

    // Removed lines
    for (let i = firstDiff; i <= lastDiffBefore; i++) {
      diffLines.push(`-${beforeLines[i]}`)
      linesRemoved++
    }

    // Added lines
    for (let i = firstDiff; i <= lastDiffAfter; i++) {
      diffLines.push(`+${afterLines[i]}`)
      linesAdded++
    }

    // Context after change
    for (let i = lastDiffBefore + 1; i <= hunkEndBefore; i++) {
      if (i < beforeLines.length) diffLines.push(` ${beforeLines[i]}`)
    }
  }

  let unified = diffLines.join("\n")
  let truncated = false
  if (Buffer.byteLength(unified) > maxBytes) {
    // Truncate at a line boundary
    const lines = unified.split("\n")
    let bytes = 0
    let cutIndex = lines.length
    for (let i = 0; i < lines.length; i++) {
      bytes += Buffer.byteLength(lines[i]!) + 1
      if (bytes > maxBytes) {
        cutIndex = i
        break
      }
    }
    unified = lines.slice(0, cutIndex).join("\n") + "\n[diff truncated]"
    truncated = true
  }

  const bytesChanged = Buffer.byteLength(afterContent) - Buffer.byteLength(beforeContent)

  return {
    path,
    operation: "patch",
    linesAdded,
    linesRemoved,
    bytesChanged: Math.abs(bytesChanged),
    unified,
    truncated,
  }
}

export function generateCreateDiff(
  path: string,
  content: string,
  maxBytes: number,
): MutationDiff {
  const lines = content.split("\n")
  const diffLines = [
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ]

  let unified = diffLines.join("\n")
  let truncated = false
  if (Buffer.byteLength(unified) > maxBytes) {
    const allLines = unified.split("\n")
    let bytes = 0
    let cutIndex = allLines.length
    for (let i = 0; i < allLines.length; i++) {
      bytes += Buffer.byteLength(allLines[i]!) + 1
      if (bytes > maxBytes) {
        cutIndex = i
        break
      }
    }
    unified = allLines.slice(0, cutIndex).join("\n") + "\n[diff truncated]"
    truncated = true
  }

  return {
    path,
    operation: "create",
    linesAdded: lines.length,
    linesRemoved: 0,
    bytesChanged: Buffer.byteLength(content),
    unified,
    truncated,
  }
}

// --- Budget Validation ---

export function checkBudgets(diff: MutationDiff, budgets: MutationBudgets): MutationFailure | null {
  if (diff.linesAdded > budgets.maxAddedLines) {
    return new MutationFailure("BUDGET_EXCEEDED", `Added lines ${diff.linesAdded} exceeds budget ${budgets.maxAddedLines}`)
  }
  if (diff.linesRemoved > budgets.maxRemovedLines) {
    return new MutationFailure("BUDGET_EXCEEDED", `Removed lines ${diff.linesRemoved} exceeds budget ${budgets.maxRemovedLines}`)
  }
  if (diff.bytesChanged > budgets.maxTotalChangedBytes) {
    return new MutationFailure("BUDGET_EXCEEDED", `Changed bytes ${diff.bytesChanged} exceeds budget ${budgets.maxTotalChangedBytes}`)
  }
  if (Buffer.byteLength(diff.unified) > budgets.maxDiffBytes) {
    return new MutationFailure("OVERSIZED_DIFF", `Diff size exceeds budget ${budgets.maxDiffBytes}`)
  }
  return null
}

// --- Patch Location ---

export type PatchMatchKind = "EXACT" | "WHITESPACE_NORMALIZED"

export type PatchLocation =
  | { readonly ok: true; readonly afterContent: string; readonly matchKind: PatchMatchKind; readonly startLine: number }
  | { readonly ok: false; readonly code: "PATCH_MISMATCH" | "PATCH_AMBIGUOUS"; readonly detail: string }

const MAX_HINT_LINES = 24
const MAX_HINT_BYTES = 2_400

function key(line: string): string {
  return line.trim()
}

function leadingWhitespace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}

function numbered(lines: readonly string[], firstLine: number): string {
  let text = ""
  for (let index = 0; index < lines.length && index < MAX_HINT_LINES; index += 1) {
    const next = `${String(firstLine + index).padStart(4)}| ${lines[index]!.replace(/\r$/, "")}\n`
    if (text.length + next.length > MAX_HINT_BYTES) break
    text += next
  }
  return text
}

/** True when every non-blank file line is its search line shifted by one shared indentation prefix. */
function uniformIndentOffset(searchLines: readonly string[], fileLines: readonly string[]): boolean {
  let shared: string | undefined
  for (let index = 0; index < searchLines.length; index += 1) {
    const search = searchLines[index]!
    const file = fileLines[index]!
    if (!search.trim() || !file.trim()) continue
    const s = leadingWhitespace(search)
    const f = leadingWhitespace(file)
    const delta = f.endsWith(s) ? `+${f.slice(0, f.length - s.length)}` : s.endsWith(f) ? `-${s.slice(0, s.length - f.length)}` : undefined
    if (delta === undefined || (shared !== undefined && delta !== shared)) return false
    shared = delta
  }
  return true
}

/**
 * Re-indents replacement lines by the uniform indentation offset between the model's search text and the
 * matched file lines. Only a consistent prefix is added or removed; anything else is left untouched.
 */
function reindent(replaceLines: readonly string[], searchFirst: string, fileFirst: string): string[] {
  const searchIndent = leadingWhitespace(searchFirst)
  const fileIndent = leadingWhitespace(fileFirst)
  if (searchIndent === fileIndent) return [...replaceLines]
  if (fileIndent.endsWith(searchIndent)) {
    const prefix = fileIndent.slice(0, fileIndent.length - searchIndent.length)
    return replaceLines.map((line) => (line.trim() ? prefix + line : line))
  }
  if (searchIndent.endsWith(fileIndent)) {
    const extra = searchIndent.slice(0, searchIndent.length - fileIndent.length)
    if (replaceLines.every((line) => !line.trim() || line.startsWith(extra))) {
      return replaceLines.map((line) => (line.trim() ? line.slice(extra.length) : line))
    }
  }
  return [...replaceLines]
}

/**
 * Locates a search/replace edit in file content.
 *
 * 1. Exact substring that occurs exactly once.
 * 2. Otherwise, a unique window of whole lines equal to the search lines after trimming each line
 *    (indentation, trailing spaces and CRLF differences). The replacement is re-indented by the observed
 *    offset and the original line endings are kept. Text outside the window is preserved byte-for-byte.
 * 3. Otherwise a typed failure whose detail carries the closest region with line numbers, so the caller can
 *    correct the search text without another read.
 *
 * Pure function: no I/O. The caller still validates, diffs, budgets and requires approval.
 */
export function locatePatch(content: string, search: string, replace: string, displayPath: string): PatchLocation {
  const first = content.indexOf(search)
  if (first !== -1) {
    const second = content.indexOf(search, first + 1)
    if (second !== -1) {
      const lineOf = (offset: number) => content.slice(0, offset).split("\n").length
      return { ok: false, code: "PATCH_AMBIGUOUS", detail: `PATCH_AMBIGUOUS: search matched more than once in ${displayPath} (lines ${lineOf(first)} and ${lineOf(second)}). Include more surrounding lines so search matches exactly once.` }
    }
    return { ok: true, afterContent: content.slice(0, first) + replace + content.slice(first + search.length), matchKind: "EXACT", startLine: content.slice(0, first).split("\n").length }
  }

  const fileLines = content.split("\n")
  const trimmedSearch = search.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "")
  const searchLines = trimmedSearch.split("\n")
  const searchKeys = searchLines.map(key)
  const nonEmptyKeys = searchKeys.filter(Boolean)
  const matches: number[] = []
  if (nonEmptyKeys.length > 0 && nonEmptyKeys.join("").length >= 3) {
    for (let start = 0; start + searchLines.length <= fileLines.length; start += 1) {
      let equal = true
      for (let offset = 0; offset < searchLines.length; offset += 1) {
        if (key(fileLines[start + offset]!) !== searchKeys[offset]) { equal = false; break }
      }
      if (equal) matches.push(start)
    }
  }
  if (matches.length > 1) {
    return { ok: false, code: "PATCH_AMBIGUOUS", detail: `PATCH_AMBIGUOUS: search matched ${matches.length} places in ${displayPath} (lines ${matches.slice(0, 4).map((line) => line + 1).join(", ")}) when indentation is ignored. Include more surrounding lines so search matches exactly once.` }
  }
  if (matches.length === 1 && !uniformIndentOffset(searchLines, fileLines.slice(matches[0]!, matches[0]! + searchLines.length))) {
    const start = matches[0]!
    return {
      ok: false,
      code: "PATCH_MISMATCH",
      detail: `PATCH_MISMATCH: search matches lines ${start + 1}-${start + searchLines.length} of ${displayPath} only if indentation is ignored, and the indentation differs unevenly. Copy search and replace with the file's exact indentation:\n${numbered(fileLines.slice(start, start + searchLines.length), start + 1)}`,
    }
  }
  if (matches.length === 1) {
    const start = matches[0]!
    const window = fileLines.slice(start, start + searchLines.length)
    const crlf = window.length > 0 && window.every((line) => line.endsWith("\r"))
    const trimmedReplace = replace.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "")
    const rawReplaceLines = trimmedReplace === "" ? [] : trimmedReplace.split("\n").map((line) => line.replace(/\r$/, ""))
    const firstSearch = searchLines.find((line) => line.trim()) ?? ""
    const firstFile = window[searchLines.indexOf(firstSearch)] ?? window[0] ?? ""
    const replaceLines = reindent(rawReplaceLines, firstSearch, firstFile).map((line) => (crlf ? `${line}\r` : line))
    const afterLines = [...fileLines.slice(0, start), ...replaceLines, ...fileLines.slice(start + searchLines.length)]
    return { ok: true, afterContent: afterLines.join("\n"), matchKind: "WHITESPACE_NORMALIZED", startLine: start + 1 }
  }

  // No match: return the most similar region so the next attempt can copy exact text.
  let bestStart = -1
  let bestScore = 0
  const searchSet = new Set(nonEmptyKeys)
  const span = Math.max(1, searchLines.length)
  for (let start = 0; start < fileLines.length; start += 1) {
    let score = 0
    for (let offset = 0; offset < span && start + offset < fileLines.length; offset += 1) {
      if (searchSet.has(key(fileLines[start + offset]!))) score += 1
    }
    if (score > bestScore) { bestScore = score; bestStart = start }
  }
  const replaceKey = replace.trim()
  const alreadyThere = replaceKey.length >= 3 && content.includes(replaceKey)
    ? ` The replace text already appears in ${displayPath}; this edit may already be applied, so check before retrying.`
    : ""
  const regionStart = bestStart >= 0 ? Math.max(0, bestStart - 2) : 0
  const regionLines = fileLines.slice(regionStart, regionStart + (bestStart >= 0 ? span + 4 : MAX_HINT_LINES))
  const label = bestStart >= 0 ? `Closest lines in ${displayPath}` : `Start of ${displayPath} (${fileLines.length} lines)`
  return {
    ok: false,
    code: "PATCH_MISMATCH",
    detail: `PATCH_MISMATCH: search was not found in ${displayPath}.${alreadyThere} Copy search exactly from the current file text below (without the line-number prefix), or call read_file first. Do not call create_file.\n${label}:\n${numbered(regionLines, regionStart + 1)}`,
  }
}

// --- Mutation Engine ---

export interface MutationEngineOptions {
  readonly budgets?: MutationBudgets
  readonly policy?: MutationPolicy
  readonly idFactory?: () => string
  readonly timestampFactory?: () => string
}

export class MutationEngine {
  readonly #workspaceRoot: string
  readonly #budgets: MutationBudgets
  readonly #policy: MutationPolicy
  readonly #snapshots: Map<string, MutationSnapshot> = new Map()
  readonly #idFactory: () => string
  readonly #timestampFactory: () => string
  #mutationsThisStep = 0

  constructor(workspaceRoot: string, options?: MutationEngineOptions) {
    this.#workspaceRoot = workspaceRoot
    this.#budgets = options?.budgets ?? DEFAULT_MUTATION_BUDGETS
    this.#policy = options?.policy ?? DEFAULT_MUTATION_POLICY
    let idSeq = 0
    this.#idFactory = options?.idFactory ?? (() => `mutation-${++idSeq}`)
    this.#timestampFactory = options?.timestampFactory ?? (() => new Date().toISOString())
  }

  resetStepCounter(): void {
    this.#mutationsThisStep = 0
  }

  // --- Prepare ---

  async preparePatch(request: MutationRequest): Promise<PreparedMutation> {
    if (request.operation !== "patch") {
      throw new MutationFailure("INVALID_PATCH", "Operation must be 'patch'")
    }
    if (!request.patch) {
      throw new MutationFailure("INVALID_PATCH", "Patch content is required")
    }

    // Budget: files per step
    if (this.#mutationsThisStep >= this.#budgets.maxFilesPerStep) {
      throw new MutationFailure("BUDGET_EXCEEDED", `Max files per step (${this.#budgets.maxFilesPerStep}) exceeded`)
    }

    // Resolve path safely
    const root = await realpath(this.#workspaceRoot)
    const resolvedPath = await resolveWritePath(root, request.path, { mustExist: true })

    // Policy check
    const policyViolation = checkMutationPolicy(root, resolvedPath, this.#policy)
    if (policyViolation) throw policyViolation

    // Read current content
    const rawBytes = await readFile(resolvedPath)
    if (containsBinaryBytes(rawBytes) || hasBinaryExtension(resolvedPath)) {
      throw new MutationFailure("BINARY_FILE", `Cannot patch binary file: ${request.path}`)
    }

    const beforeContent = rawBytes.toString("utf8")
    const baseHash = sha256(beforeContent)

    // Apply patch: find search text and replace
    const relForError = relative(root, resolvedPath).replaceAll("\\", "/")
    const location = locatePatch(beforeContent, request.patch.search, request.patch.replace, relForError)
    if (!location.ok) throw new MutationFailure(location.code, location.detail)
    const afterContent = location.afterContent
    const duplicate = duplicateExportFunction(afterContent)
    if (duplicate) {
      throw new MutationFailure("INVALID_PATCH", `Patch would declare export function ${duplicate} more than once in ${relForError}`)
    }
    const dangling = danglingRenamedBinding(beforeContent, afterContent)
    if (dangling) {
      throw new MutationFailure("INVALID_PATCH", `The patch removes the binding ${dangling} but ${relForError} still calls it. Update that call in the same patch.`)
    }
    const resultHash = sha256(afterContent)

    // Validate result is valid UTF-8 text
    if (containsBinaryBytes(Buffer.from(afterContent, "utf8"))) {
      throw new MutationFailure("ENCODING_ERROR", `Patch result contains binary content`)
    }

    // Generate diff
    const relPath = relative(root, resolvedPath).replaceAll("\\", "/")
    const diff = generateUnifiedDiff(relPath, beforeContent, afterContent, this.#budgets.maxDiffBytes)

    // Budget checks
    const budgetViolation = checkBudgets(diff, this.#budgets)
    if (budgetViolation) throw budgetViolation

    const fileChange: FileChange = {
      path: relPath,
      operation: "patch",
      beforeSize: Buffer.byteLength(beforeContent),
      afterSize: Buffer.byteLength(afterContent),
      beforeHash: baseHash,
      afterHash: resultHash,
    }

    const id = this.#idFactory()
    return {
      id,
      operation: "patch",
      path: relPath,
      resolvedPath,
      beforeContent,
      proposedContent: afterContent,
      baseHash,
      resultHash,
      diff,
      fileChange,
      timestamp: this.#timestampFactory(),
      valid: true,
    }
  }

  async prepareCreate(request: MutationRequest): Promise<PreparedMutation> {
    if (request.operation !== "create") {
      throw new MutationFailure("INVALID_PATCH", "Operation must be 'create'")
    }
    if (request.content === undefined || request.content === null) {
      throw new MutationFailure("INVALID_PATCH", "Content is required for create")
    }

    // Budget: files per step
    if (this.#mutationsThisStep >= this.#budgets.maxFilesPerStep) {
      throw new MutationFailure("BUDGET_EXCEEDED", `Max files per step (${this.#budgets.maxFilesPerStep}) exceeded`)
    }

    // Check new file size
    const contentBytes = Buffer.byteLength(request.content)
    if (contentBytes > this.#budgets.maxNewFileBytes) {
      throw new MutationFailure("OVERSIZED_FILE", `New file size ${contentBytes} exceeds budget ${this.#budgets.maxNewFileBytes}`)
    }

    const root = await realpath(this.#workspaceRoot)
    let existingPath: string | undefined
    try {
      existingPath = await resolveWritePath(root, request.path, { mustExist: true })
    } catch (error) {
      if (!(error instanceof MutationFailure) || error.code !== "FILE_NOT_FOUND") throw error
    }

    if (existingPath) {
      const policyViolation = checkMutationPolicy(root, existingPath, this.#policy)
      if (policyViolation) throw policyViolation
      const rawBytes = await readFile(existingPath)
      if (containsBinaryBytes(rawBytes) || hasBinaryExtension(existingPath)) {
        throw new MutationFailure("BINARY_FILE", `Cannot create over binary file: ${request.path}`)
      }
      const beforeContent = rawBytes.toString("utf8")
      const relPath = relative(root, existingPath).replaceAll("\\", "/")
      if (sha256(beforeContent) === sha256(request.content)) {
        const resultHash = sha256(request.content)
        const diff = generateUnifiedDiff(relPath, beforeContent, request.content, this.#budgets.maxDiffBytes)
        return {
          id: this.#idFactory(),
          operation: "create",
          path: relPath,
          resolvedPath: existingPath,
          beforeContent,
          proposedContent: request.content,
          baseHash: resultHash,
          resultHash,
          diff,
          fileChange: {
            path: relPath,
            operation: "create",
            beforeSize: Buffer.byteLength(beforeContent),
            afterSize: Buffer.byteLength(request.content),
            beforeHash: resultHash,
            afterHash: resultHash,
          },
          timestamp: this.#timestampFactory(),
          valid: true,
        }
      }
      const unique = deriveUniquePatch(beforeContent, request.content)
      if (unique) {
        try {
          return await this.preparePatch({ operation: "patch", path: relPath, patch: unique })
        } catch {
          // Fall through to a typed create rejection. Never convert an ambiguous rewrite.
        }
      }
      throw new MutationFailure("FILE_EXISTS", existingFileCreateObservation(relPath, beforeContent))
    }

    const resolvedPath = await resolveWritePath(root, request.path, { mustExist: false })
    try {
      await access(resolvedPath)
      throw new MutationFailure("FILE_EXISTS", existingFileCreateObservation(request.path, ""))
    } catch (error) {
      if (error instanceof MutationFailure) throw error
    }

    // Policy check
    const policyViolation = checkMutationPolicy(root, resolvedPath, this.#policy)
    if (policyViolation) throw policyViolation

    // Validate content is valid text
    if (containsBinaryBytes(Buffer.from(request.content, "utf8"))) {
      throw new MutationFailure("ENCODING_ERROR", `Content contains binary data`)
    }
    if (hasBinaryExtension(resolvedPath)) {
      throw new MutationFailure("BINARY_FILE", `Cannot create binary file: ${request.path}`)
    }

    const resultHash = sha256(request.content)
    const relPath = relative(root, resolvedPath).replaceAll("\\", "/")
    const diff = generateCreateDiff(relPath, request.content, this.#budgets.maxDiffBytes)

    // Budget checks
    const budgetViolation = checkBudgets(diff, this.#budgets)
    if (budgetViolation) throw budgetViolation

    const fileChange: FileChange = {
      path: relPath,
      operation: "create",
      beforeSize: 0,
      afterSize: contentBytes,
      beforeHash: "",
      afterHash: resultHash,
    }

    const id = this.#idFactory()
    return {
      id,
      operation: "create",
      path: relPath,
      resolvedPath,
      beforeContent: null,
      proposedContent: request.content,
      baseHash: "",
      resultHash,
      diff,
      fileChange,
      timestamp: this.#timestampFactory(),
      valid: true,
    }
  }

  // --- Apply ---

  async applyPreparedMutation(prepared: PreparedMutation): Promise<MutationResult> {
    if (this.#consumed.has(prepared.id)) {
      return this.#failureResult(prepared, "INVALID_PATCH", "already consumed")
    }
    if (!prepared.valid) {
      return this.#failureResult(prepared, "INVALID_PATCH", "Prepared mutation is not valid")
    }

    // Re-verify path safety and containment at apply time to prevent TOCTOU symlink races
    let currentResolvedPath: string
    try {
      currentResolvedPath = await resolveWritePath(this.#workspaceRoot, prepared.path, {
        mustExist: prepared.operation === "patch",
      })
    } catch (err) {
      if (err instanceof MutationFailure) {
        return this.#failureResult(prepared, err.code, err.message)
      }
      return this.#failureResult(prepared, "PATH_ESCAPE", (err as Error).message)
    }

    if (currentResolvedPath !== prepared.resolvedPath) {
      return this.#failureResult(prepared, "STALE_BASE", "Resolved target path changed since preparation")
    }

    // Disallow patching symlinks directly
    if (prepared.operation === "patch") {
      try {
        const root = await realpath(this.#workspaceRoot)
        const candidate = resolve(root, prepared.path)
        const fileStat = await lstat(candidate)
        if (fileStat.isSymbolicLink()) {
          return this.#failureResult(prepared, "SYMLINK_ESCAPE", "Target path is a symlink")
        }
      } catch (err) {
        return this.#failureResult(prepared, "FILE_NOT_FOUND", (err as Error).message)
      }
    }

    let result: MutationResult
    if (prepared.operation === "patch") {
      result = await this.#applyPatch(prepared)
    } else {
      result = await this.#applyCreate(prepared)
    }

    if (result.status === "APPLIED" || result.status === "ALREADY_SATISFIED") {
      this.#consumed.add(prepared.id)
    }
    return result
  }

  async #applyPatch(prepared: PreparedMutation): Promise<MutationResult> {
    // Re-read and verify base hash
    let currentContent: string
    try {
      const rawBytes = await readFile(prepared.resolvedPath)
      currentContent = rawBytes.toString("utf8")
    } catch {
      return this.#failureResult(prepared, "FILE_NOT_FOUND", `File no longer exists: ${prepared.path}`)
    }

    const currentHash = sha256(currentContent)
    if (currentHash === prepared.resultHash) {
      return this.#alreadyAppliedResult(prepared)
    }
    if (currentHash !== prepared.baseHash) {
      return this.#failureResult(prepared, "STALE_BASE", `File changed since preparation (expected ${prepared.baseHash.slice(0, 12)}, got ${currentHash.slice(0, 12)})`)
    }

    // Create snapshot
    const snapshot: MutationSnapshot = {
      id: prepared.id,
      path: prepared.path,
      resolvedPath: prepared.resolvedPath,
      operation: "patch",
      beforeContent: currentContent,
      beforeHash: prepared.baseHash,
      afterHash: prepared.resultHash,
      timestamp: this.#timestampFactory(),
    }

    const expectedResult = prepared.proposedContent;

    // Atomic write: write temp file, then rename
    const tempPath = `${prepared.resolvedPath}.mutation-tmp`
    try {
      await writeFile(tempPath, expectedResult, "utf8")

      // Verify written content
      const writtenBytes = await readFile(tempPath)
      const writtenHash = sha256(writtenBytes.toString("utf8"))
      if (writtenHash !== prepared.resultHash) {
        await unlink(tempPath).catch(() => {})
        return this.#failureResult(prepared, "ATOMIC_WRITE_FAILED", "Written content hash mismatch")
      }

      await rename(tempPath, prepared.resolvedPath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      return this.#failureResult(prepared, "ATOMIC_WRITE_FAILED", `Write failed: ${error instanceof Error ? error.message : "unknown"}`)
    }

    // Store snapshot
    this.#snapshots.set(prepared.id, snapshot)
    this.#mutationsThisStep++

    return {
      id: prepared.id,
      status: "APPLIED",
      path: prepared.path,
      operation: "patch",
      diff: prepared.diff,
      observation: this.#formatObservation(prepared),
    }
  }

  async #applyCreate(prepared: PreparedMutation): Promise<MutationResult> {
    // Verify file still doesn't exist
    try {
      await access(prepared.resolvedPath)
      const existing = await readFile(prepared.resolvedPath)
      if (sha256(existing.toString("utf8")) === prepared.resultHash) {
        return this.#alreadyAppliedResult(prepared)
      }
      return this.#failureResult(prepared, "FILE_EXISTS", `File now exists: ${prepared.path}`)
    } catch (error) {
      if (error instanceof MutationFailure) throw error
      // File doesn't exist - proceed
    }

    const expectedContent = prepared.proposedContent;

    // Create snapshot
    const snapshot: MutationSnapshot = {
      id: prepared.id,
      path: prepared.path,
      resolvedPath: prepared.resolvedPath,
      operation: "create",
      beforeContent: null,
      beforeHash: "",
      afterHash: prepared.resultHash,
      timestamp: this.#timestampFactory(),
    }

    // Ensure parent directory exists
    const parentDir = dirname(prepared.resolvedPath)
    await mkdir(parentDir, { recursive: true })

    // Atomic write: write temp file, then rename
    const tempPath = `${prepared.resolvedPath}.mutation-tmp`
    try {
      await writeFile(tempPath, expectedContent, "utf8")

      // Verify written content
      const writtenBytes = await readFile(tempPath)
      const writtenHash = sha256(writtenBytes.toString("utf8"))
      if (writtenHash !== prepared.resultHash) {
        await unlink(tempPath).catch(() => {})
        return this.#failureResult(prepared, "ATOMIC_WRITE_FAILED", "Written content hash mismatch")
      }

      await rename(tempPath, prepared.resolvedPath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      if (error instanceof MutationFailure) throw error
      return this.#failureResult(prepared, "ATOMIC_WRITE_FAILED", `Write failed: ${error instanceof Error ? error.message : "unknown"}`)
    }

    // Store snapshot
    this.#snapshots.set(prepared.id, snapshot)
    this.#mutationsThisStep++

    return {
      id: prepared.id,
      status: "APPLIED",
      path: prepared.path,
      operation: "create",
      diff: prepared.diff,
      observation: this.#formatObservation(prepared),
    }
  }

  readonly #consumed = new Set<string>()

  isConsumed(id: string): boolean {
    return this.#consumed.has(id)
  }

  rejectMutation(id: string): void {
    this.#consumed.add(id)
  }

  // --- Rollback ---

  async rollback(mutationId: string): Promise<MutationResult> {
    const snapshot = this.#snapshots.get(mutationId)
    if (!snapshot) {
      throw new MutationFailure("NO_SNAPSHOT", `No snapshot found for mutation: ${mutationId}`)
    }

    if (snapshot.operation === "patch") {
      return this.#rollbackPatch(snapshot)
    }
    return this.#rollbackCreate(snapshot)
  }

  async #rollbackPatch(snapshot: MutationSnapshot): Promise<MutationResult> {
    // Verify current file hash matches afterHash
    let currentContent: string
    try {
      const rawBytes = await readFile(snapshot.resolvedPath)
      currentContent = rawBytes.toString("utf8")
    } catch {
      throw new MutationFailure("ROLLBACK_CONFLICT", `File no longer exists: ${snapshot.path}`)
    }

    const currentHash = sha256(currentContent)
    if (currentHash !== snapshot.afterHash) {
      throw new MutationFailure("ROLLBACK_CONFLICT", `File was modified after mutation (expected ${snapshot.afterHash.slice(0, 12)}, got ${currentHash.slice(0, 12)})`)
    }

    // Restore original content atomically
    const tempPath = `${snapshot.resolvedPath}.rollback-tmp`
    try {
      await writeFile(tempPath, snapshot.beforeContent!, "utf8")
      await rename(tempPath, snapshot.resolvedPath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      throw new MutationFailure("ATOMIC_WRITE_FAILED", `Rollback write failed: ${error instanceof Error ? error.message : "unknown"}`)
    }

    this.#snapshots.delete(snapshot.id)

    return {
      id: snapshot.id,
      status: "APPLIED",
      path: snapshot.path,
      operation: "patch",
      observation: `Rollback applied: ${snapshot.path} restored to original state`,
    }
  }

  async #rollbackCreate(snapshot: MutationSnapshot): Promise<MutationResult> {
    // Verify current file hash matches afterHash
    let currentContent: string
    try {
      const rawBytes = await readFile(snapshot.resolvedPath)
      currentContent = rawBytes.toString("utf8")
    } catch {
      // File already gone - rollback is effectively done
      this.#snapshots.delete(snapshot.id)
      return {
        id: snapshot.id,
        status: "APPLIED",
        path: snapshot.path,
        operation: "create",
        observation: `Rollback: file ${snapshot.path} already removed`,
      }
    }

    const currentHash = sha256(currentContent)
    if (currentHash !== snapshot.afterHash) {
      throw new MutationFailure("ROLLBACK_CONFLICT", `File was modified after creation (expected ${snapshot.afterHash.slice(0, 12)}, got ${currentHash.slice(0, 12)})`)
    }

    // Remove the created file
    await unlink(snapshot.resolvedPath)

    this.#snapshots.delete(snapshot.id)

    return {
      id: snapshot.id,
      status: "APPLIED",
      path: snapshot.path,
      operation: "create",
      observation: `Rollback applied: ${snapshot.path} removed`,
    }
  }

  // --- Observation ---

  #alreadyAppliedResult(prepared: PreparedMutation): MutationResult {
    return {
      id: prepared.id,
      status: "ALREADY_SATISFIED",
      path: prepared.path,
      operation: prepared.operation,
      diff: prepared.diff,
      observation: `Already satisfied: ${prepared.path}\nThe file already matches the proposed content. No write.`,
    }
  }

  #formatObservation(prepared: PreparedMutation): string {
    const op = prepared.operation === "patch" ? "Modified" : "Created"
    return [
      `Mutation applied:`,
      `${prepared.path}`,
      ``,
      `Operation: ${op}`,
      `+${prepared.diff.linesAdded} / -${prepared.diff.linesRemoved} lines`,
      `Result hash: ${prepared.resultHash.slice(0, 16)}`,
      `Verification: PASS`,
    ].join("\n")
  }

  // --- Failure Result ---

  #failureResult(prepared: PreparedMutation, code: string, message: string): MutationResult {
    return {
      id: prepared.id,
      status: code === "STALE_BASE" ? "STALE_BASE" : "FAILED",
      path: prepared.path,
      operation: prepared.operation,
      error: new MutationFailure(code as any, message),
      observation: `Mutation failed: ${prepared.path}\nReason: ${message}`,
    }
  }

  // --- Accessors ---

  get workspaceRoot(): string {
    return this.#workspaceRoot
  }

  getSnapshot(mutationId: string): MutationSnapshot | undefined {
    return this.#snapshots.get(mutationId)
  }

  registerSnapshot(snapshot: MutationSnapshot): void {
    this.#snapshots.set(snapshot.id, snapshot)
  }

  get snapshotCount(): number {
    return this.#snapshots.size
  }
}

