/**
 * Run Benchmark CLI — Sprint 4E.
 *
 * Entry point for: npm run eval:model and npm run eval:models
 *
 * This CLI is strictly gated by the inference host authorization.
 * Without OPEN_VS_CODE_REAL_INFERENCE=1, it exits with BLOCKED_WITH_EVIDENCE.
 *
 * To run a real benchmark on an authorized host:
 *   export OPEN_VS_CODE_REAL_INFERENCE=1
 *   export OPEN_VS_CODE_MODEL_ENDPOINT=http://localhost:11434
 *   export OPEN_VS_CODE_AGENT_MODEL=qwen2.5-coder:7b
 *   export OPEN_VS_CODE_FIM_MODEL=qwen2.5-coder:7b
 *   npm run eval:models
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkInferenceGate, inferenceGateBlockedMessage } from "../../src/model/inference-gate.ts"
import { benchmarkCli } from "./real-model-benchmark.ts"

export function getCanonicalEvalsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(currentDir, "../../../..")
  return path.resolve(repoRoot, "evals/results")
}

export async function main(): Promise<void> {
  const gate = checkInferenceGate()
  if (!gate.authorized) {
    console.log(inferenceGateBlockedMessage())
    return
  }

  await benchmarkCli()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[benchmark] Failed:", err)
    process.exit(1)
  })
}
