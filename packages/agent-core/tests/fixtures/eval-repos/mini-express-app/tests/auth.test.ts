import { requireAuth } from "../src/auth/middleware.ts"

// Intentionally failing test case for test diagnosis benchmarks:
// It expects token "invalid-token" to authenticate successfully.
export function testAuthScenario(): void {
  const result = requireAuth("Bearer invalid-token")
  if (!result.authenticated) {
    throw new Error("AUTH_ASSERTION_FAILED: Expected invalid-token to authenticate but received authenticated=false")
  }
}
