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
  readonly workspaceRoot?: string | undefined
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
  if (code === "FILE_EXISTS" || /already exists/i.test(input.message) || input.message.startsWith("FILE_ALREADY_EXISTS:")) {
    const target = path || "that file"
    return {
      category: "FILE_ALREADY_EXISTS",
      signature: `FILE_ALREADY_EXISTS|${input.toolName}|${path}`,
      message: input.message.startsWith("FILE_ALREADY_EXISTS:")
        ? input.message
        : `FILE_ALREADY_EXISTS: create_file cannot overwrite ${target}. The file already exists. Read it, then call apply_patch(path, search, replace) with unique search text from that file. Do not call create_file again for ${target}.`,
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
      message: `INVALID_PATH: use a workspace-relative path such as src/add.ts, or "." for the workspace root${input.workspaceRoot ? ` (${input.workspaceRoot})` : ""}. Absolute paths outside the workspace and path traversal are not permitted; a repository path named in the request that is not under the workspace root is not reachable.`,
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
  if (/^test_[^/]*\.py$/.test(base) || /_test\.(?:py|go)$/.test(base)) return true
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
  return /\b(?:do not|don't|never)\b(?:(?!\.)[^\n]){0,80}\b(?:the|that|those)\s+tests?\b/i.test(instruction)
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
    ...readContextPaths(instruction),
  ]
  let kept = paths.filter((path) => !negated.some((named) => pathsReferToSameFile(path, named)))
  if (forbidsTestEdits(instruction)) {
    kept = kept.filter((path) => !isTestArtifactPath(path))
    if (kept.length === 0 && paths.every((path) => isTestArtifactPath(path))) return []
  }
  return kept.length > 0 ? kept : paths
}

/**
 * Paths in a clause that starts with a reading verb ("Read AGENTS.md, CLAUDE.md and the ADRs.") are context,
 * unless an edit verb also names them. A clause ends at a sentence stop or a line break.
 */
function readContextPaths(instruction: string): string[] {
  const edited = new Set<string>()
  for (const match of instruction.matchAll(new RegExp(String.raw`\b(?:fix|change|edit|modify|update|rename|create|write|produce|add)\s+(?:only\s+)?\x60?${EDIT_PATH}`, "gi"))) {
    if (match[1]) edited.add(match[1].replace(/^\.\//, "").toLowerCase())
  }
  const cited: string[] = []
  const clause = /(?:^|[.!?]\s+|\n\s*(?:[-*]\s+)?)(?:read|inspect|review|consult|study|see)\b([^\n]*?)(?=[.!?](?:\s|$)|\n|$)/gi
  for (const match of instruction.matchAll(clause)) {
    for (const path of match[1]?.matchAll(new RegExp(EDIT_PATH, "g")) ?? []) {
      const named = path[1]!.replace(/^\.\//, "")
      if (!edited.has(named.toLowerCase())) cited.push(named)
    }
  }
  return cited
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

/** The user asked for a test to be written ("add a test", "write regression tests"), not just for tests to pass. */
export function requestsNewTest(instruction: string): boolean {
  return /\b(?:add|write|create|include|extend)\b[^.\n]{0,60}?\b(?:regression\s+tests?|unit\s+tests?|tests?|specs?)\b/i.test(instruction) && !forbidsTestEdits(instruction)
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
  /** TEST, TYPECHECK, LINT or BUILD. Absent facts are treated as TEST. */
  readonly action?: string
}

export interface CodingCompletion {
  /** Specific unfinished parts of the request, when known. */
  readonly gaps?: readonly string[]
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
  /** The request asks for a new test, so a missing test file is not excused by a passing run. */
  readonly requireTestEdit?: boolean
  readonly mutations: readonly MutationFact[]
  readonly verifications: readonly VerificationFact[]
  readonly verificationRequired: boolean
  readonly userRejectedMutation: boolean
  readonly scheduledVerification?: "PASSED" | "UNAVAILABLE" | "NOT_RUN" | undefined
  /**
   * Verification actions that must also pass after the last edit, beyond the test run (for example TYPECHECK
   * when the project defines a typecheck script and the edit touched TypeScript).
   */
  readonly additionalVerification?: readonly string[]
  /** Explicit request parts not carried out yet (requirement-checks.ts). Non-empty means edits are unsatisfied. */
  readonly requirementGaps?: readonly string[]
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
  // A named file is context, not an obligation, once the repository's own tests pass after the applied
  // implementation edit. The summary still lists the named files that were left unchanged.
  const verifiedWithoutMissing = missingPaths.length > 0 && satisfied.length > 0 && !testOnly
    && !(input.requireTestEdit && missingPaths.some((path) => isTestArtifactPath(path)))
    && verificationAfterMutation(input.mutations, input.verifications, input.explicitPaths) === "PASS"
  if (satisfied.length === 0 || (input.explicitPaths.length > 1 && missingPaths.length > 0 && !verifiedWithoutMissing) || testOnly) {
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

  if ((input.requirementGaps?.length ?? 0) > 0) {
    return {
      accept: false,
      editsSatisfied: false,
      verificationSatisfied: false,
      failureReason: "INCOMPLETE",
      gaps: input.requirementGaps!,
      summary: `${changed} ${approval} ${tests} Incomplete: ${input.requirementGaps!.join(" ")}`,
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

  if (input.verificationRequired && (input.additionalVerification?.length ?? 0) > 0) {
    for (const action of ["TEST", ...input.additionalVerification!]) {
      const status = actionAfterMutation(input.mutations, input.verifications, input.explicitPaths, action)
      if (status === "PASS") continue
      const label = action === "TEST" ? "Tests" : action === "TYPECHECK" ? "Typecheck" : action.charAt(0) + action.slice(1).toLowerCase()
      return {
        accept: false,
        editsSatisfied: true,
        verificationSatisfied: false,
        failureReason: status === "FAIL" ? "VERIFICATION_FAILED" : "INCOMPLETE",
        summary: status === "FAIL"
          ? `${changed} ${approval} ${label} failed. The edit is not complete.`
          : `${changed} ${approval} ${label} has not run since the last edit. Incomplete: the edit is not verified.`,
      }
    }
  }

  return {
    accept: true,
    editsSatisfied: true,
    verificationSatisfied: true,
    summary: alreadyPresent
      ? `${changed} ${approval} ${tests} The requested content was already present.`
      : `${changed} ${approval} ${tests} The requested edit was applied.${verifiedWithoutMissing ? ` Not changed (tests pass without it): ${missingPaths.join(", ")}.` : ""}`,
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
  // "Create src/slug.ts ...", "add a new Stack class": a create request names a path or a new unit of code.
  // Creating over an existing file is still refused by the engine (FILE_EXISTS), so this cannot widen writes.
  if (/\b(?:create|new)\b[^.\n]{0,40}?(?:\b(?:class|component|module|file)\b|[\w./-]+\.[a-z]{1,5}\b)/i.test(instruction)) return false
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

/** The latest result of one verification action after the last relevant edit. */
export function actionAfterMutation(
  mutations: readonly MutationFact[],
  verifications: readonly VerificationFact[],
  explicitPaths: readonly string[],
  action: string,
): "PASS" | "FAIL" | "NONE" | "INCOMPLETE" {
  return verificationAfterMutation(mutations, verifications.filter((verification) => (verification.action ?? "TEST") === action), explicitPaths)
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
 * A patch that renames an exported or imported binding by hand: `from` disappears from the file's export
 * or import names and `to` appears, and the instruction names both. Such a rename changes other files, so it
 * belongs to the language service (rename_symbol), not to a single-file patch (ADR-047).
 */
export function handRenamedBinding(before: string, after: string, instruction: string): { from: string; to: string } | undefined {
  const names = (source: string) => new Set([...exportedNames(source), ...importedNames(source)])
  const was = names(before)
  const now = names(after)
  const mentioned = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(instruction)
  const removed = [...was].filter((name) => !now.has(name) && mentioned(name))
  const added = [...now].filter((name) => !was.has(name) && mentioned(name))
  if (removed.length !== 1 || added.length === 0) return undefined
  const from = removed[0]!
  // The target is the name the request gives after "to" following the old name; a patch that also adds
  // other exports (e.g. an extracted constant) must not be read as renaming to one of them.
  const escaped = from.replace(/\$/g, "\\$")
  // Every "to/into/as <name>" after a mention of the old name, in order; the first one the patch adds wins.
  const at = instruction.search(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`))
  const stated = [...instruction.slice(Math.max(0, at)).matchAll(/\b(?:to|into|as)\s+\x60?([$A-Za-z_][\w$]*)/g)].map((match) => match[1]!)
  // No fallback: a patch that adds a different name than the stated target is not redirected.
  const to = stated.find((name) => added.includes(name))
  return to ? { from, to } : undefined
}

function exportedNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([$A-Za-z_][\w$]*)/g)) names.add(match[1]!)
  for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()
      if (/^[$A-Za-z_][\w$]*$/.test(name)) names.add(name)
    }
  }
  return names
}

/** Original (pre-alias) names in import clauses: `import { a as b }` yields a. */
function importedNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/import\s+(?:type\s+)?[^;]*?\{([^}]*)\}\s*from\s+['"][^'"]+['"]/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()
      if (/^[$A-Za-z_][\w$]*$/.test(name)) names.add(name)
    }
  }
  return names
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
    "apply_patch(path, search, replace) is the only way to modify an existing file. search must match exactly once.",
    "create_file(path, content) creates a genuinely new file only. It cannot overwrite or replace an existing file.",
    "modify_file is not available.",
    "Paths are workspace-relative, such as src/add.ts. Absolute paths and traversal are rejected.",
    "Edits require approval before they are written. Running tests does not write files.",
    ...(toolNames.includes("rename_symbol") ? ["rename_symbol(path, symbol, newName) renames a function, type, constant or variable in its definition, imports, re-exports and every call site in one reviewed change, leaving unrelated same-named symbols alone. Use it for renames instead of apply_patch."] : []),
  ].map((line) => `- ${line}`).join("\n")
}
