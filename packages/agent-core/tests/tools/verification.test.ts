import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"
import { discoverVerificationCommand } from "../../src/tools/verification-discovery.ts"
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
    assert.equal(command.executable, "npm")
    assert.deepEqual(command.args, ["run", "test"])
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
