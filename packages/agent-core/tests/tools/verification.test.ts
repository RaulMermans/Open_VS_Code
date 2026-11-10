import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"
import { discoverVerificationCommand, resolveNodeBinary } from "../../src/tools/verification-discovery.ts"
import { createVerificationToolRegistry } from "../../src/tools/verification-registry.ts"

test("Verification Discovery - valid action", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: {
        test: "echo test",
      },
    }))
    const command = await discoverVerificationCommand(tmpDir, "TEST")
    assert.match(command.executable, /npm$/)
    assert.deepEqual(command.args, ["run", "test"])
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Discovery - node --test when the repository has no package.json", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  try {
    await fs.mkdir(path.join(tmpDir, "test"))
    await fs.writeFile(path.join(tmpDir, "test", "add.test.js"), "import test from 'node:test'\ntest('ok', () => {})\n")
    const command = await discoverVerificationCommand(tmpDir, "TEST")
    assert.match(command.executable, /node$/)
    assert.deepEqual(command.args, ["--test", path.join("test", "add.test.js")])
    assert.equal(command.packageJsonPath, "")
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "node-test-fallback",
      action: "TEST",
      executable: command.executable,
      args: command.args,
      cwd: tmpDir,
      timeoutMs: 10000,
      commandPreview: `${command.executable} --test`,
      packageJsonPath: "",
      packageJsonHash: "",
      scriptName: "",
      scriptBody: "",
    })
    assert.equal(result.status, "PASS")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Discovery - missing action", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      scripts: {},
    }))
    await assert.rejects(
      discoverVerificationCommand(tmpDir, "TEST"),
      /Action TEST requires a 'test' script in package.json/
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - CWD escape", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  tmpDir = await fs.realpath(tmpDir)
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)

    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "test-id", action: "TEST",
      executable: "echo",
      args: ["hello"],
      cwd: path.resolve(tmpDir, ".."), // outside workspace
      timeoutMs: 1000,
      commandPreview: "echo hello",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "echo hello",
    })
    assert.equal(result.status, "EXECUTION_ERROR")
    assert.ok(result.stderr.includes("CWD validation failed"))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Success execution", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  tmpDir = await fs.realpath(tmpDir)
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)
    // require crypto dynamically because we need to compute hash sync here
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "test-id", action: "TEST",
      executable: "node",
      args: ["-e", "console.log('hello')"],
      cwd: tmpDir,
      timeoutMs: 1000,
      commandPreview: "node -e ...",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node -e console.log('hello')",
    })
    assert.equal(result.status, "PASS")
    assert.equal(result.stdout.trim(), "hello")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Output bounding limit", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  tmpDir = await fs.realpath(tmpDir)
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "test-id", action: "TEST",
      executable: "node",
      // Output more than 16KB
      args: ["-e", "console.log('a'.repeat(20000))"],
      cwd: tmpDir,
      timeoutMs: 5000,
      commandPreview: "node ...",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node ...",
    })
    assert.equal(result.status, "PASS")
    assert.ok(result.stdout.includes("[STDOUT TRUNCATED]"))
    assert.ok(result.stdout.length < 20000) // truncated
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Stale verification", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  tmpDir = await fs.realpath(tmpDir)
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const originalContent = JSON.stringify({ scripts: { test: "echo old" } })
    await fs.writeFile(pkgPath, originalContent)

    const engine = new VerificationEngine({ workspaceRoot: tmpDir })

    // Mutate package.json AFTER preparation but BEFORE execution
    const newContent = JSON.stringify({ scripts: { test: "echo new" } })
    await fs.writeFile(pkgPath, newContent)

    const result = await engine.execute({
      verificationId: "test-id", action: "TEST",
      executable: "echo",
      args: ["old"],
      cwd: tmpDir,
      timeoutMs: 1000,
      commandPreview: "echo old",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(originalContent).digest("hex"), // hash of original
      scriptName: "test",
      scriptBody: "echo old",
    })

    assert.equal(result.status, "STALE_VERIFICATION")
    assert.ok(result.stderr.includes("changed since preparation"))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Single use enforcement", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  tmpDir = await fs.realpath(tmpDir)
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)

    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const prepared = {
      verificationId: "v-single-use",
      action: "TEST",
      executable: "node",
      args: ["-e", "console.log('hello')"],
      cwd: tmpDir,
      timeoutMs: 1000,
      commandPreview: "node -e ...",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node -e console.log('hello')",
    } as const

    // First execution should pass
    const result1 = await engine.execute(prepared)
    assert.equal(result1.status, "PASS")

    // Second execution with same ID should fail immediately
    const result2 = await engine.execute(prepared)
    assert.equal(result2.status, "EXECUTION_ERROR")
    assert.ok(result2.stderr.includes("already been executed"))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Timeout", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  tmpDir = await fs.realpath(tmpDir)
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "test-id", action: "TEST",
      executable: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: tmpDir,
      timeoutMs: 100, // aggressive timeout
      commandPreview: "node ...",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node ...",
    })
    assert.equal(result.status, "TIMEOUT")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Cancellation", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  tmpDir = await fs.realpath(tmpDir)
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const controller = new AbortController()

    setTimeout(() => {
      controller.abort()
    }, 50)

    const result = await engine.execute({
      verificationId: "test-id", action: "TEST",
      executable: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: tmpDir,
      timeoutMs: 5000,
      commandPreview: "node ...",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node ...",
    }, controller.signal)

    assert.equal(result.status, "CANCELLED")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Registry - omitted action defaults to TEST", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    const registry = createVerificationToolRegistry(tmpDir)
    const prepared = registry.prepare({ id: "1", name: "run_verification", arguments: {} })
    assert.equal((prepared.arguments as { action: string }).action, "TEST")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Discovery - invalid package.json fails and does not fall back", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  try {
    await fs.mkdir(path.join(tmpDir, "test"))
    await fs.writeFile(path.join(tmpDir, "test", "add.test.js"), "import test from 'node:test'\ntest('ok', () => {})\n")
    await fs.writeFile(path.join(tmpDir, "package.json"), "{")
    await assert.rejects(discoverVerificationCommand(tmpDir, "TEST"), /Failed to parse package.json/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Discovery - unreadable package.json fails and does not fall back", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  try {
    await fs.mkdir(path.join(tmpDir, "test"))
    await fs.writeFile(path.join(tmpDir, "test", "add.test.js"), "import test from 'node:test'\ntest('ok', () => {})\n")
    await fs.mkdir(path.join(tmpDir, "package.json"))
    await assert.rejects(
      discoverVerificationCommand(tmpDir, "TEST"),
      /package.json is unreadable or resolves outside the workspace/
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Discovery - package.json symlink outside the workspace fails", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-outside-")))
  try {
    await fs.writeFile(path.join(outside, "package.json"), JSON.stringify({ scripts: { test: "echo escaped" } }))
    await fs.symlink(path.join(outside, "package.json"), path.join(tmpDir, "package.json"))
    await assert.rejects(
      discoverVerificationCommand(tmpDir, "TEST"),
      /package.json is unreadable or resolves outside the workspace/
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("Verification Discovery - escaping test symlink is not a supported Node test", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-outside-")))
  try {
    await fs.writeFile(path.join(outside, "escape.test.js"), "import test from 'node:test'\ntest('escape', () => {})\n")
    await fs.symlink(path.join(outside, "escape.test.js"), path.join(tmpDir, "escape.test.js"))
    await assert.rejects(
      discoverVerificationCommand(tmpDir, "TEST"),
      /Failed to read package.json in workspace root/
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("Verification Discovery - Node comes from an absolute PATH before nvm", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-node-"))
  const workspace = path.join(root, "workspace")
  const pathDir = path.join(root, "path-bin")
  const nvmRoot = path.join(root, "nvm")
  await fs.mkdir(workspace)
  await fs.mkdir(pathDir)
  await fs.mkdir(path.join(nvmRoot, "v22.10.0", "bin"), { recursive: true })
  const pathNode = path.join(pathDir, "node")
  const nvmNode = path.join(nvmRoot, "v22.10.0", "bin", "node")
  await fs.writeFile(pathNode, "#!/bin/sh\nexit 0\n")
  await fs.writeFile(nvmNode, "#!/bin/sh\nexit 0\n")
  await fs.chmod(pathNode, 0o755)
  await fs.chmod(nvmNode, 0o755)
  const resolved = resolveNodeBinary({ pathEnv: `relative-bin${path.delimiter}${pathDir}`, nvmRoot, workspaceRoot: workspace })
  assert.equal(resolved, pathNode)
  await fs.rm(root, { recursive: true, force: true })
})

test("Verification Discovery - nvm selection prefers the highest version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-nvm-"))
  const workspace = path.join(root, "workspace")
  const nvmRoot = path.join(root, "nvm")
  await fs.mkdir(workspace)
  for (const version of ["v22.9.0", "v22.10.0", "v20.0.0"]) {
    const bin = path.join(nvmRoot, version, "bin")
    await fs.mkdir(bin, { recursive: true })
    const node = path.join(bin, "node")
    await fs.writeFile(node, "#!/bin/sh\nexit 0\n")
    await fs.chmod(node, 0o755)
  }
  const resolved = resolveNodeBinary({ pathEnv: "relative-bin", nvmRoot, workspaceRoot: workspace })
  assert.equal(resolved, path.join(nvmRoot, "v22.10.0", "bin", "node"))
  await fs.rm(root, { recursive: true, force: true })
})

test("Verification Discovery - a Node binary inside the workspace is not used", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-planted-")))
  try {
    const pathDir = path.join(root, "bin")
    await fs.mkdir(pathDir)
    const planted = path.join(pathDir, "node")
    await fs.writeFile(planted, "#!/bin/sh\nexit 0\n")
    await fs.chmod(planted, 0o755)
    assert.throws(
      () => resolveNodeBinary({ pathEnv: pathDir, nvmRoot: path.join(root, "missing-nvm"), workspaceRoot: root }),
      /Node.js executable was not found/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("Verification Engine - failed Node tests are not a pass", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  try {
    await fs.mkdir(path.join(tmpDir, "test"))
    await fs.writeFile(path.join(tmpDir, "test", "add.test.js"), "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('no', () => assert.equal(1, 2))\n")
    const command = await discoverVerificationCommand(tmpDir, "TEST")
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "failing-node-test",
      action: "TEST",
      executable: command.executable,
      args: command.args,
      cwd: tmpDir,
      timeoutMs: 10000,
      commandPreview: `${command.executable} --test`,
      packageJsonPath: "",
      packageJsonHash: "",
      scriptName: "",
      scriptBody: "",
    })
    assert.equal(result.status, "FAIL")
    assert.notEqual(result.exitCode, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /fail/i)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - node --test with zero tests is not a pass", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "empty-node-test",
      action: "TEST",
      executable: "node",
      args: ["--test"],
      cwd: tmpDir,
      timeoutMs: 10000,
      commandPreview: "node --test",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node --test",
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.status, "FAIL")
    assert.match(result.stderr, /did not report a passing test/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - symlink cwd outside the workspace is rejected", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-outside-")))
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)
    await fs.symlink(outside, path.join(tmpDir, "escape"))
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "symlink-cwd",
      action: "TEST",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: path.join(tmpDir, "escape"),
      timeoutMs: 10000,
      commandPreview: "node -e process.exit(0)",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node -e process.exit(0)",
    })
    assert.equal(result.status, "EXECUTION_ERROR")
    assert.match(result.stderr, /CWD validation failed/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("Verification Engine - a test path outside the workspace is rejected", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-")))
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-outside-")))
  try {
    const pkgPath = path.join(tmpDir, "package.json")
    const pkgContent = "{}"
    await fs.writeFile(pkgPath, pkgContent)
    const outsideTest = path.join(outside, "escape.test.js")
    await fs.writeFile(outsideTest, "import test from 'node:test'\ntest('escape', () => {})\n")
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      verificationId: "outside-arg",
      action: "TEST",
      executable: "node",
      args: ["--test", outsideTest],
      cwd: tmpDir,
      timeoutMs: 10000,
      commandPreview: "node --test escape",
      packageJsonPath: pkgPath,
      packageJsonHash: crypto.createHash("sha256").update(pkgContent).digest("hex"),
      scriptName: "test",
      scriptBody: "node --test",
    })
    assert.equal(result.status, "EXECUTION_ERROR")
    assert.match(result.stderr, /CWD validation failed/)
    assert.equal(result.exitCode, null)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("Verification Registry - Command injection resistance", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    const registry = createVerificationToolRegistry(tmpDir)
    assert.throws(() => {
      registry.prepare({ id: "1", name: "run_verification", arguments: { action: "TEST && rm -rf /" } })
    }, /action must be one of TEST, TYPECHECK, LINT, BUILD/)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
