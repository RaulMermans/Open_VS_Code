import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"
import * as path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { PreparedVerification, VerificationResult, VerificationStatus } from "./verification-contracts.ts"
import { RepositoryPathError, resolveRepositoryPath } from "./path-safety.ts"
import { resolveWritePath } from "./mutation-engine.ts"
import { killProcessTree } from "./kill-process-tree.ts"
import { type CommandSandboxMode, planSandboxedCommand } from "./command-sandbox.ts"
import { COREPACK_OFFLINE_ENV, corepackHome, workspaceVenv } from "./verification-discovery.ts"

const MAX_OUTPUT_BYTES = 16 * 1024 // 16KB

export function truncateUtf8Buffer(buf: Buffer, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  if (buf.length <= maxBytes) {
    return { buffer: buf, truncated: false }
  }
  let end = maxBytes
  while (end > 0) {
    const b = buf[end - 1]
    if (b === undefined || (b & 0xC0) !== 0x80) break
    end--
  }
  const lastByte = end > 0 ? buf[end - 1] : undefined
  if (lastByte !== undefined && (lastByte & 0x80) !== 0) {
    const lead = lastByte
    let seqLen = 1
    if ((lead & 0xE0) === 0xC0) seqLen = 2
    else if ((lead & 0xF0) === 0xE0) seqLen = 3
    else if ((lead & 0xF8) === 0xF0) seqLen = 4

    if (end - 1 + seqLen <= maxBytes) {
      end = end - 1 + seqLen
    } else {
      end = end - 1
    }
  }
  return { buffer: buf.subarray(0, end), truncated: true }
}

const FAILURE_LINE = /(?:^|\s)(?:FAIL|FAILED)\b|^\s*not ok\b|AssertionError|(?:#|ℹ)\s+fail\b|Tests\s+\d+\s+failed/
const FAILURE_KEEP_BYTES = 8 * 1024

/** Lines that name a failure, plus a few lines after each one, even when they sit in the middle of a long log. */
export class FailureLineCapture {
  #carry = ""
  #lines: string[] = []
  #bytes = 0
  #follow = 0

  push(text: string): void {
    const lines = `${this.#carry}${text}`.split("\n")
    this.#carry = lines.pop() ?? ""
    for (const line of lines) this.#take(line)
  }

  end(): void {
    if (this.#carry) this.#take(this.#carry)
    this.#carry = ""
  }

  text(): string {
    return this.#lines.length > 0 ? `${this.#lines.join("\n")}\n` : ""
  }

  #take(line: string): void {
    const hit = FAILURE_LINE.test(line)
    if (hit) this.#follow = 8
    else if (this.#follow === 0) return
    else this.#follow -= 1
    const clipped = line.slice(0, 400)
    this.#lines.push(clipped)
    this.#bytes += clipped.length + 1
    // A monorepo log fails in several packages. Keep the latest failure, which is the one the task just ran.
    while (this.#bytes > FAILURE_KEEP_BYTES && this.#lines.length > 1) {
      this.#bytes -= this.#lines[0]!.length + 1
      this.#lines.shift()
    }
  }
}

/** Keep the end of a stream. Test reporters print the failures last; the head is often toolchain noise. */
export function retainOutputTail(existing: Buffer, chunk: Buffer, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  if (chunk.length === 0) return { buffer: existing, truncated: false }
  const combined = Buffer.concat([existing, chunk])
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false }
  let start = combined.length - maxBytes
  while (start < combined.length && (combined[start]! & 0xC0) === 0x80) start++
  if (start >= combined.length) start = Math.max(0, combined.length - maxBytes)
  return { buffer: combined.subarray(start), truncated: true }
}

export type VerificationOutputCallback = (output: { stream: "stdout" | "stderr"; chunk: string }) => void

export interface VerificationEngineOptions {
  readonly workspaceRoot: string
  /** ADR-046. Library default "off"; the desktop runtime passes the user setting (default "auto"). */
  readonly sandbox?: CommandSandboxMode
  /** Per-scope sandbox memory cap override (default SANDBOX_LIMITS.memory). */
  readonly sandboxMemoryMax?: string | undefined
}

export class VerificationEngine {
  readonly #consumed = new Set<string>()

  constructor(private readonly options: VerificationEngineOptions) {}

  async execute(
    prepared: PreparedVerification,
    abortSignal?: AbortSignal,
    onOutput?: VerificationOutputCallback
  ): Promise<VerificationResult> {
    if (this.#consumed.has(prepared.verificationId)) {
      return {
        status: "EXECUTION_ERROR",
        exitCode: null,
        stdout: "",
        stderr: "Verification has already been executed",
        durationMs: 0,
      }
    }
    this.#consumed.add(prepared.verificationId)

    const startTime = Date.now()

    // A repository without package.json verifies through node --test. There is no script hash to check.
    if (prepared.packageJsonPath) {
    let packageJsonPath = prepared.packageJsonPath
    try {
      packageJsonPath = await resolveRepositoryPath(this.options.workspaceRoot, prepared.packageJsonPath, "file")
    } catch (error) {
      return {
        status: "EXECUTION_ERROR",
        exitCode: null,
        stdout: "",
        stderr: `package.json validation failed: ${(error as Error).message}`,
        durationMs: Date.now() - startTime,
      }
    }
    // Check for stale verification
    let currentPackageJsonContent: string
    try {
      currentPackageJsonContent = await fs.readFile(packageJsonPath, "utf-8")
    } catch (error) {
      return {
        status: "EXECUTION_ERROR",
        exitCode: null,
        stdout: "",
        stderr: `Failed to read package.json at execution time: ${(error as Error).message}`,
        durationMs: Date.now() - startTime,
      }
    }
    const currentHash = crypto.createHash("sha256").update(currentPackageJsonContent).digest("hex")
    if (currentHash !== prepared.packageJsonHash) {
      return {
        status: "STALE_VERIFICATION",
        exitCode: null,
        stdout: "",
        stderr: "Verification script or package.json has changed since preparation (package.json modified)",
        durationMs: Date.now() - startTime,
      }
    }

    let parsedPkg: any
    try {
      parsedPkg = JSON.parse(currentPackageJsonContent)
    } catch {
      // Ignored here; hash already matched
    }
    if (prepared.scriptName && prepared.scriptBody && parsedPkg?.scripts && prepared.scriptName in parsedPkg.scripts && parsedPkg.scripts[prepared.scriptName] !== prepared.scriptBody) {
      return {
        status: "STALE_VERIFICATION",
        exitCode: null,
        stdout: "",
        stderr: `Script '${prepared.scriptName}' was modified since preparation`,
        durationMs: Date.now() - startTime,
      }
    }
    }

    // Verify CWD is within workspaceRoot using authoritative containment check
    let resolvedCwd: string
    try {
      resolvedCwd = await resolveRepositoryPath(this.options.workspaceRoot, prepared.cwd, "directory")
      await assertExecutableContained(this.options.workspaceRoot, prepared.executable)
      await assertArgsContained(this.options.workspaceRoot, prepared.args)
    } catch (error) {
      return {
        status: "EXECUTION_ERROR",
        exitCode: null,
        stdout: "",
        stderr: `CWD validation failed: ${(error as Error).message}`,
        durationMs: Date.now() - startTime,
      }
    }

    const env: Record<string, string> = {
      PATH: absolutePathEntries(process.env.PATH || ""),
      NODE_ENV: process.env.NODE_ENV || "test",
    }
    // Prepared environment: workspace PYTHONPATH, the fixed offline Corepack settings, and COREPACK_HOME only as
    // the real Corepack cache root. Anything else is refused.
    for (const [key, value] of Object.entries(prepared.env ?? {})) {
      if (key in COREPACK_OFFLINE_ENV) {
        if (value !== COREPACK_OFFLINE_ENV[key]) return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: `${key} must be ${COREPACK_OFFLINE_ENV[key]} for verification`, durationMs: Date.now() - startTime }
        env[key] = value
        continue
      }
      if (key === "COREPACK_HOME") {
        if (value !== corepackHome()) return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: "COREPACK_HOME must be the Corepack cache", durationMs: Date.now() - startTime }
        env[key] = value
        continue
      }
      if (key !== "PYTHONPATH") {
        return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: `Environment variable ${key} is not allowed for verification`, durationMs: Date.now() - startTime }
      }
      try {
        const entries = await Promise.all(value.split(path.delimiter).filter(Boolean).map((entry) => resolveRepositoryPath(this.options.workspaceRoot, entry, "directory")))
        env.PYTHONPATH = entries.join(path.delimiter)
      } catch (error) {
        return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: `PYTHONPATH must stay inside the workspace: ${(error as Error).message}`, durationMs: Date.now() - startTime }
      }
    }
    // Include npm_config_* variables
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toLowerCase().startsWith("npm_config_") && value !== undefined) {
        env[key] = value
      }
    }

    // Workspace-local toolchains and cached package managers: re-checked now, sandbox mode "required" only.
    const workspaceReal = await fs.realpath(this.options.workspaceRoot)
    const configuredMode = this.options.sandbox ?? "off"
    if (prepared.requiresSandbox || isInsideReal(workspaceReal, path.resolve(prepared.executable))) {
      const venv = workspaceVenv(workspaceReal)
      if (!venv || path.resolve(prepared.executable) !== venv.python) {
        return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: "The workspace interpreter is no longer a valid project virtualenv", durationMs: Date.now() - startTime }
      }
      if (configuredMode === "off") {
        return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: "ENVIRONMENT_SETUP_REQUIRED: this verification uses the project's virtualenv, which runs only inside the command sandbox, and the sandbox is turned off.", durationMs: Date.now() - startTime }
      }
    }
    const readOnlyBinds: string[] = []
    for (const dir of prepared.readOnlyBinds ?? []) {
      const real = await fs.realpath(dir).catch(() => undefined)
      const cacheRoot = await fs.realpath(path.join(corepackHome(), "v1")).catch(() => undefined)
      if (!real || real !== dir || !cacheRoot || !isInsideReal(cacheRoot, real) || real === cacheRoot || isInsideReal(workspaceReal, real)) {
        return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: `Read-only bind refused: ${dir} is not a cached package manager`, durationMs: Date.now() - startTime }
      }
      readOnlyBinds.push(real)
    }
    const sandboxed = prepared.requiresSandbox || isInsideReal(workspaceReal, path.resolve(prepared.executable))
    const plan = planSandboxedCommand({
      mode: sandboxed ? "required" : configuredMode,
      readOnlyBinds,
      workspaceRoot: this.options.workspaceRoot,
      cwd: resolvedCwd,
      executable: prepared.executable,
      args: prepared.args,
      env,
      memoryMax: this.options.sandboxMemoryMax,
    })
    if ("error" in plan) {
      return { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: plan.error, durationMs: Date.now() - startTime, sandbox: plan.status }
    }
    const sandbox = plan.status

    return new Promise<VerificationResult>((resolveRaw) => {
      const resolve = (result: VerificationResult) => resolveRaw({ ...result, sandbox })
      let isSettled = false

      const child = spawn(plan.executable, [...plan.args], {
        cwd: resolvedCwd,
        env: plan.env,
        shell: false,
        detached: process.platform !== "win32",
      })

      const stdoutDecoder = new StringDecoder("utf-8")
      const stderrDecoder = new StringDecoder("utf-8")

      let stdoutBuf = Buffer.alloc(0)
      let stderrBuf = Buffer.alloc(0)
      let stdoutTruncated = false
      let stderrTruncated = false
      const stdoutFailures = new FailureLineCapture()
      const stderrFailures = new FailureLineCapture()

      child.stdout.on("data", (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk)
        if (text.length > 0) stdoutFailures.push(text)
        if (text.length > 0 && onOutput) {
          onOutput({ stream: "stdout", chunk: text })
        }

        const retainedOut = retainOutputTail(stdoutBuf, chunk, MAX_OUTPUT_BYTES)
        stdoutBuf = Buffer.from(retainedOut.buffer)
        if (retainedOut.truncated) stdoutTruncated = true
      })

      child.stderr.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk)
        if (text.length > 0) stderrFailures.push(text)
        if (text.length > 0 && onOutput) {
          onOutput({ stream: "stderr", chunk: text })
        }

        const retainedErr = retainOutputTail(stderrBuf, chunk, MAX_OUTPUT_BYTES)
        stderrBuf = Buffer.from(retainedErr.buffer)
        if (retainedErr.truncated) stderrTruncated = true
      })

      let timeoutId: NodeJS.Timeout | undefined

      const settle = (status: VerificationStatus, exitCode: number | null, overrideStderr?: string) => {
        if (isSettled) return
        isSettled = true
        if (timeoutId) clearTimeout(timeoutId)

        const remOut = stdoutDecoder.end()
        if (remOut.length > 0) {
          stdoutFailures.push(remOut)
          const retainedOut = retainOutputTail(stdoutBuf, Buffer.from(remOut), MAX_OUTPUT_BYTES)
          stdoutBuf = Buffer.from(retainedOut.buffer)
          if (retainedOut.truncated) stdoutTruncated = true
          if (onOutput) onOutput({ stream: "stdout", chunk: remOut })
        }
        stdoutFailures.end()
        const remErr = stderrDecoder.end()
        if (remErr.length > 0 && overrideStderr === undefined) {
          stderrFailures.push(remErr)
          const retainedErr = retainOutputTail(stderrBuf, Buffer.from(remErr), MAX_OUTPUT_BYTES)
          stderrBuf = Buffer.from(retainedErr.buffer)
          if (retainedErr.truncated) stderrTruncated = true
          if (onOutput) onOutput({ stream: "stderr", chunk: remErr })
        }
        stderrFailures.end()

        let stdout = stdoutBuf.toString("utf-8")
        const keptOut = stdoutFailures.text()
        if (keptOut && !stdout.includes(keptOut.slice(0, 80))) stdout = `${keptOut}\n[EARLIER FAILURES KEPT]\n${stdout}`
        if (stdoutTruncated) stdout += "\n[STDOUT TRUNCATED]"

        let stderr = overrideStderr !== undefined ? overrideStderr : stderrBuf.toString("utf-8")
        const keptErr = overrideStderr === undefined ? stderrFailures.text() : ""
        if (keptErr && !stderr.includes(keptErr.slice(0, 80))) stderr = `${keptErr}\n[EARLIER FAILURES KEPT]\n${stderr}`
        if (stderrTruncated && overrideStderr === undefined) stderr += "\n[STDERR TRUNCATED]"

        let finalStatus = status
        if (finalStatus === "PASS" && isNodeTestCommand(prepared.args) && !nodeTestReportedPass(stdout, stderr, stdoutTruncated || stderrTruncated)) {
          finalStatus = "FAIL"
          stderr += "\nNode test run did not report a passing test."
        }
        if (finalStatus === "PASS" && isPythonTestCommand(prepared.args) && !pythonTestReportedPass(stdout, stderr, stdoutTruncated || stderrTruncated)) {
          finalStatus = "FAIL"
          stderr += "\nPython test run did not report a passing test."
        }

        resolve({
          status: finalStatus,
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
        })
      }

      timeoutId = setTimeout(() => {
        killProcessTree(child)
        settle("TIMEOUT", null)
      }, prepared.timeoutMs)

      const onAbort = () => {
        killProcessTree(child)
        settle("CANCELLED", null)
      }

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort()
        } else {
          abortSignal.addEventListener("abort", onAbort)
        }
      }

      child.on("error", (err) => {
        settle("EXECUTION_ERROR", null, err.message)
      })

      child.on("close", (code) => {
        if (isSettled) return

        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort)
        }

        const status = code === 0 ? "PASS" : "FAIL"
        settle(status, code)
      })
    })
  }
}

function absolutePathEntries(pathEnv: string): string {
  return pathEnv.split(path.delimiter).filter((entry) => path.isAbsolute(entry)).join(path.delimiter)
}

async function assertExecutableContained(workspaceRoot: string, executable: string): Promise<void> {
  if (executable.includes("\0")) throw new Error("Executable path is invalid")
  if (!executable.includes("/") && !executable.includes("\\") && !executable.includes("..")) return
  if (path.isAbsolute(executable)) {
    const root = await fs.realpath(workspaceRoot)
    let real: string
    try {
      real = await fs.realpath(executable)
    } catch (error) {
      throw new Error(`Executable was not found: ${executable}`, { cause: error })
    }
    const rel = path.relative(root, real)
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new Error(`Executable resolves inside the workspace: ${executable}`)
    }
    return
  }
  await resolveRepositoryPath(workspaceRoot, executable, "file")
}

async function assertArgsContained(workspaceRoot: string, args: readonly string[]): Promise<void> {
  for (const arg of args) {
    if (!isPathArg(arg)) continue
    try {
      await resolveRepositoryPath(workspaceRoot, arg)
    } catch (error) {
      // An output path the command will create (for example a report or pid file) need not exist yet,
      // but its nearest existing ancestor must still resolve inside the workspace.
      if (!(error instanceof RepositoryPathError) || error.code !== "NOT_FOUND") throw error
      await resolveWritePath(workspaceRoot, arg, { mustExist: false })
    }
  }
}

function isInsideReal(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function isPathArg(arg: string): boolean {
  if (arg.startsWith("-") && !arg.includes("..") && !arg.includes("/") && !arg.includes("\\")) return false
  return arg.includes("/") || arg.includes("\\") || arg.startsWith(".") || path.isAbsolute(arg)
}

/** unittest, Django's manage.py test and pytest: an exit code of 0 is not enough when no test ran. */
function isPythonTestCommand(args: readonly string[]): boolean {
  return (args[0] === "-m" && (args[1] === "unittest" || args[1] === "pytest")) || (args[0] === "manage.py" && args[1] === "test")
}

function pythonTestReportedPass(stdout: string, stderr: string, truncated: boolean): boolean {
  if (truncated) return false
  const text = `${stdout}\n${stderr}`
  const ran = [...text.matchAll(/^Ran (\d+) tests? in /gm)].at(-1)
  if (ran) return Number(ran[1]) > 0 && /^OK\b/m.test(text)
  const pytest = [...text.matchAll(/(\d+) passed/g)].at(-1)
  return pytest !== undefined && Number(pytest[1]) > 0 && !/\d+ (?:failed|error)/.test(text)
}

function isNodeTestCommand(args: readonly string[]): boolean {
  return args.includes("--test")
}

function nodeTestReportedPass(stdout: string, stderr: string, truncated: boolean): boolean {
  if (truncated) return false
  const text = `${stdout}\n${stderr}`
  const tests = [...text.matchAll(/(?:#|ℹ)\s+tests\s+(\d+)/g)]
  const fails = [...text.matchAll(/(?:#|ℹ)\s+fail\s+(\d+)/g)]
  const cancelled = [...text.matchAll(/(?:#|ℹ)\s+cancelled\s+(\d+)/g)]
  if (tests.length === 0 || fails.length === 0) return false
  const testCount = Number(tests.at(-1)?.[1])
  const failCount = Number(fails.at(-1)?.[1])
  const cancelledCount = cancelled.length === 0 ? 0 : Number(cancelled.at(-1)?.[1])
  return testCount > 0 && failCount === 0 && cancelledCount === 0
}
