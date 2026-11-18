/**
 * Sprint 25: trusted workspace-local toolchains inside the command sandbox. A project virtualenv is used only
 * after static path, symlink and containment checks, and only in sandbox mode "required"; a project's
 * cached pnpm is exposed read-only with Corepack offline; missing tools or dependencies are
 * ENVIRONMENT_SETUP_REQUIRED, found before any approval; nothing is installed.
 */
import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import test from "node:test"

import { planSandboxedCommand, resetBubblewrapProbe } from "../../src/tools/command-sandbox.ts"
import { COREPACK_OFFLINE_ENV, cachedPackageManager, discoverVerificationCommand, workspaceVenv } from "../../src/tools/verification-discovery.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"
import type { PreparedVerification } from "../../src/tools/verification-contracts.ts"

const HOST_PYTHON = (() => {
  try {
    return realpathSync(execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim())
  } catch {
    return undefined
  }
})()
const hasPython = HOST_PYTHON !== undefined && /^python3(?:\.\d+)?$/.test(basename(HOST_PYTHON))

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ovsc-s25-tool-")))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

/** A uv/venv-style virtualenv: bin/python links to the host interpreter named in pyvenv.cfg. */
async function makeVenv(root: string, options: { pytest?: boolean; home?: string; target?: string } = {}): Promise<void> {
  const venv = join(root, ".venv")
  await mkdir(join(venv, "bin"), { recursive: true })
  await writeFile(join(venv, "pyvenv.cfg"), `home = ${options.home ?? dirname(HOST_PYTHON!)}\nversion_info = 3\n`)
  await symlink(options.target ?? HOST_PYTHON!, join(venv, "bin", "python"))
  const site = join(venv, "lib", "python3.12", "site-packages")
  await mkdir(site, { recursive: true })
  if (options.pytest) await mkdir(join(site, "pytest"), { recursive: true })
}

const PYTEST_REPO = { "pytest.ini": "[pytest]\n", "tests/test_a.py": "def test_a():\n    assert True\n" }

test("a valid project virtualenv with pytest is the verifier, and it must run sandboxed", { skip: !hasPython }, async () => {
  const root = await workspace(PYTEST_REPO)
  try {
    await makeVenv(root, { pytest: true })
    const command = await discoverVerificationCommand(root, "TEST")
    assert.equal(command.executable, join(root, ".venv", "bin", "python"))
    assert.deepEqual(command.args, ["-m", "pytest", "-q"])
    assert.equal(command.requiresSandbox, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a virtualenv without pytest is ENVIRONMENT_SETUP_REQUIRED with the setup command, found before running", { skip: !hasPython }, async () => {
  const root = await workspace(PYTEST_REPO)
  try {
    await makeVenv(root, { pytest: false })
    await assert.rejects(discoverVerificationCommand(root, "TEST"), /^Error: ENVIRONMENT_SETUP_REQUIRED: pytest is not installed in the project virtualenv\. To set it up \(needs network; not done automatically\): \.venv\/bin\/python -m pip install pytest/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("symlink escapes and impostors are not accepted as a project virtualenv", { skip: !hasPython }, async () => {
  const outside = await workspace()
  const root = await workspace(PYTEST_REPO)
  try {
    // .venv itself is a symlink to a directory outside the workspace.
    await makeVenv(outside, { pytest: true })
    await symlink(join(outside, ".venv"), join(root, ".venv"))
    assert.equal(workspaceVenv(root), undefined, ".venv that leaves the workspace")
    await rm(join(root, ".venv"))
    // bin/python is another program (sh), not a Python interpreter.
    await makeVenv(root, { pytest: true, target: "/bin/sh", home: "/bin" })
    assert.equal(workspaceVenv(root), undefined, "python that is not a Python interpreter")
    await rm(join(root, ".venv"), { recursive: true })
    // bin/python is a workspace file (workspace-controlled binary).
    await writeFile(join(root, "python3.12"), "#!/bin/sh\necho owned\n", { mode: 0o755 })
    await makeVenv(root, { pytest: true, target: join(root, "python3.12"), home: root })
    assert.equal(workspaceVenv(root), undefined, "interpreter inside the workspace")
    await rm(join(root, ".venv"), { recursive: true })
    // pyvenv.cfg names a different home than the interpreter really lives in.
    await makeVenv(root, { pytest: true, home: "/opt/elsewhere" })
    assert.equal(workspaceVenv(root), undefined, "home mismatch")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

function prepared(root: string, overrides: Partial<PreparedVerification> = {}): PreparedVerification {
  return {
    verificationId: "v", action: "TEST", executable: join(root, ".venv", "bin", "python"), args: ["-c", "print('ran')"], cwd: root, timeoutMs: 30_000,
    commandPreview: "", packageJsonPath: "", packageJsonHash: "", scriptName: "", scriptBody: "", requiresSandbox: true, ...overrides,
  }
}

test("a workspace interpreter never falls back to unsandboxed execution", { skip: !hasPython }, async () => {
  const root = await workspace(PYTEST_REPO)
  try {
    await makeVenv(root, { pytest: true })
    // Sandbox turned off: refused, not run on the host.
    const off = await new VerificationEngine({ workspaceRoot: root, sandbox: "off" }).execute(prepared(root))
    assert.equal(off.status, "EXECUTION_ERROR")
    assert.match(off.stderr, /^ENVIRONMENT_SETUP_REQUIRED: .*runs only inside the command sandbox/)
    assert.doesNotMatch(off.stdout, /ran/)
    // Sandbox "auto" with bubblewrap unavailable: "required" applies, so it does not run either.
    resetBubblewrapProbe({ available: false, reason: "bubblewrap (bwrap) is not installed" })
    try {
      const auto = await new VerificationEngine({ workspaceRoot: root, sandbox: "auto" }).execute(prepared(root, { verificationId: "v-auto" }))
      assert.equal(auto.status, "EXECUTION_ERROR")
      assert.match(auto.stderr, /Command sandbox is required but bubblewrap \(bwrap\) is not installed/)
      assert.doesNotMatch(auto.stdout, /ran/)
      assert.equal(auto.sandbox?.sandboxed, false)
    } finally {
      resetBubblewrapProbe()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a prepared interpreter that is no longer the project virtualenv is refused at execution", { skip: !hasPython }, async () => {
  const root = await workspace(PYTEST_REPO)
  try {
    await makeVenv(root, { pytest: true })
    const swapped = prepared(root, { executable: join(root, "tool"), requiresSandbox: true })
    await writeFile(join(root, "tool"), "#!/bin/sh\necho ran\n", { mode: 0o755 })
    const result = await new VerificationEngine({ workspaceRoot: root, sandbox: "auto" }).execute(swapped)
    assert.equal(result.status, "EXECUTION_ERROR")
    assert.doesNotMatch(result.stdout, /ran/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("only fixed offline Corepack settings and real Corepack cache binds are accepted", async () => {
  const root = await workspace({ "a.js": "" })
  try {
    const engine = new VerificationEngine({ workspaceRoot: root, sandbox: "off" })
    const base = { executable: process.execPath, args: ["-e", "0"], requiresSandbox: false }
    const network = await engine.execute(prepared(root, { ...base, verificationId: "n", env: { COREPACK_ENABLE_NETWORK: "1" } }))
    assert.match(network.stderr, /COREPACK_ENABLE_NETWORK must be 0/)
    const token = await engine.execute(prepared(root, { ...base, verificationId: "t", env: { NPM_TOKEN: "secret" } }))
    assert.match(token.stderr, /NPM_TOKEN is not allowed/)
    const bind = await engine.execute(prepared(root, { ...base, verificationId: "b", readOnlyBinds: [tmpdir()] }))
    assert.match(bind.stderr, /Read-only bind refused/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the declared package manager is used from the Corepack cache when present; otherwise setup is required", async () => {
  const cache = await realpath(await mkdtemp(join(tmpdir(), "ovsc-s25-corepack-")))
  const saved = process.env.COREPACK_HOME
  process.env.COREPACK_HOME = cache
  const root = await workspace({ "package.json": JSON.stringify({ packageManager: "pnpm@10.28.0", scripts: { build: "pnpm -r build" } }) })
  try {
    await assert.rejects(discoverVerificationCommand(root, "BUILD"), /ENVIRONMENT_SETUP_REQUIRED: the script calls pnpm, and pnpm@10\.28\.0 .* is not in the Corepack cache.*corepack install/)
    await mkdir(join(cache, "v1", "pnpm", "10.28.0"), { recursive: true })
    await writeFile(join(cache, "v1", "pnpm", "10.28.0", "package.json"), "{}")
    assert.deepEqual(cachedPackageManager({ packageManager: "pnpm@10.28.0" }, root), { name: "pnpm", version: "10.28.0", cacheDir: join(cache, "v1", "pnpm", "10.28.0") })
    const command = await discoverVerificationCommand(root, "BUILD")
    assert.deepEqual(command.readOnlyBinds, [join(cache, "v1", "pnpm", "10.28.0")])
    assert.equal(command.env?.COREPACK_HOME, cache)
    for (const [key, value] of Object.entries(COREPACK_OFFLINE_ENV)) assert.equal(command.env?.[key], value)
  } finally {
    if (saved === undefined) delete process.env.COREPACK_HOME
    else process.env.COREPACK_HOME = saved
    await rm(root, { recursive: true, force: true })
    await rm(cache, { recursive: true, force: true })
  }
})

test("declared dependencies without node_modules are ENVIRONMENT_SETUP_REQUIRED, not a test run", async () => {
  const root = await workspace({ "package.json": JSON.stringify({ devDependencies: { vitest: "^3" }, scripts: { test: "vitest run" } }), "package-lock.json": "{}" })
  try {
    await assert.rejects(discoverVerificationCommand(root, "TEST"), /ENVIRONMENT_SETUP_REQUIRED: the project's dependencies are not installed \(no node_modules\)\. To set it up \(needs network; not done automatically\): npm ci/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("TEST without a test script uses the project's test:unit script instead of requiring a package.json edit", async () => {
  const root = await workspace({ "package.json": JSON.stringify({ scripts: { "test:unit": "node --test" } }) })
  try {
    const command = await discoverVerificationCommand(root, "TEST")
    assert.equal(command.scriptName, "test:unit")
    assert.deepEqual(command.args, ["run", "test:unit"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the sandbox plan exposes extra read-only binds and keeps the network unshared", () => {
  const plan = planSandboxedCommand({ mode: "auto", workspaceRoot: tmpdir(), cwd: tmpdir(), executable: process.execPath, args: [], env: { PATH: "/usr/bin" }, readOnlyBinds: ["/opt/corepack-cache/v1/pnpm/10.28.0"] })
  if ("error" in plan || !plan.status.sandboxed) return // bubblewrap not available here
  const args = plan.args.join(" ")
  assert.match(args, /--ro-bind \/opt\/corepack-cache\/v1\/pnpm\/10\.28\.0 \/opt\/corepack-cache\/v1\/pnpm\/10\.28\.0/)
  assert.match(args, /--unshare-all/)
  assert.doesNotMatch(args, /--share-net/)
})

import { AgentRunner } from "../../src/agent/runner.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { createVerificationToolRegistrations } from "../../src/tools/verification-registry.ts"

const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })
const reply = (text: string): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: text } })

async function runAgent(root: string, steps: ModelResponse[], instruction: string, decision: "APPROVE" | "REJECT") {
  const engine = new MutationEngine(root)
  const registry = new ToolRegistry([...createMutationToolRegistrations({ engine }), ...createVerificationToolRegistrations(root, { sandbox: "auto" })])
  const agent = new AgentRunner({ provider: new ScriptedModelProvider(steps), registry, eventFactory: { createId: () => "e", now: () => "2026-11-18T12:00:00.000Z" } })
  let result = await agent.run({ task: { id: "t", mode: "BUILD", instruction }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: calculateBudget({ contextWindow: 16_000, reservedOutput: 400, reservedToolHistory: 400 }), projectInstructions: [] })
  const prompts: string[] = []
  for (let guard = 0; result.status === "PAUSED" && guard < 10; guard += 1) {
    prompts.push(JSON.stringify(result.confirmation ?? {}))
    result = await agent.resume(decision)
  }
  return { result, prompts }
}

test("rejecting the approval of a virtualenv verification runs nothing", { skip: !hasPython }, async () => {
  const root = await workspace({ ...PYTEST_REPO, "conftest.py": "open('RAN', 'w').write('x')\n" })
  try {
    await makeVenv(root, { pytest: true })
    const { result, prompts } = await runAgent(root, [call("v1", "run_verification", { action: "TEST" }), reply("Verification was rejected.")], "Run the tests and report the result. Do not edit files.", "REJECT")
    assert.equal(prompts.length, 1, "one approval was asked")
    assert.match(prompts[0]!, /\.venv\/bin\/python/, "the approval shows the exact command")
    assert.match(prompts[0]!, /Sandbox required: this uses the project's virtualenv and never runs outside the sandbox/, "and that it runs only sandboxed")
    await assert.rejects(realpath(join(root, "RAN")), "the command did not run")
    assert.ok(!result.observations?.some((item) => item.content.startsWith("Verification Status:")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("package.json is not edited to make verification run unless the request is about it", async () => {
  const pkg = JSON.stringify({ name: "x", scripts: { "test:unit": "node --test" } }, null, 2)
  const patch = { path: "package.json", search: '"test:unit": "node --test"', replace: '"test": "node --test",\n    "test:unit": "node --test"' }
  const root = await workspace({ "package.json": pkg, "src/a.js": "export const a = 1\n" })
  try {
    const { result } = await runAgent(root, [call("p1", "apply_patch", patch), reply("Left package.json alone.")], "Fix src/a.js so a is 2.", "APPROVE")
    assert.equal(result.toolCalls.find((item) => item.id === "p1")?.outcome, "DENIED")
    assert.match(String(result.observations?.find((item) => item.callId === "p1")?.content), /does not ask to change package\.json/)
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(root, "package.json"), "utf8")), pkg)
    // A request about the scripts may edit them (after the normal review).
    const asked = await runAgent(root, [call("p2", "apply_patch", patch), reply("Added the test script.")], "Add a test script to package.json that runs node --test.", "APPROVE")
    assert.notEqual(asked.result.toolCalls.find((item) => item.id === "p2")?.outcome, "DENIED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
