import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect, Option } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import {
  Closed,
  Conflict,
  Service as PrivatePeerService,
  Unavailable,
  defaultLayer as PrivatePeerLayer,
} from "../../../src/kilocode/server/private-peer-registry"

const run = <A, E>(effect: Effect.Effect<A, E, PrivatePeerService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(PrivatePeerLayer)))

function pair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
  const b = new JsonRpcPeer({ reader: aToB, writer: bToA })
  return { a, b }
}

function closeAll(...peers: JsonRpcPeer[]): void {
  for (const p of peers) {
    try {
      p.dispose()
    } catch (err) {
      console.warn("[cleanup:closeAll] peer dispose failed:", String(err))
    }
  }
}

describe("private-peer-registry", () => {
  test("no peer: current none and request unavailable", async () => {
    await run(
      Effect.gen(function* () {
        const svc = yield* PrivatePeerService
        const seen = yield* svc.current
        expect(Option.isNone(seen)).toBeTrue()
        const failed = yield* svc.request("test/echo", {}).pipe(Effect.flip)
        expect(failed).toBeInstanceOf(Unavailable)
      }),
    )
  })

  test("pre-init peer: current some but request unavailable without sending", async () => {
    const linked = pair()
    try {
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(linked.a)
          expect(linked.a.isInitialized()).toBeFalse()
          const failed = yield* svc.request("test/echo", {}).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Unavailable)
          // Nothing was emitted: no pending entry and no id consumed.
          expect(linked.a.getPendingCount()).toBe(0)
          expect(linked.a.peekNextId()).toBe(1)
          linked.a.markInitialized()
          const scoped = yield* svc.current
          expect(Option.isSome(scoped)).toBeTrue()
          yield* lease.release
        }),
      )
    } finally {
      closeAll(linked.a, linked.b)
    }
  })

  test("install then request round-trips through the open peer", async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const b = new JsonRpcPeer({
      reader: aToB,
      writer: bToA,
      onRequest: async (method: string, params: unknown) => {
        if (method === "test/echo") return { echo: params }
        throw new Error(`unexpected ${method}`)
      },
    })
    try {
      a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(a)
          yield* lease.negotiate(["test/echo"])
          const seen = yield* svc.current
          expect(Option.isSome(seen)).toBeTrue()
          const call = yield* svc.request("test/echo", { n: 7 })
          const done: unknown = yield* Effect.promise(() => call.done)
          expect(done).toEqual({ echo: { n: 7 } })
          // Scoped request through current uses the same open peer.
          if (Option.isSome(seen)) {
            const scoped = yield* seen.value.request("test/echo", { n: 8 })
            const out: unknown = yield* Effect.promise(() => scoped.done)
            expect(out).toEqual({ echo: { n: 8 } })
            // Scoped drop of an unknown id sends nothing and reports false.
            expect(seen.value.drop(999)).toBeFalse()
          } else {
            throw new Error("expected current scope")
          }
          yield* lease.release
          const after = yield* svc.current
          expect(Option.isNone(after)).toBeTrue()
          // Release never disposes the peer.
          expect(a.getState()).toBe("open")
        }),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("same peer repeat install fails closed (single owner, no refcount)", async () => {
    const linked = pair()
    try {
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const first = yield* svc.install(linked.a)
          const failed = yield* svc.install(linked.a).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Conflict)
          const seen = yield* svc.current
          expect(Option.isSome(seen)).toBeTrue()
          // One exact release clears; duplicate releases are no-ops.
          yield* first.release
          expect(Option.isNone(yield* svc.current)).toBeTrue()
          yield* first.release
          expect(Option.isNone(yield* svc.current)).toBeTrue()
          expect(linked.a.getState()).toBe("open")
        }),
      )
    } finally {
      closeAll(linked.a, linked.b)
    }
  })

  test("different live peer install fails closed and keeps old", async () => {
    const first = pair()
    const second = pair()
    try {
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(first.a)
          const failed = yield* svc.install(second.a).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Conflict)
          const seen = yield* svc.current
          expect(Option.isSome(seen)).toBeTrue()
          // Stale release of the rejected peer is a no-op.
          yield* svc.release(second.a)
          const kept = yield* svc.current
          expect(Option.isSome(kept)).toBeTrue()
          yield* lease.release
          const after = yield* svc.current
          expect(Option.isNone(after)).toBeTrue()
          // Neither install nor release disposes peers.
          expect(first.a.getState()).toBe("open")
          expect(second.a.getState()).toBe("open")
        }),
      )
    } finally {
      closeAll(first.a, first.b, second.a, second.b)
    }
  })

  test("closed peer cannot install and current sweeps closed peer", async () => {
    const linked = pair()
    const shut = pair()
    try {
      shut.a.dispose()
      expect(shut.a.getState()).toBe("closed")
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const failed = yield* svc.install(shut.a).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Closed)
          const lease = yield* svc.install(linked.a)
          void lease
          linked.a.dispose()
          expect(linked.a.getState()).toBe("closed")
          const seen = yield* svc.current
          expect(Option.isNone(seen)).toBeTrue()
          const missing = yield* svc.request("test/echo", {}).pipe(Effect.flip)
          expect(missing).toBeInstanceOf(Unavailable)
        }),
      )
    } finally {
      closeAll(linked.a, linked.b, shut.a, shut.b)
    }
  })

  test("replacement allowed only after old release", async () => {
    const first = pair()
    const second = pair()
    try {
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(first.a)
          const blocked = yield* svc.install(second.a).pipe(Effect.flip)
          expect(blocked).toBeInstanceOf(Conflict)
          yield* lease.release
          const next = yield* svc.install(second.a)
          const seen = yield* svc.current
          expect(Option.isSome(seen)).toBeTrue()
          yield* next.release
        }),
      )
    } finally {
      closeAll(first.a, first.b, second.a, second.b)
    }
  })

  test("old call drop after replacement never touches the new peer", async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const aHang = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const bHang = new JsonRpcPeer({
      reader: aToB,
      writer: bToA,
      // Never answers: the call stays pending on the old peer.
      onRequest: () => new Promise<unknown>(() => {}),
    })
    const second = pair()
    try {
      aHang.markInitialized()
      second.a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(aHang)
          yield* lease.negotiate(["test/hang"])
          const call = yield* svc.request("test/hang", {})
          expect(aHang.getPendingIds()).toEqual([call.id])
          yield* lease.release
          const next = yield* svc.install(second.a)
          // Dropping the stale call only cancels the captured old peer.
          const dropped = call.drop()
          expect(dropped).toBeTrue()
          expect(aHang.getPendingCount()).toBe(0)
          expect(second.a.getPendingCount()).toBe(0)
          expect(second.a.peekNextId()).toBe(1)
          const settled = yield* Effect.promise(() =>
            call.done.then(
              () => ({ ok: true as const }),
              () => ({ ok: false as const }),
            ),
          )
          expect(settled.ok).toBeFalse()
          yield* next.release
        }),
      )
    } finally {
      closeAll(aHang, bHang, second.a, second.b)
    }
  })

  test("isolated layers hold independent state", async () => {
    const linked = pair()
    try {
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          yield* svc.install(linked.a)
          return yield* svc.current
        }).pipe(Effect.provide(PrivatePeerLayer)),
      )
      expect(Option.isSome(first)).toBeTrue()
      // A second isolated build does not see the first build's peer: custom
      // layers never share registry state. Only the shared canonical layer
      // memoMap identity (production serve runtime) is the supported scope.
      const second = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.current
        }).pipe(Effect.provide(PrivatePeerLayer)),
      )
      expect(Option.isNone(second)).toBeTrue()
    } finally {
      closeAll(linked.a, linked.b)
    }
  })
})
