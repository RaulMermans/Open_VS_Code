/**
 * Engineering Outcome Ledger (Sprint 26). A task-scoped view over existing run state, not a planner and not
 * stored anywhere new: outcomes are derived from the instruction's own structure, and statuses are recomputed
 * from applied edits and verification results, so a resumed run rebuilds it from the checkpoint's durable facts.
 * The model never marks an outcome done; only workspace evidence and verification do.
 */
export type OutcomeKind = "IMPLEMENTATION" | "TESTS" | "DOCUMENTATION" | "EXTERNAL"
export type OutcomeStatus = "PENDING" | "IN_PROGRESS" | "IMPLEMENTED" | "VERIFIED" | "BLOCKED" | "FAILED" | "UNVERIFIED"

export interface Outcome {
  readonly id: string
  readonly kind: OutcomeKind
  readonly title: string
  readonly terms: readonly string[]
  /** The brief's own words for this outcome (bounded), shown when it becomes the current work unit. */
  readonly brief: string
  readonly status: OutcomeStatus
  readonly files: readonly string[]
  readonly blocker?: string
  /** The section itself asks for tests ("Test in isolation: …"): its code is not done until a test file covers it. */
  readonly testsRequired?: boolean
  /** The cases the section's own test list names (its bullets), quoted back when the tests are still owed. */
  readonly testCases?: readonly string[]
}

export interface AppliedFile { readonly path: string; readonly content: string }
export interface LedgerVerification { readonly status: string; readonly afterLastEdit: boolean }

const IMPLEMENT_VERB = /\b(?:implement|add|extend|prepare|remove|build|create|update|fix|refactor|write|change|migrate|rename|replace|configure)\b/i
const READ_ONLY_HEADING = /\b(?:definition of done|acceptance criteria|inspect|audit|investigat|baseline|objective|overview|background|context|authority|report|reporting|qualification of the)\b/i
const EXTERNAL_HEADING = /\b(?:live|production|publish|push|install|restart|acceptance)\b|\bapproval\b/i
const APPROVAL = /\b(?:approval|approved|authoriz|authoris|operator)\b/i
const STOP = new Set(["should", "which", "their", "there", "would", "these", "those", "about", "after", "before", "while", "using", "existing", "request", "tests", "phase", "other", "every"])

function sections(instruction: string): { heading: string; body: string }[] {
  const parts = instruction.split(/^#{2,3}\s+/m).slice(1)
  return parts.map((part) => {
    const [heading = "", ...rest] = part.split("\n")
    return { heading: heading.trim(), body: rest.join("\n") }
  })
}

function termsOf(heading: string, body: string): string[] {
  const text = `${heading}\n${body}`
  const ticked = [...text.matchAll(/`([^`\n]{3,60})`/g)].map((m) => m[1]!.toLowerCase())
  const idents = [...text.matchAll(/\b([A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+|[a-z0-9]+(?:-[a-z0-9]+){2,})\b/g)].map((m) => m[1]!.toLowerCase())
  const words = [...heading.toLowerCase().matchAll(/[a-z]{6,}/g)].map((m) => m[0]).filter((w) => !STOP.has(w))
  const lead = [...body.trim().split(/(?<=[.!?])\s/)[0]!.toLowerCase().matchAll(/[a-z]{8,}/g)].map((m) => m[0]).filter((w) => !STOP.has(w))
  return [...new Set([...ticked, ...idents, ...words, ...lead])].slice(0, 24)
}

/** Outcomes the instruction asks for. Empty for anything that is not a multi-part engineering brief. */
/** Bullet items under a line that starts with "test"/"verify" (the brief's own list of cases to cover). */
function testCasesOf(body: string): string[] {
  const lines = body.split("\n")
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^\s*(?:[-*]\s*)?(?:test|tests|verify|add tests?)\b/i.test(lines[start]!)) continue
    const cases: string[] = []
    for (const line of lines.slice(start + 1)) {
      const item = /^\s*[-*]\s+(.+)$/.exec(line)
      if (item) cases.push(item[1]!.trim().slice(0, 100))
      else if (line.trim()) break
    }
    if (cases.length > 0) return cases.slice(0, 10)
  }
  return []
}

export function deriveOutcomes(instruction: string): Outcome[] {
  const out: Outcome[] = []
  for (const { heading, body } of sections(instruction)) {
    if (READ_ONLY_HEADING.test(heading) && !IMPLEMENT_VERB.test(heading)) continue
    if (/^\s*(?:deliverables?|tests?|run|report)\b/i.test(heading)) continue
    const text = `${heading}\n${body}`
    const external = EXTERNAL_HEADING.test(heading) && APPROVAL.test(text)
    if (!external && !IMPLEMENT_VERB.test(text)) continue
    const readOnly = /^\s*read-only\b/im.test(body) && !IMPLEMENT_VERB.test(heading)
    if (readOnly) continue
    const kind: OutcomeKind = external ? "EXTERNAL"
      : /\btests?\b/i.test(heading) ? "TESTS"
        : /\b(?:plan|procedure|runbook|document|report|strategy|deployment|safety)\b/i.test(heading) && !/\b(?:implement|build|config)/i.test(heading) ? "DOCUMENTATION"
          : "IMPLEMENTATION"
    out.push({
      id: `O${out.length + 1}`, kind, title: heading.replace(/^Phase\s+\d+\s*[—:-]\s*/i, "").slice(0, 80), terms: termsOf(heading, body), brief: body.trim().slice(0, 900),
      status: external ? "BLOCKED" : "PENDING", files: [],
      ...(kind === "IMPLEMENTATION" && /^\s*(?:[-*]\s*)?(?:test|tests|verify|add tests?)\b/im.test(body) ? { testsRequired: true, testCases: testCasesOf(body) } : {}),
      ...(external ? { blocker: "needs the operator's explicit approval; not performed" } : {}),
    })
  }
  return out
}

/** A brief with several separate implementation outcomes. Smaller requests keep the existing single-edit rules. */
export function isSubstantial(outcomes: readonly Outcome[]): boolean {
  return outcomes.filter((o) => o.kind === "IMPLEMENTATION" || o.kind === "TESTS").length >= 2
}

function hits(outcome: Outcome, file: AppliedFile): number {
  const haystack = `${file.path}\n${file.content}`.toLowerCase()
  return outcome.terms.filter((term) => haystack.includes(term)).length
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/i.test(path)
}

export function evaluateOutcomes(outcomes: readonly Outcome[], applied: readonly AppliedFile[], verification: LedgerVerification | undefined): Outcome[] {
  return outcomes.map((outcome) => {
    if (outcome.kind === "EXTERNAL") return outcome
    const scored = applied.map((file) => ({ file, n: hits(outcome, file) })).filter((m) => m.n > 0)
    const relevant = scored.filter((m) => outcome.kind === "TESTS" ? isTestPath(m.file.path)
      : outcome.kind === "DOCUMENTATION" ? /\.md$/i.test(m.file.path) : !isTestPath(m.file.path) && !/\.md$/i.test(m.file.path))
    const files = relevant.map((m) => m.file.path)
    // A section that asks for tests is evidenced by its code and its tests together; tests alone never count.
    const testEvidence = outcome.testsRequired === true && relevant.length > 0 ? scored.filter((m) => isTestPath(m.file.path)) : []
    const strong = [...relevant, ...testEvidence].some((m) => m.n >= 2 || m.n / Math.max(outcome.terms.length, 1) >= 0.25)
    let status: OutcomeStatus = relevant.length === 0 ? "PENDING" : strong ? "IMPLEMENTED" : "IN_PROGRESS"
    const testsMissing = outcome.testsRequired === true && !scored.some((m) => isTestPath(m.file.path))
    if (testsMissing && status === "IMPLEMENTED") status = "IN_PROGRESS"
    if (status === "IMPLEMENTED" && outcome.kind === "DOCUMENTATION") status = "VERIFIED"
    else if (status === "IMPLEMENTED") {
      status = !verification || !verification.afterLastEdit ? "UNVERIFIED"
        : verification.status === "PASS" ? "VERIFIED"
          : verification.status === "FAIL" ? "FAILED"
            : verification.status === "UNCHANGED_FAILURE" ? "IMPLEMENTED"
              : "UNVERIFIED"
    }
    return { ...outcome, status, files }
  })
}

/** Outcomes that block completion: implementation or tests not done, or verified failing. */
export function outcomeGaps(outcomes: readonly Outcome[]): string[] {
  return outcomes
    .filter((o) => (o.kind === "IMPLEMENTATION" || o.kind === "TESTS") && (o.status === "PENDING" || o.status === "IN_PROGRESS" || o.status === "FAILED"))
    .map((o) => `${o.id} ${o.title}: ${o.status === "FAILED" ? "tests fail after its edits" : o.status === "PENDING" ? "no edit yet" : o.testsRequired ? `its code is edited but the tests it asks for are not written${o.testCases?.length ? ` in a test file that covers it. Cases the request lists: ${o.testCases.join("; ")}` : ""}` : "edits do not yet cover it"}.`)
    .slice(0, 6)
}

export function formatOutcomeReport(outcomes: readonly Outcome[]): string {
  if (outcomes.length === 0) return ""
  const lines = outcomes.map((o) => `- ${o.id} [${o.status}] ${o.title}${o.files.length ? ` (${o.files.slice(0, 3).join(", ")})` : ""}${o.blocker ? ` — ${o.blocker}` : ""}`)
  return `Outcomes:\n${lines.join("\n")}`
}

/** The first outcome still owed, in the brief's order: the bounded work unit the next turns should finish. */
export function currentWorkUnit(outcomes: readonly Outcome[]): Outcome | undefined {
  return outcomes.find((o) => o.kind !== "EXTERNAL" && (o.status === "PENDING" || o.status === "IN_PROGRESS" || o.status === "FAILED" || o.status === "UNVERIFIED"))
}

export function formatWorkUnit(outcomes: readonly Outcome[]): string {
  const unit = currentWorkUnit(outcomes)
  if (!unit) return ""
  const done = outcomes.filter((o) => o.status === "VERIFIED" || o.status === "IMPLEMENTED").map((o) => o.id)
  const how = unit.kind === "DOCUMENTATION" ? "Write the document." : unit.status === "UNVERIFIED" ? "Its edits are made; run the tests." : "Make the code change, then run the tests."
  return `\n\n[CURRENT WORK UNIT ${unit.id} of ${outcomes.length}: ${unit.title}]\n${unit.brief}\n${how} Finish this unit before the others${done.length ? ` (done: ${done.join(", ")})` : ""}. If something it names does not exist in this workspace, say so and continue with what does.`
}
