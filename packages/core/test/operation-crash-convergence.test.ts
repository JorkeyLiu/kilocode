import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"

// Crash-restart convergence for accepted generation + provider outcome: real
// file-backed SQLite, two sequential layer stacks on the same file (scope
// close between them is the crash — no terminalize runs), then the boot
// sweep. Proves the sweep needs no live owner state. Worker crash here is
// the private runtime process dying: prompt `in-flight` rows converge with
// revision + `changed` + `generation`, provider `in-flight` rows converge
// with exactly one revision + one `changed` row (never `generation`, never
// recovery fields), both at receipt (boot) time with no forged occurrence
// timestamp, no retry, no silent replay.

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
  const dir = await mkdtemp(join(tmpdir(), "op-crash-converge-"))
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

function canonicalStack(file: string) {
  const database = Database.layerFromPath(file)
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

function withCanonicalStack<A>(
  file: string,
  fn: (env: { db: Database.Interface["db"]; svc: any }) => Effect.Effect<A, unknown, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(canonicalStack(file))
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

const opRow = (db: Database.Interface["db"], opId: string) =>
  db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)

describe("operation crash convergence", () => {
  test("op kind/outcome validator accepts crash codes, provider terminal rejects prompt shape", async () => {
    const promptFixed = SessionOperation.generationTerminal({
      opId: SessionOperation.promptId("msg_codes"),
      outcome: "abandoned",
      code: "prompt.abandoned",
      message: "prompt abandoned due to runtime restart",
      time: 1,
    })
    expect(() => SessionOperation.validateRecord(promptFixed)).not.toThrow()
    const provFixed = SessionOperation.providerTerminal({ opId: SessionOperation.providerId("msg_codes", 0), time: 1 })
    expect(provFixed.code).toBe("provider.abandoned")
    expect(provFixed.message).toBe("Provider attempt abandoned after runtime restart")
    expect(provFixed.opKind).toBe("provider")
    expect(provFixed.outcome).toBe("abandoned")
    expect(() => SessionOperation.validateRecord(provFixed)).not.toThrow()
    expect(SessionOperation.recoveryForTerminal(provFixed.opKind, provFixed.outcome)).toBeUndefined()
    expect(() => SessionOperation.providerTerminal({ opId: SessionOperation.promptId("msg_codes") })).toThrow()
    expect(() =>
      SessionOperation.generationTerminal({
        opId: SessionOperation.providerId("msg_codes", 0),
        outcome: "abandoned",
        code: "provider.abandoned",
        message: "x",
      }),
    ).toThrow()
  })

  test("restart converges orphaned prompt+provider in-flight rows exactly once with no replay", async () => {
    const { dir, file } = await freshFile()
    try {
      const location = { directory: AbsolutePath.make("/project") }
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location }).pipe(Effect.orDie)
          const opA = SessionOperation.promptId("msg_crash_a")
          const opB = SessionOperation.promptId("msg_crash_b")
          const done = SessionOperation.promptId("msg_done")
          const provOp = SessionOperation.providerId("msg_crash_a", 0)
          const a = yield* SessionOperation.ensurePromptInFlight(db, s.id, opA)
          const b = yield* SessionOperation.ensurePromptInFlight(db, s.id, opB)
          expect(a.fresh).toBe(true)
          expect(b.fresh).toBe(true)
          // already-terminal row on the same session must be untouched
          yield* SessionOperation.put(db, s.id, {
            opId: done,
            opKind: "prompt",
            outcome: "succeeded",
            code: "prompt.succeeded",
            message: "ok",
            time: Date.now(),
          })
          // provider-kind in-flight row is swept by the combined gate
          yield* SessionOperation.put(db, s.id, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { sid: s.id as string, opA, opB, done, provOp, feed: feed.length }
        }),
      )
      // scope closed with no terminalize: the crash. Fresh stack = restart.
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const summary = yield* SessionOperation.convergeOrphanedInFlight(db)
          expect(summary.converged).toEqual([ids.opA, ids.opB, ids.provOp])
          expect(summary.raced).toEqual([])
          expect(summary.skipped).toEqual([])

          for (const op of [ids.opA, ids.opB]) {
            const rec = yield* SessionOperation.get(db, op)
            expect(rec?.outcome).toBe("abandoned")
            expect(rec?.code).toBe(SessionOperation.CRASH_CONVERGE_CODE)
            expect(rec?.message).toBe(SessionOperation.CRASH_CONVERGE_MESSAGE)
            expect(rec?.detail).toBeUndefined()
            expect(rec?.stack).toBeUndefined()
            expect(Number.isFinite(rec?.time)).toBe(true)
            const row = (yield* opRow(db, op)) as unknown as Record<string, unknown>
            expect(row["recovery_budget"]).toBe(0)
            expect(row["recovery_next_at"]).toBeNull()
            expect(row["recovery_provenance"]).toBe("terminal")
            // panel projection carries no diagnostic fields
            const panel = SessionOperation.toPanelRecord(rec!)
            expect(panel.detail).toBeUndefined()
            expect(panel.stack).toBeUndefined()
          }

          // provider row: abandoned receipt-time, fixed safe code, no
          // generation, no recovery fields, no diagnostic leak
          const prov = yield* SessionOperation.get(db, ids.provOp)
          expect(prov?.outcome).toBe("abandoned")
          expect(prov?.code).toBe(SessionOperation.PROVIDER_CRASH_CONVERGE_CODE)
          expect(prov?.message).toBe(SessionOperation.PROVIDER_CRASH_CONVERGE_MESSAGE)
          expect(prov?.detail).toBeUndefined()
          expect(prov?.stack).toBeUndefined()
          expect(Number.isFinite(prov?.time)).toBe(true)
          const provRow = (yield* opRow(db, ids.provOp)) as unknown as Record<string, unknown>
          expect(provRow["recovery_budget"]).toBeNull()
          expect(provRow["recovery_next_at"]).toBeNull()
          expect(provRow["recovery_provenance"]).toBeNull()
          const provPanel = SessionOperation.toPanelRecord(prov!)
          expect(provPanel.detail).toBeUndefined()
          expect(provPanel.stack).toBeUndefined()

          // untouched rows
          const kept = yield* SessionOperation.get(db, ids.done)
          expect(kept?.outcome).toBe("succeeded")

          // exact changefeed accounting: 2 prompt x (changed + generation)
          // plus 1 provider x (changed only)
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(5)
          const kinds = after.slice(before).map((r) => r.kind).sort()
          expect(kinds).toEqual(["changed", "changed", "changed", "generation", "generation"])
          const seqs = after.map((r) => r.seq)
          expect(new Set(seqs).size).toBe(seqs.length)

          // idempotent rerun: nothing converges, no new feed
          const rerun = yield* SessionOperation.convergeOrphanedInFlight(db)
          expect(rerun).toEqual({ converged: [], raced: [], skipped: [] })
          const reread = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(reread).toBe(after.length)

          // no silent replay and no provider retry: same opIds replay
          // terminal, never restart generation or a new provider attempt
          const replay = yield* SessionOperation.ensurePromptInFlight(db, ids.sid as never, ids.opA)
          expect(replay.fresh).toBe(false)
          if (!replay.fresh) expect(replay.record.outcome).toBe("abandoned")
          const cas = yield* SessionOperation.tryTransitionPromptTerminal(db, ids.sid as never, {
            opId: ids.opA,
            opKind: "prompt",
            outcome: "succeeded",
            code: "prompt.succeeded",
            message: "late success",
            time: Date.now(),
          })
          expect(cas.applied).toBe(false)
          const provReplay = yield* SessionOperation.get(db, ids.provOp)
          expect(provReplay?.outcome).toBe("abandoned")
          const retryRow = (yield* opRow(db, SessionOperation.providerId("msg_crash_a", 1))) as unknown as Record<string, unknown> | undefined
          expect(retryRow).toBeUndefined()
          const final = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(final).toBe(after.length)
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("live prompt terminal vs sweep race converges exactly once with no duplicate feed", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const op = SessionOperation.promptId("msg_race")
          const inception = yield* SessionOperation.ensurePromptInFlight(db, sid, op)
          expect(inception.fresh).toBe(true)
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length

          // streaming crash vs terminal commit racing on the same row
          const live = SessionOperation.tryTransitionPromptTerminal(db, sid, {
            opId: op,
            opKind: "prompt",
            outcome: "succeeded",
            code: "prompt.succeeded",
            message: "prompt succeeded",
            time: Date.now(),
          })
          const sweep = SessionOperation.convergeOrphanedInFlight(db)
          const [liveRes, sweepRes] = yield* Effect.all([live, sweep], { concurrency: "unbounded" })
          const wins = (liveRes.applied ? 1 : 0) + sweepRes.converged.length
          expect(wins).toBe(1)
          if (liveRes.applied) {
            expect(sweepRes.converged).toEqual([])
            // sweep either observed the live terminal (raced) or never saw the row at all
            expect(sweepRes.raced.length <= 1).toBe(true)
            if (sweepRes.raced.length === 1) expect(sweepRes.raced).toEqual([op])
          } else {
            expect(sweepRes.converged).toEqual([op])
            expect(sweepRes.raced).toEqual([])
          }
          expect(sweepRes.skipped).toEqual([])

          const rec = yield* SessionOperation.get(db, op)
          expect(rec?.outcome).toBe(liveRes.applied ? "succeeded" : "abandoned")

          // exactly one winner wrote exactly changed + generation, seqs unique
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(2)
          expect(after.slice(before).map((r) => r.kind).sort()).toEqual(["changed", "generation"])
          const seqs = after.map((r) => r.seq)
          expect(new Set(seqs).size).toBe(seqs.length)

          // settled: further sweep is a no-op
          const settled = yield* SessionOperation.convergeOrphanedInFlight(db)
          expect(settled).toEqual({ converged: [], raced: [], skipped: [] })
          const final = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(final).toBe(after.length)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("live provider terminal vs sweep race has a unique winner with changed-only feed", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const op = SessionOperation.providerId("msg_race_prov", 0)
          yield* SessionOperation.put(db, sid, {
            opId: op,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length

          // live provider terminal (via the production put path) races the
          // boot sweep; the loser emits nothing. A losing live put dies with
          // a terminal conflict, so capture it as a loss instead of failing.
          const live = SessionOperation.put(db, sid, {
            opId: op,
            opKind: "provider",
            outcome: "succeeded",
            code: "provider.succeeded",
            message: "provider request succeeded",
            time: Date.now(),
          }).pipe(
            Effect.map(() => ({ won: true as const })),
            Effect.catch(() => Effect.succeed({ won: false as const })),
            Effect.catchDefect(() => Effect.succeed({ won: false as const })),
          )
          const sweep = SessionOperation.convergeOrphanedProviderInFlight(db)
          const [liveRes, sweepRes] = yield* Effect.all([live, sweep], { concurrency: "unbounded" })
          const wins = (liveRes.won ? 1 : 0) + sweepRes.converged.length
          expect(wins).toBe(1)
          if (liveRes.won) {
            expect(sweepRes.converged).toEqual([])
            expect(sweepRes.raced.length <= 1).toBe(true)
            if (sweepRes.raced.length === 1) expect(sweepRes.raced).toEqual([op])
          } else {
            expect(sweepRes.converged).toEqual([op])
            expect(sweepRes.raced).toEqual([])
          }
          expect(sweepRes.skipped).toEqual([])

          const rec = yield* SessionOperation.get(db, op)
          expect(rec?.outcome).toBe(liveRes.won ? "succeeded" : "abandoned")
          if (!liveRes.won) {
            expect(rec?.code).toBe(SessionOperation.PROVIDER_CRASH_CONVERGE_CODE)
            const row = (yield* opRow(db, op)) as unknown as Record<string, unknown>
            expect(row["recovery_budget"]).toBeNull()
            expect(row["recovery_next_at"]).toBeNull()
            expect(row["recovery_provenance"]).toBeNull()
          }

          // exactly one winner wrote exactly one changed row, never generation
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(1)
          expect(after.slice(before).map((r) => r.kind)).toEqual(["changed"])
          const seqs = after.map((r) => r.seq)
          expect(new Set(seqs).size).toBe(seqs.length)

          // settled: further sweep is a no-op with 0 new feeds
          const settled = yield* SessionOperation.convergeOrphanedInFlight(db)
          expect(settled).toEqual({ converged: [], raced: [], skipped: [] })
          const final = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(final).toBe(after.length)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("canonical lease layer restart converges prompt+provider with exact feed and no replay", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withCanonicalStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const opA = SessionOperation.promptId("msg_canonical_a")
          const provOp = SessionOperation.providerId("msg_canonical_a", 0)
          const a = yield* SessionOperation.ensurePromptInFlight(db, s.id, opA)
          expect(a.fresh).toBe(true)
          yield* SessionOperation.put(db, s.id, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { sid: s.id as string, opA, provOp, feed: feed.length }
        }),
      )
      const out = await withCanonicalStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const summary = yield* SessionOperation.convergeOrphanedInFlight(db)
          expect(summary.converged).toEqual([ids.opA, ids.provOp])
          expect(summary.raced).toEqual([])
          expect(summary.skipped).toEqual([])
          const rec = yield* SessionOperation.get(db, ids.opA)
          expect(rec?.outcome).toBe("abandoned")
          const prov = yield* SessionOperation.get(db, ids.provOp)
          expect(prov?.outcome).toBe("abandoned")
          expect(prov?.code).toBe(SessionOperation.PROVIDER_CRASH_CONVERGE_CODE)
          const provRow = (yield* opRow(db, ids.provOp)) as unknown as Record<string, unknown>
          expect(provRow["recovery_budget"]).toBeNull()
          expect(provRow["recovery_next_at"]).toBeNull()
          expect(provRow["recovery_provenance"]).toBeNull()
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(3)
          expect(after.slice(before).map((r) => r.kind).sort()).toEqual(["changed", "changed", "generation"])
          const rerun = yield* SessionOperation.convergeOrphanedInFlight(db)
          expect(rerun).toEqual({ converged: [], raced: [], skipped: [] })
          const replay = yield* SessionOperation.ensurePromptInFlight(db, ids.sid as never, ids.opA)
          expect(replay.fresh).toBe(false)
          if (!replay.fresh) expect(replay.record.outcome).toBe("abandoned")
          const final = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(final).toBe(after.length)
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("poison invalid row fails closed, valid prompt+provider still land, no terminal fabrication", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const good = SessionOperation.promptId("msg_good")
          const bad = SessionOperation.promptId("msg_poison")
          const provOp = SessionOperation.providerId("msg_good", 0)
          const g = yield* SessionOperation.ensurePromptInFlight(db, s.id, good)
          expect(g.fresh).toBe(true)
          yield* db
            .insert(SessionOperationTable)
            .values({
              op_id: bad,
              session_id: s.id,
              op_kind: "prompt",
              outcome: "in-flight",
              code: "",
              message: "poison",
              time: Date.now(),
              detail: "secret-token-xyz",
              stack: "stack-secret-abc",
              revision: 0,
            })
            .run()
            .pipe(Effect.orDie)
          yield* SessionOperation.put(db, s.id, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { sid: s.id as string, good, bad, provOp, feed: feed.length }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((s) => ({ ok: true as const, s })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(res.ok).toBe(false)
          if (res.ok) return false
          expect(res.f._tag).toBe("SessionOperation.ConvergeOrphanedFailure")
          expect(res.f.count).toBe(1)
          expect(res.f.opIds).toEqual([ids.bad])
          expect(res.f.converged).toEqual([ids.good, ids.provOp])
          expect(res.f.raced).toEqual([])
          const flat = JSON.stringify(res.f)
          expect(flat.includes("secret-token-xyz")).toBe(false)
          expect(flat.includes("stack-secret-abc")).toBe(false)
          const goodRec = yield* SessionOperation.get(db, ids.good)
          expect(goodRec?.outcome).toBe("abandoned")
          expect(goodRec?.code).toBe(SessionOperation.CRASH_CONVERGE_CODE)
          const provRec = yield* SessionOperation.get(db, ids.provOp)
          expect(provRec?.outcome).toBe("abandoned")
          expect(provRec?.code).toBe(SessionOperation.PROVIDER_CRASH_CONVERGE_CODE)
          const badRow = (yield* opRow(db, ids.bad)) as unknown as Record<string, unknown>
          expect(badRow["outcome"]).toBe("in-flight")
          expect(badRow["code"]).toBe("")
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(3)
          expect(after.slice(before).map((r) => r.kind).sort()).toEqual(["changed", "changed", "generation"])
          const replay = yield* SessionOperation.ensurePromptInFlight(db, ids.sid as never, ids.good)
          expect(replay.fresh).toBe(false)
          if (!replay.fresh) expect(replay.record.outcome).toBe("abandoned")
          const again = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((s) => ({ ok: true as const, s })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(again.ok).toBe(false)
          if (!again.ok) {
            expect(again.f.opIds).toEqual([ids.bad])
            expect(again.f.converged).toEqual([])
          }
          const final = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(final).toBe(after.length)
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("missing session fails closed without fabricating terminal", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const good = SessionOperation.promptId("msg_ok")
          const provOp = SessionOperation.providerId("msg_ok", 0)
          const orphan = SessionOperation.promptId("msg_orphan")
          const g = yield* SessionOperation.ensurePromptInFlight(db, s.id, good)
          expect(g.fresh).toBe(true)
          yield* SessionOperation.put(db, s.id, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          yield* db.run("PRAGMA foreign_keys=OFF").pipe(Effect.orDie)
          try {
            yield* db
              .insert(SessionOperationTable)
              .values({
                op_id: orphan,
                session_id: "ses_missing_000000000000000000000000" as never,
                op_kind: "prompt",
                outcome: "in-flight",
                code: "prompt.inflight",
                message: "prompt accepted",
                time: Date.now(),
                revision: 0,
              })
              .run()
              .pipe(Effect.orDie)
          } finally {
            yield* db.run("PRAGMA foreign_keys=ON").pipe(Effect.orDie)
          }
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { sid: s.id as string, good, provOp, orphan, feed: feed.length }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((s) => ({ ok: true as const, s })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(res.ok).toBe(false)
          if (res.ok) return false
          expect(res.f.opIds).toEqual([ids.orphan])
          expect(res.f.converged).toEqual([ids.good, ids.provOp])
          const goodRec = yield* SessionOperation.get(db, ids.good)
          expect(goodRec?.outcome).toBe("abandoned")
          const provRec = yield* SessionOperation.get(db, ids.provOp)
          expect(provRec?.outcome).toBe("abandoned")
          const orphanRow = (yield* opRow(db, ids.orphan)) as unknown as Record<string, unknown>
          expect(orphanRow["outcome"]).toBe("in-flight")
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("db error fails closed with typed failure and no terminal", async () => {
    const broken = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              all: () => Effect.fail(new Error("db boom") as unknown as never),
            }),
          }),
        }),
      }),
    } as unknown as Database.Interface["db"]
    const res = await Effect.runPromise(
      SessionOperation.convergeOrphanedInFlight(broken).pipe(
        Effect.map((s) => ({ ok: true as const, s })),
        Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
      ),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.f._tag).toBe("SessionOperation.ConvergeOrphanedFailure")
      expect(res.f.count).toBe(0)
      expect(res.f.opIds).toEqual([])
      expect(JSON.stringify(res.f).includes("db boom")).toBe(false)
    }
  })
})
