/**
 * Sprint 9D — REA Standalone Custom Mode Profiles.
 */

import type { CustomModeProfile } from "../modes/contracts.ts";

export const REA_INVESTIGATION_MODE_PROFILE: CustomModeProfile = Object.freeze({
  id: "rea-investigation",
  name: "REA Investigation",
  description: "Read-only software investigation mode for exploring running web apps, ASAR packages, and native binaries to produce evidence and specifications.",
  icon: "search",
  version: 1,
  schemaVersion: 1,
  source: "builtin",
  baseMode: "REVIEW",
  customInstructions:
    "Investigate authorized software targets systematically using REA methodology. Record concrete observations, distinguish inferences from facts, map state transitions, and catalog unknowns without mutating the workspace.",
  requiredSkills: [
    "rea-investigation-routing",
    "browser-behavior-investigation",
    "javascript-electron-analysis",
    "native-artifact-analysis",
    "feature-specification",
    "evidence-reconciliation",
  ],
  optionalSkills: [],
  requiredMcpServers: [],
  optionalMcpServers: ["rea"],
  toolAllowlist: [
    "read_file",
    "list_directory",
    "search_text",
    "find_files",
    "browser_open",
    "browser_navigate",
    "browser_snapshot",
    "browser_screenshot",
    "browser_close",
  ],
  workflowPreference: "direct",
  scope: "builtin",
  enabled: true,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
});

export const REA_RECONSTRUCTION_MODE_PROFILE: CustomModeProfile = Object.freeze({
  id: "rea-reconstruction",
  name: "REA Reconstruction",
  description: "Governed clean-room implementation mode for building independent functionality, executing verification tests, and closing reconstruction obligations.",
  icon: "tools",
  version: 1,
  schemaVersion: 1,
  source: "builtin",
  baseMode: "BUILD",
  customInstructions:
    "Implement independent clean-room functionality based on approved investigation specifications. Execute test suites, verify obligations with evidence, and preserve permission gates.",
  requiredSkills: [
    "reconstruction-planning",
    "reconstruction-verification",
    "feature-specification",
    "evidence-reconciliation",
  ],
  optionalSkills: [],
  requiredMcpServers: [],
  optionalMcpServers: ["rea"],
  toolAllowlist: [
    "read_file",
    "list_directory",
    "search_text",
    "find_files",
    "apply_patch",
    "create_file",
    "run_verification",
    "browser_open",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_fill",
    "browser_screenshot",
    "browser_close",
  ],
  workflowPreference: "direct",
  scope: "builtin",
  enabled: true,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
});
