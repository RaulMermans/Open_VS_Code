/**
 * AutocompleteService — Sprint 3E.
 *
 * Central orchestrator for editor-native autocomplete.  This class:
 *
 *   - Accepts trigger events from the VS Code InlineCompletionItemProvider
 *   - Applies debounce via an injectable scheduler (deterministic in tests)
 *   - Supersedes pending requests when typing continues
 *   - Cancels in-flight requests via AbortSignal
 *   - Enforces inference timeout
 *   - Performs stale-result rejection (version, cursor, document, request ID)
 *   - Sanitizes provider output
 *   - Maintains bounded session telemetry (no source text)
 *   - Records bounded acceptance registry for telemetry
 *   - Has ZERO access to AgentRunner, ToolRuntime, MCP, MutationEngine, ProjectMemory
 *
 * Injectable scheduler:
 *   The debounce timer is implemented via the `scheduler` parameter, which
 *   defaults to real setTimeout/clearTimeout.  Tests inject a fake scheduler
 *   that can advance time deterministically without real sleeps.
 */

import type { AutocompleteRequest } from "./contracts.ts"
import type { AutocompleteGateway } from "./gateway.ts"
import type { ModelPerformanceLedger, AutocompleteOutcomeRecord } from "../model/performance-ledger.ts"
import { buildAutocompleteContext, type EditorSnapshot } from "./context-builder.ts"
import { sanitizeCompletion } from "./sanitizer.ts"
import {
  MAX_OUTPUT_TOKENS,
  INFERENCE_TIMEOUT_MS,
  MAX_ACCEPTANCE_REGISTRY_SIZE,
} from "./budget.ts"
import { RouteUnavailableError } from "./gateway.ts"

// ---------------------------------------------------------------------------
// Scheduler (injectable for deterministic tests)
// ---------------------------------------------------------------------------

export interface AutocompleteScheduler {
  /** Schedule fn to run after delayMs.  Returns a cancel handle. */
  schedule(fn: () => void, delayMs: number): { cancel(): void }
}

class RealScheduler implements AutocompleteScheduler {
  schedule(fn: () => void, delayMs: number): { cancel(): void } {
    const handle = setTimeout(fn, delayMs)
    return { cancel: () => clearTimeout(handle) }
  }
}

export const realScheduler: AutocompleteScheduler = new RealScheduler()

// ---------------------------------------------------------------------------
// Request identity (staleness checks)
// ---------------------------------------------------------------------------

export interface RequestIdentity {
  readonly requestId: string
  readonly documentUri: string
  readonly documentVersion: number
  readonly cursorLine: number
  readonly cursorCharacter: number
}

export interface LiveEditorState {
  readonly documentUri: string
  readonly documentVersion: number
  readonly cursorLine: number
  readonly cursorCharacter: number
}


// ---------------------------------------------------------------------------
// Telemetry (session-local, no source text)
// ---------------------------------------------------------------------------

export interface AutocompleteTelemetry {
  requests: number
  providerInvocations: number
  shown: number
  accepted: number
  cancelled: number
  staleDiscarded: number
  empty: number
  failed: number
  generatedChars: number
  acceptedChars: number
}

function emptyTelemetry(): AutocompleteTelemetry {
  return {
    requests: 0,
    providerInvocations: 0,
    shown: 0,
    accepted: 0,
    cancelled: 0,
    staleDiscarded: 0,
    empty: 0,
    failed: 0,
    generatedChars: 0,
    acceptedChars: 0,
  }
}

// ---------------------------------------------------------------------------
// Acceptance registry entry (opaque IDs only, no source text)
// ---------------------------------------------------------------------------

interface AcceptanceEntry {
  readonly requestId: string
  readonly generatedChars: number
  readonly deploymentId: string
}

// ---------------------------------------------------------------------------
// Completion result returned to the IDE provider
// ---------------------------------------------------------------------------

export interface CompletionResult {
  readonly requestId: string
  readonly text: string
  readonly deploymentId: string
  readonly providerId: string
}

// ---------------------------------------------------------------------------
// AutocompleteService
// ---------------------------------------------------------------------------

export interface AutocompleteServiceOptions {
  readonly gateway: AutocompleteGateway
  readonly debounceMs?: number
  readonly timeoutMs?: number
  readonly scheduler?: AutocompleteScheduler
  readonly performanceLedger?: ModelPerformanceLedger | undefined
}

export class AutocompleteService {
  readonly #gateway: AutocompleteGateway
  readonly #debounceMs: number
  readonly #timeoutMs: number
  readonly #scheduler: AutocompleteScheduler
  readonly #performanceLedger?: ModelPerformanceLedger | undefined

  // Session telemetry (aggregated, no source text)
  readonly #telemetry: AutocompleteTelemetry = emptyTelemetry()

  // Bounded acceptance registry (opaque IDs + char counts only)
  readonly #acceptanceRegistry: AcceptanceEntry[] = []

  // Pending shown completion awaiting acceptance or supersession (at most one)
  #pendingShownOutcome: {
    readonly requestId: string
    readonly deploymentId: string
    readonly latencyMs: number
  } | null = null

  #persistTimer?: NodeJS.Timeout | undefined

  // Current pending debounce handle, resolver, duplicate key, and promise
  #pendingHandle: { cancel(): void } | null = null
  #pendingResolver: ((res: CompletionResult | null) => void) | null = null
  #pendingKey: string | null = null
  #pendingPromise: Promise<CompletionResult | null> | null = null

  // Current in-flight request identity, abort controller, duplicate key, and promise
  #inflightId: string | null = null
  #inflightAbort: AbortController | null = null
  #inflightKey: string | null = null
  #inflightPromise: Promise<CompletionResult | null> | null = null

  // Latest scheduled request identity (for superseding)
  #latestRequestId: string | null = null

  // Enabled flag
  #enabled = true

  // Disposed flag (deactivation)
  #disposed = false

  constructor(options: AutocompleteServiceOptions) {
    this.#gateway = options.gateway
    this.#debounceMs = options.debounceMs ?? 100
    this.#timeoutMs = options.timeoutMs ?? INFERENCE_TIMEOUT_MS
    this.#scheduler = options.scheduler ?? realScheduler
    this.#performanceLedger = options.performanceLedger ?? options.gateway.performanceLedger
  }

  get enabled(): boolean { return this.#enabled }
  set enabled(v: boolean) { this.#enabled = v }

  get telemetry(): Readonly<AutocompleteTelemetry> { return { ...this.#telemetry } }

  /**
   * Trigger an autocomplete request for the given editor snapshot.
   *
   * Returns a CompletionResult (possibly with empty text) or null if the
   * request was superseded/cancelled/stale.
   *
   * This is called by the VS Code InlineCompletionItemProvider.
   * The provider passes a vsCodeToken for VS Code lifecycle cancellation
   * and an optional liveEditorSupplier to check live editor state upon completion.
   */
  async trigger(
    snapshot: EditorSnapshot,
    documentUri: string,
    vsCodeAbortSignal?: AbortSignal,
    liveEditorSupplier?: () => LiveEditorState | null,
  ): Promise<CompletionResult | null> {
    if (this.#disposed || !this.#enabled) return null

    this.#telemetry.requests++

    // Build context — this may immediately reject (sensitive file, etc.)
    const ctxResult = buildAutocompleteContext(snapshot)
    if (!ctxResult.ok) {
      return null
    }

    // Compute deterministic duplicate key from editor state and context (no random request ID)
    const duplicateKey = computeDuplicateKey(
      documentUri,
      snapshot,
      ctxResult.context.prefix,
      ctxResult.context.suffix,
    )

    // Deduplication: if the exact same editor state is already in-flight or waiting in debounce,
    // share the existing promise without invoking the provider a second time.
    if (this.#inflightKey === duplicateKey && this.#inflightPromise) {
      return this.#inflightPromise
    }
    if (this.#pendingKey === duplicateKey && this.#pendingPromise) {
      return this.#pendingPromise
    }

    const requestId = generateId()

    // Create request identity for staleness checks
    const identity: RequestIdentity = {
      requestId,
      documentUri,
      documentVersion: snapshot.documentVersion,
      cursorLine: snapshot.cursorLine,
      cursorCharacter: snapshot.cursorCharacter,
    }

    // Supersede any pending debounce for different request
    this.#cancelPending()

    // Register this as the latest request
    this.#latestRequestId = requestId
    this.#pendingKey = duplicateKey

    // Debounce: wait before actually invoking
    const resultPromise = new Promise<CompletionResult | null>((resolve) => {
      if (this.#disposed) { resolve(null); return }

      this.#pendingResolver = resolve

      const handle = this.#scheduler.schedule(async () => {
        if (this.#pendingResolver === resolve) {
          this.#pendingResolver = null
        }
        if (this.#pendingKey === duplicateKey) {
          this.#pendingKey = null
          this.#pendingPromise = null
        }
        if (this.#disposed) { resolve(null); return }

        // After debounce: check still latest
        if (this.#latestRequestId !== requestId) {
          resolve(null)
          return
        }

        // Cancel any currently in-flight request
        this.#cancelInflight()

        // Set up abort signal combining VS Code token + our timeout + our cancel
        const ourAbort = new AbortController()
        this.#inflightId = requestId
        this.#inflightKey = duplicateKey
        this.#inflightAbort = ourAbort
        this.#inflightPromise = resultPromise

        const t0 = performance.now()
        let lastDeploymentId: string | undefined

        // Merge VS Code's cancellation token into our abort signal
        if (vsCodeAbortSignal?.aborted) {
          ourAbort.abort()
        } else if (vsCodeAbortSignal) {
          vsCodeAbortSignal.addEventListener("abort", () => ourAbort.abort(), { once: true })
        }

        // Inference timeout
        const timeoutHandle = setTimeout(() => ourAbort.abort(), this.#timeoutMs)

        try {
          this.#telemetry.providerInvocations++

          const request: AutocompleteRequest = {
            requestId,
            prefix: ctxResult.context.prefix,
            suffix: ctxResult.context.suffix,
            languageId: ctxResult.context.languageId,
            relativePath: ctxResult.context.relativePath,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            signal: ourAbort.signal,
          }

          const response = await this.#gateway.complete(request)
          clearTimeout(timeoutHandle)
          lastDeploymentId = response.deploymentId
          const latencyMs = Math.max(0, Math.round(performance.now() - t0))

          // Stale-result checks against live editor state
          const isStaleResult = this.#isStale(identity, liveEditorSupplier, documentUri)
          if (isStaleResult) {
            this.#telemetry.staleDiscarded++
            this.#recordOutcome({
              deploymentId: response.deploymentId,
              shown: false,
              accepted: false,
              staleDiscarded: true,
              emptyCompletion: false,
              cancelled: false,
              latencyMs,
            })
            resolve(null)
            return
          }

          // Sanitize output
          const sanitized = sanitizeCompletion(
            response.text,
            ctxResult.context.prefix,
            ctxResult.context.suffix,
          )

          if (!sanitized) {
            this.#telemetry.empty++
            this.#recordOutcome({
              deploymentId: response.deploymentId,
              shown: false,
              accepted: false,
              staleDiscarded: false,
              emptyCompletion: true,
              cancelled: false,
              latencyMs,
            })
            resolve(null)
            return
          }

          this.#telemetry.shown++
          this.#telemetry.generatedChars += sanitized.length

          // Finalize previous unaccepted shown completion before replacing it
          if (this.#pendingShownOutcome) {
            const prev = this.#pendingShownOutcome
            this.#pendingShownOutcome = null
            this.#recordOutcome({
              deploymentId: prev.deploymentId,
              shown: true,
              accepted: false,
              staleDiscarded: false,
              emptyCompletion: false,
              cancelled: false,
              latencyMs: prev.latencyMs,
            })
          }

          // Register in acceptance registry
          this.#registerAcceptance(requestId, sanitized.length, response.deploymentId)

          // Track this shown completion as pending acceptance
          this.#pendingShownOutcome = {
            requestId,
            deploymentId: response.deploymentId,
            latencyMs,
          }

          resolve({
            requestId,
            text: sanitized,
            deploymentId: response.deploymentId,
            providerId: response.providerId,
          })
        } catch (err) {
          clearTimeout(timeoutHandle)
          const latencyMs = Math.max(0, Math.round(performance.now() - t0))

          const isAbort = err instanceof Error &&
            (err.message.includes("abort") || err.message.includes("Abort") ||
             err.message.includes("cancel") || err.message.includes("Cancel") ||
             ourAbort.signal.aborted)

          if (isAbort) {
            this.#telemetry.cancelled++
            const depId = lastDeploymentId ?? (this.#gateway as any).lastDecision?.deploymentId ?? "default"
            this.#recordOutcome({
              deploymentId: depId,
              shown: false,
              accepted: false,
              staleDiscarded: false,
              emptyCompletion: false,
              cancelled: true,
              latencyMs,
            })
          } else if (err instanceof RouteUnavailableError) {
            // Quiet — no compatible route
            this.#telemetry.empty++
          } else {
            this.#telemetry.failed++
          }

          resolve(null)
        } finally {
          if (this.#inflightId === requestId) {
            this.#inflightId = null
            this.#inflightAbort = null
            this.#inflightKey = null
            this.#inflightPromise = null
          }
        }
      }, this.#debounceMs)

      this.#pendingHandle = handle

      // If VS Code cancels before debounce fires
      if (vsCodeAbortSignal) {
        vsCodeAbortSignal.addEventListener("abort", () => {
          this.#cancelPending()
          this.#telemetry.cancelled++
          resolve(null)
        }, { once: true })
      }
    })

    this.#pendingPromise = resultPromise
    return resultPromise
  }

  /**
   * Record user acceptance of a completion.
   *
   * Called by the acceptance command attached to InlineCompletionItem.
   * Does NOT call AgentRunner, does NOT call tools, does NOT write to disk.
   * Does NOT store source text — only counts and char aggregates.
   *
   * Single-use: once accepted, entry is consumed and subsequent calls with
   * the same requestId are safe no-ops (delta = 0).
   * Unknown / stale / evicted IDs are silently ignored.
   */
  recordAccepted(requestId: string): void {
    const entryIndex = this.#acceptanceRegistry.findIndex(e => e.requestId === requestId)
    if (entryIndex === -1) return  // Unknown / stale / evicted / already accepted — safe no-op
    const entry = this.#acceptanceRegistry[entryIndex]!
    this.#acceptanceRegistry.splice(entryIndex, 1)
    this.#telemetry.accepted++
    this.#telemetry.acceptedChars += entry.generatedChars

    if (this.#pendingShownOutcome && this.#pendingShownOutcome.requestId === requestId) {
      const pending = this.#pendingShownOutcome
      this.#pendingShownOutcome = null
      this.#recordOutcome({
        deploymentId: pending.deploymentId,
        shown: true,
        accepted: true,
        staleDiscarded: false,
        emptyCompletion: false,
        cancelled: false,
        latencyMs: pending.latencyMs,
      })
    }
  }

  /**
   * Flush pending debounced persistence.
   */
  async flush(): Promise<void> {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = undefined
    }
    await this.#performanceLedger?.persist().catch(() => {})
  }

  #recordOutcome(record: AutocompleteOutcomeRecord): void {
    if (!this.#performanceLedger) return
    this.#performanceLedger.recordAutocompleteOutcome(record)
    this.#schedulePersist()
  }

  #schedulePersist(): void {
    if (this.#persistTimer) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined
      void this.#performanceLedger?.persist().catch(() => {})
    }, 500)
  }

  /**
   * Dispose the service (called on extension deactivation).
   *
   * After dispose:
   *   - No new completions will be generated
   *   - Active in-flight request is aborted
   *   - Pending unaccepted shown completion is finalized once
   *   - Acceptance registry is cleared
   *   - Ledger is flushed to disk
   */
  dispose(): void {
    this.#disposed = true
    this.#cancelPending()
    this.#cancelInflight()
    if (this.#pendingShownOutcome) {
      const pending = this.#pendingShownOutcome
      this.#pendingShownOutcome = null
      this.#recordOutcome({
        deploymentId: pending.deploymentId,
        shown: true,
        accepted: false,
        staleDiscarded: false,
        emptyCompletion: false,
        cancelled: false,
        latencyMs: pending.latencyMs,
      })
    }
    this.#acceptanceRegistry.length = 0
    this.#latestRequestId = null
    void this.flush()
  }

  get disposed(): boolean { return this.#disposed }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  #cancelPending(): void {
    this.#pendingKey = null
    this.#pendingPromise = null
    if (this.#pendingHandle) {
      this.#pendingHandle.cancel()
      this.#pendingHandle = null
    }
    if (this.#pendingResolver) {
      const resolve = this.#pendingResolver
      this.#pendingResolver = null
      resolve(null)
    }
  }

  #cancelInflight(): void {
    if (this.#inflightAbort) {
      this.#inflightAbort.abort()
      this.#inflightAbort = null
    }
    this.#inflightId = null
    this.#inflightKey = null
    this.#inflightPromise = null
  }

  /**
   * Check if a returning result is stale.
   *
   * A result is stale if:
   *   (a) A newer request ID has been registered (superseded)
   *   (b) The active document URI changed
   *   (c) The document version changed
   *   (d) The cursor moved (line or character)
   */
  #isStale(
    identity: RequestIdentity,
    liveEditorSupplier?: () => LiveEditorState | null,
    fallbackDocumentUri?: string,
  ): boolean {
    // 1. Superseded by newer request
    if (this.#latestRequestId !== identity.requestId) return true

    // 2. Real live editor checks
    if (liveEditorSupplier) {
      const current = liveEditorSupplier()
      if (!current) return true
      if (current.documentUri !== identity.documentUri) return true
      if (current.documentVersion !== identity.documentVersion) return true
      if (
        current.cursorLine !== identity.cursorLine ||
        current.cursorCharacter !== identity.cursorCharacter
      ) {
        return true
      }
    } else if (fallbackDocumentUri && identity.documentUri !== fallbackDocumentUri) {
      return true
    }

    return false
  }

  #registerAcceptance(requestId: string, chars: number, deploymentId: string): void {
    // Bounded registry
    if (this.#acceptanceRegistry.length >= MAX_ACCEPTANCE_REGISTRY_SIZE) {
      this.#acceptanceRegistry.shift()
    }
    this.#acceptanceRegistry.push({ requestId, generatedChars: chars, deploymentId })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeDuplicateKey(
  documentUri: string,
  snapshot: EditorSnapshot,
  prefix: string,
  suffix: string,
): string {
  return `${documentUri}:${snapshot.documentVersion}:${snapshot.cursorLine}:${snapshot.cursorCharacter}:${snapshot.languageId}:${prefix.length}:${suffix.length}:${hashDjb2(prefix)}:${hashDjb2(suffix)}`
}

function hashDjb2(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash |= 0
  }
  return (hash >>> 0).toString(36)
}

let idCounter = 0
function generateId(): string {
  return `ac_${Date.now()}_${++idCounter}`
}
