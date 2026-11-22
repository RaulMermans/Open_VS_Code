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
import { AgentSessionBridge, DEPENDENCY_MANIFEST } from "../src/bridge.ts"
import type { IdeContextSnapshot, IdeHost } from "../src/contracts.ts"
import { applyChatModelSelection, buildStarterRoutingConfig } from "../../vscode-integration/src/local-model-selection.ts"
import { TypeScriptCodeIntelligence } from "../../agent-core/src/tools/typescript-code-intelligence.ts"

const [workspaceArg, promptFile, outFile] = process.argv.slice(2)
if (!workspaceArg || !promptFile || !outFile || process.env.OPEN_VS_CODE_REAL_INFERENCE !== "1") {
  console.error("usage (with OPEN_VS_CODE_REAL_INFERENCE=1): run-workspace-task.ts <workspace> <promptFile> <out.json> [--code-intel] [--timeout-min N]")
  process.exit(2)
}
const codeIntel = process.argv.includes("--code-intel")
const timeoutIndex = process.argv.indexOf("--timeout-min")
const timeoutMin = timeoutIndex > 0 ? Number(process.argv[timeoutIndex + 1]) : 15
// Extended session: up to three work units of --timeout-min each, continued only while a unit made progress.
const units = process.argv.includes("--units") ? Number(process.argv[process.argv.indexOf("--units") + 1]) : 1
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
    // Dependency manifests are never auto-approved (a dependency or script change needs a person), like anything outside the workspace.
    const decision = paths.every(inside) && !paths.some((path) => DEPENDENCY_MANIFEST.test(path)) && (!cwd || inside(cwd)) ? "APPROVE" : "REJECT"
    approvals.push({ prompt: prompt.slice(0, 300), decision })
    return decision
  },
} as IdeHost

/**
 * The desktop's routing for a chosen chat model (model-routing.ts: starter config, then the chat selection).
 * The starter config alone falls back to qwen2.5-coder:7b for any model outside the Qwen-Coder families.
 */
function evalRoutingConfig(model: string) {
  const config = applyChatModelSelection(buildStarterRoutingConfig([model]), model)
  const served = config.deployments.find((deployment) => config.routes.coding?.includes(deployment.id))?.modelName
  if (served !== model) throw new Error(`routing serves ${served}, not the requested ${model}`)
  return config
}

const controller = new AbortController()
let timedOut = false
const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMin * 60_000 * units)
const bridge = new AgentSessionBridge({
  host, workspaceRoot: root, routingConfigOverride: evalRoutingConfig(process.env.OPEN_VS_CODE_EVAL_MODEL ?? "qwen3-coder:30b"), skipWorkspaceRoutingFile: true,
  skills: { enabled: false }, workflow: { enabled: false }, progressMonitor: { enabled: false }, learning: { enabled: false },
  ...(codeIntel ? { codeIntelligence: new TypeScriptCodeIntelligence(root) } : {}),
  ...(units > 1 ? { unitBudgetMs: timeoutMin * 60_000 } : {}),
})
const started = Date.now()
let result: any
let unitsUsed = 1
const unitLog: Array<{ unit: number; seconds: number; toolCalls: number }> = []
try {
  result = await bridge.runTask(instruction, "BUILD", controller.signal)
  while (units > 1 && result?.failureReason === "MAX_TURNS_EXCEEDED" && unitsUsed < units) {
    unitsUsed += 1
    unitLog.push({ unit: unitsUsed - 1, seconds: Math.round((Date.now() - started) / 1000), toolCalls: result.toolCalls?.length ?? 0 })
    result = await bridge.continueTurnBudget(result.runId ?? result.diagnostics?.runId, controller.signal)
  }
} catch (error) {
  result = { status: "HARNESS_ERROR", failureReason: String(error).slice(0, 300) }
} finally {
  clearTimeout(timer)
}
// What Ollama actually had loaded at the end of the run (evidence that the requested model served it).
const servedModels = await fetch("http://127.0.0.1:11434/api/ps").then((response) => response.json()).then((body: any) => (body.models ?? []).map((model: any) => model.name)).catch(() => [])
const toolCalls = (result?.toolCalls ?? []) as Array<{ name: string; outcome: string }>
const summary = {
  model: process.env.OPEN_VS_CODE_EVAL_MODEL ?? "qwen3-coder:30b", servedModels, codeIntel, timedOut, durationMs: Date.now() - started, status: result?.status, failureReason: result?.failureReason, turns: result?.turns,
  toolCalls: toolCalls.length, toolSequence: toolCalls.map((call) => `${call.name}:${call.outcome}`),
  unitsUsed, unitLog, approvals, finalAnswer: String(result?.finalAnswer ?? "").slice(0, 1500), diagnostics: result?.diagnostics,
}
await writeFile(outFile, JSON.stringify(summary, null, 2))
if (process.argv.includes("--trace")) {
  // Full diagnostic trace: profile, every call with arguments, observations, context omissions, events.
  const { classifyTaskProfile } = await import("../../agent-core/src/agent/task-profile.ts")
  const profile = classifyTaskProfile(instruction, "BUILD")
  await writeFile(outFile.replace(/\.json$/, ".trace.json"), JSON.stringify({
    model: process.env.OPEN_VS_CODE_EVAL_MODEL ?? "qwen3-coder:30b",
    profile: { category: profile.category, requiresCodeChange: profile.requiresCodeChange, explicitFilePaths: profile.explicitFilePaths, toolGuidance: profile.toolGuidance },
    toolCalls, observations: (result?.observations ?? []).map((item: any) => ({ tool: item.toolName, ok: item.ok, arguments: item.arguments, content: String(item.content).slice(0, 2500) })),
    contextDiagnostics: result?.contextDiagnostics ?? [], nonProgress: result?.nonProgress,
    events: (result?.events ?? []).map((event: any) => ({ type: event.type, payload: JSON.stringify(event.payload ?? {}).slice(0, 400) })),
  }, null, 2))
}
console.log(`status=${summary.status} turns=${summary.turns} tools=${summary.toolCalls} approvals=${approvals.length} ${Math.round(summary.durationMs / 1000)}s timedOut=${timedOut}`)
process.exit(0)
