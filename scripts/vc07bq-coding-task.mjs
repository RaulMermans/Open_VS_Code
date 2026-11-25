#!/usr/bin/env node
/**
 * VC-07B-Q Gate D2: ONE bounded coding task through the real Agent Core runner and tool executor:
 *   AgentRunner → HaloProvider (pinned x3-qwen3-14b-vulkan) → HALO Core → admission → daemon → llama.cpp 14B
 *   → structured tool call → read_file / apply_patch / run_verification(TEST) in a disposable workspace → continuation.
 *
 * Run (only with explicit Gate D2 approval):
 *   HALO_APP_TOKEN_OPEN_VSCODE=… HALO_VC07BQ_OUT=/path/evidence.json \
 *     node --import tsx/esm scripts/vc07bq-coding-task.mjs --approve-gate D2
 *
 * One attempt only. Every stop condition ends the run; nothing is retried. Never prints tokens, prompts or model output.
 * Deviation from the IDE: no VS Code UI, MCP, memory or skills; same AgentRunner, HaloProvider and production tools.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '../packages/agent-core/src/agent/runner.ts';
import { calculateBudget } from '../packages/agent-core/src/context/budget.ts';
import { HaloProvider } from '../packages/agent-core/src/model/halo.ts';
import { MutationEngine } from '../packages/agent-core/src/tools/mutation-engine.ts';
import { createMutationToolRegistrations } from '../packages/agent-core/src/tools/mutation-registry.ts';
import { createReadOnlyToolRegistry } from '../packages/agent-core/src/tools/read-only-registry.ts';
import { createVerificationToolRegistrations } from '../packages/agent-core/src/tools/verification-registry.ts';

// Proposed limits (VC-07B-Q plan §D2). Fixed for the run; never raised to rescue a failing attempt.
const LIMITS = Object.freeze({
  turns: 6, outputTokensPerTurn: 1024, inputCharsPerRequest: 20_000, toolCalls: 8, wallClockMs: 180_000,
  testRuns: 1, perRequestTimeoutMs: 100_000,
});
const MODEL_ID = 'x3-qwen3-14b-vulkan';
const RUNTIME_ID = 'llama-cpp-vulkan-b12144-qwen3-14b';
const ALLOWED_TOOLS = new Set(['read_file', 'apply_patch', 'run_verification']);
const ALLOWED_CHANGES = ['src/sum.ts'];
const CORE = process.env.HALO_CORE_URL ?? 'http://127.0.0.1:4310';
const OLLAMA = process.env.HALO_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const token = process.env.HALO_APP_TOKEN_OPEN_VSCODE?.trim();
const outPath = process.env.HALO_VC07BQ_OUT;
const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'fixtures', 'vc07bq-sum-defect');

if (!process.argv.includes('--approve-gate') || process.argv[process.argv.indexOf('--approve-gate') + 1] !== 'D2') {
  console.error('refusing: Gate D2 requires --approve-gate D2');
  process.exit(2);
}
if (!token || !outPath) {
  console.error('missing HALO_APP_TOKEN_OPEN_VSCODE or HALO_VC07BQ_OUT');
  process.exit(2);
}
if (!['127.0.0.1', 'localhost'].includes(new URL(CORE).hostname)) {
  console.error('refusing: HALO Core must be loopback');
  process.exit(2);
}

const evidence = { schema: 'halo.qa/vc07bq-d2/v1', startedAt: new Date().toISOString(), limits: LIMITS, modelId: MODEL_ID, turns: [], approvals: [], stops: [] };
const stop = (code, detail = {}) => { evidence.stops.push({ code, ...detail }); };

const json = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
};
const snapshot = async () => {
  const [version, admission, runtimes, ollama] = await Promise.all([
    json(`${CORE}/version`), json(`${CORE}/inference/admission`), json(`${CORE}/infrastructure/model-runtimes`), json(`${OLLAMA}/api/ps`),
  ]);
  return {
    observedAt: new Date().toISOString(),
    releaseId: version.body?.build?.releaseId ?? null,
    admission: { maxActiveRequests: admission.body?.maxActiveRequests ?? null, activeRequestCount: admission.body?.activeRequestCount ?? null },
    runtimes: (runtimes.body?.observations ?? []).map((item) => ({
      runtimeId: item.runtimeId, haloModelId: item.haloModelId, phase: item.phase, owned: item.process?.owned ?? null,
      pid: item.processIdentity?.pid ?? null, starttime: item.processIdentity?.starttime ?? null, spawnGeneration: item.processIdentity?.spawnGeneration ?? null,
      automaticEviction: item.lifecycle?.automaticEviction ?? null,
    })),
    llamaServerPids: pgrepLlama(),
    ollamaModels: (ollama.body?.models ?? []).map((model) => model.name),
  };
};
function pgrepLlama() {
  try { return execFileSync('pgrep', ['-x', 'llama-server'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number).sort(); } catch { return []; }
}
const identity = (snap, runtimeId) => snap.runtimes.find((item) => item.runtimeId === runtimeId) ?? null;
const sameGeneration = (a, b) => a && b && a.pid === b.pid && a.starttime === b.starttime && a.spawnGeneration === b.spawnGeneration;

/** Real HaloProvider behind fixed limits; records only identities, sizes and counts. */
class BudgetedProvider {
  #inner; #deadline; toolCalls = 0;
  constructor(inner, deadline) { this.#inner = inner; this.#deadline = deadline; this.capabilities = inner.capabilities; }
  async complete(request) {
    if (evidence.turns.length >= LIMITS.turns) { stop('BUDGET_TURNS'); throw new Error('turn budget exhausted'); }
    const inputChars = JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length;
    if (inputChars > LIMITS.inputCharsPerRequest) { stop('BUDGET_INPUT_CHARS', { inputChars }); throw new Error('input budget exceeded'); }
    const started = Date.now();
    const turn = { turn: evidence.turns.length + 1, inputChars, toolsOffered: (request.tools ?? []).map((tool) => tool.name) };
    evidence.turns.push(turn);
    try {
      const response = await this.#inner.complete({
        ...request,
        maxOutputTokens: Math.min(request.maxOutputTokens ?? LIMITS.outputTokensPerTurn, LIMITS.outputTokensPerTurn),
        signal: request.signal ? AbortSignal.any([request.signal, this.#deadline]) : this.#deadline,
      });
      const calls = response.toolCalls ?? [];
      Object.assign(turn, {
        ok: true, ms: Date.now() - started, model: response.model, finishReason: response.finishReason ?? null, usage: response.usage ?? null,
        contentChars: response.message.content.length,
        toolCalls: calls.map((call) => ({ id: call.id, name: call.name, argumentKeys: Object.keys(call.arguments ?? {}).sort() })),
      });
      if (response.model !== MODEL_ID) { stop('WRONG_MODEL', { model: response.model }); throw new Error('model identity changed'); }
      this.toolCalls += calls.length;
      if (this.toolCalls > LIMITS.toolCalls) { stop('BUDGET_TOOL_CALLS'); throw new Error('tool-call budget exceeded'); }
      for (const call of calls) if (!ALLOWED_TOOLS.has(call.name)) { stop('UNAUTHORIZED_TOOL_REQUESTED', { name: call.name }); throw new Error('unauthorized tool'); }
      return response;
    } catch (error) {
      Object.assign(turn, { ok: turn.ok ?? false, ms: Date.now() - started, code: error?.code ?? 'ERROR' });
      if (error?.code === 'HALO_UNCERTAIN_COMPLETION' || error?.code === 'HALO_TIMEOUT' || error?.code === 'HALO_CANCELLED') stop('UNCERTAIN_COMPLETION', { code: error.code });
      else if (turn.ok !== true && evidence.stops.length === 0) stop('PROVIDER_ERROR', { code: error?.code ?? 'ERROR' });
      throw error;
    }
  }
}

evidence.preflight = await snapshot();
const before14b = identity(evidence.preflight, RUNTIME_ID);
const before4b = identity(evidence.preflight, 'llama-cpp-vulkan-b12144-qwen3-4b');
if (evidence.preflight.admission.maxActiveRequests !== 1) stop('POLICY_NOT_SERIAL');
if (evidence.preflight.admission.activeRequestCount !== 0) stop('ACTIVE_INFERENCE_PRESENT');
if (!before14b || before14b.phase !== 'model_ready' || before14b.owned !== true) stop('RUNTIME_NOT_RESIDENT_READY', { phase: before14b?.phase ?? null });
if (evidence.preflight.runtimes.some((item) => item.automaticEviction === true)) stop('EVICTION_ENABLED');
if (evidence.stops.length > 0) finish('STOP_PREFLIGHT', 3);

// Disposable workspace: a private temp copy of the fixture under git so the diff is independently inspectable.
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'halo-vc07bq-d2-')));
chmodSync(workspace, 0o700);
cpSync(fixture, workspace, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
git('init', '-q');
git('-c', 'user.email=qa@halo.invalid', '-c', 'user.name=halo-qa', 'add', '-A');
git('-c', 'user.email=qa@halo.invalid', '-c', 'user.name=halo-qa', 'commit', '-q', '-m', 'fixture');
evidence.workspace = { path: workspace, baseline: git('rev-parse', 'HEAD').trim() };
evidence.baselineTest = independentTest();

const engine = new MutationEngine(workspace);
let registry = createReadOnlyToolRegistry();
for (const registration of createMutationToolRegistrations({ engine })) registry.register(registration);
for (const registration of createVerificationToolRegistrations(workspace, { sandbox: 'required' })) registry.register(registration);
registry = registry.filterByName(ALLOWED_TOOLS);
evidence.toolsOffered = registry.listDefinitions().map((tool) => tool.name);

const deadline = AbortSignal.timeout(LIMITS.wallClockMs);
const provider = new BudgetedProvider(new HaloProvider({ coreUrl: CORE, capability: 'coding', token, modelId: MODEL_ID, timeoutMs: LIMITS.perRequestTimeoutMs }), deadline);
const runner = new AgentRunner({ provider, registry, evidenceGate: false, mutationStep: engine, conversationEncoding: 'native-tool-messages' });
const started = Date.now();
let testRuns = 0;
let result;
try {
  result = await runner.run({
    task: { id: 'vc07bq-d2-sum', mode: 'BUILD', instruction: 'sum() in src/sum.ts returns the wrong total. Read src/sum.ts, fix the defect with a minimal apply_patch, then run the TEST verification once and report the result.' },
    workspaceRoot: workspace,
    maxTurns: LIMITS.turns,
    contextBudget: calculateBudget({ contextWindow: 8192, reservedOutput: LIMITS.outputTokensPerTurn, reservedToolHistory: 1000 }),
    projectInstructions: [],
    signal: deadline,
  });
  while (result.status === 'PAUSED' && evidence.stops.length === 0) {
    const request = result.confirmation;
    const decision = authorize(request);
    evidence.approvals.push({ callId: request?.callId ?? null, toolName: request?.toolName ?? null, action: request?.action ?? null, decision });
    if (decision !== 'APPROVE') { stop('TOOL_NOT_AUTHORIZED', { toolName: request?.toolName ?? null }); await runner.resume('REJECT'); break; }
    result = await runner.resume('APPROVE');
  }
} catch (error) {
  if (evidence.stops.length === 0) stop('RUNNER_ERROR', { code: error?.code ?? 'ERROR' });
}
evidence.durationMs = Date.now() - started;
if (evidence.durationMs > LIMITS.wallClockMs) stop('BUDGET_WALL_CLOCK');
evidence.result = result ? {
  status: result.status, failureReason: result.failureReason ?? null, finalAnswerChars: result.finalAnswer?.length ?? 0,
  toolCalls: (result.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name, outcome: call.outcome })),
  appliedMutations: result.appliedMutations ?? [],
} : null;

const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map((line) => line.slice(3));
evidence.changedPaths = changed;
if (changed.some((file) => !ALLOWED_CHANGES.includes(file))) stop('UNEXPECTED_WRITE', { changed });
evidence.diff = git('diff', '--', ...ALLOWED_CHANGES);
evidence.independentTest = independentTest();
evidence.testRunsApproved = testRuns;
evidence.toolCallIds = evidence.turns.flatMap((turn) => (turn.toolCalls ?? []).map((call) => call.id));
// A tool result reached HALO when a successful turn followed the first model tool call. Runner-issued calls
// (e.g. auto-verify-*) are recorded separately: they were authorized here, not requested by the model.
const firstCallTurn = evidence.turns.findIndex((turn) => (turn.toolCalls ?? []).length > 0);
evidence.toolResultContinuations = firstCallTurn < 0 ? 0 : evidence.turns.slice(firstCallTurn + 1).filter((turn) => turn.ok).length;
evidence.runnerIssuedCalls = (result?.toolCalls ?? []).map((call) => call.id).filter((id) => !evidence.toolCallIds.includes(id));
evidence.finalAnswerFromModel = (evidence.turns.at(-1)?.toolCalls ?? []).length === 0 && evidence.turns.at(-1)?.ok === true;
if (new Set(evidence.toolCallIds).size !== evidence.toolCallIds.length) stop('DUPLICATE_TOOL_CALL_ID');

evidence.postflight = await snapshot();
const after14b = identity(evidence.postflight, RUNTIME_ID);
const after4b = identity(evidence.postflight, 'llama-cpp-vulkan-b12144-qwen3-4b');
if (!sameGeneration(before14b, after14b)) stop('RUNTIME_GENERATION_CHANGED', { runtimeId: RUNTIME_ID });
if (before4b && !sameGeneration(before4b, after4b)) stop('RUNTIME_GENERATION_CHANGED', { runtimeId: 'llama-cpp-vulkan-b12144-qwen3-4b' });
if (JSON.stringify(evidence.preflight.llamaServerPids) !== JSON.stringify(evidence.postflight.llamaServerPids)) stop('UNEXPECTED_PROCESS');
if (JSON.stringify(evidence.preflight.ollamaModels) !== JSON.stringify(evidence.postflight.ollamaModels)) stop('OLLAMA_CHANGED');

const pass = evidence.stops.length === 0 && result?.status === 'COMPLETED' && evidence.independentTest.exitCode === 0
  && evidence.baselineTest.exitCode !== 0 && changed.length === 1 && testRuns === 1
  && evidence.turns.some((turn) => (turn.toolCalls ?? []).length > 0) && evidence.toolResultContinuations >= 1;
finish(pass ? 'PASS' : (evidence.stops.length > 0 ? 'STOP' : 'FAIL'), pass ? 0 : 5);

function authorize(request) {
  if (!request || !ALLOWED_TOOLS.has(request.toolName)) return 'REJECT';
  if (request.toolName === 'run_verification') {
    if (request.arguments?.action !== 'TEST' || testRuns >= LIMITS.testRuns) return 'REJECT';
    testRuns += 1;
  }
  if (request.toolName === 'apply_patch' && request.preparedMutation && !ALLOWED_CHANGES.includes(String(request.preparedMutation.path ?? ''))) return 'REJECT';
  return 'APPROVE';
}
function independentTest() {
  try {
    execFileSync(process.execPath, ['--test', 'test/sum.test.ts'], { cwd: workspace, stdio: 'ignore', timeout: 30_000 });
    return { exitCode: 0 };
  } catch (error) { return { exitCode: typeof error?.status === 'number' ? error.status : -1 }; }
}
function finish(decision, exitCode) {
  evidence.decision = decision;
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`decision=${decision} turns=${evidence.turns.length} stops=${evidence.stops.map((item) => item.code).join(',') || 'none'} out=${outPath}`);
  process.exit(exitCode);
}
