import { FailureClassification } from "./failure-classification.ts"
import { RepairInvestigationPrompt } from "./repair-contracts.ts"

export function mapFailureToInvestigation(failure: FailureClassification): RepairInvestigationPrompt {
  let instruction = `The verification step failed with a ${failure.category}.\n`
  instruction += `\n### Failure Details\n${failure.details}\n`
  
  let systemPrompt = "You are an autonomous repair agent tasked with fixing a verification failure."
  
  if (failure.category === "LINT_ERROR") {
    systemPrompt += " Your primary goal is to resolve linter warnings and errors."
    instruction += "\nPlease inspect the failed files and apply minimal corrections to satisfy the linter. Do not rewrite logic unless strictly necessary."
  } else if (failure.category === "TYPE_ERROR") {
    systemPrompt += " Your primary goal is to resolve TypeScript compiler errors."
    instruction += "\nPlease investigate the type mismatches. Ensure interfaces and implementations align. You may need to read the type definitions of imported modules."
  } else if (failure.category === "TEST_FAILURE") {
    systemPrompt += " Your primary goal is to fix failing tests without changing the intended business logic, or fix business logic to pass the test if the test is correct."
    instruction += "\nPlease read the failing test file. Determine if the test assertions are outdated or if the implementation is broken, and apply a targeted fix."
  } else if (failure.category === "BUILD_FAILURE") {
    systemPrompt += " Your primary goal is to resolve build and compilation errors."
    instruction += "\nPlease verify package.json, tsconfig.json, and the source files mentioned in the build output to resolve the build break."
  } else {
    systemPrompt += " Your primary goal is to fix the runtime or unknown error."
    instruction += "\nPlease read the relevant files, reproduce or reason about the crash, and apply a fix."
  }

  if (failure.failedFiles.length > 0) {
    instruction += `\n\nHint: Focus your investigation on the following files:\n- ${failure.failedFiles.join("\n- ")}`
  }

  return {
    failure,
    systemPrompt,
    instruction
  }
}
