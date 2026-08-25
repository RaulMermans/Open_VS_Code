export function runClean(dir = "dist"): { deleted: boolean; directory: string } {
  return { deleted: true, directory: dir }
}
