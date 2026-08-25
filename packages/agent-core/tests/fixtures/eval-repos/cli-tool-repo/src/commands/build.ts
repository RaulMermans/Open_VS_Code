export interface BuildOptions {
  readonly target: "node" | "browser"
  readonly watch?: boolean
}

export function runBuild(options: BuildOptions): { success: boolean; target: string } {
  if (options.target !== "node" && options.target !== "browser") {
    throw new Error(`Invalid build target: ${options.target}`)
  }
  return { success: true, target: options.target }
}
