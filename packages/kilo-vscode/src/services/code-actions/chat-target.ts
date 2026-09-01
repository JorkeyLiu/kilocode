/**
 * P3.1 chat-surface routing contract, kept vscode-free so the readiness and
 * target-preference rules are executable-tested without an Extension Host.
 */

/** A ready-to-post chat surface. */
export type ChatTarget = {
  postMessage(msg: unknown): void
}

/**
 * Resolve a chat surface that is guaranteed to accept messages (webview
 * readiness already awaited), or `undefined` when the chosen surface never
 * became ready (e.g. the panel was closed while opening).
 */
export type ChatTargetResolver = () => Promise<ChatTarget | undefined>

/**
 * The Agent Manager surface: openable on demand and able to report webview
 * readiness.
 */
export type ChatSurface = ChatTarget & {
  isActive(): boolean
  waitForReady(): Promise<boolean>
  openPanel(): void
}

/**
 * Resolve the preferred ready chat target: Agent Manager is the sole chat
 * surface. Opens the panel on demand and waits for readiness. Returns
 * undefined when the panel never reports readiness.
 */
export async function resolveChatTarget(am: ChatSurface): Promise<ChatTarget | undefined> {
  if (am.isActive()) {
    return (await am.waitForReady()) ? am : undefined
  }
  am.openPanel()
  return (await am.waitForReady()) ? am : undefined
}
