import * as vscode from "vscode";
import type { McpService, McpServerSummary } from "./mcp-service.js";
import { classifyMcpAction } from "@open-vs-code/agent-core";

export const STARTER_MCP_JSON = JSON.stringify(
  {
    $schema: "https://raw.githubusercontent.com/RaulMermans/Open_VS_Code/main/config/schemas/mcp.schema.json",
    version: 2,
    servers: {
      "local-node": {
        name: "Local Node Tool Server",
        transport: "stdio",
        command: "node",
        args: ["./scripts/mcp-server.js"],
        enabled: false,
      },
      "remote-gateway": {
        name: "Remote MCP Gateway",
        transport: "streamable_http",
        url: "https://mcp.internal.example/api",
        enabled: false,
        auth: {
          type: "bearer",
          secretKey: "mcp.remoteGateway.token",
        },
      },
    },
  },
  null,
  2,
) + "\n";

export function registerMcpCommands(
  context: vscode.ExtensionContext,
  service: McpService,
  outputChannel?: vscode.OutputChannel,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // 1. List configured MCP servers
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.listMcpServers", async () => {
      const summaries = await service.listServers();
      if (summaries.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          "No MCP servers configured in .open-vs-code/mcp.json.",
          "Open MCP Config",
          "Close",
        );
        if (choice === "Open MCP Config") {
          await vscode.commands.executeCommand("open-vs-code.openMcpConfig");
        }
        return;
      }

      const items = summaries.map((s) => ({
        label: `${stateIcon(s.state)} ${s.name}`,
        description: `[${s.transport}] · ${s.state} · ${s.toolCount} tool(s)`,
        detail: `${s.urlOrCommand}${s.auth?.type && s.auth.type !== "none" ? ` · Auth: ${s.auth.type}` : ""}${s.error ? ` · Error: ${s.error}` : ""}`,
        serverId: s.id,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: "Configured MCP Servers",
        placeHolder: "Select a server to inspect or manage",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (picked) {
        await vscode.commands.executeCommand("open-vs-code.inspectMcpServer", picked.serverId);
      }
    }),
  );

  // 2. Inspect MCP server
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.inspectMcpServer", async (serverIdArg?: string) => {
      let serverId = serverIdArg;
      const summaries = await service.listServers();
      if (summaries.length === 0) {
        vscode.window.showInformationMessage("No MCP servers configured.");
        return;
      }

      if (!serverId) {
        const picked = await vscode.window.showQuickPick(
          summaries.map((s) => ({
            label: `${stateIcon(s.state)} ${s.name}`,
            description: `[${s.transport}] · ${s.state}`,
            serverId: s.id,
          })),
          { title: "Select MCP Server to Inspect" },
        );
        if (!picked) return;
        serverId = picked.serverId;
      }

      const summary = summaries.find((s) => s.id === serverId);
      if (!summary) {
        vscode.window.showErrorMessage(`Server "${serverId}" not found.`);
        return;
      }

      const actions = [
        ...(summary.state !== "CONNECTED"
          ? [{ label: "$(plug) Connect Server", action: "connect" }]
          : [{ label: "$(debug-disconnect) Disconnect Server", action: "disconnect" }]),
        { label: `$(tools) Inspect Discovered Tools (${summary.toolCount})`, action: "inspectTools" },
        { label: "$(refresh) Refresh Discovery", action: "refresh" },
        { label: "$(info) View Actionable Diagnostics", action: "diagnostics" },
        { label: "$(edit) Open Configuration File", action: "openConfig" },
      ];

      const authInfo = summary.auth
        ? `${summary.auth.type}${summary.auth.secretKey ? ` (SecretStorage key: ${summary.auth.secretKey})` : summary.auth.tokenEnv ? ` (env: ${summary.auth.tokenEnv})` : ""}`
        : "none";

      const choice = await vscode.window.showQuickPick(actions, {
        title: `MCP Server: ${summary.name} [${summary.state}]`,
        placeHolder: `Transport: ${summary.transport} | Auth: ${authInfo} | Tools: ${summary.toolCount}`,
      });

      if (!choice) return;

      switch (choice.action) {
        case "connect":
          await vscode.commands.executeCommand("open-vs-code.connectMcpServer", summary.id);
          break;
        case "disconnect":
          await vscode.commands.executeCommand("open-vs-code.disconnectMcpServer", summary.id);
          break;
        case "inspectTools":
          await vscode.commands.executeCommand("open-vs-code.inspectMcpTools", summary.id);
          break;
        case "refresh":
          await vscode.commands.executeCommand("open-vs-code.refreshMcpDiscovery");
          break;
        case "diagnostics":
          await vscode.commands.executeCommand("open-vs-code.viewMcpDiagnostics");
          break;
        case "openConfig":
          await vscode.commands.executeCommand("open-vs-code.openMcpConfig");
          break;
      }
    }),
  );

  // 3. Inspect discovered tools
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.inspectMcpTools", async (filterServerId?: string) => {
      const catalog = await service.getCatalog();
      let tools = catalog.getTools();
      if (filterServerId) {
        tools = tools.filter((t) => t.serverId === filterServerId);
      }

      if (tools.length === 0) {
        vscode.window.showInformationMessage(
          filterServerId
            ? `No tools discovered for MCP server "${filterServerId}". Ensure the server is connected.`
            : "No MCP tools discovered. Ensure servers are enabled and connected.",
        );
        return;
      }

      const items = tools.map((t) => {
        const actionType = classifyMcpAction(t);
        return {
          label: `$(wrench) ${t.toolName}`,
          description: `Server: ${t.serverId} · Action: ${actionType} · ~${t.estimatedSchemaTokens} tokens`,
          detail: t.description || "No description provided",
          tool: t,
          actionType,
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        title: filterServerId ? `Tools Discovered: ${filterServerId}` : "All Discovered MCP Tools",
        placeHolder: "Select a tool to view its parameters and security classification",
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (picked) {
        const t = picked.tool;
        const schema = t.inputSchema ? JSON.stringify(t.inputSchema, null, 2) : "None";
        const props = t.inputSchema?.properties
          ? Object.keys(t.inputSchema.properties).join(", ")
          : "none";

        await vscode.window.showInformationMessage(
          `MCP Tool: ${t.toolName} (${t.serverId})\nClassification: ${picked.actionType}\nParameters: ${props}\n\nDescription: ${t.description || "none"}`,
          { modal: true, detail: `Input Schema:\n${schema}` },
        );
      }
    }),
  );

  // 4. Open MCP configuration
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.openMcpConfig", async () => {
      const root = service.getRoot();
      if (!root) {
        vscode.window.showWarningMessage("Open a workspace folder before managing MCP configuration.");
        return;
      }

      const dirPath = vscode.Uri.file(`${root}/.open-vs-code`);
      const filePath = vscode.Uri.file(`${root}/.open-vs-code/mcp.json`);

      try {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
      } catch {
        const choice = await vscode.window.showInformationMessage(
          "No mcp.json found. Would you like to create a starter MCP configuration?",
          "Create Starter Config",
          "Cancel",
        );
        if (choice === "Create Starter Config") {
          try {
            await vscode.workspace.fs.createDirectory(dirPath);
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(filePath, encoder.encode(STARTER_MCP_JSON));
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage("Created starter MCP configuration at .open-vs-code/mcp.json");
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create starter config: ${err.message}`);
          }
        }
      }
    }),
  );

  // 5. Connect server
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.connectMcpServer", async (serverIdArg?: string) => {
      let serverId = serverIdArg;
      if (!serverId) {
        const summaries = await service.listServers();
        const disconnected = summaries.filter((s) => s.state !== "CONNECTED");
        if (disconnected.length === 0) {
          vscode.window.showInformationMessage("All configured MCP servers are already connected.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          disconnected.map((s) => ({
            label: `${stateIcon(s.state)} ${s.name}`,
            description: `[${s.transport}] · ${s.state}`,
            serverId: s.id,
          })),
          { title: "Select MCP Server to Connect" },
        );
        if (!picked) return;
        serverId = picked.serverId;
      }

      outputChannel?.appendLine(`[MCP] Connecting to server "${serverId}"...`);
      const res = await service.connectServer(serverId);
      if (res.success) {
        vscode.window.showInformationMessage(res.message);
        outputChannel?.appendLine(`[MCP] ${res.message}`);
      } else {
        vscode.window.showErrorMessage(res.message);
        outputChannel?.appendLine(`[MCP Error] ${res.message}`);
      }
    }),
  );

  // 6. Disconnect server
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.disconnectMcpServer", async (serverIdArg?: string) => {
      let serverId = serverIdArg;
      if (!serverId) {
        const summaries = await service.listServers();
        const connected = summaries.filter((s) => s.state === "CONNECTED" || s.state === "DEGRADED");
        if (connected.length === 0) {
          vscode.window.showInformationMessage("No connected MCP servers to disconnect.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          connected.map((s) => ({
            label: `${stateIcon(s.state)} ${s.name}`,
            description: `[${s.transport}] · ${s.state}`,
            serverId: s.id,
          })),
          { title: "Select MCP Server to Disconnect" },
        );
        if (!picked) return;
        serverId = picked.serverId;
      }

      const res = await service.disconnectServer(serverId);
      vscode.window.showInformationMessage(res.message);
      outputChannel?.appendLine(`[MCP] ${res.message}`);
    }),
  );

  // 7. Refresh tool discovery
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.refreshMcpDiscovery", async () => {
      outputChannel?.appendLine("[MCP] Refreshing tool discovery across all configured servers...");
      const res = await service.refreshDiscovery();
      const msg = `MCP discovery refreshed: ${res.servers} server(s), ${res.tools} tool(s) discovered.${res.diagnostics > 0 ? ` (${res.diagnostics} diagnostic issues detected)` : ""}`;
      vscode.window.showInformationMessage(msg);
      outputChannel?.appendLine(`[MCP] ${msg}`);
    }),
  );

  // 8. View actionable diagnostics
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.viewMcpDiagnostics", async () => {
      const diagnostics = await service.getDiagnostics();
      if (diagnostics.length === 0) {
        vscode.window.showInformationMessage("All configured MCP servers and configurations are healthy.");
        return;
      }

      if (outputChannel) {
        outputChannel.appendLine("=== MCP Diagnostics ===");
        for (const line of diagnostics) {
          outputChannel.appendLine(line);
        }
        outputChannel.show(true);
      }

      await vscode.window.showQuickPick(
        diagnostics.map((d) => ({
          label: "$(warning) " + d,
        })),
        { title: `Actionable MCP Diagnostics (${diagnostics.length} issues)` },
      );
    }),
  );

  return disposables;
}

function stateIcon(state: string): string {
  switch (state) {
    case "CONNECTED":
      return "$(pass-filled)";
    case "CONNECTING":
      return "$(sync~spin)";
    case "AUTH_REQUIRED":
      return "$(key)";
    case "DEGRADED":
      return "$(warning)";
    case "FAILED":
      return "$(error)";
    case "DISABLED":
      return "$(circle-slash)";
    case "DISCONNECTED":
    default:
      return "$(circle-outline)";
  }
}
