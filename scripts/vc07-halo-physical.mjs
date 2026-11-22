#!/usr/bin/env node
/**
 * Bounded VC-07 Gate B/C runner. Never prints tokens, prompts, or model output.
 * Requires HALO_APP_TOKEN_OPEN_VSCODE in the environment.
 */
import { writeFileSync } from 'node:fs';
import { HaloProvider, inspectHaloConnection } from '../packages/agent-core/src/model/halo.ts';

const CORE = process.env.HALO_CORE_URL ?? 'http://127.0.0.1:4310';
const token = process.env.HALO_APP_TOKEN_OPEN_VSCODE?.trim();
const outPath = process.env.HALO_VC07_OUT;
if (!token) {
  console.error('missing HALO_APP_TOKEN_OPEN_VSCODE');
  process.exit(2);
}

const json = async (url, init = {}) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { parseError: true, bytes: text.length }; }
  return { status: response.status, body };
};

const snapshot = async () => {
  const [admission, runtimes, ollama, version] = await Promise.all([
    json(`${CORE}/inference/admission`),
    json(`${CORE}/infrastructure/model-runtimes`),
    json('http://127.0.0.1:11434/api/ps').catch(() => ({ status: 0, body: { models: [] } })),
    json(`${CORE}/version`),
  ]);
  const observations = runtimes.body?.observations ?? [];
  return {
    observedAt: new Date().toISOString(),
    releaseId: version.body?.build?.releaseId ?? null,
    admission: {
      status: admission.status,
      maxActiveRequests: admission.body?.maxActiveRequests ?? null,
      activeRequestCount: admission.body?.activeRequestCount ?? null,
      capacityState: admission.body?.capacityState ?? null,
      occupancyQuality: admission.body?.backendOccupancy ?? null,
    },
    runtimes: observations.map((item) => ({
      runtimeId: item.runtimeId,
      haloModelId: item.haloModelId,
      evictionEligibility: item.lifecycle?.evictionEligibility ?? null,
      automaticEviction: item.lifecycle?.automaticEviction ?? null,
      occupancyQuality: item.backendOccupancy?.quality ?? null,
    })),
    llama: {
      p8092: (await json('http://127.0.0.1:8092/health').catch(() => ({ status: 0 }))).status,
      p8093: (await json('http://127.0.0.1:8093/health').catch(() => ({ status: 0 }))).status,
    },
    ollamaModels: (ollama.body?.models ?? []).map((model) => model.name),
  };
};

const evidence = { schema: 'halo.qa/vc07-physical/v1', startedAt: new Date().toISOString(), tasks: [] };
evidence.preflight = await snapshot();
if (evidence.preflight.admission.maxActiveRequests !== 1) {
  evidence.decision = 'STOP_POLICY';
  write(evidence);
  process.exit(3);
}

evidence.inspection = await inspectHaloConnection({
  coreUrl: CORE,
  token,
  capability: 'coding',
  modelId: 'x3-qwen3-14b-vulkan',
});

const capability = new HaloProvider({ coreUrl: CORE, capability: 'coding', token, timeoutMs: 30_000 });
const explicit = new HaloProvider({
  coreUrl: CORE, capability: 'reasoning', token, timeoutMs: 30_000, modelId: 'x3-qwen3-14b-vulkan',
});

async function chat(name, provider, instruction, { allowFail = false } = {}) {
  const started = Date.now();
  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: instruction }],
      maxOutputTokens: 32,
    });
    evidence.tasks.push({
      name,
      ok: true,
      ms: Date.now() - started,
      model: result.model,
      finishReason: result.finishReason ?? null,
      contentChars: result.message.content.length,
      contentPresent: result.message.content.trim().length > 0,
      usage: result.usage ?? null,
      tools: result.toolCalls !== undefined,
      streaming: result.metadata?.streaming ?? null,
    });
  } catch (error) {
    evidence.tasks.push({
      name,
      ok: false,
      ms: Date.now() - started,
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'ERROR',
    });
    if (allowFail) return;
    evidence.decision = 'STOP_INFERENCE';
    evidence.postflight = await snapshot();
    write(evidence);
    process.exit(4);
  }
}

await chat('ask-capability-coding-4b', capability, 'Reply with one word: pong.', { allowFail: true });
if (!evidence.tasks.at(-1)?.ok) {
  evidence.fourBCapability = {
    blocked: true,
    note: 'coding routes to x3-qwen3-4b-vulkan; live phase was model_advertised so demand-start is unauthorized (empty 4B allowlist). Continuing on resident 14B per Gate C.',
  };
  evidence.decision = undefined;
  evidence.tasks[evidence.tasks.length - 1].expectedBlock = true;
}

await chat('ask-ping-14b', explicit, 'Reply with one word: pong.');
await chat('ask-code-14b', explicit, 'Write a one-line Python function named add that returns a+b. Code only.');
await chat('ask-reuse-14b', explicit, 'Reply with one word: ok.');

const unauthorized = new HaloProvider({ coreUrl: CORE, capability: 'coding', token: 'not-a-valid-open-vscode-token', timeoutMs: 10_000 });
try {
  await unauthorized.complete({ messages: [{ role: 'user', content: 'no' }], maxOutputTokens: 8 });
  evidence.unauthorized = { ok: false, note: 'expected auth failure' };
  evidence.decision = 'STOP_AUTH';
} catch (error) {
  evidence.unauthorized = { ok: true, code: error && typeof error === 'object' && 'code' in error ? error.code : 'ERROR' };
}

evidence.postflight = await snapshot();
evidence.finishedAt = new Date().toISOString();
const extraOllama = evidence.postflight.ollamaModels.length > 0;
const evictionOn = evidence.postflight.runtimes.some((runtime) => runtime.automaticEviction === true);
evidence.decision = extraOllama || evictionOn ? 'STOP_SIDE_EFFECT' : 'PASS';
write(evidence);
process.exit(evidence.decision === 'PASS' ? 0 : 5);

function write(payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, text);
  console.log(`decision=${payload.decision} tasks=${(payload.tasks ?? []).length} out=${outPath ?? 'stdout-suppressed'}`);
}
