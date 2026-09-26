import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
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
  const dir = await mkdtemp(join(tmpdir(), "op-receipt-"))
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

const feedRows = (db: Database.Interface["db"]) =>
  db
    .select({ seq: SessionChangefeedTable.seq, kind: SessionChangefeedTable.kind })
    .from(SessionChangefeedTable)
    .all()
    .pipe(Effect.orDie)

const runExit = <A>(self: Effect.Effect<A, unknown, unknown>) => Effect.exit(self) as Effect.Effect<Exit.Exit<A, unknown>>

const revisionOf = (db: Database.Interface["db"], sid: string) =>
  db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as never)).get().pipe(Effect.orDie)

describe("operation terminal receipt", () => {
  test("prompt terminal persists member-confirmed gen + owner fact in same tx, feed shape intact", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const op = SessionOperation.promptId("msg_receipt_prompt")
          yield* SessionOperation.ensurePromptInFlight(db, sid, op)
          const gen = "genreccprompt"
          yield* SessionGeneration.begin(db, sid, gen, "msg_receipt_prompt", 2)
          const occ = Date.now()
          const charged = yield* SessionGeneration.charge(db, sid, gen, { layer: "provider", occurrenceTime: occ, nextAt: occ + 1000 })
          expect(charged.charged).toBe(true)
          const beforeFeed = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          const at = Date.now()
          const res = yield* SessionOperation.tryTransitionPromptTerminal(db, sid, SessionOperation.generationTerminal({
            opId: op, outcome: "succeeded", code: "prompt.succeeded", message: "ok", time: at,
          }))
          expect(res.applied).toBe(true)
          if (!res.applied) return
          expect(res.entry.kind).toBe("changed")
          expect(res.generationEntry?.kind).toBe("generation")
          const receipt = yield* SessionOperation.getReceipt(db, op)
          expect(receipt).toBeDefined()
          expect(receipt?.opId).toBe(op)
          expect(receipt?.sessionID).toBe(s.id as string)
          expect(receipt?.outcome).toBe("succeeded")
          expect(receipt?.time).toBe(at)
          expect(receipt?.genID).toBe(gen)
          expect(receipt?.unknown).toBeNull()
          expect(receipt?.used).toBe(1)
          expect(receipt?.limit).toBe(2)
          expect(receipt?.layer).toBe("provider")
          expect(receipt?.retryOccurrence).toBe(occ)
          expect(receipt?.nextAt).toBe(occ + 1000)
          expect(receipt?.closeReason).toBeNull()
          expect(receipt?.replay).toBe("forbidden")
          expect(Object.keys(receipt as object)).not.toContain("detail")
          expect(Object.keys(receipt as object)).not.toContain("stack")
          const afterFeed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(afterFeed.length - beforeFeed).toBe(2)
          expect(afterFeed.slice(beforeFeed).map((r) => r.kind).sort()).toEqual(["changed", "generation"])
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("provider strict terminal persists gen link with changed-only feed and no recovery", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_receipt_prov"))
          yield* SessionGeneration.begin(db, sid, "genreccprov", "msg_receipt_prov", 3)
          const op = SessionOperation.providerId("assist_receipt", 0)
          yield* SessionOperation.putProviderInFlight(db, sid, {
            opId: op, opKind: "provider", outcome: "in-flight", code: "provider.inflight", message: "started", time: Date.now(),
          }, "genreccprov")
          expect(yield* SessionOperation.getReceipt(db, op)).toBeUndefined()
          const beforeFeed = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          const at = Date.now()
          const term = yield* SessionOperation.put(db, sid, {
            opId: op, opKind: "provider", outcome: "succeeded", code: "provider.succeeded", message: "ok", time: at,
          })
          expect(term.outcome).toBe("succeeded")
          const receipt = yield* SessionOperation.getReceipt(db, op)
          expect(receipt?.genID).toBe("genreccprov")
          expect(receipt?.unknown).toBeNull()
          expect(receipt?.outcome).toBe("succeeded")
          expect(receipt?.time).toBe(at)
          expect(receipt?.used).toBe(0)
          expect(receipt?.limit).toBe(3)
          expect(receipt?.replay).toBe("forbidden")
          const afterFeed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(afterFeed.length - beforeFeed).toBe(1)
          expect(afterFeed.slice(beforeFeed).map((r) => r.kind)).toEqual(["changed"])
          const row = (yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, op)).get().pipe(Effect.orDie)) as unknown as Record<string, unknown>
          expect(row["recovery_budget"]).toBeNull()
          expect(row["result_snapshot"]).toBeNull()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("legacy prompt/provider persist explicit unknown, never infer parentID", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const promptOp = SessionOperation.promptId("msg_legacy_unknown")
          yield* SessionOperation.ensurePromptInFlight(db, sid, promptOp)
          const at = Date.now()
          const res = yield* SessionOperation.tryTransitionPromptTerminal(db, sid, SessionOperation.generationTerminal({
            opId: promptOp, outcome: "failed", code: "prompt.failed", message: "boom", time: at,
          }))
          expect(res.applied).toBe(true)
          const prec = yield* SessionOperation.getReceipt(db, promptOp)
          expect(prec?.genID).toBeNull()
          expect(prec?.unknown).toBe("no_member")
          expect(prec?.used).toBeNull()
          expect(prec?.time).toBe(at)
          const provOp = SessionOperation.providerId("legacy_unknown_assist", 0)
          yield* SessionOperation.put(db, sid, {
            opId: provOp, opKind: "provider", outcome: "in-flight", code: "provider.inflight", message: "legacy", time: Date.now(),
          })
          const pat = Date.now()
          yield* SessionOperation.put(db, sid, {
            opId: provOp, opKind: "provider", outcome: "failed", code: "provider.failed", message: "boom", time: pat,
          })
          const vrec = yield* SessionOperation.getReceipt(db, provOp)
          expect(vrec?.genID).toBeNull()
          expect(vrec?.unknown).toBe("legacy_null")
          expect(vrec?.time).toBe(pat)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("known gen with missing/corrupt/cross-scope owner fails closed, never unknown", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const s2 = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid2 = s2.id as never
          // dangling provider link: raw in-flight row with ghost gen, no owner
          const ghost = SessionOperation.providerId("ghost_assist", 0)
          yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id","session_id","op_kind","outcome","code","message","time","revision","gen_id") VALUES (${ghost}, ${s.id as string}, 'provider','in-flight','provider.inflight','ghost',${Date.now()},0,'ghostgen')`).pipe(Effect.orDie)
          const gres = yield* runExit(SessionOperation.tryTransitionProviderTerminal(db, sid, SessionOperation.providerTerminal({ opId: ghost })))
          expect(gres._tag).toBe("Failure")
          const ghostRow = (yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, ghost)).get().pipe(Effect.orDie)) as unknown as Record<string, unknown>
          expect(ghostRow["outcome"]).toBe("in-flight")
          expect(yield* SessionOperation.getReceipt(db, ghost)).toBeUndefined()
          // cross-scope owner: owner in sid, provider row in sid2 linked via raw SQL
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_scope"))
          yield* SessionGeneration.begin(db, sid, "genscope", "msg_scope", 2)
          const cross = SessionOperation.providerId("cross_assist", 0)
          yield* SessionOperation.put(db, sid2, {
            opId: cross, opKind: "provider", outcome: "in-flight", code: "provider.inflight", message: "x", time: Date.now(),
          })
          yield* (db as any).run(sql`UPDATE "session_operation" SET "gen_id" = 'genscope' WHERE "op_id" = ${cross}`).pipe(Effect.orDie)
          const cres = yield* runExit(SessionOperation.put(db, sid2, {
            opId: cross, opKind: "provider", outcome: "succeeded", code: "provider.succeeded", message: "ok", time: Date.now(),
          }))
          expect(cres._tag).toBe("Failure")
          expect(yield* SessionOperation.getReceipt(db, cross)).toBeUndefined()
          // corrupt owner: consumed exceeds limit via raw SQL, prompt terminal must die
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_corrupt"))
          yield* SessionGeneration.begin(db, sid, "gencorrupt", "msg_corrupt", 1)
          yield* (db as any).run(sql`UPDATE "session_generation_owner" SET "retry_consumed" = 5 WHERE "gen_id" = 'gencorrupt'`).pipe(Effect.orDie)
          const corrupt = yield* runExit(SessionOperation.tryTransitionPromptTerminal(db, sid, SessionOperation.generationTerminal({
            opId: SessionOperation.promptId("msg_corrupt"), outcome: "failed", code: "prompt.failed", message: "x",
          })))
          expect(corrupt._tag).toBe("Failure")
          expect(yield* SessionOperation.getReceipt(db, SessionOperation.promptId("msg_corrupt"))).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("closed linked owner is legal but close receipt is never the op occurrence", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_closed"))
          yield* SessionGeneration.begin(db, sid, "genclosed", "msg_closed", 2)
          const occ = Date.now() - 5000
          yield* SessionGeneration.charge(db, sid, "genclosed", { layer: "broker", occurrenceTime: occ, nextAt: occ + 2000 })
          yield* SessionGeneration.close(db, sid, "genclosed", "completed")
          const owner = yield* SessionGeneration.getOwner(db, "genclosed")
          expect(owner?.reason).toBe("completed")
          expect(owner?.nextAt).toBeNull()
          const at = Date.now()
          const res = yield* SessionOperation.tryTransitionPromptTerminal(db, sid, SessionOperation.generationTerminal({
            opId: SessionOperation.promptId("msg_closed"), outcome: "abandoned", code: "prompt.abandoned", message: "bye", time: at,
          }))
          expect(res.applied).toBe(true)
          const receipt = yield* SessionOperation.getReceipt(db, SessionOperation.promptId("msg_closed"))
          expect(receipt?.genID).toBe("genclosed")
          expect(receipt?.closeReason).toBe("completed")
          expect(receipt?.layer).toBe("broker")
          expect(receipt?.retryOccurrence).toBe(occ)
          expect(receipt?.nextAt).toBeNull()
          expect(receipt?.time).toBe(at)
          // close receipt is never the op occurrence: the table carries no
          // close_time/occurrence_time column, only the owner retry occurrence
          const rcols = (yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation_receipt')`).pipe(Effect.orDie)) as { name: string }[]
          expect(rcols.some((c) => c.name === "close_time")).toBe(false)
          expect(rcols.some((c) => c.name === "occurrence_time")).toBe(false)
          expect(receipt?.retryOccurrence).toBe(occ)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("idempotent replay writes zero extra rows and zero extra seq", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_replay"))
          yield* SessionGeneration.begin(db, sid, "genreplay", "msg_replay", 2)
          const at = Date.now()
          const first = yield* SessionOperation.put(db, sid, SessionOperation.generationTerminal({
            opId: SessionOperation.promptId("msg_replay"), outcome: "succeeded", code: "prompt.succeeded", message: "ok", time: at,
          }))
          const rev1 = (yield* revisionOf(db, s.id as string)) as unknown as { rev: number }
          const feed1 = ((yield* feedRows(db)) as { seq: number }[]).length
          const rec1 = yield* SessionOperation.getReceipt(db, SessionOperation.promptId("msg_replay"))
          const dup = yield* SessionOperation.put(db, sid, SessionOperation.generationTerminal({
            opId: SessionOperation.promptId("msg_replay"), outcome: "succeeded", code: "prompt.succeeded", message: "ok", time: at,
          }))
          expect(dup).toEqual(first)
          const rev2 = (yield* revisionOf(db, s.id as string)) as unknown as { rev: number }
          const feed2 = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(rev2.rev).toBe(rev1.rev)
          expect(feed2).toBe(feed1)
          const rec2 = yield* SessionOperation.getReceipt(db, SessionOperation.promptId("msg_replay"))
          expect(rec2).toEqual(rec1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("crash sweep keeps original feed shape with receipts; poison good-commit bad-block, no receipt for poison", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const good = SessionOperation.promptId("msg_sweep_good")
          const bad = SessionOperation.promptId("msg_sweep_poison")
          const prov = SessionOperation.providerId("sweep_good", 0)
          yield* SessionOperation.ensurePromptInFlight(db, sid, good)
          yield* SessionGeneration.begin(db, sid, "gensweep", "msg_sweep_good", 2)
          yield* db
            .insert(SessionOperationTable)
            .values({
              op_id: bad, session_id: s.id, op_kind: "prompt", outcome: "in-flight", code: "", message: "poison", time: Date.now(), revision: 0,
            })
            .run()
            .pipe(Effect.orDie)
          yield* SessionOperation.put(db, sid, {
            opId: prov, opKind: "provider", outcome: "in-flight", code: "provider.inflight", message: "accepted", time: Date.now(),
          })
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { sid: s.id as string, good, bad, prov, feed: feed.length }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((x) => ({ ok: true as const, x })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(res.ok).toBe(false)
          if (res.ok) return
          expect(res.f.opIds).toEqual([ids.bad])
          expect(res.f.converged.sort()).toEqual([ids.good, ids.prov].sort())
          const goodRec = yield* SessionOperation.get(db, ids.good)
          expect(goodRec?.outcome).toBe("abandoned")
          expect(goodRec?.code).toBe(SessionOperation.CRASH_CONVERGE_CODE)
          const provRec = yield* SessionOperation.get(db, ids.prov)
          expect(provRec?.code).toBe(SessionOperation.PROVIDER_CRASH_CONVERGE_CODE)
          const grec = yield* SessionOperation.getReceipt(db, ids.good)
          expect(grec?.outcome).toBe("abandoned")
          expect(grec?.genID).toBe("gensweep")
          expect(grec?.time).toBe(goodRec?.time)
          const prec = yield* SessionOperation.getReceipt(db, ids.prov)
          expect(prec?.outcome).toBe("abandoned")
          expect(prec?.unknown).toBe("legacy_null")
          expect(yield* SessionOperation.getReceipt(db, ids.bad)).toBeUndefined()
          const flat = JSON.stringify(res.f)
          expect(flat.includes("secret")).toBe(false)
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(3)
          expect(after.slice(before).map((r) => r.kind).sort()).toEqual(["changed", "changed", "generation"])
          const again = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((x) => ({ ok: true as const, x })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(again.ok).toBe(false)
          const fin = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(fin).toBe(after.length)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("receipt DDL carries 5 CHECKs, indexed FKs, and column parity", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const create = (yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation_receipt'`).pipe(Effect.orDie)) as unknown as { sql: string }
          expect(typeof create?.sql).toBe("string")
          const ddl = create.sql
          expect(ddl).toContain("session_operation_receipt_outcome_check")
          expect(ddl).toContain(`"outcome" IN ('succeeded','failed','ambiguous','superseded','abandoned')`)
          expect(ddl).toContain("session_operation_receipt_gen_check")
          expect(ddl).toContain(`"gen_id" IS NOT NULL`)
          expect(ddl).toContain(`"gen_unknown" IS NOT NULL`)
          expect(ddl).toContain("session_operation_receipt_replay_check")
          expect(ddl).toContain(`"replay" = 'forbidden'`)
          expect(ddl).toContain("session_operation_receipt_layer_check")
          expect(ddl).toContain(`"owner_layer" IN ('provider','incomplete','broker','task','restart')`)
          expect(ddl).toContain("session_operation_receipt_close_reason_check")
          expect(ddl).toContain(`"owner_close_reason" IN ('completed','interrupted','error','crash')`)
          expect(ddl).toContain(`REFERENCES "session_operation"("op_id") ON DELETE CASCADE`)
          expect(ddl).toContain(`REFERENCES "session"("id") ON DELETE CASCADE`)
          const cols = (yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation_receipt')`).pipe(Effect.orDie)) as { name: string }[]
          const names = cols.map((c) => c.name).sort()
          expect(names).toEqual(["gen_id", "gen_unknown", "op_id", "outcome", "owner_close_reason", "owner_layer", "owner_limit", "owner_next_at", "owner_retry_occurrence", "owner_used", "replay", "session_id", "time"])
          expect(names).not.toContain("detail")
          expect(names).not.toContain("stack")
          expect(names).not.toContain("result_snapshot")
          expect(names).not.toContain("close_time")
          expect(names).not.toContain("occurrence_time")
          const fks = (yield* (db as any).all(sql`SELECT "table" AS tbl, "from" AS fromCol, "to" AS toCol, on_delete AS onDelete FROM pragma_foreign_key_list('session_operation_receipt')`).pipe(Effect.orDie)) as { tbl: string; fromCol: string; toCol: string; onDelete: string }[]
          expect(fks.some((f) => f.tbl === "session_operation" && f.fromCol === "op_id" && f.toCol === "op_id" && f.onDelete === "CASCADE")).toBe(true)
          expect(fks.some((f) => f.tbl === "session" && f.fromCol === "session_id" && f.toCol === "id" && f.onDelete === "CASCADE")).toBe(true)
          const idx = (yield* (db as any).all(sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='session_operation_receipt'`).pipe(Effect.orDie)) as { name: string; sql: string | null }[]
          const sessionIdx = idx.find((r) => r.name === "session_operation_receipt_session_idx")
          expect(sessionIdx).toBeDefined()
          expect(sessionIdx?.sql ?? "").toContain("session_id")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("illegal receipt INSERTs are rejected by CHECKs", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as string
          const seed = (op: string) =>
            (db as any).run(sql`INSERT INTO "session_operation" ("op_id","session_id","op_kind","outcome","code","message","time","revision") VALUES (${op}, ${sid}, 'tool','in-flight','tool.inflight','run',1700000000000,0)`).pipe(Effect.orDie)
          const attempt = (op: string, outcome: string, gen: string | null, unk: string | null, replay: string, layer: string | null, reason: string | null) =>
            runExit((db as any).run(sql`INSERT INTO "session_operation_receipt" ("op_id","session_id","outcome","time","gen_id","gen_unknown","owner_used","owner_limit","owner_layer","owner_retry_occurrence","owner_next_at","owner_close_reason","replay") VALUES (${op}, ${sid}, ${outcome}, 1700000000001, ${gen}, ${unk}, null, null, ${layer}, null, null, ${reason}, ${replay})`))
          const badOutcome = SessionOperation.toolId("check_bad_outcome", "c1")
          yield* seed(badOutcome)
          expect((yield* attempt(badOutcome, "bogus", null, "non_gen_kind", "forbidden", null, null))._tag).toBe("Failure")
          const bothNull = SessionOperation.toolId("check_both_null", "c2")
          yield* seed(bothNull)
          expect((yield* attempt(bothNull, "succeeded", null, null, "forbidden", null, null))._tag).toBe("Failure")
          const bothSet = SessionOperation.toolId("check_both_set", "c3")
          yield* seed(bothSet)
          expect((yield* attempt(bothSet, "succeeded", "genx", "non_gen_kind", "forbidden", null, null))._tag).toBe("Failure")
          const badReplay = SessionOperation.toolId("check_bad_replay", "c4")
          yield* seed(badReplay)
          expect((yield* attempt(badReplay, "succeeded", null, "non_gen_kind", "allowed", null, null))._tag).toBe("Failure")
          const badLayer = SessionOperation.toolId("check_bad_layer", "c5")
          yield* seed(badLayer)
          expect((yield* attempt(badLayer, "succeeded", "geny", null, "forbidden", "nope", null))._tag).toBe("Failure")
          const badReason = SessionOperation.toolId("check_bad_reason", "c6")
          yield* seed(badReason)
          expect((yield* attempt(badReason, "succeeded", "genz", null, "forbidden", null, "nope"))._tag).toBe("Failure")
          for (const op of [badOutcome, bothNull, bothSet, badReplay, badLayer, badReason])
            expect(yield* SessionOperation.getReceipt(db, op)).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("corrupt receipt rows bypassing CHECKs read fail-closed without replay masking", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as string
          const seed = (op: string) =>
            (db as any).run(sql`INSERT INTO "session_operation" ("op_id","session_id","op_kind","outcome","code","message","time","revision") VALUES (${op}, ${sid}, 'tool','in-flight','tool.inflight','run',1700000000000,0)`).pipe(Effect.orDie)
          const bypass = (op: string, outcome: string, gen: string | null, unk: string | null, used: unknown, limit: unknown, layer: string | null, reason: string | null, replay: string, time: unknown) =>
            Effect.gen(function* () {
              yield* (db as any).run(sql`PRAGMA ignore_check_constraints=ON`).pipe(Effect.orDie)
              try {
                yield* (db as any).run(sql`INSERT INTO "session_operation_receipt" ("op_id","session_id","outcome","time","gen_id","gen_unknown","owner_used","owner_limit","owner_layer","owner_retry_occurrence","owner_next_at","owner_close_reason","replay") VALUES (${op}, ${sid}, ${outcome as string}, ${time as number}, ${gen}, ${unk}, ${used as number}, ${limit as number}, ${layer}, null, null, ${reason}, ${replay})`).pipe(Effect.orDie)
              } finally {
                yield* (db as any).run(sql`PRAGMA ignore_check_constraints=OFF`).pipe(Effect.orDie)
              }
            })
          const badOutcome = SessionOperation.toolId("corrupt_outcome", "k1")
          yield* seed(badOutcome)
          yield* bypass(badOutcome, "bogus", null, "non_gen_kind", null, null, null, null, "forbidden", 1700000000001)
          expect((yield* runExit(SessionOperation.getReceipt(db, badOutcome)))._tag).toBe("Failure")
          const maskedReplay = SessionOperation.toolId("corrupt_replay", "k2")
          yield* seed(maskedReplay)
          yield* bypass(maskedReplay, "succeeded", null, "non_gen_kind", null, null, null, null, "allowed", 1700000000001)
          const masked = yield* runExit(SessionOperation.getReceipt(db, maskedReplay))
          expect(masked._tag).toBe("Failure")
          if (masked._tag === "Success") expect(masked.value?.replay).not.toBe("forbidden")
          const xorBothNull = SessionOperation.toolId("corrupt_xor", "k3")
          yield* seed(xorBothNull)
          yield* bypass(xorBothNull, "succeeded", null, null, null, null, null, null, "forbidden", 1700000000001)
          expect((yield* runExit(SessionOperation.getReceipt(db, xorBothNull)))._tag).toBe("Failure")
          const badOwner = SessionOperation.toolId("corrupt_owner", "k4")
          yield* seed(badOwner)
          yield* bypass(badOwner, "succeeded", "genbad", null, 5, 2, null, null, "forbidden", 1700000000001)
          expect((yield* runExit(SessionOperation.getReceipt(db, badOwner)))._tag).toBe("Failure")
          const badTime = SessionOperation.toolId("corrupt_time", "k5")
          yield* seed(badTime)
          yield* bypass(badTime, "succeeded", null, "non_gen_kind", null, null, null, null, "forbidden", "not-a-number" as unknown as number)
          expect((yield* runExit(SessionOperation.getReceipt(db, badTime)))._tag).toBe("Failure")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("linked-gen receipt cross-field invariants fail closed, legacy/closed pass", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as string
          const seed = (op: string) =>
            (db as any).run(sql`INSERT INTO "session_operation" ("op_id","session_id","op_kind","outcome","code","message","time","revision") VALUES (${op}, ${sid}, 'tool','in-flight','tool.inflight','run',1700000000000,0)`).pipe(Effect.orDie)
          const inject = (op: string, gen: string | null, unk: string | null, used: number | null, limit: number | null, layer: string | null, occ: number | null, next: number | null, reason: string | null) =>
            (db as any).run(sql`INSERT INTO "session_operation_receipt" ("op_id","session_id","outcome","time","gen_id","gen_unknown","owner_used","owner_limit","owner_layer","owner_retry_occurrence","owner_next_at","owner_close_reason","replay") VALUES (${op}, ${sid}, 'succeeded', 1700000000001, ${gen}, ${unk}, ${used as never}, ${limit as never}, ${layer}, ${occ as never}, ${next as never}, ${reason}, 'forbidden')`).pipe(Effect.orDie)
          const T = 1700000000100
          // closed => nextAt null
          const closedNext = SessionOperation.toolId("link_closed_next", "c1")
          yield* seed(closedNext)
          yield* inject(closedNext, "gena", null, 1, 2, "broker", T, T + 1000, "completed")
          expect((yield* runExit(SessionOperation.getReceipt(db, closedNext)))._tag).toBe("Failure")
          // closed occurrence requires layer
          const closedOrphan = SessionOperation.toolId("link_closed_orphan", "c2")
          yield* seed(closedOrphan)
          yield* inject(closedOrphan, "genb", null, 1, 2, null, T, null, "completed")
          expect((yield* runExit(SessionOperation.getReceipt(db, closedOrphan)))._tag).toBe("Failure")
          // open layer and nextAt paired: layer without next
          const openSplit1 = SessionOperation.toolId("link_open_split1", "c3")
          yield* seed(openSplit1)
          yield* inject(openSplit1, "genc", null, 1, 2, "provider", null, null, null)
          expect((yield* runExit(SessionOperation.getReceipt(db, openSplit1)))._tag).toBe("Failure")
          // open next without layer
          const openSplit2 = SessionOperation.toolId("link_open_split2", "c4")
          yield* seed(openSplit2)
          yield* inject(openSplit2, "gend", null, 1, 2, null, null, T + 1000, null)
          expect((yield* runExit(SessionOperation.getReceipt(db, openSplit2)))._tag).toBe("Failure")
          // open occurrence requires layer+next: occ alone
          const openOrphan = SessionOperation.toolId("link_open_orphan", "c5")
          yield* seed(openOrphan)
          yield* inject(openOrphan, "gene", null, 1, 2, null, T, null, null)
          expect((yield* runExit(SessionOperation.getReceipt(db, openOrphan)))._tag).toBe("Failure")
          // open occurrence with layer but missing next
          const openPartial = SessionOperation.toolId("link_open_partial", "c6")
          yield* seed(openPartial)
          yield* inject(openPartial, "genf", null, 1, 2, "provider", T, null, null)
          expect((yield* runExit(SessionOperation.getReceipt(db, openPartial)))._tag).toBe("Failure")
          // unknown => owner fields all null
          const unkOwner = SessionOperation.toolId("link_unk_owner", "c7")
          yield* seed(unkOwner)
          yield* inject(unkOwner, null, "non_gen_kind", 0, 1, null, null, null, null)
          expect((yield* runExit(SessionOperation.getReceipt(db, unkOwner)))._tag).toBe("Failure")
          // valid legacy open: layer+next paired, occurrence null allowed, no fabrication
          const legacyOpen = SessionOperation.toolId("link_legacy_open", "v1")
          yield* seed(legacyOpen)
          yield* inject(legacyOpen, "genleg", null, 1, 2, "provider", null, T + 1000, null)
          const leg = yield* SessionOperation.getReceipt(db, legacyOpen)
          expect(leg?.genID).toBe("genleg")
          expect(leg?.unknown).toBeNull()
          expect(leg?.used).toBe(1)
          expect(leg?.limit).toBe(2)
          expect(leg?.layer).toBe("provider")
          expect(leg?.retryOccurrence).toBeNull()
          expect(leg?.nextAt).toBe(T + 1000)
          expect(leg?.closeReason).toBeNull()
          expect(leg?.outcome).toBe("succeeded")
          expect(leg?.time).toBe(1700000000001)
          expect(leg?.replay).toBe("forbidden")
          // valid closed: layer+occurrence retained, next null, no fabrication
          const closedOk = SessionOperation.toolId("link_closed_ok", "v2")
          yield* seed(closedOk)
          yield* inject(closedOk, "genclo", null, 1, 2, "broker", T, null, "completed")
          const clo = yield* SessionOperation.getReceipt(db, closedOk)
          expect(clo?.genID).toBe("genclo")
          expect(clo?.unknown).toBeNull()
          expect(clo?.used).toBe(1)
          expect(clo?.limit).toBe(2)
          expect(clo?.layer).toBe("broker")
          expect(clo?.retryOccurrence).toBe(T)
          expect(clo?.nextAt).toBeNull()
          expect(clo?.closeReason).toBe("completed")
          expect(clo?.time).toBe(1700000000001)
          // valid open untouched: all owner null except used/limit
          const openEmpty = SessionOperation.toolId("link_open_empty", "v3")
          yield* seed(openEmpty)
          yield* inject(openEmpty, "genemp", null, 0, 2, null, null, null, null)
          const emp = yield* SessionOperation.getReceipt(db, openEmpty)
          expect(emp?.genID).toBe("genemp")
          expect(emp?.used).toBe(0)
          expect(emp?.limit).toBe(2)
          expect(emp?.layer).toBeNull()
          expect(emp?.retryOccurrence).toBeNull()
          expect(emp?.nextAt).toBeNull()
          expect(emp?.closeReason).toBeNull()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("upgrade leaves old terminal rows without receipt (not recorded, never backfilled); snapshot contract intact", async () => {
    const { dir, file } = await freshFile()
    const oldOp = SessionOperation.promptId("msg_upgrade_old")
    let sid = ""
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          sid = s.id as string
          const sub = sid as never
          yield* SessionOperation.ensurePromptInFlight(db, sub, SessionOperation.promptId("msg_upgrade_anchor"))
          yield* SessionGeneration.begin(db, sub, "genupgrade", "msg_upgrade_anchor", 1)
          // legacy terminal row written directly, bypassing the receipt path
          yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id","session_id","op_kind","outcome","code","message","time","revision") VALUES (${oldOp}, ${sid}, 'prompt','succeeded','prompt.succeeded','old ok',1700000000000,0)`).pipe(Effect.orDie)
          // simulate pre-migration state: drop receipt table + journal row
          yield* (db as any).run(sql`DROP TABLE IF EXISTS "session_operation_receipt"`).pipe(Effect.orDie)
          yield* (db as any).run(sql`DELETE FROM "migration" WHERE id = '20260926000002_add_operation_receipt'`).pipe(Effect.orDie)
          const pre = (yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='session_operation_receipt'`).pipe(Effect.orDie)) as { name: string }[]
          expect(pre.length).toBe(0)
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const sub = sid as never
          const cols = (yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation_receipt')`).pipe(Effect.orDie)) as { name: string }[]
          expect(cols.some((c) => c.name === "op_id")).toBe(true)
          expect(cols.some((c) => c.name === "detail")).toBe(false)
          expect(cols.some((c) => c.name === "stack")).toBe(false)
          // old terminal row is present but receipt is absent: not recorded, never backfilled
          const old = yield* SessionOperation.get(db, oldOp)
          expect(old?.outcome).toBe("succeeded")
          expect(yield* SessionOperation.getReceipt(db, oldOp)).toBeUndefined()
          // new terminal after upgrade records a receipt; old row stays absent
          yield* SessionOperation.ensurePromptInFlight(db, sub, SessionOperation.promptId("msg_upgrade_new"))
          yield* SessionGeneration.begin(db, sub, "genupgrade2", "msg_upgrade_new", 1)
          const res = yield* SessionOperation.tryTransitionPromptTerminal(db, sub, SessionOperation.generationTerminal({
            opId: SessionOperation.promptId("msg_upgrade_new"), outcome: "succeeded", code: "prompt.succeeded", message: "new ok",
          }))
          expect(res.applied).toBe(true)
          expect((yield* SessionOperation.getReceipt(db, SessionOperation.promptId("msg_upgrade_new")))?.genID).toBe("genupgrade2")
          expect(yield* SessionOperation.getReceipt(db, oldOp)).toBeUndefined()
          // dedicated sessionUpdate helper keeps result_snapshot and writes no receipt
          const upd = yield* SessionOperation.insertSessionUpdateSucceededTx(db as never, sub, {
            opId: SessionOperation.sessionUpdateId(sid, "tok-snap"),
            opKind: "sessionUpdate", outcome: "succeeded", code: "sessionUpdate.succeeded", message: "title ok", time: Date.now(),
          }, {
            idempotencyHash: "hash-snap", requestId: "req-snap", directory: "/project", title: "hello",
          })
          expect(upd.resultSnapshot).toBeDefined()
          expect(yield* SessionOperation.getReceipt(db, upd.opId)).toBeUndefined()
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          expect(yield* SessionOperation.getReceipt(db, oldOp)).toBeUndefined()
          expect((yield* SessionOperation.getReceipt(db, SessionOperation.promptId("msg_upgrade_new")))?.genID).toBe("genupgrade2")
          const journal = (yield* (db as any).all(sql`SELECT id FROM "migration" WHERE id = '20260926000002_add_operation_receipt'`).pipe(Effect.orDie)) as { id: string }[]
          expect(journal.length).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
