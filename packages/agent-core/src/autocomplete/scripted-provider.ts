/**
 * ScriptedAutocompleteProvider — Sprint 3E.
 *
 * Deterministic, fake autocomplete provider for testing.
 *
 * Supports:
 *   - configured response text
 *   - configured delay (controllable via readiness gate)
 *   - AbortSignal observation
 *   - configured error
 *   - configured empty result
 *   - readiness gate for deterministic cancellation tests
 *
 * This provider has zero access to:
 *   - AgentRunner
 *   - ToolRuntime
 *   - MCP
 *   - ProjectMemory
 *   - disk I/O
 *   - network
 */

import type { AutocompleteProvider, AutocompleteRequest, AutocompleteResponse } from "./contracts.ts"

/**
 * A single scripted step.
 *
 * "ready" — the provider resolves immediately with the configured response.
 * "delay" — the provider waits for the external readiness gate before resolving.
 * "error" — the provider rejects with the configured error.
 * "empty" — the provider resolves with an empty text response.
 */
export type ScriptedAutocompleteStep =
  | { kind: "ready"; text: string; delayMs?: number }
  | { kind: "gate" }              // waits for external gate signal (for cancellation tests)
  | { kind: "error"; error: Error }
  | { kind: "empty" }

export interface ScriptedAutocompleteProviderOptions {
  readonly providerId?: string
  readonly modelId?: string
  readonly deploymentId?: string
  readonly steps: readonly ScriptedAutocompleteStep[]
}

export class ScriptedAutocompleteProvider implements AutocompleteProvider {
  readonly providerId: string
  readonly modelId: string
  readonly deploymentId: string

  readonly requests: AutocompleteRequest[] = []
  readonly #steps: ScriptedAutocompleteStep[]

  /** Gate resolvers — call openGate() to unblock waiting "gate" steps */
  #gateResolvers: Array<() => void> = []

  constructor(options: ScriptedAutocompleteProviderOptions) {
    this.providerId = options.providerId ?? "scripted-autocomplete"
    this.modelId = options.modelId ?? "scripted-fim-model"
    this.deploymentId = options.deploymentId ?? "scripted-autocomplete-deployment"
    this.#steps = [...options.steps]
  }

  /**
   * Open the readiness gate — unblocks the next "gate" step.
   * Use in tests to precisely control when a result is delivered.
   */
  openGate(): void {
    const resolver = this.#gateResolvers.shift()
    if (resolver) resolver()
  }

  /**
   * Synchronously open ALL pending gates.
   * Use for cleanup at end of tests.
   */
  openAllGates(): void {
    const resolvers = this.#gateResolvers.splice(0)
    for (const r of resolvers) r()
  }

  get pendingGates(): number {
    return this.#gateResolvers.length
  }

  async complete(request: AutocompleteRequest): Promise<AutocompleteResponse> {
    this.requests.push(request)

    const step = this.#steps.shift()
    if (!step) {
      throw new Error("ScriptedAutocompleteProvider: no remaining steps")
    }

    switch (step.kind) {
      case "ready": {
        if (step.delayMs && step.delayMs > 0) {
          await delay(step.delayMs, request.signal)
        }
        if (request.signal.aborted) {
          throw new Error("ScriptedAutocompleteProvider: aborted")
        }
        return buildResponse(step.text, this)
      }

      case "gate": {
        // Block until gate is opened or signal fires
        await new Promise<void>((resolve, reject) => {
          if (request.signal.aborted) {
            reject(new Error("ScriptedAutocompleteProvider: aborted before gate"))
            return
          }
          this.#gateResolvers.push(resolve)
          request.signal.addEventListener("abort", () => {
            // Remove resolver to avoid stale reference
            const idx = this.#gateResolvers.indexOf(resolve)
            if (idx !== -1) this.#gateResolvers.splice(idx, 1)
            reject(new Error("ScriptedAutocompleteProvider: aborted at gate"))
          }, { once: true })
        })
        // Gate opened — but signal may have fired simultaneously
        if (request.signal.aborted) {
          throw new Error("ScriptedAutocompleteProvider: aborted after gate")
        }
        return buildResponse("", this)
      }

      case "error": {
        throw step.error
      }

      case "empty": {
        return buildResponse("", this)
      }
    }
  }
}

function buildResponse(text: string, provider: ScriptedAutocompleteProvider): AutocompleteResponse {
  return {
    text,
    deploymentId: provider.deploymentId,
    providerId: provider.providerId,
    modelId: provider.modelId,
    finishReason: "stop",
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new Error("Aborted during delay"))
    }, { once: true })
  })
}
