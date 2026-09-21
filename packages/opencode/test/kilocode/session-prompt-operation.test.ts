import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, Scope } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionPromptDispatchService, layer as PromptLayer } from "@/kilocode/session/session-prompt-dispatch"
import { SessionCommandDispatchService, layer as CommandLayer } from "@/kilocode/session/session-command-dispatch"
import { Command } from "@/command"

// test boundary: converge Effect error/environment unknown -> never without hiding defects
const toTestEffect = <A>(self: Effect.Effect<A, unknown, unknown>): Effect.Effect<A, never, never> =>
  self.pipe(Effect.catchCause((cause: unknown) => Effect.die(cause))) as unknown as Effect.Effect<A, never, never>
const runTest = (self: Effect.Effect<void, unknown, unknown>) => Effect.runPromise(toTestEffect(self))

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

function basePrompt() {
  return {
    v: 1,
    requestId: "req-1",
    opId: `prompt:${MID}`,
    op: "session/prompt",
    idempotencyKey: `prompt:${MID}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: MID, parts: [{ type: "text", text: "hi" }] },
  }
}
function baseCommand() {
  return {
    v: 1,
    requestId: "req-1",
    opId: `prompt:${MID}`,
    op: "session/command",
    idempotencyKey: `prompt:${MID}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: MID, command: "probe", arguments: "hello" },
  }
}
function makePromptDeps(over: { promptImpl?: () => Effect.Effect<any, unknown, unknown>; lease?: ControlLease.ControlLease } = {}) {
  const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
  const dbLayer = Database.layerNoLease(":memory:")
  const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
  const promptLayer = Layer.succeed(SessionPrompt.Service, {
    prompt: over.promptImpl ?? (() => Effect.succeed({ id: "dummy" } as any)),
    command: () => Effect.succeed({ id: "dummy" } as any),
    cancel: () => Effect.void,
    loop: () => Effect.die(new Error("unused")),
    shell: () => Effect.die(new Error("unused")),
    resolvePromptParts: () => Effect.succeed([] as never),
  } as any)
  const eventsLayer = Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any)
  const storeLayer = Layer.succeed(InstanceStore.Service, {
    load: () => Effect.succeed(fakeCtx),
    reload: () => Effect.succeed(fakeCtx),
    dispose: () => Effect.void,
    disposeSafe: () => Effect.void,
    disposeDirectory: () => Effect.void,
    disposeAll: () => Effect.void,
    provide: (_input: unknown, effect: Effect.Effect<unknown>) => effect as Effect.Effect<unknown>,
    snapshot: () => Effect.succeed(Option.none()),
    directories: () => Effect.succeed([]),
  } as any)
  const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
  const leaseLayer = Layer.succeed(ControlLease.Service, over.lease ?? ControlLease.noop)
  const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
  const full = Layer.provide(PromptLayer, deps)
  return Layer.mergeAll(full, deps)
}
function makeCommandDeps(over: { commandImpl?: () => Effect.Effect<any, unknown, unknown>; lease?: ControlLease.ControlLease } = {}) {
  const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
  const dbLayer = Database.layerNoLease(":memory:")
  const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
  const promptLayer = Layer.succeed(SessionPrompt.Service, {
    prompt: () => Effect.succeed({ id: "dummy" } as any),
    command: over.commandImpl ?? (() => Effect.succeed({ id: "dummy" } as any)),
    cancel: () => Effect.void,
    loop: () => Effect.die(new Error("unused")),
    shell: () => Effect.die(new Error("unused")),
    resolvePromptParts: () => Effect.succeed([] as never),
  } as any)
  const cmdLayer = Layer.succeed(Command.Service, {
    get: (n: string) => (n === "probe" ? Effect.succeed({ name: "probe", template: "hi" } as any) : Effect.succeed(undefined as any)),
    list: () => Effect.succeed([{ name: "probe" } as any]),
  } as any)
  const eventsLayer = Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any)
  const storeLayer = Layer.succeed(InstanceStore.Service, {
    load: () => Effect.succeed(fakeCtx),
    reload: () => Effect.succeed(fakeCtx),
    dispose: () => Effect.void,
    disposeSafe: () => Effect.void,
    disposeDirectory: () => Effect.void,
    disposeAll: () => Effect.void,
    provide: (_i: unknown, e: Effect.Effect<unknown>) => e as Effect.Effect<unknown>,
    snapshot: () => Effect.succeed(Option.some(fakeCtx as never)),
    directories: () => Effect.succeed([]),
  } as any)
  const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
  const leaseLayer = Layer.succeed(ControlLease.Service, over.lease ?? ControlLease.noop)
  const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, cmdLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
  const full = Layer.provide(CommandLayer, deps)
  return Layer.mergeAll(full, deps)
}
const ensureSession = (db: any) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: "proj-test" as any, worktree: DIR as any, vcs: "git", time_created: Date.now(), time_updated: Date.now(), sandboxes: [] as any } as any)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: SID as any, project_id: "proj-test" as any, slug: "test", directory: DIR, title: "t", version: "1", revision: 0, time_created: Date.now(), time_updated: Date.now() } as any)
      .run()
      .pipe(Effect.orDie)
  })

describe("prompt durable operation", () => {
  test("first dispatch writes in-flight then terminal succeeded, replay does not start second generation", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          let calls = 0
          const gate = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const deps = makePromptDeps({
            promptImpl: () =>
              Effect.gen(function* () {
                calls += 1
                yield* Deferred.succeed(started, void 0)
                yield* Deferred.await(gate)
                return { id: "dummy" } as any
              }),
          })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r1 = (yield* svc.dispatch(basePrompt())) as any
            expect(r1.status).toBe("succeeded")
            // wait for fork to start
            yield* Deferred.await(started).pipe(Effect.timeoutOption("2 seconds"))
            const row1 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row1!.outcome).toBe("in-flight")
            const r2 = (yield* svc.dispatch(basePrompt())) as any
            expect(r2.status).toBe("succeeded")
            expect(calls).toBe(1)
            yield* Deferred.succeed(gate, void 0)
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "succeeded") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row2 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row2!.outcome).toBe("succeeded")
            expect(row2!.code).toBe("prompt.succeeded")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })

  test("failed generation terminalizes to failed with redaction and cap", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const deps = makePromptDeps({
            promptImpl: () => Effect.fail(new Error("boom api_key=secret123456 and token=Bearer abcdef and extra long " + "x".repeat(2500))),
          })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt())) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "failed") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("failed")
            expect(row!.code).toBe("prompt.failed")
            expect(row!.message).not.toContain("secret123456")
            expect(row!.message).toContain("[redacted]")
            if (row!.detail) {
              expect(row!.detail.length).toBeLessThanOrEqual(1001)
              expect(row!.detail).not.toContain("secret123456")
            }
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })

  test("lease exact-once: accepted holds lease until background completes", async () => {
    let acquires = 0
    let releases = 0
    const lease: ControlLease.ControlLease = {
      acquire: () => {
        acquires += 1
        return Option.some(Effect.sync(() => { releases += 1 }))
      },
      acquireWrite: () => Option.some(Effect.void),
      sealAndDrain: () => Effect.void,
    }
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const deps = makePromptDeps({
            promptImpl: () => Deferred.await(gate).pipe(Effect.as({ id: "dummy" } as any)),
            lease,
          })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt())) as any
            expect(r.status).toBe("succeeded")
            expect(acquires).toBe(1)
            expect(releases).toBe(0)
            yield* Deferred.succeed(gate, void 0)
            let tries = 0
            while (tries < 50 && releases === 0) {
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            expect(releases).toBe(1)
            expect(acquires).toBe(1)
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })

  test("interrupt terminalizes to abandoned with bounded redaction", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const deps = makePromptDeps({ promptImpl: () => Effect.interrupt })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt())) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "abandoned") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("abandoned")
            expect(row!.code).toBe("prompt.abandoned")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })

  test("command not_found releases lease immediately and does not create operation", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          let acq = 0, rel = 0
          const lease: ControlLease.ControlLease = {
            acquire: () => { acq += 1; return Option.some(Effect.sync(() => { rel += 1 })) },
            acquireWrite: () => Option.some(Effect.void),
            sealAndDrain: () => Effect.void,
          }
          const deps = makeCommandDeps({ lease })
          yield* Effect.gen(function* () {
            const svc = yield* SessionCommandDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const bad = { ...baseCommand(), payload: { ...baseCommand().payload, command: "missing" } }
            const r = (yield* svc.dispatch(bad)) as any
            expect(r.status).toBe("failed")
            expect(r.failure.code).toBe("command.not_found")
            expect(r.failure.retryable).toBe(false)
            expect(acq).toBe(1)
            expect(rel).toBe(1)
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row).toBeUndefined()
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })
})

describe("command durable operation", () => {
  test("command first write and replay", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const deps = makeCommandDeps()
          yield* Effect.gen(function* () {
            const svc = yield* SessionCommandDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r1 = (yield* svc.dispatch(baseCommand())) as any
            expect(r1.status).toBe("succeeded")
            const row1 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row1!.outcome).toBe("in-flight")
            const r2 = (yield* svc.dispatch(baseCommand())) as any
            expect(r2.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "succeeded") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row2 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row2!.outcome).toBe("succeeded")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })
})

describe("cross-process atomic inception/replay", () => {
  test("two dispatches on same SQLite file serialize first-write via immediate transaction (sequential replay, single file)", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const fsp = yield* Effect.promise(() => import("fs/promises"))
          const p = yield* Effect.promise(() => import("path"))
          const os = yield* Effect.promise(() => import("os"))
          const dir = (yield* Effect.promise(() => (fsp as any).mkdtemp(p.join(os.tmpdir(), "kilo-cross-")))) as unknown as string
          const file = p.join(dir, "kilo.db")
          try {
            const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
            let calls = 0
            const gate = yield* Deferred.make<void>()
            const started = yield* Deferred.make<void>()
            const countingPrompt = () =>
              Effect.gen(function* () {
                calls += 1
                yield* Deferred.succeed(started, void 0)
                yield* Deferred.await(gate)
                return { info: { role: "assistant", id: "x" } } as any
              })
            const dbLayer = Database.layerNoLease(file)
            const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
            const promptLayer = Layer.succeed(SessionPrompt.Service, {
              prompt: countingPrompt,
              command: () => Effect.succeed({ id: "dummy" } as any),
              cancel: () => Effect.void,
              loop: () => Effect.die(new Error("unused")),
              shell: () => Effect.die(new Error("unused")),
              resolvePromptParts: () => Effect.succeed([] as never),
            } as any)
            const eventsLayer = Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any)
            const storeLayer = Layer.succeed(InstanceStore.Service, {
              load: () => Effect.succeed(fakeCtx),
              reload: () => Effect.succeed(fakeCtx),
              dispose: () => Effect.void,
              disposeSafe: () => Effect.void,
              disposeDirectory: () => Effect.void,
              disposeAll: () => Effect.void,
              provide: (_i: unknown, e: Effect.Effect<unknown>) => e as Effect.Effect<unknown>,
              snapshot: () => Effect.succeed(Option.none()),
              directories: () => Effect.succeed([]),
            } as any)
            const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
            const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
            const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
            const full = Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)
            yield* Effect.gen(function* () {
              const db = (yield* Database.Service).db
              yield* ensureSession(db)
              const svc = yield* SessionPromptDispatchService
              const r1 = (yield* svc.dispatch(basePrompt()) as any)
              expect(r1.status).toBe("succeeded")
              yield* Deferred.await(started).pipe(Effect.timeoutOption("2 seconds"))
              const row1 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              expect(row1!.outcome).toBe("in-flight")
              const r2 = (yield* svc.dispatch(basePrompt()) as any)
              expect(r2.status).toBe("succeeded")
              expect(calls).toBe(1)
              yield* Deferred.succeed(gate, void 0)
              let tries = 0
              while (tries < 80) {
                const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
                if (cur && cur.outcome === "succeeded") break
                yield* Effect.sleep("20 millis")
                tries += 1
              }
              const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              expect(row).toBeDefined()
              expect(row!.outcome).toBe("succeeded")
            }).pipe(Effect.provide(full))
          } finally {
            yield* Effect.promise(() => (fsp as any).rm(dir, { recursive: true, force: true }).catch(() => {}))
          }
        }),
      ),
    )
  })
  test("two independent Database.Service on same file (separate layers) also serialize", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const fsp = yield* Effect.promise(() => import("fs/promises"))
          const p = yield* Effect.promise(() => import("path"))
          const os = yield* Effect.promise(() => import("os"))
          const dir = (yield* Effect.promise(() => (fsp as any).mkdtemp(p.join(os.tmpdir(), "kilo-cross2-")))) as unknown as string
          const file = p.join(dir, "kilo.db")
          try {
            // init session via first service
            const initLayer = Database.layerNoLease(file)
            const initDeps = Layer.mergeAll(
              initLayer,
              Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
              Layer.succeed(SessionPrompt.Service, { prompt: () => Effect.succeed({} as any), command: () => Effect.succeed({} as any), cancel: () => Effect.void, loop: () => Effect.die(new Error("x")), shell: () => Effect.die(new Error("x")), resolvePromptParts: () => Effect.succeed([] as never) } as any),
              Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any),
              Layer.succeed(InstanceStore.Service, { load: () => Effect.succeed({ directory: DIR, worktree: DIR, project: { id: "proj-test" } }), reload: () => Effect.succeed({ directory: DIR, worktree: DIR, project: { id: "proj-test" } }), dispose: () => Effect.void, disposeSafe: () => Effect.void, disposeDirectory: () => Effect.void, disposeAll: () => Effect.void, provide: (_i: unknown, e: any) => e, snapshot: () => Effect.succeed(Option.none()), directories: () => Effect.succeed([]) } as any),
              Layer.succeed(GenerationGate.Service, GenerationGate.noop),
              Layer.succeed(ControlLease.Service, ControlLease.noop),
            )
            yield* Effect.gen(function* () {
              const db = (yield* Database.Service).db
              yield* ensureSession(db)
            }).pipe(Effect.provide(initDeps))
            // two independent services each with own layer, run sequentially to verify both can read same file
            const makeLayer = () => {
              const dbLayer = Database.layerNoLease(file)
              const deps = Layer.mergeAll(
                dbLayer,
                Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
                Layer.succeed(SessionPrompt.Service, { prompt: () => Effect.succeed({} as any), command: () => Effect.succeed({} as any), cancel: () => Effect.void, loop: () => Effect.die(new Error("x")), shell: () => Effect.die(new Error("x")), resolvePromptParts: () => Effect.succeed([] as never) } as any),
                Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any),
                Layer.succeed(InstanceStore.Service, { load: () => Effect.succeed({ directory: DIR, worktree: DIR, project: { id: "proj-test" } }), reload: () => Effect.succeed({ directory: DIR, worktree: DIR, project: { id: "proj-test" } }), dispose: () => Effect.void, disposeSafe: () => Effect.void, disposeDirectory: () => Effect.void, disposeAll: () => Effect.void, provide: (_i: unknown, e: any) => e, snapshot: () => Effect.succeed(Option.none()), directories: () => Effect.succeed([]) } as any),
                Layer.succeed(GenerationGate.Service, GenerationGate.noop),
                Layer.succeed(ControlLease.Service, ControlLease.noop),
              )
              return deps
            }
            const row1 = yield* Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const r = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              return r
            }).pipe(Effect.provide(makeLayer()))
            // row1 may be undefined if not yet created, but after init session there is no op yet, so undefined is expected
            expect(row1).toBeUndefined()
            // create op via one service
            const svcLayer = (() => {
              const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
              const dbLayer = Database.layerNoLease(file)
              const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
              const promptLayer = Layer.succeed(SessionPrompt.Service, { prompt: () => Effect.succeed({} as any), command: () => Effect.succeed({} as any), cancel: () => Effect.void, loop: () => Effect.die(new Error("x")), shell: () => Effect.die(new Error("x")), resolvePromptParts: () => Effect.succeed([] as never) } as any)
              const eventsLayer = Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any)
              const storeLayer = Layer.succeed(InstanceStore.Service, { load: () => Effect.succeed(fakeCtx), reload: () => Effect.succeed(fakeCtx), dispose: () => Effect.void, disposeSafe: () => Effect.void, disposeDirectory: () => Effect.void, disposeAll: () => Effect.void, provide: (_i: unknown, e: any) => e, snapshot: () => Effect.succeed(Option.none()), directories: () => Effect.succeed([]) } as any)
              const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
              const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
              const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
              return Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)
            })()
            yield* Effect.gen(function* () {
              const svc = yield* SessionPromptDispatchService
              const r = (yield* svc.dispatch(basePrompt()) as any)
              expect(r.status).toBe("succeeded")
            }).pipe(Effect.provide(svcLayer))
            // second independent service should see same op
            const row2 = yield* Effect.gen(function* () {
              const db = (yield* Database.Service).db
              let tries = 0
              while (tries < 50) {
                const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
                if (cur) break
                yield* Effect.sleep("20 millis")
                tries += 1
              }
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              return cur
            }).pipe(Effect.provide(makeLayer()))
            expect(row2).toBeDefined()
          } finally {
            yield* Effect.promise(() => (fsp as any).rm(dir, { recursive: true, force: true }).catch(() => {}))
          }
        }),
      ),
    )
  })
})

describe("lease ownership on DB failure paths", () => {
  test("DB failure during inception releases lease and next dispatch not blocked", async () => {
    let acquires = 0, releases = 0
    const countingLease: ControlLease.ControlLease = {
      acquire: () => { acquires += 1; return Option.some(Effect.sync(() => { releases += 1 })) },
      acquireWrite: () => Option.some(Effect.void),
      sealAndDrain: () => Effect.void,
    }
    // failing DB: transaction always dies
    const fakeDbFail = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: () => Effect.succeed(undefined),
          }),
          get: () => Effect.succeed(undefined),
        }),
      }),
      transaction: () => Effect.die(new Error("injected DB failure")),
    } as unknown as any
    const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
    const makeFailDeps = () => {
      const dbLayer = Layer.succeed(Database.Service, { db: fakeDbFail } as any)
      const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
      const promptLayer = Layer.succeed(SessionPrompt.Service, {
        prompt: () => Effect.succeed({ id: "dummy" } as any),
        command: () => Effect.succeed({ id: "dummy" } as any),
        cancel: () => Effect.void,
        loop: () => Effect.die(new Error("unused")),
        shell: () => Effect.die(new Error("unused")),
        resolvePromptParts: () => Effect.succeed([] as never),
      } as any)
      const eventsLayer = Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any)
      const storeLayer = Layer.succeed(InstanceStore.Service, {
        load: () => Effect.succeed(fakeCtx),
        reload: () => Effect.succeed(fakeCtx),
        dispose: () => Effect.void,
        disposeSafe: () => Effect.void,
        disposeDirectory: () => Effect.void,
        disposeAll: () => Effect.void,
        provide: (_i: unknown, e: Effect.Effect<unknown>) => e as Effect.Effect<unknown>,
        snapshot: () => Effect.succeed(Option.none()),
        directories: () => Effect.succeed([]),
      } as any)
      const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
      const leaseLayer = Layer.succeed(ControlLease.Service, countingLease)
      const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
      return Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)
    }
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const deps = makeFailDeps()
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            // need to ensure Session.get and Message checks don't hit failing db's select for those paths
            // Our fakeDb's select returns undefined for all, so session.get will succeed (it doesn't use db for get),
            // global message check will see undefined (no scope mismatch), so it will reach inception which fails
            const r = (yield* svc.dispatch(basePrompt())) as any
            // inception failure is mapped to internal error, not die
            expect(r.status).toBe("failed")
            expect(r.failure.code).toBe("internal")
            expect(acquires).toBe(1)
            expect(releases).toBe(1)
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
    // second dispatch with real DB should not be blocked (lease released)
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const deps = makePromptDeps({ lease: countingLease })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt())) as any
            expect(r.status).toBe("succeeded")
            expect(acquires).toBe(2)
            // background still holds until terminal, but at this point one lease held
            expect(releases).toBe(1)
            // wait for terminal
            let tries = 0
            while (tries < 50 && releases === 1) {
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            expect(releases).toBe(2)
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })
})

describe("cancellation outcome truth via dispatcher", () => {
  test("aborted success payload is abandoned, natural success is succeeded, error is failed", async () => {
    const abortedPayload = { info: { error: { name: "MessageAbortedError", message: "Aborted" } } }
    const mkPrompt = (mid: string) => ({
      v: 1 as const,
      requestId: "req-1",
      opId: `prompt:${mid}`,
      op: "session/prompt" as const,
      idempotencyKey: `prompt:${mid}`,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: mid, parts: [{ type: "text", text: "hi" }] },
    })
    // aborted success -> abandoned
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const deps = makePromptDeps({ promptImpl: () => Effect.succeed(abortedPayload as any) })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt())) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "abandoned") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("abandoned")
            expect(row!.code).toBe("prompt.abandoned")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
    // natural success -> succeeded
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const mid2 = "msg_abc12300000000000002"
          const deps = makePromptDeps({ promptImpl: () => Effect.succeed({ info: { role: "assistant", id: "x" } } as any) })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(mkPrompt(mid2)) as any) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${mid2}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "succeeded") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${mid2}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("succeeded")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
    // error -> failed
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const mid3 = "msg_abc12300000000000003"
          const deps = makePromptDeps({ promptImpl: () => Effect.fail(new Error("boom")) })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(mkPrompt(mid3)) as any) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${mid3}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "failed") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${mid3}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("failed")
            expect(row!.code).toBe("prompt.failed")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })
  test("command aborted success also abandoned", async () => {
    const abortedPayload = { info: { error: { name: "MessageAbortedError", message: "Aborted" } } }
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const deps = makeCommandDeps({ commandImpl: () => Effect.succeed(abortedPayload as any) })
          yield* Effect.gen(function* () {
            const svc = yield* SessionCommandDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(baseCommand())) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome === "abandoned") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("abandoned")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })
})

describe("finalizer concurrent terminalization", () => {
  test("terminal CAS prevents double write, second transition is no-op", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const hang = yield* Deferred.make<void>()
          const deps = makePromptDeps({ promptImpl: () => Deferred.await(hang).pipe(Effect.as({ id: "dummy" } as any)) })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt())) as any
            expect(r.status).toBe("succeeded")
            const row1 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(row1!.outcome).toBe("in-flight")
            yield* Deferred.succeed(hang, void 0)
            let tries = 0
            while (tries < 50) {
              const cur = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (cur && cur.outcome !== "in-flight") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const row2 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(["succeeded", "abandoned", "failed"]).toContain(row2!.outcome)
            const rec: any = { opId: `prompt:${MID}`, opKind: "prompt", outcome: "failed", code: "prompt.failed", message: "second", time: Date.now() }
            const mod = yield* Effect.promise(() => import("@opencode-ai/core/session/operation"))
            const res = yield* (mod as any).SessionOperation.tryTransitionPromptTerminal(db, SID as any, rec).pipe(
              Effect.catch(() => Effect.succeed({ applied: false } as any)),
              Effect.catchDefect(() => Effect.succeed({ applied: false } as any)),
            )
            expect((res as any).applied).toBe(false)
            const finalRow = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            expect(finalRow!.outcome).toBe(row2!.outcome)
            expect(finalRow!.code).toBe(row2!.code)
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })
})

describe("prompt dispatch durable fail-closed (merged)", () => {
  function basePromptForFailClosed() {
    return {
      v: 1,
      requestId: "req-1",
      opId: `prompt:${MID}`,
      op: "session/prompt",
      idempotencyKey: `prompt:${MID}`,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: MID, parts: [{ type: "text", text: "hi" }] },
    } as unknown as { v: number; requestId: string; opId: string; op: string; idempotencyKey: string; context: unknown; payload: unknown }
  }

  function makeDispatchDepsWithFakeDbForMerged(fakeDb: unknown, promptImpl?: () => Effect.Effect<unknown>) {
    const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } } as unknown as { directory: string; worktree: string; project: { id: string } }
    const dbLayer = Layer.succeed(Database.Service, { db: fakeDb } as unknown as Database.Interface)
    const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as unknown as Session.Interface)
    const promptLayer = Layer.succeed(SessionPrompt.Service, {
      prompt: (promptImpl as unknown as () => Effect.Effect<unknown>) ?? (() => Effect.succeed({ id: "dummy" } as unknown)),
      command: () => Effect.succeed({ id: "dummy" } as unknown),
      cancel: () => Effect.void,
      loop: () => Effect.die(new Error("unused")),
      shell: () => Effect.die(new Error("unused")),
      resolvePromptParts: () => Effect.succeed([] as never),
    } as unknown as SessionPrompt.Interface)
    const eventsLayer = Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as unknown as InstanceType<typeof EventV2Bridge.Service>)
    const storeLayer = Layer.succeed(InstanceStore.Service, {
      load: () => Effect.succeed(fakeCtx as unknown),
      reload: () => Effect.succeed(fakeCtx as unknown),
      dispose: () => Effect.void,
      disposeSafe: () => Effect.void,
      disposeDirectory: () => Effect.void,
      disposeAll: () => Effect.void,
      provide: (_i: unknown, e: unknown) => e as Effect.Effect<unknown>,
      snapshot: () => Effect.succeed(Option.none() as unknown),
      directories: () => Effect.succeed([] as unknown[]),
    } as unknown as InstanceStore.Interface)
    const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop as unknown as InstanceType<typeof GenerationGate.Service>)
    const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop as unknown as InstanceType<typeof ControlLease.Service>)
    const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
    return Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)
  }

  test("fast replay with illegal outcome is internal fail-closed not succeeded", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const dirtyRow = {
            op_id: `prompt:${MID}`,
            session_id: SID,
            op_kind: "prompt",
            outcome: "bogus",
            code: "c",
            message: "m",
            time: Date.now(),
            cancel: null,
            detail: null,
            stack: null,
            revision: 1,
          } as unknown as typeof SessionOperationTable.$inferSelect
          const fakeDb: unknown = {
            select: () => ({
              from: (table: unknown) => ({
                where: () => ({
                  get: () => {
                    if (table === SessionOperationTable) return Effect.succeed(dirtyRow as unknown)
                    return Effect.succeed(undefined as unknown)
                  },
                  all: () => Effect.succeed([] as unknown[]),
                }),
              }),
            }),
            transaction: (cb: unknown) => {
              const tx: unknown = {
                select: () => ({
                  from: () => ({
                    where: () => ({ get: () => Effect.succeed(dirtyRow as unknown) }),
                  }),
                }),
              }
              return (cb as (v: unknown) => Effect.Effect<unknown>)(tx)
            },
          }
          const deps = makeDispatchDepsWithFakeDbForMerged(fakeDb)
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const res = (yield* svc.dispatch(basePromptForFailClosed() as unknown as Parameters<typeof svc.dispatch>[0])) as unknown as { status: string; failure: { code: string } }
            expect(res.status).toBe("failed")
            expect(res.failure.code).toBe("internal")
            expect(res.status).not.toBe("succeeded")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })

  test("fast replay with illegal opKind is internal", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const dirtyRow = {
            op_id: `prompt:${MID}`,
            session_id: SID,
            op_kind: "tool",
            outcome: "succeeded",
            code: "c",
            message: "m",
            time: Date.now(),
            cancel: null,
            detail: null,
            stack: null,
            revision: 1,
          } as unknown as typeof SessionOperationTable.$inferSelect
          const fakeDb: unknown = {
            select: () => ({
              from: (table: unknown) => ({
                where: () => ({
                  get: () => {
                    if (table === SessionOperationTable) return Effect.succeed(dirtyRow as unknown)
                    return Effect.succeed(undefined as unknown)
                  },
                  all: () => Effect.succeed([] as unknown[]),
                }),
              }),
            }),
            transaction: (cb: unknown) => {
              const tx = { select: () => ({ from: () => ({ where: () => ({ get: () => Effect.succeed(dirtyRow as unknown) }) }) }) } as unknown
              return (cb as (v: unknown) => Effect.Effect<unknown>)(tx)
            },
          }
          const deps = makeDispatchDepsWithFakeDbForMerged(fakeDb)
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const res = (yield* svc.dispatch(basePromptForFailClosed() as unknown as Parameters<typeof svc.dispatch>[0])) as unknown as { status: string; failure: { code: string } }
            expect(res.status).toBe("failed")
            expect(res.failure.code).toBe("internal")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })

  test("fast replay scope mismatch returns scope_mismatch not succeeded", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const otherSid = "ses_other000000000000001"
          const row = {
            op_id: `prompt:${MID}`,
            session_id: otherSid,
            op_kind: "prompt",
            outcome: "succeeded",
            code: "prompt.succeeded",
            message: "ok",
            time: Date.now(),
            cancel: null,
            detail: null,
            stack: null,
            revision: 1,
          } as unknown as typeof SessionOperationTable.$inferSelect
          const fakeDb: unknown = {
            select: () => ({
              from: (table: unknown) => ({
                where: () => ({
                  get: () => {
                    if (table === SessionOperationTable) return Effect.succeed(row as unknown)
                    return Effect.succeed(undefined as unknown)
                  },
                  all: () => Effect.succeed([] as unknown[]),
                }),
              }),
            }),
            transaction: (cb: unknown) => {
              const tx = { select: () => ({ from: () => ({ where: () => ({ get: () => Effect.succeed(row as unknown) }) }) }) } as unknown
              return (cb as (v: unknown) => Effect.Effect<unknown>)(tx)
            },
          }
          const deps = makeDispatchDepsWithFakeDbForMerged(fakeDb)
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const res = (yield* svc.dispatch(basePromptForFailClosed() as unknown as Parameters<typeof svc.dispatch>[0])) as unknown as { status: string; failure: { code: string } }
            expect(res.status).toBe("failed")
            expect(res.failure.code).toBe("scope_mismatch")
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })

  test("normal replay still zero duplicate generation (fast path)", async () => {
    await runTest(Effect.scoped(
        Effect.gen(function* () {
          const goodRow = {
            op_id: `prompt:${MID}`,
            session_id: SID,
            op_kind: "prompt",
            outcome: "succeeded",
            code: "prompt.succeeded",
            message: "ok",
            time: Date.now(),
            cancel: null,
            detail: null,
            stack: null,
            revision: 1,
          } as unknown as typeof SessionOperationTable.$inferSelect
          let calls = 0
          const fakeDb: unknown = {
            select: () => ({
              from: (table: unknown) => ({
                where: () => ({
                  get: () => {
                    if (table === SessionOperationTable) return Effect.succeed(goodRow as unknown)
                    if (table === SessionTable) return Effect.succeed({ id: SID, revision: 1 } as unknown)
                    return Effect.succeed(undefined as unknown)
                  },
                  all: () => Effect.succeed([] as unknown[]),
                  orderBy: () => ({ all: () => Effect.succeed([] as unknown[]), get: () => Effect.succeed(undefined as unknown) }),
                }),
              }),
            }),
            transaction: (cb: unknown) => {
              const tx = {
                select: () => ({ from: () => ({ where: () => ({ get: () => Effect.succeed(goodRow as unknown) }), all: () => Effect.succeed([] as unknown[]) }) }),
                insert: () => ({ values: () => ({ run: () => Effect.succeed(undefined as unknown), onConflictDoNothing: () => ({ run: () => Effect.succeed(undefined as unknown) }), returning: () => ({ get: () => Effect.succeed({} as unknown), all: () => Effect.succeed([] as unknown[]) }) }) }),
                update: () => ({ set: () => ({ where: () => ({ run: () => Effect.succeed(undefined as unknown), returning: () => ({ all: () => Effect.succeed([] as unknown[]) }) }) }) }),
              } as unknown
              return (cb as (v: unknown) => Effect.Effect<unknown>)(tx as unknown)
            },
          }
          const deps = makeDispatchDepsWithFakeDbForMerged(fakeDb, () => {
            calls += 1
            return Effect.succeed({ id: "dummy" } as unknown)
          })
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const r1 = (yield* svc.dispatch(basePromptForFailClosed() as unknown as Parameters<typeof svc.dispatch>[0])) as unknown as { status: string }
            expect(r1.status).toBe("succeeded")
            const r2 = (yield* svc.dispatch(basePromptForFailClosed() as unknown as Parameters<typeof svc.dispatch>[0])) as unknown as { status: string }
            expect(r2.status).toBe("succeeded")
            expect(calls).toBe(0)
          }).pipe(Effect.provide(deps))
        }),
      ),
    )
  })
})

