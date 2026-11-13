import test from "node:test"
import assert from "node:assert/strict"
import { PRODUCTION_MAX_TURNS, resolveAcceptanceMaxTurns } from "../../src/agent/acceptance-budget.ts"

test("production maxTurns stays 15 outside the acceptance lab", () => {
  assert.equal(PRODUCTION_MAX_TURNS, 15)
  assert.equal(resolveAcceptanceMaxTurns({}), 15)
  assert.equal(resolveAcceptanceMaxTurns({ OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "2" }), 15)
  assert.equal(resolveAcceptanceMaxTurns({
    OPEN_VS_CODE_ACCEPTANCE_LAB: "1",
    OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "2",
  }), 2)
  assert.equal(resolveAcceptanceMaxTurns({
    OPEN_VS_CODE_ACCEPTANCE_LAB: "1",
    OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "99",
  }), 15)
  assert.equal(resolveAcceptanceMaxTurns({
    OPEN_VS_CODE_ACCEPTANCE_LAB: "1",
    OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: "abc",
  }), 15)
})
