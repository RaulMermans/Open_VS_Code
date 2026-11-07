import { verifyEffectiveSandboxSupport } from "../../src/browser/index.ts"

export const chromiumSandbox = verifyEffectiveSandboxSupport()

/** Skip real Chromium suites only on local hosts that cannot sandbox. CI never skips: missing sandbox must fail closed. */
export const skipWithoutChromiumSandbox: string | false =
  process.env.CI === "true" && process.platform === "linux"
    ? false
    : chromiumSandbox.supported
      ? false
      : chromiumSandbox.details
