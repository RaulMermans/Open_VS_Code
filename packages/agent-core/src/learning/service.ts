/**
 * LearningService (Sprint 5D, ADR-032): the single authority over learning records, skill
 * candidates and learned-skill provenance.
 *
 *   observe → (dedupe, accumulate independent evidence) → OBSERVED → CANDIDATE
 *   proposeSkills → LearnedSkillCandidate (validated, permission-capped) → READY_FOR_REVIEW
 *   approve (explicit human action) → APPROVED memory, or a schema-valid learned SKILL.md
 *
 * Invariants: nothing is promoted without `approve`; only APPROVED, non-stale records are ever
 * retrieved; a disabled service observes and proposes nothing; learning never grants authority.
 */
import { estimateTokens } from "../context/budget.ts"
import type { AgentMode } from "../contracts/agent.ts"
import { REQUIRED_SKILL_SECTIONS, SKILL_LIMITS } from "../skills/contracts.ts"
import { SkillValidationError, parseSkillFrontmatter, splitSkillDocument, validateSkillBody, validateSkillMetadata } from "../skills/schema.ts"
import { describeCandidateRejection, findContentSafetyIssue, normalizeSkillCandidate, rejectedCandidateEvidence, type SkillCandidateDraft } from "./candidate.ts"
import {
  LEARNING_HISTORY_DIR,
  LEARNING_LIMITS,
  LEARNING_THRESHOLDS,
  type LearnedSkillProvenance,
  type LearningObservation,
  type LearningRecord,
  type LearningRetrieval,
  type LearningStoreData,
  type RejectionFingerprint,
  type LearnedSkillCandidate,
} from "./contracts.ts"
import { templateFor } from "./patterns.ts"
import {
  assessTrust,
  boundList,
  classifyScope,
  confidenceFor,
  dedupeKey,
  findDuplicate,
  isContradicted,
  isPromotable,
  normalizedTokens,
  sanitizeLearningText,
  shortDigest,
} from "./policy.ts"

/** Persistence for the compact JSON store. Implementations must write atomically. */
export interface LearningStorage {
  read(): Promise<string | undefined>
  write(text: string): Promise<void>
}

/** Workspace-relative, contained file access for staleness checks and learned-skill writes. */
export interface LearningWorkspaceFiles {
  exists(relativePath: string): Promise<boolean>
  readText(relativePath: string): Promise<string | undefined>
  writeText(relativePath: string, content: string): Promise<void>
}

export interface LearningServiceOptions {
  readonly enabled: boolean
  readonly projectId: string
  readonly storage: LearningStorage
  readonly files: LearningWorkspaceFiles
  /** Built-in skill ids: a learned skill may never shadow one. */
  readonly builtinSkillIds: readonly string[]
  /** Learned skills are workspace skills; they are only written in a trusted workspace. */
  readonly workspaceTrusted: boolean
  readonly clock?: () => string
}

export interface ObserveReport {
  readonly created: number
  readonly merged: number
  readonly ignoredDuplicateTask: number
  readonly rejected: readonly { readonly title: string; readonly reason: string }[]
  readonly droppedForCapacity: number
}

export type ApprovalResult =
  | { readonly ok: true; readonly kind: "MEMORY"; readonly record: LearningRecord }
  | { readonly ok: true; readonly kind: "SKILL"; readonly candidate: LearnedSkillCandidate; readonly path: string; readonly version: number }
  | { readonly ok: false; readonly reason: string }

export interface LearningExplanation {
  readonly id: string
  readonly what: string
  readonly why: string
  readonly fromTasks: readonly string[]
  readonly evidence: readonly string[]
  readonly successes: number
  readonly failures: number
  readonly status: string
  readonly scope: string
  readonly ifApproved: string
}

export interface RetrievalQuery {
  readonly task: string
  readonly mode: AgentMode
  readonly paths?: readonly string[]
  readonly availableContext: number
}

const EMPTY_STORE = (projectId: string): LearningStoreData => ({ schemaVersion: 1, projectId, records: [], candidates: [], rejections: [], learnedSkills: [] })

export const LEARNED_SKILLS_DIR = ".open-vs-code/skills"

export class LearningService {
  readonly #options: LearningServiceOptions
  readonly #clock: () => string
  #data: LearningStoreData
  /** A store that failed to parse is never overwritten; learning stays read-only until it is fixed. */
  readonly corrupt: boolean

  private constructor(options: LearningServiceOptions, data: LearningStoreData, corrupt: boolean) {
    this.#options = options
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#data = data
    this.corrupt = corrupt
  }

  static async open(options: LearningServiceOptions): Promise<LearningService> {
    const text = await options.storage.read()
    if (text === undefined) return new LearningService(options, EMPTY_STORE(options.projectId), false)
    try {
      const parsed = JSON.parse(text) as LearningStoreData
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.records) || !Array.isArray(parsed.candidates)) throw new Error("schema")
      return new LearningService(options, { ...EMPTY_STORE(options.projectId), ...parsed }, false)
    } catch {
      return new LearningService(options, EMPTY_STORE(options.projectId), true)
    }
  }

  get enabled(): boolean {
    return this.#options.enabled
  }

  get data(): LearningStoreData {
    return this.#data
  }

  async #persist(): Promise<void> {
    if (this.corrupt) throw new Error("learning store is corrupt; it is not overwritten")
    await this.#options.storage.write(`${JSON.stringify(this.#data, null, 1)}\n`)
  }

  // ---- observe ---------------------------------------------------------------------------------------

  async observe(observations: readonly LearningObservation[]): Promise<ObserveReport> {
    const report = { created: 0, merged: 0, ignoredDuplicateTask: 0, rejected: [] as { title: string; reason: string }[], droppedForCapacity: 0 }
    if (!this.enabled || observations.length === 0) return report
    let records = [...this.#data.records]
    let rejections = [...this.#data.rejections]
    const now = this.#clock()
    for (const raw of observations) {
      const trust = assessTrust(raw)
      if (!trust.trusted && trust.reject) {
        report.rejected.push({ title: sanitizeLearningText(raw.title, 80), reason: trust.reason })
        rejections = addRejection(rejections, { fingerprint: shortDigest(dedupeKey(raw.kind, raw.title)), successesAtRejection: 0, rejectedAt: now, reason: trust.reason })
        continue
      }
      const { kind, scope } = classifyScope(raw)
      const title = sanitizeLearningText(raw.title, LEARNING_LIMITS.titleChars)
      const summary = sanitizeLearningText(raw.summary, LEARNING_LIMITS.summaryChars)
      const existing = findDuplicate(records, { kind, title, ...(raw.patternKey ? { patternKey: raw.patternKey } : {}) })
      if (existing) {
        const independent = !existing.sourceTaskIds.includes(raw.taskId)
        if (!independent) report.ignoredDuplicateTask += 1
        else report.merged += 1
        const successes = existing.successfulOccurrences + (independent && raw.outcome === "SUCCESS" ? 1 : 0)
        const failures = existing.failedOccurrences + (independent && raw.outcome === "FAILURE" ? 1 : 0)
        const merged: LearningRecord = {
          ...existing,
          evidenceRefs: boundList([...existing.evidenceRefs, ...raw.evidenceRefs], LEARNING_LIMITS.maxEvidenceRefs),
          sourceTaskIds: boundList([...existing.sourceTaskIds, raw.taskId], LEARNING_LIMITS.maxSourceTaskIds),
          successfulOccurrences: successes,
          failedOccurrences: failures,
          confidence: confidenceFor(successes, failures),
          tags: boundList([...existing.tags, ...(raw.tags ?? [])], LEARNING_LIMITS.maxTags, 40),
          updatedAt: now,
        }
        records = records.map((record) => (record.id === existing.id ? this.#transition(merged, rejections) : record))
        continue
      }
      const successes = raw.outcome === "SUCCESS" ? 1 : 0
      const failures = raw.outcome === "FAILURE" ? 1 : 0
      const record: LearningRecord = {
        id: `lr-${shortDigest(`${this.#options.projectId}:${raw.patternKey ?? dedupeKey(kind, title)}`).slice(0, 12)}`,
        ...(scope === "PROJECT" ? { projectId: this.#options.projectId } : {}),
        kind,
        source: raw.source,
        ...(raw.patternKey ? { patternKey: raw.patternKey } : {}),
        dedupeKey: dedupeKey(kind, title),
        title,
        summary,
        evidenceRefs: boundList(raw.evidenceRefs, LEARNING_LIMITS.maxEvidenceRefs),
        sourceTaskIds: boundList([raw.taskId], LEARNING_LIMITS.maxSourceTaskIds),
        successfulOccurrences: successes,
        failedOccurrences: failures,
        confidence: confidenceFor(successes, failures),
        scope,
        status: "OBSERVED",
        tags: boundList(raw.tags ?? [], LEARNING_LIMITS.maxTags, 40),
        relevantPaths: boundList(raw.relevantPaths ?? [], LEARNING_LIMITS.maxPaths),
        modes: [...new Set(raw.modes ?? [])],
        ...(!trust.trusted ? { statusReason: trust.reason } : {}),
        createdAt: now,
        updatedAt: now,
      }
      const capped = enforceCapacity(records, record)
      if (!capped) {
        report.droppedForCapacity += 1
        continue
      }
      records = capped
      report.created += 1
    }
    this.#data = { ...this.#data, records, rejections }
    await this.#persist()
    return report
  }

  /** Status after new evidence. Approval is never granted here. */
  #transition(record: LearningRecord, rejections: readonly RejectionFingerprint[]): LearningRecord {
    const successes = record.successfulOccurrences
    const failures = record.failedOccurrences
    if (record.status === "STALE") return record
    if (isContradicted(successes, failures)) return { ...record, status: "STALE", statusReason: `repeated contradictory evidence (${successes} success, ${failures} failure)` }
    if (record.status === "APPROVED") return record
    if (record.status === "REJECTED") {
      const rejection = rejections.find((item) => item.fingerprint === shortDigest(record.dedupeKey))
      const resurface = rejection && successes >= rejection.successesAtRejection + LEARNING_THRESHOLDS.resurfaceAfterSuccesses
      return resurface ? { ...record, status: "CANDIDATE", statusReason: "resurfaced after materially new evidence" } : record
    }
    const trusted = record.source === "OBSERVED_OUTCOME" || record.source === "USER_DECISION"
    if (trusted && record.status === "OBSERVED" && successes >= LEARNING_THRESHOLDS.candidateSuccesses && successes > failures) return { ...record, status: "CANDIDATE" }
    return record
  }

  /** An explicit user decision is trusted on arrival and supersedes an earlier decision on the same subject. */
  async recordUserDecision(input: { readonly title: string; readonly summary: string; readonly taskId?: string; readonly relevantPaths?: readonly string[]; readonly tags?: readonly string[] }): Promise<{ ok: true; record: LearningRecord } | { ok: false; reason: string }> {
    if (!this.enabled) return { ok: false, reason: "learning is disabled" }
    const trust = assessTrust({ source: "USER_DECISION", title: input.title, summary: input.summary, evidenceRefs: ["user"] })
    if (!trust.trusted) return { ok: false, reason: trust.reason }
    const now = this.#clock()
    const title = sanitizeLearningText(input.title, LEARNING_LIMITS.titleChars)
    const summary = sanitizeLearningText(input.summary, LEARNING_LIMITS.summaryChars)
    const key = dedupeKey("PROJECT_DECISION", title)
    const id = `lr-${shortDigest(`${this.#options.projectId}:decision:${key}:${summary}`).slice(0, 12)}`
    const record: LearningRecord = {
      id,
      projectId: this.#options.projectId,
      kind: "PROJECT_DECISION",
      source: "USER_DECISION",
      dedupeKey: key,
      title,
      summary,
      evidenceRefs: [`user:decision@${now}`],
      sourceTaskIds: boundList([input.taskId ?? `user-${now}`], LEARNING_LIMITS.maxSourceTaskIds),
      successfulOccurrences: 1,
      failedOccurrences: 0,
      confidence: "HIGH",
      scope: "PROJECT",
      status: "APPROVED",
      tags: boundList(input.tags ?? [], LEARNING_LIMITS.maxTags, 40),
      relevantPaths: boundList(input.relevantPaths ?? [], LEARNING_LIMITS.maxPaths),
      modes: [],
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    const previous = findDuplicate(this.#data.records.filter((item) => item.kind === "PROJECT_DECISION" && item.status !== "STALE" && item.id !== id), { kind: "PROJECT_DECISION", title })
    let records = this.#data.records.filter((item) => item.id !== id)
    if (previous) records = records.map((item) => (item.id === previous.id ? { ...item, status: "STALE" as const, statusReason: "the user changed this decision", supersededBy: id, updatedAt: now } : item))
    const capped = enforceCapacity(records, record)
    if (!capped) return { ok: false, reason: "project learning capacity reached" }
    this.#data = { ...this.#data, records: capped }
    await this.#persist()
    return { ok: true, record }
  }

  // ---- staleness -------------------------------------------------------------------------------------

  /** Marks records whose referenced files are gone STALE. History is kept; stale records are never retrieved. */
  async refreshStaleness(): Promise<number> {
    let changed = 0
    const now = this.#clock()
    const records: LearningRecord[] = []
    for (const record of this.#data.records) {
      if (record.status === "STALE" || record.relevantPaths.length === 0) {
        records.push(record)
        continue
      }
      const missing: string[] = []
      for (const path of record.relevantPaths) if (!(await this.#options.files.exists(path))) missing.push(path)
      if (missing.length === 0) records.push(record)
      else {
        changed += 1
        records.push({ ...record, status: "STALE", statusReason: `referenced file no longer exists: ${missing.join(", ")}`.slice(0, 200), updatedAt: now })
      }
    }
    if (changed > 0) {
      this.#data = { ...this.#data, records }
      await this.#persist()
    }
    return changed
  }

  async markStale(id: string, reason: string): Promise<boolean> {
    const record = this.#data.records.find((item) => item.id === id)
    if (!record) return false
    this.#data = { ...this.#data, records: this.#data.records.map((item) => (item.id === id ? { ...item, status: "STALE" as const, statusReason: sanitizeLearningText(reason, 200), updatedAt: this.#clock() } : item)) }
    await this.#persist()
    return true
  }

  // ---- skill candidates ------------------------------------------------------------------------------

  /** Drafts candidates for promotable reusable records with a recognised pattern. Never approves. */
  async proposeSkills(): Promise<{ proposed: LearnedSkillCandidate[]; suppressed: number }> {
    if (!this.enabled) return { proposed: [], suppressed: 0 }
    const proposed: LearnedSkillCandidate[] = []
    let suppressed = 0
    let candidates = [...this.#data.candidates]
    for (const record of this.#data.records) {
      if (!isPromotable(record)) continue
      const template = templateFor(record.patternKey)
      if (!template) continue
      if (candidates.some((candidate) => candidate.recordId === record.id && (candidate.status === "DRAFT" || candidate.status === "READY_FOR_REVIEW"))) continue
      const fingerprint = candidateFingerprint(record.id, template.skill.id)
      const rejection = this.#data.rejections.find((item) => item.fingerprint === fingerprint)
      if (rejection && record.successfulOccurrences < rejection.successesAtRejection + LEARNING_THRESHOLDS.resurfaceAfterSuccesses) {
        suppressed += 1
        continue
      }
      const candidate = await this.#validateCandidate({
        id: `sc-${shortDigest(`${record.id}:${template.skill.id}:${record.successfulOccurrences}`).slice(0, 12)}`,
        recordId: record.id,
        proposedSkillId: template.skill.id,
        title: template.skill.name,
        description: template.skill.description,
        category: template.skill.category,
        intent: template.skill.intent,
        whenToUse: template.skill.whenToUse,
        inputs: template.skill.inputs,
        workflow: template.skill.workflow,
        verification: template.skill.verification,
        failureModes: template.skill.failureModes,
        exitCriteria: template.skill.exitCriteria,
        triggers: template.skill.triggers,
        evidenceRefs: record.evidenceRefs,
        supportingTaskIds: record.sourceTaskIds,
        proposedCapabilities: template.skill.capabilities,
        proposedTools: template.skill.tools,
        proposedModes: template.skill.modes,
        status: "DRAFT",
        createdAt: this.#clock(),
        updatedAt: this.#clock(),
      })
      if (!candidate) continue
      if (candidates.length >= LEARNING_LIMITS.maxCandidates) {
        const evictable = candidates.findIndex((item) => item.status === "REJECTED" || item.status === "APPROVED")
        if (evictable === -1) break
        candidates.splice(evictable, 1)
      }
      candidates = [...candidates, candidate]
      proposed.push(candidate)
    }
    this.#data = { ...this.#data, candidates }
    if (proposed.length > 0) await this.#persist()
    return { proposed, suppressed }
  }

  /**
   * External proposals (e.g. a model-drafted candidate) go through the same gate: they must point
   * at a promotable record (evidence first) and are validated exactly like generated ones. The raw
   * input is normalised before anything is stored; a draft rejected at that boundary is stored only
   * as a code-bearing stub, never with its content. The raw input is never serialised or hashed:
   * the candidate id comes from the bounded canonical draft, or from the stub's code and ids.
   */
  async submitCandidate(input: SkillCandidateDraft): Promise<LearnedSkillCandidate> {
    const normalized = normalizeSkillCandidate(input)
    const record = this.#data.records.find((item) => item.id === (input as { recordId?: unknown })?.recordId)
    const now = this.#clock()
    const meta = { evidenceRefs: record?.evidenceRefs ?? [], supportingTaskIds: record?.sourceTaskIds ?? [], createdAt: now, updatedAt: now }
    let candidate: LearnedSkillCandidate
    if (!normalized.ok) {
      const stub = rejectedCandidateEvidence({ ...meta, id: "", ...(record ? { knownRecordId: record.id } : {}) }, input, describeCandidateRejection(normalized))
      candidate = { ...stub, id: candidateId(`rejected:${stub.statusReason}:${stub.recordId}:${stub.proposedSkillId}`) }
    } else {
      const base: LearnedSkillCandidate = { ...normalized.draft, ...meta, id: candidateId(`candidate:${JSON.stringify(normalized.draft)}`), status: "DRAFT" }
      candidate = !this.enabled
        ? { ...base, status: "REJECTED", statusReason: "learning is disabled" }
        : !record || !isPromotable(record)
          ? { ...base, status: "REJECTED", statusReason: "no promotable evidence record supports this proposal" }
          : await this.#validateCandidate(base) ?? { ...base, status: "REJECTED", statusReason: "identical to the existing learned skill" }
    }
    this.#data = { ...this.#data, candidates: [...this.#data.candidates.filter((item) => item.id !== candidate.id), candidate].slice(-LEARNING_LIMITS.maxCandidates) }
    if (this.enabled) await this.#persist()
    return candidate
  }

  /**
   * Fail-closed validation. Returns READY_FOR_REVIEW, REJECTED (with a reason), or undefined when
   * nothing would change. Every caller (proposal, submission, approval) passes the candidate through
   * the normalisation boundary here, so a stored candidate is never trusted as-is.
   */
  async #validateCandidate(input: LearnedSkillCandidate): Promise<LearnedSkillCandidate | undefined> {
    const normalized = normalizeSkillCandidate(input)
    if (!normalized.ok) return rejectedCandidateEvidence({ ...input, knownRecordId: input.recordId }, input, describeCandidateRejection(normalized))
    // System-managed fields plus the canonical draft only: unknown keys in a stored candidate are dropped.
    const { id, evidenceRefs, supportingTaskIds, status, createdAt, updatedAt, updateOf } = input
    const candidate: LearnedSkillCandidate = { id, evidenceRefs, supportingTaskIds, status, createdAt, updatedAt, ...(updateOf ? { updateOf } : {}), ...normalized.draft }
    const reject = (reason: string): LearnedSkillCandidate => ({ ...candidate, status: "REJECTED", statusReason: reason })
    if (this.#options.builtinSkillIds.includes(candidate.proposedSkillId)) return reject(`'${candidate.proposedSkillId}' would shadow a built-in skill; built-in changes need a maintainer`)

    const path = learnedSkillPath(candidate.proposedSkillId)
    const provenance = this.#data.learnedSkills.find((item) => item.skillId === candidate.proposedSkillId)
    const existing = await this.#options.files.readText(path)
    let version = 1
    if (existing !== undefined) {
      if (!provenance) return reject(`a user-authored workspace skill '${candidate.proposedSkillId}' exists; it is never overwritten`)
      version = provenance.version + 1
    }
    const rendered = renderSkill(candidate, version)
    const valid = validateRendered(rendered, candidate.proposedSkillId)
    if (!valid.ok) return reject(`generated SKILL.md is invalid: ${valid.reason}`)
    if (existing !== undefined && provenance) {
      if (renderSkill(candidate, provenance.version) === existing) return undefined
      return { ...candidate, status: "READY_FOR_REVIEW", updateOf: { skillId: candidate.proposedSkillId, fromVersion: provenance.version } }
    }
    return { ...candidate, status: "READY_FOR_REVIEW" }
  }

  // ---- review ----------------------------------------------------------------------------------------

  list(): { records: readonly LearningRecord[]; candidates: readonly LearnedSkillCandidate[] } {
    return { records: this.#data.records, candidates: this.#data.candidates }
  }

  explain(id: string): LearningExplanation | undefined {
    const record = this.#data.records.find((item) => item.id === id)
    if (record) {
      return {
        id,
        what: `${record.title} — ${record.summary}`,
        why: record.statusReason ?? `${record.kind} from ${record.source === "USER_DECISION" ? "an explicit user decision" : "observed task outcomes"}`,
        fromTasks: record.sourceTaskIds,
        evidence: record.evidenceRefs,
        successes: record.successfulOccurrences,
        failures: record.failedOccurrences,
        status: record.status,
        scope: record.scope === "PROJECT" ? `project ${record.projectId}` : "reusable",
        ifApproved: record.status === "APPROVED" ? "already approved: it is eligible for budgeted retrieval into prompts" : "it becomes eligible for budgeted retrieval into prompts for relevant tasks in this project; it grants no permission",
      }
    }
    const candidate = this.#data.candidates.find((item) => item.id === id)
    if (!candidate) return undefined
    const source = this.#data.records.find((item) => item.id === candidate.recordId)
    return {
      id,
      what: `Skill '${candidate.proposedSkillId}': ${candidate.description}`,
      why: candidate.statusReason ?? `the pattern "${source?.title ?? candidate.recordId}" held in ${candidate.supportingTaskIds.length} independent tasks`,
      fromTasks: candidate.supportingTaskIds,
      evidence: candidate.evidenceRefs,
      successes: source?.successfulOccurrences ?? 0,
      failures: source?.failedOccurrences ?? 0,
      status: candidate.status,
      scope: "reusable (written as a project-local workspace skill)",
      ifApproved: `${LEARNED_SKILLS_DIR}/${candidate.proposedSkillId}/SKILL.md is ${candidate.updateOf ? `updated to version ${candidate.updateOf.fromVersion + 1} (the previous version is archived)` : "created"}; it is lazily selectable like any workspace skill (skills.enabled, trusted workspace) and declares only [${candidate.proposedCapabilities.join(", ")}], each still checked by the PermissionGate`,
    }
  }

  /** The human approval gate. Never called by the runtime; only by an explicit command. */
  async approve(id: string): Promise<ApprovalResult> {
    if (!this.enabled) return { ok: false, reason: "learning is disabled" }
    const now = this.#clock()
    const record = this.#data.records.find((item) => item.id === id)
    if (record) {
      if (record.status === "APPROVED") return { ok: true, kind: "MEMORY", record }
      if (record.status !== "CANDIDATE" && record.status !== "OBSERVED") return { ok: false, reason: `a ${record.status} record cannot be approved` }
      if (record.source === "REPOSITORY_TEXT" || record.source === "MODEL_PROPOSAL") return { ok: false, reason: "untrusted text cannot become approved memory; record an explicit decision instead" }
      const approved: LearningRecord = { ...record, status: "APPROVED", approvedAt: now, updatedAt: now }
      this.#data = { ...this.#data, records: this.#data.records.map((item) => (item.id === id ? approved : item)) }
      await this.#persist()
      return { ok: true, kind: "MEMORY", record: approved }
    }
    const candidate = this.#data.candidates.find((item) => item.id === id)
    if (!candidate) return { ok: false, reason: `no learning record or candidate '${id}'` }
    if (candidate.status !== "READY_FOR_REVIEW") return { ok: false, reason: `a ${candidate.status} candidate cannot be approved` }
    if (!this.#options.workspaceTrusted) return { ok: false, reason: "learned skills are workspace skills; trust the workspace first" }
    const boundary = normalizeSkillCandidate(candidate)
    if (!boundary.ok) {
      // A stored candidate that fails the boundary (an older or hand-edited store) is replaced by its stub.
      const stub = rejectedCandidateEvidence({ ...candidate, updatedAt: now, knownRecordId: candidate.recordId }, candidate, describeCandidateRejection(boundary))
      this.#data = { ...this.#data, candidates: this.#data.candidates.map((item) => (item.id === id ? stub : item)) }
      await this.#persist()
      return { ok: false, reason: stub.statusReason! }
    }
    // Re-validate at approval time: the workspace may have changed since the proposal.
    const revalidated = await this.#validateCandidate({ ...candidate, status: "DRAFT" })
    if (!revalidated || revalidated.status !== "READY_FOR_REVIEW") return { ok: false, reason: revalidated?.statusReason ?? "the candidate no longer changes anything" }
    const path = learnedSkillPath(candidate.proposedSkillId)
    const provenance = this.#data.learnedSkills.find((item) => item.skillId === candidate.proposedSkillId)
    const history = [...(provenance?.history ?? [])]
    if (provenance) {
      const current = await this.#options.files.readText(path)
      if (current === undefined || shortDigest(current) !== provenance.contentHash) return { ok: false, reason: "the learned skill was edited by hand since approval; review it before updating" }
      const archived = `${LEARNING_HISTORY_DIR}/${candidate.proposedSkillId}/v${provenance.version}.md`
      await this.#options.files.writeText(archived, current)
      history.push(archived)
    }
    const version = (provenance?.version ?? 0) + 1
    const rendered = renderSkill(revalidated, version)
    const valid = validateRendered(rendered, candidate.proposedSkillId)
    if (!valid.ok) return { ok: false, reason: `generated SKILL.md is invalid: ${valid.reason}` }
    await this.#options.files.writeText(path, rendered)
    const approvedCandidate: LearnedSkillCandidate = { ...revalidated, status: "APPROVED", updatedAt: now }
    const entry: LearnedSkillProvenance = {
      skillId: candidate.proposedSkillId,
      version,
      candidateId: candidate.id,
      recordId: candidate.recordId,
      supportingTaskIds: candidate.supportingTaskIds,
      evidenceRefs: candidate.evidenceRefs,
      approvedAt: now,
      contentHash: shortDigest(rendered),
      history: history.slice(-10),
    }
    this.#data = {
      ...this.#data,
      candidates: this.#data.candidates.map((item) => (item.id === id ? approvedCandidate : item)),
      records: this.#data.records.map((item) => (item.id === candidate.recordId ? { ...item, status: "APPROVED" as const, approvedAt: now, updatedAt: now } : item)),
      learnedSkills: [...this.#data.learnedSkills.filter((item) => item.skillId !== candidate.proposedSkillId), entry],
    }
    await this.#persist()
    return { ok: true, kind: "SKILL", candidate: approvedCandidate, path, version }
  }

  async reject(id: string, reason = "rejected by reviewer"): Promise<boolean> {
    if (!this.enabled) return false
    const now = this.#clock()
    const why = sanitizeLearningText(reason, 200)
    const record = this.#data.records.find((item) => item.id === id)
    if (record) {
      this.#data = {
        ...this.#data,
        records: this.#data.records.map((item) => (item.id === id ? { ...item, status: "REJECTED" as const, statusReason: why, updatedAt: now } : item)),
        rejections: addRejection(this.#data.rejections, { fingerprint: shortDigest(record.dedupeKey), successesAtRejection: record.successfulOccurrences, rejectedAt: now, reason: why }),
      }
      await this.#persist()
      return true
    }
    const candidate = this.#data.candidates.find((item) => item.id === id)
    if (!candidate || candidate.status === "APPROVED") return false
    const source = this.#data.records.find((item) => item.id === candidate.recordId)
    this.#data = {
      ...this.#data,
      candidates: this.#data.candidates.map((item) => (item.id === id ? { ...item, status: "REJECTED" as const, statusReason: why, updatedAt: now } : item)),
      rejections: addRejection(this.#data.rejections, { fingerprint: candidateFingerprint(candidate.recordId, candidate.proposedSkillId), successesAtRejection: source?.successfulOccurrences ?? 0, rejectedAt: now, reason: why }),
    }
    await this.#persist()
    return true
  }

  // ---- retrieval -------------------------------------------------------------------------------------

  /**
   * Selective, budgeted retrieval of APPROVED memory only. Candidates, observations, rejected and
   * stale records never reach a prompt. The budget is a fixed share of the available context.
   */
  retrieve(query: RetrievalQuery): LearningRetrieval {
    const budgetTokens = Math.floor(query.availableContext * LEARNING_LIMITS.memoryBudgetRatio)
    const empty = { items: [], budgetTokens, retrievedTokens: 0, indexTokens: 0, considered: 0, excludedStale: 0, excludedUnapproved: 0, droppedForBudget: 0 }
    if (!this.enabled) return empty
    const taskTokens = new Set(normalizedTokens(query.task))
    const paths = new Set(query.paths ?? [])
    let excludedStale = 0
    let excludedUnapproved = 0
    const scored: { record: LearningRecord; score: number }[] = []
    for (const record of this.#data.records) {
      if (record.status === "STALE") {
        excludedStale += 1
        continue
      }
      if (record.status !== "APPROVED") {
        excludedUnapproved += 1
        continue
      }
      if (record.scope === "PROJECT" && record.projectId !== this.#options.projectId) continue
      const overlap = normalizedTokens(`${record.title} ${record.tags.join(" ")}`).filter((token) => taskTokens.has(token)).length
      const pathOverlap = record.relevantPaths.filter((path) => paths.has(path)).length
      const always = record.kind === "PROJECT_DECISION" || record.tags.includes("toolchain")
      if (!always && overlap === 0 && pathOverlap === 0) continue
      const modeMatch = record.modes.length === 0 || record.modes.includes(query.mode) ? 1 : 0
      const kindWeight = record.kind === "PROJECT_DECISION" ? 3 : record.kind === "PROJECT_FACT" ? 2 : 1
      const confidence = record.confidence === "HIGH" ? 1 : 0
      scored.push({ record, score: overlap * 3 + pathOverlap * 4 + modeMatch + kindWeight + confidence })
    }
    scored.sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt) || left.record.id.localeCompare(right.record.id))
    const items: { id: string; kind: LearningRecord["kind"]; content: string; estimatedTokens: number }[] = []
    let retrievedTokens = 0
    let droppedForBudget = 0
    for (const { record } of scored) {
      const content = renderMemory(record)
      const tokens = estimateTokens(content)
      if (retrievedTokens + tokens > budgetTokens) {
        droppedForBudget += 1
        continue
      }
      items.push({ id: record.id, kind: record.kind, content, estimatedTokens: tokens })
      retrievedTokens += tokens
    }
    const index = this.#data.records.filter((record) => record.status === "APPROVED").map((record) => `- ${record.title}`).join("\n")
    return { items, budgetTokens, retrievedTokens, indexTokens: estimateTokens(index), considered: this.#data.records.length, excludedStale, excludedUnapproved, droppedForBudget }
  }
}

// ---- helpers -----------------------------------------------------------------------------------------

const LABEL: Readonly<Record<LearningRecord["kind"], string>> = {
  PROJECT_FACT: "Project fact",
  PROJECT_DECISION: "Decision",
  PROJECT_PATTERN: "Project pattern",
  REUSABLE_PATTERN: "Pattern",
  FAILURE_PATTERN: "Known failure pattern",
}

/** The compact form a record takes in a prompt: one line of what, one pointer to evidence. */
export function renderMemory(record: LearningRecord): string {
  return `${LABEL[record.kind]}: ${record.title}. ${record.summary} (evidence: ${record.evidenceRefs[0] ?? "user"})`
}

export function learnedSkillPath(skillId: string): string {
  return `${LEARNED_SKILLS_DIR}/${skillId}/SKILL.md`
}

/** Submitted-candidate id; the seed is always bounded canonical data, never raw input. */
function candidateId(seed: string): string {
  return `sc-${shortDigest(seed).slice(0, 12)}`
}

function candidateFingerprint(recordId: string, skillId: string): string {
  return shortDigest(`skill:${recordId}:${skillId}`)
}

function addRejection(rejections: readonly RejectionFingerprint[], next: RejectionFingerprint): RejectionFingerprint[] {
  return [...rejections.filter((item) => item.fingerprint !== next.fingerprint), next].slice(-LEARNING_LIMITS.maxRejections)
}

/** Inserts a record within its scope's cap, evicting STALE, then REJECTED, then the oldest OBSERVED. */
function enforceCapacity(records: readonly LearningRecord[], record: LearningRecord): LearningRecord[] | undefined {
  const cap = record.scope === "PROJECT" ? LEARNING_LIMITS.maxProjectRecords : LEARNING_LIMITS.maxReusableRecords
  const next = [...records, record]
  const inScope = () => next.filter((item) => item.scope === record.scope)
  for (const status of ["STALE", "REJECTED", "OBSERVED"] as const) {
    while (inScope().length > cap) {
      const victims = inScope().filter((item) => item.status === status && item.id !== record.id).toSorted((left, right) => left.successfulOccurrences - right.successfulOccurrences || left.updatedAt.localeCompare(right.updatedAt))
      if (victims.length === 0) break
      next.splice(next.indexOf(victims[0]!), 1)
    }
  }
  return inScope().length > cap ? undefined : next
}

function yamlList(key: string, values: readonly string[]): string {
  return `${key}:\n${values.map((value) => `  - ${value}`).join("\n")}`
}

const line = (text: string) => sanitizeLearningText(text, LEARNING_LIMITS.candidateLineChars)
const items = (values: readonly string[]) => values.slice(0, LEARNING_LIMITS.candidateListItems).map(line)
/** Frontmatter values get the same sanitiser as the body, then lose YAML-significant characters. */
const scalar = (text: string, maxChars: number) => sanitizeLearningText(text.replace(/[\n:]/g, " "), maxChars)

/** Renders the canonical Sprint 5A SKILL.md. Provenance stays in the learning store, not the frontmatter. */
export function renderSkill(candidate: LearnedSkillCandidate, version: number): string {
  const body = [
    `# Intent\n\n${line(candidate.intent)}`,
    `# When to Use\n\n${line(candidate.whenToUse)}`,
    `# Inputs\n\n${line(candidate.inputs)}`,
    `# Workflow\n\n${items(candidate.workflow).map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    `# Verification\n\n${items(candidate.verification).map((step) => `- ${step}`).join("\n")}`,
    `# Failure Modes\n\n${items(candidate.failureModes).map((step) => `- ${step}`).join("\n")}`,
    `# Exit Criteria\n\n${items(candidate.exitCriteria).map((step) => `- ${step}`).join("\n")}`,
  ].join("\n\n")
  const budget = Math.min(1_200, Math.max(SKILL_LIMITS.minContextBudget, Math.ceil(estimateTokens(body) * 1.25 / 50) * 50))
  const frontmatter = [
    `id: ${candidate.proposedSkillId}`,
    `name: ${scalar(candidate.title, SKILL_LIMITS.maxNameChars)}`,
    `description: ${scalar(candidate.description, SKILL_LIMITS.maxDescriptionChars)}`,
    `version: ${version}`,
    `category: ${candidate.category}`,
    yamlList("allowed_modes", candidate.proposedModes),
    yamlList("capabilities", candidate.proposedCapabilities),
    yamlList("required_tools", candidate.proposedTools),
    `context_budget: ${budget}`,
    "risk_level: low",
    ...(candidate.triggers.length > 0 ? [yamlList("triggers", candidate.triggers.slice(0, SKILL_LIMITS.maxTriggers).map((trigger) => scalar(trigger, SKILL_LIMITS.maxTriggerChars)))] : []),
  ].join("\n")
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

/** Validates a rendered SKILL.md with the exact Sprint 5A schema the registry uses, plus the candidate safety scan. */
export function validateRendered(content: string, directory: string): { ok: true } | { ok: false; reason: string } {
  try {
    if (Buffer.byteLength(content, "utf8") > SKILL_LIMITS.maxFileBytes) return { ok: false, reason: "too large" }
    const { frontmatter, body } = splitSkillDocument(content)
    validateSkillMetadata(parseSkillFrontmatter(frontmatter), directory)
    const { sections } = validateSkillBody(body)
    for (const section of REQUIRED_SKILL_SECTIONS) if (!sections.has(section)) return { ok: false, reason: `missing ${section}` }
    // The 5A body checks do not cover frontmatter; metadata reaches the skill index before the body
    // does, so the whole document passes the candidate safety scan.
    const issue = findContentSafetyIssue(content)
    if (issue) return { ok: false, reason: issue }
    return { ok: true }
  } catch (error) {
    // A code only: schema messages may quote the offending text.
    return { ok: false, reason: error instanceof SkillValidationError ? error.code : "invalid" }
  }
}
