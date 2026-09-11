import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { SnapshotBlobTable, SnapshotMutationTable } from "@opencode-ai/core/snapshot/journal.sql"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"

// kilocode_change - Snapshot v2 durable file mutation journal. Strictly a
// queryable capture unit: SessionRevert/Snapshot restore transport is
// unchanged (git-backed). Blobs hold complete raw bytes; ToolPart metadata
// carries only small {coverage, ids} pointers.

const log = Log.create({ service: "snapshot-journal" })

export type Op = "add" | "update" | "delete" | "move"
export type Status = "prepared" | "applied" | "failed"
export type Row = typeof SnapshotMutationTable.$inferSelect

export class PathError extends Schema.TaggedErrorClass<PathError>()("SnapshotJournalPathError", {
  message: Schema.String,
  file: Schema.String,
  worktree: Schema.String,
}) {}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SnapshotJournalConflict", {
  message: Schema.String,
  id: Schema.String,
  status: Schema.String,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("SnapshotJournalNotFound", {
  message: Schema.String,
  id: Schema.String,
}) {}

export class DbError extends Schema.TaggedErrorClass<DbError>()("SnapshotJournalDbError", {
  op: Schema.String,
  message: Schema.String,
}) {}

export class ApplyError extends Schema.TaggedErrorClass<ApplyError>()("SnapshotJournalApplyError", {
  message: Schema.String,
  id: Schema.String,
  recovered: Schema.Boolean,
}) {}

export interface PrepareInput {
  readonly sessionID: string
  readonly messageID: string
  readonly callID?: string
  readonly tool: string
  readonly item: number
  readonly sub?: number
  readonly directory?: string
  readonly worktree?: string
  readonly path: string
  readonly target?: string
  readonly op: Op
  readonly before: Buffer | null
  readonly encoding?: string | null
  readonly bom?: boolean | null
  readonly diagnostic?: string | null
}

export interface ApplyInput {
  readonly id: string
  readonly after: Buffer | null
  readonly encoding?: string | null
  readonly bom?: boolean | null
  readonly diagnostic?: string | null
  readonly beforeFallback?: Buffer | null
}

export interface FailInput {
  readonly id: string
  readonly error: string
}

export interface Filter {
  readonly sessionID?: string
  readonly messageID?: string
  readonly callID?: string
  readonly status?: Status
  readonly path?: string
}

const nul = String.fromCharCode(0)

const idemKey = (session: string, message: string, call: string, item: number, sub: number, rel: string, op: Op) =>
  Hash.sha256([session, message, call, String(item), String(sub), rel, op].join(nul))

const digest = (bytes: Buffer | null) => (bytes ? Hash.sha256(bytes) : null)

function uniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  if (code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE")
    return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("UNIQUE constraint") || msg.includes("unique constraint") || msg.includes("SQLITE_CONSTRAINT")
}

const dbFail = (op: string, err: unknown) => new DbError({ op, message: err instanceof Error ? err.message : String(err) })

export interface Interface {
  readonly prepare: (
    input: PrepareInput,
  ) => Effect.Effect<{ outcome: "prepared" | "replay"; row: Row }, PathError | Conflict | DbError>
  readonly apply: (
    input: ApplyInput,
  ) => Effect.Effect<{ outcome: "applied" | "replay"; row: Row }, NotFound | Conflict | DbError | ApplyError>
  readonly fail: (input: FailInput) => Effect.Effect<Row, NotFound | Conflict | DbError>
  readonly get: (id: string) => Effect.Effect<Row | undefined, DbError>
  readonly list: (filter: Filter) => Effect.Effect<Row[], DbError>
  readonly readBlob: (sha256: string) => Effect.Effect<Buffer | undefined, DbError>
  readonly gc: () => Effect.Effect<number, DbError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SnapshotJournal") {}

export const layer: Layer.Layer<Service, never, Database.Service | FSUtil.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    type Store = typeof db
    type Prepared = { outcome: "prepared" | "replay"; row: Row }
    type Applied = { outcome: "applied" | "replay"; row: Row }
    const asStore = (tx: unknown) => tx as unknown as Store

    const roots = (dir: string, worktree?: string) =>
      Effect.gen(function* () {
        if (worktree) return { directory: FSUtil.resolve(dir), worktree: FSUtil.resolve(worktree) }
        const ctx = yield* InstanceState.context.pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!ctx) return yield* new PathError({ message: "no worktree context", file: dir, worktree: "" })
        return { directory: FSUtil.resolve(dir || ctx.directory), worktree: FSUtil.resolve(ctx.worktree) }
      })

    const relative = (worktree: string, file: string) => {
      const rel = path.relative(worktree, file).replaceAll("\\", "/")
      if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return undefined
      return rel
    }

    // Resolve without requiring existence: walk up to the nearest existing
    // ancestor (symlink-canonical, e.g. /var -> /private/var on macOS) and
    // re-append the remainder so new files still validate against worktree.
    const resolveAny = (file: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        let cur = file
        const tail: string[] = []
        for (;;) {
          const hit = yield* fs.exists(cur).pipe(Effect.orElseSucceed(() => false))
          if (hit) {
            const base = FSUtil.resolve(cur)
            return tail.length ? path.join(base, ...tail.reverse()) : base
          }
          const parent = path.dirname(cur)
          if (parent === cur) return FSUtil.resolve(file)
          tail.push(path.basename(cur))
          cur = parent
        }
      })

    const locate = Effect.fn("SnapshotJournal.locate")(function* (input: {
      directory?: string
      worktree?: string
      path: string
      target?: string
      op: Op
    }) {
      const root = yield* roots(input.directory ?? "", input.worktree)
      const abs = yield* resolveAny(path.isAbsolute(input.path) ? input.path : path.join(root.directory, input.path))
      const rel = relative(root.worktree, abs)
      if (!rel)
        return yield* new PathError({ message: `path escapes worktree: ${input.path}`, file: input.path, worktree: root.worktree })
      const raw = input.target
      const absTarget = raw ? yield* resolveAny(path.isAbsolute(raw) ? raw : path.join(root.directory, raw)) : undefined
      const targetRel = absTarget ? relative(root.worktree, absTarget) : undefined
      if (raw && !targetRel)
        return yield* new PathError({ message: `target escapes worktree: ${raw}`, file: raw, worktree: root.worktree })
      if (input.op === "move" && !targetRel)
        return yield* new PathError({ message: "move requires target in worktree", file: input.path, worktree: root.worktree })
      return { ...root, abs, rel, absTarget, targetRel }
    })

    const byKey = (store: Store, session: string, message: string, call: string, item: number, sub: number, rel: string, op: Op) =>
      store
        .select()
        .from(SnapshotMutationTable)
        .where(
          and(
            eq(SnapshotMutationTable.session_id, session),
            eq(SnapshotMutationTable.message_id, message),
            eq(SnapshotMutationTable.call_id, call),
            eq(SnapshotMutationTable.item_index, item),
            eq(SnapshotMutationTable.sub_index, sub),
            eq(SnapshotMutationTable.path, rel),
            eq(SnapshotMutationTable.op, op),
          ),
        )
        .get() as unknown as Effect.Effect<Row | undefined, unknown>

    const bomNorm = (bom: boolean | null | undefined) => (bom === undefined || bom === null ? null : bom ? 1 : 0)
    const encNorm = (encoding: string | null | undefined) => encoding ?? null
    // Replay must reuse the exact persisted baseline: existence + sha256 +
    // size + encoding + BOM. Any drift is a typed Conflict, never a silent
    // reuse of the old baseline.
    const checkBaseline = (found: Row, input: PrepareInput): Effect.Effect<void, Conflict> =>
      Effect.gen(function* () {
        if (found.status !== "prepared")
          return yield* new Conflict({ message: `journal replay of ${found.status} mutation`, id: found.id, status: found.status })
        const wantHash = digest(input.before)
        const wantHas = input.before !== null
        const gotHas = found.before_blob !== null || found.before_hash !== null
        if (wantHas !== gotHas)
          return yield* new Conflict({ message: "journal prepare before existence mismatch", id: found.id, status: found.status })
        if (wantHas && wantHash !== (found.before_hash ?? found.before_blob))
          return yield* new Conflict({ message: "journal prepare before hash mismatch", id: found.id, status: found.status })
        if (wantHas && input.before!.length !== found.before_size)
          return yield* new Conflict({ message: "journal prepare before size mismatch", id: found.id, status: found.status })
        if (encNorm(input.encoding) !== (found.encoding ?? null))
          return yield* new Conflict({ message: "journal prepare encoding mismatch", id: found.id, status: found.status })
        if (bomNorm(input.bom) !== found.bom)
          return yield* new Conflict({ message: "journal prepare bom mismatch", id: found.id, status: found.status })
      })
    const outcomeOf = (found: Row, input: PrepareInput) =>
      checkBaseline(found, input).pipe(Effect.as({ outcome: "replay" as const, row: found }))

    const prepare: Interface["prepare"] = Effect.fn("SnapshotJournal.prepare")(function* (input: PrepareInput) {
      const call = input.callID ?? ""
      const sub = input.sub ?? 0
      const loc = yield* locate(input)
      const beforeHash = digest(input.before)
      const id = idemKey(input.sessionID, input.messageID, call, input.item, sub, loc.rel, input.op)
      const now = Date.now()

      const commit = (store: Store): Effect.Effect<Prepared, Conflict | unknown> =>
        Effect.gen(function* () {
          const found = yield* byKey(store, input.sessionID, input.messageID, call, input.item, sub, loc.rel, input.op)
          if (found) return yield* outcomeOf(found, input)
          if (input.before !== null && beforeHash) {
            yield* store
              .insert(SnapshotBlobTable)
              .values({ sha256: beforeHash, bytes: input.before, size: input.before.length, time_created: now })
              .onConflictDoNothing()
              .run()
          }
          const created = (yield* store
            .insert(SnapshotMutationTable)
            .values({
              id,
              session_id: input.sessionID,
              message_id: input.messageID,
              call_id: call,
              tool: input.tool,
              item_index: input.item,
              sub_index: sub,
              directory: loc.directory,
              worktree: loc.worktree,
              path: loc.rel,
              target_path: loc.targetRel ?? null,
              op: input.op,
              status: "prepared",
              before_blob: beforeHash,
              after_blob: null,
              before_hash: beforeHash,
              before_size: input.before?.length ?? null,
              after_hash: null,
              after_size: null,
              encoding: input.encoding ?? null,
              bom: input.bom === undefined || input.bom === null ? null : input.bom ? 1 : 0,
              diagnostic: input.diagnostic ?? null,
              error: null,
              time_applied: null,
              time_created: now,
              time_updated: now,
            })
            .returning()) as unknown as Row[]
          return { outcome: "prepared" as const, row: created[0]! }
        })

      const fallback = (err: unknown): Effect.Effect<Prepared, PathError | Conflict | DbError> =>
        Effect.gen(function* () {
          if (err instanceof Conflict || err instanceof PathError) return yield* Effect.fail(err)
          if (!uniqueViolation(err)) return yield* Effect.fail(dbFail("prepare", err))
          const found = yield* byKey(db, input.sessionID, input.messageID, call, input.item, sub, loc.rel, input.op).pipe(
            Effect.catch((cause) => Effect.fail(dbFail("prepare", cause))),
            Effect.catchDefect((def) => Effect.fail(dbFail("prepare", def))),
          )
          if (!found) return yield* Effect.fail(dbFail("prepare", err))
          return yield* outcomeOf(found, input).pipe(
            Effect.catch((conflict) => Effect.fail(conflict)),
            Effect.catchDefect((def) => Effect.fail(dbFail("prepare", def))),
          )
        })

      return yield* db
        .transaction((tx) => commit(asStore(tx)), { behavior: "immediate" })
        .pipe(Effect.catch(fallback), Effect.catchDefect(fallback))
    })

    const readRow = (store: Store, id: string) =>
      store.select().from(SnapshotMutationTable).where(eq(SnapshotMutationTable.id, id)).get() as unknown as Effect.Effect<
        Row | undefined,
        unknown
      >

    const readBytes = (store: Store, ref: string | null) =>
      ref
        ? (store.select().from(SnapshotBlobTable).where(eq(SnapshotBlobTable.sha256, ref)).get() as unknown as Effect.Effect<
            { bytes: Buffer } | undefined,
            unknown
          >)
        : Effect.succeed(undefined as { bytes: Buffer } | undefined)

    const rawOf = (file: string) =>
      fs.readFile(file).pipe(
        Effect.map((data) => Buffer.from(data)),
        Effect.catch(() => Effect.succeed(undefined as Buffer | undefined)),
        Effect.catchDefect(() => Effect.succeed(undefined as Buffer | undefined)),
      )

    const apply: Interface["apply"] = Effect.fn("SnapshotJournal.apply")(function* (input: ApplyInput) {
      const afterHash = digest(input.after)
      const now = Date.now()
      const seen = yield* readRow(db, input.id).pipe(
        Effect.catch((cause) => Effect.fail(dbFail("apply", cause))),
        Effect.catchDefect((def) => Effect.fail(dbFail("apply", def))),
      )
      if (!seen) return yield* new NotFound({ message: `journal mutation not found: ${input.id}`, id: input.id })
      if (seen.status === "applied") {
        if ((seen.after_hash ?? null) === afterHash) return { outcome: "replay" as const, row: seen }
        return yield* new Conflict({ message: "journal apply after mismatch", id: seen.id, status: seen.status })
      }
      if (seen.status === "failed")
        return yield* new Conflict({ message: "journal apply of failed mutation", id: seen.id, status: seen.status })

      const stored = yield* readBytes(db, seen.before_blob).pipe(
        Effect.catch(() => Effect.succeed(undefined as { bytes: Buffer } | undefined)),
        Effect.catchDefect(() => Effect.succeed(undefined as { bytes: Buffer } | undefined)),
      )
      // Persisted fact only: a missing before blob must refuse restore even
      // when the caller still holds an in-memory fallback.
      const persisted = stored ? Buffer.from(stored.bytes) : undefined

      const commit = (store: Store): Effect.Effect<Applied, Conflict | NotFound | unknown> =>
        Effect.gen(function* () {
          const fresh = yield* readRow(store, input.id)
          if (!fresh) return yield* new NotFound({ message: `journal mutation not found: ${input.id}`, id: input.id })
          if (fresh.status === "applied") {
            if ((fresh.after_hash ?? null) === afterHash) return { outcome: "replay" as const, row: fresh }
            return yield* new Conflict({ message: "journal apply after mismatch", id: fresh.id, status: fresh.status })
          }
          if (fresh.status !== "prepared")
            return yield* new Conflict({ message: `journal apply of ${fresh.status} mutation`, id: fresh.id, status: fresh.status })
          if (input.after !== null && afterHash) {
            yield* store
              .insert(SnapshotBlobTable)
              .values({ sha256: afterHash, bytes: input.after, size: input.after.length, time_created: now })
              .onConflictDoNothing()
              .run()
          }
          const updated = (yield* store
            .update(SnapshotMutationTable)
            .set({
              after_blob: afterHash,
              after_hash: afterHash,
              after_size: input.after?.length ?? null,
              encoding: input.encoding ?? fresh.encoding,
              bom: input.bom === undefined || input.bom === null ? fresh.bom : input.bom ? 1 : 0,
              diagnostic: input.diagnostic ?? fresh.diagnostic,
              status: "applied",
              time_applied: now,
              time_updated: now,
            })
            .where(eq(SnapshotMutationTable.id, input.id))
            .returning()) as unknown as Row[]
          return { outcome: "applied" as const, row: updated[0]! }
        })

      const markFailed = (message: string) =>
        readRow(db, input.id).pipe(
          Effect.flatMap((row) => {
            if (!row || row.status !== "prepared") return Effect.void
            return db
              .update(SnapshotMutationTable)
              .set({ status: "failed", error: message, time_updated: Date.now() })
              .where(eq(SnapshotMutationTable.id, input.id))
              .run()
              .pipe(Effect.asVoid)
          }),
          Effect.catch(() => Effect.void),
          Effect.catchDefect(() => Effect.void),
        )

      const rollback = (cause: unknown): Effect.Effect<never, NotFound | Conflict | DbError | ApplyError> =>
        Effect.gen(function* () {
          const original = cause instanceof Error ? cause.message : String(cause)
          // CAS target is the real after landing spot. Single-row move is
          // legacy: new tools model move as delete+add/update, so a lone move
          // row never attempts filesystem repair here.
          if (seen.op === "move") {
            log.warn("journal apply rollback refused: legacy single-row move", { id: seen.id, path: seen.path })
            yield* markFailed(original)
            return yield* new ApplyError({ message: `journal apply failed: ${original}`, id: seen.id, recovered: false })
          }
          const abs = path.join(seen.worktree, seen.path)
          const current = yield* rawOf(abs)
          const match = input.after === null ? current === undefined : current !== undefined && digest(current) === afterHash
          let recovered = false
          if (!match) {
            log.warn("journal apply rollback refused: disk changed", { id: seen.id, path: seen.path })
          } else if (seen.op === "add" && !seen.before_blob && !persisted) {
            // Only add-without-before may delete the after image.
            recovered = yield* fs
              .remove(abs)
              .pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false)))
          } else if (persisted) {
            recovered = yield* fs
              .writeFile(abs, persisted)
              .pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false)))
          } else {
            // update/delete (or add-with-prior) without its persisted before
            // blob must never delete: honest failed fact, no filesystem touch.
            log.warn("journal apply rollback refused: before blob missing", { id: seen.id, path: seen.path, op: seen.op })
          }
          yield* markFailed(original)
          return yield* new ApplyError({ message: `journal apply failed: ${original}`, id: seen.id, recovered })
        })

      return yield* db.transaction((tx) => commit(asStore(tx)), { behavior: "immediate" }).pipe(
        Effect.catch((err) => {
          if (err instanceof Conflict || err instanceof NotFound) return Effect.fail(err)
          if (uniqueViolation(err)) return Effect.fail(dbFail("apply", err))
          return rollback(err)
        }),
        Effect.catchDefect((def) => rollback(def)),
      )
    })

    const fail: Interface["fail"] = Effect.fn("SnapshotJournal.fail")(function* (input: FailInput) {
      const now = Date.now()
      const settle = (store: Store): Effect.Effect<Row, NotFound | Conflict | unknown> =>
        Effect.gen(function* () {
          const row = yield* readRow(store, input.id)
          if (!row) return yield* new NotFound({ message: `journal mutation not found: ${input.id}`, id: input.id })
          if (row.status === "failed") return row
          if (row.status === "applied")
            return yield* new Conflict({ message: "journal fail of applied mutation", id: row.id, status: row.status })
          const updated = (yield* store
            .update(SnapshotMutationTable)
            .set({ status: "failed", error: input.error, time_updated: now })
            .where(eq(SnapshotMutationTable.id, input.id))
            .returning()) as unknown as Row[]
          return updated[0]!
        })
      return yield* db
        .transaction((tx) => settle(asStore(tx)), { behavior: "immediate" })
        .pipe(
          Effect.catch(
            (err): Effect.Effect<Row, NotFound | Conflict | DbError> =>
              err instanceof NotFound || err instanceof Conflict ? Effect.fail(err) : Effect.fail(dbFail("fail", err)),
          ),
          Effect.catchDefect(
            (def): Effect.Effect<Row, NotFound | Conflict | DbError> => Effect.fail(dbFail("fail", def)),
          ),
        )
    })

    const get: Interface["get"] = (id: string) =>
      readRow(db, id).pipe(
        Effect.catch((cause) => Effect.fail(dbFail("get", cause))),
        Effect.catchDefect((def) => Effect.fail(dbFail("get", def))),
      )

    const list: Interface["list"] = Effect.fn("SnapshotJournal.list")(function* (filter: Filter) {
      const conds = [
        filter.sessionID ? eq(SnapshotMutationTable.session_id, filter.sessionID) : undefined,
        filter.messageID ? eq(SnapshotMutationTable.message_id, filter.messageID) : undefined,
        filter.callID !== undefined ? eq(SnapshotMutationTable.call_id, filter.callID) : undefined,
        filter.status ? eq(SnapshotMutationTable.status, filter.status) : undefined,
        filter.path ? eq(SnapshotMutationTable.path, filter.path) : undefined,
      ].filter((item): item is NonNullable<typeof item> => item !== undefined)
      const rows = (yield* (conds.length
        ? db.select().from(SnapshotMutationTable).where(and(...conds)).all()
        : db.select().from(SnapshotMutationTable).all()
      ).pipe(
        Effect.catch((cause) => Effect.fail(dbFail("list", cause))),
        Effect.catchDefect((def) => Effect.fail(dbFail("list", def))),
      )) as unknown as Row[]
      return [...rows].sort(
        (a, b) =>
          a.time_created - b.time_created ||
          a.item_index - b.item_index ||
          (a.sub_index ?? 0) - (b.sub_index ?? 0) ||
          a.path.localeCompare(b.path) ||
          a.id.localeCompare(b.id),
      )
    })

    const readBlob: Interface["readBlob"] = (sha256: string) =>
      readBytes(db, sha256).pipe(
        Effect.map((hit) => (hit ? Buffer.from(hit.bytes) : undefined)),
        Effect.catch((cause) => Effect.fail(dbFail("readBlob", cause))),
        Effect.catchDefect((def) => Effect.fail(dbFail("readBlob", def))),
      )

    // Single-transaction, single-SQL gc: delete exactly the blobs with no
    // current mutation reference. All statuses (prepared/applied/failed) are
    // recovery facts, so every referenced blob is retained; nothing is
    // auto-deleted beyond the unreferenced set.
    const gc: Interface["gc"] = Effect.fn("SnapshotJournal.gc")(function* () {
      const deleted = (yield* db
        .transaction(
          (tx) =>
            asStore(tx)
              .delete(SnapshotBlobTable)
              .where(
                sql`${SnapshotBlobTable.sha256} NOT IN (SELECT ${SnapshotMutationTable.before_blob} FROM ${SnapshotMutationTable} WHERE ${SnapshotMutationTable.before_blob} IS NOT NULL UNION SELECT ${SnapshotMutationTable.after_blob} FROM ${SnapshotMutationTable} WHERE ${SnapshotMutationTable.after_blob} IS NOT NULL)`,
              )
              .returning({ sha256: SnapshotBlobTable.sha256 }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.catch((cause) => Effect.fail(dbFail("gc", cause))),
          Effect.catchDefect((def) => Effect.fail(dbFail("gc", def))),
        )) as unknown as { sha256: string }[]
      return deleted.length
    })

    return Service.of({ prepare, apply, fail, get, list, readBlob, gc })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Database.defaultLayer))

export * as SnapshotJournal from "./journal"
