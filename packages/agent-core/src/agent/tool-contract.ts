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

export interface MutationFact {
  readonly path: string
  readonly status: string
  readonly at: string
}

export interface VerificationFact {
  readonly status: string
  readonly at: string
}

export interface CodingCompletion {
  readonly accept: boolean
  readonly failureReason?: AgentFailureReason
  readonly summary: string
}

export function relevantAppliedPaths(mutations: readonly MutationFact[], explicitPaths: readonly string[]): string[] {
  const applied = mutations.filter((mutation) => mutation.status === "APPLIED").map((mutation) => mutation.path)
  if (explicitPaths.length === 0) return applied
  return applied.filter((path) => explicitPaths.some((wanted) => pathsReferToSameFile(path, wanted)))
}

export function assessCodingCompletion(input: {
  readonly requiresCodeChange: boolean
  readonly explicitPaths: readonly string[]
  readonly mutations: readonly MutationFact[]
  readonly verifications: readonly VerificationFact[]
  readonly verificationRequired: boolean
  readonly userRejectedMutation: boolean
  readonly scheduledVerification?: "PASSED" | "UNAVAILABLE" | "NOT_RUN" | undefined
}): CodingCompletion {
  const applied = relevantAppliedPaths(input.mutations, input.explicitPaths)
  const unrelated = input.mutations
    .filter((mutation) => mutation.status === "APPLIED" && !applied.includes(mutation.path))
    .map((mutation) => mutation.path)
  const lastVerification = input.verifications.at(-1)
  const tests = describeTests(input.scheduledVerification, lastVerification?.status)
  const changed = applied.length > 0
    ? `Changed: ${applied.join(", ")}.`
    : unrelated.length > 0
      ? `Changed unrelated file: ${unrelated.join(", ")}.`
      : "No files were changed."
  const approval = input.userRejectedMutation && applied.length === 0
    ? "The proposed edit was rejected."
    : applied.length > 0
      ? "Approval was granted for the applied edit."
      : "No edit was approved."

  if (!input.requiresCodeChange) {
    return {
      accept: true,
      summary: `${changed} ${approval} ${tests} Read-only task completed from the gathered evidence.`,
    }
  }

  const missingPaths = input.explicitPaths.filter((wanted) => !applied.some((path) => pathsReferToSameFile(path, wanted)))
  if (applied.length === 0 || (input.explicitPaths.length > 1 && missingPaths.length > 0)) {
    const failureReason: AgentFailureReason = input.userRejectedMutation && applied.length === 0 ? "REJECTED" : "INCOMPLETE"
    const why = input.userRejectedMutation && applied.length === 0
      ? "The requested edit was not applied because the mutation was rejected."
      : missingPaths.length > 0 && applied.length > 0
        ? `The edit did not include ${missingPaths.join(", ")}.`
        : unrelated.length > 0
          ? "The applied edit does not match the requested file."
          : "The requested edit was not applied."
    return {
      accept: false,
      failureReason,
      summary: `${changed} ${approval} ${tests} Incomplete: ${why}`,
    }
  }

  if (input.verificationRequired) {
    if (input.scheduledVerification === "UNAVAILABLE") {
      return {
        accept: false,
        failureReason: "VERIFICATION_UNAVAILABLE",
        summary: `${changed} ${approval} Tests did not run because verification is unavailable. Incomplete: the edit is unverified.`,
      }
    }
    const followed = verificationAfterMutation(input.mutations, input.verifications, input.explicitPaths)
    if (input.scheduledVerification !== "PASSED" && followed !== "PASS") {
      const failed = followed === "FAIL" || lastVerification?.status === "FAIL"
      return {
        accept: false,
        failureReason: failed ? "VERIFICATION_FAILED" : "INCOMPLETE",
        summary: failed
          ? `${changed} ${approval} Tests failed. The edit is not complete.`
          : `${changed} ${approval} Tests did not run after the edit. Incomplete: verification is still required.`,
      }
    }
  }

  return {
    accept: true,
    summary: `${changed} ${approval} ${tests} The requested edit was applied.`,
  }
}

function describeTests(scheduled: "PASSED" | "UNAVAILABLE" | "NOT_RUN" | undefined, lastStatus: string | undefined): string {
  if (scheduled === "PASSED" || lastStatus === "PASS") return "Tests passed."
  if (scheduled === "UNAVAILABLE") return "Tests did not run."
  if (lastStatus === "FAIL") return "Tests failed."
  return "Tests did not run."
}

function verificationAfterMutation(
  mutations: readonly MutationFact[],
  verifications: readonly VerificationFact[],
  explicitPaths: readonly string[],
): "PASS" | "FAIL" | "NONE" {
  const relevant = mutations.filter((mutation) =>
    mutation.status === "APPLIED"
    && (explicitPaths.length === 0 || explicitPaths.some((wanted) => pathsReferToSameFile(mutation.path, wanted))),
  )
  const lastMutation = relevant.at(-1)
  if (!lastMutation) return "NONE"
  const later = verifications.filter((verification) => verification.at >= lastMutation.at)
  const last = later.at(-1)
  if (!last) return "NONE"
  return last.status === "PASS" ? "PASS" : "FAIL"
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
