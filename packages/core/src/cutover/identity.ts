import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "../database/database"

export const SCHEMA_VERSION = "1"

export type Identity = {
  uuid: string
  schema_version: string
  created_at: number
  cutover_archive_id: string
}

export function createIdentity(db: Database.Interface["db"], archiveID: string, now: number = Date.now()) {
  return Effect.gen(function* () {
    const id: Identity = {
      uuid: randomUUID(),
      schema_version: SCHEMA_VERSION,
      created_at: now,
      cutover_archive_id: archiveID,
    }
    yield* db.run(sql`INSERT INTO storage_identity (id, uuid, schema_version, created_at, cutover_archive_id) VALUES (1, ${id.uuid}, ${id.schema_version}, ${id.created_at}, ${id.cutover_archive_id})`).pipe(Effect.orDie)
    return id
  })
}

export function readIdentity(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const row = yield* db
      .get<{ uuid: string; schema_version: string; created_at: number; cutover_archive_id: string }>(
        sql`SELECT uuid, schema_version, created_at, cutover_archive_id FROM storage_identity WHERE id = 1`,
      )
      .pipe(Effect.orDie)
    if (!row) return undefined as Identity | undefined
    return row as Identity
  })
}

export function verifyGate(db: Database.Interface["db"], dataRoot: string, expectedArchiveID?: string) {
  return Effect.gen(function* () {
    const id = yield* readIdentity(db)
    if (!id) yield* Effect.fail(new Error(`storage identity missing`))
    const v = id as Identity
    if (!isUUID(v.uuid)) yield* Effect.fail(new Error(`invalid storage uuid`))
    if (v.schema_version !== SCHEMA_VERSION) yield* Effect.fail(new Error(`schema version mismatch`))
    if (!v.cutover_archive_id) yield* Effect.fail(new Error(`cutover archive id missing`))
    if (!isValidArchiveID(v.cutover_archive_id)) yield* Effect.fail(new Error(`invalid cutover archive id`))
    if (expectedArchiveID && v.cutover_archive_id !== expectedArchiveID) yield* Effect.fail(new Error(`cutover archive id mismatch`))

    // verify PRAGMA auto_vacuum=2 (incremental)
    const av = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
    const avVal = (av as any)?.auto_vacuum
    if (avVal !== 2) yield* Effect.fail(new Error(`auto_vacuum must be 2, got ${avVal}`))

    // full canonical aggregate zero-state: session + related tables + singleton state
    const zeroTables = [
      "session",
      "message",
      "part",
      "todo",
      "session_message",
      "session_input",
      "session_context_epoch",
      "session_share",
      "event",
      "event_sequence",
      "session_changefeed",
      "retention_obligation",
    ]
    for (const tbl of zeroTables) {
      const row = yield* db
        .get<{ c: number }>(sql.raw(`SELECT count(*) as c FROM "${tbl}"`))
        .pipe(
          Effect.catch((e) => {
            const msg = String((e as any)?.message ?? e)
            if (msg.includes("no such table") && (tbl === "event" || tbl === "event_sequence")) {
              return Effect.succeed({ c: 0 } as { c: number })
            }
            return Effect.fail(e as unknown as Error)
          }),
          Effect.orDie,
        )
      const c = (row as any)?.c
      if (c !== 0) yield* Effect.fail(new Error(`fresh DB must have zero ${tbl}, got ${c}`))
    }
    // singleton state tables that must be initialized for fresh canonical DB
    const scsRow = yield* db
      .get<{ c: number }>(sql.raw(`SELECT count(*) as c FROM "session_changefeed_state"`))
      .pipe(Effect.orDie)
    if ((scsRow as any)?.c !== 1) yield* Effect.fail(new Error(`fresh DB session_changefeed_state must have 1 row, got ${(scsRow as any)?.c}`))
    const scs = yield* db
      .get<{ latest_seq: number; retained_rows: number; retained_bytes: number }>(
        sql`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`,
      )
      .pipe(Effect.orDie)
    if (!scs) yield* Effect.fail(new Error(`session_changefeed_state missing id 1`))
    if ((scs as any).retained_rows !== 0 || (scs as any).retained_bytes !== 0)
      yield* Effect.fail(new Error(`fresh DB session_changefeed_state retained not zero`))
    // additional singleton: storage_identity already validated above, but also ensure count 1
    const identCount = yield* db.get<{ c: number }>(sql.raw(`SELECT count(*) as c FROM "storage_identity"`)).pipe(Effect.orDie)
    if ((identCount as any)?.c !== 1) yield* Effect.fail(new Error(`storage_identity must have 1 row`))

    const kinds = ["session_diff", "session_diff_base", "session_share"]
    for (const k of kinds) {
      const dir = path.join(dataRoot, "storage", k)
      const entries = yield* Effect.promise(() => fs.readdir(dir)).pipe(
        Effect.catch((e: any) => {
          if (e?.code === "ENOENT") return Effect.succeed([] as string[])
          return Effect.fail(e)
        }),
      )
      if (entries.length !== 0) yield* Effect.fail(new Error(`family artifact not empty ${k}: ${entries.length} entries`))
    }
    return v
  })
}

function isValidArchiveID(id: string): boolean {
  return /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function isUUID(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}
