export interface AppConfig {
  readonly port: number
  readonly jwtSecret: string
  readonly env: string
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || "3000", 10),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-key-12345",
  env: process.env.NODE_ENV || "development",
}
