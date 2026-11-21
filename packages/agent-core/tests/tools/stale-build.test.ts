import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { rebuildStaleWorkspacePackages } from "../../src/tools/verification-registry.ts"

test("a stale workspace dist is rebuilt with the package tsc script before tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-stale-build-"))
  try {
    await writeTree(root, {
      "package.json": JSON.stringify({ type: "module" }),
      "packages/models/package.json": JSON.stringify({
        name: "@acme/models",
        exports: { ".": { import: "./dist/index.js" } },
        scripts: { build: "tsc -p tsconfig.json" },
      }),
      "packages/models/src/index.ts": "export const built = false\n",
      "packages/models/dist/index.js": "export const built = false\n",
      "packages/app/package.json": JSON.stringify({ dependencies: { "@acme/models": "workspace:*" } }),
      "node_modules/.bin/tsc": "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nwriteFileSync('dist/index.js', 'export const built = true\\n')\n",
    })
    await symlink("../../../models", join(root, "packages/app/node_modules/@acme/models"))
    const old = new Date("2020-01-01T00:00:00.000Z")
    await utimes(join(root, "packages/models/dist/index.js"), old, old)
    const first = await rebuildStaleWorkspacePackages(root, join(root, "packages/app"))
    assert.match(first?.note ?? "", /Rebuilt @acme\/models/)
    assert.equal(await readFile(join(root, "packages/models/dist/index.js"), "utf8"), "export const built = true\n")
    const second = await rebuildStaleWorkspacePackages(root, join(root, "packages/app"))
    assert.equal(second, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content, { mode: rel.endsWith("/tsc") ? 0o755 : 0o644 })
  }
  await mkdir(join(root, "packages/app/node_modules/@acme"), { recursive: true })
}
