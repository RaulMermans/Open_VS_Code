import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyInvestigationTarget } from "../../src/rea/target-classifier.ts";
import { ReaMcpService } from "../../src/rea/rea-mcp-service.ts";
import { REA_PINNED_VERSION } from "../../src/rea/contracts.ts";

const REA_CLI_CANDIDATE = "/tmp/rea-upstream/scripts/rea.mjs";
const hasUpstreamRea = existsSync(REA_CLI_CANDIDATE);

test(
  "Demo B — JavaScript/Electron Application Static Investigation via Real REA MCP",
  { skip: !hasUpstreamRea },
  async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "rea-demo-b-electron-"));

    try {
      // 1. Author an authorized Electron application fixture
      writeFileSync(
        join(fixtureDir, "package.json"),
        JSON.stringify({
          name: "secure-notes-electron",
          version: "1.2.0",
          main: "main.js",
          devDependencies: {
            electron: "^28.2.0",
          },
        })
      );

      writeFileSync(
        join(fixtureDir, "main.js"),
        `const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile("index.html");
}

app.whenReady().then(createWindow);

ipcMain.handle("notes:get", async () => {
  return [{ id: 1, text: "Grounded REA Investigation Note" }];
});

ipcMain.handle("notes:save", async (event, note) => {
  if (!note || !note.text) throw new Error("Invalid note payload");
  return { success: true, id: Date.now() };
});
`
      );

      writeFileSync(
        join(fixtureDir, "preload.js"),
        `const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notesApi", {
  getNotes: () => ipcRenderer.invoke("notes:get"),
  saveNote: (note) => ipcRenderer.invoke("notes:save", note),
});
`
      );

      writeFileSync(
        join(fixtureDir, "renderer.js"),
        `window.addEventListener("DOMContentLoaded", async () => {
  const notes = await window.notesApi.getNotes();
  const list = document.getElementById("notes-list");
  for (const n of notes) {
    const li = document.createElement("li");
    li.textContent = n.text;
    list.appendChild(li);
  }
});
`
      );

      writeFileSync(
        join(fixtureDir, "index.html"),
        `<!DOCTYPE html>
<html>
<head><title>Secure Notes</title></head>
<body>
  <h1>Secure Notes App</h1>
  <ul id="notes-list"></ul>
  <script src="renderer.js"></script>
</body>
</html>
`
      );

      // 2. Deterministic Target Classification
      const target = classifyInvestigationTarget(fixtureDir, { workspaceRoot: fixtureDir });
      assert.equal(target.category, "javascript_electron_app");
      assert.equal(target.format, "unpacked_electron_directory");
      assert.equal(target.authorized, true);
      assert.equal(target.metadata?.packageName, "secure-notes-electron");
      assert.equal(target.metadata?.mainEntry, "main.js");

      // 3. Connect to real REA MCP server
      const reaService = new ReaMcpService({
        reaCliPath: REA_CLI_CANDIDATE,
        nodeExecutable: "/Users/raulm/.nvm/versions/node/v22.23.2/bin/node",
        requestTimeoutMs: 30000,
      });

      try {
        const identity = await reaService.connect();
        assert.equal(identity.server.version, REA_PINNED_VERSION);
        assert.ok(reaService.hasTool("analyze_javascript_application"));
        assert.ok(reaService.hasPrompt("investigate_feature"));

        // 4. Execute REA tool analyze_javascript_application
        const toolResult = await reaService.callTool("analyze_javascript_application", {
          input_path: fixtureDir,
        });

        assert.equal(toolResult.isError, false, "REA tool execution should succeed");
        assert.ok(toolResult.content.length > 0);

        const firstText = toolResult.content.find((c) => c.type === "text")?.text;
        assert.ok(firstText, "REA must return text payload");

        const evidence = JSON.parse(firstText);
        assert.ok(evidence.evidence_id, "REA must emit a valid evidence_id");
        assert.ok(evidence.subject?.digest?.sha256, "REA must compute deterministic SHA-256 digest");

        // 5. Invoke Guided Investigation Prompt
        const promptResult = await reaService.getPrompt("investigate_feature", {
          feature: "IpcDataTransfer",
          target_path: fixtureDir,
        });

        assert.ok(promptResult.messages.length > 0, "REA prompt must return guidance messages");
        const promptContent = promptResult.messages.map((m) => m.content.text).join(" ");
        assert.ok(promptContent.length > 50, "Prompt must contain detailed guidance");

        // 6. Safe Native Inspection Checks
        const diagnostics = await reaService.queryProviderDiagnostics();
        const nativeReport = diagnostics.find((d) => d.id === "native-macos");
        assert.ok(nativeReport);
        assert.equal(nativeReport.available, process.platform === "darwin");

        // Heavyweight providers report safely unconfigured
        const ghidraReport = diagnostics.find((d) => d.id === "ghidra");
        assert.equal(ghidraReport?.available, false);
      } finally {
        await reaService.close();
        assert.equal(reaService.isConnected, false);
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
);
