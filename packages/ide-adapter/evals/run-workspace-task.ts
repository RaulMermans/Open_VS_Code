/**
 * Sprint 24: one live task on an existing disposable workspace (e.g. a Reeprov clone), through the same
 * AgentSessionBridge path as run-coding-eval.ts. Approves writes and commands that stay inside the
 * workspace; refuses anything else. Correctness is judged afterwards by the caller (tests, tsc, oracle).
 *
 *   OPEN_VS_CODE_REAL_INFERENCE=1 node --import tsx/esm packages/ide-adapter/evals/run-workspace-task.ts \
 *     <workspace> <promptFile> <out.json> [--code-intel] [--timeout-min 15]
 */
import { readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { AgentSessionBridge } from "../src/bridge.ts"
import type { IdeContextSnapshot, IdeHost } from "../src/contracts.ts"
import { buildStarterRoutingConfig } from "../../vscode-integration/src/local-model-selection.ts"
import { TypeScriptCodeIntelligence } from "../../agent-core/src/tools/typescript-code-intelligence.ts"

const [workspaceArg, promptFile, outFile] = process.argv.slice(2)
if (!workspaceArg || !promptFile || !outFile || process.env.OPEN_VS_CODE_REAL_INFERENCE !== "1") {
  console.error("usage (with OPEN_VS_CODE_REAL_INFERENCE=1): run-workspace-task.ts <workspace> <promptFile> <out.json> [--code-intel] [--timeout-min N]")
  process.exit(2)
}
const codeIntel = process.argv.includes("--code-intel")
const timeoutIndex = process.argv.indexOf("--timeout-min")
const timeoutMin = timeoutIndex > 0 ? Number(process.argv[timeoutIndex + 1]) : 15
const root = await realpath(workspaceArg)
const instruction = (await readFile(promptFile, "utf8")).trim()
const inside = (path: string) => {
  const rel = relative(root, resolve(root, path))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}
const approvals: Array<{ prompt: string; decision: string }> = []
const host: IdeHost = {
  getWorkspaceRoots: async () => [{ uri: `file://${root}`, fsPath: root }],
  getActiveDocument: async () => null,
  getSelection: async () => null,
  getVisibleDocuments: async () => [],
  getDiagnostics: async () => [],
  isWorkspaceTrusted: async () => true,
  showOutput: async () => {},
  showError: async () => {},
  onWorkspaceChange: () => ({ dispose: () => {} }),
  getSnapshot: async (): Promise<IdeContextSnapshot> => ({ workspaceRoots: [{ uri: `file://${root}`, fsPath: root }], activeDocument: null, selection: null, visibleDocuments: [], diagnostics: [], isTrusted: true }),
  requestConfirmation: async (prompt: string, payload: any) => {
    const paths = Array.isArray(payload?.files) ? payload.files.map((file: any) => String(file.path)) : payload?.path ? [String(payload.path)] : []
    const cwd = payload?.preparedCommand?.cwd
    const decision = paths.every(inside) && (!cwd || inside(cwd)) ? "APPROVE" : "REJECT"
    approvals.push({ prompt: prompt.slice(0, 300), decision })
    return decision
  },
} as IdeHost

const controller = new AbortController()
let timedOut = false
const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMin * 60_000)
const bridge = new AgentSessionBridge({
  host, workspaceRoot: root, routingConfigOverride: buildStarterRoutingConfig([process.env.OPEN_VS_CODE_EVAL_MODEL ?? "qwen3-coder:30b"]), skipWorkspaceRoutingFile: true,
  skills: { enabled: false }, workflow: { enabled: false }, progressMonitor: { enabled: false }, learning: { enabled: false },
  ...(codeIntel ? { codeIntelligence: new TypeScriptCodeIntelligence(root) } : {}),
})
const started = Date.now()
let result: any
try {
  result = await bridge.runTask(instruction, "BUILD", controller.signal)
} catch (error) {
  result = { status: "HARNESS_ERROR", failureReason: String(error).slice(0, 300) }
} finally {
  clearTimeout(timer)
}
const toolCalls = (result?.toolCalls ?? []) as Array<{ name: string; outcome: string }>
const summary = {
  codeIntel, timedOut, durationMs: Date.now() - started, status: result?.status, failureReason: result?.failureReason, turns: result?.turns,
  toolCalls: toolCalls.length, toolSequence: toolCalls.map((call) => `${call.name}:${call.outcome}`),
  approvals, finalAnswer: String(result?.finalAnswer ?? "").slice(0, 1500),
}
await writeFile(outFile, JSON.stringify(summary, null, 2))
console.log(`status=${summary.status} turns=${summary.turns} tools=${summary.toolCalls} approvals=${approvals.length} ${Math.round(summary.durationMs / 1000)}s timedOut=${timedOut}`)
process.exit(0)
