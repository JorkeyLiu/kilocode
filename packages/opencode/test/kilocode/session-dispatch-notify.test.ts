// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Command } from "@/command"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionPromptDispatchService, layer as PromptLayer } from "@/kilocode/session/session-prompt-dispatch"
import { SessionCommandDispatchService, layer as CommandLayer } from "@/kilocode/session/session-command-dispatch"
import { OBSERVATION_NOTIFICATION, OBSERVATION_VERSION } from "@/private-worker/observation"
import { Service as PrivatePeerService } from "@/kilocode/server/private-peer-registry"

const SID = "ses_abc12300000000000001"
const SID2 = "ses_abc12300000000000002"
const MID = "msg_abc12300000000000001"
const MID2 = "msg_abc12300000000000002"
const MID3 = "msg_abc12300000000000003"
const MID4 = "msg_abc12300000000000004"
const DIR = "/tmp/ws"

function basePrompt(mid = MID) {
  return {
    v: 1,
    requestId: "req-1",
    opId: `prompt:${mid}`,
    op: "session/prompt",
    idempotencyKey: `prompt:${mid}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: mid, parts: [{ type: "text", text: "hi" }] },
  }
}
function baseCommand(mid = MID) {
  return {
    v: 1,
    requestId: "req-1",
    opId: `prompt:${mid}`,
    op: "session/command",
    idempotencyKey: `prompt:${mid}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: mid, command: "probe", arguments: "hello" },
  }
}

function ensureSession(db: any) {
  return Effect.gen(function* () {
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
}

function makePeer(calls: any[], fail = false) {
  const peer: any = {
    install: () => Effect.succeed({ release: Effect.void, negotiate: () => Effect.void } as any),
    release: () => Effect.void,
    negotiate: () => Effect.succeed(undefined),
    current: Effect.succeed(Option.none()),
    request: () => Effect.fail(new Error("unsupported") as any),
    requestWithEvents: () => Effect.fail(new Error("unsupported") as any),
    supports: () => Effect.succeed(false),
    notify: (method: string, params: unknown) => {
      calls.push({ method, params })
      if (fail) return Effect.fail(new Error("peer boom") as unknown as never)
      return Effect.succeed(undefined)
    },
  }
  return peer
}

function makePromptDeps(peer: any, promptImpl?: () => Effect.Effect<any>) {
  const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
  const dbLayer = Database.layerNoLease(":memory:")
  const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
  const promptLayer = Layer.succeed(SessionPrompt.Service, {
    prompt: promptImpl ?? (() => Effect.succeed({ id: "dummy" } as any)),
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
  const peerLayer = Layer.succeed(PrivatePeerService, peer)
  const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer, peerLayer)
  const full = Layer.provide(PromptLayer, deps)
  return Layer.mergeAll(full, deps)
}

function makeCommandDeps(peer: any, commandImpl?: () => Effect.Effect<any>) {
  const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
  const dbLayer = Database.layerNoLease(":memory:")
  const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
  const promptLayer = Layer.succeed(SessionPrompt.Service, {
    prompt: () => Effect.succeed({ id: "dummy" } as any),
    command: commandImpl ?? (() => Effect.succeed({ id: "dummy" } as any)),
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
    snapshot: () => Effect.succeed(Option.none()),
    directories: () => Effect.succeed([]),
  } as any)
  const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
  const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
  const peerLayer = Layer.succeed(PrivatePeerService, peer)
  const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, cmdLayer, eventsLayer, storeLayer, gateLayer, leaseLayer, peerLayer)
  const full = Layer.provide(CommandLayer, deps)
  return Layer.mergeAll(full, deps)
}

describe("dispatch commit-after notify via entry", () => {
  test("prompt fresh in-flight uses entry strict 5-key payload cursor=seq", async () => {
    const calls: any[] = []
    const peer = makePeer(calls)
    const deps = makePromptDeps(peer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionPromptDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const r = (yield* svc.dispatch(basePrompt())) as any
          expect(r.status).toBe("succeeded")
          expect(r.accepted).toBe(true)
          // fresh should have notified once
          expect(calls.length).toBe(1)
          const first = calls[0]
          expect(first.method).toBe(OBSERVATION_NOTIFICATION)
          const payload = first.params as any
          expect(payload.v).toBe(OBSERVATION_VERSION)
          expect(typeof payload.cursor).toBe("number")
          expect(payload.entries.length).toBe(1)
          const e = payload.entries[0]
          expect(Object.keys(e).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
          expect(payload.cursor).toBe(e.seq)
          // ensure entry matches DB changefeed entry
          const rows = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
          expect(rows.length).toBe(1)
          expect(rows[0].seq).toBe(e.seq)
          expect(rows[0].session_id).toBe(e.session_id)
          expect(rows[0].revision).toBe(e.revision)
          expect(rows[0].kind).toBe(e.kind)
          // no external append beyond operation: 1 op -> 1 changefeed
          const ops = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
          expect(ops.length).toBe(1)
        }).pipe(Effect.provide(deps)),
      ),
    )
  })

  test("prompt terminal succeeded/failed/abandoned have notify with entry", async () => {
    // succeeded
    {
      const calls: any[] = []
      const peer = makePeer(calls)
      const deps = makePromptDeps(peer, () => Effect.succeed({ id: "ok" } as any))
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt(MID))) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
              if (row && row.outcome === "succeeded") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            expect(calls.length).toBe(3)
            const term = calls[1].params as any
            expect(term.v).toBe(OBSERVATION_VERSION)
            expect(term.cursor).toBe(term.entries[0].seq)
            expect(Object.keys(term.entries[0]).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
            expect(term.entries[0].kind).toBe("changed")
            const gen = calls[2].params as any
            expect(gen.v).toBe(OBSERVATION_VERSION)
            expect(gen.entries[0].kind).toBe("generation")
            expect(gen.entries[0].revision).toBe(term.entries[0].revision)
            expect(gen.cursor).toBe(gen.entries[0].seq)
            const crows = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            expect(crows.length).toBe(3)
            expect(crows.filter((c:any)=>c.kind==="generation").length).toBe(1)
          }).pipe(Effect.provide(deps)),
        ),
      )
    }
    // failed
    {
      const calls: any[] = []
      const peer = makePeer(calls)
      const deps = makePromptDeps(peer, () => Effect.fail(new Error("boom")))
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt(MID2))) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID2}`)).get().pipe(Effect.orDie)
              if (row && row.outcome === "failed") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            expect(calls.length).toBe(3)
            const term = calls[1].params as any
            expect(term.entries[0].kind).toBe("changed")
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID2}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("failed")
          }).pipe(Effect.provide(deps)),
        ),
      )
    }
    // abandoned via interrupt
    {
      const calls: any[] = []
      const peer = makePeer(calls)
      const deps = makePromptDeps(peer, () => Effect.interrupt)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(basePrompt(MID3))) as any
            expect(r.status).toBe("succeeded")
            let tries = 0
            while (tries < 50) {
              const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID3}`)).get().pipe(Effect.orDie)
              if (row && row.outcome === "abandoned") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            expect(calls.length).toBe(3)
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID3}`)).get().pipe(Effect.orDie)
            expect(row!.outcome).toBe("abandoned")
          }).pipe(Effect.provide(deps)),
        ),
      )
    }
  })

  test("prompt replay has no secondary notify", async () => {
    const calls: any[] = []
    const peer = makePeer(calls)
    const deps = makePromptDeps(peer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionPromptDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const r1 = (yield* svc.dispatch(basePrompt())) as any
          expect(r1.status).toBe("succeeded")
          let tries = 0
          while (tries < 50) {
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            if (row && row.outcome === "succeeded") break
            yield* Effect.sleep("20 millis")
            tries += 1
          }
          const before = calls.length
          expect(before).toBe(3)
          const r2 = (yield* svc.dispatch(basePrompt())) as any
          expect(r2.status).toBe("succeeded")
          // give a tick for any stray notify
          yield* Effect.sleep("30 millis")
          expect(calls.length).toBe(before)
        }).pipe(Effect.provide(deps)),
      ),
    )
  })

  test("prompt CAS no-op terminal has no second notify", async () => {
    const calls: any[] = []
    const peer = makePeer(calls)
    const deps = makePromptDeps(peer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionPromptDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const r = (yield* svc.dispatch(basePrompt())) as any
          expect(r.status).toBe("succeeded")
          let tries = 0
          while (tries < 50) {
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            if (row && row.outcome === "succeeded") break
            yield* Effect.sleep("20 millis")
            tries += 1
          }
          expect(calls.length).toBe(3)
          const mod = yield* Effect.promise(() => import("@opencode-ai/core/session/operation"))
          const rec: any = { opId: `prompt:${MID}`, opKind: "prompt", outcome: "failed", code: "prompt.failed", message: "second", time: Date.now() }
          const res = yield* (mod as any).SessionOperation.tryTransitionPromptTerminal(db, SID as any, rec).pipe(
            Effect.catch(() => Effect.succeed({ applied: false } as any)),
            Effect.catchDefect(() => Effect.succeed({ applied: false } as any)),
          )
          expect((res as any).applied).toBe(false)
          yield* Effect.sleep("30 millis")
          expect(calls.length).toBe(3)
        }).pipe(Effect.provide(deps)),
      ),
    )
  })

  test("prompt peer notify failure still accepted and terminal succeeds", async () => {
    const calls: any[] = []
    const failingPeer = makePeer(calls, true)
    const deps = makePromptDeps(failingPeer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionPromptDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const r = (yield* svc.dispatch(basePrompt())) as any
          expect(r.status).toBe("succeeded")
          expect(r.accepted).toBe(true)
          expect(calls.length).toBe(1)
          let tries = 0
          while (tries < 50) {
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            if (row && row.outcome === "succeeded") break
            yield* Effect.sleep("20 millis")
            tries += 1
          }
          expect(calls.length).toBe(3)
          const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
          expect(row!.outcome).toBe("succeeded")
        }).pipe(Effect.provide(deps)),
      ),
    )
  })

  test("prompt validation/session/scope no notify", async () => {
    const calls: any[] = []
    const peer = makePeer(calls)
    // validation: bad opId
    {
      const deps = makePromptDeps(peer)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const bad = { ...basePrompt(), opId: "prompt:bad", idempotencyKey: "prompt:bad" }
            const r = (yield* svc.dispatch(bad)) as any
            expect(r.status).toBe("failed")
          }).pipe(Effect.provide(deps)),
        ),
      )
      expect(calls.length).toBe(0)
    }
    // session not found: we override Session.get to fail
    {
      const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
      const dbLayer = Database.layerNoLease(":memory:")
      const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.fail(Object.assign(new Error("session not found"), { _tag: "NotFoundError" })) } as any)
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
      const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
      const peerLayer = Layer.succeed(PrivatePeerService, peer)
      const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer, peerLayer)
      const full = Layer.provide(PromptLayer, deps)
      const all = Layer.mergeAll(full, deps)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const r = (yield* svc.dispatch(basePrompt())) as any
            expect(r.status).toBe("failed")
            expect(r.failure.code).toBe("session.not_found")
          }).pipe(Effect.provide(all)),
        ),
      )
      expect(calls.length).toBe(0)
    }
  })

  test("command fresh notify strict payload and terminal", async () => {
    const calls: any[] = []
    const peer = makePeer(calls)
    const deps = makeCommandDeps(peer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionCommandDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const r = (yield* svc.dispatch(baseCommand())) as any
          expect(r.status).toBe("succeeded")
          expect(calls.length).toBe(1)
          const p = calls[0].params as any
          expect(p.v).toBe(OBSERVATION_VERSION)
          expect(p.cursor).toBe(p.entries[0].seq)
          expect(Object.keys(p.entries[0]).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
          let tries = 0
          while (tries < 50) {
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            if (row && row.outcome === "succeeded") break
            yield* Effect.sleep("20 millis")
            tries += 1
          }
          expect(calls.length).toBe(3)
          const term = calls[1].params as any
          expect(term.v).toBe(OBSERVATION_VERSION)
          expect(term.cursor).toBe(term.entries[0].seq)
          const crows = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
          expect(crows.length).toBe(3)
        }).pipe(Effect.provide(deps)),
      ),
    )
  })

  test("command replay and command-not-found no notify", async () => {
    const calls: any[] = []
    const peer = makePeer(calls)
    const deps = makeCommandDeps(peer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionCommandDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const r1 = (yield* svc.dispatch(baseCommand())) as any
          expect(r1.status).toBe("succeeded")
          let tries = 0
          while (tries < 50) {
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            if (row && row.outcome === "succeeded") break
            yield* Effect.sleep("20 millis")
            tries += 1
          }
          const before = calls.length
          expect(before).toBe(3)
          const r2 = (yield* svc.dispatch(baseCommand())) as any
          expect(r2.status).toBe("succeeded")
          yield* Effect.sleep("20 millis")
          expect(calls.length).toBe(before)
        }).pipe(Effect.provide(deps)),
      ),
    )
    // command-not-found
    const calls2: any[] = []
    const peer2 = makePeer(calls2)
    const deps2 = makeCommandDeps(peer2)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionCommandDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const bad = { ...baseCommand(MID4), payload: { ...baseCommand(MID4).payload, command: "missing" } }
          const r = (yield* svc.dispatch(bad)) as any
          expect(r.status).toBe("failed")
          expect(r.failure.code).toBe("command.not_found")
        }).pipe(Effect.provide(deps2)),
      ),
    )
    expect(calls2.length).toBe(0)
  })

  test("command peer failure still accepted", async () => {
    const calls: any[] = []
    const peer = makePeer(calls, true)
    const deps = makeCommandDeps(peer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionCommandDispatchService
          const db = (yield* Database.Service).db
          yield* ensureSession(db)
          const r = (yield* svc.dispatch(baseCommand())) as any
          expect(r.status).toBe("succeeded")
          expect(r.accepted).toBe(true)
          expect(calls.length).toBe(1)
          let tries = 0
          while (tries < 50) {
            const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
            if (row && row.outcome === "succeeded") break
            yield* Effect.sleep("20 millis")
            tries += 1
          }
          expect(calls.length).toBe(3)
        }).pipe(Effect.provide(deps)),
      ),
    )
  })
})
