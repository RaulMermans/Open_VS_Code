import assert from "node:assert/strict"
import test from "node:test"

import { selectSkills, type SkillSelectionInput } from "../../src/context/skill-selector.ts"
import type { SkillMetadata } from "../../src/context/skills.ts"

const catalog: SkillMetadata[] = [
  {
    id: "SCAFFOLD_APP",
    title: "Scaffold App",
    summary: "Create the initial structure of an application.",
    modes: ["PLAN", "BUILD"],
    tags: ["init", "scaffold", "setup"],
    triggers: ["scaffold a new app", "initialize project"],
    path: "SCAFFOLD_APP/SKILL.md",
    estimatedTokens: 100,
  },
  {
    id: "ADD_FEATURE_WITH_TESTS",
    title: "Add Feature With Tests",
    summary: "Add a new feature and tests.",
    modes: ["BUILD"],
    tags: ["feature", "tests"],
    path: "ADD_FEATURE_WITH_TESTS/SKILL.md",
    estimatedTokens: 150,
  },
  {
    id: "BUG_TRIAGE_LOOP",
    title: "Bug Triage Loop",
    summary: "Diagnose a defect using evidence.",
    modes: ["DEBUG"],
    tags: ["debugging", "regression", "diagnosis", "crash", "null"],
    triggers: ["fix crash", "diagnose bug"],
    path: "BUG_TRIAGE_LOOP/SKILL.md",
    estimatedTokens: 200,
  },
  {
    id: "REFACTOR_WITH_GUARDS",
    title: "Refactor With Guards",
    summary: "Improve code structure without altering behavior.",
    modes: ["BUILD", "DEBUG"],
    tags: ["refactor", "cleanup"],
    path: "REFACTOR_WITH_GUARDS/SKILL.md",
    estimatedTokens: 180,
  },
  {
    id: "SECURITY_HARDENING_PASS",
    title: "Security Hardening Pass",
    summary: "Review for vulnerabilities like path traversal.",
    modes: ["REVIEW"],
    tags: ["security", "audit", "path traversal", "leakage"],
    path: "SECURITY_HARDENING_PASS/SKILL.md",
    estimatedTokens: 120,
  },
  {
    id: "ARCH_REVIEW_PASS",
    title: "Architecture Review Pass",
    summary: "Inspect architecture.",
    modes: ["REVIEW", "PLAN"],
    tags: ["architecture", "structure", "coupling", "restructuring"],
    path: "ARCH_REVIEW_PASS/SKILL.md",
    estimatedTokens: 130,
  },
  {
    id: "LOCAL_RELEASE_RUNBOOK",
    title: "Local Release Runbook",
    summary: "Plan local release.",
    modes: ["PLAN"],
    tags: ["release", "desktop"],
    triggers: ["prepare local release"],
    path: "LOCAL_RELEASE_RUNBOOK/SKILL.md",
    estimatedTokens: 90,
  },
  {
    id: "MCP_TOOL_CONTRACT",
    title: "MCP Tool Contract",
    summary: "Define an MCP tool.",
    modes: ["PLAN"],
    tags: ["mcp", "tool"],
    path: "MCP_TOOL_CONTRACT/SKILL.md",
    estimatedTokens: 110,
  },
]

const testCases = [
  // 1-3. BUG_TRIAGE_LOOP
  { task: "Fix crash when parser receives null config", mode: "DEBUG", expectedPrimary: "BUG_TRIAGE_LOOP", forbidden: ["SCAFFOLD_APP"] },
  { task: "Diagnose why the build is failing", mode: "DEBUG", expectedPrimary: "BUG_TRIAGE_LOOP" },
  { task: "Investigate regression in authentication", mode: "DEBUG", expectedPrimary: "BUG_TRIAGE_LOOP" },

  // 4-6. ADD_FEATURE_WITH_TESTS
  { task: "Add export-to-CSV with regression tests", mode: "BUILD", expectedPrimary: "ADD_FEATURE_WITH_TESTS" },
  { task: "Implement user login feature", mode: "BUILD", expectedPrimary: "ADD_FEATURE_WITH_TESTS" },
  { task: "Create a new API endpoint for products", mode: "BUILD", expectedPrimary: "ADD_FEATURE_WITH_TESTS" },

  // 7-9. REFACTOR_WITH_GUARDS
  { task: "Replace internal cache implementation without behavior changes", mode: "BUILD", expectedPrimary: "REFACTOR_WITH_GUARDS" },
  { task: "Refactor the database module to be cleaner", mode: "BUILD", expectedPrimary: "REFACTOR_WITH_GUARDS" },
  { task: "Clean up messy code in the parser", mode: "BUILD", expectedPrimary: "REFACTOR_WITH_GUARDS" },

  // 10-12. SECURITY_HARDENING_PASS
  { task: "Review authentication boundary for path traversal and secret leakage", mode: "REVIEW", expectedPrimary: "SECURITY_HARDENING_PASS", expectedSupporting: "ARCH_REVIEW_PASS" },
  { task: "Audit the codebase for security issues", mode: "REVIEW", expectedPrimary: "SECURITY_HARDENING_PASS" },
  { task: "Check if there is any secret leakage in logs", mode: "REVIEW", expectedPrimary: "SECURITY_HARDENING_PASS" },

  // 13-15. ARCH_REVIEW_PASS
  { task: "Review the architecture and check for tight coupling", mode: "REVIEW", expectedPrimary: "ARCH_REVIEW_PASS" },
  { task: "Plan a restructuring of the core components", mode: "PLAN", expectedPrimary: "ARCH_REVIEW_PASS" },
  { task: "Inspect the structure for maintainability", mode: "REVIEW", expectedPrimary: "ARCH_REVIEW_PASS" },

  // 16-18. LOCAL_RELEASE_RUNBOOK
  { task: "Prepare this CLI for a local desktop release and rollback plan", mode: "PLAN", expectedPrimary: "LOCAL_RELEASE_RUNBOOK" },
  { task: "Document how to release the desktop app", mode: "PLAN", expectedPrimary: "LOCAL_RELEASE_RUNBOOK" },
  { task: "Prepare local release instructions", mode: "PLAN", expectedPrimary: "LOCAL_RELEASE_RUNBOOK" },

  // 19-21. MCP_TOOL_CONTRACT
  { task: "Define a future MCP tool that searches tickets but has no write access", mode: "PLAN", expectedPrimary: "MCP_TOOL_CONTRACT" },
  { task: "Design a new MCP tool for reading logs", mode: "PLAN", expectedPrimary: "MCP_TOOL_CONTRACT" },
  { task: "Plan an MCP tool contract for the database", mode: "PLAN", expectedPrimary: "MCP_TOOL_CONTRACT" },

  // 22-23. SCAFFOLD_APP
  { task: "Scaffold a new app using React", mode: "PLAN", expectedPrimary: "SCAFFOLD_APP" },
  { task: "Initialize project structure", mode: "BUILD", expectedPrimary: "SCAFFOLD_APP" },

  // 24. No-skill ASK
  { task: "What does this variable mean?", mode: "ASK", expectedNoSkill: true },
]

test("SkillSelector deterministic evaluation corpus", () => {
  for (const tc of testCases) {
    const input: SkillSelectionInput = {
      task: tc.task,
      mode: tc.mode,
      catalog,
      budgetTokens: 500
    }
    const result = selectSkills(input)
    
    if (tc.expectedNoSkill) {
      assert.equal(result.primarySkill, undefined, `Expected no primary skill for: ${tc.task}`)
    } else {
      assert.ok(result.primarySkill, `Expected primary skill for: ${tc.task}`)
      assert.equal(result.primarySkill.metadata.id, tc.expectedPrimary, `Expected primary ${tc.expectedPrimary} for: ${tc.task}`)
    }

    if (tc.forbidden) {
       for (const f of tc.forbidden) {
          assert.notEqual(result.primarySkill?.metadata.id, f)
          assert.equal(result.supportingSkills.some(s => s.metadata.id === f), false)
       }
    }

    if (tc.expectedSupporting) {
       assert.ok(result.supportingSkills.some(s => s.metadata.id === tc.expectedSupporting), `Expected supporting ${tc.expectedSupporting} for: ${tc.task}`)
    }
  }
})

test("SkillSelector enforces budget token limits strictly", () => {
   const input: SkillSelectionInput = {
      task: "Fix crash and also refactor",
      mode: "DEBUG",
      catalog,
      budgetTokens: 250 // Not enough for both full skills
   }
   const result = selectSkills(input)
   assert.ok(result.estimatedSkillTokens <= 250)
   assert.ok(result.skillsDroppedForBudget > 0 || result.primarySkill?.sections.length! < 8) // Should drop something or reduce sections
})

