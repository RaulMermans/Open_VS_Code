import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import * as format from "@/lib/utils/format"
describe("R3 hidden oracle", () => {
  it("formats durations", () => {
    const fd = (format as Record<string, unknown>).formatDuration as (ms: number) => string
    expect([fd(0), fd(950), fd(1000), fd(1500), fd(59_900), fd(65_000), fd(3_600_000)]).toEqual(["0 ms", "950 ms", "1.0 s", "1.5 s", "59.9 s", "1m 5s", "60m 0s"])
  })
  it("is used by RunSummaryView instead of inline formatting", () => {
    const view = readFileSync("components/runs/RunSummaryView.tsx", "utf8")
    expect(view).toMatch(/formatDuration\(/)
    expect(view).not.toMatch(/total_duration_ms \/ 1000\)\.toFixed/)
  })
})
