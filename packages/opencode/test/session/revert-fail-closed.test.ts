import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Session as SessionLayer } from "@/session/session"
import { SessionRevert as RevertLayer } from "../../src/session/revert"
import { Snapshot as SnapLayer } from "../../src/snapshot"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Layer } from "effect"

const env = Layer.mergeAll(
  SessionLayer.defaultLayer,
  RevertLayer.defaultLayer,
  SnapLayer.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

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

const BAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

describe("SessionRevert fail-closed markers", () => {
  it.live(
    "unrevert with invalid snapshot fails typed and keeps marker",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "hi")
          const a = yield* assistant(sid, u.id, dir)
          yield* text(sid, a.id, "done")
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u.id, snapshot: BAD },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          const err = yield* revert.unrevert({ sessionID: sid }).pipe(Effect.flip)
          expect(err._tag).toBe("SnapshotRestoreError")
          expect((yield* session.get(sid)).revert?.messageID).toBe(u.id)
        }),
      { git: true },
    ),
  )

  it.live(
    "revert with invalid prior snapshot fails and does not overwrite marker",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "done-1")
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id, snapshot: BAD },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second")
          const err = yield* revert.revert({ sessionID: sid, messageID: u2.id }).pipe(Effect.flip)
          expect(err._tag).toBe("SnapshotRestoreError")
          const cur = yield* session.get(sid)
          expect(cur.revert?.messageID).toBe(u1.id)
        }),
      { git: true },
    ),
  )

  it.live(
    "revert file failure keeps original error, restores partial work, sets no marker",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          yield* write(path.join(dir, "base.txt"), "base")
          const before = yield* snapshot.track()
          if (!before) throw new Error("expected snapshot")
          yield* write(path.join(dir, "good.txt"), "GOOD")
          const goodPatch = yield* snapshot.patch(before)
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "do work")
          const a = yield* assistant(sid, u.id, dir)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: sid,
            type: "patch",
            hash: goodPatch.hash,
            files: goodPatch.files,
          } as never)
          const badFile = path.join(dir, "base.txt").replaceAll("\\", "/")
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: sid,
            type: "patch",
            hash: BAD,
            files: [badFile],
          } as never)
          const err = yield* revert.revert({ sessionID: sid, messageID: u.id }).pipe(Effect.flip)
          expect(err._tag).toBe("SnapshotRevertError")
          expect(yield* read(path.join(dir, "good.txt"))).toBe("GOOD")
          expect((yield* session.get(sid)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "message-only revert without hash still sets marker",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "plain")
          const a = yield* assistant(sid, u.id, dir)
          yield* text(sid, a.id, "reply")
          const out = yield* revert.revert({ sessionID: sid, messageID: u.id })
          expect(out.revert?.messageID).toBe(u.id)
          expect(out.revert?.snapshot).toBeUndefined()
        }),
      { git: true, config: { snapshot: false } },
    ),
  )
})

describe("SessionRevert http mapping", () => {
  it.live(
    "maps snapshot failures to 500/400 and busy to 409",
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const errors = yield* Effect.promise(
            () => import("@/server/routes/instance/httpapi/handlers/session-errors"),
          )
          const snapMod = yield* Effect.promise(() => import("@/snapshot"))
          const sessionMod = yield* Effect.promise(() => import("@/session/session"))
          const httpMod = yield* Effect.promise(() => import("effect/unstable/httpapi"))
          const sid = "ses_000000000000000000000000" as never
          const restoreErr = new snapMod.Snapshot.RestoreError({
            snapshot: BAD,
            op: "read-tree",
            exit: 128,
            stderr: "x",
            cwd: "/tmp",
          })
          const mapped500 = yield* errors.mapRevert(Effect.fail(restoreErr)).pipe(Effect.flip)
          expect(mapped500).toBeInstanceOf(httpMod.HttpApiError.InternalServerError)
          const revertErr = new snapMod.Snapshot.RevertError({ message: "m", files: ["/tmp/a"] })
          const mapped500b = yield* errors.mapRevert(Effect.fail(revertErr)).pipe(Effect.flip)
          expect(mapped500b).toBeInstanceOf(httpMod.HttpApiError.InternalServerError)
          const pathErr = new snapMod.Snapshot.PathError({ message: "m", file: "/etc/passwd", worktree: "/tmp/w" })
          const mapped400 = yield* errors.mapRevert(Effect.fail(pathErr)).pipe(Effect.flip)
          expect(mapped400).toBeInstanceOf(httpMod.HttpApiError.BadRequest)
          const busy = new sessionMod.Session.BusyError({ sessionID: sid })
          const mapped409 = yield* errors.mapRevert(Effect.fail(busy)).pipe(Effect.flip)
          expect((mapped409 as { _tag: string })._tag).toBe("SessionBusyError")
          void SessionV1
        }),
      { git: true },
    ),
  )
})
