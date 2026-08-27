import { spawn } from "node:child_process"
import * as path from "node:path"
import { PreparedVerification, VerificationResult, VerificationStatus } from "./verification-contracts.ts"

const MAX_OUTPUT_BYTES = 16 * 1024 // 16KB

export interface VerificationEngineOptions {
  readonly workspaceRoot: string
}

export class VerificationEngine {
  constructor(private readonly options: VerificationEngineOptions) {}

  async execute(
    prepared: PreparedVerification,
    abortSignal?: AbortSignal
  ): Promise<VerificationResult> {
    const startTime = Date.now()
    
    // Verify CWD is within workspaceRoot
    const resolvedCwd = path.resolve(prepared.cwd)
    if (!resolvedCwd.startsWith(path.resolve(this.options.workspaceRoot))) {
      return {
        status: "EXECUTION_ERROR",
        exitCode: null,
        stdout: "",
        stderr: "CWD must be within workspace root",
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
      })

      let stdoutBuf = Buffer.alloc(0)
      let stderrBuf = Buffer.alloc(0)
      let stdoutTruncated = false
      let stderrTruncated = false

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stdoutBuf.length
          stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, remaining)])
          if (chunk.length > remaining) stdoutTruncated = true
        } else {
          stdoutTruncated = true
        }
      })

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBuf.length < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stderrBuf.length
          stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, remaining)])
          if (chunk.length > remaining) stderrTruncated = true
        } else {
          stderrTruncated = true
        }
      })

      let timeoutId: NodeJS.Timeout | undefined

      const settle = (status: VerificationStatus, exitCode: number | null, overrideStderr?: string) => {
        if (isSettled) return
        isSettled = true
        if (timeoutId) clearTimeout(timeoutId)
        
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
        child.kill("SIGKILL")
        settle("TIMEOUT", null)
      }, prepared.timeoutMs)

      const onAbort = () => {
        child.kill("SIGKILL")
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
