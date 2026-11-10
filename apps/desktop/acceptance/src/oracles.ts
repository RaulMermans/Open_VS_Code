export type SendAck = "not_attempted" | "acknowledged" | "unknown"

export interface ChatMessage {
  readonly role: "user" | "assistant" | "other"
  readonly text: string
  readonly status?: string
}

const PERMITTED_RUNTIME_FILES = new Set([
  ".open-vs-code/model-performance-ledger.json",
])

const PERMITTED_RUNTIME_PREFIXES = [
  ".open-vs-code/recovery/",
]

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

export function isPermittedRuntimePath(relativePath: string): boolean {
  const path = normalizeRelativePath(relativePath)
  if (PERMITTED_RUNTIME_FILES.has(path)) return true
  return PERMITTED_RUNTIME_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))
}

export function sourceDigest(digests: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(digests).filter(([path]) => !isPermittedRuntimePath(path)),
  )
}

export function gitLinePath(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ""
  const rest = trimmed.slice(2).trim()
  const renamed = rest.split(" -> ").pop() ?? rest
  return normalizeRelativePath(renamed.replace(/^"/, "").replace(/"$/, ""))
}

export function gitCleanProblems(porcelain: string, workspaceFiles: readonly string[]): string[] {
  const problems: string[] = []
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue
    const relativePath = gitLinePath(line)
    if (!relativePath) continue
    if (relativePath === ".open-vs-code" || relativePath.startsWith(".open-vs-code/")) {
      const nested = workspaceFiles.filter((path) => path === relativePath || path.startsWith(`${relativePath.replace(/\/$/, "")}/`) || (relativePath === ".open-vs-code" && path.startsWith(".open-vs-code/")))
      const unexpected = nested.filter((path) => !isPermittedRuntimePath(path))
      if (unexpected.length > 0) {
        problems.push(`unexpected runtime path: ${unexpected.join(", ")}`)
      }
      continue
    }
    problems.push(`git status is dirty: ${line}`)
  }
  return problems
}

export function classifySendAck(input: {
  readonly prompt: string
  readonly composerValue: string
  readonly userMessages: readonly string[]
  readonly sendClicked: boolean
  readonly clickError?: string
}): SendAck {
  const prompt = input.prompt.trim()
  if (userTurnExists(input.userMessages, prompt)) return "acknowledged"
  if (!input.sendClicked) return "not_attempted"
  const composer = input.composerValue.trim()
  if (composer.length > 0 && (composer === prompt || composer.includes(prompt))) return "not_attempted"
  // A cleared composer is not proof that Send created a user turn.
  return "unknown"
}

export function userTurnExists(userMessages: readonly string[], prompt: string): boolean {
  const needle = prompt.trim()
  return userMessages.some((text) => text.includes(needle))
}

export function turnAssistantText(messages: readonly ChatMessage[], prompt: string): string {
  return turnReplyText(messages, prompt, false)
}

export function turnReplyText(messages: readonly ChatMessage[], prompt: string, includeOther = true): string {
  const needle = prompt.trim()
  let lastUser = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role === "user" && message.text.includes(needle)) lastUser = index
  }
  if (lastUser < 0) return ""
  const parts: string[] = []
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role === "user") break
    if (message.role === "assistant" || (includeOther && message.role === "other" && message.text.trim())) parts.push(message.text)
  }
  return parts.join("\n")
}

export function trustStateFromWorkbench(text: string): "restricted" | "trusted" | "unknown" {
  if (/Restricted Mode/i.test(text)) return "restricted"
  if (/Trusted/i.test(text) && !/Restricted Mode/i.test(text)) return "trusted"
  return "unknown"
}

export function classifyPingContent(text: string): {
  readonly transportTextPresent: boolean
  readonly protocolLeak: boolean
  readonly contentOk: boolean
} {
  const protocolLeak = /<tool_call\b|<\/tool_call>|<function=/.test(text)
  const transportTextPresent = /\bpong\b/i.test(text)
  return {
    transportTextPresent,
    protocolLeak,
    contentOk: transportTextPresent && !protocolLeak,
  }
}

export function redactUrl(url: string): string {
  const cut = url.split("#")[0] ?? url
  const noQuery = cut.split("?")[0] ?? cut
  return noQuery.slice(0, 240)
}

export interface LifecycleEvent {
  readonly at: number
  readonly kind: string
  readonly detail: string
}

export function unexpectedReload(events: readonly LifecycleEvent[], afterMs: number): boolean {
  const relevant = events.filter((event) => event.at >= afterMs)
  const detached = relevant.some((event) => event.kind === "frame-detached" && /webview|active-frame|vscode-webview/i.test(event.detail))
  const attached = relevant.some((event) => event.kind === "frame-attached" && /webview|active-frame|vscode-webview/i.test(event.detail))
  return detached && attached
}
