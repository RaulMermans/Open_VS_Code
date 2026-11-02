/**
 * Sprint 9D — REA Starter Capability Packs.
 *
 * Bifurcated into:
 * 1. REA Investigation Pack (REVIEW base mode, read-only tools, investigation skills).
 * 2. REA Reconstruction Pack (BUILD base mode, governed mutation tools, verification skills).
 */

import type { CapabilityPackManifest } from "../packs/contracts.ts";
import { computeManifestDigest } from "../packs/validation.ts";
import { REA_PINNED_VERSION, REA_PINNED_COMMIT } from "./contracts.ts";

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

export const REA_INVESTIGATION_PACK: CapabilityPackManifest = createCanonicalManifest({
  schemaVersion: 1,
  id: "rea-investigation-pack",
  name: "REA Software Investigation Pack",
  description: "Declarative capability pack for inspecting authorized software targets, discovering behavior, gathering evidence, and building specifications using Reverse Engineer Anything.",
  version: "1.0.0",
  publisher: {
    id: "open-vs-code",
    name: "Open VS Code Team",
    url: "https://github.com/RaulMermans/Open_VS_Code",
    verified: true,
  },
  sourceRepository: {
    url: "https://github.com/morluto/rea",
    commit: REA_PINNED_COMMIT,
    release: `v${REA_PINNED_VERSION}`,
  },
  license: "MIT",
  attribution: "Copyright (c) 2025-2026 morluto. Copyright (c) 2026 Open VS Code Contributors. Licensed under MIT.",
  openVsCodeVersion: "^0.1.0",
  customMode: {
    id: "rea-investigation-pack-mode",
    name: "REA Investigation",
    description: "Read-only software investigation mode for exploring running web apps, ASAR packages, and native binaries to produce evidence and specifications.",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "REVIEW",
    customInstructions: "Investigate authorized software targets systematically. Record concrete observations, distinguish inferences from facts, map state transitions, and catalog unknowns without mutating the workspace.",
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
    workflowPreference: "structured",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  },
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
  optionalMcpServers: [{ id: "rea", name: "Reverse Engineer Anything", transport: "stdio" }],
  preferredModel: {
    family: "qwen-2.5-coder",
    capabilities: ["chat", "code_review"],
  },
  workflowRequirements: {
    workflowPreference: "structured",
    requireCheckpoints: false,
  },
  evaluationRequirements: [
    {
      name: "read-only-investigation",
      type: "read_only",
      expectation: "Must strictly avoid any file mutation or uncontrolled target execution.",
    },
    {
      name: "epistemic-evidence-separation",
      type: "tool_call",
      expectation: "Must strictly distinguish OBSERVED facts from INFERRED hypotheses in evidence records.",
    },
  ],
  permissionDeclarations: ["browser_inspection", "read_repository", "search_repository"],
  resourceConstraints: {
    maxMemoryMb: 1024,
    timeoutSeconds: 300,
  },
  documentation: {
    summary: "Conducts deep software reverse engineering and functional investigation across web and binary targets.",
    guidelines: "Targets must be explicitly authorized. Requires operator-provisioned Chromium for web investigation.",
  },
});

export const REA_RECONSTRUCTION_PACK: CapabilityPackManifest = createCanonicalManifest({
  schemaVersion: 1,
  id: "rea-reconstruction-pack",
  name: "REA Evidence-Driven Reconstruction Pack",
  description: "Declarative capability pack for clean-room implementation of investigated software systems grounded in reconstruction obligation ledgers.",
  version: "1.0.0",
  publisher: {
    id: "open-vs-code",
    name: "Open VS Code Team",
    url: "https://github.com/RaulMermans/Open_VS_Code",
    verified: true,
  },
  sourceRepository: {
    url: "https://github.com/morluto/rea",
    commit: REA_PINNED_COMMIT,
    release: `v${REA_PINNED_VERSION}`,
  },
  license: "MIT",
  attribution: "Copyright (c) 2025-2026 morluto. Copyright (c) 2026 Open VS Code Contributors. Licensed under MIT.",
  openVsCodeVersion: "^0.1.0",
  customMode: {
    id: "rea-reconstruction-pack-mode",
    name: "REA Reconstruction",
    description: "Governed clean-room implementation mode for building independent functionality, executing verification tests, and closing reconstruction obligations.",
    version: 1,
    schemaVersion: 1,
    source: "builtin",
    baseMode: "BUILD",
    customInstructions: "Implement independent clean-room functionality based on approved investigation specifications. Execute test suites, verify obligations with evidence, and preserve permission gates.",
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
    workflowPreference: "structured",
    scope: "builtin",
    enabled: true,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  },
  requiredSkills: [
    "reconstruction-planning",
    "reconstruction-verification",
    "feature-specification",
    "evidence-reconciliation",
  ],
  optionalSkills: [],
  requiredMcpServers: [],
  optionalMcpServers: [{ id: "rea", name: "Reverse Engineer Anything", transport: "stdio" }],
  preferredModel: {
    family: "qwen-2.5-coder",
    capabilities: ["chat", "code_generation"],
  },
  workflowRequirements: {
    workflowPreference: "structured",
    requireCheckpoints: true,
  },
  evaluationRequirements: [
    {
      name: "governed-mutations-only",
      type: "permission_check",
      expectation: "Must request user confirmation for all repository mutations.",
    },
    {
      name: "test-evidence-closure",
      type: "tool_call",
      expectation: "Must record passing test execution evidence before marking obligations verified.",
    },
  ],
  permissionDeclarations: [
    "browser_inspection",
    "browser_interaction",
    "read_repository",
    "search_repository",
    "write_file",
    "run_known_test",
  ],
  resourceConstraints: {
    maxMemoryMb: 2048,
    timeoutSeconds: 600,
  },
  documentation: {
    summary: "Reconstructs independent, test-verified software implementations from reverse engineering specifications.",
    guidelines: "Requires explicit user authorization before initiating any code implementation.",
  },
});
