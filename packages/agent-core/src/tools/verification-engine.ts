import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { PreparedVerification, VerificationResult, VerificationStatus } from "./verification-contracts.ts"
import { resolveRepositoryPath } from "./path-safety.ts"
import { killProcessTree } from "./kill-process-tree.ts"

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

export type VerificationOutputCallback = (output: { stream: "stdout" | "stderr"; chunk: string }) => void

export interface VerificationEngineOptions {
  readonly workspaceRoot: string
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
    // Check for stale verification
    let currentPackageJsonContent: string
    try {
      currentPackageJsonContent = await fs.readFile(prepared.packageJsonPath, "utf-8")
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
      PATH: process.env.PATH || "",
      NODE_ENV: process.env.NODE_ENV || "test",
    }
    // Include npm_config_* variables
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toLowerCase().startsWith("npm_config_") && value !== undefined) {
        env[key] = value
      }
    }

    return new Promise((resolve) => {
      let isSettled = false

      const child = spawn(prepared.executable, prepared.args, {
        cwd: resolvedCwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
      })

      const stdoutDecoder = new StringDecoder("utf-8")
      const stderrDecoder = new StringDecoder("utf-8")

      let stdoutBuf = Buffer.alloc(0)
      let stderrBuf = Buffer.alloc(0)
      let stdoutTruncated = false
      let stderrTruncated = false

      child.stdout.on("data", (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk)
        if (text.length > 0 && onOutput) {
          onOutput({ stream: "stdout", chunk: text })
        }

        if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stdoutBuf.length
          if (chunk.length <= remaining) {
            stdoutBuf = Buffer.concat([stdoutBuf, chunk])
          } else {
            const { buffer: safeSlice } = truncateUtf8Buffer(chunk, remaining)
            stdoutBuf = Buffer.concat([stdoutBuf, safeSlice])
            stdoutTruncated = true
          }
        } else {
          stdoutTruncated = true
        }
      })

      child.stderr.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk)
        if (text.length > 0 && onOutput) {
          onOutput({ stream: "stderr", chunk: text })
        }

        if (stderrBuf.length < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stderrBuf.length
          if (chunk.length <= remaining) {
            stderrBuf = Buffer.concat([stderrBuf, chunk])
          } else {
            const { buffer: safeSlice } = truncateUtf8Buffer(chunk, remaining)
            stderrBuf = Buffer.concat([stderrBuf, safeSlice])
            stderrTruncated = true
          }
        } else {
          stderrTruncated = true
        }
      })

      let timeoutId: NodeJS.Timeout | undefined

      const settle = (status: VerificationStatus, exitCode: number | null, overrideStderr?: string) => {
        if (isSettled) return
        isSettled = true
        if (timeoutId) clearTimeout(timeoutId)

        const remOut = stdoutDecoder.end()
        if (remOut.length > 0 && onOutput) {
          onOutput({ stream: "stdout", chunk: remOut })
        }
        const remErr = stderrDecoder.end()
        if (remErr.length > 0 && onOutput) {
          onOutput({ stream: "stderr", chunk: remErr })
        }

        let stdout = stdoutBuf.toString("utf-8")
        if (stdoutTruncated) stdout += "\n[STDOUT TRUNCATED]"

        let stderr = overrideStderr !== undefined ? overrideStderr : stderrBuf.toString("utf-8")
        if (stderrTruncated && overrideStderr === undefined) stderr += "\n[STDERR TRUNCATED]"

        resolve({
          status,
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
