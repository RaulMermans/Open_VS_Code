import { verifyEffectiveSandboxSupport } from "../../src/browser/index.ts"

export const chromiumSandbox = verifyEffectiveSandboxSupport()

/** Skip real Chromium suites when the host cannot launch a sandboxed browser. */
export const skipWithoutChromiumSandbox: string | false = chromiumSandbox.supported
  ? false
  : chromiumSandbox.details
