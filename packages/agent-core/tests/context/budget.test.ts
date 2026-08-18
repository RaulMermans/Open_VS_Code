import assert from "node:assert/strict"
import test from "node:test"

import type { ContextItem } from "../../src/contracts/context.ts"
import { ContextBudgetError, calculateBudget, estimateTokens, fitContext, rankContext } from "../../src/context/budget.ts"

function item(id: string, tokens: number, options: Partial<ContextItem> = {}): ContextItem {
  return {
    id,
    source: { kind: "background" },
    content: id,
    priority: 0,
    estimatedTokens: tokens,
    required: false,
    ...options,
  }
}

test("calculates available context and validates negative or over-reserved values", () => {
  assert.deepEqual(calculateBudget({ contextWindow: 100, reservedOutput: 20, reservedToolHistory: 10 }), {
    contextWindow: 100,
    reservedOutput: 20,
    reservedToolHistory: 10,
    availableContext: 70,
  })
  assert.throws(() => calculateBudget({ contextWindow: 10, reservedOutput: -1, reservedToolHistory: 0 }), ContextBudgetError)
  assert.throws(() => calculateBudget({ contextWindow: 10, reservedOutput: 8, reservedToolHistory: 3 }), ContextBudgetError)
})

test("uses a deterministic approximate token estimate", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("1234"), 1)
  assert.equal(estimateTokens("12345"), 2)
})

test("fits exact boundaries, many optional items, and an empty context", () => {
  const budget = calculateBudget({ contextWindow: 10, reservedOutput: 0, reservedToolHistory: 0 })
  assert.deepEqual(fitContext([], budget), { items: [], totalEstimatedTokens: 0, budget, omittedItemIds: [] })
  const result = fitContext([item("high", 6, { priority: 10 }), item("low", 4), item("extra", 1)], budget)
  assert.deepEqual(result.items.map((entry) => entry.id), ["high", "low"])
  assert.deepEqual(result.omittedItemIds, ["extra"])
  assert.equal(result.totalEstimatedTokens, 10)
})

test("fails explicitly when required context exceeds a tiny budget", () => {
  const budget = calculateBudget({ contextWindow: 2, reservedOutput: 0, reservedToolHistory: 0 })
  assert.throws(() => fitContext([item("rules", 3, { required: true })], budget), { code: "REQUIRED_CONTEXT_OVERFLOW" })
})

test("deduplicates equivalent content before charging the budget", () => {
  const budget = calculateBudget({ contextWindow: 4, reservedOutput: 0, reservedToolHistory: 0 })
  const duplicate = item("copy", 4, { content: "same", source: { kind: "retrieved-code", path: "src/a.ts" } })
  const result = fitContext([
    item("original", 4, { content: "same", source: { kind: "retrieved-code", path: "src/a.ts" } }),
    duplicate,
  ], budget)
  assert.deepEqual(result.items.map((entry) => entry.id), ["original"])
  assert.deepEqual(result.omittedItemIds, ["copy"])
})

test("ranks by configurable source order and stable item priority", () => {
  const items = [
    item("background", 1),
    item("task", 1, { source: { kind: "task" } }),
    item("code", 1, { source: { kind: "active-code" }, priority: 50 }),
  ]
  assert.deepEqual(rankContext(items).map((entry) => entry.id), ["task", "code", "background"])
  assert.deepEqual(rankContext(items, ["background", "task", "active-code"]).map((entry) => entry.id), ["background", "task", "code"])
})

test("rejects invalid item token costs", () => {
  const budget = calculateBudget({ contextWindow: 10, reservedOutput: 0, reservedToolHistory: 0 })
  assert.throws(() => fitContext([item("invalid", -1)], budget), ContextBudgetError)
})
