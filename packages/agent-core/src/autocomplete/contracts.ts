/**
 * Autocomplete contracts — Sprint 3E.
 *
 * These types are intentionally minimal and separate from the conversational
 * ModelRequest / ModelResponse contracts.  Autocomplete has:
 *   - no messages[]
 *   - no tools[]
 *   - no toolChoice
 *   - no conversation history
 *   - no memory / skills / MCP
 *
 * The key constraint: autocomplete NEVER flows through AgentRunner.
 */

/**
 * Bounded input to a single autocomplete inference.
 * All fields are editor-local — no filesystem reads, no memory retrieval.
 */
export interface AutocompleteRequest {
  /** Opaque correlation ID for staleness checks. */
  readonly requestId: string

  /** Text immediately before the cursor — already token-budgeted. */
  readonly prefix: string

  /** Text immediately after the cursor — already token-budgeted. */
  readonly suffix: string

  /** VS Code languageId (e.g. "typescript", "python"). */
  readonly languageId: string

  /** Workspace-relative path, never an absolute user path.  Optional. */
  readonly relativePath?: string

  /** Maximum generated tokens.  Provider must respect this. */
  readonly maxOutputTokens: number

  /** Caller-supplied abort signal — propagated into the provider. */
  readonly signal: AbortSignal
}

/**
 * Successful completion response.
 * Contains only the generated text and lightweight provenance — no source
 * code, no secret env values, no chain-of-thought.
 */
export interface AutocompleteResponse {
  /** Generated completion text, already sanitized. */
  readonly text: string

  /** Deployment ID that served this completion. */
  readonly deploymentId: string

  /** Provider ID. */
  readonly providerId: string

  /** Model ID. */
  readonly modelId: string

  /** Provider finish reason, if reported. */
  readonly finishReason?: string

  /** Token usage, if reported. */
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
  }
}

/**
 * Autocomplete provider contract.
 * Implementors: ScriptedAutocompleteProvider (tests), future real FIM adapters.
 *
 * The provider MUST:
 *   - observe signal.aborted before and during inference
 *   - throw (or reject) when signal fires
 *   - never invoke AgentRunner, ToolRuntime, MCP, or ProjectMemory
 *   - never write to disk
 */
export interface AutocompleteProvider {
  readonly providerId: string
  readonly modelId: string
  readonly deploymentId: string

  complete(request: AutocompleteRequest): Promise<AutocompleteResponse>
}
