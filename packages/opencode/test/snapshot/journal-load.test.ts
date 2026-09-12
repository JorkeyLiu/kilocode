import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { SnapshotBlobTable, SnapshotMutationTable } from "@opencode-ai/core/snapshot/journal.sql"
import { SnapshotJournal } from "@/snapshot/journal"
import { SnapshotJournalCas } from "@/snapshot/journal-cas"
import { ensureJournalSession } from "../fixture/journal"
import { testEffect } from "../lib/effect"

const memory = Database.layerFromPath(":memory:")
const layer = Layer.mergeAll(memory, SnapshotJournal.layer.pipe(Layer.provide(memory), Layer.provide(FSUtil.defaultLayer)), FSUtil.defaultLayer)
const it = testEffect(layer)

const put = (p: string, content: string | Buffer) => Effect.promise(() => fs.writeFile(p, content))
const loadRaw = (p: string) => Effect.promise(() => fs.readFile(p))
const tagOf = (err: unknown) => (err as { _tag?: string })?._tag

let seq = 0
const ids = (tag: string) => {
  seq += 1
  return { session: `ses_load_${tag}_${seq}`, message: `msg_load_${tag}_${seq}`, call: `call_load_${tag}_${seq}` }
}

const prepareApply = (args: {
  session: string
  message: string
  call: string
  item?: number
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
      tool: "edit",
      item: args.item ?? 0,
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

describe("SnapshotJournal.load bounded batch read", () => {
  it.live("empty input is a fast path with empty maps", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const out = yield* journal.load([])
      expect(out.rows.size).toBe(0)
      expect(out.blobs.size).toBe(0)
    }),
  )

  it.live("duplicate ids and shared blobs query once but behave the same", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("dup")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "load-dup-")))
      try {
        const sharedBefore = Buffer.from("shared-before\n")
        const sharedAfter = Buffer.from("shared-after\n")
        const r1 = yield* prepareApply({ session: id.session, message: id.message, call: id.call, item: 0, dir, file: path.join(dir, "a.txt"), op: "update", before: sharedBefore, after: sharedAfter })
        const r2 = yield* prepareApply({ session: id.session, message: id.message, call: `${id.call}-b`, item: 1, dir, file: path.join(dir, "b.txt"), op: "update", before: sharedBefore, after: sharedAfter })
        const out = yield* journal.load([r1.id, r1.id, r2.id, r1.id])
        expect(out.rows.size).toBe(2)
        // Shared content collapses to at most 2 blobs (before+after shas).
        expect(out.blobs.size).toBeLessThanOrEqual(2)
        expect(out.rows.get(r1.id)!.id).toBe(r1.id)
        expect(out.rows.get(r2.id)!.id).toBe(r2.id)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("cas reports first missing id in flat order", () =>
    Effect.gen(function* () {
      const id = ids("missorder")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "load-missorder-")))
      try {
        const v1 = Buffer.from("v1\n")
        const v2 = Buffer.from("v2\n")
        const r1 = yield* prepareApply({ session: id.session, message: id.message, call: id.call, item: 0, dir, file: path.join(dir, "a.txt"), op: "update", before: v1, after: v2 })
        const r2 = yield* prepareApply({ session: id.session, message: id.message, call: `${id.call}-b`, item: 1, dir, file: path.join(dir, "b.txt"), op: "update", before: v1, after: v2 })
        yield* put(path.join(dir, "a.txt"), v2)
        yield* put(path.join(dir, "b.txt"), v2)
        const missingA = "journal-missing-a"
        const missingB = "journal-missing-b"
        // Redo keeps flat order == applyOrder, so the first missing wins.
        const exit = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [r1.id, missingA, r2.id, missingB], direction: "redo" }],
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause) as { _tag: string; id: string }
          expect(err._tag).toBe("SnapshotJournalNotFound")
          expect(err.id).toBe(missingA)
        }
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("cas fails missing blob and corrupt blob per step/side", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("badblob")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "load-badblob-")))
      try {
        const v1 = Buffer.from("v1\n")
        const v2 = Buffer.from("v2-longer\n")
        const file = path.join(dir, "s.txt")
        yield* put(file, v1)
        const row = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file, op: "update", before: v1, after: v2 })
        yield* put(file, v2)
        const fresh = (yield* journal.get(row.id))!
        const facts = yield* journal.load([row.id])
        // Missing blob: drop the after blob from the batch; undo needs it.
        const missingProxy = {
          ...journal,
          load: (_need: readonly string[]) =>
            Effect.succeed({
              rows: new Map(facts.rows),
              blobs: new Map([...facts.blobs].filter(([sha]) => sha !== fresh.after_blob)),
            }),
        } as unknown as SnapshotJournal.Interface
        const miss = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [row.id], direction: "undo" }],
        }).pipe(Effect.provideService(SnapshotJournal.Service, missingProxy), Effect.exit)
        expect(Exit.isFailure(miss)).toBe(true)
        if (Exit.isFailure(miss)) {
          const err = Cause.squash(miss.cause) as { _tag: string; message: string }
          expect(err._tag).toBe("SnapshotJournalConflict")
          expect(err.message).toContain("blob missing")
        }
        expect((yield* loadRaw(file)).equals(v2)).toBe(true)
        // Corrupt blob: swap the after bytes so the size/hash check fails.
        const corruptProxy = {
          ...journal,
          load: (_need: readonly string[]) => {
            const blobs = new Map(facts.blobs)
            if (fresh.after_blob) blobs.set(fresh.after_blob, Buffer.from("x"))
            return Effect.succeed({ rows: new Map(facts.rows), blobs })
          },
        } as unknown as SnapshotJournal.Interface
        const corrupt = yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: [row.id], direction: "undo" }],
        }).pipe(Effect.provideService(SnapshotJournal.Service, corruptProxy), Effect.exit)
        expect(Exit.isFailure(corrupt)).toBe(true)
        if (Exit.isFailure(corrupt)) expect(tagOf(Cause.squash(corrupt.cause))).toBe("SnapshotJournalConflict")
        expect((yield* loadRaw(file)).equals(v2)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("probe: 100-step cas uses one batch load, zero per-step reads", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("batch100")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "load-batch100-")))
      try {
        const before = Buffer.from("before\n")
        const after = Buffer.from("after\n")
        const wanted: string[] = []
        for (let i = 0; i < 100; i++) {
          const file = path.join(dir, `f${i}.txt`)
          yield* put(file, before)
          const row = yield* prepareApply({ session: id.session, message: `${id.message}-${i}`, call: `${id.call}-${i}`, item: i, dir, file, op: "update", before, after })
          yield* put(file, after)
          wanted.push(row.id)
        }
        let loads = 0
        let gets = 0
        let reads = 0
        const counting = {
          ...journal,
          get: (rowId: string) => {
            gets++
            return journal.get(rowId)
          },
          readBlob: (ref: string) => {
            reads++
            return journal.readBlob(ref)
          },
          load: (need: readonly string[]) => {
            loads++
            return journal.load(need)
          },
        } as unknown as SnapshotJournal.Interface
        // Undo runs reverse(applyOrder); disk holds after-images so undo to
        // before-images succeeds for the whole batch.
        yield* SnapshotJournalCas.run({
          sessionID: id.session,
          worktree: dir,
          segments: [{ applyOrder: wanted, direction: "undo" }],
        }).pipe(Effect.provideService(SnapshotJournal.Service, counting))
        expect(loads).toBe(1)
        expect(gets).toBe(0)
        expect(reads).toBe(0)
        expect((yield* loadRaw(path.join(dir, "f0.txt"))).equals(before)).toBe(true)
        expect((yield* loadRaw(path.join(dir, "f99.txt"))).equals(before)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("chunked load returns all rows and blobs across row/blob chunks", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const { db } = yield* Database.Service
      const id = ids("chunkreal")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "load-chunkreal-")))
      try {
        // COUNT > LOAD_CHUNK (800) on both sides: 1050 unique ids force at
        // least two row chunks (800 + 250), and 2100 unique blob shas force
        // at least three blob chunks. One journal.load must return all of
        // them. Direct Drizzle inserts keep this fast (no 1000+ tool runs).
        const COUNT = 1050
        const now = Date.now()
        const rowIds: string[] = []
        const befores: Buffer[] = []
        const afters: Buffer[] = []
        const beforeHash: string[] = []
        const afterHash: string[] = []
        const blobValues: { sha256: string; bytes: Buffer; size: number; time_created: number }[] = []
        for (let i = 0; i < COUNT; i++) {
          const before = Buffer.from(`chunkreal-before-${id.session}-${i}\n`)
          const after = Buffer.from(`chunkreal-after-${id.session}-${i}\n`)
          const bh = Hash.sha256(before)
          const ah = Hash.sha256(after)
          befores.push(before)
          afters.push(after)
          beforeHash.push(bh)
          afterHash.push(ah)
          rowIds.push(`journal-chunkreal-${id.session}-${i}`)
          blobValues.push({ sha256: bh, bytes: before, size: before.length, time_created: now })
          blobValues.push({ sha256: ah, bytes: after, size: after.length, time_created: now })
        }
        expect(new Set(rowIds).size).toBe(COUNT)
        expect(new Set(blobValues.map((v) => v.sha256)).size).toBe(2 * COUNT)
        for (let s = 0; s < blobValues.length; s += 100) {
          yield* db.insert(SnapshotBlobTable).values(blobValues.slice(s, s + 100)).onConflictDoNothing().run()
        }
        const rowValues = rowIds.map((rowId, i) => ({
          id: rowId,
          session_id: id.session,
          message_id: id.message,
          call_id: id.call,
          tool: "edit",
          item_index: i,
          sub_index: 0,
          directory: dir,
          worktree: dir,
          path: `chunkreal-${i}.txt`,
          target_path: null,
          op: "update" as const,
          status: "applied" as const,
          before_blob: beforeHash[i]!,
          after_blob: afterHash[i]!,
          before_hash: beforeHash[i]!,
          before_size: befores[i]!.length,
          after_hash: afterHash[i]!,
          after_size: afters[i]!.length,
          encoding: "utf-8",
          bom: 0,
          diagnostic: null,
          error: null,
          time_applied: now,
          time_created: now,
          time_updated: now,
        }))
        for (let s = 0; s < rowValues.length; s += 100) {
          yield* db.insert(SnapshotMutationTable).values(rowValues.slice(s, s + 100)).run()
        }
        const out = yield* journal.load(rowIds)
        expect(out.rows.size).toBe(COUNT)
        expect(out.blobs.size).toBe(2 * COUNT)
        const first = out.rows.get(rowIds[0]!)
        const last = out.rows.get(rowIds[COUNT - 1]!)
        expect(first?.before_hash).toBe(beforeHash[0])
        expect(first?.after_hash).toBe(afterHash[0])
        expect(last?.before_hash).toBe(beforeHash[COUNT - 1])
        expect(last?.after_hash).toBe(afterHash[COUNT - 1])
        expect(out.blobs.get(beforeHash[0]!)?.equals(befores[0]!)).toBe(true)
        expect(out.blobs.get(afterHash[0]!)?.equals(afters[0]!)).toBe(true)
        expect(out.blobs.get(beforeHash[COUNT - 1]!)?.equals(befores[COUNT - 1]!)).toBe(true)
        expect(out.blobs.get(afterHash[COUNT - 1]!)?.equals(afters[COUNT - 1]!)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("probe: 2000 ids load in chunks without sqlite variable failure", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("chunk2000")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "load-chunk2000-")))
      try {
        const before = Buffer.from("b\n")
        const after = Buffer.from("a\n")
        const file = path.join(dir, "one.txt")
        yield* put(file, before)
        const row = yield* prepareApply({ session: id.session, message: id.message, call: id.call, dir, file, op: "update", before, after })
        const synthetic: string[] = []
        for (let i = 0; i < 1999; i++) synthetic.push(`journal-synthetic-${id.session}-${i}`)
        // 2000 ids exceed a single SQLite variable window; chunked load must
        // succeed and return only the single real row.
        const out = yield* journal.load([row.id, ...synthetic])
        expect(out.rows.size).toBe(1)
        expect(out.rows.get(row.id)!.id).toBe(row.id)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )
})
