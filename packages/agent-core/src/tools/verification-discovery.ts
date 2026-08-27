import * as fs from "node:fs/promises"
import * as path from "node:path"
import { VerificationAction } from "./verification-contracts.ts"

export interface DiscoveredCommand {
  readonly executable: string
  readonly args: readonly string[]
}

const ACTION_TO_SCRIPT: Record<VerificationAction, string> = {
  TEST: "test",
  TYPECHECK: "typecheck",
  LINT: "lint",
  BUILD: "build",
}

export async function discoverVerificationCommand(
  workspaceRoot: string,
  action: VerificationAction
): Promise<DiscoveredCommand> {
  const packageJsonPath = path.join(workspaceRoot, "package.json")
  
  let content: string
  try {
    content = await fs.readFile(packageJsonPath, "utf-8")
  } catch (error) {
    throw new Error(`Failed to read package.json in workspace root: ${(error as Error).message}`, { cause: error })
  }

  let pkg: any
  try {
    pkg = JSON.parse(content)
  } catch (error) {
    throw new Error(`Failed to parse package.json: ${(error as Error).message}`, { cause: error })
  }

  const scriptName = ACTION_TO_SCRIPT[action]
  if (!pkg.scripts || !pkg.scripts[scriptName]) {
    throw new Error(`Action ${action} requires a '${scriptName}' script in package.json`)
  }

  return {
    executable: "npm",
    args: ["run", scriptName],
  }
}
