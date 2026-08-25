import { runBuild } from "../src/commands/build.ts"

// Intentionally failing test case for test diagnosis benchmarks:
export function testInvalidTarget(): void {
  // Expected to throw "Invalid build target"
  try {
    runBuild({ target: "wasm" as unknown as "node" })
    throw new Error("BUILD_TEST_FAILED: Expected runBuild to throw for target 'wasm'")
  } catch (error) {
    if (error instanceof Error && error.message.includes("Invalid build target")) {
      // test passes
      return
    }
    throw error
  }
}
