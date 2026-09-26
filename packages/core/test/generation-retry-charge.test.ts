import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
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

// Real SQLite proof that every generation-owning retry charge hits the same
// owner CAS: consumed increments atomically, exhaustion/closed/missing never
// increment, races serialize, close/crash preserve consumed without forging
// occurrence, and no charge emits changefeed.
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
  const dir = await mkdtemp(join(tmpdir(), "gen-charge-"))
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

const feedCount = (db: Database.Interface["db"]) =>
  db.select({ seq: SessionChangefeedTable.seq }).from(SessionChangefeedTable).all().pipe(Effect.orDie)

describe("generation retry charge CAS", () => {
  test("charges increment consumed, exhaustion fails closed without increment", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_01"))
          const gen = `gen_charge_${Date.now()}_01`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_01", 2).pipe(Effect.orDie)
          const before = ((yield* feedCount(db)) as unknown[]).length
          const c1 = yield* SessionGeneration.charge(db, sid, gen).pipe(Effect.orDie)
          expect(c1).toEqual({ charged: true, used: 1, limit: 2, missing: false, closed: false, exhausted: false, layer: null, nextAt: null })
          const c2 = yield* SessionGeneration.charge(db, sid, gen).pipe(Effect.orDie)
          expect(c2).toEqual({ charged: true, used: 2, limit: 2, missing: false, closed: false, exhausted: false, layer: null, nextAt: null })
          const c3 = yield* SessionGeneration.charge(db, sid, gen).pipe(Effect.orDie)
          expect(c3.charged).toBe(false)
          expect(c3.exhausted).toBe(true)
          expect(c3.used).toBe(2)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(2)
          expect(owner?.limit).toBe(2)
          expect(((yield* feedCount(db)) as unknown[]).length).toBe(before)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("missing owner reports missing without fabricating a row", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const res = yield* SessionGeneration.charge(db, sid, "gen_missing_charge").pipe(Effect.orDie)
          expect(res.missing).toBe(true)
          expect(res.charged).toBe(false)
          expect(yield* SessionGeneration.getOwner(db, "gen_missing_charge")).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("closed owner fails closed without increment", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_closed"))
          const gen = `gen_charge_closed_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_closed", 2).pipe(Effect.orDie)
          yield* SessionGeneration.charge(db, sid, gen).pipe(Effect.orDie)
          yield* SessionGeneration.close(db, sid, gen, "completed").pipe(Effect.orDie)
          const res = yield* SessionGeneration.charge(db, sid, gen).pipe(Effect.orDie)
          expect(res.charged).toBe(false)
          expect(res.closed).toBe(true)
          expect(res.used).toBe(1)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(1)
          expect(owner?.reason).toBe("completed")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("concurrent charges serialize to exactly limit with no overshoot", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_race"))
          const gen = `gen_charge_race_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_race", 2).pipe(Effect.orDie)
          const results = yield* Effect.all(
            Array.from({ length: 6 }, () => SessionGeneration.charge(db, sid, gen)),
            { concurrency: "unbounded" },
          )
          const wins = results.filter((r) => r.charged).length
          expect(wins).toBe(2)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(2)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("close and crash retain consumed and occurrence, close_time is receipt", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_crash"))
          const gen = `gen_charge_crash_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_crash", 2).pipe(Effect.orDie)
          yield* SessionGeneration.charge(db, sid, gen).pipe(Effect.orDie)
          const open = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          const feed = ((yield* feedCount(db)) as unknown[]).length
          return { sid: sid as unknown as string, gen, occurrence: open?.occurrence, feed }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedCount(db)) as unknown[]).length
          expect(before).toBe(ids.feed)
          const sweep = yield* SessionGeneration.convergeOrphaned(db)
          expect(sweep.converged).toEqual([ids.gen])
          const closed = yield* SessionGeneration.getOwner(db, ids.gen).pipe(Effect.orDie)
          expect(closed?.used).toBe(1)
          expect(closed?.limit).toBe(2)
          expect(closed?.reason).toBe("crash")
          expect(closed?.occurrence).toBe(ids.occurrence)
          expect(Number.isFinite(closed?.closedAt)).toBe(true)
          expect(closed?.closedAt).not.toBe(ids.occurrence)
          expect(((yield* feedCount(db)) as unknown[]).length).toBe(before)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("atomic charge persists layer plus nextAt; failed charge writes nothing", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_intent"))
          const gen = `gen_charge_intent_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_intent", 1).pipe(Effect.orDie)
          const before = ((yield* feedCount(db)) as unknown[]).length
          const occurrenceTime = Date.now()
          const nextAt = occurrenceTime + 1500
          const c1 = yield* SessionGeneration.charge(db, sid, gen, { layer: "provider", occurrenceTime, nextAt }).pipe(Effect.orDie)
          expect(c1).toEqual({ charged: true, used: 1, limit: 1, missing: false, closed: false, exhausted: false, layer: "provider", nextAt })
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(1)
          expect(owner?.layer).toBe("provider")
          expect(owner?.nextAt).toBe(nextAt)
          const intent = yield* SessionGeneration.getRetryIntent(db, gen).pipe(Effect.orDie)
          expect(intent).toEqual({ genID: gen, sessionID: sid, scope: sid, layer: "provider", nextAt, used: 1, limit: 1, replay: false })
          // Exhausted retry with a different layer must fail closed without overwriting the persisted intent.
          const c2 = yield* SessionGeneration.charge(db, sid, gen, { layer: "broker", occurrenceTime: nextAt, nextAt: nextAt + 500 }).pipe(Effect.orDie)
          expect(c2.charged).toBe(false)
          expect(c2.exhausted).toBe(true)
          expect(c2.layer).toBe("provider")
          expect(c2.nextAt).toBe(nextAt)
          const kept = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(kept?.layer).toBe("provider")
          expect(kept?.nextAt).toBe(nextAt)
          // Invalid schedule dies without writing (fail-closed at the budget layer).
          const bad = yield* SessionGeneration.charge(db, sid, gen, { layer: "provider", occurrenceTime: nextAt, nextAt: nextAt - 1 } as never).pipe(Effect.exit)
          expect(bad._tag).toBe("Failure")
          const kept2 = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(kept2?.layer).toBe("provider")
          expect(kept2?.nextAt).toBe(nextAt)
          expect(((yield* feedCount(db)) as unknown[]).length).toBe(before)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("concurrent layered charges serialize with last-writer intent and no overshoot", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_layer_race"))
          const gen = `gen_charge_layer_race_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_layer_race", 2).pipe(Effect.orDie)
          const base = Date.now()
          const layers = ["provider", "broker", "incomplete", "task", "provider", "broker"] as const
          const results = yield* Effect.all(
            layers.map((layer, i) =>
              SessionGeneration.charge(db, sid, gen, { layer, occurrenceTime: base, nextAt: base + 100 + i }),
            ),
            { concurrency: "unbounded" },
          )
          const wins = results.filter((r) => r.charged)
          expect(wins.length).toBe(2)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(2)
          expect(owner?.layer).not.toBeNull()
          expect(owner?.nextAt).not.toBeNull()
          const winnerNextAts = new Set(wins.map((w) => w.nextAt))
          expect(winnerNextAts.has(owner?.nextAt ?? -1)).toBe(true)
          const intent = yield* SessionGeneration.getRetryIntent(db, gen).pipe(Effect.orDie)
          expect(intent?.layer as unknown as string).toBe(owner?.layer as unknown as string)
          expect(intent?.nextAt as unknown as number).toBe(owner?.nextAt as unknown as number)
          expect(intent?.replay).toBe(false)
          expect(intent?.scope).toBe(sid as unknown as string)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("close and crash clear pending nextAt but retain last-layer provenance; intent reads undefined", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_terminal"))
          const gen = `gen_charge_terminal_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_terminal", 2).pipe(Effect.orDie)
          // No intent before any charge.
          expect(yield* SessionGeneration.getRetryIntent(db, gen)).toBeUndefined()
          const occurrenceTime = Date.now()
          const nextAt = occurrenceTime + 800
          yield* SessionGeneration.charge(db, sid, gen, { layer: "incomplete", occurrenceTime, nextAt }).pipe(Effect.orDie)
          expect((yield* SessionGeneration.getRetryIntent(db, gen).pipe(Effect.orDie))?.nextAt).toBe(nextAt)
          yield* SessionGeneration.close(db, sid, gen, "completed").pipe(Effect.orDie)
          const closed = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(closed?.reason).toBe("completed")
          expect(closed?.used).toBe(1)
          expect(closed?.layer).toBe("incomplete")
          expect(closed?.nextAt).toBeNull()
          expect(yield* SessionGeneration.getRetryIntent(db, gen)).toBeUndefined()
          const after = yield* SessionGeneration.charge(db, sid, gen, { layer: "broker", occurrenceTime: nextAt, nextAt: nextAt + 100 }).pipe(Effect.orDie)
          expect(after.charged).toBe(false)
          expect(after.closed).toBe(true)
          expect(after.nextAt).toBeNull()
          // Missing rows carry no intent and fabricate nothing.
          expect(yield* SessionGeneration.getRetryIntent(db, "gen_missing_intent").pipe(Effect.orDie)).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("crash sweep clears pending intent while retaining layer and consumed", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_charge_crash_intent"))
          const gen = `gen_charge_crash_intent_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_charge_crash_intent", 2).pipe(Effect.orDie)
          const occurrenceTime = Date.now()
          const nextAt = occurrenceTime + 900
          yield* SessionGeneration.charge(db, sid, gen, { layer: "broker", occurrenceTime, nextAt }).pipe(Effect.orDie)
          return { gen, nextAt }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const sweep = yield* SessionGeneration.convergeOrphaned(db)
          expect(sweep.converged).toEqual([ids.gen])
          const closed = yield* SessionGeneration.getOwner(db, ids.gen).pipe(Effect.orDie)
          expect(closed?.reason).toBe("crash")
          expect(closed?.used).toBe(1)
          expect(closed?.layer).toBe("broker")
          expect(closed?.nextAt).toBeNull()
          expect(yield* SessionGeneration.getRetryIntent(db, ids.gen)).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
