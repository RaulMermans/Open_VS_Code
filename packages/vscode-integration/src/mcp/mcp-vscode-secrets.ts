import type { SecretProvider } from "@open-vs-code/agent-core";
import type * as vscode from "vscode";

/**
 * SecretProvider implementation bridging VS Code SecretStorage
 * to the agent-core MCP authentication layer.
 */
export class VsCodeSecretProvider implements SecretProvider {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getSecret(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}
