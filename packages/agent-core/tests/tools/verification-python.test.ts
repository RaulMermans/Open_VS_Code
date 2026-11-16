import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { discoverVerificationCommand } from "../../src/tools/verification-discovery.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ovsc-pyverify-")))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  return root
}

async function execute(root: string) {
  const command = await discoverVerificationCommand(root, "TEST")
  const engine = new VerificationEngine({ workspaceRoot: root })
  const result = await engine.execute({
    verificationId: "py",
    action: "TEST",
    executable: command.executable,
    args: command.args,
    cwd: root,
    timeoutMs: 30_000,
    commandPreview: `${command.executable} ${command.args.join(" ")}`,
    packageJsonPath: command.packageJsonPath,
    packageJsonHash: command.packageJsonHash,
    scriptName: command.scriptName,
    scriptBody: command.scriptBody,
  })
  return { command, result }
}

const PASSING = "import unittest\nfrom src.mod import value\n\nclass T(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(value(), 1)\n"

test("a Python package with tests/__init__.py runs stdlib unittest discovery and reports PASS", async () => {
  const root = await fixture({ "src/__init__.py": "", "src/mod.py": "def value():\n    return 1\n", "tests/__init__.py": "", "tests/test_mod.py": PASSING })
  try {
    const { command, result } = await execute(root)
    assert.match(command.executable, /python3$/)
    assert.deepEqual(command.args, ["-m", "unittest", "discover", "-s", "tests", "-t", "."])
    assert.equal(result.status, "PASS", result.stderr)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failing Python test is FAIL with the assertion in the output", async () => {
  const root = await fixture({ "src/__init__.py": "", "src/mod.py": "def value():\n    return 2\n", "tests/__init__.py": "", "tests/test_mod.py": PASSING })
  try {
    const { result } = await execute(root)
    assert.equal(result.status, "FAIL")
    assert.match(result.stdout + result.stderr, /AssertionError: 2 != 1/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a tests directory without __init__.py is discovered without a top-level directory", async () => {
  const root = await fixture({ "src/__init__.py": "", "src/mod.py": "def value():\n    return 1\n", "tests/test_mod.py": PASSING })
  try {
    const { command, result } = await execute(root)
    assert.deepEqual(command.args, ["-m", "unittest", "discover", "-s", "tests"])
    assert.equal(result.status, "PASS", result.stdout + result.stderr)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an exit code of 0 with zero tests run is not a PASS", async () => {
  const root = await fixture({ "tests/__init__.py": "", "tests/test_empty.py": "# no tests here\n" })
  try {
    const { result } = await execute(root)
    // Python >= 3.12 exits 5 on "NO TESTS RAN"; older versions exit 0 and the engine's gate fails it.
    assert.equal(result.status, "FAIL")
    assert.match(result.stdout + result.stderr, /Ran 0 tests|did not report a passing test/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Django-style projects use manage.py test and pytest is used only when the repository configures it", async () => {
  const django = await fixture({ "manage.py": "print('Ran 0 tests in 0.000s')\n", "app/tests.py": "" })
  const pytestRepo = await fixture({ "pytest.ini": "[pytest]\n", "tests/test_mod.py": PASSING })
  try {
    assert.deepEqual((await discoverVerificationCommand(django, "TEST")).args, ["manage.py", "test"])
    assert.equal((await execute(django)).result.status, "FAIL", "a fake manage.py that runs no tests is not a PASS")
    assert.deepEqual((await discoverVerificationCommand(pytestRepo, "TEST")).args, ["-m", "pytest", "-q"])
  } finally {
    await rm(django, { recursive: true, force: true })
    await rm(pytestRepo, { recursive: true, force: true })
  }
})

test("a repository with no package.json and no recognizable tests still has no verifier", async () => {
  const root = await fixture({ "src/mod.py": "x = 1\n" })
  try {
    await assert.rejects(discoverVerificationCommand(root, "TEST"), /package\.json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
