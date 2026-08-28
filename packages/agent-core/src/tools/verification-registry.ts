import { ToolRegistry, ToolRegistration, ToolExecutionContext, ReviewableExecution } from "./registry.ts"
import { discoverVerificationCommand } from "./verification-discovery.ts"
import { VerificationEngine } from "./verification-engine.ts"
import { VerificationAction, PreparedVerification, VerificationResult } from "./verification-contracts.ts"

const ACTION_TIMEOUTS: Record<VerificationAction, number> = {
  TEST: 60_000,
  TYPECHECK: 60_000,
  LINT: 60_000,
  BUILD: 120_000,
}

export function createVerificationToolRegistrations(workspaceRoot: string): ToolRegistration[] {
  const engine = new VerificationEngine({ workspaceRoot })

  const runVerificationRegistration: ToolRegistration = {
    definition: {
      name: "run_verification",
      action: "run_known_test",
      description: "Run narrowly scoped verification actions: TEST, TYPECHECK, LINT, or BUILD.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["TEST", "TYPECHECK", "LINT", "BUILD"],
            description: "The verification action to run",
          },
        },
        required: ["action"],
      },
    },
    validate: (input: unknown) => {
      if (!input || typeof input !== "object") throw new Error("Input must be an object")
      const action = (input as any).action
      if (!["TEST", "TYPECHECK", "LINT", "BUILD"].includes(action)) {
        throw new Error("action must be one of TEST, TYPECHECK, LINT, BUILD")
      }
      return { action }
    },
    prepareForReview: async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ReviewableExecution> => {
      const action = input.action as VerificationAction
      const command = await discoverVerificationCommand(context.workspaceRoot, action)
      const verificationId = `verification-${Date.now()}-${Math.random().toString(36).slice(2)}`
      
      const prepared: PreparedVerification = {
        verificationId,
        action,
        executable: command.executable,
        args: command.args,
        cwd: context.workspaceRoot,
        timeoutMs: ACTION_TIMEOUTS[action],
        commandPreview: `${command.executable} ${command.args.join(" ")}`,
        packageJsonPath: command.packageJsonPath,
        packageJsonHash: command.packageJsonHash,
        scriptName: command.scriptName,
        scriptBody: command.scriptBody,
      }

      return {
        id: verificationId,
        reviewPayload: prepared as any,
        apply: async (applyContext: ToolExecutionContext): Promise<VerificationResult> => {
          return engine.execute(prepared, applyContext.signal)
        },
      }
    },
    execute: async () => {
      throw new Error("run_verification requires a two-phase review process")
    },
  }

  return [runVerificationRegistration]
}

export function createVerificationToolRegistry(workspaceRoot: string): ToolRegistry {
  return new ToolRegistry(createVerificationToolRegistrations(workspaceRoot))
}
