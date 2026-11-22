import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { detectBubblewrap } from "../../src/tools/command-sandbox.ts"
import { resolveNodeBinary } from "../../src/tools/verification-discovery.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"
import { createVerificationToolRegistrations, planStaleDependencyBuilds } from "../../src/tools/verification-registry.ts"
import type { PreparedVerification } from "../../src/tools/verification-contracts.ts"

const sandboxSkip = detectBubblewrap().available ? false : `bubblewrap unavailable: ${detectBubblewrap().reason}`

test("a reviewed test rebuilds a stale workspace dist through the verification engine", { skip: sandboxSkip }, async () => {
  const root = await fixture({
    "node_modules/typescript/lib/tsc.js": "import { writeFileSync } from 'node:fs'\nwriteFileSync('dist/index.js', 'export const built = true\\n')\n",
  })
  try {
    const review = await reviewTest(root)
    const payload = review.reviewPayload as unknown as PreparedVerification
    assert.match(payload.commandPreview, /typescript\/lib\/tsc\.js/)
    assert.equal(payload.dependencyBuilds?.length, 1)
    const build = payload.dependencyBuilds![0]!
    assert.equal(build.executable, resolveNodeBinary({ workspaceRoot: root }))
    assert.equal(await realpath(build.executable) === root || (await realpath(build.executable)).startsWith(`${root}/`), false)
    assert.equal((await realpath(build.args[0]!)).startsWith(`${root}/`), true)
    assert.equal(await readFile(join(root, "packages/models/dist/index.js"), "utf8"), "export const built = false\n")
    const result = await review.apply({ workspaceRoot: root, signal: new AbortController().signal }) as { status: string; diagnosis?: string; sandbox?: { sandboxed?: boolean } }
    assert.equal(result.status, "PASS", JSON.stringify(result))
    assert.equal(result.sandbox?.sandboxed, true)
    assert.match(result.diagnosis ?? "", /Rebuilt @acme\/models/)
    assert.equal(await readFile(join(root, "packages/models/dist/index.js"), "utf8"), "export const built = true\n")
    assert.equal((await planStaleDependencyBuilds(root, root)).builds.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a dependency build cannot write outside the workspace or see the network", { skip: sandboxSkip }, async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "ovsc-stale-outside-")))
  const root = await fixture({
    "node_modules/typescript/lib/tsc.js": `import { writeFileSync } from 'node:fs'\nwriteFileSync('dist/index.js', 'export const built = true\\n')\ntry { writeFileSync(${JSON.stringify(join(outside, "escaped.txt"))}, 'escaped') } catch {}\nfetch('http://127.0.0.1:9/').then(() => {}, () => {})\n`,
  })
  try {
    const plan = await planStaleDependencyBuilds(root, root)
    const engine = new VerificationEngine({ workspaceRoot: root, sandbox: "required" })
    const result = await engine.execute(plan.builds[0]!, new AbortController().signal)
    assert.equal(result.sandbox?.sandboxed, true)
    assert.equal(result.status, "PASS")
    assert.equal(existsSync(join(outside, "escaped.txt")), false)
    assert.equal(await readFile(join(root, "packages/models/dist/index.js"), "utf8"), "export const built = true\n")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("a compiler or dependency outside the workspace is not executed", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "ovsc-stale-compiler-")))
  await writeFile(join(outside, "tsc.js"), "import { writeFileSync } from 'node:fs'\nwriteFileSync('marker.txt', 'ran')\n")
  const root = await fixture({})
  try {
    await mkdir(join(root, "node_modules/typescript/lib"), { recursive: true })
    await symlink(join(outside, "tsc.js"), join(root, "node_modules/typescript/lib/tsc.js"))
    const planned = await planStaleDependencyBuilds(root, root)
    assert.match(planned.error ?? "", /workspace/)
    assert.equal(planned.builds.length, 0)
    assert.equal(existsSync(join(outside, "marker.txt")), false)
    await rm(join(root, "node_modules/typescript/lib/tsc.js"))
    await writeFile(join(root, "node_modules/typescript/lib/tsc.js"), "import { writeFileSync } from 'node:fs'\nwriteFileSync('marker.txt', 'ran')\n")
    await rm(join(root, "node_modules/@acme/models"))
    await symlink(outside, join(root, "node_modules/@acme/models"))
    const skipped = await planStaleDependencyBuilds(root, root)
    assert.equal(skipped.builds.length, 0)
    assert.equal(existsSync(join(outside, "marker.txt")), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("a changed build script after review is not run", async () => {
  const root = await fixture({
    "node_modules/typescript/lib/tsc.js": "import { writeFileSync } from 'node:fs'\nwriteFileSync('ran.txt', 'ran')\n",
  })
  try {
    const plan = await planStaleDependencyBuilds(root, root)
    await writeFile(join(root, "packages/models/package.json"), JSON.stringify({
      name: "@acme/models",
      exports: { ".": { import: "./dist/index.js" } },
      scripts: { build: "node evil.js" },
    }))
    const engine = new VerificationEngine({ workspaceRoot: root, sandbox: "off" })
    const result = await engine.execute(plan.builds[0]!, new AbortController().signal)
    assert.equal(result.status, "STALE_VERIFICATION")
    assert.equal(existsSync(join(root, "packages/models/ran.txt")), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancelling the reviewed build stops it before the test", { skip: sandboxSkip }, async () => {
  const root = await fixture({
    "node_modules/typescript/lib/tsc.js": "setInterval(() => {}, 1000)\n",
  })
  try {
    const review = await reviewTest(root)
    const controller = new AbortController()
    const pending = review.apply({ workspaceRoot: root, signal: controller.signal })
    controller.abort()
    const result = await pending as { status: string }
    assert.equal(result.status, "CANCELLED")
    assert.equal(await readFile(join(root, "packages/models/dist/index.js"), "utf8"), "export const built = false\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a non-tsc build script is left alone", async () => {
  const root = await fixture({}, "node evil.js")
  try {
    assert.equal((await planStaleDependencyBuilds(root, root)).builds.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a build argument outside the workspace is refused before execution", async () => {
  const root = await fixture({
    "node_modules/typescript/lib/tsc.js": "import { writeFileSync } from 'node:fs'\nwriteFileSync('ran.txt', 'ran')\n",
  }, "tsc --outDir /tmp/ovsc-stale-escape")
  try {
    const planned = await planStaleDependencyBuilds(root, root)
    assert.match(planned.error ?? "", /outside the workspace/)
    assert.equal(planned.builds.length, 0)
    assert.equal(existsSync(join(root, "packages/models/ran.txt")), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function reviewTest(root: string) {
  const [tool] = createVerificationToolRegistrations(root, { sandbox: "required" })
  return tool!.prepareForReview!({ action: "TEST" }, { workspaceRoot: root, signal: new AbortController().signal })
}

async function fixture(files: Record<string, string>, build = "tsc -p tsconfig.json"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ovsc-stale-build-")))
  const tree: Record<string, string> = {
    "package.json": JSON.stringify({ name: "app", scripts: { test: "node -e \"process.exit(0)\"" }, dependencies: { "@acme/models": "workspace:*" } }),
    "packages/models/package.json": JSON.stringify({
      name: "@acme/models",
      exports: { ".": { import: "./dist/index.js" } },
      scripts: { build },
    }),
    "packages/models/src/index.ts": "export const built = false\n",
    "packages/models/dist/index.js": "export const built = false\n",
    ...files,
  }
  for (const [rel, content] of Object.entries(tree)) {
    const file = join(root, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await mkdir(join(root, "node_modules/@acme"), { recursive: true })
  await symlink("../../packages/models", join(root, "node_modules/@acme/models"))
  const old = new Date("2020-01-01T00:00:00.000Z")
  await utimes(join(root, "packages/models/dist/index.js"), old, old)
  return root
}
