/**
 * Sprint 25: the primary objective decides the task profile. Mentions of AGENTS.md, rules or files to read
 * do not turn an implementation request into a rules question, and files named only for reading are not
 * required edits. Prompts are realistic multi-paragraph briefs, not the HALO VC-02 wording.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { classifyTaskProfile, isMultiPartRequest } from "../../src/agent/task-profile.ts"
import { requiredEditPaths } from "../../src/agent/tool-contract.ts"

const featureBrief = `# Billing export — CSV download

## Context

Read AGENTS.md, CONTRIBUTING.md and docs/billing.md before changing anything. Follow the repository conventions.

## Requirements

- Add a CSV export endpoint to the invoices service.
- Reuse the existing invoice serializer; do not duplicate field formatting.
- Add tests for empty, single and multi-currency exports.

## Constraints

Do not change the database schema. Do not push or deploy.

## Deliverables

Write docs/billing-export.md describing the endpoint.`

const required = (instruction: string) => requiredEditPaths(instruction, classifyTaskProfile(instruction, "BUILD").explicitFilePaths)

test("a multi-section feature brief that mentions AGENTS.md is an implementation task, not a rules question", () => {
  const profile = classifyTaskProfile(featureBrief, "BUILD")
  assert.equal(profile.category, "IMPLEMENTATION")
  assert.equal(profile.requiresCodeChange, true)
  assert.ok(profile.allowedTools.includes("list_directory"))
  assert.match(profile.toolGuidance, /locate the code each requirement concerns/)
})

test("files the brief says to read are context; the deliverable it names is still required", () => {
  assert.deepEqual(required(featureBrief), ["docs/billing-export.md"])
})

test("an implementation request that only says to follow AGENTS.md is not RULES_QUERY", () => {
  const instruction = "Following the conventions in AGENTS.md, fix src/date.ts so formatDate pads single-digit months, and add a regression test."
  const profile = classifyTaskProfile(instruction, "BUILD")
  assert.notEqual(profile.category, "RULES_QUERY")
  assert.equal(profile.requiresCodeChange, true)
  assert.ok(required(instruction).includes("src/date.ts"))
})

test("a question about the rules is still RULES_QUERY", () => {
  assert.equal(classifyTaskProfile("What are the testing rules in AGENTS.md?", "ASK").category, "RULES_QUERY")
  assert.equal(classifyTaskProfile("Read AGENTS.md and summarize the commit conventions.", "BUILD").category, "RULES_QUERY")
})

test("a request to update the rules document keeps that document as the edit target", () => {
  const instruction = "Update AGENTS.md to document the new pnpm test:unit command in the Testing section."
  assert.deepEqual(required(instruction), ["AGENTS.md"])
  assert.notEqual(classifyTaskProfile(instruction, "BUILD").category, "RULES_QUERY")
})

test("read one file, change another: only the changed file is required", () => {
  assert.deepEqual(required("Read src/util.ts, then update src/app.ts to call slugify from it."), ["src/app.ts"])
})

test("read then fix the same file: the file stays required", () => {
  assert.deepEqual(required("Read src/a.ts. Fix the off-by-one in its loop."), ["src/a.ts"])
})

test("a path named after an edit verb inside a reading clause stays required", () => {
  assert.deepEqual(required("Review src/parse.ts and update src/parse.ts so empty input returns []."), ["src/parse.ts"])
})

test("a short failing-test repair request is not routed to the multi-part profile", () => {
  const instruction = "The test in test/cart.test.ts fails since yesterday: totals are off by one cent for discounted items.\n\nFind the cause in src/cart.ts and fix it. Do not change the test."
  const profile = classifyTaskProfile(instruction, "BUILD")
  assert.notEqual(profile.category, "IMPLEMENTATION")
  assert.equal(profile.requiresCodeChange, true)
  assert.deepEqual(required(instruction), ["src/cart.ts"])
})

test("multi-part detection: headed sections or a long list of requirements", () => {
  assert.equal(isMultiPartRequest(featureBrief), true)
  assert.equal(isMultiPartRequest("Fix the bug in src/a.ts."), false)
  const longList = `Please make the following changes to the reporting module. ${"Context sentence. ".repeat(80)}\n${Array.from({ length: 6 }, (_, index) => `${index + 1}. Requirement number ${index + 1}.`).join("\n")}`
  assert.equal(isMultiPartRequest(longList), true)
  assert.equal(isMultiPartRequest("## One heading\nFix src/a.ts.\n## Two\nThanks."), false)
})

test("a read-only investigation of a multi-section brief is not an implementation task", () => {
  assert.notEqual(classifyTaskProfile(featureBrief, "ASK").category, "IMPLEMENTATION")
})
