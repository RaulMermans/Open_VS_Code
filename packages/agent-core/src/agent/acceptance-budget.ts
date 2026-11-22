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
