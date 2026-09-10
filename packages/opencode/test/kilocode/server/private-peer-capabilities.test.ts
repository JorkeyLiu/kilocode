import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect, Option } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import {
  Closed,
  Conflict,
  Service as PrivatePeerService,
  Unavailable,
  Unsupported,
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

describe("private peer capability negotiation", () => {
  test("pre-negotiation request is Unavailable, not Unsupported, without id/send", async () => {
    const linked = pair()
    try {
      linked.a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(linked.a)
          const failed = yield* svc.request("test/echo", {}).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Unavailable)
          expect(linked.a.getPendingCount()).toBe(0)
          expect(linked.a.peekNextId()).toBe(1)
          // No capabilities yet: supports is false.
          const scoped = yield* svc.current
          expect(Option.isSome(scoped)).toBeTrue()
          if (Option.isSome(scoped)) {
            expect(scoped.value.supports("test/echo")).toBeFalse()
            expect(scoped.value.capabilities).toEqual([])
          }
          yield* lease.release
        }),
      )
    } finally {
      closeAll(linked.a, linked.b)
    }
  })

  test("unsupported method fails typed Unsupported without id/send", async () => {
    const linked = pair()
    try {
      linked.a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(linked.a)
          yield* lease.negotiate(["offered/method"])
          const failed = yield* svc.request("missing/method", {}).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Unsupported)
          expect((failed as Unsupported).capability).toBe("missing/method")
          expect(linked.a.getPendingCount()).toBe(0)
          expect(linked.a.peekNextId()).toBe(1)
          expect(yield* svc.supports("missing/method")).toBeFalse()
          expect(yield* svc.supports("offered/method")).toBeTrue()
          yield* lease.release
        }),
      )
    } finally {
      closeAll(linked.a, linked.b)
    }
  })

  test("offered method round-trips; offered-but-unknown sends to host", async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const b = new JsonRpcPeer({
      reader: aToB,
      writer: bToA,
      onRequest: async (method: string, params: unknown) => {
        if (method === "offered/echo") return { echo: params }
        const err = new Error(`Method not found: ${method}`) as Error & { code: number }
        err.code = -32601
        throw err
      },
    })
    try {
      a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(a)
          yield* lease.negotiate(["offered/echo", "future/method"])
          const call = yield* svc.request("offered/echo", { n: 1 })
          const done: unknown = yield* Effect.promise(() => call.done)
          expect(done).toEqual({ echo: { n: 1 } })
          // Offered-but-unknown reaches the host; host answers MethodNotFound.
          const unknown = yield* svc.request("future/method", {})
          const settled = yield* Effect.promise(() =>
            unknown.done.then(
              () => ({ ok: true as const }),
              (err: unknown) => ({ ok: false as const, code: (err as { code?: number }).code }),
            ),
          )
          expect(settled.ok).toBeFalse()
          if (!settled.ok) expect(settled.code).toBe(-32601)
          yield* lease.release
        }),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("replacement isolation: old scope caps never apply to the new peer", async () => {
    const first = pair()
    const second = pair()
    try {
      first.a.markInitialized()
      second.a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(first.a)
          yield* lease.negotiate(["old/cap"])
          const seen = yield* svc.current
          expect(Option.isSome(seen)).toBeTrue()
          yield* lease.release
          const next = yield* svc.install(second.a)
          yield* next.negotiate(["new/cap"])
          // Old scope still refers to the old peer: supports false, request unavailable.
          if (Option.isSome(seen)) {
            expect(seen.value.supports("old/cap")).toBeFalse()
            expect(seen.value.supports("new/cap")).toBeFalse()
            const failed = yield* seen.value.request("old/cap", {}).pipe(Effect.flip)
            expect(failed).toBeInstanceOf(Unavailable)
          }
          expect(yield* svc.supports("new/cap")).toBeTrue()
          expect(yield* svc.supports("old/cap")).toBeFalse()
          yield* next.release
        }),
      )
    } finally {
      closeAll(first.a, first.b, second.a, second.b)
    }
  })

  test("stale lease negotiate is rejected and duplicate negotiate fails", async () => {
    const first = pair()
    const second = pair()
    try {
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(first.a)
          yield* lease.release
          const next = yield* svc.install(second.a)
          // Stale lease for the released peer cannot publish.
          const stale = yield* lease.negotiate(["x"]).pipe(Effect.flip)
          expect(stale).toBeInstanceOf(Conflict)
          yield* next.negotiate(["y"])
          const dup = yield* next.negotiate(["z"]).pipe(Effect.flip)
          expect(dup).toBeInstanceOf(Conflict)
          // Duplicate did not overwrite the first offer.
          expect(yield* svc.supports("y")).toBeTrue()
          expect(yield* svc.supports("z")).toBeFalse()
          yield* next.release
        }),
      )
    } finally {
      closeAll(first.a, first.b, second.a, second.b)
    }
  })

  test("closed peer negotiate fails and sweep clears negotiated state", async () => {
    const linked = pair()
    try {
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(linked.a)
          linked.a.dispose()
          const failed = yield* lease.negotiate(["x"]).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Closed)
          const seen = yield* svc.current
          expect(Option.isNone(seen)).toBeTrue()
          const missing = yield* svc.request("x", {}).pipe(Effect.flip)
          expect(missing).toBeInstanceOf(Unavailable)
        }),
      )
    } finally {
      closeAll(linked.a, linked.b)
    }
  })

  test("reserved names are never negotiable or callable", async () => {
    const linked = pair()
    try {
      linked.a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(linked.a)
          for (const name of ["initialize", "$/cancelRequest", "$/progress"]) {
            const failed = yield* lease.negotiate([name]).pipe(Effect.flip)
            expect(failed).toBeInstanceOf(Conflict)
            expect(yield* svc.supports(name)).toBeFalse()
            const call = yield* svc.request(name, {}).pipe(Effect.flip)
            expect(call).toBeInstanceOf(Unavailable)
            expect(linked.a.getPendingCount()).toBe(0)
            expect(linked.a.peekNextId()).toBe(1)
          }
          yield* lease.negotiate(["ok/method"])
          for (const name of ["initialize", "$/cancelRequest", "$/progress"]) {
            const blocked = yield* svc.request(name, {}).pipe(Effect.flip)
            expect(blocked).toBeInstanceOf(Unsupported)
            expect((blocked as Unsupported).capability).toBe(name)
          }
          expect(linked.a.getPendingCount()).toBe(0)
          expect(linked.a.peekNextId()).toBe(1)
          yield* lease.release
        }),
      )
    } finally {
      closeAll(linked.a, linked.b)
    }
  })

  test("replacement never inherits reverse capabilities", async () => {
    const first = pair()
    const second = pair()
    try {
      first.a.markInitialized()
      second.a.markInitialized()
      await run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          const lease = yield* svc.install(first.a)
          yield* lease.negotiate(["carry/over"])
          yield* lease.release
          const next = yield* svc.install(second.a)
          expect(yield* svc.supports("carry/over")).toBeFalse()
          const blocked = yield* svc.request("carry/over", {}).pipe(Effect.flip)
          expect(blocked).toBeInstanceOf(Unavailable)
          expect(second.a.getPendingCount()).toBe(0)
          expect(second.a.peekNextId()).toBe(1)
          yield* next.negotiate(["fresh/cap"])
          expect(yield* svc.supports("fresh/cap")).toBeTrue()
          expect(yield* svc.supports("carry/over")).toBeFalse()
          yield* next.release
        }),
      )
    } finally {
      closeAll(first.a, first.b, second.a, second.b)
    }
  })
})
