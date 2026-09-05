import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

const FORBIDDEN_IMPORT_PATTERNS = [
  /@kilocode\//,
  /^['"]vscode['"]$/,
  /@anthropic-ai\//,
  /@google\/genai/,
  /@aws-sdk\//,
  /@azure\//,
  /['"]openai['"]/, // Match npm package "openai", not local "./openai-compatible.ts"
  /['"]node:child_process['"]|['"]child_process['"]/,
]

async function getFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      files.push(...(await getFilesRecursively(fullPath)))
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      files.push(fullPath)
    }
  }
  return files
}

test("agent-core codebase maintains strict zero-baggage architectural boundary", async () => {
  const srcDir = path.resolve(new URL(".", import.meta.url).pathname, "../src")
  const srcFiles = await getFilesRecursively(srcDir)

  for (const filePath of srcFiles) {
    const content = await fs.readFile(filePath, "utf-8")
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!line.includes("import") && !line.includes("require")) continue

      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.source.includes("child_process") && (filePath.endsWith("verification-engine.ts") || filePath.endsWith("kill-process-tree.ts") || filePath.endsWith("mcp-transport.ts"))) {
          continue
        }
        assert.equal(
          pattern.test(line),
          false,
          `Forbidden import matching ${pattern} found in ${path.relative(process.cwd(), filePath)}:${i + 1} -> ${line}`,
        )
      }
    }
  }
})

test("agent-core exports only public contracts and decoupled modules", async () => {
  const index = await import("../src/index.ts")

  assert.ok(index.AgentRunner)
  assert.ok(index.ScriptedModelProvider)
  assert.ok(index.OpenAICompatibleProvider)
  assert.ok(index.normalizeWireResponse)
  assert.ok(index.probeBackend)
  assert.ok(index.createReadOnlyToolRegistry)
  assert.ok(index.compileContext)
  assert.ok(index.calculateBudget)
  assert.ok(index.MutationEngine)
  assert.ok(index.MutationFailure)
  assert.ok(index.createMutationToolRegistrations)
  assert.ok(index.sha256)
})

test("benchmark results use single canonical root-level directory regardless of working directory", async () => {
  const { getCanonicalEvalsDir } = await import("./evals/run-benchmark-cli.ts")
  const canonicalDir = getCanonicalEvalsDir()

  assert.ok(canonicalDir.endsWith(path.join("evals", "results")))
  assert.ok(!canonicalDir.includes(path.join("packages", "agent-core", "evals")))

  // Check that duplicate nested evals directory in packages/agent-core does not exist
  const nestedEvals = path.resolve(process.cwd(), "evals")
  const exists = await fs.stat(nestedEvals).then(() => true).catch(() => false)
  // If cwd is packages/agent-core, nestedEvals is packages/agent-core/evals
  if (process.cwd().endsWith("agent-core")) {
    assert.equal(exists, false, "Nested packages/agent-core/evals directory must not exist")
  }
})

test("repository does not contain model weight files", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..")
  const MODEL_WEIGHT_EXTENSIONS = [".gguf", ".safetensors", ".ckpt"]

  async function findModelWeights(dir: string, maxDepth = 5): Promise<string[]> {
    if (maxDepth <= 0) return []
    const found: string[] = []
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        found.push(...(await findModelWeights(fullPath, maxDepth - 1)))
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (MODEL_WEIGHT_EXTENSIONS.includes(ext)) {
          found.push(path.relative(repoRoot, fullPath))
        }
      }
    }
    return found
  }

  const weights = await findModelWeights(repoRoot)
  assert.equal(weights.length, 0, `Model weight files found in repository: ${weights.join(", ")}`)
})

