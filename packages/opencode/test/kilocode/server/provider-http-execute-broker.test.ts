import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Duration, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import * as PrivatePeer from "../../../src/kilocode/server/private-peer-registry"
import * as Broker from "../../../src/kilocode/server/provider-http-execute-broker"

const record = (endpoint = "https://api.example.com/v1") => ({
  name: "Acme",
  endpoint,
  protocol: "openai/completions" as const,
  models: { m1: { name: "M1" } },
  credential: "secret:kilo.credentials.global.provider.acme",
})

const validBody = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
const validInput = { providerId: "acme", modelId: "m1", record: record(), body: validBody }

function pairWithHandler(handler: (method: string, params: unknown, ctx: import("../../../src/private-worker/peer").RequestContext) => unknown | Promise<unknown>) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
  const b = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: handler as never })
  return { a, b, aToB, bToA }
}
function closeAll(...peers: JsonRpcPeer[]) {
  for (const p of peers) try { p.dispose() } catch {}
}

describe("provider/httpExecute broker protocol", () => {
  test("concurrent requests do not cross-deliver (raw wire)", async () => {
    const { a, b, aToB, bToA } = pairWithHandler(async (method, _params, ctx) => {
      if (method === "provider/httpExecute") {
        ctx.emit({ seq: 0, status: 200, headers: { "content-type": "text/plain" } })
        ctx.emit({ seq: 1, bytes: Buffer.from("hello ").toString("base64") })
        ctx.emit({ seq: 2, bytes: Buffer.from("world").toString("base64") })
        return { seq: 2, chunks: 2, bytes: Buffer.from("hello world").length }
      }
      throw new Error("unknown")
    })
    try {
      const h1 = a.requestWithId("provider/httpExecute", { providerId: "a", modelId: "m1", record: record(), body: validBody }, () => {})
      const h2 = a.requestWithId("provider/httpExecute", { providerId: "a", modelId: "m1", record: record(), body: validBody }, () => {})
      expect(h1.id).not.toBe(h2.id)
      expect(a.getPendingCount()).toBe(2)
      a.tryCancelPending(h1.id)
      a.tryCancelPending(h2.id)
      h1.promise.catch(() => {})
      h2.promise.catch(() => {})
    } finally {
      closeAll(a, b)
      aToB.destroy()
      bToA.destroy()
    }
  })

  test("metadata/status available while terminal promise is still held (broker)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { a, b } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 202, headers: { "x-custom": "ok" } })
      await gate
      return { seq: 0, chunks: 0, bytes: 0 }
    })
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const scope = yield* Scope.make()
          const httpStream = yield* broker.stream(validInput).pipe(Effect.provideService(Scope.Scope, scope))
          expect(httpStream.status).toBe(202)
          expect(httpStream.headers["x-custom"]).toBe("ok")
          expect(a.getPendingCount()).toBe(1)
          release()
          // drain stream (scoped to same scope, so it will complete after terminal)
          const fiber = yield* Effect.forkChild(Effect.scoped(Stream.runCollect(httpStream.stream).pipe(Effect.provideService(Scope.Scope, scope))))
          // wait for terminal and queue end
          yield* Effect.sleep(Duration.millis(50))
          const collected = yield* Fiber.join(fiber)
          expect([...collected].length).toBe(0)
          // scope close happens via fiber's scoped, but outer scope still needs close
          yield* Scope.close(scope, Exit.void)
          expect(a.getPendingCount()).toBe(0)
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("first chunk consumable before terminal (broker)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const payload = "first-chunk-payload"
    const { a, b } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      ctx.emit({ seq: 1, bytes: Buffer.from(payload).toString("base64") })
      await gate
      return { seq: 1, chunks: 1, bytes: Buffer.byteLength(payload) }
    })
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const scope = yield* Scope.make()
          const httpStream = yield* broker.stream(validInput).pipe(Effect.provideService(Scope.Scope, scope))
          expect(httpStream.status).toBe(200)
          expect(a.getPendingCount()).toBe(1)
          // fork collection that will wait for terminal
          const chunkFiber = yield* Effect.forkChild(Effect.scoped(Stream.runCollect(httpStream.stream).pipe(Effect.provideService(Scope.Scope, scope))))
          yield* Effect.sleep(Duration.millis(20))
          expect(a.getPendingCount()).toBe(1)
          release()
          const collected = yield* Fiber.join(chunkFiber)
          const out = Buffer.concat([...collected].map((u) => Buffer.from(u as Uint8Array))).toString("utf8")
          expect(out).toBe(payload)
          yield* Scope.close(scope, Exit.void)
          expect(a.getPendingCount()).toBe(0)
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("ordered completion preserves sequence (broker)", async () => {
    const parts = ["hello ", "world", "!", " done"]
    const total = parts.join("").length
    const { a, b } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      parts.forEach((p, i) => ctx.emit({ seq: i + 1, bytes: Buffer.from(p).toString("base64") }))
      return { seq: parts.length, chunks: parts.length, bytes: total }
    })
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const out = yield* Effect.scoped(
            Effect.gen(function* () {
              const s = yield* broker.stream(validInput)
              const collected = yield* Stream.runCollect(s.stream)
              const txt = Buffer.concat([...collected].map((u) => Buffer.from(u as Uint8Array))).toString("utf8")
              expect(txt).toBe(parts.join(""))
              expect(s.status).toBe(200)
              return txt
            }),
          )
          expect(out).toBe(parts.join(""))
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("terminal mismatch fails typed protocol error (broker)", async () => {
    // seq/chunks mismatch
    const { a, b } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      ctx.emit({ seq: 1, bytes: Buffer.from("hi").toString("base64") })
      return { seq: 2, chunks: 2, bytes: 2 }
    })
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const err = yield* Effect.scoped(
            Effect.gen(function* () {
              const s = yield* broker.stream(validInput)
              yield* Stream.runCollect(s.stream)
            }),
          ).pipe(Effect.flip)
          expect((err as unknown as { _tag: string })._tag).toBe("ProviderHttpProtocolError")
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
    // bytes mismatch
    const { a: a2, b: b2 } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      ctx.emit({ seq: 1, bytes: Buffer.from("hello").toString("base64") })
      return { seq: 1, chunks: 1, bytes: 9999 }
    })
    try {
      a2.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a2)
          yield* lease.negotiate(["provider/httpExecute"])
          const err = yield* Effect.scoped(
            Effect.gen(function* () {
              const s = yield* broker.stream(validInput)
              yield* Stream.runCollect(s.stream)
            }),
          ).pipe(Effect.flip)
          expect((err as unknown as { _tag: string })._tag).toBe("ProviderHttpProtocolError")
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a2, b2)
    }
  })

  test("early stream finalization / scope close drops exact call once (broker)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { a, b } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      await gate
      return { seq: 0, chunks: 0, bytes: 0 }
    })
    let drops = 0
    const origCancel = a.cancel.bind(a)
    ;(a as unknown as { cancel: (id: unknown) => boolean }).cancel = (id: unknown) => {
      drops++
      return origCancel(id as never)
    }
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                const s = yield* broker.stream(validInput)
                // hold stream open
                yield* Effect.never
                return s
              }),
            ),
          )
          // wait for pending
          for (let i = 0; i < 50; i++) {
            if (a.getPendingCount() === 1) break
            yield* Effect.sleep(Duration.millis(10))
          }
          expect(a.getPendingCount()).toBe(1)
          expect(drops).toBe(0)
          yield* Fiber.interrupt(fiber)
          // after interrupt, drop exactly once
          yield* Effect.sleep(Duration.millis(20))
          expect(drops).toBe(1)
          expect(a.getPendingCount()).toBe(0)
          // second interrupt should not increase
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
          yield* Effect.sleep(Duration.millis(10))
          expect(drops).toBe(1)
          release()
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("protocol error drops once (broker)", async () => {
    const { a, b } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      await new Promise((r) => setTimeout(r, 30))
      // out-of-order seq should trigger protocol error
      ctx.emit({ seq: 3, bytes: Buffer.from("bad").toString("base64") })
      // keep handler open a bit to verify no second drop
      await new Promise((r) => setTimeout(r, 200))
      return { seq: 1, chunks: 1, bytes: 3 }
    })
    let drops = 0
    const origCancel = a.cancel.bind(a)
    ;(a as unknown as { cancel: (id: unknown) => boolean }).cancel = (id: unknown) => {
      drops++
      return origCancel(id as never)
    }
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const err = yield* Effect.scoped(
            Effect.gen(function* () {
              const s = yield* broker.stream(validInput)
              yield* Stream.runCollect(s.stream)
            }),
          ).pipe(Effect.flip)
          expect((err as unknown as { _tag: string })._tag).toBe("ProviderHttpProtocolError")
          yield* Effect.sleep(Duration.millis(20))
          expect(drops).toBe(1)
          expect(a.getPendingCount()).toBe(0)
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("concurrent streams isolated (broker)", async () => {
    const { a, b } = pairWithHandler(async (_m, params, ctx) => {
      const p = params as { headers?: Record<string, string> }
      const which = p.headers?.["x-which"] ?? "unknown"
      ctx.emit({ seq: 0, status: 200, headers: {} })
      const payload = which === "req1" ? "one" : which === "req2" ? "two" : "unknown"
      ctx.emit({ seq: 1, bytes: Buffer.from(payload).toString("base64") })
      return { seq: 1, chunks: 1, bytes: Buffer.byteLength(payload) }
    })
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const inp1 = { providerId: "acme", modelId: "m1", record: record(), body: validBody, headers: { "x-which": "req1" } as unknown as Record<string, string> }
          const inp2 = { providerId: "acme", modelId: "m1", record: record(), body: validBody, headers: { "x-which": "req2" } as unknown as Record<string, string> }
          const f1 = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                const s = yield* broker.stream(inp1)
                const c = yield* Stream.runCollect(s.stream)
                return Buffer.concat([...c].map((u) => Buffer.from(u as Uint8Array))).toString("utf8")
              }),
            ),
          )
          const f2 = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                const s = yield* broker.stream(inp2)
                const c = yield* Stream.runCollect(s.stream)
                return Buffer.concat([...c].map((u) => Buffer.from(u as Uint8Array))).toString("utf8")
              }),
            ),
          )
          const o1 = yield* Fiber.join(f1)
          const o2 = yield* Fiber.join(f2)
          expect(o1).toBe("one")
          expect(o2).toBe("two")
          expect(a.getPendingCount()).toBe(0)
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("broker execute collects bytes correctly (real peer)", async () => {
    const payload = "execute collect test"
    const { a, b } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: { "content-type": "text/plain" } })
      const mid = Math.floor(payload.length / 2)
      ctx.emit({ seq: 1, bytes: Buffer.from(payload.slice(0, mid)).toString("base64") })
      ctx.emit({ seq: 2, bytes: Buffer.from(payload.slice(mid)).toString("base64") })
      return { seq: 2, chunks: 2, bytes: Buffer.byteLength(payload) }
    })
    try {
      a.markInitialized()
      await Effect.runPromise(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate(["provider/httpExecute"])
          const out = yield* broker.execute(validInput)
          expect(out.status).toBe(200)
          expect(Buffer.from(out.bytes).toString("utf8")).toBe(payload)
          yield* lease.release
        }).pipe(Effect.provide(Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer)))),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("end-to-end bytes reconstruction via peer events (real peer)", async () => {
    const a2B = new PassThrough()
    const b2A = new PassThrough()
    const srv = new JsonRpcPeer({
      reader: b2A,
      writer: a2B,
      onRequest: async (m, _p, ctx) => {
        ctx.emit({ seq: 0, status: 200, headers: {} })
        ctx.emit({ seq: 1, bytes: Buffer.from("hello").toString("base64") })
        return { seq: 1, chunks: 1, bytes: 5 }
      },
    })
    const cli = new JsonRpcPeer({ reader: a2B, writer: b2A })
    try {
      const evs: unknown[] = []
      const h = cli.requestWithEvents("provider/httpExecute", {}, (ev) => evs.push(ev))
      const res = (await h.promise) as { seq: number; chunks: number; bytes: number }
      expect(evs.length).toBe(2)
      expect((evs[0] as { seq: number }).seq).toBe(0)
      expect((evs[1] as { seq: number }).seq).toBe(1)
      expect(res.seq).toBe(1)
      expect(res.bytes).toBe(5)
      const decoded = Buffer.from((evs[1] as { bytes: string }).bytes, "base64").toString("utf8")
      expect(decoded).toBe("hello")
    } finally {
      cli.dispose()
      srv.dispose()
      a2B.destroy()
      b2A.destroy()
    }
  })
})
