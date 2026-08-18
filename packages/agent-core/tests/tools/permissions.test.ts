import assert from "node:assert/strict"
import test from "node:test"

import { classifyPermission, type ActionCategory } from "../../src/tools/permissions.ts"

test("classifies the baseline action table deterministically", () => {
  const expected: Readonly<Record<ActionCategory, string>> = {
    read_repository: "ALLOW",
    search_repository: "ALLOW",
    read_markdown: "ALLOW",
    write_file: "CONFIRM",
    delete_file: "CONFIRM",
    run_known_test: "CONFIRM",
    terminal_command: "CONFIRM",
    git_commit: "CONFIRM",
    git_push: "CONFIRM",
    deploy: "CONFIRM",
    repository_escape: "DENY",
    system_configuration: "DENY",
    destructive_disk: "DENY",
    unknown: "DENY",
  }
  for (const [action, permission] of Object.entries(expected)) {
    assert.equal(classifyPermission({ action: action as ActionCategory, mode: "ASK" }), permission)
  }
})

test("PLAN narrows mutating and execution actions", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "PLAN" }), "DENY")
  assert.equal(classifyPermission({ action: "terminal_command", mode: "PLAN" }), "DENY")
  assert.equal(classifyPermission({ action: "read_repository", mode: "PLAN" }), "ALLOW")
})

test("mode overrides may change soft policy but never hard denies", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "BUILD", modeOverrides: { BUILD: { write_file: "ALLOW" } } }), "ALLOW")
  assert.equal(classifyPermission({ action: "repository_escape", mode: "BUILD", modeOverrides: { BUILD: { repository_escape: "ALLOW" } } }), "DENY")
  assert.equal(classifyPermission({ action: "unknown", mode: "BUILD", modeOverrides: { BUILD: { unknown: "ALLOW" } } }), "DENY")
})
