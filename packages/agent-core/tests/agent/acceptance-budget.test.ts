import test from "node:test"
import assert from "node:assert/strict"
import {
  PRODUCTION_MAX_TURNS,
  TASK_DURATION_PROFILES,
  UNLIMITED_MAX_TURNS,
  isUnlimitedTurnBudget,
  resolveAcceptanceMaxTurns,
  resolveTaskDurationMs,
} from "../../src/agent/acceptance-budget.ts"

test("production chat has no turn cap outside the acceptance lab", () => {
  assert.equal(PRODUCTION_MAX_TURNS, UNLIMITED_MAX_TURNS)
  assert.equal(isUnlimitedTurnBudget(PRODUCTION_MAX_TURNS), true)
  assert.equal(resolveAcceptanceMaxTurns({}), UNLIMITED_MAX_TURNS)
  assert.equal(resolveAcceptanceMaxTurns({ OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "2" }), UNLIMITED_MAX_TURNS)
  assert.equal(resolveAcceptanceMaxTurns({
    OPEN_VS_CODE_ACCEPTANCE_LAB: "1",
    OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "2",
  }), 2)
  assert.equal(resolveAcceptanceMaxTurns({
    OPEN_VS_CODE_ACCEPTANCE_LAB: "1",
    OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "99",
  }), UNLIMITED_MAX_TURNS)
  assert.equal(resolveAcceptanceMaxTurns({
    OPEN_VS_CODE_ACCEPTANCE_LAB: "1",
    OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "abc",
  }), UNLIMITED_MAX_TURNS)
})

test("execution profiles are ceilings, not mandatory durations", () => {
  assert.equal(TASK_DURATION_PROFILES.small, 15 * 60_000)
  assert.equal(TASK_DURATION_PROFILES.extended, 120 * 60_000)
  assert.equal(resolveTaskDurationMs("engineering", {}), 60 * 60_000)
  assert.equal(resolveTaskDurationMs("sprint", { OPEN_VS_CODE_TASK_BUDGET_MS: "120000" }), 120_000)
  assert.equal(resolveTaskDurationMs(undefined, {}), undefined)
})
