import { accessSync, constants, readdirSync, realpathSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { VerificationAction } from "./verification-contracts.ts"
import { RepositoryPathError, resolveRepositoryPath } from "./path-safety.ts"

export interface DiscoveredCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly packageJsonPath: string
  readonly packageJsonHash: string
  readonly scriptName: string
  readonly scriptBody: string
  /** Extra environment for the command. Only PYTHONPATH entries inside the workspace are accepted by the engine. */
  readonly env?: Readonly<Record<string, string>>
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
  let workspaceReal: string
  try {
    workspaceReal = await fs.realpath(workspaceRoot)
  } catch (error) {
    throw new Error(`Failed to resolve workspace root: ${(error as Error).message}`, { cause: error })
  }

  let content: string
  try {
    await resolveRepositoryPath(workspaceRoot, "package.json", "file")
    content = await fs.readFile(packageJsonPath, "utf-8")
  } catch (error) {
    const missing = error instanceof RepositoryPathError && error.code === "NOT_FOUND"
    if (missing && action === "TEST") {
      const testFiles = await collectContainedNodeTests(workspaceReal)
      if (testFiles.length > 0) {
        return {
          executable: resolveNodeBinary({ workspaceRoot: workspaceReal }),
          args: ["--test", ...testFiles],
          packageJsonPath: "",
          packageJsonHash: "",
          scriptName: "",
          scriptBody: "",
        }
      }
      const python = await discoverPythonTestCommand(workspaceReal)
      if (python) return python
    }
    if (missing) {
      throw new Error(`Failed to read package.json in workspace root: ${(error as Error).message}`, { cause: error })
    }
    if (error instanceof RepositoryPathError) {
      throw new Error(`package.json is unreadable or resolves outside the workspace: ${error.message}`, { cause: error })
    }
    throw new Error(`package.json is unreadable: ${(error as Error).message}`, { cause: error })
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
    executable: resolveNpmBinary(workspaceReal),
    args: ["run", scriptName],
    packageJsonPath,
    packageJsonHash,
    scriptName,
    scriptBody: pkg.scripts[scriptName]
  }
}

const NODE_TEST_FILE = /\.test\.(?:js|mjs|cjs|ts)$/
const PYTHON_TEST_FILE = /^(?:test_.*|.*_test)\.py$/

async function containedFileExists(workspaceReal: string, relative: string): Promise<boolean> {
  try {
    await resolveRepositoryPath(workspaceReal, relative, "file")
    return true
  } catch {
    return false
  }
}

async function containedText(workspaceReal: string, relative: string): Promise<string> {
  try {
    const resolved = await resolveRepositoryPath(workspaceReal, relative, "file")
    return await fs.readFile(resolved, "utf-8")
  } catch {
    return ""
  }
}

/**
 * Python verifier registry for repositories without package.json. Only commands the repository already
 * implies are used: Django's manage.py, a configured pytest, or stdlib unittest over existing test files.
 * The interpreter is python3 from PATH and is refused when it resolves inside the workspace.
 */
async function srcHoldsPackage(workspaceReal: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(workspaceReal, "src"), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && await containedFileExists(workspaceReal, path.join("src", entry.name, "__init__.py"))) return true
    }
  } catch {
    return false
  }
  return false
}

/** True when the tests are plain module-level `def test_*` functions that unittest discovery cannot see. */
async function isPytestStyleOnly(workspaceReal: string, testFiles: readonly string[]): Promise<boolean> {
  let plainFunctions = false
  for (const file of testFiles) {
    const text = await containedText(workspaceReal, file)
    if (/^\s*(?:import unittest|from unittest\b)|\bunittest\.TestCase\b|\(\s*TestCase\s*\)/m.test(text)) return false
    if (/^(?:def test_|class Test)/m.test(text)) plainFunctions = true
  }
  return plainFunctions
}

async function discoverPythonTestCommand(workspaceReal: string): Promise<DiscoveredCommand | undefined> {
  const testFiles = await collectContainedNodeTests(workspaceReal, workspaceReal, 0, PYTHON_TEST_FILE)
  const djangoProject = await containedFileExists(workspaceReal, "manage.py")
  if (testFiles.length === 0 && !djangoProject) return undefined
  const executable = findExecutable("python3", { workspaceRoot: workspaceReal })
  if (!executable) return undefined
  // src layout: packages live under src/ (pyproject `where = ["src"]`, or src/ holding a package).
  const pyproject = await containedText(workspaceReal, "pyproject.toml")
  const srcLayout = /where\s*=\s*\[\s*["']src["']\s*\]/.test(pyproject) || /package_dir\s*=\s*\{\s*["']{2}\s*:\s*["']src["']/.test(await containedText(workspaceReal, "setup.py"))
    || await srcHoldsPackage(workspaceReal)
  const env = srcLayout ? { PYTHONPATH: path.join(workspaceReal, "src") } : undefined
  const command = (args: string[]): DiscoveredCommand => ({ executable, args, packageJsonPath: "", packageJsonHash: "", scriptName: "", scriptBody: "", ...(env ? { env } : {}) })
  if (djangoProject) return command(["manage.py", "test"])
  const pytestConfigured = await containedFileExists(workspaceReal, "pytest.ini")
    || await containedFileExists(workspaceReal, "conftest.py")
    || /^\[tool\.pytest/m.test(await containedText(workspaceReal, "pyproject.toml"))
    || /^\[(?:tool:)?pytest\]/m.test(await containedText(workspaceReal, "setup.cfg"))
    || /^\[pytest\]/m.test(await containedText(workspaceReal, "tox.ini"))
  if (pytestConfigured) return command(["-m", "pytest", "-q"])
  // Plain `def test_*` functions are invisible to unittest discovery ("Ran 0 tests"), which would look like a
  // failing run that no code change can fix. Such tests need pytest; without it, report no verifier instead.
  if (await isPytestStyleOnly(workspaceReal, testFiles)) {
    return spawnSync(executable, ["-I", "-c", "import pytest"], { stdio: "ignore", timeout: 10_000, cwd: os.tmpdir() }).status === 0 ? command(["-m", "pytest", "-q"]) : undefined
  }
  const topDirs = new Set(testFiles.map((file) => file.split(path.sep)[0]!))
  const start = topDirs.size === 1 && testFiles.every((file) => file.includes(path.sep)) ? [...topDirs][0]! : "."
  const importable = start === "." || await containedFileExists(workspaceReal, path.join(start, "__init__.py"))
  return command(["-m", "unittest", "discover", "-s", start, ...(importable ? ["-t", "."] : [])])
}
const NODE_NAME = process.platform === "win32" ? "node.exe" : "node"

export interface NodeBinaryOptions {
  readonly pathEnv?: string
  readonly nvmRoot?: string
  readonly workspaceRoot?: string
}

/** Node's built-in test runner, used when a repository has tests and no package.json. */
export function resolveNodeBinary(options: NodeBinaryOptions = {}): string {
  const found = findExecutable(NODE_NAME, options)
  if (!found) throw new Error("Node.js executable was not found on PATH or in a supported nvm installation")
  return found
}

function resolveNpmBinary(workspaceRoot: string): string {
  return findExecutable("npm", { workspaceRoot }) ?? "npm"
}

function findExecutable(name: string, options: NodeBinaryOptions): string | undefined {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ""
  const workspace = options.workspaceRoot ? existingRealpath(options.workspaceRoot) : undefined
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, name)
    if (usableBinary(candidate, workspace)) return candidate
  }
  if (name !== NODE_NAME) return undefined
  const nvmRoot = options.nvmRoot ?? path.join(os.homedir(), ".nvm", "versions", "node")
  let versions: string[]
  try {
    versions = readdirSync(nvmRoot)
  } catch {
    return undefined
  }
  const ranked = versions.toSorted(compareNodeVersions).toReversed()
  for (const version of ranked) {
    const candidate = path.join(nvmRoot, version, "bin", name)
    if (usableBinary(candidate, workspace)) return candidate
  }
  return undefined
}

function parseNodeVersion(name: string): number[] {
  return name.replace(/^v/, "").split(".").map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
}

function compareNodeVersions(left: string, right: string): number {
  const a = parseNodeVersion(left)
  const b = parseNodeVersion(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function existingRealpath(target: string): string | undefined {
  try {
    return realpathSync(target)
  } catch {
    return undefined
  }
}

function usableBinary(candidate: string, workspaceReal: string | undefined): boolean {
  try {
    accessSync(candidate, constants.X_OK)
  } catch {
    return false
  }
  if (!workspaceReal) return true
  const real = existingRealpath(candidate)
  if (!real || isInside(workspaceReal, real)) return false
  return true
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** Test files whose real path stays inside the workspace. Symlinks that leave the workspace are ignored. */
async function collectContainedNodeTests(workspaceReal: string, current = workspaceReal, depth = 0, pattern: RegExp = NODE_TEST_FILE): Promise<string[]> {
  if (depth > 4) return []
  let entries
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name === ".git" || entry.name.startsWith(".")) continue
    const full = path.join(current, entry.name)
    if (entry.isSymbolicLink()) {
      const real = existingRealpath(full)
      if (!real || !isInside(workspaceReal, real)) continue
      let stat
      try {
        stat = await fs.stat(real)
      } catch {
        continue
      }
      if (stat.isFile() && pattern.test(entry.name)) files.push(path.relative(workspaceReal, full))
      continue
    }
    if (entry.isDirectory()) {
      files.push(...await collectContainedNodeTests(workspaceReal, full, depth + 1, pattern))
    } else if (pattern.test(entry.name)) {
      files.push(path.relative(workspaceReal, full))
    }
  }
  return files.toSorted()
}
