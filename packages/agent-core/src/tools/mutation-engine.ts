import { readFile, writeFile, rename, unlink, mkdir, realpath, access, lstat } from "node:fs/promises"
import { resolve, relative, dirname, isAbsolute, join, basename } from "node:path"
import { createHash } from "node:crypto"
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
      const resolvedCandidate = join(resolvedParent, ...missing.slice().reverse(), basename(candidate))
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
    const searchIndex = beforeContent.indexOf(request.patch.search)
    if (searchIndex === -1) {
      throw new MutationFailure("PATCH_MISMATCH", `Search text not found in ${request.path}`)
    }

    // Check for ambiguity
    const secondIndex = beforeContent.indexOf(request.patch.search, searchIndex + 1)
    if (secondIndex !== -1) {
      throw new MutationFailure("PATCH_AMBIGUOUS", `Search text found multiple times in ${request.path}`)
    }

    const afterContent = beforeContent.slice(0, searchIndex) + request.patch.replace + beforeContent.slice(searchIndex + request.patch.search.length)
    const duplicate = duplicateExportFunction(afterContent)
    if (duplicate) {
      throw new MutationFailure("INVALID_PATCH", `Patch would declare export function ${duplicate} more than once in ${request.path}`)
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

    // Resolve path safely (must NOT exist)
    const root = await realpath(this.#workspaceRoot)
    const resolvedPath = await resolveWritePath(root, request.path, { mustExist: false })

    // Check file doesn't already exist
    try {
      await access(resolvedPath)
      throw new MutationFailure("FILE_EXISTS", `Cannot create file that already exists: ${request.path}`)
    } catch (error) {
      if (error instanceof MutationFailure) throw error
      // File doesn't exist - good
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

    if (result.status === "APPLIED") {
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

