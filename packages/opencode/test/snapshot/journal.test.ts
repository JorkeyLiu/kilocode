import { afterAll, describe, expect } from "bun:test"
import crypto from "crypto"
import fs from "fs/promises"
import { mkdtempSync } from "fs"
import os from "os"
import path from "path"
import { Database as BunDatabase } from "bun:sqlite"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SnapshotBlobTable, SnapshotMutationTable } from "@opencode-ai/core/snapshot/journal.sql"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { EditTool } from "@/tool/edit"
import { ReadTool } from "@/tool/read"
import { ToolRegistry } from "@/tool/registry"
import { WriteTool } from "@/tool/write"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { SnapshotJournal } from "@/snapshot/journal"
import { SessionID, MessageID } from "@/session/schema"
import { stripPartMetadata } from "@/session/message-v2"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { ensureJournalSession, SnapshotPassthrough } from "../fixture/journal"
import { testEffect } from "../lib/effect"

// File-backed DB (tmpdir, unique per file) so restart/rollback tests can hold
// real SQLite locks and reopen the database across runtime instances.
const root = mkdtempSync(path.join(os.tmpdir(), "journal-test-"))
const dbFile = path.join(root, "journal.db")
const memory = Database.layerFromPath(dbFile)
const journalLayer = SnapshotJournal.layer.pipe(Layer.provide(memory), Layer.provide(FSUtil.defaultLayer))
const registryLive = ToolRegistry.defaultLayer.pipe(Layer.provide(journalLayer), Layer.provide(SnapshotPassthrough)) // kilocode_change - production Registry with same canonical journal

const MARK = "# journal-formatted"

const formatLayer = Layer.mock(Format.Service, {
  file: (p: string) =>
    Effect.promise(async () => {
      if (p.includes("failfmt")) throw new Error("mock formatter boom")
      if (p.includes("plain")) return false
      const text = await fs.readFile(p, "utf-8")
      if (text.includes(MARK)) return true
      await fs.writeFile(p, `${text.trimEnd()}\n${MARK}\n`, "utf-8")
      return true
    }),
})

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  FSUtil.defaultLayer,
  formatLayer,
  EventV2Bridge.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  memory,
  journalLayer,
  SnapshotPassthrough,
  registryLive,
)

const it = testEffect(layer)

afterAll(async () => {
  await disposeAllInstances()
  await fs.rm(root, { recursive: true, force: true })
})

let seq = 0
const ids = (tag: string) => {
  seq += 1
  return {
    session: `ses_journal_${tag}_${seq}`,
    message: `msg_journal_${tag}_${seq}`,
    call: `call_journal_${tag}_${seq}`,
  }
}

const put = (p: string, content: string | Buffer) => Effect.promise(() => fs.writeFile(p, content))
const load = (p: string) => Effect.promise(() => fs.readFile(p, "utf-8"))
const loadRaw = (p: string) => Effect.promise(() => fs.readFile(p))

const tagOf = (err: unknown) => (err as { _tag?: string })?._tag

describe("Snapshot v2 durable mutation journal", () => {
  it.live("roundtrips complete raw bytes through the Bun driver", () =>
    Effect.gen(function* () {
      const id = ids("blob")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      const { db } = yield* Database.Service
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-blob-")))
      try {
        // Full-range binary including NUL, BOM, and invalid UTF-8 sequences.
        const bytes = Buffer.concat([
          crypto.randomBytes(32 * 1024),
          Buffer.from([0x00, 0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x00, 0x80]),
        ])
        const file = path.join(dir, "bin.dat")
        yield* put(file, bytes)
        const noted = yield* journal.prepare({
          sessionID: id.session,
          messageID: id.message,
          callID: id.call,
          tool: "write",
          item: 0,
          directory: dir,
          worktree: dir,
          path: file,
          op: "add",
          before: null,
          encoding: "utf-8",
          bom: false,
        })
        expect(noted.outcome).toBe("prepared")
        expect(noted.row.before_blob).toBeNull()
        const done = yield* journal.apply({ id: noted.row.id, after: bytes, encoding: "utf-8", bom: false })
        expect(done.outcome).toBe("applied")
        expect(done.row.after_hash).toBe(Hash.sha256(bytes))
        expect(done.row.after_size).toBe(bytes.length)
        const back = yield* journal.readBlob(done.row.after_hash!)
        expect(back).toBeDefined()
        expect(Buffer.from(back!).equals(bytes)).toBe(true)
        const stored = (yield* db
          .select()
          .from(SnapshotBlobTable)
          .where(eq(SnapshotBlobTable.sha256, done.row.after_hash!))
          .get()) as unknown as { size: number; bytes: Buffer } | undefined
        expect(stored?.size).toBe(bytes.length)
        expect(Buffer.from(stored!.bytes).equals(bytes)).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("prepare survives restart and lists/reads before", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-restart-")))
      const file = path.join(dir, "keep.txt")
      const dbPath = path.join(dir, "restart.db")
      const dbLayer = Database.layerFromPath(dbPath)
      const make = () =>
        ManagedRuntime.make(
          Layer.mergeAll(
            FSUtil.defaultLayer,
            dbLayer,
            SnapshotJournal.layer.pipe(Layer.provide(dbLayer), Layer.provide(FSUtil.defaultLayer)),
          ),
        )
      const id = { session: "ses_journal_restart", message: "msg_journal_restart", call: "call_journal_restart" }
      const before = Buffer.from("before restart\n", "utf-8")
      yield* Effect.promise(() => fs.writeFile(file, before))
      const first = make()
      const rowId = yield* Effect.promise(() =>
        first.runPromise(
          Effect.gen(function* () {
            yield* ensureJournalSession(id.session)
            const journal = yield* SnapshotJournal.Service
            const noted = yield* journal.prepare({
              sessionID: id.session,
              messageID: id.message,
              callID: id.call,
              tool: "edit",
              item: 0,
              directory: dir,
              worktree: dir,
              path: file,
              op: "update",
              before,
              encoding: "utf-8",
              bom: false,
            })
            return noted.row.id
          }),
        ),
      ).pipe(Effect.ensuring(Effect.promise(() => first.dispose())))
      const second = make()
      yield* Effect.promise(() =>
        second.runPromise(
          Effect.gen(function* () {
            const journal = yield* SnapshotJournal.Service
            const rows = yield* journal.list({ sessionID: id.session })
            expect(rows).toHaveLength(1)
            expect(rows[0]!.id).toBe(rowId)
            expect(rows[0]!.status).toBe("prepared")
            const back = yield* journal.readBlob(rows[0]!.before_blob!)
            expect(back && Buffer.from(back).equals(before)).toBe(true)
          }),
        ),
      ).pipe(Effect.ensuring(Effect.promise(() => second.dispose())))
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

  it.live("prepare DB failure writes zero files", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-nodb-")))
      try {
        const file = path.join(dir, "untouched.txt")
        yield* put(file, "original\n")
        // No session row: the FK rejects the insert inside the transaction.
        const exit = yield* journal
          .prepare({
            sessionID: "ses_journal_missing",
            messageID: "msg_journal_missing",
            callID: "call_journal_missing",
            tool: "edit",
            item: 0,
            directory: dir,
            worktree: dir,
            path: file,
            op: "update",
            before: Buffer.from("original\n"),
            encoding: "utf-8",
            bom: false,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(tagOf(Cause.squash(exit.cause))).toBe("SnapshotJournalDbError")
        expect(yield* load(file)).toBe("original\n")
        expect(yield* journal.list({ sessionID: "ses_journal_missing" })).toHaveLength(0)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("edit applies formatter-final before/after exactly", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("edit")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      const file = path.join(test.directory, "doc.txt")
      yield* put(file, "hello\n")
      const metas: any[] = []
      const ctx = {
        sessionID: SessionID.make(id.session),
        messageID: MessageID.make(id.message),
        callID: id.call,
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: (input: any) => Effect.sync(() => metas.push(input)),
        ask: () => Effect.void,
      }
      const info = yield* EditTool
      const tool = yield* info.init()
      const result: any = yield* tool.execute({ filePath: file, oldString: "hello", newString: "world" }, ctx)
      expect(result.metadata.journal.coverage).toBe("full")
      expect(result.metadata.journal.ids).toHaveLength(1)
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.status).toBe("applied")
      expect(row.op).toBe("update")
      expect(row.path.endsWith("doc.txt")).toBe(true)
      expect(row.path).not.toContain("..")
      const disk = yield* loadRaw(file)
      expect(row.before_hash).toBe(Hash.sha256(Buffer.from("hello\n")))
      expect(row.after_hash).toBe(Hash.sha256(disk))
      expect(Buffer.from((yield* journal.readBlob(row.before_hash!))!).toString("utf-8")).toBe("hello\n")
      expect(Buffer.from((yield* journal.readBlob(row.after_hash!))!).equals(disk)).toBe(true)
      expect(metas[0].metadata.journal.coverage).toBe("partial")
    }),
  )

  it.instance("edit new file records null before and permission reject writes zero rows", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("editnew")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      const file = path.join(test.directory, "fresh.txt")
      const info = yield* EditTool
      const tool = yield* info.init()
      const base = {
        sessionID: SessionID.make(id.session),
        messageID: MessageID.make(id.message),
        callID: id.call,
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
      }
      const created: any = yield* tool.execute({ filePath: file, oldString: "", newString: "seed" }, { ...base, ask: () => Effect.void })
      expect(created.metadata.journal.coverage).toBe("full")
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.op).toBe("add")
      expect(rows[0]!.before_blob).toBeNull()

      const denied = path.join(test.directory, "deny.txt")
      yield* put(denied, "keep\n")
      const exit = yield* tool
        .execute({ filePath: denied, oldString: "keep", newString: "change" }, { ...base, ask: () => Effect.die(new Error("denied")) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* load(denied)).toBe("keep\n")
      expect(yield* journal.list({ sessionID: id.session, path: "deny.txt" })).toHaveLength(0)
    }),
  )

  it.instance("apply_patch applies add/update/delete/move in order with per-item journal", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("patch")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      yield* put(path.join(test.directory, "mod.txt"), "old\n")
      yield* put(path.join(test.directory, "gone.txt"), "bye\n")
      yield* put(path.join(test.directory, "src.txt"), "moving\n")
      const info = yield* ApplyPatchTool
      const tool = yield* info.init()
      const patch = [
        "*** Begin Patch",
        "*** Add File: added.txt",
        "+fresh",
        "*** Update File: mod.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: gone.txt",
        "*** Update File: src.txt",
        "*** Move to: dest.txt",
        "@@",
        "-moving",
        "+moved",
        "*** End Patch",
      ].join("\n")
      const result: any = yield* tool.execute(
        { patchText: patch },
        {
          sessionID: SessionID.make(id.session),
          messageID: MessageID.make(id.message),
          callID: id.call,
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.metadata.journal.coverage).toBe("full")
      expect(result.metadata.journal.ids).toHaveLength(5)
      const rows = yield* journal.list({ sessionID: id.session })
      // Move is two facts (target add sub 0 + source delete sub 1); no single-row op=move is written.
      // Both share item 3; list order is stable target-first by (created, item, sub).
      expect([...rows.map((row) => row.op)].sort()).toEqual(["add", "add", "delete", "delete", "update"])
      expect(rows.map((row) => row.item_index)).toEqual([0, 1, 2, 3, 3])
      expect(rows.map((row) => row.sub_index)).toEqual([0, 0, 0, 0, 1])
      // ids metadata order matches list order (target sub 0 before source sub 1).
      expect(result.metadata.journal.ids).toEqual(rows.map((row) => row.id))
      expect(rows.every((row) => row.status === "applied")).toBe(true)
      expect(rows.some((row) => row.op === "move")).toBe(false)
      const src = rows.find((row) => row.op === "delete" && row.path.endsWith("src.txt"))!
      expect(src.after_blob).toBeNull()
      const tgt = rows.find((row) => row.path.endsWith("dest.txt"))!
      expect(tgt.op).toBe("add")
      expect(tgt.before_blob).toBeNull()
      const gone = rows.find((row) => row.op === "delete" && row.path.endsWith("gone.txt"))!
      expect(gone.after_blob).toBeNull()
      expect(yield* load(path.join(test.directory, "dest.txt"))).toContain("moved")
    }),
  )

  it.instance("apply_patch mid-batch failure keeps applied, fails current, writes nothing later", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("patchfail")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      yield* put(path.join(test.directory, "first.txt"), "one\n")
      yield* put(path.join(test.directory, "blocker"), "i am a file\n")
      const info = yield* ApplyPatchTool
      const tool = yield* info.init()
      const metas: any[] = []
      // Item 1 cannot be written: its parent "blocker" is a file, so the
      // mkdir inside the encoding-aware write fails after item 0 applied.
      const patch = [
        "*** Begin Patch",
        "*** Update File: first.txt",
        "@@",
        "-one",
        "+uno",
        "*** Add File: blocker/child.txt",
        "+nope",
        "*** Add File: later.txt",
        "+never",
        "*** End Patch",
      ].join("\n")
      const exit = yield* tool
        .execute(
          { patchText: patch },
          {
            sessionID: SessionID.make(id.session),
            messageID: MessageID.make(id.message),
            callID: id.call,
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: (input: any) => Effect.sync(() => metas.push(input)),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* load(path.join(test.directory, "first.txt"))).toContain("uno")
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(2)
      expect(rows[0]!.status).toBe("applied")
      expect(rows[1]!.status).toBe("failed")
      expect(rows[1]!.error).toBeDefined()
      const last = metas[metas.length - 1]!
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toHaveLength(2)
      const later = yield* Effect.promise(() =>
        fs
          .access(path.join(test.directory, "later.txt"))
          .then(() => true)
          .catch(() => false),
      )
      expect(later).toBe(false)
    }),
  )

  it.live("apply DB failure restores before only when disk still matches after", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const { db } = yield* Database.Service
      const id = ids("rollback")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-rollback-")))
      try {
        const file = path.join(dir, "victim.txt")
        const v1 = Buffer.from("version one\n", "utf-8")
        const v2 = Buffer.from("version two\n", "utf-8")
        yield* put(file, v1)
        const noted = yield* journal.prepare({
          sessionID: id.session,
          messageID: id.message,
          callID: id.call,
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
        // Simulate the tool write, then wedge the database with an exclusive
        // holder so the apply transaction fails after the file is on disk.
        yield* put(file, v2)
        yield* db.run(sql`PRAGMA busy_timeout = 0`)
        const holder = new BunDatabase(dbFile)
        try {
          holder.exec("BEGIN IMMEDIATE")
          holder.exec("CREATE TABLE IF NOT EXISTS lock_hold (x TEXT)")
          const exit = yield* journal
            .apply({ id: noted.row.id, after: v2, encoding: "utf-8", bom: false, beforeFallback: v1 })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) throw new Error("expected apply failure")
          const err = Cause.squash(exit.cause) as { _tag: string; message: string; recovered: boolean }
          expect(err._tag).toBe("SnapshotJournalApplyError")
          expect(err.recovered).toBe(true)
          expect(err.message.startsWith("journal apply failed: ")).toBe(true)
          expect(err.message.length).toBeGreaterThan("journal apply failed: ".length)
          expect((yield* loadRaw(file)).equals(v1)).toBe(true)
          // The mark-failed write also hit the lock, so the prepared fact stays.
          expect((yield* journal.get(noted.row.id))!.status).toBe("prepared")
        } finally {
          holder.exec("ROLLBACK")
          holder.close()
        }
        yield* db.run(sql`PRAGMA busy_timeout = 5000`)

        // External rewrite: disk no longer matches after, so no restore.
        const v3 = Buffer.from("external rewrite\n", "utf-8")
        yield* put(file, v2)
        const noted2 = yield* journal.prepare({
          sessionID: id.session,
          messageID: `${id.message}-ext`,
          callID: `${id.call}-ext`,
          tool: "edit",
          item: 0,
          directory: dir,
          worktree: dir,
          path: file,
          op: "update",
          before: v2,
          encoding: "utf-8",
          bom: false,
        })
        yield* put(file, v3)
        yield* db.run(sql`PRAGMA busy_timeout = 0`)
        const holder2 = new BunDatabase(dbFile)
        try {
          holder2.exec("BEGIN IMMEDIATE")
          holder2.exec("CREATE TABLE IF NOT EXISTS lock_hold (x TEXT)")
          const exit = yield* journal
            .apply({ id: noted2.row.id, after: v2, encoding: "utf-8", bom: false, beforeFallback: v2 })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) throw new Error("expected apply failure")
          const err = Cause.squash(exit.cause) as { _tag: string; recovered: boolean }
          expect(err._tag).toBe("SnapshotJournalApplyError")
          expect(err.recovered).toBe(false)
          expect((yield* loadRaw(file)).equals(v3)).toBe(true)
        } finally {
          holder2.exec("ROLLBACK")
          holder2.close()
        }
        yield* db.run(sql`PRAGMA busy_timeout = 5000`)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("idempotent replay and typed conflicts, including concurrent prepare", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("idem")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-idem-")))
      try {
        const file = path.join(dir, "same.txt")
        const body = { sessionID: id.session, messageID: id.message, callID: id.call, tool: "edit", item: 0 as const, directory: dir, worktree: dir, path: file, op: "update" as const, encoding: "utf-8" as const, bom: false as const }
        const first = yield* journal.prepare({ ...body, before: Buffer.from("v1\n") })
        expect(first.outcome).toBe("prepared")
        const second = yield* journal.prepare({ ...body, before: Buffer.from("v1\n") })
        expect(second.outcome).toBe("replay")
        expect(second.row.id).toBe(first.row.id)
        const after = Buffer.from("v2\n")
        const applied = yield* journal.apply({ id: first.row.id, after, encoding: "utf-8", bom: false })
        expect(applied.outcome).toBe("applied")
        const replay = yield* journal.apply({ id: first.row.id, after: Buffer.from("v2\n"), encoding: "utf-8", bom: false })
        expect(replay.outcome).toBe("replay")
        const clash = yield* journal.apply({ id: first.row.id, after: Buffer.from("other\n"), encoding: "utf-8", bom: false }).pipe(Effect.exit)
        expect(Exit.isFailure(clash)).toBe(true)
        if (Exit.isFailure(clash)) expect(tagOf(Cause.squash(clash.cause))).toBe("SnapshotJournalConflict")
        const redo = yield* journal.prepare({ ...body, before: Buffer.from("v1\n") }).pipe(Effect.exit)
        expect(Exit.isFailure(redo)).toBe(true)
        if (Exit.isFailure(redo)) expect(tagOf(Cause.squash(redo.cause))).toBe("SnapshotJournalConflict")

        const racing = { sessionID: id.session, messageID: `${id.message}-race`, callID: `${id.call}-race`, tool: "edit", item: 0 as const, directory: dir, worktree: dir, path: file, op: "update" as const, encoding: "utf-8" as const, bom: false as const, before: Buffer.from("v1\n") }
        const settled = yield* Effect.all(
          Array.from({ length: 12 }, () => journal.prepare(racing)),
          { concurrency: 12 },
        )
        expect(settled.every((item) => item.outcome === "prepared" || item.outcome === "replay")).toBe(true)
        expect(new Set(settled.map((item) => item.row.id)).size).toBe(1)
        expect(yield* journal.list({ sessionID: id.session, messageID: `${id.message}-race` })).toHaveLength(1)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("session delete cascades and gc clears unreferenced blobs", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const { db } = yield* Database.Service
      const id = ids("cascade")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-gc-")))
      try {
        const file = path.join(dir, "doomed.txt")
        const before = Buffer.from(crypto.randomBytes(64))
        const after = Buffer.from(crypto.randomBytes(64))
        const noted = yield* journal.prepare({
          sessionID: id.session, messageID: id.message, callID: id.call, tool: "edit", item: 0,
          directory: dir, worktree: dir, path: file, op: "update", before, encoding: "utf-8", bom: false,
        })
        yield* journal.apply({ id: noted.row.id, after, encoding: "utf-8", bom: false })
        expect(yield* journal.readBlob(noted.row.before_hash!)).toBeDefined()
        yield* db.delete(SessionTable).where(eq(SessionTable.id, id.session as never)).run()
        expect(yield* journal.list({ sessionID: id.session })).toHaveLength(0)
        // Blobs linger until the explicit gc (no triggers, no ref-count machine).
        expect(yield* journal.readBlob(noted.row.before_hash!)).toBeDefined()
        const removed = yield* journal.gc()
        expect(removed).toBeGreaterThanOrEqual(2)
        expect(yield* journal.readBlob(noted.row.before_hash!)).toBeUndefined()
        expect(yield* journal.readBlob(noted.row.after_hash!)).toBeUndefined()
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("identical content dedupes across sessions and paths stay in-worktree", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const { db } = yield* Database.Service
      const left = ids("dedup-left")
      const right = ids("dedup-right")
      yield* ensureJournalSession(left.session)
      yield* ensureJournalSession(right.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-dedup-")))
      try {
        const shared = Buffer.from(crypto.randomBytes(128))
        const base = { messageID: "msg_dedup", callID: "call_dedup", tool: "edit", item: 0 as const, directory: dir, worktree: dir, op: "update" as const, before: shared, encoding: "utf-8" as const, bom: false as const }
        const one = yield* journal.prepare({ ...base, sessionID: left.session, path: path.join(dir, "a.txt") })
        const two = yield* journal.prepare({ ...base, sessionID: right.session, path: path.join(dir, "b.txt") })
        expect(one.row.before_blob).toBe(two.row.before_blob)
        const blobs = (yield* db
          .select()
          .from(SnapshotBlobTable)
          .where(eq(SnapshotBlobTable.sha256, one.row.before_hash!))) as unknown as unknown[]
        expect(blobs).toHaveLength(1)

        for (const bad of ["../escape.txt", "/etc/passwd", `${dir}/../out.txt`]) {
          const exit = yield* journal
            .prepare({ ...base, sessionID: left.session, path: bad })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(tagOf(Cause.squash(exit.cause))).toBe("SnapshotJournalPathError")
        }
        const target = yield* journal
          .prepare({ ...base, sessionID: left.session, path: path.join(dir, "ok.txt"), target: "/etc/shadow", op: "move" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(target)).toBe(true)
        if (Exit.isFailure(target)) expect(tagOf(Cause.squash(target.cause))).toBe("SnapshotJournalPathError")
        const missing = yield* journal
          .prepare({ ...base, sessionID: left.session, path: path.join(dir, "ok.txt"), op: "move" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(missing)).toBe(true)
        // Cleanup keeps later gc assertions exact.
        yield* db.delete(SessionTable).where(eq(SessionTable.id, left.session as never)).run()
        yield* db.delete(SessionTable).where(eq(SessionTable.id, right.session as never)).run()
        yield* journal.gc()
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("write records formatter-final journal with full coverage", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("write")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      const file = path.join(test.directory, "plain-note.txt")
      yield* put(file, "before\n")
      const info = yield* WriteTool
      const tool = yield* info.init()
      const result: any = yield* tool.execute(
        { filePath: file, content: "after\n" },
        {
          sessionID: SessionID.make(id.session),
          messageID: MessageID.make(id.message),
          callID: id.call,
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.metadata.journal.coverage).toBe("full")
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("applied")
      expect(rows[0]!.directory).toBe(test.directory)
      const inst = yield* InstanceState.context
      expect(rows[0]!.worktree).toBe(inst.worktree)
      expect(rows[0]!.path.endsWith("plain-note.txt")).toBe(true)
      const disk = yield* loadRaw(file)
      expect(rows[0]!.after_hash).toBe(Hash.sha256(disk))
    }),
  )

  it.live("message metadata strip keeps the small journal pointer", () =>
    Effect.gen(function* () {
      const small = "diff --git a/a b/a\n"
      const part = {
        id: "prt_journal",
        sessionID: "ses_journal_strip",
        messageID: "msg_journal_strip",
        type: "tool",
        callID: "call_journal_strip",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "t",
          metadata: {
            filediff: { file: "a", patch: small, additions: 1, deletions: 1 },
            journal: { coverage: "full", ids: ["row-1", "row-2"] },
          },
          time: { start: 0, end: 1 },
        },
      } as never
      const kept = stripPartMetadata(part) as any
      expect(kept.state.metadata.journal).toEqual({ coverage: "full", ids: ["row-1", "row-2"] })
      expect(kept.state.metadata.filediff.patch).toBe(small)
    }),
  )

  it.live("filters list by session, message, call, path, and status", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("filter")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-filter-")))
      try {
        const file = path.join(dir, "f.txt")
        const body = { sessionID: id.session, messageID: id.message, callID: id.call, tool: "edit", item: 0 as const, directory: dir, worktree: dir, path: file, op: "update" as const, before: Buffer.from("x\n"), encoding: "utf-8" as const, bom: false as const }
        const noted = yield* journal.prepare(body)
        expect(yield* journal.list({ sessionID: id.session, messageID: id.message })).toHaveLength(1)
        expect(yield* journal.list({ sessionID: id.session, callID: id.call })).toHaveLength(1)
        expect(yield* journal.list({ sessionID: id.session, path: "f.txt" })).toHaveLength(1)
        const preparedRows = yield* journal.list({ status: "prepared" })
        expect(preparedRows.some((row) => row.id === noted.row.id)).toBe(true)
        expect(yield* journal.list({ sessionID: id.session, messageID: "msg_nope" })).toHaveLength(0)
        const failed = yield* journal.fail({ id: noted.row.id, error: "boom" })
        expect(failed.status).toBe("failed")
        expect(yield* journal.list({ sessionID: id.session, status: "failed" })).toHaveLength(1)
        const again = yield* journal.fail({ id: noted.row.id, error: "boom" })
        expect(again.status).toBe("failed")
        // Cleanup keeps later gc assertions exact.
        const { db } = yield* Database.Service
        yield* db.delete(SessionTable).where(eq(SessionTable.id, id.session as never)).run()
        yield* journal.gc()
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("edit write failure marks prepared failed with running ids and zero full", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("editfail")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      // failfmt triggers the mock formatter to throw after prepare+write, before apply.
      const file = path.join(test.directory, "failfmt-edit.txt")
      yield* put(file, "hello\n")
      const info = yield* EditTool
      const tool = yield* info.init()
      const metas: any[] = []
      const exit = yield* tool
        .execute(
          { filePath: file, oldString: "hello", newString: "world" },
          {
            sessionID: SessionID.make(id.session),
            messageID: MessageID.make(id.message),
            callID: id.call,
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: (input: any) => Effect.sync(() => metas.push(input)),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      // Typed journal/write failure settles as tool failure (Tool.define.wrap orDie defect path),
      // but journal.fail + failed running metadata run first — proven here.
      expect(Exit.isFailure(exit)).toBe(true)
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("failed")
      expect(rows[0]!.error).toBeDefined()
      expect(rows.some((row) => row.status === "applied")).toBe(false)
      const partial = metas.find((m) => m.metadata?.journal?.coverage === "partial")
      expect(partial?.metadata.journal.ids).toHaveLength(1)
      const last = metas[metas.length - 1]!
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toEqual(partial.metadata.journal.ids)
      if (Exit.isFailure(exit)) {
        const msg = String((Cause.squash(exit.cause) as Error)?.message ?? Cause.squash(exit.cause))
        expect(msg).toContain("mock formatter boom")
      }
    }),
  )

  it.instance("write write failure marks prepared failed with running ids and zero full", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("writefail")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      const file = path.join(test.directory, "failfmt-write.txt")
      yield* put(file, "before\n")
      const info = yield* WriteTool
      const tool = yield* info.init()
      const metas: any[] = []
      const exit = yield* tool
        .execute(
          { filePath: file, content: "after\n" },
          {
            sessionID: SessionID.make(id.session),
            messageID: MessageID.make(id.message),
            callID: id.call,
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: (input: any) => Effect.sync(() => metas.push(input)),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("failed")
      expect(rows.some((row) => row.status === "applied")).toBe(false)
      const last = metas[metas.length - 1]!
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toHaveLength(1)
    }),
  )

  it.live("prepare before drift is a typed Conflict, never a silent baseline reuse", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const id = ids("drift")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-drift-")))
      try {
        const file = path.join(dir, "drift.txt")
        const base = { sessionID: id.session, messageID: id.message, callID: id.call, tool: "edit", item: 0 as const, directory: dir, worktree: dir, path: file, op: "update" as const, encoding: "utf-8" as const, bom: false as const }
        const first = yield* journal.prepare({ ...base, before: Buffer.from("v1\n") })
        expect(first.outcome).toBe("prepared")
        for (const variant of [
          { ...base, before: Buffer.from("v2\n") },
          { ...base, before: Buffer.from("v1\n"), encoding: "latin1" as const },
          { ...base, before: Buffer.from("v1\n"), bom: true as const },
          { ...base, before: null },
        ]) {
          const exit = yield* journal.prepare(variant as never).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(tagOf(Cause.squash(exit.cause))).toBe("SnapshotJournalConflict")
        }
        // Same baseline still replays.
        const replay = yield* journal.prepare({ ...base, before: Buffer.from("v1\n") })
        expect(replay.outcome).toBe("replay")
        expect(replay.row.id).toBe(first.row.id)
        const { db } = yield* Database.Service
        yield* db.delete(SessionTable).where(eq(SessionTable.id, id.session as never)).run()
        yield* journal.gc()
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("CAS rollback deletes only add-without-before and never deletes on missing before blob", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const { db } = yield* Database.Service
      const id = ids("cas")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-cas-")))
      try {
        // Add without before: DB failure after the file lands deletes the after image.
        const added = path.join(dir, "added.txt")
        const addNoted = yield* journal.prepare({
          sessionID: id.session, messageID: id.message, callID: id.call, tool: "write", item: 0,
          directory: dir, worktree: dir, path: added, op: "add", before: null, encoding: "utf-8", bom: false,
        })
        const addAfter = Buffer.from("new file\n")
        yield* put(added, addAfter)
        yield* db.run(sql`PRAGMA busy_timeout = 0`)
        const holder = new BunDatabase(dbFile)
        try {
          holder.exec("BEGIN IMMEDIATE")
          holder.exec("CREATE TABLE IF NOT EXISTS lock_hold (x TEXT)")
          const exit = yield* journal.apply({ id: addNoted.row.id, after: addAfter, encoding: "utf-8", bom: false }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(tagOf(Cause.squash(exit.cause))).toBe("SnapshotJournalApplyError")
            expect((Cause.squash(exit.cause) as { recovered: boolean }).recovered).toBe(true)
          }
          expect(yield* Effect.promise(() => fs.access(added).then(() => true).catch(() => false))).toBe(false)
        } finally {
          holder.exec("ROLLBACK")
          holder.close()
        }
        yield* db.run(sql`PRAGMA busy_timeout = 5000`)

        // Update with missing before blob: refuse restore, keep the after image.
        const victim = path.join(dir, "victim.txt")
        const v1 = Buffer.from("v1\n")
        const v2 = Buffer.from("v2\n")
        yield* put(victim, v1)
        const updNoted = yield* journal.prepare({
          sessionID: id.session, messageID: `${id.message}-upd`, callID: `${id.call}-upd`, tool: "edit", item: 0,
          directory: dir, worktree: dir, path: victim, op: "update", before: v1, encoding: "utf-8", bom: false,
        })
        // Simulate a missing before blob (corrupt/GC gap): FK off so the referenced blob can be removed.
        yield* db.run(sql`PRAGMA foreign_keys = OFF`)
        yield* db.delete(SnapshotBlobTable).where(eq(SnapshotBlobTable.sha256, updNoted.row.before_hash!)).run()
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* put(victim, v2)
        yield* db.run(sql`PRAGMA busy_timeout = 0`)
        const holder2 = new BunDatabase(dbFile)
        try {
          holder2.exec("BEGIN IMMEDIATE")
          holder2.exec("CREATE TABLE IF NOT EXISTS lock_hold (x TEXT)")
          const exit = yield* journal.apply({ id: updNoted.row.id, after: v2, encoding: "utf-8", bom: false, beforeFallback: v1 }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(tagOf(Cause.squash(exit.cause))).toBe("SnapshotJournalApplyError")
            expect((Cause.squash(exit.cause) as { recovered: boolean }).recovered).toBe(false)
          }
          // No delete: the after image survives.
          expect((yield* loadRaw(victim)).equals(v2)).toBe(true)
        } finally {
          holder2.exec("ROLLBACK")
          holder2.close()
        }
        yield* db.run(sql`PRAGMA busy_timeout = 5000`)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, id.session as never)).run()
        yield* journal.gc()
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("move to existing target preserves accurate prior with dual applied facts", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("moveexist")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      yield* put(path.join(test.directory, "src.txt"), "moving\n")
      const prior = Buffer.from("existing target\n")
      yield* put(path.join(test.directory, "dest.txt"), prior)
      const info = yield* ApplyPatchTool
      const tool = yield* info.init()
      const patch = ["*** Begin Patch", "*** Update File: src.txt", "*** Move to: dest.txt", "@@", "-moving", "+moved", "*** End Patch"].join("\n")
      const result: any = yield* tool.execute(
        { patchText: patch },
        { sessionID: SessionID.make(id.session), messageID: MessageID.make(id.message), callID: id.call, agent: "build", abort: AbortSignal.any([]), messages: [], metadata: () => Effect.void, ask: () => Effect.void },
      )
      expect(result.metadata.journal.coverage).toBe("full")
      expect(result.metadata.journal.ids).toHaveLength(2)
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(2)
      expect(rows.some((row) => row.op === "move")).toBe(false)
      const src = rows.find((row) => row.path.endsWith("src.txt"))!
      const tgt = rows.find((row) => row.path.endsWith("dest.txt"))!
      expect(src.op).toBe("delete")
      expect(src.status).toBe("applied")
      expect(tgt.op).toBe("update")
      expect(tgt.status).toBe("applied")
      expect(tgt.before_hash).toBe(Hash.sha256(prior))
      expect(Buffer.from((yield* journal.readBlob(tgt.before_hash!))!).equals(prior)).toBe(true)
      expect(yield* load(path.join(test.directory, "dest.txt"))).toContain("moved")
      expect(yield* Effect.promise(() => fs.access(path.join(test.directory, "src.txt")).then(() => true).catch(() => false))).toBe(false)
    }),
  )

  it.instance("move target write failure fails both facts with zero applied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("movefail")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      yield* put(path.join(test.directory, "src.txt"), "moving\n")
      yield* put(path.join(test.directory, "blocker"), "i am a file\n")
      const info = yield* ApplyPatchTool
      const tool = yield* info.init()
      const metas: any[] = []
      // Target blocker/child.txt cannot be created (blocker is a file), so the
      // dual move fails before any write lands.
      const patch = ["*** Begin Patch", "*** Update File: src.txt", "*** Move to: blocker/child.txt", "@@", "-moving", "+moved", "*** End Patch"].join("\n")
      const exit = yield* tool
        .execute(
          { patchText: patch },
          { sessionID: SessionID.make(id.session), messageID: MessageID.make(id.message), callID: id.call, agent: "build", abort: AbortSignal.any([]), messages: [], metadata: (input: any) => Effect.sync(() => metas.push(input)), ask: () => Effect.void },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.status === "failed")).toBe(true)
      expect(rows.some((row) => row.status === "applied")).toBe(false)
      expect(yield* load(path.join(test.directory, "src.txt"))).toBe("moving\n")
      const last = metas[metas.length - 1]!
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toHaveLength(2)
    }),
  )

  it.instance("apply_patch failure keeps prefix formatter-final diffs, events, and LSP touch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("prefixmeta")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      yield* put(path.join(test.directory, "first.txt"), "one\n")
      yield* put(path.join(test.directory, "blocker"), "i am a file\n")
      const info = yield* ApplyPatchTool
      const tool = yield* info.init()
      const metas: any[] = []
      const patch = ["*** Begin Patch", "*** Update File: first.txt", "@@", "-one", "+uno", "*** Add File: blocker/child.txt", "+nope", "*** Add File: later.txt", "+never", "*** End Patch"].join("\n")
      const exit = yield* tool
        .execute(
          { patchText: patch },
          { sessionID: SessionID.make(id.session), messageID: MessageID.make(id.message), callID: id.call, agent: "build", abort: AbortSignal.any([]), messages: [], metadata: (input: any) => Effect.sync(() => metas.push(input)), ask: () => Effect.void },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      // Completed prefix is formatter-final on disk (mock formatter appends MARK).
      expect(yield* load(path.join(test.directory, "first.txt"))).toContain("uno")
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(2)
      expect(rows[0]!.status).toBe("applied")
      expect(rows[1]!.status).toBe("failed")
      const last = metas[metas.length - 1]!
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toHaveLength(2)
      // Error running metadata retains the applied prefix formatter-final files/totalDiff.
      expect(last.metadata.files).toHaveLength(1)
      expect(last.metadata.files[0].patch).toContain("uno")
      expect(last.metadata.diff).toContain("uno")
      expect(last.metadata.files[0].patch).toContain(MARK)
    }),
  )

  it.live("gc is a single transaction and never drops concurrently referenced blobs", () =>
    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const { db } = yield* Database.Service
      const id = ids("gcrace")
      yield* ensureJournalSession(id.session)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-gcrace-")))
      try {
        const file = path.join(dir, "r.txt")
        const before = Buffer.from(crypto.randomBytes(64))
        const noted = yield* journal.prepare({
          sessionID: id.session, messageID: id.message, callID: id.call, tool: "edit", item: 0,
          directory: dir, worktree: dir, path: file, op: "update", before, encoding: "utf-8", bom: false,
        })
        yield* journal.fail({ id: noted.row.id, error: "kept fact" })
        // Orphan blob with no mutation reference is the only gc target.
        const orphan = Buffer.from(crypto.randomBytes(32))
        const orphanHash = Hash.sha256(orphan)
        yield* db.insert(SnapshotBlobTable).values({ sha256: orphanHash, bytes: orphan, size: orphan.length, time_created: Date.now() }).onConflictDoNothing().run()
        // Concurrent prepares race a single-transaction gc: referenced blobs survive.
        const racing = { sessionID: id.session, messageID: `${id.message}-race`, callID: `${id.call}-race`, tool: "edit", item: 0 as const, directory: dir, worktree: dir, path: file, op: "update" as const, before, encoding: "utf-8" as const, bom: false as const }
        const [gcCount] = yield* Effect.all([journal.gc(), Effect.all(Array.from({ length: 8 }, () => journal.prepare(racing)), { concurrency: 8 })], { concurrency: 2 }).pipe(
          Effect.map(([count]) => [count] as const),
        )
        expect(gcCount).toBeGreaterThanOrEqual(1)
        expect(yield* journal.readBlob(noted.row.before_hash!)).toBeDefined()
        expect(yield* journal.readBlob(orphanHash)).toBeUndefined()
        expect(yield* journal.list({ sessionID: id.session, status: "failed" })).toHaveLength(1)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, id.session as never)).run()
        yield* journal.gc()
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.live("production ToolRegistry path shares one canonical journal", () =>
    Effect.gen(function* () {
      const registrySrc = yield* Effect.promise(() => fs.readFile("src/tool/registry.ts", "utf-8"))
      expect(registrySrc.includes("SnapshotJournal.Service")).toBe(true)
      expect(registrySrc.includes("SnapshotJournal.defaultLayer")).toBe(false)
      const appSrc = yield* Effect.promise(() => fs.readFile("src/effect/app-runtime.ts", "utf-8"))
      expect(appSrc.includes("const JournalLive = SnapshotJournal.defaultLayer")).toBe(true)
      expect(appSrc.includes("ToolRegistry.defaultLayer.pipe(")).toBe(true)
      expect(appSrc.includes("Layer.provide(JournalLive)")).toBe(true)
      expect(appSrc.includes("Layer.provide(SnapshotLive)")).toBe(true)
      expect(appSrc.split("SnapshotJournal.defaultLayer").length - 1).toBe(1)
      for (const src of yield* Effect.promise(() =>
        Promise.all([
          fs.readFile("src/tool/edit.ts", "utf-8"),
          fs.readFile("src/tool/write.ts", "utf-8"),
          fs.readFile("src/tool/apply_patch.ts", "utf-8"),
        ]),
      )) {
        expect(src.includes("yield* SnapshotJournal.Service")).toBe(true)
        expect(src.includes("yield* Snapshot.Service")).toBe(true)
        expect(src.includes("JournalWindow.run")).toBe(true)
        expect(src.includes("serviceOption")).toBe(false)
        expect(src.includes("SnapshotJournal.defaultLayer")).toBe(false)
        expect(src.includes("Snapshot.defaultLayer")).toBe(false)
      }
    }),
  )

  it.instance("production ToolRegistry executes file tools with shared journal", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("regprod")
      yield* ensureJournalSession(id.session)
      const direct = yield* SnapshotJournal.Service
      const registry = yield* ToolRegistry.Service
      const defs = yield* registry.all()
      const editDef = defs.find((item) => item.id === "edit")!
      expect(editDef).toBeDefined()
      const file = test.directory + "/via-registry.txt"
      yield* put(file, "hello\n")
      const result: any = yield* editDef.execute(
        { filePath: file, oldString: "hello", newString: "world" },
        {
          sessionID: SessionID.make(id.session),
          messageID: MessageID.make(id.message),
          callID: id.call,
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.metadata.journal.coverage).toBe("full")
      expect(result.metadata.journal.ids).toHaveLength(1)
      const rows = yield* direct.list({ sessionID: id.session })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("applied")
      expect(rows[0]!.id).toBe(result.metadata.journal.ids[0])
      expect(rows[0]!.sub_index).toBe(0)
    }),
  )

  it.instance("move target applied source remove failed keeps honest partial", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = ids("movepartial")
      yield* ensureJournalSession(id.session)
      const journal = yield* SnapshotJournal.Service
      const src = test.directory + "/src.txt"
      const dest = test.directory + "/dest.txt"
      yield* put(src, "moving\n")
      yield* put(dest, "existing\n")
      const real = yield* FSUtil.Service
      const wrapped = FSUtil.Service.of({
        ...real,
        remove: (p: string) =>
          p === src ? Effect.die(new Error("mock source remove boom")) : real.remove(p),
      })
      const wrappedLayer = Layer.succeed(FSUtil.Service, wrapped)
      const seenEvents: Array<{ file: string; event: string }> = []
      const seenTouches: string[] = []
      const { Watcher } = yield* Effect.promise(() => import("@opencode-ai/core/filesystem/watcher"))
      const realEvents = yield* EventV2Bridge.Service
      const eventsWrapped = EventV2Bridge.Service.of({
        ...realEvents,
        publish: ((def: any, data: any, opts?: any) => {
          if (def === (Watcher as any).Event.Updated) {
            seenEvents.push({ file: (data as any).file, event: (data as any).event })
          }
          return (realEvents.publish as any)(def, data, opts)
        }) as any,
      })
      const realLsp = yield* LSP.Service
      const lspWrapped = LSP.Service.of({
        ...realLsp,
        touchFile: ((input: string, mode?: any) => {
          seenTouches.push(input)
          return (realLsp.touchFile as any)(input, mode)
        }) as any,
      })
      const info = yield* ApplyPatchTool.pipe(
        Effect.provide(wrappedLayer),
        Effect.provide(Layer.succeed(EventV2Bridge.Service, eventsWrapped)),
        Effect.provide(Layer.succeed(LSP.Service, lspWrapped)),
      )
      const tool = yield* info.init()
      const metas: any[] = []
      const patch = ["*** Begin Patch", "*** Update File: src.txt", "*** Move to: dest.txt", "@@", "-moving", "+moved", "*** End Patch"].join("\n")
      const exit = yield* tool
        .execute(
          { patchText: patch },
          {
            sessionID: SessionID.make(id.session),
            messageID: MessageID.make(id.message),
            callID: id.call,
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: (input: any) => Effect.sync(() => metas.push(input)),
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const rows = yield* journal.list({ sessionID: id.session })
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.sub_index)).toEqual([0, 1])
      expect(rows[0]!.path.endsWith("dest.txt")).toBe(true)
      expect(rows[1]!.path.endsWith("src.txt")).toBe(true)
      const tgt = rows[0]!
      const failedSrc = rows[1]!
      expect(tgt.status).toBe("applied")
      expect(tgt.op).toBe("update")
      expect(failedSrc.status).toBe("failed")
      expect(failedSrc.op).toBe("delete")
      expect(failedSrc.error).toContain("mock source remove boom")
      expect(Buffer.from((yield* journal.readBlob(tgt.before_hash!))!).toString("utf-8")).toBe("existing\n")
      expect(Buffer.from((yield* journal.readBlob(failedSrc.before_hash!))!).toString("utf-8")).toBe("moving\n")
      const last = metas[metas.length - 1]!
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toHaveLength(2)
      expect(last.metadata.journal.ids).toEqual(rows.map((row) => row.id))
      expect(metas.some((m) => m.metadata?.journal?.coverage === "partial")).toBe(true)
      expect(yield* load(dest)).toContain("moved")
      expect(yield* load(src)).toBe("moving\n")
      expect(seenEvents.some((e) => e.file === dest && e.event === "change")).toBe(true)
      expect(seenEvents.some((e) => e.file === src)).toBe(false)
      expect(seenTouches).toContain(dest)
    }),
  )

  it.live("move list order stable target-first across concurrent and restart", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "journal-moveorder-")))
      const dbPath = path.join(dir, "order.db")
      const dbLayer = Database.layerFromPath(dbPath)
      const make = () =>
        ManagedRuntime.make(
          Layer.mergeAll(
            FSUtil.defaultLayer,
            dbLayer,
            SnapshotJournal.layer.pipe(Layer.provide(dbLayer), Layer.provide(FSUtil.defaultLayer)),
          ),
        )
      const sid = "ses_journal_moveorder"
      const mid = "msg_journal_moveorder"
      const call = "call_journal_moveorder"
      const file = path.join(dir, "src.txt")
      const target = path.join(dir, "dest.txt")
      const beforeSrc = Buffer.from("moving\n", "utf-8")
      const beforeTgt = Buffer.from("existing\n", "utf-8")
      const first = make()
      const ids0: string[] = yield* Effect.promise(() =>
        first.runPromise(
          Effect.gen(function* () {
            yield* ensureJournalSession(sid)
            const journal = yield* SnapshotJournal.Service
            const racing = (sub: number, p: string, before: Buffer, op: "delete" | "update") =>
              journal.prepare({
                sessionID: sid,
                messageID: mid,
                callID: call,
                tool: "apply_patch",
                item: 0,
                sub,
                directory: dir,
                worktree: dir,
                path: p,
                op,
                before,
                encoding: "utf-8",
                bom: false,
              })
            const settled = yield* Effect.all(
              [
                ...Array.from({ length: 6 }, () => racing(0, target, beforeTgt, "update")),
                ...Array.from({ length: 6 }, () => racing(1, file, beforeSrc, "delete")),
              ],
              { concurrency: 12 },
            )
            const rows = yield* journal.list({ sessionID: sid })
            expect(rows).toHaveLength(2)
            expect(rows.map((row) => row.sub_index)).toEqual([0, 1])
            expect(rows[0]!.path.endsWith("dest.txt")).toBe(true)
            expect(rows[1]!.path.endsWith("src.txt")).toBe(true)
            expect(new Set(settled.map((s) => s.row.id)).size).toBe(2)
            return rows.map((row) => row.id)
          }),
        ),
      ).pipe(Effect.ensuring(Effect.promise(() => first.dispose())))
      const second = make()
      yield* Effect.promise(() =>
        second.runPromise(
          Effect.gen(function* () {
            const journal = yield* SnapshotJournal.Service
            const rows = yield* journal.list({ sessionID: sid })
            expect(rows.map((row) => row.id)).toEqual(ids0)
            expect(rows.map((row) => row.sub_index)).toEqual([0, 1])
          }),
        ),
      ).pipe(Effect.ensuring(Effect.promise(() => second.dispose())))
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

it.live("non-file and custom tools need no Journal; file tools require it", () =>
    Effect.gen(function* () {
      // Static contract: file tools require Journal, non-file tools do not.
      const [readSrc, editSrc] = yield* Effect.promise(() =>
        Promise.all([fs.readFile("src/tool/read.ts", "utf-8"), fs.readFile("src/tool/edit.ts", "utf-8")]),
      )
      expect(readSrc.includes("SnapshotJournal")).toBe(false)
      expect(editSrc.includes("yield* SnapshotJournal.Service")).toBe(true)
      // Runtime: a Journal-free runtime builds custom tools but not file tools.
      const noJournal = Layer.mergeAll(
        FSUtil.defaultLayer,
        LSP.defaultLayer,
        formatLayer,
        EventV2Bridge.defaultLayer,
        Truncate.defaultLayer,
        Agent.defaultLayer,
      )
      const runNoJournal = ManagedRuntime.make(noJournal)
      try {
        const { Cause: Cause2, Exit: Exit2, Effect: Effect2 } = yield* Effect.promise(() => import("effect"))
        // Custom tool with only Truncate+Agent builds without Journal.
        const customOk = yield* Effect.promise(() =>
          runNoJournal.runPromiseExit(
            Effect.gen(function* () {
              const { Tool: ToolNs } = yield* Effect.promise(() => import("@/tool/tool"))
              const { Schema: SchemaNs } = yield* Effect.promise(() => import("effect"))
              const Custom = ToolNs.define(
                "custom_nojournal",
                Effect.gen(function* () {
                  const truncate = yield* (yield* Effect.promise(() => import("@/tool/truncate"))).Truncate.Service
                  const agents = yield* (yield* Effect.promise(() => import("@/agent/agent"))).Agent.Service
                  return {
                    description: "custom",
                    parameters: SchemaNs.Struct({}),
                    execute: () =>
                      Effect.gen(function* () {
                        const info = yield* agents.get("build")
                        const out = yield* truncate.output("ok", {}, info)
                        return { title: "custom", metadata: {}, output: out.content }
                      }),
                  }
                }),
              )
              const yielded = yield* Custom
              return yield* yielded.init()
            }),
          ),
        )
        expect(Exit2.isSuccess(customOk)).toBe(true)
        // File tool without Journal fails (missing service defect, never silent).
        const editFail = yield* Effect.promise(() =>
          runNoJournal.runPromiseExit(
            Effect.gen(function* () {
              const mod = yield* Effect.promise(() => import("@/tool/edit"))
              const anyEdit = mod.EditTool as unknown as Effect.Effect<unknown, unknown, never>
              return yield* anyEdit
            }) as unknown as Effect.Effect<unknown, unknown, never>,
          ),
        )
        expect(Exit2.isFailure(editFail)).toBe(true)
      } finally {
        yield* Effect.promise(() => runNoJournal.dispose())
      }
    }),
  )
})
