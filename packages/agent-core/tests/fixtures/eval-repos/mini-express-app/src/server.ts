import { config } from "./config.ts"
import { requireAuth } from "./auth/middleware.ts"
import { usersRouter } from "./routes/users.ts"
import { healthRouter } from "./routes/health.ts"

export interface ServerInstance {
  readonly appName: string
  readonly port: number
  readonly routes: readonly string[]
  readonly middleware: readonly unknown[]
  readonly routers: readonly unknown[]
}

export function createServer(): ServerInstance {
  return {
    appName: "mini-express-app",
    port: config.port,
    routes: ["/health", "/api/users"],
    middleware: [requireAuth],
    routers: [healthRouter, usersRouter],
  }
}
