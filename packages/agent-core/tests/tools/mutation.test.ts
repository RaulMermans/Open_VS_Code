import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm, stat, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  MutationEngine,
  sha256,
  resolveWritePath,
  checkMutationPolicy,
  isSensitivePath,
  generateUnifiedDiff,
  generateCreateDiff,
  checkBudgets,
} from "../../src/tools/mutation-engine.ts"
import {
  MutationFailure,
  DEFAULT_MUTATION_BUDGETS,
  DEFAULT_MUTATION_POLICY,
  type MutationRequest,
  type MutationBudgets,
} from "../../src/tools/mutation-contracts.ts"

// --- Test Helpers ---

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mutation-test-"))
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = join(dir, name)
  const parentDir = join(filePath, "..")
  await mkdir(parentDir, { recursive: true })
  await writeFile(filePath, content, "utf8")
  return filePath
}

function deterministicEngine(workspace: string, overrides?: Partial<{ budgets: MutationBudgets }>): MutationEngine {
  let idSeq = 0
  return new MutationEngine(workspace, {
    ...(overrides?.budgets ? { budgets: overrides.budgets } : {}),
    idFactory: () => `test-mutation-${++idSeq}`,
    timestampFactory: () => "2025-01-01T00:00:00.000Z",
  })
}

// --- SHA-256 ---

test("sha256 produces deterministic hex digest", () => {
  const hash = sha256("hello world")
  assert.equal(hash, sha256("hello world"))
  assert.notEqual(hash, sha256("hello world!"))
  assert.equal(hash.length, 64)
})

// --- Diff Generation ---

test("generateUnifiedDiff produces valid unified diff for patch", () => {
  const diff = generateUnifiedDiff("src/main.ts", "const x = 1\n", "const x = 2\n", 16384)
  assert.equal(diff.operation, "patch")
  assert.equal(diff.linesAdded, 1)
  assert.equal(diff.linesRemoved, 1)
  assert.ok(diff.unified.includes("--- a/src/main.ts"))
  assert.ok(diff.unified.includes("+++ b/src/main.ts"))
  assert.ok(diff.unified.includes("-const x = 1"))
  assert.ok(diff.unified.includes("+const x = 2"))
  assert.equal(diff.truncated, false)
})

test("generateCreateDiff produces valid create diff", () => {
  const diff = generateCreateDiff("src/new.ts", "const y = 42\n", 16384)
  assert.equal(diff.operation, "create")
  assert.equal(diff.linesAdded, 2)
  assert.equal(diff.linesRemoved, 0)
  assert.ok(diff.unified.includes("--- /dev/null"))
  assert.ok(diff.unified.includes("+++ b/src/new.ts"))
  assert.ok(diff.unified.includes("+const y = 42"))
})

test("diff truncation when exceeding limit", () => {
  const bigContent = "line\n".repeat(5000)
  const diff = generateCreateDiff("big.ts", bigContent, 256)
  assert.equal(diff.truncated, true)
  assert.ok(diff.unified.includes("[diff truncated]"))
})

// --- Budget Checks ---

test("checkBudgets passes within limits", () => {
  const diff = generateUnifiedDiff("test.ts", "a\n", "b\n", 16384)
  const result = checkBudgets(diff, DEFAULT_MUTATION_BUDGETS)
  assert.equal(result, null)
})

test("checkBudgets rejects when added lines exceed budget", () => {
  const content = "x\n".repeat(300)
  const diff = generateCreateDiff("big.ts", content, 65536)
  const result = checkBudgets(diff, { ...DEFAULT_MUTATION_BUDGETS, maxAddedLines: 10 })
  assert.ok(result instanceof MutationFailure)
  assert.equal(result!.code, "BUDGET_EXCEEDED")
})

// --- Policy Checks ---

test("checkMutationPolicy blocks .git directory", () => {
  const result = checkMutationPolicy("/workspace", "/workspace/.git/config", DEFAULT_MUTATION_POLICY)
  assert.ok(result instanceof MutationFailure)
  assert.equal(result!.code, "SENSITIVE_PATH")
})

test("checkMutationPolicy blocks node_modules", () => {
  const result = checkMutationPolicy("/workspace", "/workspace/node_modules/pkg/index.js", DEFAULT_MUTATION_POLICY)
  assert.ok(result instanceof MutationFailure)
  assert.equal(result!.code, "SENSITIVE_PATH")
})

test("checkMutationPolicy allows normal src path", () => {
  const result = checkMutationPolicy("/workspace", "/workspace/src/main.ts", DEFAULT_MUTATION_POLICY)
  assert.equal(result, null)
})

test("isSensitivePath detects .env files", () => {
  assert.equal(isSensitivePath("/workspace", "/workspace/.env", DEFAULT_MUTATION_POLICY), true)
  assert.equal(isSensitivePath("/workspace", "/workspace/.env.local", DEFAULT_MUTATION_POLICY), true)
  assert.equal(isSensitivePath("/workspace", "/workspace/src/main.ts", DEFAULT_MUTATION_POLICY), false)
})

test("isSensitivePath detects key files", () => {
  assert.equal(isSensitivePath("/workspace", "/workspace/id_rsa", DEFAULT_MUTATION_POLICY), true)
  assert.equal(isSensitivePath("/workspace", "/workspace/server.key", DEFAULT_MUTATION_POLICY), true)
  assert.equal(isSensitivePath("/workspace", "/workspace/server.pem", DEFAULT_MUTATION_POLICY), true)
})

// --- Write Path Resolution ---

test("resolveWritePath resolves existing file safely", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "hello.txt", "content")
    const resolved = await resolveWritePath(ws, "hello.txt", { mustExist: true })
    assert.ok(resolved.endsWith("hello.txt"))
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("resolveWritePath rejects path traversal", async () => {
  const ws = await createTempWorkspace()
  try {
    await assert.rejects(
      resolveWritePath(ws, "../../../etc/passwd", { mustExist: true }),
      (err: MutationFailure) => err.code === "OUTSIDE_WORKSPACE",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("resolveWritePath rejects symlink escape for existing file", async () => {
  const ws = await createTempWorkspace()
  const outside = await createTempWorkspace()
  try {
    await createFile(outside, "secret.txt", "secret")
    await symlink(join(outside, "secret.txt"), join(ws, "link.txt"))
    await assert.rejects(
      resolveWritePath(ws, "link.txt", { mustExist: true }),
      (err: MutationFailure) => err.code === "SYMLINK_ESCAPE",
    )
  } finally {
    await rm(ws, { recursive: true })
    await rm(outside, { recursive: true })
  }
})

test("resolveWritePath resolves new file with valid parent", async () => {
  const ws = await createTempWorkspace()
  try {
    const resolved = await resolveWritePath(ws, "newfile.txt", { mustExist: false })
    assert.ok(resolved.endsWith("newfile.txt"))
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("resolveWritePath rejects new file with symlinked parent escape", async () => {
  const ws = await createTempWorkspace()
  const outside = await createTempWorkspace()
  try {
    await symlink(outside, join(ws, "escaped"))
    await assert.rejects(
      resolveWritePath(ws, "escaped/newfile.txt", { mustExist: false }),
      (err: MutationFailure) => err.code === "SYMLINK_ESCAPE",
    )
  } finally {
    await rm(ws, { recursive: true })
    await rm(outside, { recursive: true })
  }
})

test("resolveWritePath accepts a missing parent inside the workspace", async () => {
  const ws = await createTempWorkspace()
  try {
    const resolved = await resolveWritePath(ws, "nonexistent/subdir/file.txt", { mustExist: false })
    assert.equal(resolved, join(await realpath(ws), "nonexistent", "subdir", "file.txt"))
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Mutation Engine: Patch ---

test("preparePatch and apply produces correct file content", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "greeting.txt", "Hello World")
    const engine = deterministicEngine(ws)
    const request: MutationRequest = {
      operation: "patch",
      path: "greeting.txt",
      patch: { search: "Hello", replace: "Welcome" },
    }
    const prepared = await engine.preparePatch(request)
    assert.equal(prepared.operation, "patch")
    assert.equal(prepared.path, "greeting.txt")
    assert.ok(prepared.baseHash)
    assert.ok(prepared.resultHash)
    assert.notEqual(prepared.baseHash, prepared.resultHash)
    assert.equal(prepared.diff.linesAdded, 1)
    assert.equal(prepared.diff.linesRemoved, 1)
    assert.ok(prepared.diff.unified.includes("-Hello World"))
    assert.ok(prepared.diff.unified.includes("+Welcome World"))

    const result = await engine.applyPreparedMutation(prepared)
    assert.equal(result.status, "APPLIED")
    assert.ok(result.observation.includes("Mutation applied"))
    assert.ok(result.observation.includes("Verification: PASS"))

    const content = await readFile(join(ws, "greeting.txt"), "utf8")
    assert.equal(content, "Welcome World")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("patch rejects when search text not found", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "test.txt", "abc")
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.preparePatch({ operation: "patch", path: "test.txt", patch: { search: "xyz", replace: "q" } }),
      (err: MutationFailure) => err.code === "PATCH_MISMATCH",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("patch rejects ambiguous search text", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "test.txt", "foo bar foo")
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.preparePatch({ operation: "patch", path: "test.txt", patch: { search: "foo", replace: "baz" } }),
      (err: MutationFailure) => err.code === "PATCH_AMBIGUOUS",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("patch rejects binary file", async () => {
  const ws = await createTempWorkspace()
  try {
    const content = Buffer.alloc(100)
    content[50] = 0 // null byte
    await writeFile(join(ws, "binary.dat"), content)
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.preparePatch({ operation: "patch", path: "binary.dat", patch: { search: "x", replace: "y" } }),
      (err: MutationFailure) => err.code === "BINARY_FILE",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("patch rejects file in excluded directory", async () => {
  const ws = await createTempWorkspace()
  try {
    await mkdir(join(ws, ".git"), { recursive: true })
    await createFile(ws, ".git/config", "[core]")
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.preparePatch({ operation: "patch", path: ".git/config", patch: { search: "[core]", replace: "[new]" } }),
      (err: MutationFailure) => err.code === "SENSITIVE_PATH",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("patch rejects path traversal", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.preparePatch({ operation: "patch", path: "../../etc/passwd", patch: { search: "root", replace: "hacked" } }),
      (err: MutationFailure) => err.code === "OUTSIDE_WORKSPACE",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Mutation Engine: Create ---

test("prepareCreate and apply creates new file", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws)
    const request: MutationRequest = {
      operation: "create",
      path: "new-module.ts",
      content: "export const x = 42\n",
    }
    const prepared = await engine.prepareCreate(request)
    assert.equal(prepared.operation, "create")
    assert.equal(prepared.baseHash, "")
    assert.ok(prepared.resultHash)
    assert.ok(prepared.diff.unified.includes("--- /dev/null"))
    assert.ok(prepared.diff.unified.includes("+export const x = 42"))

    const result = await engine.applyPreparedMutation(prepared)
    assert.equal(result.status, "APPLIED")

    const content = await readFile(join(ws, "new-module.ts"), "utf8")
    assert.equal(content, "export const x = 42\n")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("prepareCreate and apply creates a missing parent directory", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws)
    const prepared = await engine.prepareCreate({
      operation: "create",
      path: "test/greeting.test.js",
      content: "import test from \"node:test\"\n",
    })
    const result = await engine.applyPreparedMutation(prepared)
    assert.equal(result.status, "APPLIED")
    assert.equal(await readFile(join(ws, "test/greeting.test.js"), "utf8"), "import test from \"node:test\"\n")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("create rejects when file already exists", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "existing.txt", "content")
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.prepareCreate({ operation: "create", path: "existing.txt", content: "new" }),
      (err: MutationFailure) => err.code === "FILE_EXISTS",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("create rejects binary extension", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.prepareCreate({ operation: "create", path: "data.bin", content: "text" }),
      (err: MutationFailure) => err.code === "BINARY_FILE",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("create rejects oversized file", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws, { budgets: { ...DEFAULT_MUTATION_BUDGETS, maxNewFileBytes: 10 } })
    await assert.rejects(
      engine.prepareCreate({ operation: "create", path: "big.ts", content: "a".repeat(100) }),
      (err: MutationFailure) => err.code === "OVERSIZED_FILE",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("create rejects path in node_modules", async () => {
  const ws = await createTempWorkspace()
  try {
    await mkdir(join(ws, "node_modules"), { recursive: true })
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.prepareCreate({ operation: "create", path: "node_modules/pkg.js", content: "hack" }),
      (err: MutationFailure) => err.code === "SENSITIVE_PATH",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Stale Base Protection ---

test("apply rejects stale base when file changed after preparation", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "volatile.txt", "original content")
    const engine = deterministicEngine(ws)
    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "volatile.txt",
      patch: { search: "original", replace: "modified" },
    })

    // External modification after preparation
    await writeFile(join(ws, "volatile.txt"), "external change", "utf8")

    const result = await engine.applyPreparedMutation(prepared)
    assert.equal(result.status, "STALE_BASE")
    assert.ok(result.error)
    assert.equal(result.error!.code, "STALE_BASE")

    // Verify file was NOT changed by the mutation
    const content = await readFile(join(ws, "volatile.txt"), "utf8")
    assert.equal(content, "external change")
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Rollback ---

test("rollback restores original content for patch", async () => {
  const ws = await createTempWorkspace()
  try {
    const originalContent = "const x = 1\n"
    await createFile(ws, "rollback.ts", originalContent)
    const engine = deterministicEngine(ws)

    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "rollback.ts",
      patch: { search: "const x = 1", replace: "const x = 2" },
    })
    const result = await engine.applyPreparedMutation(prepared)
    assert.equal(result.status, "APPLIED")

    // Verify changed
    assert.equal(await readFile(join(ws, "rollback.ts"), "utf8"), "const x = 2\n")

    // Rollback
    const rollbackResult = await engine.rollback(prepared.id)
    assert.equal(rollbackResult.status, "APPLIED")

    // Verify restored
    assert.equal(await readFile(join(ws, "rollback.ts"), "utf8"), originalContent)
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("rollback removes created file", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws)

    const prepared = await engine.prepareCreate({
      operation: "create",
      path: "temp.ts",
      content: "temporary",
    })
    await engine.applyPreparedMutation(prepared)

    // File exists
    assert.ok(await stat(join(ws, "temp.ts")))

    // Rollback
    await engine.rollback(prepared.id)

    // File removed
    await assert.rejects(stat(join(ws, "temp.ts")))
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("rollback detects conflict when file modified after mutation", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "conflict.txt", "before")
    const engine = deterministicEngine(ws)

    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "conflict.txt",
      patch: { search: "before", replace: "after" },
    })
    await engine.applyPreparedMutation(prepared)

    // External modification after mutation
    await writeFile(join(ws, "conflict.txt"), "someone else changed this", "utf8")

    // Rollback should detect conflict
    await assert.rejects(
      engine.rollback(prepared.id),
      (err: MutationFailure) => err.code === "ROLLBACK_CONFLICT",
    )

    // Verify external change preserved
    assert.equal(await readFile(join(ws, "conflict.txt"), "utf8"), "someone else changed this")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("rollback with no snapshot throws", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws)
    await assert.rejects(
      engine.rollback("nonexistent-id"),
      (err: MutationFailure) => err.code === "NO_SNAPSHOT",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Budget Enforcement ---

test("mutation engine enforces files-per-step budget", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws, {
      budgets: { ...DEFAULT_MUTATION_BUDGETS, maxFilesPerStep: 1 },
    })

    await createFile(ws, "file1.txt", "content1")
    await createFile(ws, "file2.txt", "content2")

    const p1 = await engine.preparePatch({ operation: "patch", path: "file1.txt", patch: { search: "content1", replace: "changed1" } })
    await engine.applyPreparedMutation(p1)

    // Second mutation should exceed budget
    await assert.rejects(
      engine.preparePatch({ operation: "patch", path: "file2.txt", patch: { search: "content2", replace: "changed2" } }),
      (err: MutationFailure) => err.code === "BUDGET_EXCEEDED",
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("mutation engine step counter resets", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws, {
      budgets: { ...DEFAULT_MUTATION_BUDGETS, maxFilesPerStep: 1 },
    })

    await createFile(ws, "file1.txt", "content1")
    await createFile(ws, "file2.txt", "content2")

    const p1 = await engine.preparePatch({ operation: "patch", path: "file1.txt", patch: { search: "content1", replace: "changed1" } })
    await engine.applyPreparedMutation(p1)

    engine.resetStepCounter()

    // After reset, should succeed
    const p2 = await engine.preparePatch({ operation: "patch", path: "file2.txt", patch: { search: "content2", replace: "changed2" } })
    await engine.applyPreparedMutation(p2)

    assert.equal(await readFile(join(ws, "file2.txt"), "utf8"), "changed2")
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Snapshot ---

test("snapshot is stored after successful mutation", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "snap.txt", "original")
    const engine = deterministicEngine(ws)

    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "snap.txt",
      patch: { search: "original", replace: "modified" },
    })
    await engine.applyPreparedMutation(prepared)

    const snapshot = engine.getSnapshot(prepared.id)
    assert.ok(snapshot)
    assert.equal(snapshot!.path, "snap.txt")
    assert.equal(snapshot!.operation, "patch")
    assert.equal(snapshot!.beforeContent, "original")
    assert.equal(snapshot!.beforeHash, prepared.baseHash)
    assert.equal(snapshot!.afterHash, prepared.resultHash)
    assert.equal(engine.snapshotCount, 1)
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("create snapshot records null beforeContent", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = deterministicEngine(ws)
    const prepared = await engine.prepareCreate({
      operation: "create",
      path: "created.txt",
      content: "new content",
    })
    await engine.applyPreparedMutation(prepared)

    const snapshot = engine.getSnapshot(prepared.id)
    assert.ok(snapshot)
    assert.equal(snapshot!.beforeContent, null)
    assert.equal(snapshot!.beforeHash, "")
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Bounded Observation ---

test("mutation observation is compact", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "obs.txt", "old value")
    const engine = deterministicEngine(ws)

    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "obs.txt",
      patch: { search: "old value", replace: "new value" },
    })
    const result = await engine.applyPreparedMutation(prepared)

    assert.ok(result.observation.includes("Mutation applied"))
    assert.ok(result.observation.includes("obs.txt"))
    assert.ok(result.observation.includes("Verification: PASS"))
    assert.ok(result.observation.includes("Result hash:"))
    // Observation should NOT contain full file contents
    assert.ok(!result.observation.includes("old value"))
    assert.ok(!result.observation.includes("new value"))
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Mutation Failure Observation ---

test("stale base produces failure observation", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "stale.txt", "version1")
    const engine = deterministicEngine(ws)

    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "stale.txt",
      patch: { search: "version1", replace: "version2" },
    })

    await writeFile(join(ws, "stale.txt"), "version3", "utf8")

    const result = await engine.applyPreparedMutation(prepared)
    assert.equal(result.status, "STALE_BASE")
    assert.ok(result.observation.includes("Mutation failed"))
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Hash Verification ---

test("post-write hash verification catches corruption", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "verify.txt", "content A")
    const engine = deterministicEngine(ws)

    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "verify.txt",
      patch: { search: "content A", replace: "content B" },
    })
    const result = await engine.applyPreparedMutation(prepared)
    assert.equal(result.status, "APPLIED")

    // Verify the result hash matches actual file
    const actualContent = await readFile(join(ws, "verify.txt"), "utf8")
    assert.equal(sha256(actualContent), prepared.resultHash)
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- FileChange Contract ---

test("prepared mutation includes complete FileChange", async () => {
  const ws = await createTempWorkspace()
  try {
    await createFile(ws, "change.txt", "before text")
    const engine = deterministicEngine(ws)

    const prepared = await engine.preparePatch({
      operation: "patch",
      path: "change.txt",
      patch: { search: "before", replace: "after" },
    })

    assert.equal(prepared.fileChange.path, "change.txt")
    assert.equal(prepared.fileChange.operation, "patch")
    assert.ok(prepared.fileChange.beforeSize > 0)
    assert.ok(prepared.fileChange.afterSize > 0)
    assert.equal(prepared.fileChange.beforeHash, prepared.baseHash)
    assert.equal(prepared.fileChange.afterHash, prepared.resultHash)
  } finally {
    await rm(ws, { recursive: true })
  }
})

// --- Symlink Write Escape ---

test("patch rejects symlink pointing outside workspace", async () => {
  const ws = await createTempWorkspace()
  const outside = await createTempWorkspace()
  try {
    await createFile(outside, "target.txt", "external content")
    await symlink(join(outside, "target.txt"), join(ws, "symlink.txt"))
    const engine = deterministicEngine(ws)

    await assert.rejects(
      engine.preparePatch({
        operation: "patch",
        path: "symlink.txt",
        patch: { search: "external", replace: "hacked" },
      }),
      (err: MutationFailure) => err.code === "SYMLINK_ESCAPE",
    )

    // Verify external file unchanged
    assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "external content")
  } finally {
    await rm(ws, { recursive: true })
    await rm(outside, { recursive: true })
  }
})

test("create rejects symlinked parent directory escape", async () => {
  const ws = await createTempWorkspace()
  const outside = await createTempWorkspace()
  try {
    await symlink(outside, join(ws, "escaped"))
    const engine = deterministicEngine(ws)

    await assert.rejects(
      engine.prepareCreate({
        operation: "create",
        path: "escaped/evil.txt",
        content: "malicious",
      }),
      (err: MutationFailure) => err.code === "SYMLINK_ESCAPE",
    )
  } finally {
    await rm(ws, { recursive: true })
    await rm(outside, { recursive: true })
  }
})

// --- MutationFailure Error Class ---

test("MutationFailure has correct name and code", () => {
  const err = new MutationFailure("STALE_BASE", "File changed")
  assert.equal(err.name, "MutationFailure")
  assert.equal(err.code, "STALE_BASE")
  assert.equal(err.message, "File changed")
  assert.ok(err instanceof Error)
})

// --- Default Budgets ---

test("default budgets are conservative", () => {
  assert.equal(DEFAULT_MUTATION_BUDGETS.maxFilesPerStep, 3)
  assert.ok(DEFAULT_MUTATION_BUDGETS.maxTotalChangedBytes <= 10_000)
  assert.ok(DEFAULT_MUTATION_BUDGETS.maxAddedLines <= 200)
  assert.ok(DEFAULT_MUTATION_BUDGETS.maxRemovedLines <= 100)
  assert.ok(DEFAULT_MUTATION_BUDGETS.maxNewFileBytes <= 8_192)
})

// --- No terminal or child_process ---

test("mutation engine does not import child_process", async () => {
  const { readFile: rf } = await import("node:fs/promises")
  const { resolve: r } = await import("node:path")
  const { existsSync } = await import("node:fs")
  const base = existsSync(r(process.cwd(), "packages/agent-core/src/tools/mutation-engine.ts"))
    ? r(process.cwd(), "packages/agent-core/src/tools")
    : r(process.cwd(), "src/tools")
  const engineSource = await rf(r(base, "mutation-engine.ts"), "utf8")
  const contractsSource = await rf(r(base, "mutation-contracts.ts"), "utf8")
  const registrySource = await rf(r(base, "mutation-registry.ts"), "utf8")

  for (const source of [engineSource, contractsSource, registrySource]) {
    assert.ok(!source.includes("child_process"), "Must not import child_process")
    assert.ok(!source.includes("exec("), "Must not call exec()")
    assert.ok(!source.includes("spawn("), "Must not call spawn()")
  }
})

test("mutation engine does not import model/inference dependencies", async () => {
  const { readFile: rf } = await import("node:fs/promises")
  const { resolve: r } = await import("node:path")
  const { existsSync } = await import("node:fs")
  const base = existsSync(r(process.cwd(), "packages/agent-core/src/tools/mutation-engine.ts"))
    ? r(process.cwd(), "packages/agent-core/src/tools")
    : r(process.cwd(), "src/tools")
  const engineSource = await rf(r(base, "mutation-engine.ts"), "utf8")

  assert.ok(!engineSource.includes("ollama"), "Must not reference ollama")
  assert.ok(!engineSource.includes("openai"), "Must not reference openai")
  assert.ok(!engineSource.includes("@anthropic"), "Must not reference anthropic")
})
