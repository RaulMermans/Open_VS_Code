import { VerificationResult } from "../tools/verification-contracts.ts"

export type FailureCategory = "LINT_ERROR" | "TYPE_ERROR" | "TEST_FAILURE" | "BUILD_FAILURE" | "RUNTIME_CRASH" | "UNKNOWN"

export interface FailureClassification {
  readonly category: FailureCategory
  readonly summary: string
  readonly details: string
  readonly failedFiles: string[]
}

export function classifyFailure(action: string, result: VerificationResult): FailureClassification {
  const combinedOutput = result.stdout + "\n" + result.stderr

  let category: FailureCategory = "UNKNOWN"
  if (result.status === "EXECUTION_ERROR") {
    category = "RUNTIME_CRASH"
  } else if (action === "LINT") {
    category = "LINT_ERROR"
  } else if (action === "TYPECHECK") {
    category = "TYPE_ERROR"
  } else if (action === "TEST") {
    category = "TEST_FAILURE"
  } else if (action === "BUILD") {
    category = "BUILD_FAILURE"
  }

  // Very basic heuristic file extraction
  const files = new Set<string>()
  const fileRegex = /(?:^|\s|\/)([a-zA-Z0-9_\-./\\]+\.(?:ts|js|jsx|tsx|md))(?::\d+:\d+)?/gm
  let match
  while ((match = fileRegex.exec(combinedOutput)) !== null) {
    if (match[1] && match[1].length > 3) {
      files.add(match[1])
    }
  }

  const lines = combinedOutput.split("\n")
  const errorLines = lines.filter(line => 
    line.toLowerCase().includes("error") || 
    line.toLowerCase().includes("fail") ||
    line.includes("    at ") // stack trace
  ).slice(0, 10).join("\n")

  return {
    category,
    summary: `${category} during ${action}`,
    details: errorLines || "Check full output for details",
    failedFiles: Array.from(files),
  }
}
