import type { CustomModeProfile } from "./contracts.ts";

export const STARTER_MODE_PROFILES: readonly CustomModeProfile[] = Object.freeze([
  {
    id: "architecture-review",
    name: "Architecture Review",
    description: "Repository reading, search, and architectural analysis without mutation authority.",
    icon: "organization",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "REVIEW",
    customInstructions:
      "Focus strictly on architectural analysis, component boundaries, dependency structures, and design principles. Do not attempt file modifications, deletions, or destructive actions.",
    requiredSkills: [],
    optionalSkills: ["repo-intake", "upstream-audit"],
    requiredMcpServers: [],
    optionalMcpServers: [],
    toolAllowlist: ["read_file", "list_directory", "search_text", "find_files", "read_repository", "search_repository", "read_markdown", "mcp_external_read"],
    workflowPreference: "direct",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  },
  {
    id: "reverse-engineering-analysis",
    name: "Reverse Engineering — Analysis",
    description:
      "Inspect local structure, analyze architecture and configuration, explore dependencies, and produce an evidence-backed reconstruction plan.",
    icon: "search",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "PLAN",
    customInstructions:
      "Inspect authorized local repository files, configuration, and dependencies. Produce an evidence-backed reconstruction plan. Do not copy proprietary code and do not assume external browser automation or replication capabilities exist.",
    requiredSkills: [],
    optionalSkills: ["repo-intake"],
    requiredMcpServers: [],
    optionalMcpServers: [],
    toolAllowlist: ["read_file", "list_directory", "search_text", "find_files", "read_repository", "search_repository", "read_markdown", "mcp_external_read"],
    workflowPreference: "direct",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  },
  {
    id: "design-exploration",
    name: "Design Exploration",
    description:
      "Inspect application UI files, analyze component structures, and propose design changes within read-only planning limits.",
    icon: "paintcan",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "PLAN",
    customInstructions:
      "Inspect existing application structure, UI files, and design system tokens. Formulate layout, component structure, and design proposals. Stay within read-only planning boundaries. Do not assume Figma or Playwright integrations are present unless explicitly configured and connected.",
    requiredSkills: [],
    optionalSkills: ["react-components", "shadcn-ui"],
    requiredMcpServers: [],
    optionalMcpServers: [],
    toolAllowlist: ["read_file", "list_directory", "search_text", "find_files", "read_repository", "search_repository", "read_markdown", "mcp_external_read"],
    workflowPreference: "direct",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  },
  {
    id: "browser-qa-local-dev",
    name: "Browser QA — Local Development",
    description:
      "Inspect local development servers, analyze accessibility snapshots, examine console errors, and verify UI state within read-only inspection boundaries.",
    icon: "browser",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "PLAN",
    customInstructions:
      "Navigate to authorized local development URLs, inspect structured accessibility snapshots, capture screenshots, and examine console errors. Stay strictly within read-only inspection boundaries. Do not attempt unapproved form fills, clicks, or mutations.",
    requiredSkills: [],
    optionalSkills: [],
    requiredMcpServers: [],
    optionalMcpServers: [],
    toolAllowlist: [
      "browser_open",
      "browser_snapshot",
      "browser_screenshot",
      "browser_close",
      "read_file",
      "search_text",
    ],
    workflowPreference: "direct",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  },
  {
    id: "browser-qa-interactive-local-dev",
    name: "Browser QA — Interactive Local Development",
    description:
      "Execute interactive browser verification, fill permitted form inputs, click interactive controls, and test user flows with explicit confirmations.",
    icon: "browser",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "BUILD",
    customInstructions:
      "Execute governed interactive browser QA flows on authorized local development servers. Fill fields, click permitted interactive elements, and verify state changes under explicit user confirmation.",
    requiredSkills: [],
    optionalSkills: [],
    requiredMcpServers: [],
    optionalMcpServers: [],
    toolAllowlist: [
      "browser_open",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_screenshot",
      "browser_close",
      "read_file",
      "search_text",
    ],
    workflowPreference: "direct",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  },
]);

export function getStarterModeProfiles(): readonly CustomModeProfile[] {
  return STARTER_MODE_PROFILES;
}

export function findStarterModeProfile(id: string): CustomModeProfile | undefined {
  return STARTER_MODE_PROFILES.find((p) => p.id === id);
}
