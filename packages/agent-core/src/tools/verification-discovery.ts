import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
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
  /** Extra environment for the command. The engine accepts only workspace PYTHONPATH and the fixed Corepack settings. */
  readonly env?: Readonly<Record<string, string>>
  /** Runs a workspace-local toolchain (a project virtualenv): only inside the command sandbox, never unsandboxed. */
  readonly requiresSandbox?: boolean
  /** Host directories the sandbox exposes read-only (the project's cached package manager). */
  readonly readOnlyBinds?: readonly string[]
}

/**
 * The workspace cannot run this verification until it is set up (tools or dependencies missing). Not a code
 * defect. Nothing is installed automatically: setup needs the network and the user's separate decision.
 */
export class EnvironmentSetupRequiredError extends Error {
  constructor(reason: string, readonly setup?: string) {
    super(`ENVIRONMENT_SETUP_REQUIRED: ${reason}.${setup ? ` To set it up (needs network; not done automatically): ${setup}` : ""}`)
  }
}

/** Fixed Corepack settings for verification: use the cached manager, never download one. */
export const COREPACK_OFFLINE_ENV: Readonly<Record<string, string>> = {
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_ENABLE_AUTO_PIN: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
}

/** The Corepack cache root (COREPACK_HOME or ~/.cache/node/corepack). */
export function corepackHome(): string {
  return process.env.COREPACK_HOME?.trim() || path.join(process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache"), "node", "corepack")
}

/**
 * The project's declared package manager (`packageManager: "pnpm@10.28.0"`) and, when Corepack already has
 * exactly that version cached outside the workspace, the directory to expose read-only.
 */
export function cachedPackageManager(pkg: { packageManager?: unknown }, workspaceReal: string): { name: string; version: string; cacheDir?: string } | undefined {
  const match = typeof pkg.packageManager === "string" ? /^(pnpm|yarn)@(\d+\.\d+\.\d+[\w.-]*)(?:\+.*)?$/.exec(pkg.packageManager) : null
  if (!match) return undefined
  const [, name, version] = match as unknown as [string, string, string]
  const dir = path.join(corepackHome(), "v1", name, version)
  const real = existingRealpath(dir)
  const usable = real !== undefined && !isInside(workspaceReal, real) && existsSyncDir(real) && existsSyncFile(path.join(real, "package.json"))
  return usable ? { name, version, cacheDir: real } : { name, version }
}

function existsSyncDir(target: string): boolean {
  try { return statSync(target).isDirectory() } catch { return false }
}

function existsSyncFile(target: string): boolean {
  try { return statSync(target).isFile() } catch { return false }
}

const PYTHON_BINARY = /^python3(?:\.\d+)?$/

/**
 * A project virtualenv the sandbox may run: `.venv` (or `venv`) is a real directory inside the workspace with
 * its `pyvenv.cfg`, and `bin/python` resolves to a Python interpreter in the `home` that `pyvenv.cfg` names
 * (a symlinked base interpreter outside the workspace, not a copied binary and not some other program).
 * Static checks only: nothing from the workspace is executed to decide this.
 */
export function workspaceVenv(workspaceReal: string): { python: string; sitePackages: string[] } | undefined {
  for (const name of [".venv", "venv"]) {
    const dir = path.join(workspaceReal, name)
    const realDir = existingRealpath(dir)
    if (!realDir || realDir !== dir || !existsSyncDir(realDir)) continue
    const cfgPath = path.join(dir, "pyvenv.cfg")
    if (existingRealpath(cfgPath) !== cfgPath) continue
    let cfg = ""
    try { cfg = readFileSync(cfgPath, "utf8") } catch { continue }
    const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim()
    const python = path.join(dir, "bin", "python")
    const target = existingRealpath(python)
    if (!home || !target || !path.isAbsolute(home)) continue
    if (isInside(workspaceReal, target) || !PYTHON_BINARY.test(path.basename(target))) continue
    const homeReal = existingRealpath(home)
    if (!homeReal || (path.dirname(target) !== homeReal && existingRealpath(path.join(home, path.basename(target))) !== target)) continue
    try { accessSync(target, constants.X_OK) } catch { continue }
    const lib = path.join(dir, "lib")
    let sitePackages: string[] = []
    try {
      sitePackages = readdirSync(lib).filter((entry) => /^python3\.\d+$/.test(entry)).map((entry) => path.join(lib, entry, "site-packages")).filter((site) => existingRealpath(site) === site)
    } catch { /* no lib */ }
    return { python, sitePackages }
  }
  return undefined
}

function venvHas(venv: { sitePackages: string[] }, module: string): boolean {
  return venv.sitePackages.some((site) => existsSyncDir(path.join(site, module)) || existsSyncFile(path.join(site, `${module}.py`)))
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

  // TEST without a "test" script uses the project's own unit-test script, so nobody edits package.json for it.
  const preferred = ACTION_TO_SCRIPT[action]
  const scriptName = pkg.scripts?.[preferred] ? preferred : action === "TEST" && pkg.scripts?.["test:unit"] ? "test:unit" : preferred
  if (!pkg.scripts || !pkg.scripts[scriptName]) {
    throw new Error(`Action ${action} requires a '${scriptName}' script in package.json`)
  }
  const scriptBody = String(pkg.scripts[scriptName])
  const manager = cachedPackageManager(pkg, workspaceReal)
  if (manager && !manager.cacheDir && new RegExp(String.raw`\b${manager.name}\b`).test(scriptBody)) {
    throw new EnvironmentSetupRequiredError(`the script calls ${manager.name}, and ${manager.name}@${manager.version} (the project's packageManager) is not in the Corepack cache; the sandbox has no network to download it`, `corepack install`)
  }
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0
  if (declared && !existsSyncDir(path.join(workspaceReal, "node_modules"))) {
    const install = manager ? `${manager.name} install --frozen-lockfile` : existsSyncFile(path.join(workspaceReal, "package-lock.json")) ? "npm ci" : "npm install"
    throw new EnvironmentSetupRequiredError("the project's dependencies are not installed (no node_modules)", install)
  }

  return {
    executable: resolveNpmBinary(workspaceReal),
    args: ["run", scriptName],
    packageJsonPath,
    packageJsonHash,
    scriptName,
    scriptBody,
    // Always offline Corepack: a verification run never downloads a package manager.
    env: { ...COREPACK_OFFLINE_ENV, ...(manager?.cacheDir ? { COREPACK_HOME: corepackHome() } : {}) },
    ...(manager?.cacheDir ? { readOnlyBinds: [manager.cacheDir] } : {}),
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
  const venv = workspaceVenv(workspaceReal)
  const systemPython = findExecutable("python3", { workspaceRoot: workspaceReal })
  const executable = venv?.python ?? systemPython
  if (!executable) return undefined
  // src layout: packages live under src/ (pyproject `where = ["src"]`, or src/ holding a package).
  const pyproject = await containedText(workspaceReal, "pyproject.toml")
  const srcLayout = /where\s*=\s*\[\s*["']src["']\s*\]/.test(pyproject) || /package_dir\s*=\s*\{\s*["']{2}\s*:\s*["']src["']/.test(await containedText(workspaceReal, "setup.py"))
    || await srcHoldsPackage(workspaceReal)
  const env = srcLayout ? { PYTHONPATH: path.join(workspaceReal, "src") } : undefined
  const command = (args: string[]): DiscoveredCommand => ({ executable, args, packageJsonPath: "", packageJsonHash: "", scriptName: "", scriptBody: "", ...(env ? { env } : {}), ...(venv ? { requiresSandbox: true } : {}) })
  // pytest from the project virtualenv (checked on disk), or from the host python3 (probed; a host binary).
  const hasPytest = () => venv ? venvHas(venv, "pytest") : spawnSync(executable, ["-I", "-c", "import pytest"], { stdio: "ignore", timeout: 10_000, cwd: os.tmpdir() }).status === 0
  const pytestSetup = venv ? `${path.relative(workspaceReal, venv.python)} -m pip install pytest` : "python3 -m venv .venv && .venv/bin/python -m pip install -e . pytest"
  if (djangoProject) return command(["manage.py", "test"])
  const pytestConfigured = await containedFileExists(workspaceReal, "pytest.ini")
    || await containedFileExists(workspaceReal, "conftest.py")
    || /^\[tool\.pytest/m.test(await containedText(workspaceReal, "pyproject.toml"))
    || /^\[(?:tool:)?pytest\]/m.test(await containedText(workspaceReal, "setup.cfg"))
    || /^\[pytest\]/m.test(await containedText(workspaceReal, "tox.ini"))
  if (pytestConfigured) {
    if (!hasPytest()) throw new EnvironmentSetupRequiredError(`pytest is not installed in ${venv ? "the project virtualenv" : "the host python3, and the project has no usable .venv"}`, pytestSetup)
    return command(["-m", "pytest", "-q"])
  }
  // Plain `def test_*` functions are invisible to unittest discovery ("Ran 0 tests"), which would look like a
  // failing run that no code change can fix. Such tests need pytest; without it, report no verifier instead.
  if (await isPytestStyleOnly(workspaceReal, testFiles)) {
    return hasPytest() ? command(["-m", "pytest", "-q"]) : undefined
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
