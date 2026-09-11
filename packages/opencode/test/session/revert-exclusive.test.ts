import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Cause } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { Storage } from "@/storage/storage"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const BAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

const realEnv = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const realIt = testEffect(realEnv)

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

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

const assistant = Effect.fn("test.assistant")(function* (sid: string, parent: string, dir: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
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
    parentID: parent as never,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

describe("SessionRevert worktree exclusive cross-session", () => {
  realIt.live(
    "same worktree A rollback failure does not overwrite B final success",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snap = yield* Snapshot.Service
          const file = path.join(dir, "shared.txt")
          yield* write(file, "base")
          const h0 = yield* snap.track()
          if (!h0) throw new Error("expected base snapshot")
          yield* write(file, "B-final")
          const hB = yield* snap.track()
          if (!hB) throw new Error("expected B snapshot")
          yield* write(file, "pre")

          const infoA = yield* session.create({})
          const sidA = infoA.id
          const uA = yield* user(sidA)
          yield* text(sidA, uA.id, "work-a")
          const aA = yield* assistant(sidA, uA.id, dir)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: aA.id,
            sessionID: sidA,
            type: "patch",
            hash: BAD,
            files: [file.replaceAll("\\", "/")],
          } as never)

          const infoB = yield* session.create({})
          const sidB = infoB.id
          const uB = yield* user(sidB)
          yield* text(sidB, uB.id, "work-b")
          yield* session.setRevert({
            sessionID: sidB,
            revert: { messageID: uB.id, snapshot: hB },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const [exitA, exitB] = yield* Effect.all(
            [
              revert.revert({ sessionID: sidA, messageID: uA.id }).pipe(Effect.exit),
              revert.unrevert({ sessionID: sidB }).pipe(Effect.exit),
            ],
            { concurrency: "unbounded" },
          )
          if (exitA._tag !== "Failure") throw new Error("expected A to fail")
          const pretty = Cause.pretty(exitA.cause)
          expect(pretty).toContain("SnapshotRevertError")
          if (exitB._tag === "Failure") throw new Error("expected B to succeed")
          expect(yield* read(file)).toBe("B-final")
          expect((yield* session.get(sidA)).revert).toBeUndefined()
          expect((yield* session.get(sidB)).revert).toBeUndefined()
          void h0
        }),
      { git: true },
    ),
  )
})

type Hooks = {
  readonly trackHash: string | undefined
  readonly restore: (hash: string) => Effect.Effect<void, Snapshot.RestoreError>
  readonly revert: (patches: Snapshot.Patch[]) => Effect.Effect<void, Snapshot.RevertError | Snapshot.PathError>
}

const mockSummary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mockSnap = (hooks: Hooks, calls: { exclusive: number }) =>
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
      exclusive: (fn) =>
        Effect.gen(function* () {
          calls.exclusive += 1
          return yield* fn({
            track: () => Effect.succeed(hooks.trackHash),
            restore: hooks.restore,
            revert: hooks.revert,
          })
        }),
    }),
  )

const mockEnv = (hooks: Hooks, calls: { exclusive: number }) =>
  Layer.mergeAll(
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    Storage.defaultLayer,
    EventV2Bridge.defaultLayer,
    mockSummary,
    mockSnap(hooks, calls),
    SessionRevert.layer.pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(mockSnap(hooks, calls)),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(mockSummary),
      Layer.provide(SessionRunState.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  )

describe("SessionRevert cleanup serialization", () => {
  const calls = { exclusive: 0 }
  const itFor = testEffect(
    mockEnv(
      {
        trackHash: undefined,
        restore: () => Effect.void,
        revert: () => Effect.void,
      },
      calls,
    ),
  )

  itFor.live(
    "same session revert and cleanup complete consistently via per-session mutex",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          calls.exclusive = 0
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "one")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "reply")
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "two")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a2.id,
            sessionID: sid,
            type: "patch",
            hash: "h",
            files: ["/tmp/w/a.txt"],
          } as never)
          const [outRevert, outCleanup] = yield* Effect.all(
            [
              revert.revert({ sessionID: sid, messageID: u2.id }).pipe(Effect.exit),
              Effect.gen(function* () {
                const cur = yield* session.get(sid)
                return yield* revert.cleanup(cur).pipe(Effect.exit)
              }),
            ],
            { concurrency: "unbounded" },
          )
          expect(outRevert._tag).toBe("Success")
          expect(outCleanup._tag).toBe("Success")
          expect(calls.exclusive).toBe(1)
          const cur = yield* session.get(sid)
          if (cur.revert) {
            expect(cur.revert.messageID).toBe(u2.id)
          } else {
            const msgs = yield* session.messages({ sessionID: sid })
            expect(msgs.every((m) => m.info.id < u2.id)).toBe(true)
          }
        }),
      { git: true },
    ),
  )

  const calls2 = { exclusive: 0 }
  const itFor2 = testEffect(
    mockEnv(
      {
        trackHash: undefined,
        restore: () => Effect.void,
        revert: () => Effect.void,
      },
      calls2,
    ),
  )

  itFor2.live(
    "different session cleanups never take worktree exclusive",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          calls2.exclusive = 0
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const first = yield* session.create({})
          const second = yield* session.create({})
          const u1 = yield* user(first.id)
          yield* text(first.id, u1.id, "one")
          const a1 = yield* assistant(first.id, u1.id, dir)
          yield* text(first.id, a1.id, "r1")
          const u2 = yield* user(second.id)
          yield* text(second.id, u2.id, "two")
          const a2 = yield* assistant(second.id, u2.id, dir)
          yield* text(second.id, a2.id, "r2")
          yield* session.setRevert({
            sessionID: first.id,
            revert: { messageID: u1.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* session.setRevert({
            sessionID: second.id,
            revert: { messageID: u2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          const f1 = yield* session.get(first.id)
          const f2 = yield* session.get(second.id)
          yield* Effect.all([revert.cleanup(f1), revert.cleanup(f2)], { concurrency: "unbounded" })
          expect(calls2.exclusive).toBe(0)
          expect((yield* session.get(first.id)).revert).toBeUndefined()
          expect((yield* session.get(second.id)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
