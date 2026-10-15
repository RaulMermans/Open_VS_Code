/**
 * ProgressMonitor (Sprint 5C, ADR-031): a small deterministic observer.
 *
 *   observe snapshot → compare with the previous comparable snapshot → classify the delta →
 *   update per-dimension repeat counters → emit a non-progress signal when a threshold is crossed
 *
 * It never modifies files, runs tools, changes permissions, chooses models or performs recovery.
 * The workflow engine (or AgentRunner) stays authoritative; the monitor can only *request*
 * CONTINUE, DIAGNOSE or BLOCK, and its state is plain data that survives a restart.
 */
import type { EngineeringStage } from "../workflow/contracts.ts"
import {
  DEFAULT_PROGRESS_THRESHOLDS,
  PROGRESS_LIMITS,
  type MonitorCounters,
  type MonitorState,
  type ProgressAssessment,
  type ProgressDelta,
  type ProgressRequest,
  type ProgressSignal,
  type ProgressSnapshot,
  type ProgressStatus,
  type ProgressThresholds,
} from "./contracts.ts"

const STAGE_ORDER: readonly EngineeringStage[] = ["PLAN", "IMPLEMENT", "TEST", "REVIEW", "VERIFY", "COMPLETE"]

function stageIndex(stage: EngineeringStage | undefined): number {
  return stage === undefined ? -1 : STAGE_ORDER.indexOf(stage)
}

const VERIFICATION_RANK = { NONE: 0, BLOCKED: 0, NOT_READY: 1, READY: 2 } as const

export function initialMonitorState(): MonitorState {
  return {
    lastByPoint: {},
    counters: { test: { count: 0 }, review: { count: 0 }, diff: { count: 0 }, error: { count: 0 }, noAdvanceWindow: 0 },
    observations: 0,
    epoch: 1,
  }
}

/** Progress means measurable state changed for the better or meaningfully; STALLED/REGRESSED do not. */
export function isProgress(status: ProgressStatus): boolean {
  return status === "ADVANCED" || status === "CHANGED"
}

function bound(reasons: string[]): string[] {
  return reasons.slice(0, PROGRESS_LIMITS.reasons).map((reason) => reason.slice(0, PROGRESS_LIMITS.reasonChars))
}

/**
 * Pure comparison of two comparable snapshots (same observation point). `furthest` is the furthest
 * stage reached before `next`, so moving past it is a stage advance.
 */
export function compareSnapshots(previous: ProgressSnapshot | undefined, next: ProgressSnapshot, furthest?: EngineeringStage): ProgressDelta {
  const advanced: string[] = []
  const regressed: string[] = []
  const changed: string[] = []
  if (stageIndex(next.stage) > stageIndex(furthest)) advanced.push(`stage advanced to ${next.stage}`)

  if (previous) {
    const before = previous.failingCheckCount
    const after = next.failingCheckCount
    if (before !== undefined && after !== undefined) {
      if (after < before) advanced.push(`failing checks ${before} → ${after}`)
      else if (after > before) regressed.push(before === 0 ? `previously passing checks now fail (${after})` : `failing checks ${before} → ${after}`)
      else if (previous.testFingerprint !== next.testFingerprint) changed.push("different failing tests")
    }
    const blockersBefore = previous.blockerCount
    const blockersAfter = next.blockerCount
    if (blockersBefore !== undefined && blockersAfter !== undefined) {
      if (blockersAfter < blockersBefore) advanced.push(`blocking findings ${blockersBefore} → ${blockersAfter}`)
      else if (blockersAfter > blockersBefore) regressed.push(`blocking findings ${blockersBefore} → ${blockersAfter}`)
      else if (previous.reviewFingerprint !== next.reviewFingerprint) changed.push("previous blocker resolved, a different one remains")
    }
    if (previous.verificationState && next.verificationState && previous.verificationState !== "NONE" && next.verificationState !== "NONE") {
      const rankBefore = VERIFICATION_RANK[previous.verificationState]
      const rankAfter = VERIFICATION_RANK[next.verificationState]
      if (rankAfter > rankBefore) advanced.push(`verification ${previous.verificationState} → ${next.verificationState}`)
      else if (rankAfter < rankBefore) regressed.push(`verification ${previous.verificationState} → ${next.verificationState}`)
      else if (previous.verificationFailedChecks !== undefined && next.verificationFailedChecks !== undefined) {
        if (next.verificationFailedChecks < previous.verificationFailedChecks) advanced.push(`failed verification checks ${previous.verificationFailedChecks} → ${next.verificationFailedChecks}`)
        else if (next.verificationFailedChecks > previous.verificationFailedChecks) regressed.push(`failed verification checks ${previous.verificationFailedChecks} → ${next.verificationFailedChecks}`)
      }
    }
    if (previous.diffFingerprint !== next.diffFingerprint && next.point === "MUTATION") changed.push("workspace diff changed")
    if (previous.errorFingerprint !== next.errorFingerprint && next.errorFingerprint !== undefined) changed.push("different error")
    if (previous.toolFingerprint !== next.toolFingerprint && next.toolFingerprint !== undefined) changed.push("different tool action")
    if (previous.evidenceFingerprint !== next.evidenceFingerprint && next.evidenceFingerprint !== undefined) changed.push("new evidence")
  }

  if (regressed.length > 0) return { status: "REGRESSED", reasons: bound([...regressed, ...advanced]) }
  if (advanced.length > 0) return { status: "ADVANCED", reasons: bound(advanced) }
  if (changed.length > 0) return { status: "CHANGED", reasons: bound(changed) }
  if (!previous) return { status: "UNKNOWN", reasons: ["first observation"] }
  return { status: "STALLED", reasons: ["no observable state changed"] }
}

function repeat(counter: { readonly fingerprint?: string; readonly count: number }, fingerprint: string | undefined): { fingerprint?: string; count: number } {
  if (fingerprint === undefined) return { count: 0 }
  return { fingerprint, count: counter.fingerprint === fingerprint ? counter.count + 1 : 1 }
}

export class ProgressMonitor {
  readonly #thresholds: ProgressThresholds
  #state: MonitorState

  constructor(options: { readonly thresholds?: Partial<ProgressThresholds>; readonly state?: MonitorState } = {}) {
    this.#thresholds = { ...DEFAULT_PROGRESS_THRESHOLDS, ...options.thresholds }
    for (const [key, value] of Object.entries(this.#thresholds)) {
      if (key === "contextPressureRatio") continue
      if (!Number.isInteger(value) || value < 2) throw new TypeError(`progress threshold ${key} must be an integer of at least 2`)
    }
    this.#state = options.state ?? initialMonitorState()
  }

  get state(): MonitorState {
    return this.#state
  }

  get thresholds(): ProgressThresholds {
    return this.#thresholds
  }

  observe(snapshot: ProgressSnapshot): ProgressAssessment {
    const state = this.#state
    const previous = state.lastByPoint[snapshot.point]
    const delta = compareSnapshots(previous, snapshot, state.furthestStage)
    let counters: MonitorCounters = state.counters
    const signals: ProgressSignal[] = []
    const updated: number[] = []
    const t = this.#thresholds

    // Measurable progress opens a new epoch: an error repeated across it is not a stale repeat.
    // Per-point counters (test/review/diff) are untouched; they already key on their own fingerprints.
    const epochAdvanced = delta.status === "ADVANCED"
    if (epochAdvanced) counters = { ...counters, error: { count: 0 } }
    // A stage advance (e.g. tests pass and REVIEW starts) resets the loop counters it leaves behind.
    const stageAdvanced = stageIndex(snapshot.stage) > stageIndex(state.furthestStage)

    switch (snapshot.point) {
      case "START":
        // The start state seeds the diff counter, so a first pass that changes nothing is a repeat.
        counters = { ...counters, diff: repeat(counters.diff, snapshot.diffFingerprint) }
        break
      case "MUTATION": {
        const diff = repeat(counters.diff, snapshot.diffFingerprint)
        counters = { ...counters, diff }
        updated.push(diff.count)
        if (diff.count >= t.sameDiffAfterMutation) signals.push({ kind: "DIFF_STAGNATION", count: diff.count, threshold: t.sameDiffAfterMutation, pattern: "an implementation pass left the workspace diff unchanged" })
        break
      }
      case "TEST": {
        const failing = (snapshot.failingCheckCount ?? 0) > 0
        const test = failing ? repeat(counters.test, snapshot.testFingerprint) : { count: 0 }
        // Only fewer failures counts as improvement here; entering TEST is not a repair success.
        const improved = previous?.failingCheckCount !== undefined && (snapshot.failingCheckCount ?? 0) < previous.failingCheckCount
        const window = failing && !improved ? counters.noAdvanceWindow + 1 : 0
        counters = { ...counters, test, noAdvanceWindow: window }
        updated.push(test.count, window)
        if (failing && test.count >= t.sameTestAfterMutation) signals.push({ kind: "TEST_STAGNATION", count: test.count, threshold: t.sameTestAfterMutation, pattern: `the same ${snapshot.failingCheckCount === 1 ? "failing check" : `${snapshot.failingCheckCount} failing checks`} remained after a repair` })
        else if (window >= t.noProgressWindow) signals.push({ kind: "REPAIR_LOOP_STAGNATION", count: window, threshold: t.noProgressWindow, pattern: "IMPLEMENT → TEST cycles changed the failures without reducing them" })
        break
      }
      case "REVIEW": {
        const blocking = (snapshot.blockerCount ?? 0) > 0
        const review = blocking ? repeat(counters.review, snapshot.reviewFingerprint) : { count: 0 }
        const improved = previous?.blockerCount !== undefined && (snapshot.blockerCount ?? 0) < previous.blockerCount
        const window = blocking && !improved ? counters.noAdvanceWindow + 1 : 0
        counters = { ...counters, review, noAdvanceWindow: window }
        updated.push(review.count, window)
        if (blocking && review.count >= t.sameReviewBlocker) signals.push({ kind: "REVIEW_STAGNATION", count: review.count, threshold: t.sameReviewBlocker, pattern: "the same blocking review finding survived a repair" })
        else if (window >= t.noProgressWindow) signals.push({ kind: "REPAIR_LOOP_STAGNATION", count: window, threshold: t.noProgressWindow, pattern: "repair → review cycles did not reduce blocking findings" })
        break
      }
      default:
        break
    }
    if (snapshot.errorFingerprint !== undefined) {
      const error = repeat(counters.error, snapshot.errorFingerprint)
      counters = { ...counters, error }
      updated.push(error.count)
      if (error.count >= t.sameErrorAfterRepair) signals.push({ kind: "REPEATED_ERROR", count: error.count, threshold: t.sameErrorAfterRepair, pattern: "the same error recurred after a corrective action" })
    }
    if (stageAdvanced && snapshot.point !== "TEST" && snapshot.point !== "REVIEW") counters = { ...counters, noAdvanceWindow: 0 }
    if (stageAdvanced && stageIndex(snapshot.stage) > stageIndex("TEST")) counters = { ...counters, test: { count: 0 }, error: { count: 0 } }

    this.#state = {
      lastByPoint: { ...state.lastByPoint, [snapshot.point]: snapshot },
      ...(stageIndex(snapshot.stage) > stageIndex(state.furthestStage) ? { furthestStage: snapshot.stage } : state.furthestStage ? { furthestStage: state.furthestStage } : {}),
      counters,
      observations: state.observations + 1,
      epoch: (state.epoch ?? 1) + (epochAdvanced ? 1 : 0),
    }
    // A crossed stagnation threshold is never masked by a mere stage advance; a regression is reported as such.
    const status = signals.length > 0 && delta.status !== "REGRESSED" ? "STALLED" : delta.status
    return {
      status,
      point: snapshot.point,
      reasons: delta.reasons,
      signals,
      confidence: "DETERMINISTIC",
      repeatedCount: Math.max(0, ...updated),
    }
  }

  /** The monitor's request to the authoritative engine. It never grants or performs anything. */
  static request(assessment: ProgressAssessment, recoveryAvailable: boolean): ProgressRequest {
    if (assessment.signals.length === 0) return "CONTINUE"
    return recoveryAvailable ? "DIAGNOSE" : "BLOCK"
  }
}
