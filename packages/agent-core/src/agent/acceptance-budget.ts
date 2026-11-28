/**
 * Daily-driver chat has no turn cap. The runner still accepts an explicit
 * positive maxTurns for tests and the acceptance lab (OPEN_VS_CODE_ACCEPTANCE_LAB=1
 * plus OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS). Continue remains available after a
 * lab pause. Stop/cancel still abort a run.
 */
export const UNLIMITED_MAX_TURNS = Number.MAX_SAFE_INTEGER
export const PRODUCTION_MAX_TURNS = UNLIMITED_MAX_TURNS

export function isUnlimitedTurnBudget(maxTurns: number): boolean {
  return maxTurns >= UNLIMITED_MAX_TURNS
}

/** Wall-clock ceilings. They cap a run; they are not a target duration. */
export const TASK_DURATION_PROFILES = {
  small: 15 * 60_000,
  application: 30 * 60_000,
  engineering: 60 * 60_000,
  sprint: 90 * 60_000,
  extended: 120 * 60_000,
} as const

export type TaskDurationProfile = keyof typeof TASK_DURATION_PROFILES

export function resolveTaskDurationMs(
  profile: string | undefined = process.env.OPEN_VS_CODE_EXECUTION_PROFILE,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.OPEN_VS_CODE_TASK_BUDGET_MS?.trim()
  if (raw) {
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= TASK_DURATION_PROFILES.extended) return parsed
  }
  if (!profile) return undefined
  const key = profile.trim().toLowerCase() as TaskDurationProfile
  return TASK_DURATION_PROFILES[key]
}

export function resolveAcceptanceMaxTurns(
  env: NodeJS.ProcessEnv = process.env,
  productionDefault = PRODUCTION_MAX_TURNS,
): number {
  if (env.OPEN_VS_CODE_ACCEPTANCE_LAB !== "1") return productionDefault
  const raw = env.OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS?.trim()
  if (!raw) return productionDefault
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 14) return productionDefault
  return parsed
}
