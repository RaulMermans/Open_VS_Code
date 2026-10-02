import type { ModelProvider, ModelRequest, ModelResponse } from "../contracts/model.ts"

export type ScriptedModelStep = ModelResponse | Error | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>)

export class ScriptedModelError extends Error {
  readonly code = "SCRIPT_EXHAUSTED"

  constructor() {
    super("Scripted model has no remaining response")
    this.name = "ScriptedModelError"
  }
}

export class ScriptedModelProvider implements ModelProvider {
  readonly capabilities = new Set(["chat", "tools"] as const)
  readonly requests: ModelRequest[] = []
  readonly #steps: ScriptedModelStep[]
  readonly model: string

  constructor(steps: readonly ScriptedModelStep[], model = "scripted-general") {
    this.#steps = [...steps]
    this.model = model
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const step = this.#steps.shift()
    if (!step) throw new ScriptedModelError()
    if (step instanceof Error) throw step
    return typeof step === "function" ? step(request) : step
  }
}
