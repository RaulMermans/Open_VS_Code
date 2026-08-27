import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      action: "TEST",
      executable: "echo",
      args: ["hello"],
      cwd: path.resolve(tmpDir, ".."), // outside workspace
      timeoutMs: 1000,
      commandPreview: "echo hello",
    })
    assert.equal(result.status, "EXECUTION_ERROR")
    assert.ok(result.stderr.includes("CWD must be within workspace root"))
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Success execution", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      action: "TEST",
      executable: "node",
      args: ["-e", "console.log('hello')"],
      cwd: tmpDir,
      timeoutMs: 1000,
      commandPreview: "node -e ...",
    })
    assert.equal(result.status, "PASS")
    assert.equal(result.stdout.trim(), "hello")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Output bounding limit", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      action: "TEST",
      executable: "node",
      // Output more than 16KB
      args: ["-e", "console.log('a'.repeat(20000))"],
      cwd: tmpDir,
      timeoutMs: 5000,
      commandPreview: "node ...",
    })
    assert.equal(result.status, "PASS")
    assert.ok(result.stdout.includes("[STDOUT TRUNCATED]"))
    assert.ok(result.stdout.length < 20000) // truncated
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Timeout", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const result = await engine.execute({
      action: "TEST",
      executable: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: tmpDir,
      timeoutMs: 100, // aggressive timeout
      commandPreview: "node ...",
    })
    assert.equal(result.status, "TIMEOUT")
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

test("Verification Engine - Cancellation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvscode-test-"))
  try {
    const engine = new VerificationEngine({ workspaceRoot: tmpDir })
    const controller = new AbortController()
    
    setTimeout(() => {
      controller.abort()
    }, 50)
    
    const result = await engine.execute({
      action: "TEST",
      executable: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: tmpDir,
      timeoutMs: 5000,
      commandPreview: "node ...",
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
