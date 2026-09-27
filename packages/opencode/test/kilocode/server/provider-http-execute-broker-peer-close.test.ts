import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import * as Option from "effect/Option"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import * as PrivatePeer from "../../../src/kilocode/server/private-peer-registry"
import * as Broker from "../../../src/kilocode/server/provider-http-execute-broker"

const record = () => ({
  name: "Acme",
  endpoint: "https://api.example.com/v1",
  protocol: "openai/completions" as const,
  models: { m1: { name: "M1" } },
  credential: "secret:kilo.credentials.global.provider.acme",
})
const validBody = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
const validInput = { providerId: "acme", modelId: "m1", record: record(), body: validBody }

function pairWithHandler(
  handler: (method: string, params: unknown, ctx: import("../../../src/private-worker/peer").RequestContext) => unknown | Promise<unknown>,
) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
  const b = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: handler as never })
  return { a, b, aToB, bToA }
}

function closeAll(a: JsonRpcPeer, b: JsonRpcPeer, aToB: PassThrough, bToA: PassThrough) {
  try {
    a.dispose()
  } catch {}
  try {
    b.dispose()
  } catch {}
  try {
    aToB.destroy()
  } catch {}
  try {
    bToA.destroy()
  } catch {}
}

const infra = Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer))

const tagOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "SUCCESS"
  const errOpt = Cause.findErrorOption(exit.cause)
  if (Option.isSome(errOpt)) return (errOpt.value as { _tag?: string })._tag ?? String(errOpt.value).slice(0, 80)
  return "unknown-fail"
}

describe("provider/httpExecute broker peer-close", () => {
  test("peer close during metadata: stream acquisition fails promptly, drop exactly once", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { a, b, aToB, bToA } = pairWithHandler(async () => {
      await gate
      return { seq: 0, chunks: 0, bytes: 0 }
    })
    try {
      a.markInitialized()
      let drops = 0
      const origCancel = a.cancel.bind(a)
      ;(a as unknown as { cancel: (id: unknown) => boolean }).cancel = (id: unknown) => {
        drops++
        return origCancel(id as never)
      }
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const scope = yield* Scope.make()
          const fiber = yield* Effect.forkChild(broker.stream(validInput).pipe(Effect.provideService(Scope.Scope, scope)))
          yield* Effect.sleep(Duration.millis(50))
          // CLI-side transport loss before any metadata: call.done rejects
          a.dispose()
          const exit = yield* Fiber.await(fiber).pipe(
            Effect.timeoutOption("2 seconds"),
          )
          release()
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
          yield* lease.release.pipe(Effect.ignore)
          return {
            settled: Option.isSome(exit),
            tag: Option.isSome(exit) ? tagOf(exit.value) : "HUNG",
            pending: a.getPendingCount(),
            drops,
          }
        }).pipe(Effect.provide(infra)),
      )
      expect(out.settled).toBe(true)
      expect(out.tag).toBe("ProviderHttpProtocolError")
      expect(out.pending).toBe(0)
      expect(out.drops).toBe(1)
    } finally {
      closeAll(a, b, aToB, bToA)
    }
  })

  test("peer close after metadata with pull held: consumer fails, never truncated success", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { a, b, aToB, bToA } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      ctx.emit({ seq: 1, bytes: Buffer.from("part1").toString("base64") })
      await gate
      return { seq: 1, chunks: 1, bytes: 5 }
    })
    try {
      a.markInitialized()
      let drops = 0
      const origCancel = a.cancel.bind(a)
      ;(a as unknown as { cancel: (id: unknown) => boolean }).cancel = (id: unknown) => {
        drops++
        return origCancel(id as never)
      }
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const scope = yield* Scope.make()
          const httpStream = yield* broker.stream(validInput).pipe(Effect.provideService(Scope.Scope, scope))
          expect(httpStream.status).toBe(200)
          const fiber = yield* Effect.forkChild(
            Effect.scoped(Stream.runCollect(httpStream.stream).pipe(Effect.provideService(Scope.Scope, scope))),
          )
          yield* Effect.sleep(Duration.millis(50))
          // transport loss while the consumer pull is held
          a.dispose()
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("2 seconds"))
          release()
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
          yield* lease.release.pipe(Effect.ignore)
          return {
            settled: Option.isSome(exit),
            tag: Option.isSome(exit) ? tagOf(exit.value) : "HUNG",
            pending: a.getPendingCount(),
            drops,
          }
        }).pipe(Effect.provide(infra)),
      )
      expect(out.settled).toBe(true)
      expect(out.tag).toBe("ProviderHttpProtocolError")
      expect(out.pending).toBe(0)
      expect(out.drops).toBe(1)
    } finally {
      closeAll(a, b, aToB, bToA)
    }
  })

  test("failure recorded before scope close stays a failure (fail wins over end)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { a, b, aToB, bToA } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      ctx.emit({ seq: 1, bytes: Buffer.from("part1").toString("base64") })
      await gate
      return { seq: 1, chunks: 1, bytes: 5 }
    })
    try {
      a.markInitialized()
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const scope = yield* Scope.make()
          const httpStream = yield* broker.stream(validInput).pipe(Effect.provideService(Scope.Scope, scope))
          const fiber = yield* Effect.forkChild(
            Effect.scoped(Stream.runCollect(httpStream.stream).pipe(Effect.provideService(Scope.Scope, scope))),
          )
          yield* Effect.sleep(Duration.millis(50))
          // provider loss first: failure owns meta + queue
          a.dispose()
          yield* Effect.sleep(Duration.millis(100))
          // scope teardown races in late: must not downgrade to clean EOF
          yield* Scope.close(scope, Exit.void)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("2 seconds"))
          release()
          yield* lease.release.pipe(Effect.ignore)
          return {
            settled: Option.isSome(exit),
            tag: Option.isSome(exit) ? tagOf(exit.value) : "HUNG",
          }
        }).pipe(Effect.provide(infra)),
      )
      expect(out.settled).toBe(true)
      expect(out.tag).toBe("ProviderHttpProtocolError")
    } finally {
      closeAll(a, b, aToB, bToA)
    }
  })

  test("scope teardown interrupts a scoped consumer (no lingering truncated continuation)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { a, b, aToB, bToA } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      ctx.emit({ seq: 1, bytes: Buffer.from("part1").toString("base64") })
      await gate
      return { seq: 1, chunks: 1, bytes: 5 }
    })
    try {
      a.markInitialized()
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const scope = yield* Scope.make()
          const httpStream = yield* broker.stream(validInput).pipe(Effect.provideService(Scope.Scope, scope))
          // consumer owned by the broker scope: teardown interrupts it
          const fiber = yield* Stream.runCollect(httpStream.stream).pipe(
            Effect.forkScoped,
            Effect.provideService(Scope.Scope, scope),
          )
          yield* Effect.sleep(Duration.millis(50))
          yield* Scope.close(scope, Exit.void)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("2 seconds"))
          release()
          yield* lease.release.pipe(Effect.ignore)
          return {
            settled: Option.isSome(exit),
            interrupted: Option.isSome(exit) && Exit.isFailure(exit.value) && Cause.hasInterruptsOnly(exit.value.cause),
            success: Option.isSome(exit) && Exit.isSuccess(exit.value),
          }
        }).pipe(Effect.provide(infra)),
      )
      expect(out.settled).toBe(true)
      // teardown wins: interrupted, never a lingering truncated success
      expect(out.interrupted).toBe(true)
      expect(out.success).toBe(false)
    } finally {
      closeAll(a, b, aToB, bToA)
    }
  })
})
