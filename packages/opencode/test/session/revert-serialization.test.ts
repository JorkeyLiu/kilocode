import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Storage } from "@/storage/storage"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const BAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
const ROLLBACK = "rollback-hash"

type Hooks = {
  readonly trackHash: string | undefined
  readonly restore: (hash: string) => Effect.Effect<void, Snapshot.RestoreError>
  readonly revert: (patches: Snapshot.Patch[]) => Effect.Effect<void, Snapshot.RevertError | Snapshot.PathError>
}

const mockSnap = (hooks: Hooks) =>
  Layer.succeed(
    Snapshot.Service,
    Snapshot.Service.of({
      init: () => Effect.void,
      cleanup: () => Effect.void,
      track: () => Effect.succeed(hooks.trackHash),
      patch: (hash: string) => Effect.succeed({ hash, files: [] }),
      restore: hooks.restore,
      revert: hooks.revert,
      diff: () => Effect.succeed(""),
      diffFull: () => Effect.succeed([]),
      // kilocode_change - passthrough exclusive: SessionRevert file window runs through
      // the real exclusive control flow with narrow raw caps; worktree serialization
      // itself is covered by real-Snapshot tests, per-session mutex is covered here.
      exclusive: (fn) =>
        fn({
          track: () => Effect.succeed(hooks.trackHash),
          restore: hooks.restore,
          revert: hooks.revert,
        }),
    }),
  )

const mockSummary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const env = (hooks: Hooks) =>
  Layer.mergeAll(
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    Storage.defaultLayer,
    EventV2Bridge.defaultLayer,
    mockSummary,
    mockSnap(hooks),
    SessionRevert.layer.pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(mockSnap(hooks)),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(mockSummary),
      Layer.provide(SessionRunState.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  )

const itFor = (hooks: Hooks) => testEffect(env(hooks))

const user = Effect.fn("test.user")(function* (sid: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: sid as never,
    agent: "default",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const text = Effect.fn("test.text")(function* (sid: string, mid: string, content: string) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID: mid as never,
    sessionID: sid as never,
    type: "text",
    text: content,
  })
})

const restoreErr = (snapshot: string) =>
  new Snapshot.RestoreError({ snapshot, op: "read-tree", exit: 128, stderr: "fail", cwd: "/tmp" })

describe("SessionRevert serialization and rollback errors", () => {
  const sameProbe = { cur: 0, max: 0 }
  itFor({
    trackHash: ROLLBACK,
    restore: () =>
      Effect.gen(function* () {
        sameProbe.cur += 1
        sameProbe.max = Math.max(sameProbe.max, sameProbe.cur)
        yield* Effect.sleep("50 millis")
        sameProbe.cur -= 1
      }),
    revert: () => Effect.void,
  }).live(
    "same-session concurrent reverts serialize file work",
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          sameProbe.cur = 0
          sameProbe.max = 0
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "one")
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id, snapshot: "orig-hash" },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "two")
          const out = yield* Effect.all(
            [revert.revert({ sessionID: sid, messageID: u2.id }), revert.revert({ sessionID: sid, messageID: u2.id })],
            { concurrency: "unbounded" },
          )
          expect(out.length).toBe(2)
          expect(sameProbe.max).toBe(1)
          expect((yield* session.get(sid)).revert?.messageID).toBe(u2.id)
        }),
      { git: true },
    ),
  )

  const crossProbe = { cur: 0, max: 0 }
  itFor({
    trackHash: ROLLBACK,
    restore: () =>
      Effect.gen(function* () {
        crossProbe.cur += 1
        crossProbe.max = Math.max(crossProbe.max, crossProbe.cur)
        yield* Effect.sleep("50 millis")
        crossProbe.cur -= 1
      }),
    revert: () => Effect.void,
  }).live(
    "different sessions restore in parallel",
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          crossProbe.cur = 0
          crossProbe.max = 0
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const first = yield* session.create({})
          const second = yield* session.create({})
          const u1 = yield* user(first.id)
          yield* text(first.id, u1.id, "one")
          const u2 = yield* user(second.id)
          yield* text(second.id, u2.id, "two")
          yield* session.setRevert({
            sessionID: first.id,
            revert: { messageID: u1.id, snapshot: "hash-a" },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* session.setRevert({
            sessionID: second.id,
            revert: { messageID: u2.id, snapshot: "hash-b" },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* Effect.all(
            [revert.unrevert({ sessionID: first.id }), revert.unrevert({ sessionID: second.id })],
            { concurrency: "unbounded" },
          )
          expect(crossProbe.max).toBe(2)
          expect((yield* session.get(first.id)).revert).toBeUndefined()
          expect((yield* session.get(second.id)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  itFor({
    trackHash: ROLLBACK,
    restore: (hash) => Effect.fail(restoreErr(hash)),
    revert: () => Effect.void,
  }).live(
    "rollback failure never masks the original restore error",
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "hi")
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u.id, snapshot: BAD },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          const err = yield* revert.unrevert({ sessionID: sid }).pipe(Effect.flip)
          expect(err._tag).toBe("SnapshotRestoreError")
          if (err._tag === "SnapshotRestoreError") expect(err.snapshot).toBe(BAD)
          expect((yield* session.get(sid)).revert?.messageID).toBe(u.id)
        }),
      { git: true },
    ),
  )

  itFor({
    trackHash: ROLLBACK,
    restore: () => Effect.fail(restoreErr(ROLLBACK)),
    revert: () => Effect.fail(new Snapshot.RevertError({ message: "main revert failed", files: ["/tmp/w/a.txt"], hash: "h" })),
  }).live(
    "file-revert failure keeps main error when rollback also fails",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          void dir
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "work")
          const assistantMod = yield* Effect.promise(() => import("@/session/message-v2"))
          void assistantMod
          const a = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: sid as never,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
            parentID: u.id as never,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: sid as never,
            type: "patch",
            hash: "h",
            files: ["/tmp/w/a.txt"],
          } as never)
          const err = yield* revert.revert({ sessionID: sid, messageID: u.id }).pipe(Effect.flip)
          expect(err._tag).toBe("SnapshotRevertError")
          if (err._tag === "SnapshotRevertError") expect(err.message).toBe("main revert failed")
          expect((yield* session.get(sid)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  itFor({
    trackHash: undefined,
    restore: () => Effect.die(new Error("restore must not run without hash")),
    revert: () => Effect.die(new Error("revert must not run without patches")),
  }).live(
    "message-only revert without hash never touches the filesystem",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          void dir
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "plain")
          const out = yield* revert.revert({ sessionID: sid, messageID: u.id })
          expect(out.revert?.messageID).toBe(u.id)
          expect(out.revert?.snapshot).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
