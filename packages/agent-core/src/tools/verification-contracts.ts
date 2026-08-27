export type VerificationAction = "TEST" | "TYPECHECK" | "LINT" | "BUILD"

export type VerificationStatus = "PASS" | "FAIL" | "TIMEOUT" | "CANCELLED" | "EXECUTION_ERROR"

export interface PreparedVerification {
  readonly action: VerificationAction
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly commandPreview: string
}

export interface VerificationResult {
  readonly status: VerificationStatus
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}
