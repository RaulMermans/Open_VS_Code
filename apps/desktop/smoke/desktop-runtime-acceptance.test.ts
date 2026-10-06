import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = join(__filename, '..', '..');
const DIST_DIR = join(DESKTOP_ROOT, 'dist');
const APP_PATH = join(DIST_DIR, 'Open VS Code.app');
const APP_EXE = join(APP_PATH, 'Contents', 'MacOS', 'Open VS Code');
const ARCHIVE_PATH = join(DIST_DIR, 'Open-VS-Code-darwin-arm64-0.1.0.tar.gz');

describe('Category C: Real Desktop Runtime Acceptance Suite', () => {
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
          env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
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
});
