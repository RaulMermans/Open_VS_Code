/** Refuse a workspace configuration write until the user has trusted the folder. */
export function assertTrustedWorkspaceWrite(): void {
  const vscode = require("vscode") as { workspace?: { isTrusted?: boolean } }
  if (vscode.workspace?.isTrusted !== true) {
    throw new Error("This folder is not trusted. Workspace configuration was not written. Trust was not granted automatically.")
  }
}
