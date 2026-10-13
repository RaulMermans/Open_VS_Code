import type { AgentMode } from "../../src/contracts/agent.ts"

/**
 * Sprint 5A deterministic skill-routing dataset. Frozen before selector tuning.
 *
 * `acceptable` lists every outcome counted as correct; `null` means "no skill". Unambiguous cases
 * have exactly one acceptable outcome. `tools: "readonly"` simulates an untrusted workspace where
 * mutation and verification tools are not registered.
 */
export interface SkillSelectionCase {
  readonly id: string
  readonly task: string
  readonly mode: AgentMode
  readonly acceptable: readonly (string | null)[]
  readonly kind: "positive" | "no-skill" | "ambiguous"
  readonly tools?: "full" | "readonly"
}

export const FULL_TOOLS = ["read_file", "list_directory", "find_files", "search_text", "apply_patch", "create_file", "run_verification"] as const
export const READONLY_TOOLS = ["read_file", "list_directory", "find_files", "search_text"] as const

export const SKILL_SELECTION_CASES: readonly SkillSelectionCase[] = [
  // bug-triage
  { id: "S01", task: "Tests fail after login refactor", mode: "DEBUG", acceptable: ["bug-triage"], kind: "positive" },
  { id: "S02", task: "The app crashes on startup when config.json is missing", mode: "DEBUG", acceptable: ["bug-triage"], kind: "positive" },
  { id: "S03", task: "Fix the TypeError thrown in parseDate when input is null", mode: "DEBUG", acceptable: ["bug-triage"], kind: "positive" },
  { id: "S04", task: "Users report the export button is broken since yesterday's release", mode: "BUILD", acceptable: ["bug-triage"], kind: "positive" },
  { id: "S05", task: "Find the root cause of the intermittent timeout in the upload worker", mode: "DEBUG", acceptable: ["bug-triage"], kind: "positive" },
  { id: "S06", task: "Regression: totals are off by one after the currency change", mode: "DEBUG", acceptable: ["bug-triage"], kind: "positive" },
  // tdd
  { id: "S07", task: "Add pagination using tests first", mode: "BUILD", acceptable: ["tdd"], kind: "positive" },
  { id: "S08", task: "Implement the slugify helper with TDD", mode: "BUILD", acceptable: ["tdd"], kind: "positive" },
  { id: "S09", task: "Write a failing test for the discount rule, then implement it", mode: "BUILD", acceptable: ["tdd"], kind: "positive" },
  { id: "S10", task: "Add rate limiting to the API, test-driven please", mode: "BUILD", acceptable: ["tdd"], kind: "positive" },
  // refactor-with-guards
  { id: "S11", task: "Clean up this module without changing behavior", mode: "BUILD", acceptable: ["refactor-with-guards"], kind: "positive" },
  { id: "S12", task: "Refactor the payment service into smaller functions", mode: "BUILD", acceptable: ["refactor-with-guards"], kind: "positive" },
  { id: "S13", task: "Extract the validation logic from the controller into its own module", mode: "BUILD", acceptable: ["refactor-with-guards"], kind: "positive" },
  { id: "S14", task: "Simplify the nested conditionals in router.ts while preserving behavior", mode: "BUILD", acceptable: ["refactor-with-guards"], kind: "positive" },
  // security-review
  { id: "S15", task: "Review this auth diff for vulnerabilities", mode: "REVIEW", acceptable: ["security-review"], kind: "positive" },
  { id: "S16", task: "Check the file upload handler for path traversal", mode: "REVIEW", acceptable: ["security-review"], kind: "positive" },
  { id: "S17", task: "Is the SQL query builder vulnerable to injection?", mode: "ASK", acceptable: ["security-review"], kind: "positive" },
  { id: "S18", task: "Audit how API credentials are stored in the config loader", mode: "REVIEW", acceptable: ["security-review"], kind: "positive" },
  // verification
  { id: "S19", task: "Check whether this change is ready", mode: "REVIEW", acceptable: ["verification"], kind: "positive" },
  { id: "S20", task: "Run the checks and tell me if this branch can be merged", mode: "REVIEW", acceptable: ["verification"], kind: "positive" },
  { id: "S21", task: "Verify the build and lint pass before I open the PR", mode: "REVIEW", acceptable: ["verification"], kind: "positive" },
  { id: "S22", task: "Is this ready to ship?", mode: "REVIEW", acceptable: ["verification"], kind: "positive" },
  // no skill needed
  { id: "S23", task: "What does the parseConfig function return?", mode: "ASK", acceptable: [null], kind: "no-skill" },
  { id: "S24", task: "Explain how the model router chooses a deployment", mode: "ASK", acceptable: [null], kind: "no-skill" },
  { id: "S25", task: "Rename the local variable idx to index", mode: "BUILD", acceptable: [null], kind: "no-skill" },
  { id: "S26", task: "Add a dark mode toggle to the settings page", mode: "BUILD", acceptable: [null], kind: "no-skill" },
  { id: "S27", task: "Update the README installation section", mode: "BUILD", acceptable: [null], kind: "no-skill" },
  { id: "S28", task: "Summarize the architecture of this repository", mode: "PLAN", acceptable: [null], kind: "no-skill" },
  { id: "S29", task: "Plan the migration from REST to GraphQL", mode: "PLAN", acceptable: [null], kind: "no-skill" },
  { id: "S30", task: "List all files that import the logger", mode: "ASK", acceptable: [null], kind: "no-skill" },
  { id: "S31", task: "Review this PR", mode: "REVIEW", acceptable: [null], kind: "no-skill" },
  // ambiguous / cross-cutting
  { id: "S32", task: "Review the login change for security issues and verify the tests pass", mode: "REVIEW", acceptable: ["security-review", "verification"], kind: "ambiguous" },
  { id: "S33", task: "Fix the failing test", mode: "DEBUG", acceptable: ["bug-triage"], kind: "ambiguous" },
  { id: "S34", task: "Refactor the parser; the tests currently fail", mode: "BUILD", acceptable: ["bug-triage", null], kind: "ambiguous" },
  { id: "S35", task: "Debug why the security token refresh fails", mode: "DEBUG", acceptable: ["bug-triage"], kind: "ambiguous" },
  { id: "S36", task: "Write tests for the date utils", mode: "BUILD", acceptable: ["tdd", null], kind: "ambiguous" },
  { id: "S37", task: "Make sure nothing is broken after the dependency upgrade", mode: "REVIEW", acceptable: ["verification", null], kind: "ambiguous" },
  { id: "S38", task: "Clean up the error handling in the auth middleware", mode: "BUILD", acceptable: ["refactor-with-guards", null], kind: "ambiguous" },
  { id: "S39", task: "skill:verification look over the repository", mode: "REVIEW", acceptable: ["verification"], kind: "ambiguous" },
  { id: "S40", task: "Add pagination using tests first", mode: "BUILD", acceptable: [null], kind: "ambiguous", tools: "readonly" },
]
