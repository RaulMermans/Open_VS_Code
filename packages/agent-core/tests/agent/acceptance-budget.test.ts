import test from "node:test"
import assert from "node:assert/strict"
import {
  PRODUCTION_MAX_TURNS,
  UNLIMITED_MAX_TURNS,
  isUnlimitedTurnBudget,
  resolveAcceptanceMaxTurns,
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
