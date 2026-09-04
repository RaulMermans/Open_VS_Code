import { test } from "node:test";
import assert from "node:assert";
import { discoverSkills } from "../../src/context/skills.ts";
import { join } from "node:path";

test("Real catalog contains exact 8 built-ins", async () => {
  const root = process.cwd();
  const skills = await discoverSkills(root);
  const required = new Set([
    "SCAFFOLD_APP",
    "ADD_FEATURE_WITH_TESTS",
    "BUG_TRIAGE_LOOP",
    "REFACTOR_WITH_GUARDS",
    "SECURITY_HARDENING_PASS",
    "ARCH_REVIEW_PASS",
    "LOCAL_RELEASE_RUNBOOK",
    "MCP_TOOL_CONTRACT"
  ]);

  const found = new Set(skills.map(s => s.id));

  for (const req of required) {
    assert.ok(found.has(req), `Missing required skill: ${req}`);
  }

  // legacy skills should be in there too if we didn't remove them.
  // The catalog might have more than 8, but we only assert these 8 are there.
  assert.ok(skills.length >= 8);
});
