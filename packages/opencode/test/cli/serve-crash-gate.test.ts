import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
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
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { SessionGenerationOwnerTable } from "@opencode-ai/core/session/sql"
import { gateThenListen, runCrashConvergenceGate, runGenerationConvergenceGate } from "../../src/cli/cmd/serve"

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

async function freshFile() {
  const dir = await mkdtemp(join(tmpdir(), "serve-gate-"))
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

describe("serve crash gate pre-bind", () => {
  test("clean sweep runs before injected listen, no bind until sweep complete", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const op = SessionOperation.promptId("msg_gate_ok")
          const provOp = SessionOperation.providerId("msg_gate_ok", 0)
          const r = yield* SessionOperation.ensurePromptInFlight(db, s.id, op)
          expect(r.fresh).toBe(true)
          yield* SessionOperation.put(db, s.id, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          return { sid: s.id as string, op, provOp }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const calls: string[] = []
          const listen = async () => {
            calls.push("listen")
            const rec = await Effect.runPromise(SessionOperation.get(db, ids.op) as Effect.Effect<any>)
            expect(rec?.outcome).toBe("abandoned")
            const prov = await Effect.runPromise(SessionOperation.get(db, ids.provOp) as Effect.Effect<any>)
            expect(prov?.outcome).toBe("abandoned")
            expect(prov?.code).toBe("provider.abandoned")
            return { fake: true as const }
          }
          const res = yield* gateThenListen(db, listen).pipe(Effect.orDie)
          expect(calls).toEqual(["listen"])
          expect(res.sweep.converged).toEqual([ids.op, ids.provOp])
          expect(res.sweep.raced).toEqual([])
          expect(res.server).toEqual({ fake: true })
          // exact feed: prompt changed+generation, provider changed only
          const rows = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(rows.slice(-3).map((r) => r.kind).sort()).toEqual(["changed", "changed", "generation"])
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("poison blocks listen with safe message, valid prompt+provider still land, exact feed", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const good = SessionOperation.promptId("msg_gate_good")
          const bad = SessionOperation.promptId("msg_gate_bad")
          const provOp = SessionOperation.providerId("msg_gate_good", 0)
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
              detail: "detail-secret-xyz",
              stack: "stack-secret-abc",
              revision: 0,
            })
            .run()
            .pipe(Effect.orDie)
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { good, bad, provOp, feed: feed.length }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          let listened = false
          const listen = async () => {
            listened = true
            return { fake: true as const }
          }
          const res = yield* gateThenListen(db, listen).pipe(
            Effect.map((v) => ({ ok: true as const, v })),
            Effect.catch((e) => Effect.succeed({ ok: false as const, e: e as { message: string } })),
          )
          expect(res.ok).toBe(false)
          expect(listened).toBe(false)
          if (res.ok) return false
          expect(res.e.message.includes(ids.bad)).toBe(true)
          expect(res.e.message.includes("1 invalid")).toBe(true)
          expect(res.e.message.includes("detail-secret-xyz")).toBe(false)
          expect(res.e.message.includes("stack-secret-abc")).toBe(false)
          const goodRec = yield* SessionOperation.get(db, ids.good)
          expect(goodRec?.outcome).toBe("abandoned")
          const provRec = yield* SessionOperation.get(db, ids.provOp)
          expect(provRec?.outcome).toBe("abandoned")
          expect(provRec?.code).toBe("provider.abandoned")
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(3)
          expect(after.slice(before).map((r) => r.kind).sort()).toEqual(["changed", "changed", "generation"])
          const gate = yield* runCrashConvergenceGate(db).pipe(
            Effect.map((v) => ({ ok: true as const, v })),
            Effect.catch((e) => Effect.succeed({ ok: false as const, e: e as { message: string } })),
          )
          expect(gate.ok).toBe(false)
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("missing session blocks listen without fabricating terminal", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const good = SessionOperation.promptId("msg_miss_good")
          const provOp = SessionOperation.providerId("msg_miss_good", 0)
          const orphan = SessionOperation.promptId("msg_miss_orphan")
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
          return { good, provOp, orphan }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          let listened = false
          const res = yield* gateThenListen(db, async () => {
            listened = true
            return { fake: true as const }
          }).pipe(
            Effect.map((v) => ({ ok: true as const, v })),
            Effect.catch((e) => Effect.succeed({ ok: false as const, e: e as { message: string } })),
          )
          expect(res.ok).toBe(false)
          expect(listened).toBe(false)
          if (res.ok) return false
          expect(res.e.message.includes(ids.orphan)).toBe(true)
          const goodRec = yield* SessionOperation.get(db, ids.good)
          expect(goodRec?.outcome).toBe("abandoned")
          const provRec = yield* SessionOperation.get(db, ids.provOp)
          expect(provRec?.outcome).toBe("abandoned")
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("generation sweep runs before injected listen, no bind until sweep complete", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const base = "msg_gen_gate_ok"
          const op = SessionOperation.promptId(base)
          const r = yield* SessionOperation.ensurePromptInFlight(db, s.id, op)
          expect(r.fresh).toBe(true)
          const gen = `gen_gate_ok_${Date.now()}`
          const begun = yield* SessionGeneration.begin(db, s.id as never, gen, base, 2).pipe(Effect.orDie)
          expect(begun).toEqual({ created: true, added: op })
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { sid: s.id as string, gen, op, feed: feed.length }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const calls: string[] = []
          const listen = async () => {
            calls.push("listen")
            const owner = await Effect.runPromise(SessionGeneration.getOwner(db, ids.gen) as Effect.Effect<any>)
            expect(owner?.reason).toBe("crash")
            expect(Number.isFinite(owner?.closedAt)).toBe(true)
            expect(owner?.limit).toBe(2)
            expect(owner?.used).toBe(0)
            const rec = await Effect.runPromise(SessionOperation.get(db, ids.op) as Effect.Effect<any>)
            expect(rec?.outcome).toBe("abandoned")
            return { fake: true as const }
          }
          const res = yield* gateThenListen(db, listen).pipe(Effect.orDie)
          expect(calls).toEqual(["listen"])
          expect(res.generation.converged).toEqual([ids.gen])
          expect(res.generation.raced).toEqual([])
          expect(res.server).toEqual({ fake: true })
          // generation close emits no feed; only the operation sweep adds feeds
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(2)
          expect(after.slice(before).map((r) => r.kind).sort()).toEqual(["changed", "generation"])
          const rerun = yield* runGenerationConvergenceGate(db).pipe(Effect.orDie)
          expect(rerun).toEqual({ converged: [], raced: [], skipped: [] })
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("generation poison blocks listen without fabricating terminal", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const base = "msg_gen_gate_good"
          const op = SessionOperation.promptId(base)
          const g = yield* SessionOperation.ensurePromptInFlight(db, s.id, op)
          expect(g.fresh).toBe(true)
          const gen = `gen_gate_good_${Date.now()}`
          yield* SessionGeneration.begin(db, s.id as never, gen, base, 2).pipe(Effect.orDie)
          const orphanGen = `gen_gate_orphan_${Date.now()}`
          yield* db.run("PRAGMA foreign_keys=OFF").pipe(Effect.orDie)
          try {
            yield* db
              .insert(SessionGenerationOwnerTable)
              .values({
                gen_id: orphanGen,
                session_id: "ses_missing_000000000000000000000000" as never,
                occurrence_time: Date.now(),
                close_time: null,
                close_reason: null,
                retry_limit: 2,
                retry_consumed: 0,
              })
              .run()
              .pipe(Effect.orDie)
          } finally {
            yield* db.run("PRAGMA foreign_keys=ON").pipe(Effect.orDie)
          }
          return { sid: s.id as string, gen, op, orphanGen }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          let listened = false
          const res = yield* gateThenListen(db, async () => {
            listened = true
            return { fake: true as const }
          }).pipe(
            Effect.map((v) => ({ ok: true as const, v })),
            Effect.catch((e) => Effect.succeed({ ok: false as const, e: e as { message: string } })),
          )
          expect(res.ok).toBe(false)
          expect(listened).toBe(false)
          if (res.ok) return false
          expect(res.e.message.includes(ids.orphanGen)).toBe(true)
          expect(res.e.message.includes("generation")).toBe(true)
          const owner = yield* SessionGeneration.getOwner(db, ids.gen)
          expect(owner?.reason).toBe("crash")
          const orphan = yield* SessionGeneration.getOwner(db, ids.orphanGen)
          expect(orphan?.reason).toBeNull()
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
