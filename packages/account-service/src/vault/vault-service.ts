import type { VaultService } from "../types.js";
import { VaultNotConfiguredError } from "../errors.js";

/**
 * Disabled vault implementation for environments without server-side encryption keys
 */
export class DisabledVaultService implements VaultService {
  isConfigured(): boolean {
    return false;
  }

  async encrypt(): Promise<string> {
    throw new VaultNotConfiguredError(
      "Server-side credential vault is disabled. Credentials must be managed client-side in VS Code SecretStorage."
    );
  }

  async decrypt(): Promise<string> {
    throw new VaultNotConfiguredError(
      "Server-side credential vault is disabled. Credentials must be managed client-side in VS Code SecretStorage."
    );
  }
}
