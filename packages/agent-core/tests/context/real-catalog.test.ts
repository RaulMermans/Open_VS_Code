import { test } from "node:test";
import assert from "node:assert";
import { discoverSkills, loadSkill } from "../../src/context/skills.ts";
import { selectSkills } from "../../src/context/skill-selector.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("T-733: Real Catalog Required ID + Metadata Validation", async () => {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
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
    const skill = skills.find(s => s.id === req)!;
    assert.ok(skill.modes && skill.modes.length > 0, `Modes empty for ${req}`);
    assert.ok(skill.summary && skill.summary.trim().length > 0, `Summary empty for ${req}`);
    assert.strictEqual(skill.path.includes(req), true, `Path does not contain ID for ${req}`);
    
    const loaded = await loadSkill(root, skill);
    assert.ok(loaded.body.includes("# Intent"), `Missing # Intent in ${req}`);
  }
});

test("T-731 & T-732: Real Catalog Case Matrix", async () => {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const catalog = await discoverSkills(root);
  const budgetTokens = 2000;

  const matrix = [
    { mode: "DEBUG", task: "Fix parser crash when config is null", expectedPrimary: "BUG_TRIAGE_LOOP" },
    { mode: "BUILD", task: "Add CSV export with regression tests", expectedPrimary: "ADD_FEATURE_WITH_TESTS" },
    { mode: "BUILD", task: "Refactor the cache implementation without changing behavior", expectedPrimary: "REFACTOR_WITH_GUARDS" },
    { mode: "REVIEW", task: "Review path handling for traversal and secret leakage", expectedPrimary: "SECURITY_HARDENING_PASS" },
    { mode: "PLAN", task: "Review architecture for duplicated state ownership and coupling", expectedPrimary: "ARCH_REVIEW_PASS" },
    { mode: "PLAN", task: "Prepare the CLI for a local release, upgrade and rollback", expectedPrimary: "LOCAL_RELEASE_RUNBOOK" },
    { mode: "PLAN", task: "Define the contract for a future read-only MCP search tool", expectedPrimary: "MCP_TOOL_CONTRACT" },
    { mode: "BUILD", task: "Create the initial app skeleton using the current project stack", expectedPrimary: "SCAFFOLD_APP" },
    { mode: "BUILD", task: "Rename local variable idx to index", expectedPrimary: undefined },
    { mode: "PLAN", task: "Write a short summary", expectedPrimary: undefined },
    { mode: "DEBUG", task: "Log a message", expectedPrimary: undefined },
    { mode: "REVIEW", task: "Does it look okay?", expectedPrimary: undefined },
  ];

  for (const tc of matrix) {
    const result = selectSkills({ task: tc.task, mode: tc.mode, catalog, budgetTokens });
    if (tc.expectedPrimary) {
      assert.ok(result.primarySkill, `Expected primary skill ${tc.expectedPrimary} for task '${tc.task}', got ${result.primarySkill?.metadata?.id}`);
      assert.strictEqual(result.primarySkill.metadata.id, tc.expectedPrimary, `Expected ${tc.expectedPrimary} but got ${result.primarySkill.metadata.id} for task '${tc.task}'`);
      assert.ok(result.primarySkill.reason.length > 0, "Selection reason should be populated");
    } else {
      assert.ok(!result.primarySkill, `Expected no primary skill for task '${tc.task}', but got ${result.primarySkill?.metadata.id}`);
    }
  }

  const legacyResult = selectSkills({ task: "Map an unfamiliar software repository", mode: "PLAN", catalog, budgetTokens });
  assert.ok(!legacyResult.primarySkill || legacyResult.primarySkill.metadata.id !== "repo-intake", "Legacy skill should not be auto-selected");
  
  const mismatchResult = selectSkills({ task: "Fix parser crash when config is null", mode: "PLAN", catalog, budgetTokens });
  assert.ok(!mismatchResult.primarySkill || mismatchResult.primarySkill.metadata.id !== "BUG_TRIAGE_LOOP", "BUG_TRIAGE_LOOP should not match PLAN mode");
});

import { compileContext } from "../../src/context/compiler.ts";

test("T-740: End-to-End Section Loading Proof", async () => {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const catalog = await discoverSkills(root);
  const bugTriage = catalog.find(s => s.id === "BUG_TRIAGE_LOOP")!;
  assert.ok(bugTriage, "BUG_TRIAGE_LOOP should exist");

  const loaded = await loadSkill(root, bugTriage, { sections: ["Intent", "When", "Procedure"] });
  
  const compiled = compileContext({
    task: "Fix crash",
    projectInstructions: [],
    selectedSkills: [loaded],
    budget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500, availableContext: 6500 }
  });

  const skillItem = compiled.items.find(i => i.id === "skill:BUG_TRIAGE_LOOP");
  assert.ok(skillItem, "Skill item should be in context");

  const content = skillItem.content;
  assert.ok(content.includes("# Intent"), "Intent should be present");
  assert.ok(content.includes("# When"), "When should be present");
  assert.ok(content.includes("# Procedure"), "Procedure should be present");
  assert.ok(!content.includes("# Failure Modes"), "Failure Modes should be absent");
  assert.ok(!content.includes("# Recovery Prompts"), "Recovery Prompts should be absent");
  
  // T-739 Check metadata
  assert.deepEqual(skillItem.metadata?.sections, ["Intent", "When", "Procedure"]);
});

test("T-741 & T-742: Budget Degradation E2E", async () => {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const catalog = await discoverSkills(root);
  
  const budgetTokens = 300; 
  
  const result = selectSkills({ task: "Fix the parser crash and refactor the architecture", mode: "DEBUG", catalog, budgetTokens });
  
  let actualSkillTokens = 0;
  const loadedSkills = [];
  if (result.primarySkill) {
     const loaded = await loadSkill(root, result.primarySkill.metadata, { sections: result.primarySkill.sections });
     actualSkillTokens += compileContext({ task: "x", projectInstructions: [], budget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500, availableContext: 6500 }, selectedSkills: [loaded] }).items.find(i=>i.source.kind === "skill")!.estimatedTokens;
     loadedSkills.push(loaded);
  }
  for (const s of result.supportingSkills) {
     const loaded = await loadSkill(root, s.metadata, { sections: s.sections });
     actualSkillTokens += compileContext({ task: "x", projectInstructions: [], budget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500, availableContext: 6500 }, selectedSkills: [loaded] }).items.find(i=>i.source.kind === "skill")!.estimatedTokens;
     loadedSkills.push(loaded);
  }
  
  assert.ok(actualSkillTokens <= budgetTokens, `Actual compiled tokens ${actualSkillTokens} should be <= budget ${budgetTokens}`);
  assert.ok(result.skillsDroppedForBudget > 0 || actualSkillTokens < budgetTokens, "Should drop skills or sections");
});

test("T-744: Legacy Skill Real-Catalog Proof", async () => {
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const catalog = await discoverSkills(root);
  const budgetTokens = 2000;

  const legacyIds = ["repo-intake", "upstream-audit", "change-with-tests"];
  for (const legacyId of legacyIds) {
    const autoResult = selectSkills({ task: "Do some generic work", mode: "PLAN", catalog, budgetTokens });
    assert.ok(!autoResult.primarySkill || autoResult.primarySkill.metadata.id !== legacyId, `Legacy skill ${legacyId} should not be auto-selected`);
    
    const explicitResult = selectSkills({ task: `Use ${legacyId} please`, mode: "PLAN", catalog, budgetTokens });
    assert.ok(
      (explicitResult.primarySkill && explicitResult.primarySkill.metadata.id === legacyId) ||
      explicitResult.supportingSkills.some(s => s.metadata.id === legacyId),
      `Legacy skill ${legacyId} should be explicitly selected`
    );
  }
});
