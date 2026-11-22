/**
 * Why a model configuration tab appears.
 *
 * The extension opens `.open-vs-code/models.json` only for the explicit
 * "Open Model Configuration" command. Creating a starter file used to call
 * showTextDocument immediately afterward. VS Code session restore then
 * reopened that tab on the next launch. That restore path belongs to the
 * editor, not to this extension: legitimate tabs are left alone.
 */
export type ModelConfigOpenReason = "explicit-command" | "starter-created" | "session-restore"

export function shouldShowModelConfiguration(reason: ModelConfigOpenReason): boolean {
  return reason === "explicit-command"
}
