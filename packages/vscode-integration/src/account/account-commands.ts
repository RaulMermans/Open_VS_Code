import * as vscode from "vscode";
import type { DesktopAccountManager } from "./account-manager.js";
import type { McpService } from "../mcp/mcp-service.js";

export function registerAccountCommands(
  context: vscode.ExtensionContext,
  accountManager: DesktopAccountManager,
  mcpService?: McpService,
  outputChannel?: vscode.OutputChannel
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // 1. Account Login Command
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.accountLogin", async () => {
      const state = accountManager.getState();
      if (state.status === "ONLINE" && state.user) {
        const choice = await vscode.window.showInformationMessage(
          `Already logged in as ${state.user.username} (${state.user.role}). Do you want to log out or switch account?`,
          "Switch Account",
          "Cancel"
        );
        if (choice !== "Switch Account") return;
        await accountManager.logout();
      }

      const defaultUrl = state.serverUrl || "http://127.0.0.1:4040";
      const serverUrl = await vscode.window.showInputBox({
        title: "Account Server URL",
        prompt: "Enter the Open VS Code Account Service URL",
        value: defaultUrl,
        ignoreFocusOut: true,
      });
      if (!serverUrl?.trim()) return;

      const username = await vscode.window.showInputBox({
        title: "Account Username",
        prompt: "Enter your account username",
        ignoreFocusOut: true,
      });
      if (!username?.trim()) return;

      const password = await vscode.window.showInputBox({
        title: "Account Password",
        prompt: "Enter your account password",
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Authenticating with account service at ${serverUrl}...`,
            cancellable: false,
          },
          async () => {
            const user = await accountManager.login(
              username.trim(),
              password,
              serverUrl.trim(),
              mcpService
            );
            vscode.window.showInformationMessage(
              `Successfully logged in as ${user.username} (${user.role}).`
            );
          }
        );
      } catch (err: any) {
        const msg = err.message || "Failed to authenticate with account service.";
        vscode.window.showErrorMessage(`Login failed: ${msg}`);
        outputChannel?.appendLine(`[Account] Login error: ${msg}`);
      }
    })
  );

  // 2. Account Logout Command
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.accountLogout", async () => {
      const state = accountManager.getState();
      if (state.status === "UNAUTHENTICATED") {
        vscode.window.showInformationMessage("Not currently logged in.");
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Are you sure you want to log out of ${state.user?.username || "your account"}?`,
        { modal: true },
        "Log Out"
      );
      if (confirmed !== "Log Out") return;

      await accountManager.logout();
      vscode.window.showInformationMessage("Logged out of Open VS Code account.");
    })
  );

  // 3. View Account Profile Command
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.showAccountProfile", async () => {
      const state = accountManager.getState();

      if (state.status === "UNAUTHENTICATED") {
        const choice = await vscode.window.showInformationMessage(
          "You are not currently logged in to an Open VS Code account. Local coding functionality is active.",
          "Log In",
          "Close"
        );
        if (choice === "Log In") {
          await vscode.commands.executeCommand("open-vs-code.accountLogin");
        }
        return;
      }

      const statusLabel = state.status === "ONLINE"
        ? "$(pass) Online"
        : `$(warning) Offline (${state.isStale ? "Stale Profile" : "Unreachable"})`;

      const items = [
        {
          label: `$(account) ${state.user?.username || "Unknown"}`,
          description: `Role: ${state.user?.role || "USER"} · Status: ${state.user?.status || "ACTIVE"}`,
          detail: `User ID: ${state.user?.id || "N/A"}`,
        },
        {
          label: `$(server) Service: ${state.serverUrl}`,
          description: statusLabel,
          detail: state.error ? `Diagnostic: ${state.error}` : "Account service is connected and responding.",
        },
        {
          label: "$(sync) Synchronize Account MCP Integrations",
          description: state.lastSyncTime ? `Last synced: ${state.lastSyncTime}` : "Not yet synced in this session",
          action: "sync",
        },
        {
          label: "$(sign-out) Log Out",
          description: "Revoke current session and remove stored credentials",
          action: "logout",
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title: "Open VS Code: Account Profile & Integrations",
        placeHolder: "Select an action or view account diagnostics",
      });

      if (!picked) return;

      if ((picked as any).action === "sync") {
        await vscode.commands.executeCommand("open-vs-code.syncAccountIntegrations");
      } else if ((picked as any).action === "logout") {
        await vscode.commands.executeCommand("open-vs-code.accountLogout");
      }
    })
  );

  // 4. Sync Account MCP Integrations Command
  disposables.push(
    vscode.commands.registerCommand("open-vs-code.syncAccountIntegrations", async () => {
      if (!mcpService) {
        vscode.window.showWarningMessage("MCP Service is not available in this workspace.");
        return;
      }

      const state = accountManager.getState();
      if (state.status === "UNAUTHENTICATED") {
        const choice = await vscode.window.showInformationMessage(
          "Log in to restore your saved MCP integrations from your account.",
          "Log In"
        );
        if (choice === "Log In") {
          await vscode.commands.executeCommand("open-vs-code.accountLogin");
        }
        return;
      }

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Synchronizing MCP integrations from account backend...",
            cancellable: false,
          },
          async () => accountManager.syncIntegrations(mcpService)
        );

        if (result.isOffline) {
          vscode.window.showWarningMessage(
            "Account backend is currently offline. Restoring integrations from server was skipped."
          );
        } else {
          vscode.window.showInformationMessage(
            `Synchronized ${result.restored}/${result.total} MCP integrations from your account.`
          );
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
      }
    })
  );

  return disposables;
}
