import test from "node:test"
import { runBuild } from "../src/commands/build.ts"

test("testInvalidTarget", () => {
  try {
    runBuild({ target: "wasm" as unknown as "node" })
    throw new Error("BUILD_TEST_FAILED: Expected runBuild to throw for target 'wasm'")
  } catch (error) {
    if (error instanceof Error && error.message.includes("Invalid build target")) {
      return
    }
    throw error
  }
})

test("testValidTarget", () => {
  const result = runBuild({ target: "node" })
  if (!result.success) {
    throw new Error("BUILD_TEST_FAILED: Expected runBuild to succeed")
  }
})
