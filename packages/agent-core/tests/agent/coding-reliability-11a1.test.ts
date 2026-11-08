import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import type { AgentResult } from "../../src/contracts/agent.ts"
import { classifyTaskProfile, isSocialTurn } from "../../src/agent/task-profile.ts"
import { assessCodingCompletion, describeToolContractFault, implementationChangeRequired, requiredEditPaths } from "../../src/agent/tool-contract.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { readRepositoryFile } from "../../src/tools/read-file.ts"
import { ToolRegistry, type ToolRegistration } from "../../src/tools/registry.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function readTool(): ToolRegistration {
  return {
    definition: { name: "read_file", description: "Read one repository file.", action: "read_repository", inputSchema: { type: "object" } },
    validate: (input) => {
      const path = input && typeof input === "object" && !Array.isArray(input) ? (input as { path?: unknown }).path : undefined
      if (typeof path !== "string" || !path.trim()) throw new TypeError("path must be a non-empty string")
      return { path }
    },
    execute: (input, context) => readRepositoryFile(context.workspaceRoot, input.path as string),
  }
}

function verificationTool(status: "PASS" | "FAIL"): ToolRegistration {
  return {
    definition: { name: "run_verification", description: "Run the project tests.", action: "run_known_test", inputSchema: { type: "object" } },
    validate: () => ({}),
    execute: async () => ({ status, exitCode: status === "PASS" ? 0 : 1, stdout: status, stderr: "" }),
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-11a1-"))
  await mkdir(join(root, "src"))
  await mkdir(join(root, "test"))
  await writeFile(join(root, "src/add.ts"), "export function add(left: number, right: number) {\n  return left - right\n}\n")
  await writeFile(join(root, "src/format-note.ts"), "export function formatNote(title: string, body: string) {\n  return `# ${title}\\n\\n${body}\\n`\n}\n")
  await writeFile(join(root, "test/format-note.test.ts"), "import test from \"node:test\"\n")
  await writeFile(join(root, "README.md"), "# notes\n")
  return root
}

function registry(root: string, extra: ToolRegistration[] = []): ToolRegistry {
  const engine = new MutationEngine(root)
  return new ToolRegistry([readTool(), ...createMutationToolRegistrations({ engine }), ...extra])
}

function runner(provider: ScriptedModelProvider, tools: ToolRegistry): AgentRunner {
  return new AgentRunner({
    provider,
    registry: tools,
    eventFactory: { createId: () => "event", now: () => "2026-11-06T12:00:00.000Z" },
  })
}

async function runTask(provider: ScriptedModelProvider, root: string, instruction: string, mode: "ASK" | "BUILD" | "DEBUG" = "BUILD", maxTurns = 8, extra: ToolRegistration[] = []): Promise<{ runner: AgentRunner; result: AgentResult }> {
  const agent = runner(provider, registry(root, extra))
  let result = await agent.run({
    task: { id: "task", mode, instruction },
    workspaceRoot: root,
    maxTurns,
    contextBudget: budget,
    projectInstructions: [],
  })
  let guard = 0
  while (result.status === "PAUSED" && guard < 8) {
    result = await agent.resume("APPROVE")
    guard += 1
  }
  return { runner: agent, result }
}

test("tool contract messages name the canonical edit tools", () => {
  const unknown = describeToolContractFault({ toolName: "modify_file", code: "UNKNOWN_TOOL", message: "Unknown tool: modify_file" })
  assert.match(unknown?.message ?? "", /UNKNOWN_TOOL: modify_file is unavailable/)
  assert.match(unknown?.message ?? "", /apply_patch\(path, search, replace\)/)
  const exists = describeToolContractFault({ toolName: "create_file", code: "FILE_EXISTS", message: "Cannot create file that already exists: test/example.test.ts", path: "test/example.test.ts" })
  assert.match(exists?.message ?? "", /FILE_ALREADY_EXISTS: create_file cannot overwrite test\/example\.test\.ts/)
  const path = describeToolContractFault({ toolName: "read_file", code: "OUTSIDE_WORKSPACE", message: "Path is outside workspace: /etc/passwd", path: "/etc/passwd" })
  assert.match(path?.message ?? "", /INVALID_PATH: use a workspace-relative path such as src\/add\.ts/)
})

test("a test-only mutation is not a behavior change", () => {
  assert.equal(implementationChangeRequired("Reject empty title or body in formatNote, update the unit tests, and run the tests.", []), true)
  const verdict = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: [],
    requireImplementationChange: true,
    mutations: [{ path: "test/format-note.test.mjs", status: "APPLIED", at: "2026-11-06T00:00:01.000Z" }],
    verifications: [{ status: "PASS", at: "2026-11-06T00:00:02.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
    scheduledVerification: "PASSED",
  })
  assert.equal(verdict.accept, false)
  assert.equal(verdict.editsSatisfied, false)
  assert.equal(verdict.failureReason, "INCOMPLETE")
  assert.match(verdict.summary, /implementation was not modified/)
  assert.match(verdict.summary, /test\/format-note\.test\.mjs/)
})

test("a created test-named file is not the implementation change", () => {
  const verdict = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: [],
    requireImplementationChange: true,
    requireExistingFileEdit: true,
    mutations: [{ path: "src/tests", status: "APPLIED", at: "2026-11-06T00:00:01.000Z", operation: "create" }],
    verifications: [{ status: "PASS", at: "2026-11-06T00:00:02.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
    scheduledVerification: "PASSED",
  })
  assert.equal(verdict.accept, false)
  assert.match(verdict.summary, /implementation was not modified/)
})

test("creating an unrelated file does not change the existing implementation", () => {
  const verdict = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: [],
    requireImplementationChange: true,
    requireExistingFileEdit: true,
    mutations: [{ path: "src/helper.mjs", status: "APPLIED", at: "2026-11-06T00:00:01.000Z", operation: "create" }],
    verifications: [{ status: "PASS", at: "2026-11-06T00:00:02.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
    scheduledVerification: "PASSED",
  })
  assert.equal(verdict.accept, false)
  assert.match(verdict.summary, /existing implementation was not modified/)
})

test("a file named only as context is not a required edit", () => {
  const instruction = "Read src/sum.mjs and test/sum.test.mjs, then fix only src/sum.mjs so npm test passes. Do not edit the test."
  const mentioned = ["src/sum.mjs", "test/sum.test.mjs"]
  assert.deepEqual(requiredEditPaths(instruction, mentioned), ["src/sum.mjs"])
  assert.deepEqual(
    requiredEditPaths("Change the prefix in both src/item.mjs and test/item.test.mjs, then run the tests.", ["src/item.mjs", "test/item.test.mjs"]),
    ["src/item.mjs", "test/item.test.mjs"],
  )
  const verdict = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: requiredEditPaths(instruction, mentioned),
    requireImplementationChange: true,
    mutations: [{ path: "src/sum.mjs", status: "APPLIED", at: "2026-11-07T00:00:01.000Z", operation: "patch" }],
    verifications: [{ status: "PASS", at: "2026-11-07T00:00:02.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
    scheduledVerification: "PASSED",
  })
  assert.equal(verdict.accept, true)
  assert.match(verdict.summary, /src\/sum\.mjs/)
})

test("a file the user said not to edit is not required", () => {
  const instruction = "npm test fails because src/greet.mjs declares farewell twice. Remove the duplicate and do not edit test/greet.test.mjs."
  const mentioned = ["src/greet.mjs", "test/greet.test.mjs"]
  assert.deepEqual(requiredEditPaths(instruction, mentioned), ["src/greet.mjs"])
  const verdict = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: requiredEditPaths(instruction, mentioned),
    requireImplementationChange: true,
    mutations: [{ path: "src/greet.mjs", status: "APPLIED", at: "2026-11-07T00:00:01.000Z", operation: "patch" }],
    verifications: [{ status: "PASS", at: "2026-11-07T00:00:02.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
    scheduledVerification: "PASSED",
  })
  assert.equal(verdict.accept, true)
  assert.doesNotMatch(verdict.summary, /did not include/)
})

test("an edit with no applied change cannot report success", () => {
  const verdict = assessCodingCompletion({
    requiresCodeChange: true,
    explicitPaths: ["src/add.ts"],
    mutations: [],
    verifications: [{ status: "PASS", at: "2026-11-06T00:00:00.000Z" }],
    verificationRequired: true,
    userRejectedMutation: false,
    scheduledVerification: "PASSED",
  })
  assert.equal(verdict.accept, false)
  assert.equal(verdict.failureReason, "INCOMPLETE")
})

test("a change request is a coding task even without the word fix", () => {
  assert.equal(classifyTaskProfile("Change the greeting prefix in src/greet.mjs from hi to hello, and run the tests.", "BUILD").requiresCodeChange, true)
  assert.equal(classifyTaskProfile("What does this project do?", "BUILD").requiresCodeChange, false)
})

test("further tool calls after a passing edit are not executed", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("", [{ id: "verify", name: "run_verification", arguments: {} }]),
    response("", [{ id: "again", name: "run_verification", arguments: {} }]),
    response("should not run"),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts and run the tests.", "DEBUG", 8, [verificationTool("PASS")])
    assert.equal(result.status, "COMPLETED")
    assert.equal(provider.requests.length, 2)
    assert.equal(result.toolCalls.filter((call) => call.name === "run_verification").length, 1)
    assert.match(await readFile(join(root, "src/add.ts"), "utf8"), /return left \+ right/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a greeting in agent mode is a direct reply and does not require an edit", () => {
  assert.equal(isSocialTurn("hola"), true)
  assert.equal(isSocialTurn("hello"), true)
  assert.equal(isSocialTurn("Fix the implementation in src/add.ts"), false)
  const profile = classifyTaskProfile("hola", "BUILD")
  assert.equal(profile.directReply, true)
  assert.equal(profile.requiresCodeChange, false)
  assert.equal(classifyTaskProfile("Why is this test failing?", "BUILD").requiresCodeChange, false)
  assert.equal(classifyTaskProfile("Explain this function.", "BUILD").requiresCodeChange, false)
  assert.equal(classifyTaskProfile("What does this project do?", "BUILD").requiresCodeChange, false)
})

test("a greeting in agent mode completes without a tool call or a non-progress failure", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("Hola. Dime en qué quieres que trabaje."),
    response("should not run"),
  ])
  try {
    const { result } = await runTask(provider, root, "hola", "BUILD")
    assert.equal(result.status, "COMPLETED")
    assert.equal(result.failureReason, undefined)
    assert.match(result.finalAnswer ?? "", /Hola/)
    assert.equal(provider.requests.length, 1)
    assert.match(provider.requests[0]?.messages[0]?.content ?? "", /CONVERSATION/)
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8").then((text) => text.includes("return left - right")), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a greeting that starts as a tool call still answers instead of failing non-progress", async () => {
  const root = await workspace()
  const read = { id: "read", name: "read_file", arguments: { path: "README.md" } }
  const provider = new ScriptedModelProvider([
    response("", [read]),
    response("Hola. No hace falta cambiar archivos."),
  ])
  try {
    const { result } = await runTask(provider, root, "hola", "BUILD", 8)
    assert.equal(result.status, "COMPLETED")
    assert.notEqual(result.failureReason, "NON_PROGRESS")
    assert.match(result.finalAnswer ?? "", /Hola/)
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "# notes\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ask and plan tasks are not required to mutate", () => {
  assert.equal(classifyTaskProfile("Explain src/add.ts", "ASK").requiresCodeChange, false)
  assert.equal(classifyTaskProfile("Update src/add.ts", "PLAN").requiresCodeChange, false)
  assert.equal(classifyTaskProfile("Fix the implementation in src/add.ts", "BUILD").requiresCodeChange, true)
  assert.equal(classifyTaskProfile("What does this project do?", "BUILD").requiresCodeChange, false)
})

test("exposes apply_patch and create_file and withholds modify_file", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    (request) => {
      const tools = request.tools ?? []
      assert.deepEqual(tools.map((tool) => tool.name).filter((name) => ["apply_patch", "create_file", "modify_file"].includes(name)).toSorted(), ["apply_patch", "create_file"])
      const patch = tools.find((tool) => tool.name === "apply_patch")
      const created = tools.find((tool) => tool.name === "create_file")
      assert.match(patch?.description ?? "", /existing/)
      assert.match(created?.description ?? "", /does not already exist/)
      assert.match(request.messages[0]!.content, /modify_file is not available/)
      return response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }])
    },
    response("The file subtracts."),
  ])
  try {
    const { result } = await runTask(provider, root, "Explain src/add.ts", "BUILD")
    assert.equal(result.status, "COMPLETED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unknown tool receives one correction and a later patch is prepared", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "bad", name: "modify_file", arguments: { path: "src/add.ts" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /UNKNOWN_TOOL: modify_file is unavailable/)
      return response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }])
    },
  ])
  try {
    const agent = runner(provider, registry(root))
    const paused = await agent.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix the implementation in src/add.ts" },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    assert.equal(paused.confirmation?.toolName, "apply_patch")
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), "export function add(left: number, right: number) {\n  return left - right\n}\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("create_file on an existing file points the model at apply_patch", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "test/format-note.test.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "create", name: "create_file", arguments: { path: "test/format-note.test.ts", content: "overwrite\n" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /FILE_ALREADY_EXISTS: create_file cannot overwrite test\/format-note\.test\.ts/)
      return response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/format-note.ts", search: "return `# ${title}", replace: "if (!title || !body) throw new Error(\"empty\")\n  return `# ${title}" } }])
    },
  ])
  try {
    const agent = runner(provider, registry(root))
    const paused = await agent.run({
      task: { id: "task", mode: "BUILD", instruction: "Reject empty title or body in formatNote, update the unit tests, and run the tests." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    assert.equal(paused.confirmation?.toolName, "apply_patch")
    assert.equal(await readFile(join(root, "test/format-note.test.ts"), "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an invalid path is corrected to a workspace-relative path", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "bad", name: "read_file", arguments: { path: "/etc/passwd" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /INVALID_PATH: use a workspace-relative path such as src\/add\.ts/)
      return response("", [{ id: "good", name: "read_file", arguments: { path: "src/add.ts" } }])
    },
    response("add subtracts."),
  ])
  try {
    const { result } = await runTask(provider, root, "Explain src/add.ts", "ASK")
    assert.equal(result.status, "COMPLETED")
    assert.equal(result.toolCalls.at(-1)?.outcome, "COMPLETED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a repeated invalid tool call stops instead of looping", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "bad-1", name: "modify_file", arguments: { path: "src/add.ts" } }]),
    response("", [{ id: "bad-2", name: "modify_file", arguments: { path: "src/add.ts" } }]),
    response("should not run"),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts")
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "INCOMPLETE")
    assert.match(result.finalAnswer ?? "", /repeated tool-contract error/)
    assert.equal(provider.requests.length, 2)
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), "export function add(left: number, right: number) {\n  return left - right\n}\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a rejected mutation does not change the file and is not success", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/add.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response(""),
  ])
  try {
    const agent = runner(provider, registry(root))
    const paused = await agent.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix the implementation in src/add.ts" },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    const result = await agent.resume("REJECT")
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "REJECTED")
    assert.match(result.finalAnswer ?? "", /rejected/)
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("passing tests without the requested edit are incomplete", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/format-note.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "r1", name: "read_file", arguments: { path: "src/format-note.ts" } }]),
    response("", [{ id: "r2", name: "read_file", arguments: { path: "test/format-note.test.ts" } }]),
    response("", [{ id: "create", name: "create_file", arguments: { path: "test/format-note.test.ts", content: "nope\n" } }]),
    response("", [{ id: "verify", name: "run_verification", arguments: {} }]),
    response(""),
    response(""),
    response(""),
  ])
  try {
    const { result } = await runTask(
      provider,
      root,
      "Reject empty title or body in formatNote, update the unit tests, and run the tests.",
      "BUILD",
      8,
      [verificationTool("PASS")],
    )
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "INCOMPLETE")
    assert.match(result.finalAnswer ?? "", /No files were changed/)
    assert.equal(result.finalAnswer?.trim().length, result.finalAnswer?.length)
    assert.notEqual(result.finalAnswer, "")
    assert.equal(await readFile(join(root, "src/format-note.ts"), "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an approved patch that matches the requested file can complete", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("", [{ id: "verify", name: "run_verification", arguments: {} }]),
    response("add now returns the sum."),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts and run the tests.", "DEBUG", 6, [verificationTool("PASS")])
    assert.equal(result.status, "COMPLETED")
    assert.match(await readFile(join(root, "src/add.ts"), "utf8"), /return left \+ right/)
    assert.match(result.finalAnswer ?? "", /src\/add\.ts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an unrelated file change does not satisfy the requested edit", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "README.md", search: "# notes", replace: "# edited" } }]),
    response("done"),
    response("still done"),
    response("stopping"),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts")
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "INCOMPLETE")
    assert.match(await readFile(join(root, "src/add.ts"), "utf8"), /return left - right/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed verification is not reported as success", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("", [{ id: "verify", name: "run_verification", arguments: {} }]),
    response("I think it passed."),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts and run the tests.", "BUILD", 6, [verificationTool("FAIL")])
    assert.notEqual(result.status, "COMPLETED")
    assert.match(result.finalAnswer ?? "", /fail|Failed|failed|verification/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an empty final answer on a finished edit uses the execution summary", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("", [{ id: "verify", name: "run_verification", arguments: {} }]),
    response("   "),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts and run the tests.", "BUILD", 6, [verificationTool("PASS")])
    assert.equal(result.status, "COMPLETED")
    assert.match(result.finalAnswer ?? "", /src\/add\.ts/)
    assert.match(result.finalAnswer ?? "", /Tests passed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("turn budget exhaustion names the stop reason", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    response("too late"),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts", "BUILD", 1)
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "MAX_TURNS_EXCEEDED")
    assert.match(result.finalAnswer ?? "", /turn budget was exhausted/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancellation does not leave a success summary", async () => {
  const root = await workspace()
  const controller = new AbortController()
  const provider = new ScriptedModelProvider([
    async (request) => {
      controller.abort()
      request.signal?.throwIfAborted()
      return response("unreachable")
    },
  ])
  try {
    const agent = runner(provider, registry(root))
    const result = await agent.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix the implementation in src/add.ts" },
      workspaceRoot: root,
      maxTurns: 3,
      contextBudget: budget,
      projectInstructions: [],
      signal: controller.signal,
    })
    assert.equal(result.status, "CANCELLED")
    assert.match(result.finalAnswer ?? "", /cancelled/i)
    assert.doesNotMatch(result.finalAnswer ?? "", /The requested edit was applied/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an edit task keeps tool use available after the files have been read", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/add.ts" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /EDIT REQUIRED/)
      assert.doesNotMatch(request.messages[0]!.content, /DO NOT call any more tools/)
      return response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }])
    },
  ])
  try {
    const agent = runner(provider, registry(root))
    const paused = await agent.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix the implementation in src/add.ts" },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ask mode denies a write and leaves the file unchanged", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/add.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("I cannot edit in this mode."),
  ])
  try {
    const { result } = await runTask(provider, root, "Update the function in src/add.ts", "ASK")
    assert.equal(result.toolCalls[0]?.outcome, "DENIED")
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), before)
    assert.notEqual(result.status, "PAUSED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a test-only edit does not complete a behavior change", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/format-note.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "test/format-note.test.ts", search: "import test from \"node:test\"", replace: "import test from \"node:test\"\n// empty title is ignored" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /EDIT REQUIRED/)
      assert.doesNotMatch(request.messages[0]!.content, /DO NOT call any more tools/)
      return response("", [{ id: "verify", name: "run_verification", arguments: {} }])
    },
    response("The tests pass."),
    response("No further change."),
    response("Stopping."),
  ])
  try {
    const { result } = await runTask(
      provider,
      root,
      "Reject empty title or body in formatNote, update the unit tests, and run the tests.",
      "BUILD",
      6,
      [verificationTool("PASS")],
    )
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "INCOMPLETE")
    assert.match(result.finalAnswer ?? "", /implementation was not modified/)
    assert.equal(await readFile(join(root, "src/format-note.ts"), "utf8"), before)
    assert.deepEqual(result.appliedMutations?.map((mutation) => mutation.path), ["test/format-note.test.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a coding task that answers without tools is told to edit", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("I will fix it in a moment."),
    (request) => {
      assert.match(request.messages[0]!.content, /EDIT REQUIRED/)
      return response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }])
    },
    response("", [{ id: "verify", name: "run_verification", arguments: {} }]),
    response("add now returns the sum."),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts and run the tests.", "DEBUG", 6, [verificationTool("PASS")])
    assert.equal(result.status, "COMPLETED", `${result.failureReason ?? ""} ${result.finalAnswer ?? ""}`)
    assert.match(await readFile(join(root, "src/add.ts"), "utf8"), /return left \+ right/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verification runs after an applied edit even if the model stops calling tools", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("done"),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts and run the tests.", "DEBUG", 6, [verificationTool("PASS")])
    assert.equal(result.status, "COMPLETED", `${result.failureReason ?? ""} ${result.finalAnswer ?? ""}`)
    assert.equal(result.toolCalls.some((call) => call.name === "run_verification"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verification stays available after the implementation edit", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    (request) => {
      const content = request.messages[0]!.content
      assert.match(content, /\[VERIFICATION REQUIRED\]/)
      assert.doesNotMatch(content, /\[STATUS: EVIDENCE READY\]/)
      return response("", [{ id: "verify", name: "run_verification", arguments: {} }])
    },
    response("add now returns the sum."),
  ])
  try {
    const { result } = await runTask(provider, root, "Fix the implementation in src/add.ts and run the tests.", "DEBUG", 6, [verificationTool("PASS")])
    assert.equal(result.status, "COMPLETED", `${result.failureReason ?? ""} ${result.finalAnswer ?? ""}`)
    assert.equal(result.toolCalls.filter((call) => call.name === "run_verification").length, 1)
    assert.deepEqual(result.appliedMutations?.map((mutation) => mutation.path), ["src/add.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a multi-file edit completes only after both requested files change", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read-impl", name: "read_file", arguments: { path: "src/format-note.ts" } }]),
    response("", [{ id: "read-test", name: "read_file", arguments: { path: "test/format-note.test.ts" } }]),
    response("", [{ id: "impl", name: "apply_patch", arguments: { path: "src/format-note.ts", search: "return `# ${title}", replace: "if (!title || !body) throw new Error(\"empty\")\n  return `# ${title}" } }]),
    response("", [{ id: "test", name: "apply_patch", arguments: { path: "test/format-note.test.ts", search: "import test from \"node:test\"", replace: "import test from \"node:test\"\n// empty title is rejected" } }]),
    response("", [{ id: "verify", name: "run_verification", arguments: {} }]),
    response("Both files now reject an empty note."),
  ])
  try {
    const { result } = await runTask(
      provider,
      root,
      "Update src/format-note.ts and test/format-note.test.ts, then run the tests.",
      "BUILD",
      8,
      [verificationTool("PASS")],
    )
    assert.equal(result.status, "COMPLETED")
    assert.match(await readFile(join(root, "src/format-note.ts"), "utf8"), /empty/)
    assert.match(await readFile(join(root, "test/format-note.test.ts"), "utf8"), /empty title/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a path the user forbade is not written", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/add.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("Leaving src/add.ts unchanged."),
  ])
  try {
    const { result } = await runTask(provider, root, "Read src/add.ts. Do not modify src/add.ts.", "BUILD", 4)
    assert.notEqual(result.status, "PAUSED")
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), before)
    assert.equal(result.appliedMutations?.length ?? 0, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a patch that repeats an exported function is refused", async () => {
  const root = await workspace()
  const source = "export function greet(name) {\n  return \"Hello, \" + name\n}\n\nexport function farewell(name) {\n  return \"Goodbye, \" + name\n}\n"
  await writeFile(join(root, "src/greet.mjs"), source)
  const provider = new ScriptedModelProvider([
    response("", [{
      id: "patch",
      name: "apply_patch",
      arguments: {
        path: "src/greet.mjs",
        search: "export function farewell(name) {\n  return \"Goodbye, \" + name\n}\n",
        replace: "export function farewell(name) {\n  return \"Goodbye, \" + name\n}\n\nexport function farewell(name) {\n  return \"Goodbye, \" + name\n}\n",
      },
    }]),
    response("The duplicate was not written."),
  ])
  try {
    await runTask(provider, root, "Add farewell to src/greet.mjs. Do not edit test/format-note.test.ts.", "BUILD", 4)
    assert.equal(await readFile(join(root, "src/greet.mjs"), "utf8"), source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
