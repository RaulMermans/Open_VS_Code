export interface HealthStatus {
  readonly status: "ok" | "degraded"
  readonly uptime: number
  readonly timestamp: string
}

export function getHealth(): HealthStatus {
  return {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }
}

export const healthRouter = {
  check: getHealth,
}
