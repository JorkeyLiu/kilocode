import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { SnapshotJournal } from "@/snapshot/journal"
import { SnapshotJournalCas } from "@/snapshot/journal-cas"
import { ensureJournalSession } from "../fixture/journal"
import { testEffect } from "../lib/effect"

const memory = Database.layerFromPath(":memory:")
const layer = Layer.mergeAll(memory, SnapshotJournal.layer.pipe(Layer.provide(memory), Layer.provide(FSUtil.defaultLayer)), FSUtil.defaultLayer)
const it = testEffect(layer)

const put = (p: string, content: string | Buffer) => Effect.promise(() => fs.writeFile(p, content))
const loadRaw = (p: string) => Effect.promise(() => fs.readFile(p))
const exists = (p: string) => Effect.promise(() => fs.access(p).then(() => true).catch(() => false))
const tagOf = (err: unknown) => (err as { _tag?: string })?._tag

let seq = 0
const ids = (tag: string) => {
  seq += 1
  return { session: `ses_cas_${tag}_${seq}`, message: `msg_cas_${tag}_${seq}`, call: `call_cas_${tag}_${seq}` }
}

const prepareApply = (args: {
  session: string
  message: string
  call: string
  tool?: string
  item?: number
  sub?: number
  dir: string
  file: string
  op: SnapshotJournal.Op
  before: Buffer | null
  after: Buffer | null
}) =>
  Effect.gen(function* () {
    const journal = yield* SnapshotJournal.Service
    const noted = yield* journal.prepare({
      sessionID: args.session,
      messageID: args.message,
      callID: args.call,
      tool: args.tool ?? "edit",
      item: args.item ?? 0,
      sub: args.sub,
      directory: args.dir,
      worktree: args.dir,
      path: args.file,
      op: args.op,
      before: args.before,
      encoding: "utf-8",
      bom: false,
    })
    yield* journal.apply({ id: noted.row.id, after: args.after, encoding: "utf-8", bom: false })
    return noted.row
  })

describe("SnapshotJournalCas bounded executor", () => {
  it.live("add then update on same path undo/redo roundtrip", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("same")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-same-")))
      try {
        const file = path.join(dir, "doc.txt")
        const v1 = Buffer.from("one\n")
        const v2 = Buffer.from("two\n")
        const add = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file, op: "add", before: null, after: v1 })
        yield* put(file, v1)
        const upd = yield* prepareApply({ session: `${id.session}`, message: `${id.message}-u`, call: `${id.call}-u`, dir, file, op: "update", before: v1, after: v2 })
        void add
        yield* put(file, v2)
        // Undo update only: v2 -> v1.
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [{ applyOrder: [upd.id], direction: "undo" }] })
        expect((yield* loadRaw(file)).equals(v1)).toBe(true)
        // Redo update: v1 -> v2.
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [{ applyOrder: [upd.id], direction: "redo" }] })
        expect((yield* loadRaw(file)).equals(v2)).toBe(true)
        // Rows stay applied.
        expect((yield* journal.get(upd.id))!.status).toBe("applied")
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("delete undo restores and redo deletes", () =>
    Effect.gen(function* () {
      const id = ids("del")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-del-")))
      try {
        const file = path.join(dir, "gone.txt")
        const body = Buffer.from("bye\n")
        yield* put(file, body)
        const row = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file, op: "delete", before: body, after: null })
        yield* Effect.promise(() => fs.rm(file))
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [{ applyOrder: [row.id], direction: "undo" }] })
        expect((yield* loadRaw(file)).equals(body)).toBe(true)
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [{ applyOrder: [row.id], direction: "redo" }] })
        expect(yield* exists(file)).toBe(false)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("move dual facts target/source undo/redo", () =>
    Effect.gen(function* () {
      const id = ids("move")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-move-")))
      try {
        const src = path.join(dir, "src.txt")
        const dst = path.join(dir, "dest.txt")
        const before = Buffer.from("moving\n")
        const after = Buffer.from("moved\n")
        yield* put(src, before)
        const tgt = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file: dst, op: "add", before: null, after, item: 0, sub: 0 })
        const del = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file: src, op: "delete", before, after: null, item: 0, sub: 1 })
        yield* put(dst, after)
        yield* Effect.promise(() => fs.rm(src))
        // Undo in reverse applyOrder: source delete first, then target add.
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [{ applyOrder: [tgt.id, del.id], direction: "undo" }] })
        expect((yield* loadRaw(src)).equals(before)).toBe(true)
        expect(yield* exists(dst)).toBe(false)
        // Redo in applyOrder restores the move.
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [{ applyOrder: [tgt.id, del.id], direction: "redo" }] })
        expect((yield* loadRaw(dst)).equals(after)).toBe(true)
        expect(yield* exists(src)).toBe(false)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("external drift fails precheck with zero writes", () =>
    Effect.gen(function* () {
      const id = ids("drift")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-drift-")))
      try {
        const first = path.join(dir, "a.txt")
        const second = path.join(dir, "b.txt")
        const a1 = Buffer.from("a1\n")
        const a2 = Buffer.from("a2\n")
        const b1 = Buffer.from("b1\n")
        const b2 = Buffer.from("b2\n")
        yield* put(first, a1)
        yield* put(second, b1)
        const ra = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file: first, op: "update", before: a1, after: a2 })
        const rb = yield* prepareApply({ session: id.session, message: `${id.message}-b`, call: `${id.call}-b`, dir, file: second, op: "update", before: b1, after: b2 })
        yield* put(first, a2)
        yield* put(second, b2)
        // External drift on the first path only.
        const drift = Buffer.from("drifted\n")
        yield* put(first, drift)
        const beforeB = yield* loadRaw(second)
        const exit = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [ra.id, rb.id], direction: "undo" }],
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause) as { _tag: string; recovered: boolean }
          expect(err._tag).toBe("SnapshotJournalApplyError")
          expect(err.recovered).toBe(true)
        }
        // Zero writes: drift preserved, untouched path intact.
        expect((yield* loadRaw(first)).equals(drift)).toBe(true)
        expect((yield* loadRaw(second)).equals(beforeB)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("mid-batch write failure compensates prefix and reports recovered", () =>
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      const id = ids("comp")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-comp-")))
      try {
        const good = path.join(dir, "good.txt")
        const bad = path.join(dir, "bad.txt")
        const g1 = Buffer.from("g1\n")
        const g2 = Buffer.from("g2\n")
        const s1 = Buffer.from("s1\n")
        const s2 = Buffer.from("s2\n")
        yield* put(good, g1)
        yield* put(bad, s1)
        const rGood = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file: good, op: "update", before: g1, after: g2 })
        const rBad = yield* prepareApply({ session: id.session, message: `${id.message}-bad`, call: `${id.call}-bad`, dir, file: bad, op: "update", before: s1, after: s2 })
        yield* put(good, g2)
        yield* put(bad, s2)
        const custom = {
          ...real,
          writeFile: ((p: string, data: Uint8Array, ...rest: never[]) => {
            if (p.endsWith("bad.txt")) return Effect.fail({ _tag: "SystemError", message: "injected write failure" }) as never
            return (real.writeFile as never as (p: string, data: Uint8Array) => Effect.Effect<void>)(p, data)
          }) as never,
        } as FSUtil.Interface
        const exit = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          // Undo runs reverse(applyOrder): [bad, good] executes good then bad.
          // Good (g2->g1) succeeds, bad (s2->s1) fails injected, then the
          // prefix is compensated (g1->g2).
          segments: [{ applyOrder: [rBad.id, rGood.id], direction: "undo" }],
        }).pipe(Effect.provideService(FSUtil.Service, custom), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause) as { _tag: string; recovered: boolean }
          expect(err._tag).toBe("SnapshotJournalApplyError")
          expect(err.recovered).toBe(true)
        }
        expect((yield* loadRaw(good)).equals(g2)).toBe(true)
        expect((yield* loadRaw(bad)).equals(s2)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("legacy single-row move never executes", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("legacy")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-legacy-")))
      try {
        const file = path.join(dir, "f.txt")
        yield* put(file, "x\n")
        const noted = yield* journal.prepare({
          sessionID: id.session,
          messageID: id.message,
          callID: id.call,
          tool: "apply_patch",
          item: 0,
          directory: dir,
          worktree: dir,
          path: file,
          target: path.join(dir, "g.txt"),
          op: "move",
          before: Buffer.from("x\n"),
          encoding: "utf-8",
          bom: false,
        })
        yield* journal.apply({ id: noted.row.id, after: Buffer.from("y\n"), encoding: "utf-8", bom: false })
        const exit = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [noted.row.id], direction: "undo" }],
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(tagOf(Cause.squash(exit.cause))).toBe("SnapshotJournalConflict")
        expect((yield* loadRaw(file)).toString("utf-8")).toBe("x\n")
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("scope and blob integrity refuse", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("scope")
      yield* ensureJournalSession(id.session)
      yield* ensureJournalSession("ses_cas_other")
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-scope-")))
      try {
        const file = path.join(dir, "s.txt")
        const v1 = Buffer.from("v1\n")
        const v2 = Buffer.from("v2\n")
        yield* put(file, v1)
        const row = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file, op: "update", before: v1, after: v2 })
        yield* put(file, v2)
        const wrongSession = yield* SnapshotJournalCas.run({ sessionID: "ses_cas_other", worktree: dir, segments: [{ applyOrder: [row.id], direction: "undo" }] }).pipe(Effect.exit)
        expect(Exit.isFailure(wrongSession)).toBe(true)
        if (Exit.isFailure(wrongSession)) expect(tagOf(Cause.squash(wrongSession.cause))).toBe("SnapshotJournalConflict")
        const wrongWorktree = yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: os.tmpdir(), segments: [{ applyOrder: [row.id], direction: "undo" }] }).pipe(Effect.exit)
        expect(Exit.isFailure(wrongWorktree)).toBe(true)
        expect((yield* loadRaw(file)).toString("utf-8")).toBe("v2\n")
        const fresh = yield* journal.get(row.id)
        expect(fresh!.after_hash).toBe(Hash.sha256(v2))
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("compensation refuses to overwrite unknown data", () =>
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      const id = ids("refuse")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-refuse-")))
      try {
        const first = path.join(dir, "first.txt")
        const second = path.join(dir, "second.txt")
        const f1 = Buffer.from("f1\n")
        const f2 = Buffer.from("f2\n")
        const s1 = Buffer.from("s1\n")
        const s2 = Buffer.from("s2\n")
        const drift = Buffer.from("external\n")
        yield* put(first, f1)
        yield* put(second, s1)
        const r1 = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file: first, op: "update", before: f1, after: f2 })
        const r2 = yield* prepareApply({ session: id.session, message: `${id.message}-2`, call: `${id.call}-2`, dir, file: second, op: "update", before: s1, after: s2 })
        yield* put(first, f2)
        yield* put(second, s2)
        // Controlled FS: real reads/writes except second write fails and the
        // compensation read of the first path reports external drift.
        const reads = new Map<string, number>()
        const custom = {
          ...real,
          readFile: (p: string, ...rest: never[]) => {
            const count = (reads.get(p) ?? 0) + 1
            reads.set(p, count)
            if (p.endsWith("first.txt") && count >= 3) return Effect.succeed(drift) as never
            return (real.readFile as never as (p: string) => Effect.Effect<Uint8Array>)(p)
          },
          writeFile: ((p: string, data: Uint8Array, ...rest: never[]) => {
            if (p.endsWith("second.txt")) return Effect.fail({ _tag: "SystemError", message: "injected write failure" }) as never
            return (real.writeFile as never as (p: string, data: Uint8Array) => Effect.Effect<void>)(p, data)
          }) as never,
        } as FSUtil.Interface
        // Undo order is reverse(applyOrder): r2 (second) first, then r1.
        // r2 write is injected to fail after r1... reorder apply as [r2, r1]
        // so undo runs r1 (first) to completion, then fails on r2, then the
        // compensation read of first reports drift and refuses.
        const exit = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [r2.id, r1.id], direction: "undo" }],
        }).pipe(Effect.provideService(FSUtil.Service, custom), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause) as { _tag: string; recovered: boolean }
          expect(err._tag).toBe("SnapshotJournalApplyError")
          expect(err.recovered).toBe(false)
        }
        // Unknown data preserved: first still holds its completed undo (f1)
        // on real disk because the refused compensation never overwrote it;
        // use real reads to verify (custom would report drift).
        const actualFirst = yield* real.readFile(first).pipe(Effect.map((d) => Buffer.from(d as Uint8Array)))
        expect(actualFirst.equals(f1)).toBe(true)
        expect((yield* loadRaw(second)).equals(s2)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("empty batch is a no-op", () =>
    Effect.gen(function* () {
      const id = ids("empty")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-empty-")))
      try {
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [] })
        yield* SnapshotJournalCas.run({ sessionID: id.session, worktree: dir, segments: [{ applyOrder: [], direction: "undo" }] })
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("blob/hash/size/null strict checks fail with zero writes", () =>
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      const journal = yield* SnapshotJournal.Service
      const cases = ["ref-mismatch", "blob-missing", "size-mismatch", "hash-mismatch", "incomplete-fact"] as const
      for (const name of cases) {
        const id = ids(`strict-${name}`)
        yield* ensureJournalSession(id.session)
        const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), `cas-strict-${name}-`)))
        try {
          const file = path.join(dir, "strict.txt")
          const v1 = Buffer.from("v1\n")
          const v2 = Buffer.from("v2-longer\n")
          yield* put(file, v1)
          const row = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file, op: "update", before: v1, after: v2 })
          yield* put(file, v2)
          const base = (yield* journal.get(row.id))!
          const facts = yield* journal.load([row.id])
          let gets = 0
          let reads = 0
          const journalProxy = {
            ...journal,
            get: (rowId: string) => {
              gets++
              return journal.get(rowId)
            },
            readBlob: (ref: string) => {
              reads++
              return journal.readBlob(ref)
            },
            load: (wanted: readonly string[]) =>
              Effect.gen(function* () {
                const rows = new Map(facts.rows)
                const blobs = new Map(facts.blobs)
                if (name === "ref-mismatch") rows.set(row.id, { ...base, after_blob: "ff".repeat(32) })
                if (name === "incomplete-fact") rows.set(row.id, { ...base, after_blob: null })
                if (name === "blob-missing" && base.after_blob) blobs.delete(base.after_blob)
                if (name === "size-mismatch" && base.after_blob) blobs.set(base.after_blob, Buffer.from("x"))
                if (name === "hash-mismatch" && base.after_blob) blobs.set(base.after_blob, Buffer.from("different-bytes\n"))
                void wanted
                return { rows, blobs }
              }),
          } as unknown as SnapshotJournal.Interface
          const exit = yield* SnapshotJournalCas.run({
            sessionID: id.session,
            worktree: dir,
            segments: [{ applyOrder: [row.id], direction: "undo" }],
          }).pipe(
            Effect.provideService(SnapshotJournal.Service, journalProxy),
            Effect.provideService(FSUtil.Service, real),
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(tagOf(Cause.squash(exit.cause))).toBe("SnapshotJournalConflict")
          expect(gets).toBe(0)
          expect(reads).toBe(0)
          expect((yield* loadRaw(file)).equals(v2)).toBe(true)
          expect((yield* journal.get(row.id))!.status).toBe("applied")
        } finally {
          yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
        }
      }
    }),
  )

  it.live("interrupt during batch compensates prefix before release", () =>
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      const id = ids("int")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-int-")))
      try {
        const first = path.join(dir, "first.txt")
        const second = path.join(dir, "second.txt")
        const f1 = Buffer.from("f1\n")
        const f2 = Buffer.from("f2\n")
        const s1 = Buffer.from("s1\n")
        const s2 = Buffer.from("s2\n")
        yield* put(first, f1)
        yield* put(second, s1)
        const r1 = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file: first, op: "update", before: f1, after: f2 })
        const r2 = yield* prepareApply({ session: id.session, message: `${id.message}-2`, call: `${id.call}-2`, dir, file: second, op: "update", before: s1, after: s2 })
        yield* put(first, f2)
        yield* put(second, s2)
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const custom = {
          ...real,
          writeFile: ((p: string, data: Uint8Array, ...rest: never[]) => {
            if (p.endsWith("second.txt")) {
              return Effect.gen(function* () {
                yield* Deferred.succeed(entered, void 0).pipe(Effect.ignore)
                yield* Deferred.await(gate)
                return yield* (real.writeFile as never as (p: string, data: Uint8Array) => Effect.Effect<void>)(p, data)
              }) as never
            }
            return (real.writeFile as never as (p: string, data: Uint8Array) => Effect.Effect<void>)(p, data)
          }) as never,
        } as FSUtil.Interface
        const fiber = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [r2.id, r1.id], direction: "undo" }],
        }).pipe(Effect.provideService(FSUtil.Service, custom), Effect.forkDetach)
        yield* Deferred.await(entered)
        // First undo (f2->f1) completed before the blocked second write; poll real disk.
        let guard = 0
        while (guard++ < 200) {
          const cur = yield* loadRaw(first)
          if (cur.equals(f1)) break
          yield* Effect.sleep("10 millis")
        }
        expect((yield* loadRaw(first)).equals(f1)).toBe(true)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        // Compensation ran uninterruptibly before release: prefix restored,
        // blocked path untouched. Await waits for finalizers, so this asserts
        // disk recovery happened before the caller (exclusive) could release.
        expect((yield* loadRaw(first)).equals(f2)).toBe(true)
        expect((yield* loadRaw(second)).equals(s2)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("interrupt with unknown active step never overwrites it", () =>
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      const id = ids("int-unknown")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "cas-int-unknown-")))
      try {
        const first = path.join(dir, "first.txt")
        const second = path.join(dir, "second.txt")
        const f1 = Buffer.from("f1\n")
        const f2 = Buffer.from("f2\n")
        const s1 = Buffer.from("s1\n")
        const s2 = Buffer.from("s2\n")
        const unknown = Buffer.from("unknown-partial\n")
        yield* put(first, f1)
        yield* put(second, s1)
        const r1 = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file: first, op: "update", before: f1, after: f2 })
        const r2 = yield* prepareApply({ session: id.session, message: `${id.message}-2`, call: `${id.call}-2`, dir, file: second, op: "update", before: s1, after: s2 })
        yield* put(first, f2)
        yield* put(second, s2)
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const custom = {
          ...real,
          writeFile: ((p: string, data: Uint8Array, ...rest: never[]) => {
            if (p.endsWith("second.txt")) {
              return Effect.gen(function* () {
                yield* Deferred.succeed(entered, void 0).pipe(Effect.ignore)
                yield* Deferred.await(gate)
                return yield* (real.writeFile as never as (p: string, data: Uint8Array) => Effect.Effect<void>)(p, data)
              }) as never
            }
            return (real.writeFile as never as (p: string, data: Uint8Array) => Effect.Effect<void>)(p, data)
          }) as never,
        } as FSUtil.Interface
        const fiber = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [r2.id, r1.id], direction: "undo" }],
        }).pipe(Effect.provideService(FSUtil.Service, custom), Effect.forkDetach)
        yield* Deferred.await(entered)
        let guard2 = 0
        while (guard2++ < 200) {
          const cur = yield* loadRaw(first)
          if (cur.equals(f1)) break
          yield* Effect.sleep("10 millis")
        }
        // External unknown lands on the active path while its write is blocked.
        yield* put(second, unknown)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect((yield* loadRaw(second)).equals(unknown)).toBe(true)
        expect((yield* loadRaw(first)).equals(f2)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )
})
