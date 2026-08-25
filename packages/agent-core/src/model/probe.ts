import type { OpenAICompatibleProviderConfig } from "./openai-compatible.ts"
import { OpenAICompatibleProvider } from "./openai-compatible.ts"

export interface BackendProbeResult {
  readonly reachable: boolean
  readonly model: string
  readonly modelAvailable: boolean
  readonly chatFunctional: boolean
  readonly toolsAccepted: boolean
  readonly usageReporting: boolean
  readonly contextWindow?: number
  readonly latencyMs: number
  readonly error?: string
  readonly availableModels?: readonly string[]
}

function parseBaseUrl(value: string | URL): URL {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Model base URL must use HTTP or HTTPS")
  if (url.search || url.hash) throw new TypeError("Model base URL cannot contain a query or fragment")
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}

export async function probeBackend(
  config: OpenAICompatibleProviderConfig,
  signal?: AbortSignal,
): Promise<BackendProbeResult> {
  const startTime = Date.now()
  const customFetch = config.fetch ?? globalThis.fetch
  const headers = { ...config.headers }
  const baseUrl = parseBaseUrl(config.baseUrl)
  const targetModel = config.model.trim()

  let reachable = false
  let modelAvailable = false
  let chatFunctional = false
  let toolsAccepted = false
  let usageReporting = false
  let errorMessage: string | undefined
  const availableModels: string[] = []

  // Step 1: Probe endpoint and model availability
  try {
    const modelsUrl = new URL("models", baseUrl)
    const res = await customFetch(modelsUrl, {
      method: "GET",
      headers,
      signal: signal ?? AbortSignal.timeout(config.timeoutMs ?? 10_000),
    })

    if (res.ok) {
      reachable = true
      const body = await res.json().catch(() => null) as Record<string, unknown> | null
      if (body && Array.isArray(body.data)) {
        for (const item of body.data) {
          if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
            const id = ((item as Record<string, unknown>).id as string).trim()
            availableModels.push(id)
            if (id === targetModel || id.startsWith(`${targetModel}:`) || targetModel.startsWith(`${id}:`)) {
              modelAvailable = true
            }
          }
        }
      } else {
        // If models list not standard array, assume model is available if endpoint responded OK
        modelAvailable = true
      }
    } else if (res.status === 404 || res.status === 405) {
      // Some minimalist servers don't implement /v1/models, treat reachability as tentative
      reachable = true
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to reach backend endpoint"
  }

  // Step 2: Probe Chat Completion
  const provider = new OpenAICompatibleProvider({
    ...config,
    timeoutMs: config.timeoutMs ?? 15_000,
  })

  try {
    const chatRes = await provider.complete({
      messages: [{ role: "user", content: "ping" }],
      maxOutputTokens: 10,
      temperature: 0,
      ...(signal ? { signal } : {}),
    })

    reachable = true
    chatFunctional = true
    modelAvailable = true // Successful completion confirms model is available
    if (chatRes.usage && (chatRes.usage.inputTokens !== undefined || chatRes.usage.outputTokens !== undefined)) {
      usageReporting = true
    }
  } catch (error) {
    if (!errorMessage) {
      errorMessage = error instanceof Error ? error.message : "Chat completion probe failed"
    }
  }

  // Step 3: Probe Tool Calling Schema Acceptance
  if (chatFunctional) {
    try {
      await provider.complete({
        messages: [{ role: "user", content: "What is the current version?" }],
        maxOutputTokens: 20,
        temperature: 0,
        tools: [
          {
            name: "probe_tool",
            description: "Test tool schema acceptance",
            action: "read_repository",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
              },
              required: ["query"],
            },
          },
        ],
        ...(signal ? { signal } : {}),
      })
      toolsAccepted = true
    } catch {
      toolsAccepted = false
    }
  }

  const latencyMs = Date.now() - startTime

  return {
    reachable,
    model: targetModel,
    modelAvailable,
    chatFunctional,
    toolsAccepted,
    usageReporting,
    ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
    latencyMs,
    ...(availableModels.length > 0 ? { availableModels } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  }
}
