import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { Snapshot } from "@/snapshot"
import { SnapshotJournal } from "@/snapshot/journal"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  Snapshot.defaultLayer,
  SnapshotJournal.defaultLayer,
  FSUtil.defaultLayer,
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

const toolPart = Effect.fn("test.toolPart")(function* (
  sid: string,
  mid: string,
  call: string,
  tool: string,
  journalIds: string[],
) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID: mid as never,
    sessionID: sid as never,
    type: "tool",
    callID: call,
    tool,
    state: { status: "completed", input: {}, output: "ok", title: tool, metadata: {}, time: { start: Date.now(), end: Date.now() } },
    metadata: { journal: { coverage: "full", ids: journalIds } },
  } as never)
})

const tagOf = (err: unknown) => (err as { _tag?: string })?._tag

describe("SessionRevert journal CAS route", () => {
  it.live(
    "complete revert undo/redo roundtrip via journal",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "edit file")
          const a = yield* assistant(sid, u.id, dir)
          yield* text(sid, a.id, "done")
          const file = path.join(dir, "note.txt")
          const v1 = Buffer.from("v1\n")
          const v2 = Buffer.from("v2\n")
          yield* write(file, "v1\n")
          const call = `call_${Date.now()}_r1`
          const noted = yield* journal.prepare({
            sessionID: sid,
            messageID: a.id,
            callID: call,
            tool: "edit",
            item: 0,
            directory: dir,
            worktree: dir,
            path: file,
            op: "update",
            before: v1,
            encoding: "utf-8",
            bom: false,
          })
          yield* write(file, "v2\n")
          yield* journal.apply({ id: noted.row.id, after: v2, encoding: "utf-8", bom: false })
          yield* toolPart(sid, a.id, call, "edit", [noted.row.id])

          const out = yield* revert.revert({ sessionID: sid, messageID: u.id })
          expect(out.revert?.messageID).toBe(u.id)
          expect(out.revert?.snapshot).toBeDefined()
          expect(yield* read(file)).toBe("v1\n")
          expect((yield* journal.get(noted.row.id))!.status).toBe("applied")

          const back = yield* revert.unrevert({ sessionID: sid })
          expect(back.revert).toBeUndefined()
          expect(yield* read(file)).toBe("v2\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "chained complete reverts combine redo old plus undo new",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const info = yield* session.create({})
          const sid = info.id
          const f1 = path.join(dir, "f1.txt")
          const f2 = path.join(dir, "f2.txt")
          yield* write(f1, "f1v0\n")
          yield* write(f2, "f2w0\n")

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "a1")
          const c1 = `call_${Date.now()}_c1`
          const r1 = yield* journal.prepare({
            sessionID: sid, messageID: a1.id, callID: c1, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: f1, op: "update",
            before: Buffer.from("f1v0\n"), encoding: "utf-8", bom: false,
          })
          yield* write(f1, "f1v1\n")
          yield* journal.apply({ id: r1.row.id, after: Buffer.from("f1v1\n"), encoding: "utf-8", bom: false })
          yield* toolPart(sid, a1.id, c1, "edit", [r1.row.id])

          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* text(sid, a2.id, "a2")
          const c2 = `call_${Date.now()}_c2`
          const r2 = yield* journal.prepare({
            sessionID: sid, messageID: a2.id, callID: c2, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: f2, op: "update",
            before: Buffer.from("f2w0\n"), encoding: "utf-8", bom: false,
          })
          yield* write(f2, "f2w1\n")
          yield* journal.apply({ id: r2.row.id, after: Buffer.from("f2w1\n"), encoding: "utf-8", bom: false })
          yield* toolPart(sid, a2.id, c2, "edit", [r2.row.id])

          const first = yield* revert.revert({ sessionID: sid, messageID: u2.id })
          expect(first.revert?.messageID).toBe(u2.id)
          expect(yield* read(f2)).toBe("f2w0\n")
          expect(yield* read(f1)).toBe("f1v1\n")

          const chained = yield* revert.revert({ sessionID: sid, messageID: u1.id })
          expect(chained.revert?.messageID).toBe(u1.id)
          expect(yield* read(f1)).toBe("f1v0\n")
          expect(yield* read(f2)).toBe("f2w0\n")

          const back = yield* revert.unrevert({ sessionID: sid })
          expect(back.revert).toBeUndefined()
          expect(yield* read(f1)).toBe("f1v1\n")
          expect(yield* read(f2)).toBe("f2w1\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "drift fails CAS with marker unchanged and zero overwrite",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "edit")
          const a = yield* assistant(sid, u.id, dir)
          yield* text(sid, a.id, "done")
          const file = path.join(dir, "drift.txt")
          const v1 = Buffer.from("v1\n")
          const v2 = Buffer.from("v2\n")
          yield* write(file, "v1\n")
          const call = `call_${Date.now()}_drift`
          const noted = yield* journal.prepare({
            sessionID: sid, messageID: a.id, callID: call, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: file, op: "update",
            before: v1, encoding: "utf-8", bom: false,
          })
          yield* write(file, "v2\n")
          yield* journal.apply({ id: noted.row.id, after: v2, encoding: "utf-8", bom: false })
          yield* toolPart(sid, a.id, call, "edit", [noted.row.id])
          yield* write(file, "external\n")
          const exit = yield* revert.revert({ sessionID: sid, messageID: u.id }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause) as { _tag: string; recovered: boolean }
            expect(err._tag).toBe("SnapshotJournalApplyError")
            expect(err.recovered).toBe(true)
          }
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* read(file)).toBe("external\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "incomplete new interval falls back to whole old snapshot",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const snapshot = yield* Snapshot.Service
          const info = yield* session.create({})
          const sid = info.id
          const file = path.join(dir, "mix.txt")
          yield* write(file, "base\n")
          const base = yield* snapshot.track()
          if (!base) throw new Error("expected snapshot")
          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "a1")
          const c1 = `call_${Date.now()}_mix1`
          const v0 = Buffer.from("base\n")
          const v1 = Buffer.from("edited\n")
          const r1 = yield* journal.prepare({
            sessionID: sid, messageID: a1.id, callID: c1, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: file, op: "update",
            before: v0, encoding: "utf-8", bom: false,
          })
          yield* write(file, "edited\n")
          yield* journal.apply({ id: r1.row.id, after: v1, encoding: "utf-8", bom: false })
          yield* toolPart(sid, a1.id, c1, "edit", [r1.row.id])
          const ok = yield* revert.revert({ sessionID: sid, messageID: u1.id })
          expect(ok.revert?.snapshot).toBeDefined()
          expect(yield* read(file)).toBe("base\n")

          // New writer with opaque tool forces the next plan incomplete; old
          // Snapshot patches drive the fallback as a whole.
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a2.id as never,
            sessionID: sid as never,
            type: "tool",
            callID: `call_${Date.now()}_opaque`,
            tool: "bash",
            state: { status: "completed", input: {}, output: "ok", title: "bash", metadata: {}, time: { start: Date.now(), end: Date.now() } },
          } as never)
          const patch = yield* snapshot.patch(ok.revert!.snapshot!)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a2.id as never,
            sessionID: sid as never,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          } as never)
          const second = yield* revert.revert({ sessionID: sid, messageID: u2.id })
          expect(second.revert?.messageID).toBe(u2.id)
          // Old snapshot fallback restored the pre-first backup (edited work).
          expect(yield* read(file)).toBe("edited\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "chained complete reuses single journal list",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const info = yield* session.create({})
          const sid = info.id
          const f1 = path.join(dir, "f1.txt")
          const f2 = path.join(dir, "f2.txt")
          yield* write(f1, "f1v0\n")
          yield* write(f2, "f2w0\n")

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "a1")
          const c1 = `call_${Date.now()}_once1`
          const r1 = yield* journal.prepare({
            sessionID: sid, messageID: a1.id, callID: c1, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: f1, op: "update",
            before: Buffer.from("f1v0\n"), encoding: "utf-8", bom: false,
          })
          yield* write(f1, "f1v1\n")
          yield* journal.apply({ id: r1.row.id, after: Buffer.from("f1v1\n"), encoding: "utf-8", bom: false })
          yield* toolPart(sid, a1.id, c1, "edit", [r1.row.id])

          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* text(sid, a2.id, "a2")
          const c2 = `call_${Date.now()}_once2`
          const r2 = yield* journal.prepare({
            sessionID: sid, messageID: a2.id, callID: c2, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: f2, op: "update",
            before: Buffer.from("f2w0\n"), encoding: "utf-8", bom: false,
          })
          yield* write(f2, "f2w1\n")
          yield* journal.apply({ id: r2.row.id, after: Buffer.from("f2w1\n"), encoding: "utf-8", bom: false })
          yield* toolPart(sid, a2.id, c2, "edit", [r2.row.id])

          const first = yield* revert.revert({ sessionID: sid, messageID: u2.id })
          expect(first.revert?.messageID).toBe(u2.id)

          let calls = 0
          const base = journal
          const counting = {
            ...base,
            list: (filter: Parameters<typeof base.list>[0]) =>
              Effect.gen(function* () {
                calls++
                return yield* base.list(filter)
              }),
          } as unknown as SnapshotJournal.Interface
          const chained = yield* revert.revert({ sessionID: sid, messageID: u1.id }).pipe(
            Effect.provideService(SnapshotJournal.Service, counting),
          )
          expect(chained.revert?.messageID).toBe(u1.id)
          expect(calls).toBe(1)
          expect(yield* read(f1)).toBe("f1v0\n")
          expect(yield* read(f2)).toBe("f2w0\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "http mapping keeps journal path 400 and rest 500 without new 409",
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const errors = yield* Effect.promise(() => import("@/server/routes/instance/httpapi/handlers/session-errors"))
          const journalMod = yield* Effect.promise(() => import("@/snapshot/journal"))
          const httpMod = yield* Effect.promise(() => import("effect/unstable/httpapi"))
          const pathErr = new journalMod.SnapshotJournal.PathError({ message: "m", file: "/x", worktree: "/w" })
          expect(yield* errors.mapRevert(Effect.fail(pathErr)).pipe(Effect.flip)).toBeInstanceOf(httpMod.HttpApiError.BadRequest)
          for (const err of [
            new journalMod.SnapshotJournal.Conflict({ message: "m", id: "r", status: "applied" }),
            new journalMod.SnapshotJournal.NotFound({ message: "m", id: "r" }),
            new journalMod.SnapshotJournal.DbError({ op: "cas", message: "m" }),
            new journalMod.SnapshotJournal.ApplyError({ message: "m", id: "r", recovered: true }),
          ]) {
            expect(yield* errors.mapRevert(Effect.fail(err)).pipe(Effect.flip)).toBeInstanceOf(
              httpMod.HttpApiError.InternalServerError,
            )
          }
          void tagOf
        }),
      { git: true },
    ),
  )

  it.live(
    "stale marker forces whole old snapshot fallback without skipping redo-old",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const snapshot = yield* Snapshot.Service
          const info = yield* session.create({})
          const sid = info.id
          const f1 = path.join(dir, "f1.txt")
          const f2 = path.join(dir, "f2.txt")
          yield* write(f1, "f1v0\n")
          yield* write(f2, "f2w0\n")
          const base = yield* snapshot.track()
          if (!base) throw new Error("expected snapshot")
          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "a1")
          const c1 = `call_${Date.now()}_stale1`
          const r1 = yield* journal.prepare({
            sessionID: sid, messageID: a1.id, callID: c1, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: f1, op: "update",
            before: Buffer.from("f1v0\n"), encoding: "utf-8", bom: false,
          })
          yield* write(f1, "f1v1\n")
          yield* journal.apply({ id: r1.row.id, after: Buffer.from("f1v1\n"), encoding: "utf-8", bom: false })
          yield* toolPart(sid, a1.id, c1, "edit", [r1.row.id])
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* text(sid, a2.id, "a2")
          const c2 = `call_${Date.now()}_stale2`
          const r2 = yield* journal.prepare({
            sessionID: sid, messageID: a2.id, callID: c2, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: f2, op: "update",
            before: Buffer.from("f2w0\n"), encoding: "utf-8", bom: false,
          })
          yield* write(f2, "f2w1\n")
          yield* journal.apply({ id: r2.row.id, after: Buffer.from("f2w1\n"), encoding: "utf-8", bom: false })
          yield* toolPart(sid, a2.id, c2, "edit", [r2.row.id])
          const patch = yield* snapshot.patch(base)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a2.id as never,
            sessionID: sid as never,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          } as never)
          const first = yield* revert.revert({ sessionID: sid, messageID: u2.id })
          expect(first.revert?.messageID).toBe(u2.id)
          expect(yield* read(f2)).toBe("f2w0\n")
          // Corrupt the marker to a stale messageID: prev plan becomes
          // incomplete (boundary not found) and the chained revert must take
          // the whole old Snapshot path, never journal-first redo skip.
          const cur = yield* session.get(sid)
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: "msg_stale_missing" as never, snapshot: cur.revert?.snapshot },
            summary: cur.summary,
          })
          const chained = yield* revert.revert({ sessionID: sid, messageID: u1.id })
          expect(chained.revert?.messageID).toBe(u1.id)
          expect(yield* read(f1)).toBe("f1v0\n")
          expect(yield* read(f2)).toBe("f2w0\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "journal list failure falls back to old snapshot",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const snapshot = yield* Snapshot.Service
          const info = yield* session.create({})
          const sid = info.id
          const file = path.join(dir, "listfail.txt")
          yield* write(file, "v0\n")
          const base = yield* snapshot.track()
          if (!base) throw new Error("expected snapshot")
          const u = yield* user(sid)
          yield* text(sid, u.id, "edit")
          const a = yield* assistant(sid, u.id, dir)
          yield* text(sid, a.id, "done")
          const call = `call_${Date.now()}_listfail`
          const noted = yield* journal.prepare({
            sessionID: sid, messageID: a.id, callID: call, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: file, op: "update",
            before: Buffer.from("v0\n"), encoding: "utf-8", bom: false,
          })
          yield* write(file, "v1\n")
          yield* journal.apply({ id: noted.row.id, after: Buffer.from("v1\n"), encoding: "utf-8", bom: false })
          yield* toolPart(sid, a.id, call, "edit", [noted.row.id])
          const patch = yield* snapshot.patch(base)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id as never,
            sessionID: sid as never,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          } as never)
          const failing = {
            ...journal,
            list: () => Effect.fail(new SnapshotJournal.DbError({ op: "list", message: "injected" })),
          } as unknown as SnapshotJournal.Interface
          const out = yield* revert.revert({ sessionID: sid, messageID: u.id }).pipe(
            Effect.provideService(SnapshotJournal.Service, failing),
          )
          expect(out.revert?.messageID).toBe(u.id)
          expect(yield* read(file)).toBe("v0\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "empty complete revert creates no snapshot and unrevert clears",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          const u = yield* user(sid)
          yield* text(sid, u.id, "hello")
          const a = yield* assistant(sid, u.id, dir)
          yield* text(sid, a.id, "hi")
          const out = yield* revert.revert({ sessionID: sid, messageID: u.id })
          expect(out.revert?.messageID).toBe(u.id)
          expect(out.revert?.snapshot).toBeUndefined()
          const back = yield* revert.unrevert({ sessionID: sid })
          expect(back.revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "chained complete same-path overlap projects globally then unreverts",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const journal = yield* SnapshotJournal.Service
          const info = yield* session.create({})
          const sid = info.id
          const file = path.join(dir, "overlap.txt")
          const v0 = Buffer.from("v0\n")
          const v1 = Buffer.from("v1\n")
          const v2 = Buffer.from("v2\n")
          yield* write(file, "v0\n")
          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "a1")
          const c1 = `call_${Date.now()}_ov1`
          const r1 = yield* journal.prepare({
            sessionID: sid, messageID: a1.id, callID: c1, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: file, op: "update",
            before: v0, encoding: "utf-8", bom: false,
          })
          yield* write(file, "v1\n")
          yield* journal.apply({ id: r1.row.id, after: v1, encoding: "utf-8", bom: false })
          yield* toolPart(sid, a1.id, c1, "edit", [r1.row.id])
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* text(sid, a2.id, "a2")
          const c2 = `call_${Date.now()}_ov2`
          const r2 = yield* journal.prepare({
            sessionID: sid, messageID: a2.id, callID: c2, tool: "edit", item: 0,
            directory: dir, worktree: dir, path: file, op: "update",
            before: v1, encoding: "utf-8", bom: false,
          })
          void r1
          void r2
          yield* write(file, "v2\n")
          yield* journal.apply({ id: r2.row.id, after: v2, encoding: "utf-8", bom: false })
          yield* toolPart(sid, a2.id, c2, "edit", [r2.row.id])
          const first = yield* revert.revert({ sessionID: sid, messageID: u2.id })
          expect(first.revert?.messageID).toBe(u2.id)
          expect(yield* read(file)).toBe("v1\n")
          const chained = yield* revert.revert({ sessionID: sid, messageID: u1.id })
          expect(chained.revert?.messageID).toBe(u1.id)
          expect(yield* read(file)).toBe("v0\n")
          const back = yield* revert.unrevert({ sessionID: sid })
          expect(back.revert).toBeUndefined()
          expect(yield* read(file)).toBe("v2\n")
        }),
      { git: true },
    ),
  )
})
