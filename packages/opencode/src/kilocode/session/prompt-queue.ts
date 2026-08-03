import { Effect } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"

type Slot = {
  readonly seq: number
  readonly version: number
  readonly previous: Promise<void>
  readonly done: PromiseWithResolvers<void>
  readonly tail: Promise<void>
}

type Target = {
  readonly base: MessageID
  readonly extras: ReadonlySet<MessageID>
}

export namespace KiloSessionPromptQueue {
  const tails = new Map<SessionID, Promise<void>>()
  const versions = new Map<SessionID, number>()
  const targets = new Map<SessionID, Target>()
  // Monotonic arrival counter per session. latest holds the seq of the most
  // recently enqueued slot; activeSince snapshots latest at the moment the
  // currently running slot actually started. hasFollowup returns true only when
  // a newer slot was enqueued after the active one began running.
  const latest = new Map<SessionID, number>()
  const activeSince = new Map<SessionID, number>()
  // Per-message cancellation tracking. pending maps each queued prompt's target
  // MessageID to its session and arrival seq while the slot is waiting to
  // start; the entry is removed the moment the slot begins running, so a
  // running slot is no longer cancellable per-message. dropped holds targets
  // flagged by cancelOne so the waiting slot runs its cancelled effect instead
  // of its work.
  const pending = new Map<MessageID, { session: SessionID; seq: number }>()
  const dropped = new Set<MessageID>()
  let seq = 0

  /** @internal - test-only helper */
  export function _hasInternalState(sessionID: SessionID): boolean {
    const waiting = [...pending.values()].some((item) => item.session === sessionID)
    return (
      versions.has(sessionID) ||
      targets.has(sessionID) ||
      latest.has(sessionID) ||
      activeSince.has(sessionID) ||
      waiting
    )
  }

  /** @internal - test-only helper: is a target messageID still waiting to start? */
  export function _isQueued(sessionID: SessionID, messageID: MessageID): boolean {
    return pending.get(messageID)?.session === sessionID
  }

  const version = (sessionID: SessionID) => versions.get(sessionID) ?? 0
  const settle = (promise: Promise<void>) =>
    promise.then(
      () => undefined,
      () => undefined,
    )

  export function cancel(sessionID: SessionID) {
    return Effect.sync(() => {
      if (!tails.has(sessionID)) {
        versions.delete(sessionID)
        targets.delete(sessionID)
        latest.delete(sessionID)
        activeSince.delete(sessionID)
        return
      }
      versions.set(sessionID, version(sessionID) + 1)
    })
  }

  /**
   * Cancel a single not-yet-started queued prompt by its target MessageID.
   * The whole-session cancel() aborts every queued slot; this flags exactly one.
   * Returns true only when a waiting slot for that message existed, so the
   * currently running slot is never interrupted (its target has already left
   * pending) and unknown or completed IDs are a no-op. The flagged slot runs its
   * cancelled effect instead of its work when it reaches the front of the queue.
   */
  export function cancelOne(sessionID: SessionID, messageID: MessageID) {
    return Effect.sync(() => {
      if (pending.get(messageID)?.session !== sessionID) return false
      dropped.add(messageID)
      return true
    })
  }

  /**
   * Exempt an injected user message from being hidden by scope().
   * Called after internal follow-ups or compaction markers are persisted so
   * they are visible without also unhiding unrelated prompts queued mid-turn.
   */
  export function retarget(sessionID: SessionID, id: MessageID) {
    const current = targets.get(sessionID)
    if (!current) return
    const extras = new Set(current.extras)
    extras.add(id)
    targets.set(sessionID, { base: current.base, extras })
  }

  export function active(sessionID: SessionID) {
    return targets.get(sessionID)?.base
  }

  /**
   * True when a newer prompt was enqueued after the currently running slot
   * began. runLoop calls this between LLM steps to break out so the next
   * queued prompt can take over without starting another LLM round-trip for
   * the now-superseded turn.
   */
  export function hasFollowup(sessionID: SessionID): boolean {
    const a = activeSince.get(sessionID) ?? 0
    // A cancelled-but-not-yet-drained slot still counts toward latest, so the
    // raw counter alone would report a follow-up that will never run. Only a
    // waiting slot that is newer than the active snapshot and not flagged by
    // cancelOne is a real follow-up.
    for (const [id, item] of pending) {
      if (item.session !== sessionID) continue
      if (item.seq <= a) continue
      if (dropped.has(id)) continue
      return true
    }
    return false
  }

  export function scope(sessionID: SessionID, messages: MessageV2.WithParts[]) {
    const target = targets.get(sessionID)
    if (!target) return messages

    const hidden = new Set(
      messages
        .filter((item) => item.info.role === "user" && item.info.id > target.base && !target.extras.has(item.info.id))
        .map((item) => item.info.id),
    )
    const visible = messages.filter((item) => {
      if (item.info.role === "user") return !hidden.has(item.info.id)
      if (item.info.role === "assistant") return !hidden.has(item.info.parentID)
      return true
    })

    // When a user prompt is queued mid-turn, its time_created falls in the
    // middle of the prior turn's messages (a later assistant step in that turn
    // was written after the queue event). Ordering by time_created alone puts
    // the queued prompt before the prior turn's final assistant reply, which
    // makes the next request end with an assistant message and trips Anthropic's
    // prefill rejection. Move the target user message (and any injected
    // follow-ups) plus their own turn's assistant messages to the end so the
    // request always ends with the queued user prompt (or its latest assistant
    // step).
    const ownsID = (id: MessageID) => id === target.base || target.extras.has(id)
    const owns = (item: MessageV2.WithParts) => {
      if (item.info.role === "user") return ownsID(item.info.id)
      if (item.info.role === "assistant") return ownsID(item.info.parentID)
      return false
    }
    const before: MessageV2.WithParts[] = []
    const after: MessageV2.WithParts[] = []
    for (const item of visible) (owns(item) ? after : before).push(item)
    if (after.length === 0) return visible
    return [...before, ...after]
  }

  export function enqueue<A, E>(
    sessionID: SessionID,
    target: MessageID,
    work: Effect.Effect<A, E>,
    cancelled: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const mine = ++seq
        latest.set(sessionID, mine)
        pending.set(target, { session: sessionID, seq: mine })
        const previous = tails.get(sessionID) ?? Promise.resolve()
        const done = Promise.withResolvers<void>()
        // Keep later queued prompts moving; each caller still observes its own failure.
        const tail = settle(previous).then(() => done.promise)
        tails.set(sessionID, tail)
        return { seq: mine, version: version(sessionID), previous, done, tail } satisfies Slot
      }),
      (slot) =>
        Effect.promise(() => settle(slot.previous)).pipe(
          Effect.flatMap(() => {
            // The slot reached the front of the queue: it is now the running one
            // and no longer cancellable per-message. dropped.delete both reads and
            // clears the per-message flag set by cancelOne.
            pending.delete(target)
            if (slot.version !== version(sessionID) || dropped.delete(target)) return cancelled
            // Snapshot the latest seq at the moment this slot actually starts
            // running. hasFollowup compares against this value so the slot only
            // breaks when something newer than itself arrives.
            activeSince.set(sessionID, latest.get(sessionID) ?? slot.seq)
            return Effect.acquireUseRelease(
              Effect.sync(() => {
                targets.set(sessionID, { base: target, extras: new Set() })
              }),
              () => work,
              () =>
                Effect.sync(() => {
                  if (targets.get(sessionID)?.base === target) targets.delete(sessionID)
                }),
            )
          }),
        ),
      (slot) =>
        Effect.sync(() => {
          pending.delete(target)
          dropped.delete(target)
          slot.done.resolve()
          if (tails.get(sessionID) !== slot.tail) return
          tails.delete(sessionID)
          versions.delete(sessionID)
          targets.delete(sessionID)
          latest.delete(sessionID)
          activeSince.delete(sessionID)
        }),
    )
  }
}
