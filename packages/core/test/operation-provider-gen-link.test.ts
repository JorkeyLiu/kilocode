import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"

function stack(file: string) {
  const database = Database.layerNoLease(file)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projects = Layer.succeed(
    Project.Service,
    Project.Service.of({
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions)
}

async function freshFile(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "op-gen-link-"))
  return { dir, file: join(dir, "kilo.db") }
}

function withStack<A>(
  file: string,
  fn: (env: { db: Database.Interface["db"]; svc: any }) => Effect.Effect<A, unknown, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(stack(file))
        const db = Context.get(ctx, Database.Service).db
        const svc = Context.get(ctx, SessionV2.Service) as any
        return yield* fn({ db, svc })
      }),
    ) as Effect.Effect<A>,
  )
}

const setupProject = (db: Database.Interface["db"]) =>
  db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)

const opRow = (db: Database.Interface["db"], opId: string) =>
  db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)

const runExit = <A>(self: Effect.Effect<A, unknown, unknown>) => Effect.exit(self) as Effect.Effect<Exit.Exit<A, unknown>>

describe("provider generation link", () => {
  test("migration adds nullable gen_id with index idempotently", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const cols = (yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie)) as { name: string }[]
          expect(cols.some((c) => c.name === "gen_id")).toBe(true)
          const idx = (yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND name='session_operation_gen_id_idx'`).pipe(Effect.orDie)) as { name: string }[]
          expect(idx.length).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("strict insert links atomically, terminal preserves, idempotent replays", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const promptOp = SessionOperation.promptId("msg_link")
          yield* SessionOperation.ensurePromptInFlight(db, sid, promptOp)
          const gen = "genlink1"
          const begun = yield* SessionGeneration.begin(db, sid, gen, "msg_link", 2)
          expect(begun).toEqual({ created: true, added: promptOp })
          const provOp = SessionOperation.providerId("msg_link_assist", 0)
          const rec = yield* SessionOperation.putProviderInFlight(db, sid, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider request started",
            time: Date.now(),
          }, gen)
          expect(rec.opId).toBe(provOp)
          const got = yield* SessionOperation.getProviderGen(db, provOp)
          expect(got).toBe(gen)
          const row = (yield* opRow(db, provOp)) as unknown as Record<string, unknown>
          expect(row["gen_id"]).toBe(gen)
          // FailureRecord stays 9 fields, no result_snapshot pollution
          expect(Object.keys(rec).sort()).toEqual(["code", "message", "opId", "opKind", "outcome", "time"].sort())
          expect(row["result_snapshot"]).toBeNull()
          // terminal preserves linkage
          const term = yield* SessionOperation.put(db, sid, {
            opId: provOp,
            opKind: "provider",
            outcome: "succeeded",
            code: "provider.succeeded",
            message: "ok",
            time: Date.now(),
          })
          expect(term.outcome).toBe("succeeded")
          expect(yield* SessionOperation.getProviderGen(db, provOp)).toBe(gen)
          // idempotent terminal replay preserves
          const dup = yield* SessionOperation.put(db, sid, term)
          expect(dup).toEqual(term)
          expect(yield* SessionOperation.getProviderGen(db, provOp)).toBe(gen)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("strict missing/closed/cross-identity fails closed, legacy without link works", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const s2 = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid2 = s2.id as never
          // legacy plain insert without link still works
          const legacyOp = SessionOperation.providerId("legacy_assist", 0)
          yield* SessionOperation.put(db, sid, {
            opId: legacyOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "legacy",
            time: Date.now(),
          })
          expect(yield* SessionOperation.getProviderGen(db, legacyOp)).toBeNull()
          // missing owner fails closed
          const miss = yield* runExit(SessionOperation.putProviderInFlight(db, sid, {
            opId: SessionOperation.providerId("miss_assist", 0),
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "x",
            time: Date.now(),
          }, "nogensuch"))
          expect(miss._tag).toBe("Failure")
          // cross-session gen fails closed
          const promptOp = SessionOperation.promptId("msg_cross")
          yield* SessionOperation.ensurePromptInFlight(db, sid, promptOp)
          yield* SessionGeneration.begin(db, sid, "gencross", "msg_cross", 2)
          const cross = yield* runExit(SessionOperation.putProviderInFlight(db, sid2, {
            opId: SessionOperation.providerId("cross_assist", 0),
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "x",
            time: Date.now(),
          }, "gencross"))
          expect(cross._tag).toBe("Failure")
          // closed owner fails closed
          yield* SessionGeneration.close(db, sid, "gencross", "completed")
          const closed = yield* runExit(SessionOperation.putProviderInFlight(db, sid, {
            opId: SessionOperation.providerId("closed_assist", 0),
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "x",
            time: Date.now(),
          }, "gencross"))
          expect(closed._tag).toBe("Failure")
          // invalid gen shape fails closed
          const bad = yield* runExit(SessionOperation.putProviderInFlight(db, sid, {
            opId: SessionOperation.providerId("bad_assist", 0),
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "x",
            time: Date.now(),
          }, "bad:gen"))
          expect(bad._tag).toBe("Failure")
          // cross-generation conflict on same opId fails
          const prompt2 = SessionOperation.promptId("msg_conf")
          yield* SessionOperation.ensurePromptInFlight(db, sid, prompt2)
          yield* SessionGeneration.begin(db, sid, "genconf", "msg_conf", 2)
          const opConf = SessionOperation.providerId("conf_assist", 0)
          yield* SessionOperation.putProviderInFlight(db, sid, {
            opId: opConf,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "x",
            time: Date.now(),
          }, "genconf")
          const prompt3 = SessionOperation.promptId("msg_conf2")
          yield* SessionOperation.ensurePromptInFlight(db, sid, prompt3)
          yield* SessionGeneration.begin(db, sid, "genconf2", "msg_conf2", 2)
          const conf = yield* runExit(SessionOperation.putProviderInFlight(db, sid, {
            opId: opConf,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "x",
            time: Date.now(),
          }, "genconf2"))
          expect(conf._tag).toBe("Failure")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("crash sweep preserves link, old null rows keep existing behavior", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const promptOp = SessionOperation.promptId("msg_crash_link")
          yield* SessionOperation.ensurePromptInFlight(db, sid, promptOp)
          yield* SessionGeneration.begin(db, sid, "gencrash", "msg_crash_link", 2)
          const linkedOp = SessionOperation.providerId("crash_assist", 0)
          yield* SessionOperation.putProviderInFlight(db, sid, {
            opId: linkedOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "linked",
            time: Date.now(),
          }, "gencrash")
          const nullOp = SessionOperation.providerId("null_assist", 0)
          yield* SessionOperation.put(db, sid, {
            opId: nullOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "legacy null",
            time: Date.now(),
          })
          return { sid: s.id as string, linkedOp, nullOp }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const summary = yield* SessionOperation.convergeOrphanedInFlight(db)
          expect(summary.converged.sort()).toEqual([SessionOperation.promptId("msg_crash_link"), ids.linkedOp, ids.nullOp].sort())
          expect(yield* SessionOperation.getProviderGen(db, ids.linkedOp)).toBe("gencrash")
          expect(yield* SessionOperation.getProviderGen(db, ids.nullOp)).toBeNull()
          const linked = yield* SessionOperation.get(db, ids.linkedOp)
          expect(linked?.outcome).toBe("abandoned")
          expect(linked?.code).toBe(SessionOperation.PROVIDER_CRASH_CONVERGE_CODE)
          const nul = yield* SessionOperation.get(db, ids.nullOp)
          expect(nul?.outcome).toBe("abandoned")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("legacy null link never backfills, true idempotence keeps exact link", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          // Legacy null row with a fixed timestamp so the 9-field record is
          // exactly equal on replay; only the link differs.
          const nullOp = SessionOperation.providerId("nulllink_assist", 0)
          const at = Date.now()
          yield* SessionOperation.put(db, sid, {
            opId: nullOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "legacy null",
            time: at,
          })
          expect(yield* SessionOperation.getProviderGen(db, nullOp)).toBeNull()
          // A strict owner for the new link exists, so the only reason to
          // fail is the legacy null vs new link mismatch itself.
          const promptOp = SessionOperation.promptId("msg_nulllink")
          yield* SessionOperation.ensurePromptInFlight(db, sid, promptOp)
          yield* SessionGeneration.begin(db, sid, "gennulllink", "msg_nulllink", 2)
          const backfill = yield* runExit(SessionOperation.putProviderInFlight(db, sid, {
            opId: nullOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "legacy null",
            time: at,
          }, "gennulllink"))
          expect(backfill._tag).toBe("Failure")
          // No link fabricated on the legacy row.
          expect(yield* SessionOperation.getProviderGen(db, nullOp)).toBeNull()
          // True idempotence: exact record + exact link replays cleanly.
          const promptOk = SessionOperation.promptId("msg_idem_link")
          yield* SessionOperation.ensurePromptInFlight(db, sid, promptOk)
          yield* SessionGeneration.begin(db, sid, "genidem", "msg_idem_link", 2)
          const linkedOp = SessionOperation.providerId("idem_assist", 0)
          const at2 = Date.now()
          const first = yield* SessionOperation.putProviderInFlight(db, sid, {
            opId: linkedOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "linked",
            time: at2,
          }, "genidem")
          expect(first.opId).toBe(linkedOp)
          const replay = yield* SessionOperation.putProviderInFlight(db, sid, {
            opId: linkedOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "linked",
            time: at2,
          }, "genidem")
          expect(replay.opId).toBe(linkedOp)
          expect(yield* SessionOperation.getProviderGen(db, linkedOp)).toBe("genidem")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("existing db upgrades via real migration: old row kept null link, partial index, idempotent", async () => {
    const { dir, file } = await freshFile()
    const oldOp = SessionOperation.providerId("upgradeoldassist", 0)
    const ownerGen = "genpreupgrade"
    const ownerMsg = "msg_pre_upgrade"
    let sid = ""
    try {
      // Phase 1: the real fresh chain writes a legacy row plus an open owner,
      // then only the pre-migration state is simulated (drop column/index and
      // the new journal row — no product migration logic is copied).
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          sid = s.id as string
          const sub = sid as never
          yield* SessionOperation.put(db, sub, {
            opId: oldOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "legacy pre-upgrade",
            time: 1700000000000,
          })
          yield* SessionOperation.ensurePromptInFlight(db, sub, SessionOperation.promptId(ownerMsg))
          yield* SessionGeneration.begin(db, sub, ownerGen, ownerMsg, 2)
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_operation_gen_id_idx"`).pipe(Effect.orDie)
          yield* (db as any).run(sql`ALTER TABLE "session_operation" DROP COLUMN "gen_id"`).pipe(Effect.orDie)
          yield* (db as any).run(sql`DELETE FROM "migration" WHERE id = '20260926000000_add_provider_gen_link'`).pipe(Effect.orDie)
          const preCols = (yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie)) as { name: string }[]
          expect(preCols.some((c) => c.name === "gen_id")).toBe(false)
          const preIdx = (yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND name='session_operation_gen_id_idx'`).pipe(Effect.orDie)) as { name: string }[]
          expect(preIdx.length).toBe(0)
          const preJournal = (yield* (db as any).all(sql`SELECT id FROM "migration" WHERE id = '20260926000000_add_provider_gen_link'`).pipe(Effect.orDie)) as { id: string }[]
          expect(preJournal.length).toBe(0)
          const preRow = (yield* (db as any).get(sql`SELECT op_id, code FROM session_operation WHERE op_id = ${oldOp}`).pipe(Effect.orDie)) as { op_id: string; code: string }
          expect(preRow.op_id).toBe(oldOp)
          expect(preRow.code).toBe("provider.inflight")
          // Pre-migration strict write fails closed instead of dropping the link.
          const pre = yield* runExit(SessionOperation.putProviderInFlight(db, sub, {
            opId: SessionOperation.providerId("prestrictassist", 0),
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "x",
            time: Date.now(),
          }, ownerGen))
          expect(pre._tag).toBe("Failure")
        }),
      )
      // Phase 2: reopening via Database.layerNoLease runs the real migration.up.
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const sub = sid as never
          const cols = (yield* (db as any).all(sql`SELECT name, "notnull" FROM pragma_table_info('session_operation')`).pipe(Effect.orDie)) as { name: string; notnull: number }[]
          const gen = cols.find((c) => c.name === "gen_id")
          expect(gen).toBeDefined()
          expect(gen?.notnull).toBe(0)
          const idxSql = (yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='index' AND name='session_operation_gen_id_idx'`).pipe(Effect.orDie)) as { sql: string } | undefined
          expect(idxSql?.sql).toContain('"gen_id" IS NOT NULL')
          const journal = (yield* (db as any).all(sql`SELECT id FROM "migration" WHERE id = '20260926000000_add_provider_gen_link'`).pipe(Effect.orDie)) as { id: string }[]
          expect(journal.length).toBe(1)
          const row = (yield* (db as any).get(sql`SELECT op_id, outcome, code, message, gen_id FROM session_operation WHERE op_id = ${oldOp}`).pipe(Effect.orDie)) as { op_id: string; outcome: string; code: string; message: string; gen_id: string | null }
          expect(row.op_id).toBe(oldOp)
          expect(row.outcome).toBe("in-flight")
          expect(row.code).toBe("provider.inflight")
          expect(row.message).toBe("legacy pre-upgrade")
          expect(row.gen_id).toBeNull()
          expect(yield* SessionOperation.getProviderGen(db, oldOp)).toBeNull()
          const rec = yield* SessionOperation.get(db, oldOp)
          expect(rec?.outcome).toBe("in-flight")
          // The pre-existing owner survived, so the strict link now succeeds.
          const newOp = SessionOperation.providerId("poststrictassist", 0)
          yield* SessionOperation.putProviderInFlight(db, sub, {
            opId: newOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "linked after upgrade",
            time: Date.now(),
          }, ownerGen)
          expect(yield* SessionOperation.getProviderGen(db, newOp)).toBe(ownerGen)
        }),
      )
      // Phase 3: reopening again is idempotent.
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const journal = (yield* (db as any).all(sql`SELECT id FROM "migration" WHERE id = '20260926000000_add_provider_gen_link'`).pipe(Effect.orDie)) as { id: string }[]
          expect(journal.length).toBe(1)
          const idx = (yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND name='session_operation_gen_id_idx'`).pipe(Effect.orDie)) as { name: string }[]
          expect(idx.length).toBe(1)
          const row = (yield* (db as any).get(sql`SELECT gen_id FROM session_operation WHERE op_id = ${oldOp}`).pipe(Effect.orDie)) as { gen_id: string | null }
          expect(row.gen_id).toBeNull()
          expect(yield* SessionOperation.getProviderGen(db, oldOp)).toBeNull()
          expect(yield* SessionOperation.getProviderGen(db, SessionOperation.providerId("poststrictassist", 0))).toBe(ownerGen)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
