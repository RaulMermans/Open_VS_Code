import type { CapabilityPackManifest } from "./contracts.ts";
import { computeManifestDigest } from "./validation.ts";

function createCanonicalManifest(draft: Omit<CapabilityPackManifest, "integrity">): CapabilityPackManifest {
  const digest = computeManifestDigest(draft);
  return Object.freeze({
    ...draft,
    integrity: Object.freeze({
      algorithm: "sha256",
      digest,
    }),
  });
}

export const REPOSITORY_ARCHITECTURE_REVIEW_PACK: CapabilityPackManifest = createCanonicalManifest({
  schemaVersion: 1,
  id: "repo-architecture-review",
  name: "Repository Architecture Review Pack",
  description: "Declarative pack combining read-only repository tools, architecture inspection guidance, and security-review skills.",
  version: "1.0.0",
  publisher: {
    id: "open-vs-code",
    name: "Open VS Code Team",
    url: "https://github.com/RaulMermans/Open_VS_Code",
    verified: true,
  },
  sourceRepository: {
    url: "https://github.com/RaulMermans/Open_VS_Code",
    commit: "f7cc1c88b6c70158e90d399f57624467af96099e",
    release: "v0.1.0",
  },
  license: "MIT",
  attribution: "Copyright (c) 2026 Open VS Code Contributors. Licensed under MIT.",
  openVsCodeVersion: "^0.1.0",
  customMode: {
    id: "architecture-review-pack-mode",
    name: "Architecture Review (Pack)",
    description: "Read-only architecture review mode bundled in the repository architecture review capability pack.",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "REVIEW",
    customInstructions: "Analyze codebase modularity, interface boundaries, and architectural conformance. Ground all findings with exact file paths and citations.",
    requiredSkills: ["security-review"],
    optionalSkills: [],
    requiredMcpServers: [],
    optionalMcpServers: [],
    toolAllowlist: ["read_file", "list_directory", "search_text", "find_files"],
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  },
  requiredSkills: ["security-review"],
  optionalSkills: [],
  requiredMcpServers: [],
  optionalMcpServers: [],
  preferredModel: {
    family: "qwen-2.5-coder",
    capabilities: ["chat", "code_review"],
  },
  workflowRequirements: {
    workflowPreference: "direct",
    requireCheckpoints: false,
  },
  evaluationRequirements: [
    {
      name: "no-mutations",
      type: "read_only",
      expectation: "Must strictly avoid any write or delete operations on repository files.",
    },
    {
      name: "grounded-citations",
      type: "tool_call",
      expectation: "Must cite specific files and lines discovered via search_text or read_file.",
    },
  ],
  permissionDeclarations: ["read_repository", "search_repository"],
  resourceConstraints: {
    maxMemoryMb: 512,
    timeoutSeconds: 300,
  },
  documentation: {
    summary: "Conducts deep architecture inspection without risking accidental file modifications or unauthorized external communication.",
    guidelines: "Recommended for pull request reviews, refactoring planning, and dependency boundary auditing.",
  },
});

export const MCP_RESEARCH_DEMO_PACK: CapabilityPackManifest = createCanonicalManifest({
  schemaVersion: 1,
  id: "mcp-research-demo",
  name: "MCP-Enabled Research Demonstration Pack",
  description: "Controlled demonstration pack requiring local MCP fixture server connectivity and permitted tool execution.",
  version: "1.0.0",
  publisher: {
    id: "open-vs-code",
    name: "Open VS Code Team",
    url: "https://github.com/RaulMermans/Open_VS_Code",
    verified: true,
  },
  sourceRepository: {
    url: "https://github.com/RaulMermans/Open_VS_Code",
    commit: "f7cc1c88b6c70158e90d399f57624467af96099e",
    release: "v0.1.0",
  },
  license: "MIT",
  attribution: "Copyright (c) 2026 Open VS Code Contributors. Licensed under MIT.",
  openVsCodeVersion: "^0.1.0",
  customMode: {
    id: "mcp-research-demo-mode",
    name: "MCP Research Demo (Pack)",
    description: "Read-only research mode requiring fixture_server MCP connectivity.",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "PLAN",
    customInstructions: "Research codebase patterns and query local MCP tools. Formulate plans without altering repository files.",
    requiredSkills: [],
    optionalSkills: [],
    requiredMcpServers: ["fixture_server"],
    optionalMcpServers: [],
    toolAllowlist: ["read_file", "list_directory", "search_text", "find_files", "echo", "mcp_fixture_server_echo"],
    scope: "builtin",
    enabled: true,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  },
  requiredSkills: [],
  optionalSkills: [],
  requiredMcpServers: [
    {
      id: "fixture_server",
      name: "Local Test MCP Server",
      transport: "stdio",
    },
  ],
  optionalMcpServers: [],
  preferredModel: {
    family: "qwen-2.5-coder",
    capabilities: ["chat", "planning"],
  },
  workflowRequirements: {
    workflowPreference: "direct",
    requireCheckpoints: false,
  },
  evaluationRequirements: [
    {
      name: "mcp-connection-check",
      type: "permission_check",
      expectation: "Must verify fixture_server is connected before executing tasks.",
    },
  ],
  permissionDeclarations: ["read_repository", "search_repository", "mcp_external_read"],
  resourceConstraints: {
    maxMemoryMb: 512,
    timeoutSeconds: 180,
  },
  documentation: {
    summary: "Demonstrates governed MCP server connectivity and tool execution within a capability pack.",
    guidelines: "Requires the fixture_server MCP server to be registered and active.",
  },
});

export function getStarterCapabilityPacks(): readonly CapabilityPackManifest[] {
  return [REPOSITORY_ARCHITECTURE_REVIEW_PACK, MCP_RESEARCH_DEMO_PACK];
}
