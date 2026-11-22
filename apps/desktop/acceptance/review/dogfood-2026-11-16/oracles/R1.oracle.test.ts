import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import * as format from "@/lib/utils/format"
describe("R1 hidden oracle", () => {
  it("exports SCORE_THRESHOLDS and scoreTone with unchanged behavior", () => {
    const f = format as Record<string, unknown>
    expect(f.SCORE_THRESHOLDS).toEqual({ healthy: 80, warning: 60 })
    expect(typeof f.scoreTone).toBe("function")
    expect("statusTone" in f).toBe(false)
    const tone = f.scoreTone as (n: number) => string
    expect([tone(80), tone(79), tone(60), tone(59)]).toEqual(["success", "warning", "warning", "danger"])
    expect([format.statusForScore(80), format.statusForScore(60), format.statusForScore(10)]).toEqual(["Healthy", "Warning", "Critical"])
  })
  it("updates the importer and leaves unrelated local helpers alone", () => {
    expect(readFileSync("components/dashboard/HealthOverview.tsx", "utf8")).toMatch(/scoreTone/)
    for (const file of ["components/dashboard/RegistryWorkflowCard.tsx", "app/dashboard/integrations/page.tsx", "app/dashboard/workflows/registry/[registryId]/page.tsx"]) {
      expect(readFileSync(file, "utf8")).toMatch(/function statusTone\(/)
    }
  })
})
