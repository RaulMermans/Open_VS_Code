export type CaseCategory = 
  | "BUG_FIX"
  | "TYPE_REPAIR"
  | "TEST_REPAIR"
  | "FEATURE"
  | "REFACTOR"
  | "REGRESSION_PREVENTION"
  | "FAILURE_RECOVERY"
  | "SAFETY"
  | "NEGATIVE_ACTION"

export type CaseDifficulty = "EASY" | "MEDIUM" | "HARD"
export type CaseCompatibility = "DETERMINISTIC_ONLY" | "REAL_MODEL_COMPATIBLE" | "BOTH"
export type AgentMode = "BUILD" | "ASK" | "PLAN" | "DEBUG"

export interface SuccessCriteria {
  readonly requiredVerificationPass?: ("TEST" | "TYPECHECK" | "LINT" | "BUILD")[]
  readonly expectedFilesExist?: string[]
  readonly expectedFilesUnchanged?: string[]
  readonly expectedBehavior?: {
    readonly command: string
    readonly exitCode?: number
    readonly stdoutIncludes?: string[]
    readonly stderrIncludes?: string[]
  }
}

export interface AllowedMutationScope {
  readonly allowedPaths?: string[]
  readonly forbiddenPaths?: string[]
  readonly maxChangedFiles?: number
  readonly maxChangedLines?: number
  readonly maxMutations?: number
}

export interface BudgetLimits {
  readonly maxTurns?: number
  readonly maxRepairAttempts?: number
  readonly maxTotalAgentTurns?: number
  readonly maxVerificationRuns?: number
}

export interface CodingEvalCase {
  readonly id: string
  readonly title: string
  readonly category: CaseCategory
  readonly difficulty: CaseDifficulty
  readonly compatibility: CaseCompatibility
  readonly tags: string[]

  readonly task: {
    readonly mode: AgentMode
    readonly instruction: string
  }

  readonly fixture: {
    readonly templateRelPath: string
    readonly setupScript?: string
  }

  // If provided, the case starts in the RepairOrchestrator loop verifying this action
  readonly initialVerification?: "TEST" | "TYPECHECK" | "LINT" | "BUILD"

  readonly allowedMutationScope?: AllowedMutationScope
  readonly verificationPlan?: ("TEST" | "TYPECHECK" | "LINT" | "BUILD")[]
  
  readonly safetyExpectations?: {
    readonly expectedDenials?: ("MUTATION" | "VERIFICATION" | "TOOL_EXECUTION")[]
    readonly expectRefusal?: boolean
    readonly expectTaskSuccess: boolean
  }

  readonly budgets?: BudgetLimits

  readonly successCriteria: SuccessCriteria
  
  // For DETERMINISTIC_ONLY cases, we provide the scripted model calls here
  // so the runner can mock the reasoning.
  readonly scriptedModelSteps?: any[]
}

export type EvalRunStatus = 
  | "PASS"
  | "FAIL"
  | "SAFE_REJECTION"
  | "BUDGET_EXCEEDED"
  | "NON_PROGRESS"
  | "CANCELLED"
  | "INFRASTRUCTURE_FAILURE"

export type FailureReason =
  | "INVESTIGATION_FAILURE"
  | "INSUFFICIENT_EVIDENCE"
  | "INCORRECT_MUTATION"
  | "MUTATION_REJECTED"
  | "MUTATION_STALE"
  | "VERIFICATION_FAILURE"
  | "VERIFICATION_REJECTED"
  | "VERIFICATION_STALE"
  | "REGRESSION"
  | "BUDGET_EXCEEDED"
  | "NON_PROGRESS"
  | "SAFETY_VIOLATION"
  | "INFRASTRUCTURE_FAILURE"
  | "CANCELLED"
  | "UNKNOWN"
  
export interface EvaluationResult {
  readonly caseId: string
  readonly status: EvalRunStatus
  readonly durationMs: number

  readonly turns: number
  readonly toolCalls: number

  readonly mutationsPrepared: number
  readonly mutationsApplied: number
  readonly changedFiles: number
  readonly linesAdded: number
  readonly linesRemoved: number

  readonly repairAttempts: number

  readonly verificationRuns: number
  readonly verificationResults: {
    readonly passes: number
    readonly failures: number
    readonly retries: number
  }

  readonly safetyEvents: {
    readonly deniedActions: number
    readonly staleMutationsCaught: number
    readonly staleVerificationsCaught: number
    readonly workspaceEscapesBlocked: number
    readonly arbitraryCommandsBlocked: number
  }

  readonly failureReason?: FailureReason
  readonly errorDetails?: string
}
