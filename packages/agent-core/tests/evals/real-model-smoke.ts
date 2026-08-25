import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

export interface SmokeTestResult {
  readonly test: string
  readonly passed: boolean
  readonly latencyMs: number
  readonly response?: string
  readonly toolCalls?: readonly unknown[]
  readonly error?: string
}

export async function runRealModelSmoke(
  baseUrl = "http://localhost:11434/v1",
  model = "qwen2.5-coder:7b",
): Promise<readonly SmokeTestResult[]> {
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    model,
    timeoutMs: 60_000,
    capabilities: ["chat", "tools"],
  })
  const registry = createReadOnlyToolRegistry()
  const tools = registry.listDefinitions()

  const results: SmokeTestResult[] = []

  // A. Plain chat
  try {
    const t0 = Date.now()
    const res = await provider.complete({
      messages: [{ role: "user", content: "Reply with exactly 'READY' and nothing else." }],
      temperature: 0,
      maxOutputTokens: 20,
    })
    const passed = res.message.content.trim().includes("READY")
    results.push({
      test: "A_plain_chat",
      passed,
      latencyMs: Date.now() - t0,
      response: res.message.content.trim(),
    })
  } catch (error) {
    results.push({
      test: "A_plain_chat",
      passed: false,
      latencyMs: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // B. Tool schema comprehension
  try {
    const t0 = Date.now()
    const res = await provider.complete({
      messages: [
        {
          role: "user",
          content: "Find what files exist in the project directory using the available tools.",
        },
      ],
      tools,
      temperature: 0,
      maxOutputTokens: 100,
    })
    const hasToolCall = Boolean(res.toolCalls && res.toolCalls.length > 0)
    const toolName = res.toolCalls?.[0]?.name
    const isExpectedTool = toolName === "find_files" || toolName === "list_directory"
    results.push({
      test: "B_tool_schema_comprehension",
      passed: hasToolCall && isExpectedTool,
      latencyMs: Date.now() - t0,
      ...(res.toolCalls ? { toolCalls: res.toolCalls } : {}),
      response: res.message.content,
    })
  } catch (error) {
    results.push({
      test: "B_tool_schema_comprehension",
      passed: false,
      latencyMs: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // C. Tool arguments validity
  try {
    const t0 = Date.now()
    const res = await provider.complete({
      messages: [
        {
          role: "user",
          content: "Read the file located at 'package.json' using the read_file tool.",
        },
      ],
      tools,
      temperature: 0,
      maxOutputTokens: 100,
    })
    const firstCall = res.toolCalls?.[0]
    let argsValid = false
    if (firstCall && firstCall.name === "read_file") {
      try {
        registry.prepare(firstCall)
        argsValid = true
      } catch {
        argsValid = false
      }
    }
    results.push({
      test: "C_tool_arguments_validity",
      passed: Boolean(firstCall && firstCall.name === "read_file" && argsValid),
      latencyMs: Date.now() - t0,
      ...(res.toolCalls ? { toolCalls: res.toolCalls } : {}),
    })
  } catch (error) {
    results.push({
      test: "C_tool_arguments_validity",
      passed: false,
      latencyMs: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // D. Observation continuation
  try {
    const t0 = Date.now()
    const res = await provider.complete({
      messages: [
        {
          role: "user",
          content: "What is the project name in package.json?\n\nObservation for read_file('package.json'):\n{\"name\": \"@open-vs-code/agent-core\", \"version\": \"0.1.0\"}",
        },
      ],
      temperature: 0,
      maxOutputTokens: 100,
    })
    const passed = res.message.content.includes("@open-vs-code/agent-core")
    results.push({
      test: "D_observation_continuation",
      passed,
      latencyMs: Date.now() - t0,
      response: res.message.content.trim(),
    })
  } catch (error) {
    results.push({
      test: "D_observation_continuation",
      passed: false,
      latencyMs: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return results
}
