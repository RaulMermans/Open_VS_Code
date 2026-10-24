// Sprint 7C — a workspace opened through a symlinked path must verify, without
// weakening containment: the realpath check remains the authority.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { resolveRepositoryPath } from "../../src/tools/path-safety.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"

function fixture() {
  // realpath so the "real" side never goes through macOS /var -> /private/var itself.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ovsc-7c-symlink-")))
  const real = join(base, "real-project")
  mkdirSync(join(real, "src"), { recursive: true })
  writeFileSync(join(real, "src", "a.ts"), "export const a = 1\n")
  const outside = join(base, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "secret.txt"), "nope\n")
  const link = join(base, "linked-project")
  symlinkSync(real, link, "dir")
  return { base, real, outside, link }
}

test("7C-S1: an absolute path through the symlinked workspace root resolves to the canonical path", async () => {
  const { real, link } = fixture()
  assert.equal(await resolveRepositoryPath(link, link, "directory"), real)
  assert.equal(await resolveRepositoryPath(link, join(link, "src"), "directory"), join(real, "src"))
  assert.equal(await resolveRepositoryPath(link, join(link, "src", "a.ts"), "file"), join(real, "src", "a.ts"))
  // The canonical spelling and relative paths keep working.
  assert.equal(await resolveRepositoryPath(link, real, "directory"), real)
  assert.equal(await resolveRepositoryPath(link, "src/a.ts", "file"), join(real, "src", "a.ts"))
})

test("7C-S2: re-rooting never admits traversal, sibling prefixes or inner symlink escapes", async () => {
  const { base, outside, link, real } = fixture()
  await assert.rejects(resolveRepositoryPath(link, join(link, "..", "outside", "secret.txt")), { code: "OUTSIDE_WORKSPACE" })
  await assert.rejects(resolveRepositoryPath(link, join(outside, "secret.txt")), { code: "OUTSIDE_WORKSPACE" })
  mkdirSync(`${link}-evil`)
  await assert.rejects(resolveRepositoryPath(link, `${link}-evil`), { code: "OUTSIDE_WORKSPACE" })
  symlinkSync(outside, join(real, "escape"), "dir")
  await assert.rejects(resolveRepositoryPath(link, join(link, "escape", "secret.txt")), { code: "OUTSIDE_WORKSPACE" })
  await assert.rejects(resolveRepositoryPath(link, "escape/secret.txt"), { code: "OUTSIDE_WORKSPACE" })
  await assert.rejects(resolveRepositoryPath(link, base), { code: "OUTSIDE_WORKSPACE" })
})

test("7C-S3: VerificationEngine runs with cwd = a symlinked workspace root (was OUTSIDE_WORKSPACE)", async () => {
  const { link } = fixture()
  const pkg = JSON.stringify({ name: "fx", scripts: { test: "node -e 0" } })
  writeFileSync(join(link, "package.json"), pkg)
  const engine = new VerificationEngine({ workspaceRoot: link })
  const result = await engine.execute({
    verificationId: "v-7c-s3",
    action: "TEST",
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: link,
    timeoutMs: 10_000,
    commandPreview: "node -e …",
    packageJsonPath: join(link, "package.json"),
    packageJsonHash: createHash("sha256").update(pkg).digest("hex"),
    scriptName: "test",
    scriptBody: "node -e 0",
  })
  assert.equal(result.status, "PASS", result.stderr)
  assert.equal(result.stdout, realpathSync(link))
})

test("7C-S4: a cwd outside a symlinked workspace still fails closed", async () => {
  const { link, outside } = fixture()
  const pkg = JSON.stringify({ name: "fx", scripts: { test: "node -e 0" } })
  writeFileSync(join(link, "package.json"), pkg)
  const engine = new VerificationEngine({ workspaceRoot: link })
  const result = await engine.execute({
    verificationId: "v-7c-s4",
    action: "TEST",
    executable: process.execPath,
    args: ["-e", "0"],
    cwd: outside,
    timeoutMs: 10_000,
    commandPreview: "node -e 0",
    packageJsonPath: join(link, "package.json"),
    packageJsonHash: createHash("sha256").update(pkg).digest("hex"),
    scriptName: "test",
    scriptBody: "node -e 0",
  })
  assert.equal(result.status, "EXECUTION_ERROR")
  assert.match(result.stderr, /outside workspace/)
})
