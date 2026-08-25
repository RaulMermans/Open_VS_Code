export function resolveConfigPath(customPath?: string): string {
  return customPath || "rocket.config.json"
}
