import type { AgentFailureReason } from "../contracts/agent.ts"

export interface ToolContractFault {
  readonly category: "UNKNOWN_TOOL" | "FILE_ALREADY_EXISTS" | "INVALID_PATH" | "FILE_NOT_FOUND"
  readonly message: string
  readonly signature: string
}

export function isIllegalWorkspacePath(path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed) return false
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return true
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true
  return trimmed.split(/[\\/]/).includes("..")
}

export function describeToolContractFault(input: {
  readonly toolName: string
  readonly code?: string | undefined
  readonly message: string
  readonly path?: string | undefined
}): ToolContractFault | undefined {
  const path = input.path?.trim() ?? ""
  const illegal = path ? isIllegalWorkspacePath(path) : false
  const code = input.code ?? ""
  if (code === "UNKNOWN_TOOL" || /^Unknown tool:/i.test(input.message)) {
    return {
      category: "UNKNOWN_TOOL",
      signature: `UNKNOWN_TOOL|${input.toolName}`,
      message: `UNKNOWN_TOOL: ${input.toolName} is unavailable. Existing-file edits use apply_patch(path, search, replace). New files use create_file(path, content).`,
    }
  }
  if (code === "FILE_EXISTS" || /already exists/i.test(input.message)) {
    const target = path || "that file"
    return {
      category: "FILE_ALREADY_EXISTS",
      signature: `FILE_ALREADY_EXISTS|${input.toolName}|${path}`,
      message: `FILE_ALREADY_EXISTS: create_file cannot overwrite ${target}. Use apply_patch for changes to existing files.`,
    }
  }
  if (code === "FILE_NOT_FOUND" && input.toolName === "apply_patch" && !illegal) {
    return {
      category: "FILE_NOT_FOUND",
      signature: `FILE_NOT_FOUND|apply_patch|${path}`,
      message: `FILE_NOT_FOUND: apply_patch cannot edit ${path || "a missing file"}. Use create_file for a file that does not exist.`,
    }
  }
  if (
    illegal
    || code === "OUTSIDE_WORKSPACE"
    || code === "PATH_ESCAPE"
    || code === "SYMLINK_ESCAPE"
    || /outside workspace|escapes workspace/i.test(input.message)
  ) {
    return {
      category: "INVALID_PATH",
      signature: `INVALID_PATH|${input.toolName}|${path}`,
      message: "INVALID_PATH: use a workspace-relative path such as src/add.ts. Absolute paths and path traversal are not permitted.",
    }
  }
  return undefined
}

function normalizeWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

export function pathsReferToSameFile(left: string, right: string): boolean {
  const a = normalizeWorkspacePath(left)
  const b = normalizeWorkspacePath(right)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/** Test files and test directories. Implementation files stay outside this set. */
export function isTestArtifactPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  const lower = normalized.toLowerCase()
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//.test(lower)) return true
  const base = lower.split("/").pop() ?? lower
  if (base === "test" || base === "tests" || base === "spec" || base === "specs") return true
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[a-z0-9]+$/i.test(normalized)
}

/**
 * A behavior change needs an implementation edit.
 * An explicit request that names only test files can be satisfied by those tests.
 */
const EDIT_PATH = String.raw`((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)`

/** Paths named after "do not edit" or "without editing". */
export function excludedEditPaths(instruction: string): string[] {
  const negated: string[] = []
  const denial = new RegExp(String.raw`\b(?:do not|don't|never|without)\s+(?:edit(?:ing)?|modify(?:ing)?|change|changing|update|updating|touch(?:ing)?|alter(?:ing)?)\s+${EDIT_PATH}`, "gi")
  for (const match of instruction.matchAll(denial)) {
    const named = match[1]
    if (named) negated.push(named.replace(/^\.\//, ""))
  }
  return negated
}

/** The user forbade editing tests, without naming a specific test path. */
export function forbidsTestEdits(instruction: string): boolean {
  return /\b(?:do not|don't|never)\s+(?:edit|change|modify|update|touch|alter)(?:ing)?\s+the\s+tests?\b/i.test(instruction)
    || /\bwithout\s+(?:editing|changing|modifying|updating)\s+the\s+tests?\b/i.test(instruction)
}

/**
 * Paths the user asked to change. "Read A and B, then fix only A" does not
 * require an edit to B. "Do not edit B" also leaves B out. A request that
 * names several files without either restriction still requires each of them.
 * If every named path is excluded, the original list stays in force unless
 * the only named paths were tests the user forbade changing.
 */
export function requiredEditPaths(instruction: string, explicitPaths: readonly string[]): string[] {
  let paths = [...explicitPaths]
  const onlyBefore = instruction.match(new RegExp(String.raw`\b(?:fix|change|edit|modify|update)\s+only\s+${EDIT_PATH}`, "i"))
  const onlyAfter = instruction.match(new RegExp(String.raw`\b(?:fix|change|edit|modify|update)\s+${EDIT_PATH}\s+only\b`, "i"))
  const captured = onlyBefore?.[1] ?? onlyAfter?.[1]
  if (captured) {
    const target = captured.replace(/^\.\//, "")
    const matched = explicitPaths.filter((path) => pathsReferToSameFile(path, target))
    if (matched.length > 0) paths = matched
  }
  const negated = [
    ...excludedEditPaths(instruction),
    ...dependencyPaths(instruction),
  ]
  let kept = paths.filter((path) => !negated.some((named) => pathsReferToSameFile(path, named)))
  if (forbidsTestEdits(instruction)) {
    kept = kept.filter((path) => !isTestArtifactPath(path))
    if (kept.length === 0 && paths.every((path) => isTestArtifactPath(path))) return []
  }
  return kept.length > 0 ? kept : paths
}

/** A path cited as "from src/format.js" is context unless an edit verb names it. */
function dependencyPaths(instruction: string): string[] {
  const cited: string[] = []
  const fromPath = new RegExp(String.raw`\bfrom\s+${EDIT_PATH}`, "gi")
  const editPath = new RegExp(String.raw`\b(?:fix|change|edit|modify|update|rename)\s+(?:only\s+)?${EDIT_PATH}`, "gi")
  const edited = new Set<string>()
  for (const match of instruction.matchAll(editPath)) {
    if (match[1]) edited.add(match[1].replace(/^\.\//, "").toLowerCase())
  }
  for (const match of instruction.matchAll(fromPath)) {
    const named = match[1]?.replace(/^\.\//, "")
    if (named && !edited.has(named.toLowerCase())) cited.push(named)
  }
  return cited
}

export function implementationChangeRequired(instruction: string, explicitPaths: readonly string[]): boolean {
  if (explicitPaths.length > 0 && explicitPaths.every((path) => isTestArtifactPath(path))) return false
  if (explicitPaths.some((path) => !isTestArtifactPath(path))) return true
  const mentionsBehavior = /\b(?:implement|implementation|function|method|bug|failing|fix|src\/|return|behavior|behaviour|body|title|export|rename|replace)\b/i.test(instruction)
  const testOnly = /\b(?:test|tests|spec|specs)\b/i.test(instruction) && !mentionsBehavior
  return !testOnly
}

export interface MutationFact {
  readonly path: string
  readonly status: string
  readonly at: string
  readonly operation?: "create" | "patch" | "delete" | undefined
}

export interface VerificationFact {
  readonly status: string
  readonly at: string
}

export interface CodingCompletion {
  readonly accept: boolean
  readonly editsSatisfied: boolean
  readonly verificationSatisfied: boolean
  readonly failureReason?: AgentFailureReason
  readonly summary: string
}

function isSatisfiedMutation(status: string): boolean {
  return status === "APPLIED" || status === "ALREADY_SATISFIED"
}

export function relevantAppliedPaths(mutations: readonly MutationFact[], explicitPaths: readonly string[]): string[] {
  const applied = mutations.filter((mutation) => mutation.status === "APPLIED").map((mutation) => mutation.path)
  if (explicitPaths.length === 0) return applied
  return applied.filter((path) => explicitPaths.some((wanted) => pathsReferToSameFile(path, wanted)))
}

export function relevantSatisfiedPaths(mutations: readonly MutationFact[], explicitPaths: readonly string[]): string[] {
  const satisfied = mutations.filter((mutation) => isSatisfiedMutation(mutation.status)).map((mutation) => mutation.path)
  if (explicitPaths.length === 0) return satisfied
  return satisfied.filter((path) => explicitPaths.some((wanted) => pathsReferToSameFile(path, wanted)))
}

export function assessCodingCompletion(input: {
  readonly requiresCodeChange: boolean
  readonly explicitPaths: readonly string[]
  readonly requireImplementationChange?: boolean
  /** When true, creating a new file does not satisfy the requested behavior change. */
  readonly requireExistingFileEdit?: boolean
  readonly mutations: readonly MutationFact[]
  readonly verifications: readonly VerificationFact[]
  readonly verificationRequired: boolean
  readonly userRejectedMutation: boolean
  readonly scheduledVerification?: "PASSED" | "UNAVAILABLE" | "NOT_RUN" | undefined
}): CodingCompletion {
  const applied = relevantAppliedPaths(input.mutations, input.explicitPaths)
  const satisfied = relevantSatisfiedPaths(input.mutations, input.explicitPaths)
  const unrelated = input.mutations
    .filter((mutation) => mutation.status === "APPLIED" && !applied.includes(mutation.path))
    .map((mutation) => mutation.path)
  const lastVerification = input.verifications.at(-1)
  const tests = describeTests(input.scheduledVerification, lastVerification?.status)
  const alreadyPresent = satisfied.length > 0 && applied.length === 0
  const changed = applied.length > 0
    ? `Changed: ${applied.join(", ")}.`
    : unrelated.length > 0
      ? `Changed unrelated file: ${unrelated.join(", ")}.`
      : alreadyPresent
        ? "No files were changed. The requested content was already present."
        : "No files were changed."
  const approval = input.userRejectedMutation && applied.length === 0
    ? "The proposed edit was rejected."
    : applied.length > 0
      ? "Approval was granted for the applied edit."
      : "No edit was approved."
  const requireImplementation = input.requireImplementationChange
    ?? (input.explicitPaths.length === 0 || input.explicitPaths.some((path) => !isTestArtifactPath(path)))
  const implementationApplied = applied.some((path) => implementationEditCounts(path, input))

  if (!input.requiresCodeChange) {
    return {
      accept: true,
      editsSatisfied: true,
      verificationSatisfied: true,
      summary: `${changed} ${approval} ${tests} Read-only task completed from the gathered evidence.`,
    }
  }

  const missingPaths = input.explicitPaths.filter((wanted) => !satisfied.some((path) => pathsReferToSameFile(path, wanted)))
  const testOnly = applied.length > 0 && requireImplementation && !implementationApplied
  if (satisfied.length === 0 || (input.explicitPaths.length > 1 && missingPaths.length > 0) || testOnly) {
    const failureReason: AgentFailureReason = input.userRejectedMutation && applied.length === 0 ? "REJECTED" : "INCOMPLETE"
    const why = input.userRejectedMutation && applied.length === 0
      ? "The requested edit was not applied because the mutation was rejected."
      : testOnly && applied.some((path) => !isTestArtifactPath(path))
        ? "A new file was created. The existing implementation was not modified."
        : testOnly
          ? "Only test files changed. The implementation was not modified."
        : missingPaths.length > 0 && satisfied.length > 0
          ? `The edit did not include ${missingPaths.join(", ")}.`
          : unrelated.length > 0
            ? "The applied edit does not match the requested file."
            : "The requested edit was not applied."
    return {
      accept: false,
      editsSatisfied: false,
      verificationSatisfied: false,
      failureReason,
      summary: `${changed} ${approval} ${tests} Incomplete: ${why}`,
    }
  }

  if (input.verificationRequired) {
    if (input.scheduledVerification === "UNAVAILABLE") {
      return {
        accept: false,
        editsSatisfied: true,
        verificationSatisfied: false,
        failureReason: "VERIFICATION_UNAVAILABLE",
        summary: `${changed} ${approval} Tests did not run because verification is unavailable. Incomplete: the edit is unverified.`,
      }
    }
    const followed = verificationAfterMutation(input.mutations, input.verifications, input.explicitPaths)
    const scheduledPass = input.scheduledVerification === "PASSED" && followed !== "FAIL" && followed !== "INCOMPLETE"
    if (!scheduledPass && followed !== "PASS") {
      const failed = followed === "FAIL" || lastVerification?.status === "FAIL"
      const detail = verificationDetail(lastVerification?.status)
      return {
        accept: false,
        editsSatisfied: true,
        verificationSatisfied: false,
        failureReason: failed ? "VERIFICATION_FAILED" : "INCOMPLETE",
        summary: failed
          ? `${changed} ${approval} Tests failed. The edit is not complete.`
          : `${changed} ${approval} ${detail}`,
      }
    }
  }

  return {
    accept: true,
    editsSatisfied: true,
    verificationSatisfied: true,
    summary: alreadyPresent
      ? `${changed} ${approval} ${tests} The requested content was already present.`
      : `${changed} ${approval} ${tests} The requested edit was applied.`,
  }
}

function implementationEditCounts(path: string, input: {
  readonly mutations: readonly MutationFact[]
  readonly requireExistingFileEdit?: boolean
}): boolean {
  if (isTestArtifactPath(path)) return false
  if (!input.requireExistingFileEdit) return true
  const facts = input.mutations.filter((mutation) => mutation.status === "APPLIED" && pathsReferToSameFile(mutation.path, path))
  if (facts.length === 0) return true
  return facts.some((mutation) => mutation.operation !== "create")
}

export function requestsExistingFileEdit(instruction: string): boolean {
  if (/\b(?:create|add|write)\b/i.test(instruction) && /\b(?:file|module)\b/i.test(instruction)) return false
  return true
}

function describeTests(scheduled: "PASSED" | "UNAVAILABLE" | "NOT_RUN" | undefined, lastStatus: string | undefined): string {
  if (lastStatus === "PASS") return "Tests passed."
  if (scheduled === "PASSED" && lastStatus === undefined) return "Tests passed."
  if (scheduled === "UNAVAILABLE") return "Tests did not run."
  if (lastStatus === "FAIL") return "Tests failed."
  if (lastStatus === "TIMEOUT" || lastStatus === "CANCELLED" || lastStatus === "EXECUTION_ERROR" || lastStatus === "STALE_VERIFICATION") {
    return verificationDetail(lastStatus)
  }
  return "Tests did not run."
}

function verificationDetail(status: string | undefined): string {
  if (status === "TIMEOUT") return "Tests timed out. Incomplete: verification is still required."
  if (status === "CANCELLED") return "Verification was cancelled. Incomplete: verification is still required."
  if (status === "STALE_VERIFICATION") return "Verification was stale. Incomplete: verification is still required."
  if (status === "EXECUTION_ERROR") return "Verification did not complete. Incomplete: verification is still required."
  return "Tests did not run after the edit. Incomplete: verification is still required."
}

function verificationAfterMutation(
  mutations: readonly MutationFact[],
  verifications: readonly VerificationFact[],
  explicitPaths: readonly string[],
): "PASS" | "FAIL" | "NONE" | "INCOMPLETE" {
  const relevant = mutations.filter((mutation) =>
    isSatisfiedMutation(mutation.status)
    && (explicitPaths.length === 0 || explicitPaths.some((wanted) => pathsReferToSameFile(mutation.path, wanted))),
  )
  const lastMutation = relevant.at(-1)
  if (!lastMutation) return "NONE"
  const later = verifications.filter((verification) => verification.at >= lastMutation.at)
  const last = later.at(-1)
  if (!last) return "NONE"
  if (last.status === "PASS") return "PASS"
  if (last.status === "FAIL") return "FAIL"
  return "INCOMPLETE"
}

/**
 * A patch that drops an imported binding and still calls it. The name comes from
 * the file, so a rename has to update the call in the same patch.
 */
export function danglingRenamedBinding(before: string, after: string): string | undefined {
  const kept = new Set([...importedBindings(after), ...declaredBindings(after)])
  const calls = calledBindings(after)
  for (const name of importedBindings(before)) {
    if (!kept.has(name) && calls.has(name)) return name
  }
  return undefined
}

function importedBindings(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = match[1] ?? ""
    const brace = clause.match(/\{([^}]*)\}/)
    if (brace?.[1]) {
      for (const part of brace[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/i).pop()?.trim() ?? ""
        if (/^[$A-Za-z_][\w$]*$/.test(alias)) names.add(alias)
      }
    }
    const head = clause.replace(/\{[^}]*\}/g, " ").trim()
    const local = head.match(/^(?:\*\s+as\s+)?([$A-Za-z_][\w$]*)/)
    if (local?.[1] && local[1] !== "type") names.add(local[1])
  }
  return names
}

function declaredBindings(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/\b(?:function|class)\s+([$A-Za-z_][\w$]*)/g)) {
    if (match[1]) names.add(match[1])
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([$A-Za-z_][\w$]*)/g)) {
    if (match[1]) names.add(match[1])
  }
  return names
}

function calledBindings(source: string): Set<string> {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, " ")
  const names = new Set<string>()
  const keywords = new Set(["if", "for", "while", "switch", "catch", "function", "return", "import"])
  for (const match of stripped.matchAll(/(?<![\w$])([$A-Za-z_][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (!name || keywords.has(name)) continue
    const at = match.index ?? 0
    if (/\bfunction\s+$/.test(stripped.slice(Math.max(0, at - 16), at))) continue
    names.add(name)
  }
  return names
}

export function mutationToolGuidance(toolNames: readonly string[]): string {
  if (!toolNames.includes("apply_patch") && !toolNames.includes("create_file")) return ""
  return [
    "apply_patch(path, search, replace) modifies an existing file. search must match exactly once.",
    "create_file(path, content) creates a new file only.",
    "modify_file is not available.",
    "Paths are workspace-relative, such as src/add.ts. Absolute paths and traversal are rejected.",
    "Edits require approval before they are written. Running tests does not write files.",
  ].map((line) => `- ${line}`).join("\n")
}
