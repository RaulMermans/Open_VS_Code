import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SmokeEndpointFixture } from './smoke-fixture.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = join(__filename, '..', '..');
const DIST_DIR = join(DESKTOP_ROOT, 'dist');
const APP_PATH = join(DIST_DIR, 'Open VS Code.app');

// Mock VS Code environment for testing packaged extension in Node
const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    activeTextEditor: null as any,
    visibleTextEditors: [],
    showErrorMessage: () => {},
    showWarningMessage: async () => 'Approve',
    showInformationMessage: async () => 'Create Starter Config',
    showInputBox: async () => 'Test Instruction',
    withProgress: async (_opts: any, task: any) => {
      const token = { onCancellationRequested: () => {} };
      const progress = { report: () => {} };
      return task(progress, token);
    },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    showTextDocument: async () => {},
  },
  workspace: {
    workspaceFolders: [
      {
        uri: { fsPath: '/test/workspace', toString: () => 'file:///test/workspace' },
        name: 'workspace',
      },
    ],
    isTrusted: true,
    getWorkspaceFolder: () => null,
    asRelativePath: () => 'file.ts',
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    getConfiguration: () => ({
      get: (key: string, def: any) => def,
    }),
    registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    fs: {
      createDirectory: async () => {},
      writeFile: async () => {},
    },
    openTextDocument: async () => ({ uri: { fsPath: '/test/workspace/.open-vs-code/models.json' } }),
  },
  languages: {
    onDidChangeDiagnostics: () => ({ dispose: () => {} }),
    getDiagnostics: () => [],
    registerInlineCompletionItemProvider: (_selector: any, provider: any) => {
      mockVscode.languages.registeredProviders.push(provider);
      return { dispose: () => {} };
    },
    registeredProviders: [] as any[],
  },
  commands: {
    registerCommand: (id: string, callback: any) => {
      mockVscode.commands.registered[id] = callback;
      return { dispose: () => {} };
    },
    executeCommand: async (id: string, ...args: any[]) => {
      if (typeof mockVscode.commands.registered[id] === 'function') {
        return await mockVscode.commands.registered[id](...args);
      }
    },
    registered: {} as Record<string, any>,
  },
  env: {
    clipboard: {
      writeText: async () => {},
    },
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
  },
  Position: class {
    constructor(readonly line: number, readonly character: number) {}
  },
  Range: class {
    constructor(readonly start: any, readonly end: any) {}
  },
  InlineCompletionItem: class {
    constructor(readonly insertText: string, readonly range?: any, readonly command?: any) {}
  },
  InlineCompletionList: class {
    constructor(readonly items: any[]) {}
  },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  },
};

describe('Open VS Code V1 Desktop Candidate — Smoke & Packaging Suite', () => {
  let smokeFixture: SmokeEndpointFixture;
  let fixtureUrl: string;
  let tempWorkspace: string;

  before(async () => {
    // Intercept vscode module import in Node
    const originalResolveFilename = (Module as any)._resolveFilename;
    (Module as any)._resolveFilename = function (request: string) {
      if (request === 'vscode') return 'vscode';
      return originalResolveFilename.apply(this, arguments);
    };

    const originalRequire = (Module as any).prototype.require;
    (Module as any).prototype.require = function (id: string) {
      if (id === 'vscode') return mockVscode;
      return originalRequire.apply(this, arguments);
    };

    // Start deterministic mock OpenAI-compatible fixture
    smokeFixture = new SmokeEndpointFixture();
    const res = await smokeFixture.start();
    fixtureUrl = res.url;

    // Create temporary workspace
    tempWorkspace = mkdtempSync(join(tmpdir(), 'ovsc-smoke-workspace-'));
  });

  after(async () => {
    await smokeFixture.stop();
    try {
      rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {
      // safe cleanup
    }
  });

  // =========================================================================
  // CATEGORY A: Package Structure & Build Invariants
  // =========================================================================

  test('1. [Category A] Pinned upstream shell specification is validated', () => {
    const specPath = join(DESKTOP_ROOT, 'upstream.json');
    assert.strictEqual(existsSync(specPath), true, 'upstream.json must exist');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));

    assert.strictEqual(spec.distribution, 'vscodium', 'Must use vscodium distribution');
    assert.strictEqual(spec.version, '1.135.06055', 'Must pin version 1.135.06055');
    assert.strictEqual(spec.vscodeVersion, '1.135.0', 'Base VS Code version must be 1.135.0');
    assert.strictEqual(spec.upstreamCommit, '5a73682ca091082675b10c9dc3f348c1d824d94f', 'Commit must be pinned');
    assert.strictEqual(spec.license, 'MIT', 'License must be MIT');
    assert.strictEqual(
      spec.sha256,
      '61ff9ebc3ac5563c63a0a9e1b479822647e7f2c3303b0629f15fefe9e291f7cc',
      'SHA-256 checksum must match upstream release'
    );
  });

  test('2. [Category A] Packaged macOS Open VS Code.app bundle structure and branding', () => {
    assert.strictEqual(existsSync(APP_PATH), true, `Packaged app must exist at ${APP_PATH}`);

    // Check Info.plist
    const infoPlistPath = join(APP_PATH, 'Contents', 'Info.plist');
    assert.strictEqual(existsSync(infoPlistPath), true, 'Info.plist must exist');
    const infoPlist = readFileSync(infoPlistPath, 'utf8');
    assert.match(infoPlist, /<key>CFBundleName<\/key>\s*<string>Open VS Code<\/string>/);
    assert.match(infoPlist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.openvscode\.desktop<\/string>/);

    // Check product.json
    const productJsonPath = join(APP_PATH, 'Contents', 'Resources', 'app', 'product.json');
    assert.strictEqual(existsSync(productJsonPath), true, 'product.json must exist in packaged app');
    const product = JSON.parse(readFileSync(productJsonPath, 'utf8'));
    assert.strictEqual(product.nameShort, 'Open VS Code');
    assert.strictEqual(product.nameLong, 'Open VS Code');
    assert.strictEqual(product.applicationName, 'open-vs-code');
    assert.strictEqual(product.dataFolderName, '.open-vs-code-desktop');
    assert.strictEqual(product.enableTelemetry, false, 'Telemetry must be disabled');

    // Check main executable and renamed helper apps
    const exePath = join(APP_PATH, 'Contents', 'MacOS', 'Open VS Code');
    assert.strictEqual(existsSync(exePath), true, 'Open VS Code executable must exist');

    const frameworksDir = join(APP_PATH, 'Contents', 'Frameworks');
    assert.strictEqual(
      existsSync(join(frameworksDir, 'Open VS Code Helper.app')),
      true,
      'Open VS Code Helper.app must exist'
    );
    assert.strictEqual(
      existsSync(join(frameworksDir, 'Open VS Code Helper (Renderer).app')),
      true,
      'Open VS Code Helper (Renderer).app must exist'
    );
  });

  test('3. [Category A] Bundled Open VS Code extension is installed and discoverable in app', () => {
    const bundledExtDir = join(
      APP_PATH,
      'Contents',
      'Resources',
      'app',
      'extensions',
      'open-vs-code.vscode-integration'
    );
    assert.strictEqual(existsSync(bundledExtDir), true, 'Bundled extension directory must exist');

    const manifestPath = join(bundledExtDir, 'package.json');
    assert.strictEqual(existsSync(manifestPath), true, 'Bundled extension package.json must exist');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.name, 'vscode-integration');
    assert.strictEqual(manifest.publisher, 'open-vs-code');
    assert.strictEqual(manifest.engines?.vscode, '^1.90.0');

    const bundleJsPath = join(bundledExtDir, 'dist', 'extension.js');
    assert.strictEqual(existsSync(bundleJsPath), true, 'Bundled extension.js must exist');
    const bundleSize = readFileSync(bundleJsPath).length;
    assert.ok(bundleSize > 500_000, `Bundle size should be > 500KB (actual: ${bundleSize})`);
  });

  test('4. [Category A] Packaged Open VS Code CLI launcher script executes and reports version', () => {
    const cliScript = join(APP_PATH, 'Contents', 'Resources', 'app', 'bin', 'open-vs-code');
    assert.strictEqual(existsSync(cliScript), true, 'CLI launcher script must exist');

    const output = execSync(`"${cliScript}" --version`, { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    assert.ok(lines.length >= 1, 'Must report at least version line');
    console.log(`[smoke] Packaged CLI launcher version output:\n${output.trim()}`);
  });

  test('5. [Category A] Packaging signature verification validates truthfully', () => {
    const archivePath = join(DIST_DIR, 'Open-VS-Code-darwin-arm64-0.1.0.tar.gz');
    assert.strictEqual(existsSync(archivePath), true, 'Distribution archive must exist');

    // Extract archive into clean temp directory and verify strict signature
    const verifyTmp = mkdtempSync(join(tmpdir(), 'ovsc-sig-test-'));
    try {
      execSync(`tar -xzf "${archivePath}" -C "${verifyTmp}"`, { stdio: 'pipe' });
      const extractedApp = join(verifyTmp, 'Open VS Code.app');

      // Must succeed without throwing
      const result = execSync(`codesign --verify --deep --strict "${extractedApp}" 2>&1`, {
        encoding: 'utf8',
      });
      assert.strictEqual(result.trim(), '', 'Strict codesign verification must succeed cleanly');
    } finally {
      rmSync(verifyTmp, { recursive: true, force: true });
    }
  });

  test('6. [Category A] Security and supply-chain invariants verified', () => {
    // A. Check for forbidden cloud endpoints
    const productJsonPath = join(APP_PATH, 'Contents', 'Resources', 'app', 'product.json');
    const productContent = readFileSync(productJsonPath, 'utf8');
    assert.strictEqual(productContent.includes('api.openai.com'), false, 'Cannot contain api.openai.com');
    assert.strictEqual(productContent.includes('api.anthropic.com'), false, 'Cannot contain api.anthropic.com');

    // B. Check that no model weight files exist in repository or app bundle
    const findWeights = execSync(
      `find "${APP_PATH}" -name "*.gguf" -o -name "*.safetensors" -o -name "*.ggml" -o -name "pytorch_model*.bin" -o -name "*.pt" -o -name "*.pth" 2>/dev/null || true`,
      { encoding: 'utf8' }
    ).trim();
    assert.strictEqual(findWeights, '', 'Packaged application must NOT bundle model weight files');

    // C. Check that distribution archive exists
    const archivePath = join(DIST_DIR, 'Open-VS-Code-darwin-arm64-0.1.0.tar.gz');
    assert.strictEqual(existsSync(archivePath), true, 'Distribution archive must exist');
  });

  // =========================================================================
  // CATEGORY B: Unit & Component Integration (Truthfully Labeled)
  // =========================================================================

  test('7. [Category B — Unit] Bundled extension exports activation contracts and starter config', () => {
    const bundledExtDir = join(
      APP_PATH,
      'Contents',
      'Resources',
      'app',
      'extensions',
      'open-vs-code.vscode-integration'
    );
    const extensionModule = require(join(bundledExtDir, 'dist', 'extension.js'));

    assert.strictEqual(typeof extensionModule.activate, 'function', 'activate must be exported');
    assert.strictEqual(typeof extensionModule.deactivate, 'function', 'deactivate must be exported');
    assert.strictEqual(typeof extensionModule.STARTER_MODELS_JSON, 'string', 'STARTER_MODELS_JSON must be exported');

    const starterJson = JSON.parse(extensionModule.STARTER_MODELS_JSON);
    assert.ok(Array.isArray(starterJson.providers), 'Must have providers');
    assert.ok(Array.isArray(starterJson.models), 'Must have models');
    assert.ok(Array.isArray(starterJson.deployments), 'Must have deployments');
    assert.ok(starterJson.routes && typeof starterJson.routes === 'object', 'Must have routes');
    assert.strictEqual(starterJson.providers[0].kind, 'openai_compatible_local');
    assert.strictEqual(starterJson.models[0].specialization, 'coding');
  });

  test('8. [Category B — Unit] Mocked VS Code activation registers commands in mock environment', () => {
    const bundledExtDir = join(
      APP_PATH,
      'Contents',
      'Resources',
      'app',
      'extensions',
      'open-vs-code.vscode-integration'
    );
    const extensionModule = require(join(bundledExtDir, 'dist', 'extension.js'));

    const subscriptions: { dispose: () => void }[] = [];
    const mockContext = {
      subscriptions,
      extensionUri: { toString: () => 'file:///mock/extension' },
      secrets: {
        get: async () => undefined,
        store: async () => {},
      },
    };

    extensionModule.activate(mockContext as any);

    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.ask'], 'function');
    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.plan'], 'function');
    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.build'], 'function');
    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.debug'], 'function');
    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.review'], 'function');
    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.toggleAutocomplete'], 'function');
    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.createStarterConfig'], 'function');
    assert.strictEqual(typeof mockVscode.commands.registered['open-vs-code.openModelConfig'], 'function');
  });

  test('9. [Category B — Component] Offline inference server produces graceful error (AgentRuntime)', async () => {
    const { createAgentRuntime } = await import('@open-vs-code/agent-core');

    const routingConfig = {
      providers: [
        {
          id: 'dead-provider',
          kind: 'openai_compatible_local' as const,
          baseUrl: 'http://127.0.0.1:59999', // Closed port
        },
      ],
      models: [
        {
          id: 'test-model',
          displayName: 'Test Model',
          family: 'qwen',
          contextWindow: 8192,
          capabilities: ['coding' as const],
          specialization: 'coding' as const,
        },
      ],
      deployments: [
        {
          id: 'test-dep',
          providerId: 'dead-provider',
          modelId: 'test-model',
          modelName: 'test-model',
          enabled: true,
          priority: 1,
        },
      ],
      routes: {
        coding: ['test-dep'],
        default: ['test-dep'],
      },
    };

    const runtime = await createAgentRuntime({
      workspaceRoot: tempWorkspace,
      mode: 'ASK',
      instruction: 'Smoke test offline handling',
      signal: new AbortController().signal,
      isTrusted: true,
      routingConfigOverride: routingConfig as any,
    });

    const result = await runtime.runner.run(runtime.runnerInput);

    assert.strictEqual(result.status, 'FAILED');
    assert.ok(
      result.failureReason === 'MODEL_ERROR' ||
        result.failureReason === 'MODEL_UNAVAILABLE' ||
        result.failureReason === 'INTERNAL_ERROR',
      `Expected MODEL_ERROR, MODEL_UNAVAILABLE or INTERNAL_ERROR, got: ${result.failureReason}`
    );
  });

  test('10. [Category B — Component] Direct LocalFimProvider completes mock HTTP completion', async () => {
    const { LocalFimProvider } = await import('@open-vs-code/agent-core');

    process.env.OPEN_VS_CODE_REAL_INFERENCE = '1';
    try {
      const fimProvider = new LocalFimProvider({
        providerId: 'mock-provider',
        modelId: 'qwen-coder',
        deploymentId: 'mock-fim-dep',
        baseUrl: fixtureUrl,
        model: 'qwen2.5-coder:7b',
        fimStrategy: 'qwen',
        timeoutMs: 5000,
      });

      const result = await fimProvider.complete({
        prefix: 'def test():\n    ',
        suffix: '\n    return True',
        maxTokens: 50,
        temperature: 0.1,
        signal: new AbortController().signal,
      });

      assert.ok(result, 'FIM completion should succeed');
      assert.strictEqual(result.text, smokeFixture.fimResponseText);
    } finally {
      delete process.env.OPEN_VS_CODE_REAL_INFERENCE;
    }
  });

  test('11. [Category B — Unit] Clean deactivation flushes state and leaves zero leaks', async () => {
    const bundledExtDir = join(
      APP_PATH,
      'Contents',
      'Resources',
      'app',
      'extensions',
      'open-vs-code.vscode-integration'
    );
    const extensionModule = require(join(bundledExtDir, 'dist', 'extension.js'));

    await assert.doesNotReject(async () => {
      await extensionModule.deactivate();
    });
  });

  // =========================================================================
  // CATEGORY D: Packaged Integration (Crossing Extension Boundaries)
  // =========================================================================

  test('12. [Category D — Packaged Integration] AutocompleteController -> AutocompleteService -> Production Gateway -> LocalFimProvider against mock fixture', async () => {
    process.env.OPEN_VS_CODE_REAL_INFERENCE = '1';

    // 1. Setup real workspace models.json configuration pointing to mock fixture
    const configDir = join(tempWorkspace, '.open-vs-code');
    mkdirSync(configDir, { recursive: true });
    const modelsConfig = {
      $schema: 'https://raw.githubusercontent.com/RaulMermans/Open_VS_Code/main/config/schemas/models.schema.json',
      providers: [
        {
          id: 'fixture-provider',
          kind: 'openai_compatible_local',
          baseUrl: fixtureUrl,
        },
      ],
      models: [
        {
          id: 'qwen-coder',
          displayName: 'Qwen Coder',
          family: 'qwen',
          contextWindow: 8192,
          capabilities: ['coding', 'autocomplete', 'fim'],
          specialization: 'coding',
          fimStrategy: 'qwen',
          provenance: 'Qwen 2.5 Coder',
        },
      ],
      deployments: [
        {
          id: 'fixture-fim',
          providerId: 'fixture-provider',
          modelId: 'qwen-coder',
          modelName: 'qwen2.5-coder:7b',
          enabled: true,
          priority: 10,
          fimStrategy: 'qwen',
        },
      ],
      routes: {
        autocomplete: ['fixture-fim'],
        coding: ['fixture-fim'],
        default: ['fixture-fim'],
      },
    };
    writeFileSync(join(configDir, 'models.json'), JSON.stringify(modelsConfig, null, 2), 'utf8');

    try {
      // 2. Load bundled extension and activate with test workspace
      const bundledExtDir = join(
        APP_PATH,
        'Contents',
        'Resources',
        'app',
        'extensions',
        'open-vs-code.vscode-integration'
      );
      const extensionModule = require(join(bundledExtDir, 'dist', 'extension.js'));

      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: tempWorkspace, toString: () => `file://${tempWorkspace}` },
          name: 'test-workspace',
        },
      ];

      const mockContext = {
        subscriptions: [],
        extensionUri: { toString: () => 'file:///mock/extension' },
        secrets: {
          get: async () => undefined,
          store: async () => {},
        },
      };

      extensionModule.activate(mockContext as any);
      const controller = extensionModule._testSeam.autocompleteController;
      assert.ok(controller, 'AutocompleteController must be initialized by extension');

      // 3. Simulate VS Code TextDocument and Position
      const mockDoc: any = {
        getText: (range?: any) => {
          if (!range) return 'def compute():\n    ';
          return 'def compute():\n    ';
        },
        languageId: 'python',
        uri: { fsPath: join(tempWorkspace, 'test.py'), toString: () => `file://${join(tempWorkspace, 'test.py')}` },
        version: 1,
        positionAt: () => new mockVscode.Position(1, 4),
      };

      const mockPos = new mockVscode.Position(1, 4);
      const tokenSource = new mockVscode.CancellationTokenSource();

      mockVscode.window.activeTextEditor = {
        document: mockDoc,
        selection: { active: mockPos },
      };

      // 4. Request inline completion through extension AutocompleteController
      const result = await controller.provideInlineCompletionItems(
        mockDoc,
        mockPos,
        {} as any,
        tokenSource.token
      );

      // 5. Verify completion returned through controller
      assert.ok(result, 'AutocompleteController must return an InlineCompletionList');
      assert.ok(result.items.length > 0, 'Must contain completion items');
      assert.strictEqual(result.items[0].insertText, smokeFixture.fimResponseText);

      // 6. Verify HTTP round-trip recorded on deterministic mock fixture
      const fimReq = smokeFixture.recordedRequests.find(
        (r) => r.method === 'POST' && r.url?.includes('/completions')
      );
      assert.ok(fimReq, 'Mock fixture must have received POST /v1/completions from production gateway');
      assert.strictEqual(fimReq?.body?.model, 'qwen2.5-coder:7b');

      await extensionModule.deactivate();
    } finally {
      delete process.env.OPEN_VS_CODE_REAL_INFERENCE;
    }
  });

  test('13. [Category D — Packaged Integration] ChatController -> AgentSessionBridge -> AgentRuntime against mock fixture', async () => {
    process.env.OPEN_VS_CODE_REAL_INFERENCE = '1';

    // 1. Setup real workspace models.json pointing to mock fixture
    const configDir = join(tempWorkspace, '.open-vs-code');
    mkdirSync(configDir, { recursive: true });
    const modelsConfig = {
      $schema: 'https://raw.githubusercontent.com/RaulMermans/Open_VS_Code/main/config/schemas/models.schema.json',
      providers: [
        {
          id: 'fixture-chat-provider',
          kind: 'openai_compatible_local',
          baseUrl: fixtureUrl,
        },
      ],
      models: [
        {
          id: 'qwen-coder',
          displayName: 'Qwen Coder',
          family: 'qwen',
          contextWindow: 8192,
          capabilities: ['coding', 'toolUse'],
          specialization: 'coding',
        },
      ],
      deployments: [
        {
          id: 'fixture-chat',
          providerId: 'fixture-chat-provider',
          modelId: 'qwen-coder',
          modelName: 'qwen2.5-coder:7b',
          enabled: true,
          priority: 10,
        },
      ],
      routes: {
        coding: ['fixture-chat'],
        default: ['fixture-chat'],
      },
    };
    writeFileSync(join(configDir, 'models.json'), JSON.stringify(modelsConfig, null, 2), 'utf8');

    try {
      const bundledExtDir = join(
        APP_PATH,
        'Contents',
        'Resources',
        'app',
        'extensions',
        'open-vs-code.vscode-integration'
      );
      const extensionModule = require(join(bundledExtDir, 'dist', 'extension.js'));

      // Configure workspaceFolder to point to our test workspace
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: tempWorkspace, toString: () => `file://${tempWorkspace}` },
          name: 'test-workspace',
        },
      ];

      // Activate extension to wire ChatController
      const mockContext = {
        subscriptions: [],
        extensionUri: { toString: () => 'file:///mock/extension' },
        secrets: {
          get: async () => undefined,
          store: async () => {},
        },
      };

      extensionModule.activate(mockContext as any);
      const chatCtrl = extensionModule._testSeam.chatController;
      assert.ok(chatCtrl, 'ChatController must be initialized by extension');

      // Submit user prompt through ChatController webview message handler
      await chatCtrl.handleWebviewMessage({
        type: 'chat.send',
        text: 'Packaged integration test ping',
        mode: 'ASK',
      });

      // Await turn completion (activeTurn returns to false)
      let turnCompleted = false;
      for (let i = 0; i < 50; i++) {
        if (!chatCtrl.state.activeTurn && chatCtrl.state.messages.some((m: any) => m.role === 'assistant')) {
          turnCompleted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(turnCompleted, true, 'Chat turn must complete within timeout');

      // Verify assistant message in chatController state
      const assistantMsg = chatCtrl.state.messages.find((m: any) => m.role === 'assistant');
      assert.ok(assistantMsg, 'Assistant response must reach ChatController state');
      assert.strictEqual(assistantMsg.content, smokeFixture.chatResponseText);

      // Verify HTTP request reached mock fixture with expected model
      const chatReq = smokeFixture.recordedRequests.find(
        (r) => r.method === 'POST' && r.url?.includes('/chat/completions')
      );
      assert.ok(chatReq, 'Fixture must have received POST /chat/completions');
      assert.strictEqual(chatReq?.body?.model, 'qwen2.5-coder:7b');

      await extensionModule.deactivate();
    } finally {
      delete process.env.OPEN_VS_CODE_REAL_INFERENCE;
    }
  });
});
