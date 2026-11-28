import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import { classifyVerificationFailure } from "../../src/tools/verification-summary.ts"
import { discoverVerificationCommand, resolvePackageManager } from "../../src/tools/verification-discovery.ts"
import { loadRepositoryEngineeringProfile } from "../../src/repository/engineering-profile.ts"

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ovsc-pm-")))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

test("pnpm lockfile and packageManager select pnpm, not npm", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", scripts: { test: "node --test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  })
  try {
    const resolved = resolvePackageManager(root, { packageManager: "pnpm@9.15.0" })
    assert.equal(resolved.name, "pnpm")
    assert.equal(resolved.conflicts.length, 0)
    try {
      const command = await discoverVerificationCommand(root, "TEST")
      assert.equal(command.packageManager, "pnpm")
      assert.match(command.executable, /pnpm(?:\.cmd)?$/)
      assert.deepEqual(command.args, ["run", "test"])
    } catch (error) {
      assert.match((error as Error).message, /ENVIRONMENT_SETUP_REQUIRED/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("yarn lockfile selects yarn", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { test: "node --test" } }),
    "yarn.lock": "# yarn lockfile v1\n",
  })
  try {
    assert.equal(resolvePackageManager(root, { packageManager: "yarn@1.22.22" }).name, "yarn")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("conflicting lockfiles are not silently resolved to npm", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
  })
  try {
    const resolved = resolvePackageManager(root, {})
    assert.ok(resolved.conflicts.length > 0)
    await assert.rejects(discoverVerificationCommand(root, "TEST"), /conflicting package-manager signals/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a named package test in a pnpm workspace uses that package as cwd", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ scripts: { test: "pnpm -r test" } }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/api/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "packages/api/src/a.test.ts": "export {}\n",
  })
  try {
    const { verificationWorkspace } = await import("../../src/tools/verification-discovery.ts")
    const cwd = await verificationWorkspace(root, "Fix packages/api/src/a.test.ts")
    assert.equal(cwd, join(root, "packages", "api"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("missing pnpm executable is environment setup, not a test failure", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", scripts: { test: "node --test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  })
  const saved = process.env.PATH
  process.env.PATH = "/usr/bin"
  try {
    const command = discoverVerificationCommand(root, "TEST")
    await command.then(
      (found) => {
        assert.match(found.executable, /pnpm/)
      },
      (error: Error) => {
        assert.match(error.message, /ENVIRONMENT_SETUP_REQUIRED/)
      },
    )
  } finally {
    process.env.PATH = saved
    await rm(root, { recursive: true, force: true })
  }
})

test("failure classification distinguishes environment, mismatch, and assertions", () => {
  assert.equal(classifyVerificationFailure({ action: "TEST", status: "FAIL", stderr: "AssertionError: expected 1" }), "TEST_ASSERTION_FAILURE")
  assert.equal(classifyVerificationFailure({ action: "TYPECHECK", status: "FAIL", stdout: "error TS2304: Cannot find name" }), "TYPECHECK_FAILURE")
  assert.equal(classifyVerificationFailure({ action: "TEST", status: "FAIL", stderr: "pnpm: command not found" }), "COMMAND_NOT_FOUND")
  assert.equal(classifyVerificationFailure({ action: "TEST", status: "FAIL", stderr: "This project is configured to use yarn" }), "PACKAGE_MANAGER_MISMATCH")
  assert.equal(classifyVerificationFailure({ action: "TEST", status: "TIMEOUT" }), "TIMEOUT")
  assert.equal(classifyVerificationFailure({ action: "TEST", status: "FAIL", stderr: "ENVIRONMENT_SETUP_REQUIRED: no node_modules" }), "ENVIRONMENT_SETUP_REQUIRED")
})

test("engineering profile is compact and evidence-backed", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", scripts: { test: "turbo test", typecheck: "tsc -b" } }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "turbo.json": JSON.stringify({ tasks: { test: {} } }),
    "AGENTS.md": "# Agents\n",
  })
  try {
    const profile = loadRepositoryEngineeringProfile(root)
    assert.equal(profile?.packageManager.name, "pnpm")
    assert.ok(profile?.turbo)
    assert.ok(profile?.agentsMd)
    assert.equal(profile?.scripts.typecheck, "tsc -b")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
