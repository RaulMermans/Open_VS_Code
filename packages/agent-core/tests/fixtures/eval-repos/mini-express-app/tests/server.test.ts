import test from "node:test"
import { createServer } from "../src/server.ts"

test("testRoutes", () => {
  const srv = createServer()
  // @ts-ignore
  if (!srv.routes.includes("/api/users")) {
    throw new Error("Missing /api/users route")
  }
})
