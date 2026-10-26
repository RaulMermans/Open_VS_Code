import assert from "node:assert/strict"
import test from "node:test"

import { classifyPermission, type ActionCategory } from "../../src/tools/permissions.ts"

test("classifies the baseline action table deterministically in BUILD mode", () => {
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
    mcp_external_read: "ALLOW",
    mcp_external_side_effect: "CONFIRM",
    mcp_sensitive_data_transmission: "CONFIRM",
    mcp_external_destructive: "CONFIRM",
    mcp_external_unknown: "CONFIRM",
    browser_inspection: "ALLOW",
    browser_interaction: "CONFIRM",
    browser_sensitive: "CONFIRM",
    browser_destructive: "CONFIRM",
  }
  for (const [action, permission] of Object.entries(expected)) {
    assert.equal(classifyPermission({ action: action as ActionCategory, mode: "BUILD" }), permission)
  }
})

test("PLAN narrows mutating and execution actions", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "PLAN" }), "DENY")
  assert.equal(classifyPermission({ action: "terminal_command", mode: "PLAN" }), "DENY")
  assert.equal(classifyPermission({ action: "read_repository", mode: "PLAN" }), "ALLOW")
  assert.equal(classifyPermission({ action: "mcp_sensitive_data_transmission", mode: "PLAN" }), "DENY")
  assert.equal(classifyPermission({ action: "mcp_external_destructive", mode: "PLAN" }), "DENY")
})

test("ASK mode denies all mutation actions", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "ASK" }), "DENY")
  assert.equal(classifyPermission({ action: "delete_file", mode: "ASK" }), "DENY")
  assert.equal(classifyPermission({ action: "terminal_command", mode: "ASK" }), "DENY")
  assert.equal(classifyPermission({ action: "git_commit", mode: "ASK" }), "DENY")
  assert.equal(classifyPermission({ action: "read_repository", mode: "ASK" }), "ALLOW")
})

test("REVIEW mode denies all mutation actions", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "REVIEW" }), "DENY")
  assert.equal(classifyPermission({ action: "delete_file", mode: "REVIEW" }), "DENY")
  assert.equal(classifyPermission({ action: "terminal_command", mode: "REVIEW" }), "DENY")
  assert.equal(classifyPermission({ action: "read_repository", mode: "REVIEW" }), "ALLOW")
})

test("BUILD write requires confirmation by default", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "BUILD" }), "CONFIRM")
})

test("DEBUG write requires confirmation by default", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "DEBUG" }), "CONFIRM")
})

test("mode overrides may change soft policy but never hard denies", () => {
  assert.equal(classifyPermission({ action: "write_file", mode: "BUILD", modeOverrides: { BUILD: { write_file: "ALLOW" } } }), "ALLOW")
  assert.equal(classifyPermission({ action: "repository_escape", mode: "BUILD", modeOverrides: { BUILD: { repository_escape: "ALLOW" } } }), "DENY")
  assert.equal(classifyPermission({ action: "unknown", mode: "BUILD", modeOverrides: { BUILD: { unknown: "ALLOW" } } }), "DENY")
})

