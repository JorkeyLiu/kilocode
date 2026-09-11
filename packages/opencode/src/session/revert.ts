import { Effect, Exit, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Log } from "@opencode-ai/core/util/log"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { SessionRevertBoundary } from "./revert-boundary"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

// kilocode_change start - Snapshot v2 correctness base: typed fail-closed snapshot failures propagate;
// Busy stays 409, path validation maps to 400, git failures map to 500 at the HTTP boundary.
export type Failure = Session.BusyError | Snapshot.RestoreError | Snapshot.RevertError | Snapshot.PathError
// kilocode_change end

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Failure>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Failure>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    // kilocode_change start - per-session serialization owned by this layer; entries drop when idle (no leak).
    // File rollback window uses Snapshot.exclusive (worktree-keyed Semaphore + EffectFlock);
    // this layer keeps only the per-session mutex for marker/message atomicity. Cleanup has no
    // FS mutation and never takes the Snapshot exclusive.
    const mutex = KeyedMutex.makeUnsafe<string>()
    // kilocode_change end

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      return yield* mutex.withLock(input.sessionID)(
        Effect.gen(function* () {
          yield* state.assertNotBusy(input.sessionID)
          const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

          // kilocode_change - boundary resolution is shared with the Snapshot v2
          // journal coverage planner. Patch collection keeps the old
          // implementation: strictly after the physical anchor (see
          // SessionRevertBoundary.patchesAfter), not the planner deletion interval.
          const boundary = SessionRevertBoundary.resolve(all, input)
          let rev: Session.Info["revert"]
          const patches: Snapshot.Patch[] = []
          if (boundary) {
            rev = {
              messageID: boundary.messageID,
              partID: boundary.partID,
            }
            for (const part of SessionRevertBoundary.patchesAfter(all, boundary)) patches.push(part as Snapshot.Patch)
          }

          if (!rev) return session

          const needsRestore = !!session.revert?.snapshot
          const needsFiles = patches.length > 0
          const finish = Effect.fn("SessionRevert.finishRevert")(function* (hash: string | undefined) {
            rev.snapshot = hash
            // kilocode_change start - diff is display-derived: best-effort, never gates file success.
            const range = all.filter((msg) => msg.info.id >= rev.messageID)
            const diffs = yield* summary.computeDiff({ messages: range }).pipe(Effect.orElseSucceed(() => []))
            if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot).pipe(Effect.orElseSucceed(() => ""))
            yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
            yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs }).pipe(Effect.ignore)
            // kilocode_change end
            const summaryDiffs: Snapshot.SummaryFileDiff[] = diffs.map((d) => ({
              file: d.file,
              additions: d.additions,
              deletions: d.deletions,
              status: d.status,
            }))
            yield* sessions.setRevert({
              sessionID: input.sessionID,
              revert: rev,
              summary: {
                additions: diffs.reduce((sum, x) => sum + x.additions, 0),
                deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
                files: diffs.length,
                diffs: summaryDiffs,
              },
            })
            return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          })

          if (!needsRestore && !needsFiles) return yield* finish(undefined)
          // kilocode_change start - file window holds one Snapshot exclusive across
          // track -> restore/revert -> optional rollback; raw only, never public locked methods.
          // Marker/display stay outside exclusive but inside per-session lock; FS failure writes no marker.
          const hash = yield* snap.exclusive((raw) =>
            Effect.gen(function* () {
              const rollback = yield* raw.track()
              const current = session.revert?.snapshot ?? rollback ?? (yield* raw.track())
              const back = Effect.fn("SessionRevert.back")(function* (id: string | undefined) {
                if (!id) return
                const out = yield* Effect.exit(raw.restore(id))
                if (Exit.isFailure(out)) log.warn("revert rollback restore failed", { hash: id })
              })
              if (needsRestore) {
                const out = yield* Effect.exit(raw.restore(session.revert!.snapshot!))
                if (Exit.isFailure(out)) {
                  yield* back(rollback)
                  return yield* Effect.failCause(out.cause)
                }
              }
              if (needsFiles) {
                const out = yield* Effect.exit(raw.revert(patches))
                if (Exit.isFailure(out)) {
                  yield* back(rollback)
                  return yield* Effect.failCause(out.cause)
                }
              }
              return current
            }),
          )
          return yield* finish(hash)
        }),
      )
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      return yield* mutex.withLock(input.sessionID)(
        Effect.gen(function* () {
          log.info("unreverting", input)
          yield* state.assertNotBusy(input.sessionID)
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          if (!session.revert) return session
          // kilocode_change start - message-only (no hash) clears marker without FS work.
          if (!session.revert.snapshot) {
            yield* sessions.clearRevert(input.sessionID)
            return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          }
          // kilocode_change end
          // kilocode_change start - unrevert file window is also worktree exclusive; raw only.
          const target = session.revert.snapshot
          yield* snap.exclusive((raw) =>
            Effect.gen(function* () {
              const rollback = yield* raw.track()
              const out = yield* Effect.exit(raw.restore(target))
              if (Exit.isFailure(out)) {
                if (rollback) {
                  const back = yield* Effect.exit(raw.restore(rollback))
                  if (Exit.isFailure(back)) log.warn("revert rollback restore failed", { hash: rollback })
                }
                return yield* Effect.failCause(out.cause)
              }
            }),
          )
          yield* sessions.clearRevert(input.sessionID)
          return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        }),
      )
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      return yield* mutex.withLock(session.id)(
        Effect.gen(function* () {
          if (!session.revert) return
          const sessionID = session.id
          const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
          const messageID = session.revert.messageID
          const remove = [] as SessionV1.WithParts[]
          let target: SessionV1.WithParts | undefined
          for (const msg of msgs) {
            if (msg.info.id < messageID) continue
            if (msg.info.id > messageID) {
              remove.push(msg)
              continue
            }
            if (session.revert.partID) {
              target = msg
              continue
            }
            remove.push(msg)
          }
          for (const msg of remove) {
            yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
          }
          if (session.revert.partID && target) {
            const partID = session.revert.partID
            const idx = target.parts.findIndex((part) => part.id === partID)
            if (idx >= 0) {
              const removeParts = target.parts.slice(idx)
              target.parts = target.parts.slice(0, idx)
              for (const part of removeParts) {
                yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
              }
              // kilocode_change start - clear a reverted provider error from the retained assistant message
              if (target.info.role === "assistant" && target.info.error) {
                delete target.info.error
                yield* sessions.updateMessage(target.info)
              }
              // kilocode_change end
            }
          }
          yield* sessions.clearRevert(sessionID)
        }),
      )
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
