

// --- Operation Types ---
export type MutationOperation = "patch" | "create"

// --- Mutation Request ---
export interface MutationRequest {
  readonly operation: MutationOperation
  readonly path: string  // workspace-relative path
  readonly content?: string  // for create_file: the new file content
  readonly patch?: PatchContent  // for apply_patch: the patch to apply
}

// patch details
export interface PatchContent {
  readonly search: string    // exact text to find in the file
  readonly replace: string   // replacement text
}

// --- Prepared Mutation ---
export type PreparedMutationStatus = "PREPARED" | "APPROVED" | "APPLIED" | "REJECTED" | "INVALIDATED"

export interface PreparedMutation {
  readonly id: string
  readonly operation: MutationOperation
  readonly path: string
  readonly resolvedPath: string  // absolute resolved path
  readonly baseHash: string  // SHA-256 of file before mutation (or "" for create)
  readonly resultHash: string // SHA-256 of file after mutation
  readonly diff: MutationDiff
  readonly fileChange: FileChange
  readonly timestamp: string
  readonly valid: boolean
}

// --- Mutation Diff ---
export interface MutationDiff {
  readonly path: string
  readonly operation: MutationOperation
  readonly linesAdded: number
  readonly linesRemoved: number
  readonly bytesChanged: number
  readonly unified: string  // unified diff text
  readonly truncated: boolean  // if diff exceeded configured limit
}

// --- File Change ---
export interface FileChange {
  readonly path: string
  readonly operation: MutationOperation
  readonly beforeSize: number
  readonly afterSize: number
  readonly beforeHash: string
  readonly afterHash: string
}

// --- Mutation Result ---
export type MutationResultStatus = "APPLIED" | "REJECTED" | "FAILED" | "STALE_BASE" | "ROLLBACK_CONFLICT"

export interface MutationResult {
  readonly id: string
  readonly status: MutationResultStatus
  readonly path: string
  readonly operation: MutationOperation
  readonly diff?: MutationDiff
  readonly error?: MutationFailure
  readonly observation: string  // bounded model-facing observation
}

// --- Mutation Failure ---
export type MutationFailureCode =
  | "OUTSIDE_WORKSPACE"
  | "PATH_ESCAPE"
  | "SYMLINK_ESCAPE"
  | "SENSITIVE_PATH"
  | "BINARY_FILE"
  | "FILE_EXISTS"    // create_file target already exists
  | "FILE_NOT_FOUND" // apply_patch target doesn't exist
  | "STALE_BASE"     // file changed after read
  | "PATCH_MISMATCH" // search text not found
  | "PATCH_AMBIGUOUS" // search text found multiple times
  | "INVALID_PATCH"  // malformed patch content
  | "ENCODING_ERROR" // non-UTF-8 content
  | "BUDGET_EXCEEDED" // mutation budget exceeded
  | "OVERSIZED_DIFF" // diff exceeds configured limit
  | "OVERSIZED_FILE" // new file exceeds size limit
  | "ROLLBACK_CONFLICT" // file changed after mutation, can't rollback
  | "NO_SNAPSHOT"    // no snapshot available for rollback
  | "PERMISSION_DENIED"
  | "ATOMIC_WRITE_FAILED"
  | "PARENT_NOT_FOUND" // parent directory doesn't exist for create

export class MutationFailure extends Error {
  readonly code: MutationFailureCode

  constructor(code: MutationFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "MutationFailure"
    this.code = code
  }
}

// --- Mutation Snapshot ---
export interface MutationSnapshot {
  readonly id: string
  readonly path: string
  readonly resolvedPath: string
  readonly operation: MutationOperation
  readonly beforeContent: string | null  // null for create (file didn't exist)
  readonly beforeHash: string   // "" for create
  readonly afterHash: string
  readonly timestamp: string
}

// --- Mutation Budgets ---
export interface MutationBudgets {
  readonly maxFilesPerStep: number
  readonly maxTotalChangedBytes: number
  readonly maxAddedLines: number
  readonly maxRemovedLines: number
  readonly maxNewFileBytes: number
  readonly maxDiffBytes: number
}

export const DEFAULT_MUTATION_BUDGETS: Readonly<MutationBudgets> = {
  maxFilesPerStep: 3,
  maxTotalChangedBytes: 10_000,
  maxAddedLines: 200,
  maxRemovedLines: 100,
  maxNewFileBytes: 8_192,
  maxDiffBytes: 16_384,
}

// --- Sensitive Path Policy ---
export interface MutationPolicy {
  readonly mutationExclusions: readonly string[]   // directory prefixes to deny mutation
  readonly sensitivePatterns: readonly RegExp[]     // file patterns requiring extra confirmation
  readonly allowedOperations: readonly MutationOperation[]
}

export const DEFAULT_MUTATION_POLICY: Readonly<MutationPolicy> = {
  mutationExclusions: [
    ".git/",
    ".git\\",
    "node_modules/",
    "node_modules\\",
    "dist/",
    "dist\\",
    "build/",
    "build\\",
    "coverage/",
    "coverage\\",
    ".next/",
    ".next\\",
  ],
  sensitivePatterns: [
    /^\.env$/,
    /^\.env\./,
    /credentials/i,
    /\.pem$/,
    /\.key$/,
    /id_rsa/,
    /id_ed25519/,
  ],
  allowedOperations: ["patch", "create"],
}
