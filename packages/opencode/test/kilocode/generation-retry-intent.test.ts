// kilocode_change - durable retry layer + next-at occurrence intent: one atomic
// CAS persists charge + layer + nextAt; wait/occurrence computed first from the
// existing error/retry-after policy, only CAS success reaches set/sleep/next
// dispatch. Terminal close/crash clears pending nextAt while retaining
// consumed/last-layer provenance; the legacy panel recovery_next_at stays null.
import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Duration, Effect, Exit, Layer, Schedule } from "effect"
import * as Stream from "effect/Stream"
import { HttpBody, HttpClientRequest } from "effect/unstable/http"
import { Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { KiloRetryBudget } from "@/kilocode/session/retry-budget"
import { KiloSessionProcessor } from "@/kilocode/session/processor"
import { KiloTaskRetry } from "@/kilocode/tool/task-retry"
import { SessionRetry } from "@/session/retry"
import { SessionID } from "@/session/schema"
import type { Session as SessionSvc } from "@/session/session"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { make as makeExecutor } from "@/kilocode/provider/canonical-request-executor"

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
  const dir = await mkdtemp(join(tmpdir(), "gen-retry-intent-"))
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

function retryable(): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "0" },
    }).toObject(),
  )
}

describe("durable retry layer + next-at intent (real SQLite)", () => {
  test("provider policy persists layer and set.next atomically; exhaustion sends no new set", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_intent_provider"))
          const gen = `gen_intent_provider_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_intent_provider", 1).pipe(Effect.orDie)
          const budget = KiloRetryBudget.make(1)
          const binding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: gen, kind: "strict" }
          const seen: number[] = []
          const schedule = SessionRetry.policy({
            provider: "test",
            parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
            set: (info) => {
              seen.push(info.next)
              return Effect.void
            },
            budget,
          })
          const step = yield* Schedule.toStep(schedule)
          const err = retryable()
          const provide = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
            fx.pipe(
              Effect.provideService(KiloRetryBudget.Owner, budget),
              Effect.provideService(KiloRetryBudget.Durable, binding),
            )
          const first = yield* provide(step(0, err)).pipe(Effect.exit)
          expect(Exit.isSuccess(first)).toBe(true)
          expect(seen.length).toBe(1)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(1)
          expect(owner?.layer).toBe("provider")
          expect(owner?.nextAt).toBe(seen[0])
          const intent = yield* SessionGeneration.getRetryIntent(db, gen).pipe(Effect.orDie)
          expect(intent?.layer).toBe("provider")
          expect(intent?.nextAt).toBe(seen[0])
          expect(intent?.replay).toBe(false)
          expect(intent?.scope).toBe(sid as unknown as string)
          // Exhaustion: no second set, no new network, intent unchanged.
          const second = yield* provide(step(0, err)).pipe(Effect.exit)
          expect(Exit.isFailure(second)).toBe(true)
          expect(seen.length).toBe(1)
          const kept = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(kept?.layer).toBe("provider")
          expect(kept?.nextAt).toBe(seen[0])
          // Legacy panel stub is never filled from owner intent.
          const row = (yield* db
            .select()
            .from(SessionOperationTable)
            .where(eq(SessionOperationTable.op_id, SessionOperation.promptId("msg_intent_provider")))
            .get()
            .pipe(Effect.orDie)) as unknown as Record<string, unknown>
          expect(row["recovery_next_at"]).toBeNull()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("incomplete recovery persists layer; DB defect sends no set/sleep/dispatch", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_intent_incomplete"))
          const gen = `gen_intent_incomplete_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_intent_incomplete", 2).pipe(Effect.orDie)
          const budget = KiloRetryBudget.make(2)
          const binding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: gen, kind: "strict" }
          const noWait = spyOn(SessionRetry, "delay").mockReturnValue(0)
          let runs = 0
          let sets: number[] = []
          let discards = 0
          const out = yield* KiloSessionProcessor.recover({
            run: () =>
              Effect.gen(function* () {
                runs += 1
                if (runs === 1) return yield* Effect.fail(new KiloSessionProcessor.IncompleteResponseError())
              }),
            replayable: () => runs < 2,
            discard: () => Effect.sync(() => { discards += 1 }),
            set: (info) => Effect.sync(() => { sets.push(info.next) }),
            budget,
          }).pipe(Effect.provideService(KiloRetryBudget.Durable, binding), Effect.exit)
          noWait.mockRestore()
          expect(Exit.isSuccess(out)).toBe(true)
          expect(runs).toBe(2)
          expect(discards).toBe(1)
          expect(sets.length).toBe(1)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(1)
          expect(owner?.layer).toBe("incomplete")
          expect(owner?.nextAt).toBe(sets[0])
          // Broken DB: charge fails closed with no set and no second run.
          const broken: KiloRetryBudget.Binding = { db: {} as never, sessionID: sid, genID: gen, kind: "strict" }
          let runs2 = 0
          let sets2 = 0
          const out2 = yield* KiloSessionProcessor.recover({
            run: () =>
              Effect.gen(function* () {
                runs2 += 1
                return yield* Effect.fail(new KiloSessionProcessor.IncompleteResponseError())
              }),
            replayable: () => true,
            discard: () => Effect.void,
            set: () => Effect.sync(() => { sets2 += 1 }),
            budget: KiloRetryBudget.make(2),
          }).pipe(Effect.provideService(KiloRetryBudget.Durable, broken), Effect.exit)
          expect(Exit.isFailure(out2)).toBe(true)
          expect(runs2).toBe(1)
          expect(sets2).toBe(0)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("broker inner retry persists broker layer; failure sends no new broker call", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_intent_broker"))
          const gen = `gen_intent_broker_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_intent_broker", 1).pipe(Effect.orDie)
          const budget = KiloRetryBudget.make(1)
          const binding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: gen, kind: "strict" }
          const ctx = {
            providerId: "acme",
            modelId: "m1",
            record: {
              name: "Acme",
              endpoint: "https://api.example.com/v1",
              protocol: "openai/completions" as const,
              models: { m1: { name: "M1" } },
              credential: "secret:kilo.credentials.global.provider.acme",
            },
          }
          const body = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
          const request = () => {
            const base = HttpClientRequest.post("https://api.example.com/v1/chat/completions")
            return HttpClientRequest.setBody(base, HttpBody.text(body, "application/json"))
          }
          const counter = { count: 0 }
          const failing: Broker.Broker = {
            stream: () => {
              counter.count += 1
              return Effect.succeed({ status: 429, headers: { "retry-after-ms": "0" }, stream: Stream.succeed(new TextEncoder().encode("limited")) })
            },
            execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "unused" })),
          }
          const executor = makeExecutor(ctx, failing)
          const exit = yield* executor.execute(request()).pipe(
            Effect.provideService(KiloRetryBudget.Owner, budget),
            Effect.provideService(KiloRetryBudget.Durable, binding),
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(counter.count).toBe(2)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(1)
          expect(owner?.layer).toBe("broker")
          expect(Number.isFinite(owner?.nextAt)).toBe(true)
          // Broken DB: only the free initial broker call runs, no charged retry.
          const gen2 = `gen_intent_broker_broken_${Date.now()}`
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_intent_broker_broken"))
          yield* SessionGeneration.begin(db, sid, gen2, "msg_intent_broker_broken", 1).pipe(Effect.orDie)
          const broken: KiloRetryBudget.Binding = { db: {} as never, sessionID: sid, genID: gen2, kind: "strict" }
          const budget2 = KiloRetryBudget.make(1)
          const counter2 = { count: 0 }
          const failing2: Broker.Broker = {
            stream: () => {
              counter2.count += 1
              return Effect.succeed({ status: 500, headers: {}, stream: Stream.succeed(new TextEncoder().encode("err")) })
            },
            execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "unused" })),
          }
          const exit2 = yield* makeExecutor(ctx, failing2).execute(request()).pipe(
            Effect.provideService(KiloRetryBudget.Owner, budget2),
            Effect.provideService(KiloRetryBudget.Durable, broken),
            Effect.exit,
          )
          expect(Exit.isFailure(exit2)).toBe(true)
          expect(counter2.count).toBe(1)
          expect(budget2.used).toBe(0)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("task retry charges parent with task layer; child keeps its own layer", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_parent_intent"))
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_child_intent"))
          const parentGen = `gen_parent_intent_${Date.now()}`
          const childGen = `gen_child_intent_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, parentGen, "msg_parent_intent", 2).pipe(Effect.orDie)
          yield* SessionGeneration.begin(db, sid, childGen, "msg_child_intent", 2).pipe(Effect.orDie)
          const parentBudget = KiloRetryBudget.make(2)
          const parentBinding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: parentGen, kind: "strict" }
          const childBinding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: childGen, kind: "strict" }
          const sessions = { messages: () => Effect.succeed([]) } as unknown as SessionSvc.Interface
          const childID = SessionID.make("ses_child_intent")
          let attempts = 0
          const ok = { info: { role: "assistant" } } as unknown as SessionV1.WithParts
          const out = yield* KiloTaskRetry.recover({
            error: retryable(),
            sessions,
            sessionID: childID,
            attempt: () =>
              Effect.gen(function* () {
                attempts += 1
                const childBudget = KiloRetryBudget.make(2)
                expect(yield* KiloRetryBudget.chargeShared(childBudget, "provider", childBinding, { occurrenceTime: Date.now(), nextAt: Date.now() + 5 })).toBe(true)
                return ok
              }),
            wait: () => Duration.millis(0),
            budget: parentBudget,
            durable: parentBinding,
          })
          expect(out).toBe(ok)
          expect(attempts).toBe(1)
          const parent = yield* SessionGeneration.getOwner(db, parentGen).pipe(Effect.orDie)
          const child = yield* SessionGeneration.getOwner(db, childGen).pipe(Effect.orDie)
          expect(parent?.used).toBe(1)
          expect(parent?.layer).toBe("task")
          expect(Number.isFinite(parent?.nextAt)).toBe(true)
          expect(parentBudget.used).toBe(1)
          expect(child?.used).toBe(1)
          expect(child?.layer).toBe("provider")
          // Broken parent: no sleep/attempt, child untouched.
          const broken: KiloRetryBudget.Binding = { db: {} as never, sessionID: sid, genID: parentGen, kind: "strict" }
          let attempts2 = 0
          const out2 = yield* KiloTaskRetry.recover({
            error: retryable(),
            sessions,
            sessionID: childID,
            attempt: () => Effect.sync(() => { attempts2 += 1; return ok }),
            wait: () => Duration.millis(0),
            budget: KiloRetryBudget.make(2),
            durable: broken,
          })
          expect(out2).toBeUndefined()
          expect(attempts2).toBe(0)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("strict missing fails closed with no network and close clears pending intent", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const budget = KiloRetryBudget.make(2)
          const strict: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: "gen_intent_missing", kind: "strict" }
          let network = 0
          const guarded = Effect.gen(function* () {
            const ok = yield* KiloRetryBudget.chargeShared(budget, "provider", strict, { occurrenceTime: Date.now(), nextAt: Date.now() + 10 })
            if (!ok) return "blocked" as const
            network += 1
            return "called" as const
          })
          expect(yield* guarded).toBe("blocked")
          expect(network).toBe(0)
          expect(budget.used).toBe(0)
          expect(yield* SessionGeneration.getOwner(db, "gen_intent_missing").pipe(Effect.orDie)).toBeUndefined()
          expect(yield* SessionGeneration.getRetryIntent(db, "gen_intent_missing").pipe(Effect.orDie)).toBeUndefined()
          // Close clears pending intent while retaining provenance.
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_intent_close"))
          const gen = `gen_intent_close_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_intent_close", 2).pipe(Effect.orDie)
          const closeBudget = KiloRetryBudget.make(2)
          const closeBinding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: gen, kind: "strict" }
          expect(yield* KiloRetryBudget.chargeShared(closeBudget, "provider", closeBinding, { occurrenceTime: Date.now(), nextAt: Date.now() + 10 })).toBe(true)
          yield* SessionGeneration.close(db, sid, gen, "completed").pipe(Effect.orDie)
          const closed = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(closed?.layer).toBe("provider")
          expect(closed?.nextAt).toBeNull()
          expect(yield* SessionGeneration.getRetryIntent(db, gen).pipe(Effect.orDie)).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
