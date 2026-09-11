// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Command } from "@/command"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionCommandDispatchService, layer as DispatchLayer, validateRequest } from "@/kilocode/session/session-command-dispatch"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

function base() {
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

describe("session-command-dispatch validate", () => {
  test("accepts canonical command tuple with prompt identity", () => {
    expect(() => validateRequest(base())).not.toThrow()
  })
  test("accepts provider/model string model", () => {
    expect(() => validateRequest({ ...base(), payload: { ...base().payload, model: "test/model" } })).not.toThrow()
  })
  test("rejects non-canonical opId", () => {
    expect(() => validateRequest({ ...base(), opId: "prompt:other" })).toThrow()
  })
  test("rejects idempotency mismatch", () => {
    expect(() => validateRequest({ ...base(), idempotencyKey: "prompt:other" })).toThrow()
  })
  test("rejects non-null parent", () => {
    const r = base() as Record<string, unknown>
    const ctx = { ...(r.context as Record<string, unknown>), parentSessionId: SID }
    expect(() => validateRequest({ ...r, context: ctx })).toThrow()
  })
  test("rejects bad messageId", () => {
    const r = base() as Record<string, unknown>
    const payload = { ...((r.payload as Record<string, unknown>) ?? {}), messageId: "bad" }
    expect(() => validateRequest({ ...r, payload })).toThrow()
  })
  test("rejects malformed model string", () => {
    const r = base() as Record<string, unknown>
    const payload = { ...((r.payload as Record<string, unknown>) ?? {}), model: "nonslash" }
    expect(() => validateRequest({ ...r, payload })).toThrow()
  })
  test("rejects empty command and non-string arguments", () => {
    const r = base() as Record<string, unknown>
    expect(() => validateRequest({ ...r, payload: { ...((r.payload as Record<string, unknown>) ?? {}), command: "" } })).toThrow()
    expect(() => validateRequest({ ...r, payload: { ...((r.payload as Record<string, unknown>) ?? {}), arguments: 42 } })).toThrow()
  })
})

function depsFor(over: {
  sessionGet?: () => Effect.Effect<unknown>
  cmdGet?: () => Effect.Effect<unknown>
  cmdList?: () => Effect.Effect<unknown>
  cmdRun?: () => Effect.Effect<unknown>
  gateBarrier?: boolean
  snapshot?: unknown
  existingRole?: "user" | "assistant"
  globalSession?: string
}) {
  let gets = 0
  const fakeDb = {
    select: (..._a: unknown[]) => ({
      from: (..._b: unknown[]) => ({
        where: (..._c: unknown[]) => ({
          get: () => {
            gets += 1
            if (gets === 1 && over.existingRole) {
              return Effect.succeed({
                id: MID,
                session_id: SID,
                time_created: 1,
                data: { role: over.existingRole },
              })
            }
            if (gets === 1) return Effect.succeed(undefined)
            if (gets === 2 && over.globalSession) return Effect.succeed({ session: over.globalSession })
            return Effect.succeed(undefined)
          },
          all: () => Effect.succeed([]),
          orderBy: (..._o: unknown[]) => ({
            all: () => Effect.succeed([]),
            get: () => Effect.succeed(undefined),
          }),
        }),
      }),
    }),
  }
  const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
  const dbLayer = Layer.succeed(Database.Service, { db: fakeDb } as any)
  const sessionLayer = Layer.succeed(Session.Service, {
    get: over.sessionGet ?? (() => Effect.succeed({ directory: DIR, id: SID })),
  } as any)
  const promptLayer = Layer.succeed(SessionPrompt.Service, {
    prompt: () => Effect.die(new Error("unused")),
    command: over.cmdRun ?? (() => Effect.succeed({ id: "dummy" } as any)),
    cancel: () => Effect.void,
    loop: () => Effect.die(new Error("unused")),
    shell: () => Effect.die(new Error("unused")),
    resolvePromptParts: () => Effect.succeed([] as never),
  } as any)
  const commandLayer = Layer.succeed(Command.Service, {
    get: over.cmdGet ?? (() => Effect.succeed({ name: "probe", template: "hi", hints: [] })),
    list: over.cmdList ?? (() => Effect.succeed([{ name: "probe" }])),
  } as any)
  const eventsLayer = Layer.succeed(EventV2Bridge.Service, {
    publish: () => Effect.void,
  } as any)
  const snap = over.snapshot !== undefined ? over.snapshot : fakeCtx
  const storeLayer = Layer.succeed(InstanceStore.Service, {
    load: () => Effect.succeed(snap),
    snapshot: () => Effect.succeed(over.snapshot === null ? Option.none() : Option.some(snap as never)),
    reload: () => Effect.succeed(snap),
    dispose: () => Effect.void,
    disposeSafe: () => Effect.void,
    disposeDirectory: () => Effect.void,
    disposeAll: () => Effect.void,
    provide: (_input: unknown, effect: Effect.Effect<unknown>) => effect as Effect.Effect<unknown>,
    directories: () => Effect.succeed([]),
  } as any)
  const gateLayer = over.gateBarrier
    ? Layer.succeed(GenerationGate.Service, { ...GenerationGate.noop, isBarrierActive: () => true })
    : Layer.succeed(GenerationGate.Service, GenerationGate.noop)
  const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
  const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, commandLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
  const full = Layer.provide(DispatchLayer, deps)
  return Layer.mergeAll(full, deps)
}

describe("session-command-dispatch accept-only scope ownership", () => {
  test("dispatch returns accepted before command completes and scope close interrupts background", async () => {
    const prog = Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const all = depsFor({
        cmdRun: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0)
            yield* Deferred.await(gate)
            yield* Deferred.succeed(finished, void 0)
            return { id: "dummy" } as any
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.uninterruptible(Deferred.succeed(interrupted, void 0).pipe(Effect.asVoid))
                : Effect.void,
            ),
          ),
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionCommandDispatchService
          const result = (yield* svc.dispatch(base())) as any
          expect(result.status).toBe("succeeded")
          expect(result.accepted).toBe(true)
          yield* Deferred.await(started).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.fail(new Error("command never started") as unknown as never),
            }),
          )
          const fin = yield* Deferred.poll(finished)
          expect(Option.isNone(fin)).toBe(true)
        }).pipe(Effect.provide(all)),
      )
      yield* Deferred.await(interrupted).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.fail(new Error("background not interrupted on scope close") as unknown as never),
        }),
      )
      const finAfter = yield* Deferred.poll(finished)
      expect(Option.isNone(finAfter)).toBe(true)
    })
    await Effect.runPromise(prog.pipe(Effect.scoped))
  })

  test("command not found is terminal non-retryable", async () => {
    const prog = Effect.gen(function* () {
      const svc = yield* SessionCommandDispatchService
      const result = (yield* svc.dispatch(base())) as any
      expect(result.status).toBe("failed")
      expect(result.accepted).toBe(false)
      expect(result.failure.code).toBe("command.not_found")
      expect(result.failure.retryable).toBe(false)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(depsFor({ cmdGet: () => Effect.succeed(undefined), cmdList: () => Effect.succeed([{ name: "other" }]) })), Effect.scoped),
    )
  })

  test("session not found is terminal and fence is retryable", async () => {
    const failingGet = () => Effect.fail(Object.assign(new Error("session not found"), { _tag: "NotFoundError" }))
    const notFound = Effect.gen(function* () {
      const svc = yield* SessionCommandDispatchService
      const result = (yield* svc.dispatch(base())) as any
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("session.not_found")
      expect(result.failure.retryable).toBe(false)
      expect(result.accepted).toBe(false)
    })
    await Effect.runPromise(notFound.pipe(Effect.provide(depsFor({ sessionGet: failingGet })), Effect.scoped))
    const fenced = Effect.gen(function* () {
      const svc = yield* SessionCommandDispatchService
      const result = (yield* svc.dispatch(base())) as any
      expect(result.status).toBe("failed")
      expect(result.failure.retryable).toBe(true)
      expect(result.accepted).toBe(false)
    })
    await Effect.runPromise(
      fenced.pipe(Effect.provide(depsFor({ gateBarrier: true, snapshot: null })), Effect.scoped),
    )
  })

  test("pre-existing user succeeds without command lookup or fence even when command deleted", async () => {
    let lookedUp = 0
    let listed = 0
    const prog = Effect.gen(function* () {
      const svc = yield* SessionCommandDispatchService
      const result = (yield* svc.dispatch(base())) as any
      expect(result.status).toBe("succeeded")
      expect(result.accepted).toBe(true)
      expect(result.data.messageId).toBe(MID)
    })
    await Effect.runPromise(
      prog.pipe(
        Effect.provide(
          depsFor({
            existingRole: "user",
            gateBarrier: true,
            snapshot: null,
            cmdGet: () =>
              Effect.gen(function* () {
                lookedUp += 1
                return yield* Effect.die(new Error("command lookup must not run for pre-existing user"))
              }),
            cmdList: () =>
              Effect.gen(function* () {
                listed += 1
                return yield* Effect.die(new Error("command list must not run for pre-existing user"))
              }),
          }),
        ),
        Effect.scoped,
      ),
    )
    expect(lookedUp).toBe(0)
    expect(listed).toBe(0)
  })

  test("pre-existing non-user is rejected", async () => {
    const prog = Effect.gen(function* () {
      const svc = yield* SessionCommandDispatchService
      const result = (yield* svc.dispatch(base())) as any
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("validation.failed")
      expect(result.failure.retryable).toBe(false)
      expect(result.accepted).toBe(false)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(depsFor({ existingRole: "assistant" })), Effect.scoped))
  })

  test("same messageID in other session is scope_mismatch", async () => {
    const prog = Effect.gen(function* () {
      const svc = yield* SessionCommandDispatchService
      const result = (yield* svc.dispatch(base())) as any
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("scope_mismatch")
      expect(result.failure.retryable).toBe(false)
      expect(result.accepted).toBe(false)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(depsFor({ globalSession: "ses_other00000000000001" })), Effect.scoped),
    )
  })

  test("malformed file parts fail validation before accept", async () => {
    const goodFile = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: "a.txt" }
    const goodSymbol = {
      type: "file",
      mime: "text/plain",
      url: "file:///tmp/a.txt",
      source: { type: "symbol", path: "/tmp/a.txt", range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, name: "fn", kind: 1, text: { value: "x", start: 0, end: 1 } },
    }
    const goodResource = {
      type: "file",
      mime: "text/plain",
      url: "file:///tmp/a.txt",
      source: { type: "resource", clientName: "c", uri: "res://x", text: { value: "x", start: 0, end: 1 } },
    }
    expect(() => validateRequest({ ...base(), payload: { ...base().payload, parts: [goodFile, goodSymbol, goodResource] } })).not.toThrow()
    const badFilename = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: 42 }
    expect(() => validateRequest({ ...base(), payload: { ...base().payload, parts: [badFilename] } })).toThrow()
    const badSource = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", source: { type: "bogus" } }
    expect(() => validateRequest({ ...base(), payload: { ...base().payload, parts: [badSource] } })).toThrow()
    const prog = Effect.gen(function* () {
      const svc = yield* SessionCommandDispatchService
      const result = (yield* svc.dispatch({ ...base(), payload: { ...base().payload, parts: [badSource] } })) as any
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("validation.failed")
      expect(result.failure.retryable).toBe(false)
      expect(result.accepted).toBe(false)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(depsFor({})), Effect.scoped))
  })
})
