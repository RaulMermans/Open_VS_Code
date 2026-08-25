import { sum } from "../src/math.ts"

// This assertion is intentionally wrong for the diagnostic fixture.
if (sum(1, 2) !== 4) throw new Error("expected four")
