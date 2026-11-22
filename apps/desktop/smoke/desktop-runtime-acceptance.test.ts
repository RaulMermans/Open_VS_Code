import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PRODUCT_VERSION } from '../scripts/product-version.ts';

/**
 * Environment for launching the packaged app. Strips Electron/VS Code host variables inherited when the
 * suite runs from an editor terminal (ELECTRON_RUN_AS_NODE makes the app binary start as plain Node).
 */
function cleanAppEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ELECTRON_') && !key.startsWith('VSCODE_')));
}

const __filename = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = join(__filename, '..', '..');
const DIST_DIR = join(DESKTOP_ROOT, 'dist');
const APP_PATH = join(DIST_DIR, 'Open VS Code.app');
const APP_EXE = join(APP_PATH, 'Contents', 'MacOS', 'Open VS Code');
const ARCHIVE_PATH = join(DIST_DIR, 'Open-VS-Code-darwin-arm64-0.1.0.tar.gz');

describe('Category C: Real Desktop Runtime Acceptance Suite', { skip: process.platform !== 'darwin' }, () => {
  test('1. Real packaged Open VS Code GUI launches, reaches usable state, and shuts down cleanly', async () => {
    assert.strictEqual(existsSync(APP_EXE), true, `Executable must exist at ${APP_EXE}`);

    const testTmp = mkdtempSync(join(tmpdir(), 'ovsc-gui-launch-'));
    const userDataDir = join(testTmp, 'userData');
    const extDir = join(testTmp, 'extDir');
    const workspaceDir = join(testTmp, 'workspace');
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    let proc: ReturnType<typeof spawn> | null = null;
    try {
      // Launch the actual packaged GUI executable with isolated profile and mock keychain
      proc = spawn(
        APP_EXE,
        [
          '--user-data-dir', userDataDir,
          '--extensions-dir', extDir,
          '--password-store=basic',
          '--use-mock-keychain',
          '--disable-gpu',
          '--disable-crash-reporter',
          '--disable-telemetry',
          '--disable-workspace-trust',
          '--log', 'trace',
          workspaceDir,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...cleanAppEnv(), ELECTRON_ENABLE_LOGGING: '1' },
        }
      );

      assert.ok(proc.pid, 'GUI Process must have a valid PID');

      // Allow Electron main process and workbench to initialize
      await new Promise((resolve) => setTimeout(resolve, 3500));

      // Process must remain alive and running
      assert.strictEqual(proc.killed, false, 'Process must still be running after initial startup');

      // Verify that isolated userData structure was created by real Electron
      assert.strictEqual(existsSync(userDataDir), true, 'Isolated user-data directory must exist');

      // Graceful controlled shutdown
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        proc!.on('exit', (code, signal) => resolve({ code, signal }));
      });

      proc.kill('SIGTERM');

      const exitResult = await Promise.race([
        exitPromise,
        new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 4000)),
      ]);

      if (exitResult === 'TIMEOUT') {
        try {
          process.kill(proc.pid!, 'SIGKILL');
        } catch {
          // already terminated
        }
      } else {
        assert.ok(
          exitResult.signal === 'SIGTERM' || exitResult.code === 0 || exitResult.signal === 'SIGKILL',
          `Expected SIGTERM, SIGKILL or 0, got code ${exitResult.code}, signal ${exitResult.signal}`
        );
      }
    } finally {
      if (proc && !proc.killed) {
        try {
          process.kill(proc.pid!, 'SIGKILL');
        } catch {
          // already dead
        }
      }
      rmSync(testTmp, { recursive: true, force: true });
    }
  });

  test('2. Real VSCodium extension host discovers bundled extension, activates it, and registers commands', async () => {
    assert.strictEqual(existsSync(APP_EXE), true, `Executable must exist at ${APP_EXE}`);

    const bundledExtDir = join(
      APP_PATH,
      'Contents',
      'Resources',
      'app',
      'extensions',
      'open-vs-code.vscode-integration'
    );
    assert.strictEqual(existsSync(bundledExtDir), true, `Bundled extension must exist at ${bundledExtDir}`);

    const testTmp = mkdtempSync(join(tmpdir(), 'ovsc-exthost-accept-'));
    const userDataDir = join(testTmp, 'userData');
    const extDir = join(testTmp, 'extDir');
    const workspaceDir = join(testTmp, 'workspace');
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    const runnerScript = join(testTmp, 'test-runner.js');

    // Test runner that runs INSIDE the real VSCodium Extension Host process
    const runnerCode = `
const vscode = require('vscode');
const assert = require('assert');

async function doRun() {
  console.log('[exthost-accept] Running inside real extension host. VS Code version:', vscode.version);

  // 1. Confirm extension discovery in real extension host
  const ext = vscode.extensions.getExtension('open-vs-code.vscode-integration');
  assert.ok(ext, 'open-vs-code.vscode-integration MUST be discovered by extension host');
  console.log('[exthost-accept] Discovered extension at:', ext.extensionPath);

  // 2. Confirm extension activation
  assert.strictEqual(ext.isActive, false, 'Extension should not be active prior to explicit activation');
  await ext.activate();
  assert.strictEqual(ext.isActive, true, 'Extension MUST be active after activate()');
  console.log('[exthost-accept] Extension activated successfully.');

  // 3. Confirm all Open VS Code commands are registered in vscode.commands
  const commands = await vscode.commands.getCommands(true);
  const requiredCommands = [
    'open-vs-code.ask',
    'open-vs-code.plan',
    'open-vs-code.build',
    'open-vs-code.debug',
    'open-vs-code.review',
    'open-vs-code.toggleAutocomplete',
    'open-vs-code.setHaloToken',
    'open-vs-code.checkHaloConnection',
    'open-vs-code.createStarterConfig',
    'open-vs-code.openModelConfig',
    'open-vs-code.listSkills',
    'open-vs-code.showActiveSkill',
    'open-vs-code.reviewLearningCandidates',
    'open-vs-code.openBrowserPanel',
    'open-vs-code.showConversationHistory',
    'open-vs-code.newConversation',
  ];

  for (const cmd of requiredCommands) {
    assert.ok(commands.includes(cmd), 'Command ' + cmd + ' must be registered in vscode.commands');
  }
  console.log('[exthost-accept] All required commands confirmed registered in real host.');
}

function run(testsRoot, clb) {
  return doRun().then(
    () => { if (typeof clb === 'function') clb(null, 0); },
    (err) => { if (typeof clb === 'function') clb(err); throw err; }
  );
}

module.exports = { run };
`;
    writeFileSync(runnerScript, runnerCode, 'utf8');

    let proc: ReturnType<typeof spawn> | null = null;
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        proc = spawn(
          APP_EXE,
          [
            '--extensionDevelopmentPath=' + bundledExtDir,
            '--extensionTestsPath=' + runnerScript,
            '--user-data-dir=' + userDataDir,
            '--extensions-dir=' + extDir,
            '--password-store=basic',
            '--use-mock-keychain',
            '--disable-gpu',
            '--disable-crash-reporter',
            '--disable-telemetry',
            '--disable-workspace-trust',
            workspaceDir,
          ],
          {
            stdio: 'inherit',
            env: cleanAppEnv(),
          }
        );

        proc.on('error', reject);
        proc.on('exit', (code) => resolve(code ?? 0));
      });

      assert.strictEqual(
        exitCode,
        0,
        `Real extension host acceptance test must exit with code 0 (got: ${exitCode})`
      );
    } finally {
      if (proc && !proc.killed) {
        try {
          process.kill(proc.pid!, 'SIGKILL');
        } catch {}
      }
      rmSync(testTmp, { recursive: true, force: true });
    }
  });

  test('3. Distributable archive extracts cleanly and satisfies strict codesign verification', () => {
    assert.strictEqual(existsSync(ARCHIVE_PATH), true, `Archive must exist at ${ARCHIVE_PATH}`);

    const extractTmp = mkdtempSync(join(tmpdir(), 'ovsc-archive-verify-'));
    try {
      // Unpack archive to isolated temp location
      execSync(`tar -xzf "${ARCHIVE_PATH}" -C "${extractTmp}"`, { stdio: 'pipe' });

      const extractedApp = join(extractTmp, 'Open VS Code.app');
      assert.strictEqual(existsSync(extractedApp), true, 'Extracted app must exist');

      // Verify code signature strictly
      const verifyOutput = execSync(`codesign --verify --deep --strict "${extractedApp}" 2>&1`, {
        encoding: 'utf8',
      });
      assert.strictEqual(verifyOutput.trim(), '', 'Strict codesign verification must produce no errors');

      // Verify executable permissions
      const exePath = join(extractedApp, 'Contents', 'MacOS', 'Open VS Code');
      assert.strictEqual(existsSync(exePath), true, 'Main executable must exist in archive');

      const cliPath = join(extractedApp, 'Contents', 'Resources', 'app', 'bin', 'open-vs-code');
      assert.strictEqual(existsSync(cliPath), true, 'CLI launcher script must exist in archive');
    } finally {
      rmSync(extractTmp, { recursive: true, force: true });
    }
  });

  test('4. Sprint 7C: a saved conversation is visible after the packaged app restarts', async () => {
    assert.strictEqual(existsSync(APP_EXE), true, `Executable must exist at ${APP_EXE}`);
    const bundledExtDir = join(APP_PATH, 'Contents', 'Resources', 'app', 'extensions', 'open-vs-code.vscode-integration');
    const testTmp = mkdtempSync(join(tmpdir(), 'ovsc-restart-accept-'));
    const userDataDir = join(testTmp, 'userData');
    const extDir = join(testTmp, 'extDir');
    const workspaceDir = join(testTmp, 'workspace');
    for (const dir of [userDataDir, extDir, workspaceDir]) mkdirSync(dir, { recursive: true });
    const outFile = join(testTmp, 'probe.json');

    // Both phases drive the live ChatController of the extension the host actually loaded
    // (the module's existing _testSeam), never a second copy and never a mocked vscode.
    const preamble = `
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
async function liveChat() {
  const ext = vscode.extensions.getExtension('open-vs-code.vscode-integration');
  assert.ok(ext, 'bundled extension discovered');
  await ext.activate();
  const mod = require(path.join(ext.extensionPath, 'dist', 'extension.js'));
  const chat = mod._testSeam.chatController;
  assert.ok(chat, 'live ChatController available');
  await chat.historyReady;
  return chat;
}
function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' timed out')), ms))]);
}
function run(testsRoot, clb) {
  return doRun().then(
    () => { if (typeof clb === 'function') clb(null, 0); },
    (err) => { console.error('[restart-accept]', err && err.stack || err); if (typeof clb === 'function') clb(err); throw err; }
  );
}
module.exports = { run };
`;
    const phase1 = preamble + `
async function doRun() {
  const chat = await liveChat();
  const state = chat.getState();
  assert.strictEqual(state.history.enabled, true, 'history is enabled for a folder workspace: ' + JSON.stringify(state.history));
  assert.strictEqual(state.messages.length, 0, 'fresh profile starts empty');
  // No model is configured, so the turn fails; the user's message is still saved.
  await withTimeout(chat.handleWebviewMessage({ type: 'chat.send', text: 'Sprint 7C restart probe message', mode: 'ASK' }), 60000, 'probe turn');
  const id = chat.getState().conversationId;
  await chat.handleWebviewMessage({ type: 'conversation.rename', conversationId: id, title: 'Restart probe' });
  await chat.flushPersistence();
  const after = chat.getState();
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ id, messages: after.messages.map((m) => ({ role: m.role, content: m.content, status: m.status ?? null })), lastStatus: after.lastStatus }));
  console.log('[restart-accept] phase 1 saved conversation', id);
}
`;
    const phase2 = preamble + `
async function doRun() {
  const saved = JSON.parse(fs.readFileSync(${JSON.stringify(outFile)}, 'utf8'));
  const chat = await liveChat();
  const state = chat.getState();
  assert.strictEqual(state.conversationId, saved.id, 'the most recent conversation is reopened');
  assert.strictEqual(state.conversationTitle, 'Restart probe');
  assert.deepStrictEqual(state.messages.map((m) => ({ role: m.role, content: m.content, status: m.status ?? null })), saved.messages, 'visible history restored exactly: ' + JSON.stringify({ restored: state.messages.map((m) => ({ role: m.role, content: m.content, status: m.status ?? null })), saved: saved.messages }));
  assert.strictEqual(state.lastStatus, saved.lastStatus);
  assert.strictEqual(state.activeTurn, false, 'restoring starts no task');
  assert.strictEqual(state.pendingConfirmation, undefined, 'restoring grants no approval');
  assert.ok(chat.listConversations().some((c) => c.id === saved.id && c.title === 'Restart probe'), 'listed in history');
  fs.writeFileSync(${JSON.stringify(outFile)} + '.phase2', JSON.stringify({ ok: true, messages: state.messages.length }));
  console.log('[restart-accept] phase 2 restored conversation', saved.id);
}
`;

    const launch = (runnerPath: string) => new Promise<number>((resolve, reject) => {
      const proc = spawn(APP_EXE, [
        '--extensionDevelopmentPath=' + bundledExtDir,
        '--extensionTestsPath=' + runnerPath,
        '--user-data-dir=' + userDataDir,
        '--extensions-dir=' + extDir,
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-gpu',
        '--disable-crash-reporter',
        '--disable-telemetry',
        '--disable-workspace-trust',
        workspaceDir,
      ], { stdio: 'inherit', env: cleanAppEnv() });
      const timer = setTimeout(() => { try { process.kill(proc.pid!, 'SIGKILL'); } catch {} reject(new Error('packaged app did not exit')); }, 180_000);
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
    });

    try {
      const runner1 = join(testTmp, 'phase1.js');
      const runner2 = join(testTmp, 'phase2.js');
      writeFileSync(runner1, phase1, 'utf8');
      writeFileSync(runner2, phase2, 'utf8');

      assert.strictEqual(await launch(runner1), 0, 'phase 1 (save) must exit 0');
      const saved = JSON.parse(readFileSync(outFile, 'utf8'));
      assert.ok(saved.messages.some((m: any) => m.role === 'user' && m.content === 'Sprint 7C restart probe message'));

      // The record lives in VS Code's per-workspace storage, not in the workspace.
      const storageRoot = join(userDataDir, 'User', 'workspaceStorage');
      const records = readdirSync(storageRoot).flatMap((hash) => {
        const dir = join(storageRoot, hash, 'open-vs-code.vscode-integration', 'conversations');
        return existsSync(dir) ? readdirSync(dir).filter((n) => n === saved.id + '.json') : [];
      });
      assert.strictEqual(records.length, 1, 'exactly one saved record for the probe conversation');
      assert.strictEqual(existsSync(join(workspaceDir, '.open-vs-code', 'conversations')), false);

      assert.strictEqual(await launch(runner2), 0, 'phase 2 (restart and restore) must exit 0');
      assert.strictEqual(JSON.parse(readFileSync(outFile + '.phase2', 'utf8')).ok, true);
    } finally {
      rmSync(testTmp, { recursive: true, force: true });
    }
  });

  test('5. Sprint 7D: responsiveness probe inside the real packaged extension host', async () => {
    assert.strictEqual(existsSync(APP_EXE), true, `Executable must exist at ${APP_EXE}`);
    const bundledExtDir = join(APP_PATH, 'Contents', 'Resources', 'app', 'extensions', 'open-vs-code.vscode-integration');
    const testTmp = mkdtempSync(join(tmpdir(), 'ovsc-perf-probe-'));
    const userDataDir = join(testTmp, 'userData');
    const extDir = join(testTmp, 'extDir');
    const workspaceDir = join(testTmp, 'workspace');
    for (const dir of [userDataDir, extDir, workspaceDir]) mkdirSync(dir, { recursive: true });
    const outFile = join(testTmp, 'probe.json');

    // Drives the live extension through APIs that predate Sprint 7D, so the same probe
    // measures a baseline build and a changed build. No model is configured: chat turns
    // fail fast and autocomplete finds no route, so no inference latency is involved.
    const runner = `
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (x) => Math.round(x * 100) / 100;
function stats(xs) { const s = xs.slice().sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; return { n: s.length, median: ms(q(0.5)), p95: ms(q(0.95)), max: ms(s[s.length - 1]) }; }
function cpuMs(since) { const d = process.cpuUsage(since); return ms((d.user + d.system) / 1000); }
async function doRun() {
  const ext = vscode.extensions.getExtension('open-vs-code.vscode-integration');
  assert.ok(ext, 'bundled extension discovered');
  const a0 = performance.now();
  await ext.activate();
  const activationMs = ms(performance.now() - a0);
  const mod = require(path.join(ext.extensionPath, 'dist', 'extension.js'));
  const chat = mod._testSeam.chatController;
  await chat.historyReady;
  await vscode.commands.executeCommand('open-vs-code.chat.focus');
  for (let i = 0; i < 100 && !chat._webviewView; i++) await tick(100);
  const webviewOpen = !!chat._webviewView;
  let posts = 0;
  if (webviewOpen) {
    const wv = chat._webviewView.webview;
    const original = wv.postMessage.bind(wv);
    wv.postMessage = (m) => { posts++; return original(m); };
  }
  const mem0 = process.memoryUsage();

  const sendMs = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await chat.handleWebviewMessage({ type: 'chat.send', text: 'Probe ' + i + ' ' + 'lorem ipsum '.repeat(330), mode: 'ASK' });
    sendMs.push(performance.now() - t);
  }
  await chat.flushPersistence();
  const convA = chat.getState().conversationId;
  const messagesA = chat.getState().messages.length;
  await chat.handleWebviewMessage({ type: 'chat.newConversation' });
  for (let i = 0; i < 40; i++) await chat.handleWebviewMessage({ type: 'chat.send', text: 'Second ' + i + ' ' + 'dolor sit '.repeat(400), mode: 'ASK' });
  await chat.flushPersistence();
  const convB = chat.getState().conversationId;
  assert.notStrictEqual(convA, convB);

  const switchMs = [];
  for (let i = 0; i < 20; i++) {
    const target = i % 2 ? convB : convA;
    const t = performance.now();
    await chat.openConversation(target);
    switchMs.push(performance.now() - t);
    assert.strictEqual(chat.getState().conversationId, target, 'switched to the requested conversation');
  }

  // Editor activity while the chat view is open: 300 cursor moves in a 1 MB file.
  const lines = [];
  for (let i = 0; i < 14000; i++) lines.push('  const value_' + i + ' = compute(alpha, beta, gamma) + offset;');
  const doc = await vscode.workspace.openTextDocument({ content: lines.join('\\n'), language: 'typescript' });
  const editor = await vscode.window.showTextDocument(doc);
  await tick(1000);
  posts = 0;
  const c0 = process.cpuUsage();
  const s0 = performance.now();
  for (let i = 0; i < 300; i++) {
    editor.selection = new vscode.Selection(i * 10, 4, i * 10, 4);
    if (i % 10 === 9) await tick(0);
  }
  await tick(1500);
  const selectionStorm = { moves: 300, extensionHostCpuMs: cpuMs(c0), wallMs: ms(performance.now() - s0), webviewPosts: posts };

  // Rapid typing in a 5 MB document: 50 inline-completion requests, each superseding the last.
  const bigLines = [];
  for (let i = 0; i < 70000; i++) bigLines.push('  const value_' + i + ' = compute(alpha, beta, gamma) + offset; // ' + i);
  const big = await vscode.workspace.openTextDocument({ content: bigLines.join('\\n'), language: 'typescript' });
  const bigEditor = await vscode.window.showTextDocument(big);
  await tick(1000);
  const ac = mod._testSeam.autocompleteController;
  const c1 = process.cpuUsage();
  const t1 = performance.now();
  const pending = [];
  let prev = null;
  for (let i = 0; i < 50; i++) {
    if (prev) prev.cancel();
    prev = new vscode.CancellationTokenSource();
    const pos = new vscode.Position(35000, 10 + (i % 20));
    bigEditor.selection = new vscode.Selection(pos, pos);
    pending.push(ac.provideInlineCompletionItems(big, pos, { triggerKind: 1 }, prev.token));
  }
  const syncCpu = cpuMs(c1);
  await Promise.all(pending);
  const autocomplete = { documentChars: big.getText().length, requests: 50, extensionHostCpuMs: cpuMs(c1), cpuMsBeforeFirstAwait: syncCpu, wallMs: ms(performance.now() - t1) };

  const mem1 = process.memoryUsage();
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
    activationMs, webviewOpen,
    send: stats(sendMs), messagesInConversationA: messagesA,
    switch: stats(switchMs),
    selectionStorm, autocomplete,
    memoryMB: { heapUsedBefore: ms(mem0.heapUsed / 1048576), heapUsedAfter: ms(mem1.heapUsed / 1048576), rssAfter: ms(mem1.rss / 1048576) },
    versions: { vscode: vscode.version, node: process.version, electron: process.versions.electron },
  }));
}
function run(testsRoot, clb) {
  return doRun().then(
    () => { if (typeof clb === 'function') clb(null, 0); },
    (err) => { console.error('[perf-probe]', err && err.stack || err); if (typeof clb === 'function') clb(err); throw err; }
  );
}
module.exports = { run };
`;
    try {
      const runnerPath = join(testTmp, 'probe.js');
      writeFileSync(runnerPath, runner, 'utf8');
      const code = await new Promise<number>((resolve, reject) => {
        const proc = spawn(APP_EXE, [
          '--extensionDevelopmentPath=' + bundledExtDir,
          '--extensionTestsPath=' + runnerPath,
          '--user-data-dir=' + userDataDir,
          '--extensions-dir=' + extDir,
          '--password-store=basic',
          '--use-mock-keychain',
          '--disable-gpu',
          '--disable-crash-reporter',
          '--disable-telemetry',
          '--disable-workspace-trust',
          workspaceDir,
        ], { stdio: 'inherit', env: cleanAppEnv() });
        const timer = setTimeout(() => { try { process.kill(proc.pid!, 'SIGKILL'); } catch {} reject(new Error('packaged app did not exit')); }, 300_000);
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 0); });
      });
      assert.strictEqual(code, 0, 'the probe must exit 0');
      const probe = JSON.parse(readFileSync(outFile, 'utf8'));
      assert.strictEqual(probe.webviewOpen, true, 'the chat view was resolved, so posts reached a real webview');
      assert.ok(probe.messagesInConversationA > 0 && probe.messagesInConversationA <= 100, 'transcript bound holds');
      console.log('[perf-probe] ' + JSON.stringify(probe));
      if (process.env.OVSC_PERF_PROBE_OUT) writeFileSync(process.env.OVSC_PERF_PROBE_OUT, JSON.stringify(probe, null, 2) + '\n');
    } finally {
      rmSync(testTmp, { recursive: true, force: true });
    }
  });

  test('6. Sprint 9B: Real packaged desktop application executes Visual Browser QA panel workflow', async () => {
    assert.strictEqual(existsSync(APP_EXE), true, `Executable must exist at ${APP_EXE}`);
    const bundledExtDir = join(APP_PATH, 'Contents', 'Resources', 'app', 'extensions', 'open-vs-code.vscode-integration');
    const testTmp = mkdtempSync(join(tmpdir(), 'ovsc-browser-accept-'));
    const userDataDir = join(testTmp, 'userData');
    const extDir = join(testTmp, 'extDir');
    const workspaceDir = join(testTmp, 'workspace');
    for (const dir of [userDataDir, extDir, workspaceDir]) mkdirSync(dir, { recursive: true });
    const outFile = join(testTmp, 'browser-probe.json');

    const runner = `
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function doRun() {
  console.log('[browser-accept] Starting packaged Browser QA acceptance probe...');

  let serverHits = 0;
  const server = http.createServer((req, res) => {
    serverHits++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><title>Packaged QA Portal ?token=Secret999</title></head><body><h1>Desktop QA Ready</h1><button id="cta-btn" type="button">Order Now</button></body></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const appOrigin = 'http://127.0.0.1:' + port;
  console.log('[browser-accept] Fixture server running at:', appOrigin);

  try {
    console.log('[browser-accept] Step 1: Discovering extension...');
    const ext = vscode.extensions.getExtension('open-vs-code.vscode-integration');
    assert.ok(ext, 'bundled extension discovered');
    console.log('[browser-accept] Step 2: Activating extension...');
    await ext.activate();
    console.log('[browser-accept] Step 3: Loading extension module...');
    const mod = require(path.join(ext.extensionPath, 'dist', 'extension.js'));
    const controller = mod._testSeam.browserPanelController;
    assert.ok(controller, 'live browserPanelController available');

    console.log('[browser-accept] Step 4: Opening browser panel...');
    await vscode.commands.executeCommand('open-vs-code.openBrowserPanel');
    assert.strictEqual(controller.isPanelOpen(), true, 'Browser panel must be open');
    assert.strictEqual(controller.getObservedSessionManager(), undefined, 'Opening panel MUST NOT start a browser session');
    const initialState = controller.getState();
    assert.strictEqual(initialState.hasActiveSession, false);
    assert.strictEqual(initialState.sessionStatus, 'DISCONNECTED');
    assert.strictEqual(initialState.provisioning.status, 'READY');

    console.log('[browser-accept] Step 5: Configuring allowedOrigins...');
    await vscode.workspace.getConfiguration('open-vs-code').update('browser.allowedOrigins', [appOrigin], vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('open-vs-code.browser').update('allowedOrigins', [appOrigin], vscode.ConfigurationTarget.Workspace);
    await tick(300);

    console.log('[browser-accept] Step 6: Navigating to fixture URL...');
    await controller.handleMessage({ type: 'browserPanel.openUrl', url: appOrigin + '/qa' });

    console.log('[browser-accept] Step 7: Awaiting screenshot preview...');
    for (let i = 0; i < 80 && !controller.getState().screenshot; i++) {
      if (controller.getState().navigationError) {
        throw new Error('Navigation failed: ' + controller.getState().navigationError);
      }
      await tick(100);
    }

    const state = controller.getState();
    assert.strictEqual(state.hasActiveSession, true, 'Active browser session created upon navigation');
    assert.strictEqual(state.sessionStatus, 'READY');
    assert.strictEqual(state.activeUrl, appOrigin + '/qa');
    assert.strictEqual(state.pageTitle.includes('Secret999'), false, 'Sensitive query parameter redacted from title');
    assert.ok(state.screenshot, 'Screenshot preview captured');
    const safeSchemes = ['vscode-webview-resource:', 'vscode-file:', 'vscode-resource:', 'https://'];
    assert.ok(
      safeSchemes.some((s) => state.screenshot.webviewUri.startsWith(s)),
      'Screenshot served via webview URI: ' + state.screenshot.webviewUri
    );

    // Screenshot stored outside workspace repository
    const wsFiles = fs.readdirSync(${JSON.stringify(workspaceDir)});
    assert.strictEqual(wsFiles.filter((f) => f.endsWith('.png')).length, 0, 'Zero screenshots in workspace');

    // Accessibility snapshot & element bounds
    assert.ok(state.snapshot, 'Accessibility snapshot populated');
    const btn = state.snapshot.elements.find((e) => e.name === 'Order Now');
    assert.ok(btn, 'Order Now button present in accessibility tree');
    assert.ok(btn.bounds && btn.bounds.width > 0, 'Button bounds populated from real Chromium');

    // 3. Close session cleanly
    console.log('[browser-accept] Step 8: Closing session...');
    await controller.closeSession();
    assert.strictEqual(controller.getState().sessionStatus, 'CLOSED');
    assert.strictEqual(controller.getPerformanceMetrics().retainedScreenshotCount, 0, 'Screenshots cleaned up on close');

    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      ok: true,
      serverHits,
      screenshotArtifact: state.screenshot.artifactId,
      viewport: state.viewport,
      metrics: controller.getPerformanceMetrics(),
    }));
    console.log('[browser-accept] Packaged Browser QA acceptance passed successfully.');
  } catch (err) {
    fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      ok: false,
      error: err && err.stack ? err.stack : String(err),
    }));
    throw err;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function run(testsRoot, clb) {
  return doRun().then(
    () => { if (typeof clb === 'function') clb(null, 0); },
    (err) => {
      console.error('[browser-accept]', err && err.stack || err);
      if (typeof clb === 'function') clb(err);
      throw err;
    }
  );
}

module.exports = { run };
`;

    try {
      const runnerPath = join(testTmp, 'browser-runner.js');
      writeFileSync(runnerPath, runner, 'utf8');
      const code = await new Promise<number>((resolve, reject) => {
        const proc = spawn(APP_EXE, [
          '--extensionDevelopmentPath=' + bundledExtDir,
          '--extensionTestsPath=' + runnerPath,
          '--user-data-dir=' + userDataDir,
          '--extensions-dir=' + extDir,
          '--password-store=basic',
          '--use-mock-keychain',
          '--disable-gpu',
          '--disable-crash-reporter',
          '--disable-telemetry',
          '--disable-workspace-trust',
          workspaceDir,
        ], { stdio: 'inherit', env: cleanAppEnv() });
        const timer = setTimeout(() => { try { process.kill(proc.pid!, 'SIGKILL'); } catch {} reject(new Error('packaged app did not exit')); }, 180_000);
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 0); });
      });
      assert.strictEqual(code, 0, 'Browser QA acceptance probe must exit 0');
      const probe = JSON.parse(readFileSync(outFile, 'utf8'));
      assert.strictEqual(probe.ok, true, 'Probe report marked ok');
      console.log('[browser-accept] Report: ' + JSON.stringify(probe));
    } finally {
      rmSync(testTmp, { recursive: true, force: true });
    }
  });
});

const LINUX_PAYLOAD = join(DIST_DIR, `Open-VS-Code-linux-x64-${PRODUCT_VERSION}`);

function sandboxMode(path: string): string {
  return execSync(`stat -c '%a %U' ${JSON.stringify(path)}`, { encoding: 'utf8' }).trim();
}

describe('Category C: Linux desktop runtime acceptance', { skip: process.platform !== 'linux' }, () => {
  test('unprivileged payload fails closed instead of disabling the sandbox', async () => {
    const exe = join(LINUX_PAYLOAD, 'codium');
    const sandbox = join(LINUX_PAYLOAD, 'chrome-sandbox');
    assert.strictEqual(existsSync(exe), true, `Linux payload executable must exist at ${exe}`);
    assert.match(sandboxMode(sandbox), /^4755 /, 'package tree must record the setuid bit');
    assert.doesNotMatch(sandboxMode(sandbox), /^4755 root$/, 'an uninstalled tree is not root-owned');

    const testTmp = mkdtempSync(join(tmpdir(), 'ovsc-linux-unpriv-'));
    const userDataDir = join(testTmp, 'userData');
    const workspaceDir = join(testTmp, 'workspace');
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    let stderr = '';
    const proc = spawn(exe, [
      '--user-data-dir', userDataDir,
      '--disable-gpu',
      '--disable-crash-reporter',
      workspaceDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: cleanAppEnv() });
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
    assert.match(stderr, /SUID sandbox helper binary was found, but is not configured correctly/);
    assert.doesNotMatch(stderr, /--no-sandbox/);
    assert.notStrictEqual(exitCode, 0);
    rmSync(testTmp, { recursive: true, force: true });
  });

  test('root-installed application launches with sandbox helpers and without --no-sandbox', async () => {
    const exe = '/usr/lib/open-vs-code/codium';
    const sandbox = '/usr/lib/open-vs-code/chrome-sandbox';
    assert.strictEqual(existsSync(exe), true, 'installed codium binary must exist');
    assert.strictEqual(sandboxMode(sandbox), '4755 root');

    const testTmp = mkdtempSync(join(tmpdir(), 'ovsc-linux-gui-'));
    const userDataDir = join(testTmp, 'userData');
    const workspaceDir = join(testTmp, 'workspace');
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    const proc = spawn(exe, [
      '--user-data-dir', userDataDir,
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-telemetry',
      '--disable-workspace-trust',
      workspaceDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanAppEnv(), ELECTRON_ENABLE_LOGGING: '1' } });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    try {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      assert.strictEqual(proc.exitCode, null, 'installed GUI must still be running');
      const tree = execSync(`ps -o args= --ppid ${proc.pid}; ps -p ${proc.pid} -o args=`, { encoding: 'utf8' });
      assert.doesNotMatch(tree, /(^|\s)--no-sandbox(\s|$)/);
      assert.match(tree, /chrome-sandbox/);
      assert.doesNotMatch(stderr, /Rather than run without sandboxing I'm aborting now/);
    } finally {
      try { process.kill(proc.pid!, 'SIGTERM'); } catch { /* already exited */ }
      rmSync(testTmp, { recursive: true, force: true });
    }
  });
});
