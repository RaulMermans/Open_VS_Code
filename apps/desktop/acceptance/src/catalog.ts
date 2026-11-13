import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type ScenarioGroup = "conversation" | "coding" | "safety" | "experience" | "lifecycle"
export type ScenarioDriver = "unit" | "artifact" | "electron" | "electron-chat" | "review"
export type ScenarioHarness = "unit" | "artifact" | "cdp-webview" | "playwright-workbench"
export type ScenarioTier = "critical" | "held-out" | "standard" | "review"

export interface ScenarioExpected {
  readonly transcriptIncludes?: readonly string[]
  readonly transcriptIncludesAny?: readonly string[]
  readonly transcriptExcludes?: readonly string[]
  readonly filesUnchanged?: boolean
  readonly unchangedPaths?: readonly string[]
  readonly gitClean?: boolean
  readonly absentPaths?: readonly string[]
  readonly command?: { readonly cmd: string; readonly args: readonly string[]; readonly exitCode: number }
  readonly argvExcludes?: readonly string[]
  readonly sandboxMode?: string
  readonly launcherExportsInference?: boolean
}

export interface AcceptanceScenario {
  readonly id: string
  readonly title: string
  readonly group: ScenarioGroup
  readonly tier: ScenarioTier
  readonly driver: ScenarioDriver
  readonly harness?: ScenarioHarness
  readonly mode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW" | "NONE"
  readonly trust: "trusted" | "untrusted" | "n/a"
  readonly fixture: string
  readonly approval: "approve" | "reject" | "none"
  readonly timeoutMs: number
  readonly model: string
  readonly prompt: string
  readonly followUp?: string
  readonly requiresInference: boolean
  readonly oracle: string
  readonly forbidden: readonly string[]
  readonly expected: ScenarioExpected
  /** Lab-only initial AgentRuntime budget. Production remains 15. */
  readonly maxTurns?: number
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

export function catalogPath(): string {
  return join(ROOT, "catalog", "v1", "scenarios.json")
}

export function fixturesRoot(): string {
  return join(ROOT, "fixtures")
}

export function loadCatalog(): AcceptanceScenario[] {
  const parsed = JSON.parse(readFileSync(catalogPath(), "utf8")) as { scenarios?: AcceptanceScenario[] }
  if (!parsed.scenarios) throw new Error("Scenario catalog is missing scenarios")
  validateCatalog(parsed.scenarios)
  return parsed.scenarios
}

export function validateCatalog(scenarios: readonly AcceptanceScenario[]): void {
  if (scenarios.length < 40 || scenarios.length > 55) {
    throw new Error(`Scenario catalog must contain 40 to 55 scenarios, found ${scenarios.length}`)
  }
  const ids = new Set<string>()
  for (const scenario of scenarios) {
    if (!scenario.id || ids.has(scenario.id)) throw new Error(`Duplicate or empty scenario id: ${scenario.id}`)
    ids.add(scenario.id)
    for (const field of ["title", "group", "tier", "driver", "oracle", "timeoutMs"] as const) {
      if (scenario[field] === undefined || scenario[field] === "") throw new Error(`${scenario.id} is missing ${field}`)
    }
    if (!Array.isArray(scenario.forbidden)) throw new Error(`${scenario.id} is missing forbidden behavior`)
    if (!scenario.expected) throw new Error(`${scenario.id} is missing expected behavior`)
    if (scenario.approval === "approve" && scenario.driver !== "electron-chat") {
      throw new Error(`${scenario.id} cannot approve outside an electron chat scenario`)
    }
    if (scenario.requiresInference && scenario.driver !== "electron-chat" && scenario.driver !== "review") {
      throw new Error(`${scenario.id} requests inference without the chat driver`)
    }
    if (scenario.harness && !["unit", "artifact", "cdp-webview", "playwright-workbench"].includes(scenario.harness)) {
      throw new Error(`${scenario.id} has an unknown harness`)
    }
  }
}

const PLAYWRIGHT_WORKBENCH = new Set([
  "SAFE-CANCEL",
  "LIFE-MODEL",
  "LIFE-SANDBOX",
  "LIFE-CRASH",
  "LIFE-STALE",
  "LIFE-SECOND-REPO",
  "LIFE-UPGRADE",
  "LIFE-ROLLBACK",
  "UX-TRUST",
  "UX-LAYOUT",
  "SAFE-STALE",
  "SAFE-NO-SILENT",
  "SAFE-PROFILE",
])

const CDP_WEBVIEW = new Set([
  "UX-WIDE",
  "UX-ACTIVITY",
  "UX-DIFF",
  "LIFE-HISTORY",
])

/** Playwright keeps workbench-only flows. Agent Webview flows use CDP. */
export function scenarioHarness(scenario: AcceptanceScenario): ScenarioHarness {
  if (scenario.harness) return scenario.harness
  if (scenario.driver === "unit") return "unit"
  if (scenario.driver === "artifact") return "artifact"
  if (CDP_WEBVIEW.has(scenario.id)) return "cdp-webview"
  if (PLAYWRIGHT_WORKBENCH.has(scenario.id)) return "playwright-workbench"
  if (scenario.driver === "electron-chat" && scenario.prompt) return "cdp-webview"
  return "playwright-workbench"
}
