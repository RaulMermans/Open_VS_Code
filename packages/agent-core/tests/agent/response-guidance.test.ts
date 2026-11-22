import { test } from "node:test"
import * as assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { CONVERSATIONAL_RESPONSE_GUIDANCE } from "../../src/agent/response-guidance.ts"

test("the runner asks for a natural answer without granting new authority", () => {
  assert.match(CONVERSATIONAL_RESPONSE_GUIDANCE, /language of the user's latest message/)
  assert.match(CONVERSATIONAL_RESPONSE_GUIDANCE, /short prose/)
  assert.match(CONVERSATIONAL_RESPONSE_GUIDANCE, /fenced code block only when/)
  assert.match(CONVERSATIONAL_RESPONSE_GUIDANCE, /verification results distinct/)
  assert.match(CONVERSATIONAL_RESPONSE_GUIDANCE, /unless that fact is present in the observations/)
  const runner = readFileSync(new URL("../../src/agent/runner.ts", import.meta.url), "utf8")
  assert.match(runner, /CONVERSATIONAL_RESPONSE_GUIDANCE/)
})
