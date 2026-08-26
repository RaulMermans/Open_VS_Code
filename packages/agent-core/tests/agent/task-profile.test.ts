import test from "node:test"
import assert from "node:assert/strict"
import { classifyTaskProfile, extractExplicitFilePaths } from "../../src/agent/task-profile.ts"

test("extractExplicitFilePaths extracts valid paths and ignores excluded tokens", () => {
  const instruction = "Read README.md, AGENTS.md, src/auth.ts, and tests/build.test.ts while ignoring package.json and node_modules"
  const paths = extractExplicitFilePaths(instruction)
  assert.ok(paths.includes("README.md"))
  assert.ok(paths.includes("AGENTS.md"))
  assert.ok(paths.includes("src/auth.ts"))
  assert.ok(paths.includes("tests/build.test.ts"))
  assert.ok(!paths.includes("node_modules"))
})

test("classifyTaskProfile classifies RULES_QUERY tasks correctly", () => {
  const profile = classifyTaskProfile("Read AGENTS.md in markdown-project and state the Testing and Safety rules.")
  assert.equal(profile.category, "RULES_QUERY")
  assert.deepEqual(profile.allowedTools, ["read_file", "search_text", "find_files"])
  assert.equal(profile.defaultTurnBudget, 4)
  assert.ok(profile.explicitFilePaths.includes("AGENTS.md"))
})

test("classifyTaskProfile classifies FILE_DISCOVERY tasks correctly", () => {
  const profile = classifyTaskProfile("Find all TypeScript files in the src/ directory and list their paths.")
  assert.equal(profile.category, "FILE_DISCOVERY")
  assert.ok(profile.allowedTools.includes("find_files"))
})

test("classifyTaskProfile classifies TEST_DIAGNOSIS tasks correctly", () => {
  const profile = classifyTaskProfile("Inspect the test file in tests/ and implementation in src/ to diagnose why the test fails.")
  assert.equal(profile.category, "TEST_DIAGNOSIS")
  assert.equal(profile.defaultTurnBudget, 6)
})

test("classifyTaskProfile classifies DEPENDENCY_QUERY tasks correctly", () => {
  const profile = classifyTaskProfile("Read package.json in cli-tool-repo and list the dependencies and devDependencies.")
  assert.equal(profile.category, "DEPENDENCY_QUERY")
  assert.ok(profile.explicitFilePaths.includes("package.json"))
})

test("classifyTaskProfile classifies SYMBOL_SEARCH tasks correctly", () => {
  const profile = classifyTaskProfile("Find the definition of the function `authenticate` and identify what token value it accepts.")
  assert.equal(profile.category, "SYMBOL_SEARCH")
  assert.ok(profile.allowedTools.includes("search_text"))
})

test("classifyTaskProfile classifies CONFIG_DISCOVERY tasks correctly", () => {
  const profile = classifyTaskProfile("Find what port the application listens on by inspecting the configuration files.")
  assert.equal(profile.category, "CONFIG_DISCOVERY")
  assert.ok(profile.allowedTools.includes("search_text"))
  assert.ok(profile.allowedTools.includes("read_file"))
})

test("classifyTaskProfile classifies CROSS_FILE_REASONING tasks correctly", () => {
  const profile = classifyTaskProfile("Inspect src/server.ts, src/routes/users.ts, and src/routes/health.ts to explain endpoints.")
  assert.equal(profile.category, "CROSS_FILE_REASONING")
  assert.equal(profile.explicitFilePaths.length, 3)
  assert.equal(profile.defaultTurnBudget, 6)
})

test("classifyTaskProfile defaults to ORIENTATION when unspecified", () => {
  const profile = classifyTaskProfile("What does this project do?")
  assert.equal(profile.category, "ORIENTATION")
  assert.ok(profile.allowedTools.includes("list_directory"))
})
