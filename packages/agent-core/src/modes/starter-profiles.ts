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
    toolAllowlist: ["read_repository", "search_repository", "read_markdown", "mcp_external_read"],
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
    toolAllowlist: ["read_repository", "search_repository", "read_markdown", "mcp_external_read"],
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
    toolAllowlist: ["read_repository", "search_repository", "read_markdown", "mcp_external_read"],
    workflowPreference: "direct",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  },
]);

export function getStarterModeProfiles(): readonly CustomModeProfile[] {
  return STARTER_MODE_PROFILES;
}

export function findStarterModeProfile(id: string): CustomModeProfile | undefined {
  return STARTER_MODE_PROFILES.find((p) => p.id === id);
}
