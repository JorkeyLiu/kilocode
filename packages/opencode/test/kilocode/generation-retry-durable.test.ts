// kilocode_change - durable retry charges: strict generation-owning retries
// CAS-charge the same SQLite owner before the next dispatch via the production
// Runner path. Strict bindings fail closed on missing/closed/DB error with no
// network and no memory fallback; memory-only bindings (legacy ownerless, no
// accepted prompt row) stay bounded in memory without touching the DB. Only
// the shared consumed counter is persisted; layer attribution and next-at stay
// in-memory with no scheduler/ledger/replay.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schedule, Scope } from "effect"
import * as Stream from "effect/Stream"
import { HttpBody, HttpClientRequest } from "effect/unstable/http"
import { Schema } from "effect"
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
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { KiloRetryBudget } from "@/kilocode/session/retry-budget"
import { KiloTaskRetry } from "@/kilocode/tool/task-retry"
import { SessionRetry } from "@/session/retry"
import { MessageID, SessionID } from "@/session/schema"
import type { Session as SessionSvc } from "@/session/session"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { make as makeExecutor } from "@/kilocode/provider/canonical-request-executor"
import { LLMError } from "@opencode-ai/llm"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"

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
  const dir = await mkdtemp(join(tmpdir(), "gen-retry-durable-"))
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

describe("durable generation retry charges via production Runner path", () => {
  test("1:N adopted prompts share one owner; provider/incomplete/broker/task layers charge same row", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as SessionID
          const base = MessageID.make("msg_durable_base_01")
          const extra = MessageID.make("msg_durable_extra_01")
          yield* SessionOperation.ensurePromptInFlight(db, sid as never, SessionOperation.promptId(base as string))
          yield* SessionOperation.ensurePromptInFlight(db, sid as never, SessionOperation.promptId(extra as string))
          const scope = yield* Scope.Scope
          const runner = Runner.make<string>(scope)
          const done = yield* Deferred.make<string>()
          const started = yield* Deferred.make<void>()
          const extraReady = yield* Deferred.make<void>()
          const fiber = yield* KiloSessionPromptQueue.enqueue(
            sid,
            base,
            Effect.gen(function* () {
              return yield* runner.ensureRunning({
                prelude: (gen: string) =>
                  Effect.gen(function* () {
                    yield* SessionGeneration.begin(db, sid as never, gen, base as string, 4).pipe(Effect.orDie)
                  }),
                body: (gen: string) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined).pipe(Effect.ignore)
                    yield* awaitWithTimeout(Deferred.await(extraReady), "extra prompt never queued", "5 seconds")
                    yield* pollWithTimeout(
                      Effect.sync(() =>
                        KiloSessionPromptQueue._isQueued(sid, extra) || KiloSessionPromptQueue._isAdopted(sid, extra)
                          ? (true as const)
                          : undefined,
                      ),
                      "extra prompt never reached the queue",
                    )
                    const budget = KiloRetryBudget.make(4)
                    const binding: KiloRetryBudget.Binding = {
                      db: db as never,
                      sessionID: sid as never,
                      genID: gen,
                      kind: "strict",
                    }
                    const adopted = KiloSessionPromptQueue.adopt(sid)
                    expect(adopted).toEqual([extra])
                    if (adopted.length > 0) {
                      yield* SessionGeneration.add(db, sid as never, gen, adopted as unknown as string[]).pipe(Effect.orDie)
                    }
                    const members = yield* SessionGeneration.listMembers(db, gen)
                    expect(members.map((m) => m.promptOpID).sort()).toEqual(
                      [SessionOperation.promptId(base as string), SessionOperation.promptId(extra as string)].sort(),
                    )
                    const layers: KiloRetryBudget.Layer[] = ["provider", "incomplete", "broker", "task"]
                    for (const layer of layers) {
                      const ok = yield* Effect.provideService(
                        KiloRetryBudget.chargeShared(budget, layer),
                        KiloRetryBudget.Durable,
                        binding,
                      )
                      expect(ok).toBe(true)
                    }
                    const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
                    expect(owner?.used).toBe(4)
                    expect(owner?.limit).toBe(4)
                    expect(budget.used).toBe(4)
                    yield* SessionGeneration.close(db, sid as never, gen, "completed").pipe(Effect.orDie)
                    yield* Deferred.succeed(done, gen)
                    return "ok"
                  }).pipe(
                    Effect.provideService(KiloRetryBudget.Owner, KiloRetryBudget.make(4)),
                    Effect.provideService(KiloRetryBudget.Durable, {
                      db: db as never,
                      sessionID: sid as never,
                      genID: "__placeholder__",
                      kind: "strict",
                    }),
                  ) as Effect.Effect<string>,
              })
            }),
            Effect.succeed("settled"),
          ).pipe(Effect.forkChild)
          yield* awaitWithTimeout(Deferred.await(started), "generation body never started", "5 seconds")
          yield* Effect.ignore(Effect.forkChild(KiloSessionPromptQueue.enqueue(sid, extra, Effect.succeed("e1"), Effect.succeed("e1s"))))
          yield* pollWithTimeout(
            Effect.sync(() =>
              KiloSessionPromptQueue._isQueued(sid, extra) ? (true as const) : undefined,
            ),
            "extra prompt never reached pending",
          )
          yield* Deferred.succeed(extraReady, undefined).pipe(Effect.ignore)
          const gen = yield* awaitWithTimeout(Deferred.await(done), "generation never completed", "5 seconds")
          yield* Fiber.join(fiber)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(4)
          expect(owner?.reason).toBe("completed")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("exhausted owner starts zero new network calls; DB failure/closed fails closed", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_durable_exh"))
          const gen = `gen_durable_exh_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_durable_exh", 1).pipe(Effect.orDie)
          const budget = KiloRetryBudget.make(1)
          const binding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: gen, kind: "strict" }
          let network = 0
          const guardedCall = (layer: KiloRetryBudget.Layer) =>
            Effect.gen(function* () {
              const ok = yield* KiloRetryBudget.chargeShared(budget, layer, binding)
              if (!ok) return "blocked" as const
              network += 1
              return "called" as const
            })
          expect(yield* guardedCall("provider")).toBe("called")
          expect(network).toBe(1)
          expect(yield* guardedCall("broker")).toBe("blocked")
          expect(network).toBe(1)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(1)
          expect(budget.used).toBe(1)
          yield* SessionGeneration.close(db, sid, gen, "completed").pipe(Effect.orDie)
          expect(yield* guardedCall("incomplete")).toBe("blocked")
          expect(network).toBe(1)
          expect(budget.used).toBe(1)
          const broken = { ...binding, db: {} as never }
          const before = budget.used
          expect(yield* KiloRetryBudget.chargeShared(budget, "broker", broken)).toBe(false)
          expect(budget.used).toBe(before)
          expect(network).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("strict missing owner fails closed with no network and no memory fallback", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const budget = KiloRetryBudget.make(2)
          const strict: KiloRetryBudget.Binding = {
            db: db as never,
            sessionID: sid,
            genID: "gen_strict_missing_no_row",
            kind: "strict",
          }
          let network = 0
          const guarded = Effect.gen(function* () {
            const ok = yield* KiloRetryBudget.chargeShared(budget, "provider", strict)
            if (!ok) return "blocked" as const
            network += 1
            return "called" as const
          })
          expect(yield* guarded).toBe("blocked")
          expect(network).toBe(0)
          expect(budget.used).toBe(0)
          expect(yield* SessionGeneration.getOwner(db, "gen_strict_missing_no_row").pipe(Effect.orDie)).toBeUndefined()
          expect(yield* KiloRetryBudget.exhaustedShared(budget).pipe(Effect.provideService(KiloRetryBudget.Durable, strict))).toBe(true)
          expect(budget.used).toBe(0)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("accepted-but-ownerless stays strict while legacy ownerless stays memory-only", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_accepted_ownerless"))
          const acceptedStrict: KiloRetryBudget.Binding = {
            db: db as never,
            sessionID: sid,
            genID: "gen_accepted_but_ownerless",
            kind: "strict",
          }
          const acceptedBudget = KiloRetryBudget.make(2)
          let acceptedNetwork = 0
          const acceptedGuarded = Effect.gen(function* () {
            const ok = yield* KiloRetryBudget.chargeShared(acceptedBudget, "provider", acceptedStrict)
            if (!ok) return "blocked" as const
            acceptedNetwork += 1
            return "called" as const
          })
          expect(yield* acceptedGuarded).toBe("blocked")
          expect(acceptedNetwork).toBe(0)
          expect(acceptedBudget.used).toBe(0)
          expect(yield* SessionGeneration.getOwner(db, "gen_accepted_but_ownerless").pipe(Effect.orDie)).toBeUndefined()
          const legacyMemory: KiloRetryBudget.Binding = {
            db: db as never,
            sessionID: sid,
            genID: "gen_legacy_ownerless",
            kind: "memory",
          }
          const legacyBudget = KiloRetryBudget.make(2)
          expect(yield* KiloRetryBudget.chargeShared(legacyBudget, "provider", legacyMemory)).toBe(true)
          expect(yield* KiloRetryBudget.chargeShared(legacyBudget, "broker", legacyMemory)).toBe(true)
          expect(yield* KiloRetryBudget.chargeShared(legacyBudget, "incomplete", legacyMemory)).toBe(false)
          expect(legacyBudget.used).toBe(2)
          expect(yield* SessionGeneration.getOwner(db, "gen_legacy_ownerless").pipe(Effect.orDie)).toBeUndefined()
          const ambientBudget = KiloRetryBudget.make(1)
          expect(
            yield* KiloRetryBudget.chargeShared(ambientBudget, "provider").pipe(
              Effect.provideService(KiloRetryBudget.Durable, legacyMemory),
            ),
          ).toBe(true)
          expect(ambientBudget.used).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("concurrent strict charges serialize to exactly limit with monotonic memory mirror", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_durable_concurrent"))
          const gen = `gen_durable_concurrent_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_durable_concurrent", 3).pipe(Effect.orDie)
          const budget = KiloRetryBudget.make(3)
          const binding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: gen, kind: "strict" }
          const results = yield* Effect.all(
            Array.from({ length: 8 }, (_, i) =>
              KiloRetryBudget.chargeShared(budget, (["provider", "incomplete", "broker", "task"] as const)[i % 4]!, binding),
            ),
            { concurrency: "unbounded" },
          )
          const wins = results.filter((r) => r).length
          expect(wins).toBe(3)
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(3)
          expect(owner?.limit).toBe(3)
          expect(budget.used).toBe(3)
          expect(budget.used).toBeLessThanOrEqual(budget.limit)
          expect(budget.used).toBeLessThanOrEqual(owner?.limit ?? 3)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("SessionRetry.policy with durable binding charges DB and stops at the shared bound", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_durable_policy"))
          const gen = `gen_durable_policy_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_durable_policy", 1).pipe(Effect.orDie)
          const budget = KiloRetryBudget.make(1)
          const binding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: gen, kind: "strict" }
          const calls: number[] = []
          const schedule = SessionRetry.policy({
            provider: "test",
            parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
            set: (info) => {
              calls.push(info.attempt)
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
          const second = yield* provide(step(0, err)).pipe(Effect.exit)
          expect(Exit.isSuccess(first)).toBe(true)
          expect(Exit.isFailure(second)).toBe(true)
          expect(calls).toEqual([1])
          const owner = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(owner?.used).toBe(1)
          expect(budget.used).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("canonical broker inner retries charge the same durable owner", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_durable_broker"))
          const gen = `gen_durable_broker_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_durable_broker", 1).pipe(Effect.orDie)
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
          expect(budget.used).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("parent restarts charge the parent row, never the child row", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_parent_task"))
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_child_task"))
          const parentGen = `gen_parent_${Date.now()}`
          const childGen = `gen_child_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, parentGen, "msg_parent_task", 2).pipe(Effect.orDie)
          yield* SessionGeneration.begin(db, sid, childGen, "msg_child_task", 2).pipe(Effect.orDie)
          const parentBudget = KiloRetryBudget.make(2)
          const parentBinding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: parentGen, kind: "strict" }
          const childBinding: KiloRetryBudget.Binding = { db: db as never, sessionID: sid, genID: childGen, kind: "strict" }
          const sessions = { messages: () => Effect.succeed([]) } as unknown as SessionSvc.Interface
          const childID = SessionID.make("ses_child_durable")
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
                expect(yield* KiloRetryBudget.chargeShared(childBudget, "provider", childBinding)).toBe(true)
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
          expect(parentBudget.used).toBe(1)
          expect(child?.used).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
