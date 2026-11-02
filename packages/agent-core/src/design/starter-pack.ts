/**
 * Sprint 9C — Advanced Design & Motion Capability Pack Manifest.
 * Conforms strictly to schema `open-vs-code/capability-pack@v1` and ADR-038.
 */

import type { CapabilityPackManifest } from "../packs/contracts.ts";
import { computeManifestDigest } from "../packs/validation.ts";
import type { CustomModeProfile } from "../modes/contracts.ts";

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

export const ADVANCED_DESIGN_MOTION_MODE_PROFILE: CustomModeProfile = Object.freeze({
  id: "advanced-design-motion",
  name: "Advanced Design & Motion",
  description:
    "Specialized frontend design, design system engineering, purposeful motion tuning, and browser-verified visual QA evaluation.",
  icon: "paintcan",
  version: 1,
  schemaVersion: 1,
  source: "builtin",
  baseMode: "BUILD",
  customInstructions:
    "Execute the 5-stage shape-before-build design workflow. Define distinct design direction from the brief, formalize tokens, compose accessible frontend components, implement hardware-accelerated motion with reduced-motion support, and verify rendered output through Playwright browser observations.",
  requiredSkills: [
    "design-direction",
    "design-system-engineering",
    "frontend-composition",
    "motion-engineering",
    "visual-qa",
  ],
  optionalSkills: [
    "ux-information-architecture",
    "accessibility-review",
    "design-polish",
  ],
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
    "list_directory",
    "search_text",
    "find_files",
    "apply_patch",
    "create_file",
    "run_verification",
  ],
  workflowPreference: "structured",
  scope: "builtin",
  enabled: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

export const ADVANCED_DESIGN_MOTION_PACK: CapabilityPackManifest = createCanonicalManifest({
  schemaVersion: 1,
  id: "advanced-design-motion-pack",
  name: "Advanced Design & Motion Capability Pack",
  description:
    "Declarative capability pack orchestrating design brief interpretation, design tokens, frontend composition, motion engineering, and browser-verified quality evaluation.",
  version: "1.0.0",
  publisher: {
    id: "open-vs-code",
    name: "Open VS Code Team",
    url: "https://github.com/RaulMermans/Open_VS_Code",
    verified: true,
  },
  sourceRepository: {
    url: "https://github.com/RaulMermans/Open_VS_Code",
    commit: "dfec7e473056ff9db724a14f432eedd60f7648cd",
    release: "v0.1.0",
  },
  license: "MIT",
  attribution:
    "Copyright (c) 2026 Open VS Code Contributors. Adapted with attribution from Impeccable (Apache-2.0), Anthropic Frontend Design (Apache-2.0), UI UX Pro Max (MIT), Vercel Agent Skills (Apache-2.0), and Motion (MIT).",
  openVsCodeVersion: "^0.1.0",
  customMode: ADVANCED_DESIGN_MOTION_MODE_PROFILE,
  requiredSkills: [
    "design-direction",
    "design-system-engineering",
    "frontend-composition",
    "motion-engineering",
    "visual-qa",
  ],
  optionalSkills: [
    "ux-information-architecture",
    "accessibility-review",
    "design-polish",
  ],
  requiredMcpServers: [],
  optionalMcpServers: [],
  preferredModel: {
    family: "qwen-2.5-coder",
    capabilities: ["chat", "code_generation"],
  },
  workflowRequirements: {
    workflowPreference: "structured",
    requireCheckpoints: false,
  },
  evaluationRequirements: [
    {
      name: "wcag-aa-compliance",
      type: "read_only",
      expectation: "Must satisfy WCAG AA contrast (>= 4.5:1), alt text, and keyboard focus standards.",
    },
    {
      name: "motion-quality-verified",
      type: "read_only",
      expectation:
        "Must verify 60 FPS frame rate, avoid layout thrashing, and provide reduced-motion alternatives.",
    },
    {
      name: "evidence-backed-qa-report",
      type: "tool_call",
      expectation: "Must cite captured screenshot diffs, accessibility refs, or computed styles.",
    },
  ],
  permissionDeclarations: [
    "browser_inspection",
    "browser_interaction",
    "browser_side_effect",
    "read_repository",
    "search_repository",
    "write_file",
    "run_known_test",
  ],
  resourceConstraints: {
    maxMemoryMb: 1024,
    timeoutSeconds: 300,
  },
  documentation: {
    summary:
      "Transforms the agent into a specialized frontend design and visual engineering system with repeatable browser-based evaluation.",
    guidelines:
      "Operates through the 5-stage shape-before-build design workflow. Requires local development server or fixture and provisioned Chromium browser.",
  },
});
