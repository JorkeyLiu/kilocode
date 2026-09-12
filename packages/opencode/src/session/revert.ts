import { Effect, Exit, Layer, Context, Schema, Option } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { SnapshotJournal } from "../snapshot/journal"
import { SnapshotCoveragePlan } from "../snapshot/coverage-plan"
import { SnapshotJournalCas } from "../snapshot/journal-cas"
import { InstanceState } from "@/effect/instance-state"
import { Storage } from "@/storage/storage"
import { Log } from "@opencode-ai/core/util/log"
import { FSUtil } from "@opencode-ai/core/fs-util"
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
// Journal CAS failures join the same contract: journal path is 400, the rest is 500, never 409.
export type Failure =
  | Session.BusyError
  | Snapshot.RestoreError
  | Snapshot.RevertError
  | Snapshot.PathError
  | SnapshotJournal.PathError
  | SnapshotJournal.Conflict
  | SnapshotJournal.NotFound
  | SnapshotJournal.DbError
  | SnapshotJournal.ApplyError
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

    // kilocode_change start - journal coverage is read-only outside exclusive.
    // Re-plans from marker messageID/partID on unrevert/chained revert; never
    // expands Session.Info.revert schema. Journal/FS/worktree gate the single
    // list: rows are read at most once per revert/unrevert and shared by the
    // pure planner, so next/prev never see different snapshots. List failure
    // falls back, never fails.
    const optionOf = <A>(opt: Option.Option<A>) => (opt._tag === "Some" ? opt.value : undefined)

    const journalOf = Effect.gen(function* () {
      const j = optionOf(yield* Effect.serviceOption(SnapshotJournal.Service))
      const f = optionOf(yield* Effect.serviceOption(FSUtil.Service))
      return j && f ? ({ journal: j, fsys: f } as const) : undefined
    })

    const worktreeOf = InstanceState.context.pipe(
      Effect.map((ctx) => ctx.worktree),
      Effect.orElseSucceed(() => undefined as string | undefined),
    )

    const rowsOnce = Effect.fn("SessionRevert.rowsOnce")(function* (sessionID: string) {
      const worktree = yield* worktreeOf
      const deps = yield* journalOf
      if (!worktree || !deps) return undefined as { rows: SnapshotJournal.Row[]; deps: NonNullable<typeof deps>; worktree: string } | undefined
      const rows = yield* deps.journal.list({ sessionID }).pipe(Effect.orElseSucceed(() => undefined))
      if (!rows) return undefined
      return { rows, deps, worktree } as const
    })
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

          // kilocode_change start - complete coverage uses journal CAS; any
          // incomplete side forces the whole operation onto the old Snapshot
          // path, never mixed. Planner reads outside exclusive; executor runs
          // inside the held exclusive and never calls public Snapshot methods.
          // CAS failure never triggers raw.restore rollback (protects drift);
          // old path keeps its rollback behavior. Success still saves the raw
          // track backup as the future incomplete fallback, not as redo transport.
          // Hot path: single gated list shared by next/prev pure plans; prev
          // skipped when next is incomplete; list failure stays old Snapshot.
          const current = all as unknown as readonly SnapshotCoveragePlan.InputMessage[]
          const shared = yield* rowsOnce(input.sessionID as string)
          const next = shared
            ? SnapshotCoveragePlan.plan({ sessionID: input.sessionID, messageID: input.messageID, partID: input.partID, messages: current, rows: shared.rows })
            : undefined
          const prev =
            shared && session.revert && next?.verdict === "complete"
              ? SnapshotCoveragePlan.plan({ sessionID: input.sessionID, messageID: session.revert.messageID, partID: session.revert.partID, messages: current, rows: shared.rows })
              : undefined
          const hasMarker = !!session.revert
          const worktree = shared?.worktree
          const deps = shared?.deps
          const journalFirst = !hasMarker && next?.verdict === "complete" && !!worktree && !!deps
          const journalChain =
            hasMarker && next?.verdict === "complete" && prev?.verdict === "complete" && !!worktree && !!deps
          if (journalFirst || journalChain) {
            const prevOrder = journalChain ? prev!.applyOrder : []
            const nextOrder = next!.applyOrder
            if (prevOrder.length === 0 && nextOrder.length === 0) return yield* finish(undefined)
            const segments: SnapshotJournalCas.Segment[] = journalChain
              ? [
                  { applyOrder: prev!.applyOrder, direction: "redo" },
                  { applyOrder: next!.applyOrder, direction: "undo" },
                ]
              : [{ applyOrder: next!.applyOrder, direction: "undo" }]
            const sid = input.sessionID as string
            const root = worktree as string
            const cas = SnapshotJournalCas.run({ sessionID: sid, worktree: root, segments }).pipe(
              Effect.provideService(SnapshotJournal.Service, deps!.journal),
              Effect.provideService(FSUtil.Service, deps!.fsys),
            )
            const hash = yield* snap.exclusive((raw) =>
              Effect.gen(function* () {
                const backup = yield* raw.track()
                yield* cas
                return backup
              }),
            )
            return yield* finish(hash)
          }
          // kilocode_change end

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
            const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
            const shared = yield* rowsOnce(input.sessionID as string)
            const marker = shared
              ? SnapshotCoveragePlan.plan({
                  sessionID: input.sessionID,
                  messageID: session.revert.messageID,
                  partID: session.revert.partID,
                  messages: all as unknown as readonly SnapshotCoveragePlan.InputMessage[],
                  rows: shared.rows,
                })
              : undefined
            const worktree = shared?.worktree
            const deps = shared?.deps
            // Complete empty journal batch keeps clear semantics without FS work.
            if (marker?.verdict === "complete" && !!worktree && !!deps && marker.applyOrder.length > 0) {
              const sid = input.sessionID as string
              const root = worktree as string
              const cas = SnapshotJournalCas.run({
                sessionID: sid,
                worktree: root,
                segments: [{ applyOrder: marker.applyOrder, direction: "redo" }],
              }).pipe(
                Effect.provideService(SnapshotJournal.Service, deps.journal),
                Effect.provideService(FSUtil.Service, deps.fsys),
              )
              yield* snap.exclusive(() => cas)
            }
            yield* sessions.clearRevert(input.sessionID)
            return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          }
          // kilocode_change end
          // kilocode_change start - complete marker redoes via journal CAS;
          // incomplete with snapshot falls back to the old Snapshot restore.
          // CAS failure never triggers rollback restore; old path keeps rollback.
          const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const shared = session.revert.messageID ? yield* rowsOnce(input.sessionID as string) : undefined
          const marker = shared
            ? SnapshotCoveragePlan.plan({
                sessionID: input.sessionID,
                messageID: session.revert.messageID,
                partID: session.revert.partID,
                messages: all as unknown as readonly SnapshotCoveragePlan.InputMessage[],
                rows: shared.rows,
              })
            : undefined
          const worktree = shared?.worktree
          const deps = shared?.deps
          if (marker?.verdict === "complete" && !!worktree && !!deps) {
            if (marker.applyOrder.length === 0) {
              yield* sessions.clearRevert(input.sessionID)
              return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            }
            const sid = input.sessionID as string
            const root = worktree as string
            const cas = SnapshotJournalCas.run({
              sessionID: sid,
              worktree: root,
              segments: [{ applyOrder: marker.applyOrder, direction: "redo" }],
            }).pipe(
              Effect.provideService(SnapshotJournal.Service, deps.journal),
              Effect.provideService(FSUtil.Service, deps.fsys),
            )
            yield* snap.exclusive(() => cas)
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
