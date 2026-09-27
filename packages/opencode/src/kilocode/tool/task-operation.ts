// kilocode_change - runtime-owned prompt operation for task child + background inject
import { Cause, Effect, Exit } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import type { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"

function aborted(value: SessionV1.WithParts): boolean {
  const info = value.info
  if (info.role !== "assistant" || !info.error) return false
  const name = (info.error as { name?: unknown }).name
  if (typeof name === "string" && (name === "MessageAbortedError" || name === "AbortedError")) return true
  try {
    if (SessionV1.AbortedError.isInstance(info.error as never)) return true
  } catch {}
  return false
}

export namespace KiloTaskOperation {
  export function opIdFor(messageID: MessageID): string {
    return SessionOperation.promptId(messageID as string)
  }

  export function backgroundMessageID(child: SessionID): MessageID {
    const raw = child as unknown as string
    const suffix = raw.includes("_") ? raw.slice(raw.indexOf("_") + 1) : raw
    return `msg_${suffix}` as MessageID
  }

  // Process-local per-mid join so concurrent traced calls with the same
  // session+mid share one owner result instead of re-executing the
  // uncontrolled opts.run. Joiners await the owner promise only; interrupting
  // a joiner cancels its await, never the owner. Registration is a single
  // synchronous check-and-set (no yield inside), so two concurrent fibers
  // cannot both become owner. A row that is in-flight without a local owner
  // belongs to another process and is never joined here — only the crash
  // sweep may converge it.
  type JoinExit = Exit.Exit<SessionV1.WithParts, unknown>
  const inflight = new Map<string, PromiseWithResolvers<JoinExit>>()
  const joinKey = (sid: SessionID, opId: string): string => `${sid as unknown as string}:${opId}`

  const terminalize = Effect.fn("KiloTaskOperation.terminalize")(function* (
    db: Database.Interface["db"],
    sid: SessionID,
    opId: string,
    outcome: SessionOperation.GenerationTerminalOutcome,
    code: string,
    message: string,
    detail?: string,
  ) {
    const rec = SessionOperation.generationTerminal({
      opId,
      outcome,
      code,
      message,
      ...(detail !== undefined ? { detail } : {}),
    })
    // tryTransitionPromptTerminal is orDie: DB defects surface as defects.
    const exit = yield* Effect.exit(SessionOperation.tryTransitionPromptTerminal(db, sid, rec))
    if (exit._tag === "Failure") {
      yield* Effect.logWarning("task operation terminalize failed").pipe(
        Effect.annotateLogs({ opId, outcome, cause: Cause.pretty(exit.cause) }),
        Effect.ignore,
      )
      // Fail closed: without a proven terminal row the caller must not
      // observe success. The in-flight row stays for the crash sweep and the
      // warning above keeps the orphan visible.
      return yield* Effect.failCause(exit.cause)
    }
    if (!exit.value.applied) {
      const seen = exit.value.record?.outcome ?? "unknown"
      yield* Effect.logWarning("task operation terminal CAS race lost").pipe(
        Effect.annotateLogs({ opId, outcome, seen }),
        Effect.ignore,
      )
      return yield* Effect.die(
        new Error(`terminal CAS race lost for ${opId}: already ${seen}, cannot prove ${outcome}`),
      )
    }
  })

  const duplicate = Effect.fn("KiloTaskOperation.duplicate")(function* (
    sessions: Session.Interface,
    sid: SessionID,
    mid: MessageID,
  ) {
    const exit = yield* Effect.exit(sessions.messages({ sessionID: sid }))
    const msgs = exit._tag === "Success" ? exit.value : ([] as SessionV1.WithParts[])
    // Terminal replay must return the assistant owned by this mid only. A
    // later unrelated assistant in the same session must never satisfy the
    // replay; without a parentID match the replay is unprovable and dies.
    const owned = msgs.filter(
      (m) => m.info.role === "assistant" && (m.info as { parentID?: unknown }).parentID === (mid as unknown as string),
    )
    const last = [...owned].reverse()[0]
    if (last) return last
    return yield* Effect.die(new Error("duplicate prompt already terminal without owned assistant"))
  })

  export const traced = Effect.fn("KiloTaskOperation.traced")(function* <E, R>(opts: {
    db: Database.Interface["db"]
    sessions: Session.Interface
    sessionID: SessionID
    messageID: MessageID
    run: Effect.Effect<SessionV1.WithParts, E, R>
  }) {
    const sid = opts.sessionID
    const mid = opts.messageID
    const opId = opIdFor(mid)
    const key = joinKey(sid, opId)
    const slot = yield* Effect.sync(() => {
      const existing = inflight.get(key)
      if (existing) return { owner: false as const, entry: existing }
      const entry = Promise.withResolvers<JoinExit>()
      inflight.set(key, entry)
      return { owner: true as const, entry }
    })
    if (!slot.owner) {
      const joined = (yield* Effect.promise(() => slot.entry.promise)) as JoinExit
      if (Exit.isSuccess(joined)) return joined.value
      return yield* Effect.failCause(joined.cause as Cause.Cause<E>)
    }
    const entry = slot.entry
    const flag = { done: false }
    const settle = (outcome: JoinExit) =>
      Effect.sync(() => {
        if (flag.done) return
        flag.done = true
        entry.resolve(outcome)
        if (inflight.get(key) === entry) inflight.delete(key)
      }).pipe(Effect.uninterruptible)
    const body = Effect.gen(function* () {
      const inception = yield* SessionOperation.ensurePromptInFlight(opts.db, sid, opId)
      if (!inception.fresh) {
        if (inception.rowSessionId !== (sid as unknown as string)) {
          return yield* Effect.die(new Error(`cross-identity opId ${opId} already owned by session ${inception.rowSessionId}`))
        }
        if (SessionOperation.isTerminal(inception.record.outcome)) {
          return yield* duplicate(opts.sessions, sid, mid)
        }
        // In-flight without a local owner is owned by another process (or a
        // dead owner the sweep has not converged yet). Never re-execute here;
        // fail closed and let the crash sweep converge the orphan.
        return yield* Effect.die(
          new Error(`prompt ${opId} already in-flight owned elsewhere; converging via crash sweep`),
        )
      }
      const exit = yield* opts.run.pipe(Effect.exit)
      if (exit._tag === "Success") {
        if (aborted(exit.value)) {
          yield* terminalize(opts.db, sid, opId, "abandoned", "prompt.abandoned", "prompt abandoned")
        } else {
          yield* terminalize(opts.db, sid, opId, "succeeded", "prompt.succeeded", "prompt succeeded")
        }
        return exit.value
      }
      const cause = exit.cause
      if (Cause.hasInterruptsOnly(cause)) {
        yield* terminalize(opts.db, sid, opId, "abandoned", "prompt.abandoned", "prompt abandoned")
        return yield* Effect.failCause(cause)
      }
      const err = Cause.squash(cause)
      const raw = err instanceof Error ? err.message : String(err)
      const detail = Cause.pretty(cause)
      yield* terminalize(opts.db, sid, opId, "failed", "prompt.failed", raw, detail)
      return yield* Effect.failCause(cause)
    })
    const done = (yield* body.pipe(Effect.exit)) as JoinExit
    yield* settle(done)
    if (Exit.isSuccess(done)) return done.value
    return yield* Effect.failCause(done.cause as Cause.Cause<E>)
  })
}
