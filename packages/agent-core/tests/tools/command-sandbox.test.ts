import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { detectBubblewrap, detectResourceLimits, planSandboxedCommand } from "../../src/tools/command-sandbox.ts"
import { discoverVerificationCommand, resolveNodeBinary } from "../../src/tools/verification-discovery.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"

const available = detectBubblewrap().available
const skip = available ? false : `bubblewrap unavailable: ${detectBubblewrap().reason}`

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ovsc-sandbox-")))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  return root
}

async function run(root: string, executable: string, args: string[], sandbox: "required" | "off" = "required", signal?: AbortSignal, sandboxMemoryMax?: string) {
  const engine = new VerificationEngine({ workspaceRoot: root, sandbox, sandboxMemoryMax })
  return engine.execute({
    verificationId: `sb-${Math.random()}`,
    action: "TEST",
    executable,
    args,
    cwd: root,
    timeoutMs: 30_000,
    commandPreview: `${executable} ${args.join(" ")}`,
    packageJsonPath: "",
    packageJsonHash: "",
    scriptName: "",
    scriptBody: "",
  }, signal)
}

// Paths are embedded in the script, not passed as arguments: the engine's own argument containment check
// would refuse out-of-workspace arguments before the sandbox is even reached.
const probe = (inside: string, outside: string, ssh: string) => `
const fs = require("node:fs")
const out = {}
try { fs.writeFileSync(${JSON.stringify(inside)}, "ok"); out.workspaceWrite = true } catch { out.workspaceWrite = false }
try { fs.writeFileSync(${JSON.stringify(outside)}, "escaped"); out.outsideWrite = true } catch { out.outsideWrite = false }
out.sshVisible = fs.existsSync(${JSON.stringify(ssh)})
out.secretEnv = process.env.OVSC_SECRET_PROBE ?? null
fetch("http://127.0.0.1:11434/api/tags").then(() => { out.network = true }, () => { out.network = false }).finally(() => { console.log(JSON.stringify(out)) })
`

test("a sandboxed command can write only the workspace, has no network, and cannot see HOME or inherited secrets", { skip }, async () => {
  const root = await workspace({})
  const outside = await realpath(await mkdtemp(join(tmpdir(), "ovsc-sandbox-outside-")))
  await writeFile(join(root, "probe.cjs"), probe(join(root, "written.txt"), join(outside, "escaped.txt"), join(homedir(), ".ssh")))
  process.env.OVSC_SECRET_PROBE = "leaked"
  try {
    const result = await run(root, resolveNodeBinary(), [join(root, "probe.cjs")])
    assert.equal(result.sandbox?.sandboxed, true)
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!)
    assert.deepEqual(report, { workspaceWrite: true, outsideWrite: false, sshVisible: false, secretEnv: null, network: false })
    assert.equal(await readFile(join(root, "written.txt"), "utf8"), "ok")
    assert.equal(existsSync(join(outside, "escaped.txt")), false)
  } finally {
    delete process.env.OVSC_SECRET_PROBE
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("node --test, npm run test and python unittest still pass inside the sandbox", { skip }, async () => {
  const nodeTest = "import test from 'node:test'\nimport assert from 'node:assert'\ntest('ok', () => assert.equal(1 + 1, 2))\n"
  const root = await workspace({
    "package.json": JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }),
    "test/ok.test.js": nodeTest,
    "py/tests/__init__.py": "",
    "py/tests/test_ok.py": "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(2, 2)\n",
  })
  try {
    const npm = await discoverVerificationCommand(root, "TEST")
    const engine = new VerificationEngine({ workspaceRoot: root, sandbox: "required" })
    const pkg = await readFile(join(root, "package.json"), "utf8")
    const npmResult = await engine.execute({
      verificationId: "npm", action: "TEST", executable: npm.executable, args: npm.args, cwd: root, timeoutMs: 60_000,
      commandPreview: "npm run test", packageJsonPath: npm.packageJsonPath, packageJsonHash: createHash("sha256").update(pkg).digest("hex"),
      scriptName: npm.scriptName, scriptBody: npm.scriptBody,
    })
    assert.equal(npmResult.status, "PASS", npmResult.stdout + npmResult.stderr)
    assert.equal(npmResult.sandbox?.sandboxed, true)
    const python = await run(join(root, "py"), "/usr/bin/python3", ["-m", "unittest", "discover", "-s", "tests", "-t", "."])
    assert.equal(python.status, "PASS", python.stdout + python.stderr)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancelling a sandboxed command stops the whole process tree", { skip }, async () => {
  const root = await workspace({ "hang.cjs": "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => require(\"node:fs\").appendFileSync(process.argv[1], \"x\"), 50)', process.argv[2]], { stdio: 'ignore' }); setInterval(() => {}, 1000)\n" })
  try {
    const controller = new AbortController()
    const pending = run(root, resolveNodeBinary(), [join(root, "hang.cjs"), join(root, "tick.log")], "required", controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 800))
    controller.abort()
    const result = await pending
    assert.notEqual(result.status, "PASS")
    const size = (await readFile(join(root, "tick.log"), "utf8").catch(() => "")).length
    await new Promise((resolve) => setTimeout(resolve, 600))
    const after = (await readFile(join(root, "tick.log"), "utf8").catch(() => "")).length
    assert.equal(after, size, "the grandchild kept running after cancellation")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("off mode runs on the host and says so", async () => {
  const root = await workspace({ "a.test.js": "require('node:test')('ok', () => {})\n" })
  try {
    const result = await run(root, resolveNodeBinary(), ["--test", join(root, "a.test.js")], "off")
    assert.equal(result.status, "PASS", result.stdout + result.stderr)
    assert.deepEqual(result.sandbox, { mode: "off", sandboxed: false, reason: "command sandbox is turned off" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the sandbox plan never exposes HOME itself and keeps the workspace as the only writable bind", { skip }, () => {
  const home = homedir()
  const plan = planSandboxedCommand({ mode: "required", workspaceRoot: tmpdir(), cwd: tmpdir(), executable: "/usr/bin/true", args: [], env: { PATH: `${join(home, "bin")}:/usr/bin` } })
  assert.ok(!("error" in plan))
  if ("error" in plan) return
  const args = [...plan.args]
  const writable = args.flatMap((arg, index) => (arg === "--bind" ? [args[index + 1]] : []))
  assert.equal(writable.length, 1)
  const readOnly = args.flatMap((arg, index) => (arg === "--ro-bind" ? [args[index + 1]] : []))
  assert.ok(!readOnly.includes(home))
  assert.ok(args.includes("--unshare-all") && args.includes("--clearenv"))
})

const limitsSkip = available && detectResourceLimits().available ? false : "user cgroup resource limits unavailable"

test("sandboxed commands are capped in memory (no swap) and in process count", { skip: limitsSkip }, async () => {
  const root = await workspace({
    "hog.cjs": "const chunks = []; for (let i = 0; i < 80; i++) chunks.push(Buffer.alloc(64 * 1024 * 1024, 1)); console.log('survived')\n",
    "forks.cjs": "const { spawn } = require('node:child_process'); let ok = 0, refused = 0; for (let i = 0; i < 2600; i++) { try { const c = spawn('/bin/sleep', ['2']); c.on('error', () => {}); if (c.pid) ok++; else refused++ } catch { refused++ } } console.log(JSON.stringify({ ok, refused }))\n",
  })
  try {
    // Deliberate OOM stays at 4 GiB; the 5 GiB hog must not fit.
    const hog = await run(root, resolveNodeBinary(), ["--max-old-space-size=16384", join(root, "hog.cjs")], "required", undefined, "4G")
    assert.equal(hog.sandbox?.limits, "memory 4GB, 2048 tasks", JSON.stringify(hog.sandbox))
    assert.notEqual(hog.status, "PASS")
    assert.doesNotMatch(hog.stdout, /survived/)
    const forks = await run(root, resolveNodeBinary(), [join(root, "forks.cjs")])
    const counts = JSON.parse(forks.stdout.trim().split("\n").at(-1) ?? "{}")
    assert.ok(counts.ok < 2300, `spawned ${counts.ok} processes`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
