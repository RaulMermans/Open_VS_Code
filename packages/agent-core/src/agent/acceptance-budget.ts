/**
 * Lab-only initial turn budget. Production chat stays at 15 unless the
 * acceptance lab process sets both flags. This does not change completion
 * semantics, Continue (+8, cap 40), or daily-driver defaults.
 */
export const PRODUCTION_MAX_TURNS = 15

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
