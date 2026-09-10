import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect, ManagedRuntime, Option } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { awaitPeerClosedHandoffs, carrierRegistry, createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import type { FdCarrierRegistry } from "../../../src/kilocode/server/fd-carrier"
import type { FdCarrierHandle } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppRuntime } from "../../../src/effect/app-runtime"
import {
  Conflict,
  Service as PrivatePeerService,
  Unsupported,
  defaultLayer as PrivatePeerLayer,
} from "../../../src/kilocode/server/private-peer-registry"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { FrameDecoder, encodeFrame } from "../../../src/private-worker/frame"

function note(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

function initParams(reverse?: unknown, legacy?: unknown): Record<string, unknown> {
  const p: Record<string, unknown> = {
    protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
    clientInfo: { name: "kilo-vscode", version: "7.4.11" },
  }
  if (legacy !== undefined) p.capabilities = legacy
  if (reverse !== undefined) p.reverseCapabilities = reverse
  return p
}

type Iso = {
  readonly registry: FdCarrierRegistry
  readonly supports: (cap: string) => Promise<boolean>
  readonly requestError: (method: string, params?: unknown) => Promise<unknown>
  readonly dispose: () => Promise<void>
}

// Isolated registry backed by a private PrivatePeer layer: no shared
// process-wide global runtime state, so capability tests never disturb or
// observe other files' integration tests. Only the single production
// identity test below uses the global carrierRegistry.
function makeIsolated(): Iso {
  const rt = ManagedRuntime.make(PrivatePeerLayer)
  const run = <A, E>(effect: Effect.Effect<A, E, PrivatePeerService>): Promise<A> =>
    rt.runPromise(effect as Effect.Effect<A, E, never>)
  const registry: FdCarrierRegistry = {
    install: (target) =>
      run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          yield* svc.install(target)
        }),
      ).then(() => undefined),
    negotiate: (target, caps) =>
      run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          yield* svc.negotiate(target, caps)
        }),
      ).then(() => undefined),
    release: (target) =>
      run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          yield* svc.release(target)
        }),
      ),
  }
  return {
    registry,
    supports: (cap) =>
      run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.supports(cap)
        }),
      ),
    requestError: (method, params) =>
      run(
        Effect.gen(function* () {
          const svc = yield* PrivatePeerService
          return yield* svc.request(method, params).pipe(Effect.flip)
        }),
      ),
    dispose: () => rt.dispose(),
  }
}

type Linked = {
  readonly carrier: FdCarrierHandle
  readonly ext: JsonRpcPeer
  readonly extToCarrier: PassThrough
  readonly carrierToExt: PassThrough
}

function linked(
  reg: FdCarrierRegistry,
  handler?: (method: string, params: unknown) => Promise<unknown> | unknown,
): Linked {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: reg })
  const ext = new JsonRpcPeer({
    reader: carrierToExt,
    writer: extToCarrier,
    ...(handler ? { onRequest: handler } : {}),
  })
  return { carrier, ext, extToCarrier, carrierToExt }
}

// Deterministic cleanup for owned streams/peers: dispose both peers,
// destroy both streams, then drain the lifecycle barrier. No sleeps.
async function closeLinked(f: Linked): Promise<void> {
  try {
    f.carrier.dispose()
  } catch (err) {
    note("carrier", err)
  }
  try {
    f.ext.dispose()
  } catch (err) {
    note("ext", err)
  }
  try {
    f.extToCarrier.destroy()
  } catch (err) {
    note("extToCarrier", err)
  }
  try {
    f.carrierToExt.destroy()
  } catch (err) {
    note("carrierToExt", err)
  }
  await awaitPeerClosedHandoffs()
}

// Production identity helpers: the only global-runtime touchpoints in this
// file (see promise-facades classification).
function gSupports(cap: string): Promise<boolean> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const svc = yield* PrivatePeerService
      return yield* svc.supports(cap)
    }),
  )
}

function gCurrentNone(): Promise<boolean> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const svc = yield* PrivatePeerService
      return Option.isNone(yield* svc.current)
    }),
  )
}

describe("fd carrier initialize reverse offer (production identity)", () => {
  test("reverse offer binds supports and close clears the global registry", async () => {
    await awaitPeerClosedHandoffs()
    const f = linked(carrierRegistry)
    try {
      await f.carrier.ready
      const res = (await f.ext.request("initialize", initParams(["reverse/echo"]))) as { capabilities: string[] }
      expect(Array.isArray(res.capabilities)).toBeTrue()
      expect(await gSupports("reverse/echo")).toBeTrue()
      expect(await gSupports("missing/method")).toBeFalse()
    } finally {
      await closeLinked(f)
    }
    expect(await gCurrentNone()).toBeTrue()
    expect(await gSupports("reverse/echo")).toBeFalse()
  })
})

describe("fd carrier initialize reverse offer (isolated registry)", () => {
  test("legacy capabilities populated but reverse missing stays empty", async () => {
    const iso = makeIsolated()
    const f = linked(iso.registry)
    try {
      await f.carrier.ready
      const res = (await f.ext.request(
        "initialize",
        initParams(undefined, ["session/cancelQueued", "session/update"]),
      )) as { capabilities: string[] }
      expect(Array.isArray(res.capabilities)).toBeTrue()
      expect(await iso.supports("session/cancelQueued")).toBeFalse()
      expect(await iso.supports("anything")).toBeFalse()
    } finally {
      await closeLinked(f)
      // Released by the carrier dispose above: the isolated registry is
      // unavailable again before the runtime itself is torn down.
      expect(await iso.supports("session/cancelQueued")).toBeFalse()
      await iso.dispose()
    }
  })

  test("reverse unknown entries are accepted forward-compatible", async () => {
    const iso = makeIsolated()
    const f = linked(iso.registry)
    try {
      await f.carrier.ready
      await f.ext.request("initialize", initParams(["future/method"]))
      expect(await iso.supports("future/method")).toBeTrue()
    } finally {
      await closeLinked(f)
      await iso.dispose()
    }
  })

  test("malformed reverse offer fails InvalidParams without init and retry succeeds", async () => {
    const iso = makeIsolated()
    const f = linked(iso.registry)
    try {
      await f.carrier.ready
      let code: number | undefined
      try {
        await f.ext.request("initialize", initParams(["ok", "ok"]))
      } catch (err) {
        code = (err as { code?: number }).code
      }
      expect(code).toBe(ErrorCode.InvalidParams)
      expect(f.carrier.peer.isInitialized()).toBeFalse()
      expect(await iso.supports("retry/cap")).toBeFalse()
      const res = (await f.ext.request("initialize", initParams(["retry/cap"]))) as { capabilities: string[] }
      expect(Array.isArray(res.capabilities)).toBeTrue()
      expect(f.carrier.peer.isInitialized()).toBeTrue()
      expect(await iso.supports("retry/cap")).toBeTrue()
      let dup: number | undefined
      try {
        await f.ext.request("initialize", initParams(["other"]))
      } catch (err) {
        dup = (err as { code?: number }).code
      }
      expect(dup).toBe(ErrorCode.InvalidRequest)
      expect(await iso.supports("other")).toBeFalse()
      expect(await iso.supports("retry/cap")).toBeTrue()
    } finally {
      await closeLinked(f)
      await iso.dispose()
    }
  })

  test("reserved reverse entries fail InvalidParams", async () => {
    const iso = makeIsolated()
    const f = linked(iso.registry)
    try {
      await f.carrier.ready
      for (const name of ["initialize", "$/cancelRequest", "$/progress"]) {
        let code: number | undefined
        try {
          await f.ext.request("initialize", initParams([name]))
        } catch (err) {
          code = (err as { code?: number }).code
        }
        expect(code).toBe(ErrorCode.InvalidParams)
        expect(f.carrier.peer.isInitialized()).toBeFalse()
      }
      await f.ext.request("initialize", initParams(["ok/cap"]))
      expect(await iso.supports("ok/cap")).toBeTrue()
    } finally {
      await closeLinked(f)
      await iso.dispose()
    }
  })

  test("unsupported reverse request allocates no id and sends no frame", async () => {
    const iso = makeIsolated()
    const f = linked(iso.registry, async (method: string) => {
      throw new Error(`unexpected reverse call ${method}`)
    })
    try {
      await f.carrier.ready
      await f.ext.request("initialize", initParams(["offered/echo"]))
      expect(await iso.supports("offered/echo")).toBeTrue()
      const before = f.carrier.peer.peekNextId()
      const failed = await iso.requestError("missing/method", {})
      expect(failed).toBeInstanceOf(Unsupported)
      expect((failed as Unsupported).capability).toBe("missing/method")
      expect(f.carrier.peer.peekNextId()).toBe(before)
      expect(f.carrier.peer.getPendingCount()).toBe(0)
    } finally {
      await closeLinked(f)
      expect(await iso.supports("offered/echo")).toBeFalse()
      await iso.dispose()
    }
  })
})

describe("fd carrier concurrent initialize", () => {
  test("same active id duplicate never runs the handler twice", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const decoder = new FrameDecoder()
    const bodies: string[] = []
    const waiting: (() => void)[] = []
    const onData = (chunk: Buffer) => {
      for (const body of decoder.push(chunk)) bodies.push(body)
      // Snapshot the waiters: a check that re-queues itself must wait for
      // the next chunk, never spin synchronously inside this handler.
      const pending = waiting.splice(0, waiting.length)
      for (const fn of pending) fn()
    }
    carrierToExt.on("data", onData)
    const awaitBodies = (n: number): Promise<string[]> =>
      new Promise((resolve) => {
        const check = () => {
          if (bodies.length >= n) resolve([...bodies])
          else waiting.push(check)
        }
        check()
      })
    let releaseGate!: () => void
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    let negotiations = 0
    const stub: FdCarrierRegistry = {
      install: () => Promise.resolve(),
      negotiate: () => {
        negotiations += 1
        return gate
      },
      release: () => Promise.resolve(),
    }
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
    try {
      await carrier.ready
      const frame = encodeFrame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: initParams(["winner/cap"]),
      })
      // Same id twice: the second is a duplicate active id and must be
      // rejected without a second handler run.
      extToCarrier.write(Buffer.concat([frame, frame]))
      // The duplicate rejection arrives while the first waits on the gate:
      // event-driven, no sleep.
      const one = await awaitBodies(1)
      const firstBody = JSON.parse(one[0]!) as Record<string, unknown>
      expect("error" in firstBody).toBeTrue()
      expect((firstBody.error as { code: number }).code).toBe(ErrorCode.InvalidRequest)
      expect(negotiations).toBe(1)
      releaseGate()
      const settled = await awaitBodies(2)
      const parsed = settled.map((b) => JSON.parse(b) as Record<string, unknown>)
      const errors = parsed.filter((p) => "error" in p)
      const successes = parsed.filter((p) => "result" in p)
      expect(successes.length).toBe(1)
      expect(errors.length).toBe(1)
      expect(negotiations).toBe(1)
      expect(carrier.peer.isInitialized()).toBeTrue()
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      carrierToExt.removeListener("data", onData)
      extToCarrier.destroy()
      carrierToExt.destroy()
    }
  })

  test("different ids race exactly-once negotiate; loser fails, winner caps final", async () => {
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const decoder = new FrameDecoder()
    const bodies: string[] = []
    const waiting: (() => void)[] = []
    const onData = (chunk: Buffer) => {
      for (const body of decoder.push(chunk)) bodies.push(body)
      // Snapshot the waiters: a check that re-queues itself must wait for
      // the next chunk, never spin synchronously inside this handler.
      const pending = waiting.splice(0, waiting.length)
      for (const fn of pending) fn()
    }
    carrierToExt.on("data", onData)
    const awaitBodies = (n: number): Promise<string[]> =>
      new Promise((resolve) => {
        const check = () => {
          if (bodies.length >= n) resolve([...bodies])
          else waiting.push(check)
        }
        check()
      })
    const offers: string[][] = []
    let winner: string[] | null = null
    let calls = 0
    const stub: FdCarrierRegistry = {
      install: () => Promise.resolve(),
      negotiate: (_peer, caps) => {
        calls += 1
        offers.push([...caps])
        // Synchronous first-wins: no pending gates, so no deadlock
        // surface. Frame order + FIFO microtasks make id 1 the
        // deterministic winner; the rival fast-fails with Conflict.
        if (calls === 1) {
          winner = [...caps]
          return Promise.resolve()
        }
        return Promise.reject(new Conflict())
      },
      release: () => Promise.resolve(),
    }
    const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
    try {
      await carrier.ready
      extToCarrier.write(
        encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams(["winner/cap"]) }),
      )
      extToCarrier.write(
        encodeFrame({ jsonrpc: "2.0", id: 2, method: "initialize", params: initParams(["loser/cap"]) }),
      )
      const settled = await awaitBodies(2)
      const parsed = settled.map((b) => JSON.parse(b) as Record<string, unknown>)
      const byId = new Map<unknown, Record<string, unknown>>()
      for (const p of parsed) byId.set(p.id, p)
      const first = byId.get(1)!
      const second = byId.get(2)!
      const succeeded = [first, second].filter((p) => "result" in p)
      const failed = [first, second].filter((p) => "error" in p)
      expect(succeeded.length).toBe(1)
      expect(failed.length).toBe(1)
      expect((failed[0]!.error as { code: number }).code).toBe(ErrorCode.InvalidRequest)
      expect(offers.length).toBe(2)
      expect(JSON.stringify(winner)).toBe(JSON.stringify(["winner/cap"]))
      expect(carrier.peer.isInitialized()).toBeTrue()
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      carrierToExt.removeListener("data", onData)
      extToCarrier.destroy()
      carrierToExt.destroy()
    }
  })
})
