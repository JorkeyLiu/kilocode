import { Effect, Schema } from "effect"
import { sql, eq, inArray } from "drizzle-orm"
import { Database } from "../database/database"
import { SessionTable, SessionDeleteTombstoneTable } from "../session/sql"
import { RetentionObligationTable } from "./sql"
import { EventSequenceTable, EventTable } from "../event/sql"
import * as Artifact from "./artifact"
import * as Changefeed from "./changefeed"
import { ID as SessionID } from "../session/schema"

export const HIGH_BYTES = 8 * 1024 * 1024 * 1024
export const LOW_BYTES = 6 * 1024 * 1024 * 1024
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
export const INCREMENTAL_VACUUM_PAGES = 100

export type Diagnostics = {
  readonly trigger: string
  readonly beforeBytes: number
  readonly afterBytes: number
  readonly selected: number
  readonly deleted: number
  readonly skipped: number
  readonly skipReasons: Record<string, number>
  readonly rowsReclaimed: number
  readonly artifactBytesReclaimed: number
  readonly checkpoint: string
  readonly vacuum: string
  readonly failures: string[]
}

type Family = {
  readonly rootID: string
  readonly sessionIDs: string[]
  readonly activity: number
}

function toSessionIDs(ids: string[]): SessionID[] {
  return ids.map((id) => Schema.decodeSync(SessionID)(id))
}

function sessionIdInArray(ids: string[]) {
  const branded = toSessionIDs(ids)
  return inArray(SessionTable.id, branded)
}

export function familyQuery(db: Database.Interface["db"], rootID: string) {
  return Effect.gen(function* () {
    const rows = yield* db
      .all<{
        id: string
      }>(
        sql`WITH RECURSIVE family(id) AS (SELECT id FROM ${SessionTable} WHERE id = ${rootID} UNION ALL SELECT s.id FROM ${SessionTable} s JOIN family f ON s.parent_id = f.id) SELECT id FROM family`,
      )
      .pipe(Effect.orDie)
    return rows.map((r) => r.id)
  })
}

export function allRootFamilies(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ id: SessionTable.id, time: SessionTable.time_updated })
      .from(SessionTable)
      .where(sql`${SessionTable.parent_id} IS NULL`)
      .all()
      .pipe(Effect.orDie)
    return rows
  })
}

export function familyActivity(db: Database.Interface["db"], sessionIDs: string[]) {
  return Effect.gen(function* () {
    if (sessionIDs.length === 0) return 0
    const rows = yield* db
      .select({ t: SessionTable.time_updated })
      .from(SessionTable)
      .where(sessionIdInArray(sessionIDs))
      .all()
      .pipe(Effect.orDie)
    let max = 0
    for (const row of rows) if (row.t > max) max = row.t
    return max
  })
}

export function listFamilies(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const roots = yield* allRootFamilies(db)
    const out: Family[] = []
    for (const root of roots) {
      const ids = yield* familyQuery(db, root.id as string)
      const act = yield* familyActivity(db, ids)
      out.push({ rootID: root.id as string, sessionIDs: ids, activity: act })
    }
    return out
  })
}

export function eligibleFamilies(
  db: Database.Interface["db"],
  now: number,
  isActive: (id: string) => boolean,
  isLeased: (id: string) => boolean,
) {
  return Effect.gen(function* () {
    const families = yield* listFamilies(db)
    const cutoff = now - SEVEN_DAYS_MS
    const eligible: Family[] = []
    const skipped: { family: Family; reason: string }[] = []
    for (const fam of families) {
      if (fam.activity > cutoff) {
        skipped.push({ family: fam, reason: "within-7days" })
        continue
      }
      let blocked = false
      for (const id of fam.sessionIDs) {
        if (isActive(id) || isLeased(id)) {
          skipped.push({ family: fam, reason: isActive(id) ? "active" : "leased" })
          blocked = true
          break
        }
      }
      if (blocked) continue
      eligible.push(fam)
    }
    eligible.sort((a, b) => (a.activity === b.activity ? a.rootID.localeCompare(b.rootID) : a.activity - b.activity))
    return { eligible, skipped }
  })
}

type Tx = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

function deleteFamilyCanonicalTx(tx: Tx, rootID: string, now: number) {
  return Effect.gen(function* () {
    const raw = yield* tx
      .all<{
        id: string
      }>(
        sql`WITH RECURSIVE family(id) AS (SELECT id FROM ${SessionTable} WHERE id = ${rootID} UNION ALL SELECT s.id FROM ${SessionTable} s JOIN family f ON s.parent_id = f.id) SELECT id FROM family`,
      )
      .pipe(Effect.orDie)
    const actualIds = raw.map((r) => r.id)
    if (actualIds.length === 0) return actualIds
    const rows = yield* tx
      .select({ id: SessionTable.id, time: SessionTable.time_updated, rev: SessionTable.revision })
      .from(SessionTable)
      .where(sessionIdInArray(actualIds))
      .all()
      .pipe(Effect.orDie)
    if (rows.length !== actualIds.length) yield* Effect.die(`family row count mismatch ${rootID}`)
    for (const row of rows) {
      const finalRev = row.rev + 1
      yield* Changefeed.appendTx(tx, { session_id: row.id as string, revision: finalRev, kind: "deleted", time: now })
    }
    // Include Event/EventSequence removal in the same BEGIN IMMEDIATE transaction
    yield* tx.delete(EventTable).where(inArray(EventTable.aggregate_id, actualIds)).run().pipe(Effect.orDie)
    yield* tx
      .delete(EventSequenceTable)
      .where(inArray(EventSequenceTable.aggregate_id, actualIds))
      .run()
      .pipe(Effect.orDie)
    yield* tx
      .insert(RetentionObligationTable)
      .values({ family_root_id: rootID, session_ids: actualIds, time_created: now })
      .run()
      .pipe(Effect.orDie)
    yield* tx.delete(SessionTable).where(sessionIdInArray(actualIds)).run().pipe(Effect.orDie)
    return actualIds
  })
}

export function deleteFamilyUnprotected(db: Database.Interface["db"], rootID: string, now: number) {
  return db.transaction((tx) => deleteFamilyCanonicalTx(tx, rootID, now), { behavior: "immediate" })
}

export function deleteFamilyWithDeleteTombstoneUnprotected(
  db: Database.Interface["db"],
  rootID: string,
  now: number,
  tombstone: {
    opId: string
    sessionId: string
    hash: string
    requestId: string
    directory: string
    parentSessionId: string | null
    configVersion: number | null
    sessionRevision: number | null
    time: number
    code: string
    message: string
  },
) {
  return db.transaction((tx) => deleteFamilyWithDeleteTombstoneTx(tx, rootID, now, tombstone), {
    behavior: "immediate",
  })
}

function deleteFamilyWithDeleteTombstoneTx(
  tx: Tx,
  rootID: string,
  now: number,
  tombstone: {
    opId: string
    sessionId: string
    hash: string
    requestId: string
    directory: string
    parentSessionId: string | null
    configVersion: number | null
    sessionRevision: number | null
    time: number
    code: string
    message: string
  },
) {
  return Effect.gen(function* () {
    const raw = yield* tx
      .all<{
        id: string
      }>(
        sql`WITH RECURSIVE family(id) AS (SELECT id FROM ${SessionTable} WHERE id = ${rootID} UNION ALL SELECT s.id FROM ${SessionTable} s JOIN family f ON s.parent_id = f.id) SELECT id FROM family`,
      )
      .pipe(Effect.orDie)
    const actualIds = raw.map((r) => r.id)
    if (actualIds.length === 0) yield* Effect.die(new Error(`family not found ${rootID}`))
    const rows = yield* tx
      .select({ id: SessionTable.id, time: SessionTable.time_updated, rev: SessionTable.revision })
      .from(SessionTable)
      .where(sessionIdInArray(actualIds))
      .all()
      .pipe(Effect.orDie)
    if (rows.length !== actualIds.length) yield* Effect.die(`family row count mismatch ${rootID}`)
    const changefeedEntries: Changefeed.Entry[] = []
    for (const row of rows) {
      const finalRev = row.rev + 1
      const entry = yield* Changefeed.appendTx(tx, { session_id: row.id as string, revision: finalRev, kind: "deleted", time: now })
      changefeedEntries.push(entry)
    }
    // Include Event/EventSequence removal atomically before canonical commit checks
    yield* tx.delete(EventTable).where(inArray(EventTable.aggregate_id, actualIds)).run().pipe(Effect.orDie)
    yield* tx
      .delete(EventSequenceTable)
      .where(inArray(EventSequenceTable.aggregate_id, actualIds))
      .run()
      .pipe(Effect.orDie)
    // test-only seam: fail inside canonical delete transaction before commit (after event removal, to prove rollback)
    if (
      (globalThis as unknown as { __dispatchAtomicSeam?: { failDeleteInsideTx?: boolean } }).__dispatchAtomicSeam
        ?.failDeleteInsideTx
    )
      yield* Effect.die(new Error("injected delete tx failure"))
    yield* tx
      .insert(RetentionObligationTable)
      .values({ family_root_id: rootID, session_ids: actualIds, time_created: now })
      .run()
      .pipe(Effect.orDie)
    yield* tx
      .insert(SessionDeleteTombstoneTable)
      .values({
        op_id: tombstone.opId,
        session_id: tombstone.sessionId,
        idempotency_hash: tombstone.hash,
        request_id: tombstone.requestId,
        directory: tombstone.directory,
        parent_session_id: tombstone.parentSessionId,
        config_version: tombstone.configVersion,
        session_revision: tombstone.sessionRevision,
        time: tombstone.time,
        code: tombstone.code,
        message: tombstone.message,
        outcome: "succeeded",
      } as unknown as typeof SessionDeleteTombstoneTable.$inferInsert)
      .run()
      .pipe(Effect.orDie)
    yield* tx.delete(SessionTable).where(sessionIdInArray(actualIds)).run().pipe(Effect.orDie)
    return { ids: actualIds, entries: changefeedEntries }
  })
}

export function deleteFamilyTransaction(
  db: Database.Interface["db"],
  family: Family,
  now: number,
  isActive: (id: string) => boolean,
  isLeased: (id: string) => boolean,
) {
  return db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const raw = yield* tx
          .all<{
            id: string
          }>(
            sql`WITH RECURSIVE family(id) AS (SELECT id FROM ${SessionTable} WHERE id = ${family.rootID} UNION ALL SELECT s.id FROM ${SessionTable} s JOIN family f ON s.parent_id = f.id) SELECT id FROM family`,
          )
          .pipe(Effect.orDie)
        const actualIds = raw.map((r) => r.id)
        if (actualIds.length === 0) yield* Effect.die(`family not found ${family.rootID}`)
        const rows = yield* tx
          .select({ id: SessionTable.id, time: SessionTable.time_updated, rev: SessionTable.revision })
          .from(SessionTable)
          .where(sessionIdInArray(actualIds))
          .all()
          .pipe(Effect.orDie)
        if (rows.length !== actualIds.length) yield* Effect.die(`family row count mismatch ${family.rootID}`)
        let maxAct = 0
        for (const r of rows) if (r.time > maxAct) maxAct = r.time
        if (maxAct > now - SEVEN_DAYS_MS) yield* Effect.die(`family within 7days ${family.rootID}`)
        for (const id of actualIds) {
          if (isActive(id) || isLeased(id)) yield* Effect.die(`family now active/leased ${family.rootID} ${id}`)
        }
        for (const row of rows) {
          const finalRev = row.rev + 1
          yield* Changefeed.appendTx(tx, {
            session_id: row.id as string,
            revision: finalRev,
            kind: "deleted",
            time: now,
          })
        }
        yield* tx.delete(EventTable).where(inArray(EventTable.aggregate_id, actualIds)).run().pipe(Effect.orDie)
        yield* tx
          .delete(EventSequenceTable)
          .where(inArray(EventSequenceTable.aggregate_id, actualIds))
          .run()
          .pipe(Effect.orDie)
        yield* tx
          .insert(RetentionObligationTable)
          .values({ family_root_id: family.rootID, session_ids: actualIds, time_created: now })
          .run()
          .pipe(Effect.orDie)
        yield* tx.delete(SessionTable).where(sessionIdInArray(actualIds)).run().pipe(Effect.orDie)
      }),
    { behavior: "immediate" },
  )
}

function decodeSessionIds(value: unknown): { ids: string[] | null; malformed: string | null } {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === "string")) {
        return { ids: parsed, malformed: null }
      }
      return { ids: null, malformed: "session_ids not string array" }
    } catch (e) {
      return { ids: null, malformed: String(e) }
    }
  }
  if (Array.isArray(value)) {
    if (value.every((v): v is string => typeof v === "string")) {
      return { ids: value as string[], malformed: null }
    }
    return { ids: null, malformed: "session_ids array contains non-string" }
  }
  return { ids: null, malformed: `session_ids type ${typeof value}` }
}

export function replayObligations(
  db: Database.Interface["db"],
  deleter: (keys: string[][]) => Effect.Effect<void, unknown, never>,
) {
  return Effect.gen(function* () {
    const rows = yield* db
      .all<{
        id: number
        family_root_id: string
        session_ids: unknown
        time_created: number
        attempts: number
      }>(sql`SELECT id, family_root_id, session_ids, time_created, attempts FROM retention_obligation`)
      .pipe(Effect.orDie)
    for (const row of rows) {
      const raw: unknown = row.session_ids
      const { ids, malformed } = decodeSessionIds(raw)
      if (malformed !== null || ids === null) {
        const reason = malformed ?? "malformed obligation"
        yield* Effect.logWarning(`replayObligations malformed ${row.id}: ${reason}`)
        yield* db
          .run(sql`UPDATE retention_obligation SET attempts = attempts + 1 WHERE id = ${row.id}`)
          .pipe(Effect.orDie)
        continue
      }
      const keys = Artifact.familyArtifactsForFamily(ids)
      const exit = yield* deleter(keys).pipe(Effect.exit)
      if (exit._tag === "Failure") {
        yield* Effect.logWarning(`replayObligations deleter failed ${row.id}`, { cause: String(exit.cause) })
        yield* db
          .run(sql`UPDATE retention_obligation SET attempts = attempts + 1 WHERE id = ${row.id}`)
          .pipe(Effect.orDie)
        continue
      }
      yield* db.delete(RetentionObligationTable).where(eq(RetentionObligationTable.id, row.id)).run().pipe(Effect.orDie)
    }
  })
}

export type ReplayResult = {
  readonly succeeded: number
  readonly failed: number
  readonly malformed: number
}

export function physicalBytes(opts: {
  dbPath: string
  walPath: string
  artifactBytes: number
  stat: (p: string) => number
}): number {
  const main = opts.stat(opts.dbPath)
  const wal = opts.stat(opts.walPath)
  return main + wal + opts.artifactBytes
}

export function artifactBytesForFamily(sessionIDs: string[], sizeOf: (key: string[]) => number): number {
  let sum = 0
  for (const id of sessionIDs)
    for (const kind of Artifact.familyKinds()) sum += sizeOf([...Artifact.familyPrefix(kind), id])
  return sum
}
