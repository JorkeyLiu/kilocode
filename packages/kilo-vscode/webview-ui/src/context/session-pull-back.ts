/**
 * Pending pull-back lifecycle for the queued-message pull-back-to-editor flow.
 *
 * `pending` maps messageID → sessionID for pull-back requests posted to the
 * backend but not yet confirmed. The composer restore fires only when the
 * backend confirms removal (message.removed → handleMessageRemoved in
 * session.tsx); nothing is captured or restored at click time. The cleanup
 * effect drops entries whose message leaves the queued set without removal —
 * e.g. cancelQueued no-ops because the slot was promoted to active
 * (removed:false, HTTP 200, no message.removed) — so a lingering entry never
 * restores content for a message that actually ran. An entry is pruned only
 * when the message is neither queued nor the active/pending slot: during the
 * window between the preceding turn's completion and the slot's promotion,
 * activeUserMessageID returns the pulled-back message, and a successful cancel
 * still delivers message.removed — pruning there would silently drop the
 * restore. A genuine no-op is pruned once the active slot moves past that
 * message or the session idles. `bump` re-runs the effect on every
 * registration. Reactive status/message reads happen inside the effect via the
 * getters so Solid tracks them.
 */
import { createEffect, createSignal } from "solid-js"
import type { Message, Part, SessionStatusInfo } from "../types/messages"
import { activeUserMessageID, queuedUserMessageIDs } from "./session-queue"

export interface PendingPullBacks {
  pending: Map<string, string>
  bump: () => void
}

/**
 * Decide whether a pending pull-back entry for `messageID` should be dropped.
 * Only when the message is neither queued nor the active/pending slot: during
 * the window between the preceding turn's completion and the slot's promotion,
 * activeUserMessageID returns the pulled-back message, and a successful cancel
 * still delivers message.removed — pruning there would silently drop the
 * restore. A genuine no-op (slot promoted, no message.removed ever) is pruned
 * once the active slot moves past that message or the session idles.
 */
export function shouldPrunePendingPullBack(
  messageID: string,
  messages: Message[],
  status: SessionStatusInfo,
  getParts: (messageID: string) => Part[],
): boolean {
  const queued = new Set(queuedUserMessageIDs(messages, status, (msg) => getParts(msg.id)))
  const active = activeUserMessageID(messages, status, (msg) => getParts(msg.id))
  return !queued.has(messageID) && active !== messageID
}

export function createPendingPullBacks(
  getStatus: (sessionID: string) => SessionStatusInfo,
  getMessages: (sessionID: string) => Message[] | undefined,
  getParts: (messageID: string) => Part[],
): PendingPullBacks {
  const pending = new Map<string, string>()
  const [tick, bump] = createSignal(0)
  createEffect(() => {
    tick()
    const entries = [...pending]
    if (entries.length === 0) return
    for (const [messageID, sid] of entries) {
      const status = getStatus(sid)
      const msgs = getMessages(sid) ?? []
      if (shouldPrunePendingPullBack(messageID, msgs, status, getParts)) pending.delete(messageID)
    }
  })
  return { pending, bump: () => bump((n) => n + 1) }
}
