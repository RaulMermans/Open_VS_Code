import assert from "node:assert/strict"
import test from "node:test"
import { mutationPrompt } from "../src/bridge.ts"

test("a dependency manifest edit says so in the approval prompt; an ordinary file does not", () => {
  assert.match(mutationPrompt({ path: "apps/x/package.json", operation: "patch" }), /changes project dependencies or scripts/i)
  assert.match(mutationPrompt({ operation: "patch", files: [{ path: "src/a.ts" }, { path: "pnpm-lock.yaml" }] }), /changes project dependencies or scripts/i)
  assert.doesNotMatch(mutationPrompt({ path: "src/a.ts", operation: "patch" }), /dependencies/)
})
