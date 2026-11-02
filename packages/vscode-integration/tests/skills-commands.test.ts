import { test, describe, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionPath = mkdtempSync(join(tmpdir(), "ovsc-ext-skills-"));
cpSync(resolve(__dirname, "../../agent-core/skills/builtins"), join(extensionPath, "dist", "skills", "builtins"), { recursive: true });
const workspaceRoot = mkdtempSync(join(tmpdir(), "ovsc-ws-skills-"));
mkdirSync(join(workspaceRoot, ".open-vs-code", "skills", "broken"), { recursive: true });
writeFileSync(join(workspaceRoot, ".open-vs-code", "skills", "broken", "SKILL.md"), "not a skill");

const shown = { quickPicks: [] as any[], info: [] as string[], output: [] as string[] };

const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine: (line: string) => shown.output.push(line), show: () => {}, dispose: () => {} }),
    activeTextEditor: null,
    visibleTextEditors: [],
    showErrorMessage: () => {},
    showWarningMessage: async () => undefined,
    showInformationMessage: async (message: string) => { shown.info.push(message); return undefined; },
    showQuickPick: async (items: any[], options: any) => { shown.quickPicks.push({ items, options }); return undefined; },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot, toString: () => `file://${workspaceRoot}` }, name: "workspace" }],
    isTrusted: true,
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key === "skills.enabled" ? true : fallback) }),
    getWorkspaceFolder: () => null,
    asRelativePath: () => "f.ts",
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  },
  languages: {
    onDidChangeDiagnostics: () => ({ dispose: () => {} }),
    getDiagnostics: () => [],
    registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
  },
  commands: {
    registerCommand: (id: string, callback: any) => {
      mockVscode.commands.registered[id] = callback;
      return { dispose: () => {} };
    },
    executeCommand: async () => {},
    registered: {} as any,
  },
  ProgressLocation: { Notification: 15 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
};

describe("Skills commands (Sprint 5A)", () => {
  before(() => {
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
    const ext = require("../src/extension.ts");
    ext.activate({ subscriptions: [] as any[], extensionPath, secrets: { get: async () => undefined, store: async () => {} } });
  });

  test("List Available Skills shows metadata only and reports invalid workspace skills", async () => {
    await mockVscode.commands.registered["open-vs-code.listSkills"]();
    assert.strictEqual(shown.quickPicks.length, 1);
    const { items, options } = shown.quickPicks[0];
    assert.deepStrictEqual(
      items.map((item: any) => item.label),
      [
        "accessibility-review",
        "browser-behavior-investigation",
        "bug-triage",
        "design-direction",
        "design-polish",
        "design-system-engineering",
        "evidence-reconciliation",
        "feature-specification",
        "frontend-composition",
        "javascript-electron-analysis",
        "motion-engineering",
        "native-artifact-analysis",
        "rea-investigation-routing",
        "reconstruction-planning",
        "reconstruction-verification",
        "refactor-with-guards",
        "security-review",
        "tdd",
        "ux-information-architecture",
        "verification",
        "visual-qa",
      ]
    );
    assert.ok(items.every((item: any) => item.detail.length <= 200 && !item.detail.includes("# Workflow")), "descriptions only, never bodies");
    assert.ok(String(options.title).includes("enabled"));
    assert.ok(shown.output.some((line) => line.includes("broken") && line.includes("MALFORMED_FRONTMATTER")));
  });

  test("Show Active Skill reports when no task has run", async () => {
    await mockVscode.commands.registered["open-vs-code.showActiveSkill"]();
    assert.ok(shown.info.some((message) => message.startsWith("No active skill")));
  });
});
