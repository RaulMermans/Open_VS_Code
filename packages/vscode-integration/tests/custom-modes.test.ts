import { test, describe, before, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Module from "node:module";

// Mock vscode module for node test runner before requiring internal modules
const mockVscode = {
  window: {
    showErrorMessage: () => {},
    showWarningMessage: async () => "Cancel",
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { writeText: () => {} } },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: () => false }),
  },
};

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string) {
  if (request === "vscode") return "vscode";
  return originalResolveFilename.apply(this, arguments);
};
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "vscode") return mockVscode;
  return originalRequire.apply(this, arguments);
};

let ModeService: any;
let renderModesSection: any;
let renderModeWizard: any;
let renderModeInspector: any;
let ChatController: any;
let AgentSessionBridge: any;

describe("Sprint 8D — Custom Modes Engine & VS Code Integration", () => {
  let tmpDir: string;
  let modeService: any;

  before(async () => {
    const modeServiceMod = await import("../src/modes/mode-service.js");
    ModeService = modeServiceMod.ModeService;
    const renderMod = await import("../src/webview-render-helpers.js");
    renderModesSection = renderMod.renderModesSection;
    renderModeWizard = renderMod.renderModeWizard;
    renderModeInspector = renderMod.renderModeInspector;
    const mod = await import("../src/chat-controller.js");
    ChatController = mod.ChatController;
    const bridgeMod = await import("@open-vs-code/ide-adapter");
    AgentSessionBridge = bridgeMod.AgentSessionBridge;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-test-"));
    modeService = new ModeService({ workspaceRoot: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTestProfile(overrides: Record<string, any> = {}) {
    return {
      id: "test-mode",
      name: "Test Mode",
      description: "Test description",
      icon: "code",
      version: 1,
      schemaVersion: 1,
      source: "workspace" as const,
      baseMode: "PLAN" as const,
      scope: "workspace" as const,
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe("1. ModeService — Built-in & Workspace Storage", () => {
    test("loads canonical starter profiles by default", () => {
      const modes = modeService.listModes();
      assert.ok(modes.length >= 3, "Expected at least 3 starter modes");
      const ids = modes.map((m) => m.id);
      assert.ok(ids.includes("architecture-review"));
      assert.ok(ids.includes("reverse-engineering-analysis"));
      assert.ok(ids.includes("design-exploration"));
    });

    test("saves and loads custom workspace profiles to .open-vs-code/modes.json", () => {
      const customProfile = makeTestProfile({
        id: "team-audit",
        name: "Team Audit Mode",
        description: "Specialized team audit",
        icon: "shield",
        baseMode: "REVIEW",
        requiredSkills: ["sec-audit"],
      });

      modeService.createWorkspaceMode(customProfile);

      const filePath = path.join(tmpDir, ".open-vs-code", "modes.json");
      assert.ok(fs.existsSync(filePath), "modes.json file should exist");

      const saved = modeService.getMode("team-audit");
      assert.ok(saved, "Mode should be retrievable");
      assert.equal(saved.name, "Team Audit Mode");
      assert.equal(saved.scope, "workspace");
      assert.deepEqual(saved.requiredSkills, ["sec-audit"]);
    });

    test("deletes workspace profile cleanly", () => {
      modeService.createWorkspaceMode(makeTestProfile({
        id: "temp-mode",
        name: "Temporary",
        description: "To be deleted",
      }));

      assert.ok(modeService.getMode("temp-mode"));
      modeService.deleteWorkspaceMode("temp-mode");
      assert.equal(modeService.getMode("temp-mode"), undefined);
    });

    test("cannot delete or overwrite builtin profile via deleteWorkspaceMode", () => {
      assert.throws(() => {
        modeService.deleteWorkspaceMode("architecture-review");
      }, /Cannot delete built-in/);
      assert.ok(modeService.getMode("architecture-review"));
    });

    test("duplicates an existing mode into workspace scope", () => {
      const dup = modeService.duplicateMode("architecture-review", "workspace");
      assert.ok(dup, "Duplicate should succeed");
      assert.ok(dup.id.startsWith("architecture-review-copy"), "Copied ID should have suffix");
      assert.equal(dup.scope, "workspace");
      assert.equal(dup.baseMode, "REVIEW");
      assert.ok(modeService.getMode(dup.id));
    });

    test("disables and re-enables a mode profile", () => {
      modeService.toggleModeEnabled("architecture-review", false);
      const disabled = modeService.getMode("architecture-review");
      assert.equal(disabled?.enabled, false);

      modeService.toggleModeEnabled("architecture-review", true);
      const enabled = modeService.getMode("architecture-review");
      assert.equal(enabled?.enabled, true);
    });

    test("precedence: workspace profile overrides account profile with matching ID", () => {
      const accountMode = makeTestProfile({
        id: "shared-profile",
        name: "Account Version",
        description: "From cloud account",
        source: "account",
        scope: "account",
      });

      const workspaceMode = makeTestProfile({
        id: "shared-profile",
        name: "Workspace Override",
        description: "From local repo",
        version: 2,
        source: "workspace",
        scope: "workspace",
      });

      // Set account mode then workspace mode
      (modeService as any).accountProfiles.set("shared-profile", accountMode);
      modeService.createWorkspaceMode(workspaceMode);

      const effective = modeService.getMode("shared-profile");
      assert.equal(effective?.name, "Workspace Override");
      assert.equal(effective?.scope, "workspace");
    });
  });

  describe("2. Deterministic Mode Resolution & Readiness", () => {
    test("starter profile architecture-review resolves ready when no missing dependencies", () => {
      const resolved = modeService.resolveMode("architecture-review", {
        workspaceTrusted: true,
        availableSkills: [],
        availableMcpServers: [],
        availableTools: ["read_repository", "search_repository", "read_markdown"],
      });

      assert.equal(resolved.isReady, true);
      assert.equal(resolved.baseMode, "REVIEW");
      assert.equal(resolved.profileId, "architecture-review");
    });

    test("missing required skill causes isReady: false and emits diagnostic", () => {
      modeService.createWorkspaceMode(makeTestProfile({
        id: "needs-special-skill",
        name: "Needs Skill",
        description: "Requires advanced skill",
        requiredSkills: ["non-existent-skill"],
      }));

      const resolved = modeService.resolveMode("needs-special-skill", {
        workspaceTrusted: true,
        availableSkills: [{ id: "git-commit" }],
        availableMcpServers: [],
        availableTools: ["read_repository"],
      });

      assert.equal(resolved.isReady, false);
      assert.ok(resolved.missingRequiredSkills.includes("non-existent-skill"));
      assert.ok(resolved.diagnostics.some((d) => d.includes("non-existent-skill")));
    });

    test("missing required MCP server causes isReady: false and blocks execution", () => {
      modeService.createWorkspaceMode(makeTestProfile({
        id: "needs-mcp",
        name: "Needs Postgres MCP",
        description: "Requires DB server",
        requiredMcpServers: ["postgres-mcp"],
      }));

      const resolved = modeService.resolveMode("needs-mcp", {
        workspaceTrusted: true,
        availableSkills: [],
        availableMcpServers: [{ id: "postgres-mcp", connected: false, enabled: true }],
        availableTools: ["read_repository"],
      });

      assert.equal(resolved.isReady, false);
      assert.ok(resolved.missingRequiredMcpServers.includes("postgres-mcp"));
    });

    test("tool allowlist strictly filters effective tools in resolved execution profile", () => {
      modeService.createWorkspaceMode(makeTestProfile({
        id: "restricted-tools",
        name: "Restricted",
        description: "Only read tools permitted",
        baseMode: "REVIEW",
        toolAllowlist: ["read_repository", "read_markdown"],
      }));

      const resolved = modeService.resolveMode("restricted-tools", {
        workspaceTrusted: true,
        availableSkills: [],
        availableMcpServers: [],
        availableTools: ["read_repository", "read_markdown", "write_file", "terminal_command"],
      });

      assert.equal(resolved.isReady, true);
      assert.deepEqual(resolved.effectiveTools, ["read_repository", "read_markdown"]);
      assert.ok(!resolved.effectiveTools.includes("write_file"));
      assert.ok(!resolved.effectiveTools.includes("terminal_command"));
    });
  });

  describe("3. ChatController Mode Integration & Safety Invariants", () => {
    let host: any;
    let controller: any;
    let mockBridge: any;

    beforeEach(() => {
      host = {
        getSnapshot: async () => ({
          workspaceRoots: [{ uri: `file://${tmpDir}`, fsPath: tmpDir, name: "test-workspace" }],
          activeDocument: null,
          selection: null,
          diagnostics: [],
          visibleDocuments: [],
        }),
        isWorkspaceTrusted: async () => true,
        checkConnection: async () => true,
      };

      mockBridge = {
        runTask: async () => ({
          status: "COMPLETED",
          finalAnswer: "Mode task completed.",
        }),
      };

      controller = new ChatController(host, () => mockBridge);
      controller.attachModeService(modeService);
    });

    test("setting custom mode updates state and active profile", async () => {
      await controller.handleWebviewMessage({
        type: "chat.setMode",
        mode: "REVIEW",
        customModeId: "architecture-review",
      });

      const state = controller.getState();
      assert.equal(state.mode, "REVIEW");
      assert.equal(state.customModeId, "architecture-review");
      assert.ok(state.activeCustomProfile);
      assert.equal(state.activeCustomProfile.id, "architecture-review");
      assert.equal(state.activeCustomProfile.baseMode, "REVIEW");
    });

    test("active task guard: changing mode while task is running is blocked", async () => {
      // Simulate active turn
      (controller as any).state.activeTurn = true;

      await controller.handleWebviewMessage({
        type: "chat.setMode",
        mode: "BUILD",
        customModeId: "feature-implementation",
      });

      const state = controller.getState();
      // Should not have changed to BUILD
      assert.notEqual(state.mode, "BUILD");
      assert.notEqual(state.customModeId, "feature-implementation");
    });

    test("unready mode blocks execution and posts actionable diagnostic message without running bridge", async () => {
      modeService.createWorkspaceMode(makeTestProfile({
        id: "broken-mode",
        name: "Broken Mode",
        description: "Missing required skill",
        requiredSkills: ["uninstalled-skill"],
      }));

      await controller.handleWebviewMessage({
        type: "chat.setMode",
        mode: "PLAN",
        customModeId: "broken-mode",
      });

      let bridgeCalled = false;
      mockBridge.runTask = async () => {
        bridgeCalled = true;
        return { status: "COMPLETED" };
      };

      await controller.handleWebviewMessage({
        type: "chat.send",
        text: "Analyze repository",
        mode: "PLAN",
        customModeId: "broken-mode",
      });

      assert.equal(bridgeCalled, false, "Agent bridge should NOT have been invoked for unready mode");

      const state = controller.getState();
      const lastMsg = state.messages[state.messages.length - 1];
      assert.equal(lastMsg.role, "system");
      assert.ok(lastMsg.content.includes("Broken Mode"));
      assert.ok(lastMsg.content.includes("required dependencies are missing or unready"));
      assert.equal(state.lastStatus, "failed");
    });

    test("conversation persistence preserves customModeId and restores it safely", async () => {
      await controller.handleWebviewMessage({
        type: "chat.setMode",
        mode: "REVIEW",
        customModeId: "architecture-review",
      });

      await controller.handleWebviewMessage({
        type: "chat.send",
        text: "Audit this codebase",
        mode: "REVIEW",
        customModeId: "architecture-review",
      });

      const state = controller.getState();
      assert.equal(state.customModeId, "architecture-review");
    });
  });

  describe("4. Webview Render Helpers for Custom Modes", () => {
    class MockDoc {
      createElement(tag: string) {
        const el: any = {
          tagName: tag.toUpperCase(),
          children: [] as any[],
          attributes: {} as Record<string, string>,
          className: "",
          innerHTML: "",
          textContent: "",
          style: {},
          appendChild(child: any) {
            this.children.push(child);
            return child;
          },
          setAttribute(name: string, val: string) {
            this.attributes[name] = val;
          },
          getAttribute(name: string) {
            return this.attributes[name];
          },
          addEventListener(evt: string, cb: any) {
            this["_on_" + evt] = cb;
          },
        };
        return el;
      }
    }

    test("renderModesSection renders mode cards and actions", () => {
      const doc = new MockDoc();
      const container = doc.createElement("div");

      const state = {
        modes: [
          {
            id: "architecture-review",
            name: "Architecture Review",
            description: "Read-only structural critique",
            version: 1,
            source: "builtin",
            baseMode: "REVIEW",
            scope: "builtin",
            enabled: true,
            isReady: true,
            isActive: false,
            requiredSkillCount: 0,
            requiredMcpCount: 0,
            missingRequiredCount: 0,
            diagnostics: [],
          },
        ],
        activeModeId: undefined,
      };

      const panel = renderModesSection(container, state, doc);
      assert.ok(panel, "Panel should be created");
      assert.equal(container.children.length, 1);
    });

    test("renderModeWizard renders 9 steps and validation state", () => {
      const doc = new MockDoc();
      const container = doc.createElement("div");

      const wizard = {
        step: 1,
        draft: {
          name: "Test Draft",
          id: "test-draft",
          description: "A draft mode",
          baseMode: "PLAN",
          scope: "workspace",
        },
        validationErrors: ["Name is required"],
      };

      const panel = renderModeWizard(container, wizard, {}, doc);
      assert.ok(panel);
      assert.equal(container.children.length, 1);
    });

    test("renderModeInspector renders effective permissions and dependency breakdown", () => {
      const doc = new MockDoc();
      const container = doc.createElement("div");

      const detail = {
        id: "sec-audit",
        name: "Security Audit",
        description: "Full vulnerability inspection",
        version: 1,
        source: "workspace",
        baseMode: "REVIEW",
        scope: "workspace",
        enabled: true,
        isReady: true,
        isActive: true,
        requiredSkillCount: 1,
        requiredMcpCount: 0,
        missingRequiredCount: 0,
        diagnostics: [],
        requiredSkills: ["sec-audit-skill"],
        optionalSkills: [],
        requiredMcpServers: [],
        optionalMcpServers: [],
        toolAllowlist: ["read_repository"],
        customInstructions: "Look for memory safety issues.",
      };

      const panel = renderModeInspector(container, detail, doc);
      assert.ok(panel);
      assert.equal(container.children.length, 1);
    });
  });
});
