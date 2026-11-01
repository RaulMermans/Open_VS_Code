/**
 * Sprint 9C — Advanced Design & Motion Capability Pack Manifest Tests
 * Verifies manifest schema conformance, digest integrity, custom mode profile,
 * and dependency resolution against the authoritative Capability Pack system.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADVANCED_DESIGN_MOTION_PACK,
  ADVANCED_DESIGN_MOTION_MODE_PROFILE,
} from "../../src/design/starter-pack.ts";
import {
  validateCapabilityPackManifest,
  computeManifestDigest,
} from "../../src/packs/validation.ts";
import { resolveCapabilityPack } from "../../src/packs/resolver.ts";
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../../src/skills/registry.ts";

describe("Sprint 9C — Advanced Design & Motion Starter Pack", () => {
  it("1. ADVANCED_DESIGN_MOTION_PACK conforms to CapabilityPackManifest schema", () => {
    const validation = validateCapabilityPackManifest(ADVANCED_DESIGN_MOTION_PACK);
    assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join(", ")}`);
    assert.equal(ADVANCED_DESIGN_MOTION_PACK.id, "advanced-design-motion-pack");
    assert.equal(ADVANCED_DESIGN_MOTION_PACK.schemaVersion, 1);
    assert.equal(ADVANCED_DESIGN_MOTION_PACK.version, "1.0.0");
    assert.equal(ADVANCED_DESIGN_MOTION_PACK.license, "MIT");
  });

  it("2. Manifest integrity digest matches computed sha256 digest", () => {
    const { integrity: _, ...rest } = ADVANCED_DESIGN_MOTION_PACK;
    const computed = computeManifestDigest(rest);
    assert.equal(ADVANCED_DESIGN_MOTION_PACK.integrity.algorithm, "sha256");
    assert.equal(ADVANCED_DESIGN_MOTION_PACK.integrity.digest, computed);
  });

  it("3. Custom mode profile conforms to CustomModeProfile specification", () => {
    assert.equal(ADVANCED_DESIGN_MOTION_MODE_PROFILE.id, "advanced-design-motion");
    assert.equal(ADVANCED_DESIGN_MOTION_MODE_PROFILE.baseMode, "BUILD");
    assert.equal(ADVANCED_DESIGN_MOTION_MODE_PROFILE.source, "builtin");
    assert.equal(ADVANCED_DESIGN_MOTION_MODE_PROFILE.enabled, true);
    assert.ok(ADVANCED_DESIGN_MOTION_MODE_PROFILE.requiredSkills.includes("design-direction"));
    assert.ok(ADVANCED_DESIGN_MOTION_MODE_PROFILE.requiredSkills.includes("motion-engineering"));
    assert.ok(ADVANCED_DESIGN_MOTION_MODE_PROFILE.requiredSkills.includes("visual-qa"));
  });

  it("4. Resolves capability pack against SkillRegistry and confirms READY readiness", async () => {
    const builtinRoot = defaultBuiltinSkillsRoot();
    assert.ok(builtinRoot, "Default builtin skills root must be defined");
    const registry = await SkillRegistry.discover({
      builtinRoot,
      workspaceTrusted: true,
    });
    const resolved = resolveCapabilityPack({
      pack: ADVANCED_DESIGN_MOTION_PACK,
      workspaceTrusted: true,
      availableSkills: registry.entries.map((s) => ({ id: s.id, name: s.name })),
      availableMcpServers: [],
      availableTools: [
        "browser_open",
        "browser_navigate",
        "browser_snapshot",
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
      currentOpenVsCodeVersion: "0.1.0",
    });

    assert.equal(resolved.packId, "advanced-design-motion-pack");
    assert.equal(resolved.status, "READY");
    assert.equal(resolved.isReady, true);
    assert.equal(resolved.missingSkills.length, 0);
  });

  it("5. Correctly attributes upstream open-source projects", () => {
    const attr = ADVANCED_DESIGN_MOTION_PACK.attribution ?? "";
    assert.ok(attr.includes("Impeccable"));
    assert.ok(attr.includes("Anthropic Frontend Design"));
    assert.ok(attr.includes("UI UX Pro Max"));
    assert.ok(attr.includes("Vercel Agent Skills"));
    assert.ok(attr.includes("Motion"));
  });
});
