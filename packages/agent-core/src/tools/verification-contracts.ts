export type VerificationAction = "TEST" | "TYPECHECK" | "LINT" | "BUILD"

export type VerificationStatus = "PASS" | "FAIL" | "TIMEOUT" | "CANCELLED" | "EXECUTION_ERROR" | "STALE_VERIFICATION"

/** PASS only for an exact successful status. Missing or malformed results are execution errors. */
export function recordedVerificationStatus(status: unknown): VerificationStatus {
  switch (status) {
    case "PASS":
    case "FAIL":
    case "TIMEOUT":
    case "CANCELLED":
    case "EXECUTION_ERROR":
    case "STALE_VERIFICATION":
      return status
    default:
      return "EXECUTION_ERROR"
  }
}

export interface PreparedVerification {
  readonly verificationId: string
  readonly action: VerificationAction
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly commandPreview: string
  readonly packageJsonPath: string
  readonly packageJsonHash: string
  readonly scriptName: string
  readonly scriptBody: string
  /** Extra environment shown on the approval card. The engine accepts only workspace-contained PYTHONPATH. */
  readonly env?: Readonly<Record<string, string>>
  /** Predicted sandbox for the approval card (ADR-046); the engine re-decides at execution. */
  readonly sandboxPreview?: string
  /** A workspace-local toolchain (project virtualenv): runs only in sandbox mode "required". */
  readonly requiresSandbox?: boolean
  /** Host directories exposed read-only in the sandbox (the cached package manager); re-validated at execution. */
  readonly readOnlyBinds?: readonly string[]
  /** Stale workspace dependency builds reviewed and executed with this command. Each one goes through the same engine. */
  readonly dependencyBuilds?: readonly PreparedVerification[]
  /** Why this command was added to the reviewed operation. */
  readonly reviewNote?: string
}

export interface VerificationResult {
  readonly status: VerificationStatus
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  /** Whether and how the command was sandboxed (ADR-046). Absent when the command never started. */
  readonly sandbox?: import("./command-sandbox.ts").SandboxStatus
  /** Parsed from reporter output when the summary line is present. Absent when the reporter did not name a count. */
  readonly failedTests?: number
  readonly totalTests?: number
  /** Compact failure summary, then any symbol diagnosis. Informational only; it does not change the verdict. */
  readonly diagnosis?: string
}
