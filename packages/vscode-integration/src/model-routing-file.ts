import { statSync } from "node:fs"
import { join } from "node:path"
import { loadRoutingConfigSync, type RoutingConfiguration } from "@open-vs-code/agent-core"

/** True when the workspace routing file exists. The file contents are not read. */
export function workspaceRoutingFilePresent(workspaceRoot: string): boolean {
  try {
    return statSync(join(workspaceRoot, ".open-vs-code", "models.json")).isFile()
  } catch {
    return false
  }
}

/**
 * Parse `.open-vs-code/models.json` only for a trusted folder.
 * An untrusted folder reports presence from the directory entry and does not read the file.
 */
export function readWorkspaceRoutingOverride(workspaceRoot: string, trusted: boolean): {
  config: RoutingConfiguration | null
  invalid: boolean
  present: boolean
} {
  const present = workspaceRoutingFilePresent(workspaceRoot)
  if (trusted !== true) return { config: null, invalid: false, present }
  try {
    return { config: loadRoutingConfigSync(workspaceRoot), invalid: false, present }
  } catch {
    return { config: null, invalid: true, present: true }
  }
}
