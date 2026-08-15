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

/** An open editor-tab chat panel. */
export type ChatTab = ChatTarget & {
  waitForReady(): Promise<void>
}

/**
 * Resolve the preferred ready chat target: the active Agent Manager panel,
 * else the active editor-tab panel, else the Agent Manager opened on demand.
 * Returns undefined when the chosen surface never reported readiness, so
 * callers skip posting instead of dropping messages into an unprepared panel.
 * P3.1: the removed sidebar provider is intentionally never resolved.
 */
export async function resolveChatTarget(
  am: ChatSurface,
  getActiveTab: () => ChatTab | undefined,
): Promise<ChatTarget | undefined> {
  if (am.isActive()) {
    return (await am.waitForReady()) ? am : undefined
  }
  const tab = getActiveTab()
  if (tab) {
    await tab.waitForReady()
    return tab
  }
  am.openPanel()
  return (await am.waitForReady()) ? am : undefined
}

/**
 * Race a webview readiness wait against a deadline. Resolves true when the
 * wait settles first, false on timeout. Used where an unbounded readiness
 * wait would block a user-facing delivery (deep links).
 */
export function waitForChatReady(wait: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    wait.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}
