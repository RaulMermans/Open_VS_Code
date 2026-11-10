import { accessSync, constants, readdirSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { VerificationAction } from "./verification-contracts.ts"

export interface DiscoveredCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly packageJsonPath: string
  readonly packageJsonHash: string
  readonly scriptName: string
  readonly scriptBody: string
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
    if (action === "TEST" && await workspaceHasNodeTest(workspaceRoot)) {
      return {
        executable: resolveNodeBinary(),
        args: ["--test"],
        packageJsonPath: "",
        packageJsonHash: "",
        scriptName: "",
        scriptBody: "",
      }
    }
    throw new Error(`Failed to read package.json in workspace root: ${(error as Error).message}`, { cause: error })
  }

  const packageJsonHash = crypto.createHash("sha256").update(content).digest("hex")

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
    packageJsonPath,
    packageJsonHash,
    scriptName,
    scriptBody: pkg.scripts[scriptName]
  }
}

const NODE_TEST_FILE = /\.test\.(?:js|mjs|cjs|ts)$/

/** Node's built-in test runner, used when a repository has tests and no package.json. */
function resolveNodeBinary(): string {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === "win32" ? "node.exe" : "node")
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep searching PATH, then the local nvm install.
    }
  }
  const nvmRoot = path.join(os.homedir(), ".nvm", "versions", "node")
  try {
    const versions = readdirSync(nvmRoot).sort()
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const candidate = path.join(nvmRoot, versions[index] ?? "", "bin", "node")
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Try the next installed version.
      }
    }
  } catch {
    // nvm is not installed for this user.
  }
  return "node"
}

async function workspaceHasNodeTest(root: string, depth = 0): Promise<boolean> {
  if (depth > 4) return false
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (await workspaceHasNodeTest(full, depth + 1)) return true
    } else if (NODE_TEST_FILE.test(entry.name)) {
      return true
    }
  }
  return false
}
