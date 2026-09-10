import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect, Option } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { awaitPeerClosedHandoffs, carrierRegistry, createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import type { FdCarrierRegistry } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Closed, Service as PrivatePeerService, Unavailable } from "../../../src/kilocode/server/private-peer-registry"

function note(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

async function poll(check: () => Promise<boolean>, message: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > timeoutMs) throw new Error(message)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const isCurrent = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const svc = yield* PrivatePeerService
      return Option.isSome(yield* svc.current)
    }),
  )

const initExt = (ext: JsonRpcPeer) =>
  ext.request("initialize", {
    protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
    clientInfo: { name: "kilo-vscode", version: "7.4.11" },
    capabilities: ["session/cancelQueued"],
    reverseCapabilities: ["test/echo", "test/hang"],
  })

describe("fd-carrier private peer registry", () => {
  test("pre-init registry request fails closed, post-init round-trips", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    // Explicit opt-in: only carriers with a registry touch the global one.
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: carrierRegistry })
    const ext = new JsonRpcPeer({
      reader: carrierToExt,
      writer: extToCarrier,
      onRequest: async (method: string, params: unknown) => {
        if (method === "test/echo") return { echo: params }
        throw new Error(`unexpected ${method}`)
      },
    })
    try {
      await carrier.ready
      // Same service identity: the carrier-installed peer is reachable
      // through the global runtime registry (production default AppLayer).
      const early = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.request("test/echo", { n: 1 }).pipe(Effect.flip)
        }),
      )
      expect(early).toBeInstanceOf(Unavailable)
      const init = (await initExt(ext)) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      const call = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.request("test/echo", { n: 3 })
        }),
      )
      const done: unknown = await call.done
      expect(done).toEqual({ echo: { n: 3 } })
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
    // Release is tracked in the lifecycle handoffs: joining them settles
    // cleanup, so the check below is direct with no release poll.
    await awaitPeerClosedHandoffs()
    expect(await isCurrent()).toBeFalse()
  })

  test("registry handle drop signals remote abort", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: carrierRegistry })
    let aborted = false
    const ext = new JsonRpcPeer({
      reader: carrierToExt,
      writer: extToCarrier,
      onRequest: async (method: string, _params: unknown, ctx) => {
        if (method !== "test/hang") throw new Error(`unexpected ${method}`)
        await new Promise<void>((_, reject) => {
          if (ctx.signal.aborted) {
            aborted = true
            reject(new Error("aborted"))
            return
          }
          ctx.signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        })
        throw new Error("unreachable")
      },
    })
    try {
      await carrier.ready
      await initExt(ext)
      const call = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.request("test/hang", {})
        }),
      )
      const settled = call.done.then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      )
      const dropped = call.drop()
      expect(dropped).toBeTrue()
      const out = await settled
      expect(out.ok).toBeFalse()
      await poll(async () => aborted, "remote abort never signaled")
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
    await awaitPeerClosedHandoffs()
    expect(await isCurrent()).toBeFalse()
  })

  test("carrier EOF releases registry; requests fail closed", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: carrierRegistry })
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      await carrier.ready
      expect(await isCurrent()).toBeTrue()
      extToCarrier.end()
      // The close event itself is stream I/O timing; once observed, the
      // tracked release settles through the handoff barrier.
      await poll(async () => carrier.peer.getState() === "closed", "carrier peer never closed after EOF")
      await awaitPeerClosedHandoffs()
      expect(await isCurrent()).toBeFalse()
      const failed = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.request("test/echo", {}).pipe(Effect.flip)
        }),
      )
      expect(failed).toBeInstanceOf(Unavailable)
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })

  test("install conflict disposes the new carrier and keeps the old current", async () => {
    const firstExtToCarrier = new PassThrough()
    const firstCarrierToExt = new PassThrough()
    const first = createFdCarrier(firstExtToCarrier, firstCarrierToExt, { registry: carrierRegistry })
    const firstExt = new JsonRpcPeer({
      reader: firstCarrierToExt,
      writer: firstExtToCarrier,
      onRequest: async (method: string, params: unknown) => {
        if (method === "test/echo") return { echo: params }
        throw new Error(`unexpected ${method}`)
      },
    })
    try {
      await first.ready
      await initExt(firstExt)
      const secondExtToCarrier = new PassThrough()
      const secondCarrierToExt = new PassThrough()
      const second = createFdCarrier(secondExtToCarrier, secondCarrierToExt, { registry: carrierRegistry })
      let failed: unknown
      try {
        await second.ready
      } catch (err) {
        failed = err
      }
      expect(failed).toBeDefined()
      // The conflicting carrier cleaned its own streams; the peer is closed.
      await poll(async () => second.peer.getState() === "closed", "conflicting peer never disposed")
      expect(secondExtToCarrier.destroyed || secondExtToCarrier.closed).toBeTrue()
      // Old current is preserved and still answers.
      const call = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.request("test/echo", { n: 11 })
        }),
      )
      const done: unknown = await call.done
      expect(done).toEqual({ echo: { n: 11 } })
    } finally {
      try {
        first.dispose()
      } catch (err) {
        note("first", err)
      }
      try {
        firstExt.dispose()
      } catch (err) {
        note("firstExt", err)
      }
    }
    // After the old release a new carrier installs cleanly.
    await awaitPeerClosedHandoffs()
    expect(await isCurrent()).toBeFalse()
    const thirdExtToCarrier = new PassThrough()
    const thirdCarrierToExt = new PassThrough()
    const third = createFdCarrier(thirdExtToCarrier, thirdCarrierToExt, { registry: carrierRegistry })
    const thirdExt = new JsonRpcPeer({ reader: thirdCarrierToExt, writer: thirdExtToCarrier })
    try {
      await third.ready
      expect(await isCurrent()).toBeTrue()
    } finally {
      try {
        third.dispose()
      } catch (err) {
        note("third", err)
      }
      try {
        thirdExt.dispose()
      } catch (err) {
        note("thirdExt", err)
      }
    }
    await awaitPeerClosedHandoffs()
    expect(await isCurrent()).toBeFalse()
  })
})

describe("fd-carrier registry state machine", () => {
  test("close before install completion still releases exactly once", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    let resolveInstall!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveInstall = resolve
    })
    const releases: JsonRpcPeer[] = []
    const stub: FdCarrierRegistry = {
      install: () => gate,
      negotiate: () => Promise.resolve(),
      release: (target) => {
        releases.push(target)
        return Promise.resolve()
      },
    }
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      // Close while the install is still pending: the completion callback
      // must reconcile (exact release) without relying on ordering.
      carrier.dispose()
      expect(carrier.peer.getState()).toBe("closed")
      expect(releases.length).toBe(0)
      resolveInstall()
      await carrier.ready
      expect(releases).toEqual([carrier.peer])
      // Duplicate dispose stays a no-op: no second release.
      carrier.dispose()
      expect(releases.length).toBe(1)
    } finally {
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })

  test("install rejected closed claims nothing and releases nothing", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    let resolveInstall!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveInstall = resolve
    })
    const releases: JsonRpcPeer[] = []
    const stub: FdCarrierRegistry = {
      // Models the real service: a peer closed before the install effect
      // runs fails Closed with no registry claim.
      install: (target) =>
        gate.then(() => {
          if (target.getState() !== "open") throw new Closed()
        }),
      negotiate: () => Promise.resolve(),
      release: (target) => {
        releases.push(target)
        return Promise.resolve()
      },
    }
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    let failed: unknown
    try {
      carrier.dispose()
      resolveInstall()
      try {
        await carrier.ready
      } catch (err) {
        failed = err
      }
      expect(failed).toBeInstanceOf(Closed)
      expect(releases.length).toBe(0)
    } finally {
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })

  test("barrier joins release enqueued by late-committed install", async () => {
    // Quiesce first so the barrier below starts from an empty set.
    await awaitPeerClosedHandoffs()
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    let resolveInstall!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveInstall = resolve
    })
    const releases: JsonRpcPeer[] = []
    const stub: FdCarrierRegistry = {
      install: () => gate,
      negotiate: () => Promise.resolve(),
      release: (target) => {
        releases.push(target)
        return Promise.resolve()
      },
    }
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      // Close while the install is pending: no release/notify is tracked yet,
      // but install completion itself is — so the barrier must span it.
      carrier.dispose()
      expect(releases.length).toBe(0)
      // Start the barrier without awaiting `ready`: the late commit below
      // enqueues the release mid-drain, and the barrier must not return
      // before joining it.
      const waiting = awaitPeerClosedHandoffs()
      resolveInstall()
      await waiting
      expect(releases).toEqual([carrier.peer])
      // Exactly once: further disposes add nothing.
      carrier.dispose()
      await awaitPeerClosedHandoffs()
      expect(releases.length).toBe(1)
    } finally {
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })

  test("async release rejection is warned, tracked, and never unhandled", async () => {
    await awaitPeerClosedHandoffs()
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const attempts: JsonRpcPeer[] = []
    const stub: FdCarrierRegistry = {
      install: () => Promise.resolve(),
      negotiate: () => Promise.resolve(),
      release: (target) => {
        attempts.push(target)
        return Promise.reject(new Error("release-boom"))
      },
    }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((part) => String(part)).join(" "))
    }
    try {
      const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
      const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
      try {
        await carrier.ready
        // Production behavior never throws: the rejection is wrapped,
        // warned, and joined by the barrier.
        carrier.dispose()
        await awaitPeerClosedHandoffs()
        expect(attempts).toEqual([carrier.peer])
        expect(
          warns.some((line) => line.includes("registry release failed") && line.includes("release-boom")),
        ).toBeTrue()
      } finally {
        try {
          carrier.dispose()
        } catch (err) {
          note("carrier", err)
        }
        try {
          ext.dispose()
        } catch (err) {
          note("ext", err)
        }
      }
    } finally {
      console.warn = origWarn
    }
  })

  test("duplicate dispose notifies and releases once", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const releases: JsonRpcPeer[] = []
    const stub: FdCarrierRegistry = {
      install: () => Promise.resolve(),
      negotiate: () => Promise.resolve(),
      release: (target) => {
        releases.push(target)
        return Promise.resolve()
      },
    }
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      await carrier.ready
      carrier.dispose()
      carrier.dispose()
      // onClosed fired once inside the first dispose; every path funnels
      // through the single reconcile, so the release happens exactly once.
      expect(releases).toEqual([carrier.peer])
    } finally {
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })
})
