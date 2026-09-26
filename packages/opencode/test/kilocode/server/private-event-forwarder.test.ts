import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { GlobalBus } from "../../../src/bus/global"
import { Service as PrivatePeerService } from "../../../src/kilocode/server/private-peer-registry"
import {
  MAX_ENVELOPE_BYTES,
  MAX_QUEUE,
  NOTIFY_INVALIDATE_AFTER,
  layer as ForwarderLayer,
  toEnvelope,
} from "../../../src/kilocode/server/private-event-forwarder"

const payload = (type: string, extra: Record<string, unknown> = {}) => ({ type, properties: {}, ...extra })

describe("private event forwarder envelope", () => {
  test("preserves directory/transaction/payload", () => {
    const out = toEnvelope({ directory: "/repo", transaction: "tx-1", payload: payload("message.part.updated") })
    expect(out?.directory).toBe("/repo")
    expect(out?.transaction).toBe("tx-1")
    expect((out?.payload as { type: string }).type).toBe("message.part.updated")
  })

  test("drops synthetic connected/heartbeat", () => {
    expect(toEnvelope({ directory: "global", payload: payload("server.connected") })).toBeNull()
    expect(toEnvelope({ directory: "global", payload: payload("server.heartbeat") })).toBeNull()
  })

  test("drops malformed, extra keys, and oversize", () => {
    expect(toEnvelope(null)).toBeNull()
    expect(toEnvelope({ directory: "/a", payload: payload("x"), extra: 1 })).toBeNull()
    expect(toEnvelope({ directory: "/a", payload: { properties: {} } })).toBeNull()
    expect(toEnvelope({ directory: "/a\0b", payload: payload("x") })).toBeNull()
    const big = "p".repeat(MAX_ENVELOPE_BYTES)
    expect(toEnvelope({ directory: "/a", payload: { type: "message.part.updated", properties: {}, big } })).toBeNull()
  })

  test("queue bound keeps the newest frames in observed order", async () => {
    expect(MAX_QUEUE).toBeLessThanOrEqual(512)
    expect(MAX_QUEUE).toBeGreaterThan(0)
    const seen: string[] = []
    const notify = (_method: string, params?: unknown) =>
      Effect.sync(() => {
        seen.push((params as { directory?: string }).directory ?? "")
      })
    const mock = Layer.succeed(PrivatePeerService, {
      install: () => Effect.die("unused"),
      release: () => Effect.void,
      negotiate: () => Effect.void,
      current: Effect.succeed(null as never),
      request: () => Effect.die("unused"),
      requestWithEvents: () => Effect.die("unused"),
      supports: () => Effect.succeed(true),
      notify: notify as never,
    } as never)
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const total = MAX_QUEUE + 10
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      yield* Effect.sync(() => {
        for (let i = 0; i < total; i += 1) {
          GlobalBus.emit("event", { directory: `/q${i}`, payload: payload("message.part.updated") })
        }
      })
      const deadline = Date.now() + 2000
      for (;;) {
        if (seen.length >= MAX_QUEUE) break
        if (Date.now() > deadline) throw new Error(`overflow did not converge: seen=${seen.length}`)
        yield* Effect.sleep(5)
      }
      // Oldest 10 dropped; newest MAX_QUEUE survive in observed order.
      expect(seen.length).toBe(MAX_QUEUE)
      expect(seen[0]).toBe("/q10")
      expect(seen[seen.length - 1]).toBe(`/q${total - 1}`)
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
  })
})

describe("private event forwarder layer", () => {
  test("forwards in observed order, non-blocking, and cleans up", async () => {
    const seen: Array<{ directory?: string; payload: { type: string } }> = []
    const notify = (_method: string, params?: unknown) =>
      Effect.sync(() => {
        const p = params as { directory?: string; payload: { type: string } }
        seen.push({ directory: p.directory, payload: p.payload })
      })
    const mock = Layer.succeed(PrivatePeerService, {
      install: () => Effect.die("unused"),
      release: () => Effect.void,
      negotiate: () => Effect.void,
      current: Effect.succeed(null as never),
      request: () => Effect.die("unused"),
      requestWithEvents: () => Effect.die("unused"),
      supports: () => Effect.succeed(true),
      notify: notify as never,
    } as never)
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const before = GlobalBus.listenerCount("event")
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      yield* Effect.sync(() => {
        GlobalBus.emit("event", { directory: "/a", payload: payload("message.part.updated") })
        GlobalBus.emit("event", { directory: "/b", payload: payload("permission.asked") })
        GlobalBus.emit("event", { directory: "global", payload: payload("server.connected") })
      })
      const deadline = Date.now() + 2000
      for (;;) {
        if (seen.length >= 2) break
        if (Date.now() > deadline) throw new Error(`forwarder did not deliver in order: ${JSON.stringify(seen)}`)
        yield* Effect.sleep(5)
      }
      expect(seen.length).toBe(2)
      expect(seen[0]?.directory).toBe("/a")
      expect(seen[1]?.directory).toBe("/b")
      expect(GlobalBus.listenerCount("event")).toBe(before + 1)
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
    expect(GlobalBus.listenerCount("event")).toBe(before)
  })

  test("unsupported peer drops without throwing the producer", async () => {
    const notify = () => Effect.fail({ _tag: "PrivatePeerUnsupported", capability: "event/notify" } as never)
    const mock = Layer.succeed(PrivatePeerService, {
      install: () => Effect.die("unused"),
      release: () => Effect.void,
      negotiate: () => Effect.void,
      current: Effect.succeed(null as never),
      request: () => Effect.die("unused"),
      requestWithEvents: () => Effect.die("unused"),
      supports: () => Effect.succeed(false),
      notify: notify as never,
    } as never)
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      yield* Effect.sync(() => {
        GlobalBus.emit("event", { directory: "/a", payload: payload("message.part.updated") })
      })
      yield* Effect.sleep(20)
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
  })

  test("failed epoch frames never replay after recovery (stale isolation)", async () => {
    const seen: string[] = []
    let failing = true
    const notify = (_method: string, params?: unknown) => {
      if (failing) return Effect.fail({ _tag: "PrivatePeerUnavailable" } as never)
      return Effect.sync(() => {
        seen.push((params as { directory?: string }).directory ?? "")
      })
    }
    const mock = Layer.succeed(PrivatePeerService, {
      install: () => Effect.die("unused"),
      release: () => Effect.void,
      negotiate: () => Effect.void,
      current: Effect.succeed(null as never),
      request: () => Effect.die("unused"),
      requestWithEvents: () => Effect.die("unused"),
      supports: () => Effect.succeed(true),
      notify: notify as never,
    } as never)
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      // Epoch 1: peer down — frames are dropped, producer never throws.
      yield* Effect.sync(() => {
        GlobalBus.emit("event", { directory: "/stale-1", payload: payload("message.part.updated") })
        GlobalBus.emit("event", { directory: "/stale-2", payload: payload("message.part.updated") })
      })
      yield* Effect.sleep(30)
      expect(seen.length).toBe(0)
      // Recovery: only new frames flow; stale frames are gone, never reordered
      // over readable authorities.
      failing = false
      yield* Effect.sync(() => {
        GlobalBus.emit("event", { directory: "/fresh-1", payload: payload("message.part.updated") })
        GlobalBus.emit("event", { directory: "/fresh-2", payload: payload("permission.asked") })
      })
      const deadline = Date.now() + 2000
      for (;;) {
        if (seen.length >= 2) break
        if (Date.now() > deadline) throw new Error(`recovery did not deliver: ${JSON.stringify(seen)}`)
        yield* Effect.sleep(5)
      }
      expect(seen).toEqual(["/fresh-1", "/fresh-2"])
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
  })
})

describe("private event forwarder half-open invalidation", () => {
  const mockBase = (overrides: Record<string, unknown>) =>
    Layer.succeed(PrivatePeerService, {
      install: () => Effect.die("unused"),
      release: () => Effect.void,
      negotiate: () => Effect.void,
      current: Effect.succeed(null as never),
      request: () => Effect.die("unused"),
      requestWithEvents: () => Effect.die("unused"),
      supports: () => Effect.succeed(true),
      notify: () => Effect.die("unused"),
      invalidate: () => Effect.succeed(false),
      ...overrides,
    } as never)

  const emitOne = (dir: string): void => {
    GlobalBus.emit("event", { directory: dir, payload: payload("message.part.updated") })
  }

  test("consecutive real write faults invalidate the exact peer once (half-open)", async () => {
    expect(NOTIFY_INVALIDATE_AFTER).toBeGreaterThanOrEqual(2)
    expect(NOTIFY_INVALIDATE_AFTER).toBeLessThanOrEqual(3)
    let invalidations = 0
    const mock = mockBase({
      supports: () => Effect.succeed(true),
      notify: () => Effect.fail({ _tag: "PrivatePeerUnavailable" } as never),
      invalidate: () =>
        Effect.sync(() => {
          invalidations += 1
          return true
        }),
    })
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      for (let i = 0; i < NOTIFY_INVALIDATE_AFTER; i += 1) {
        yield* Effect.sync(() => emitOne(`/half-${i}`))
        yield* Effect.sleep(30)
      }
      yield* Effect.sleep(30)
      expect(invalidations).toBe(1)
      // No second invalidate without an intervening success: bounded, no dispose storm.
      yield* Effect.sync(() => emitOne("/half-extra"))
      yield* Effect.sleep(30)
      expect(invalidations).toBe(1)
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
  })

  test("single-frame jitter does not invalidate; success resets the streak", async () => {
    let invalidations = 0
    let failing = true
    const seen: string[] = []
    const mock = mockBase({
      supports: () => Effect.succeed(true),
      notify: (_method: string, params?: unknown) => {
        if (failing) return Effect.fail({ _tag: "PrivatePeerUnavailable" } as never)
        return Effect.sync(() => {
          seen.push((params as { directory?: string }).directory ?? "")
        })
      },
      invalidate: () =>
        Effect.sync(() => {
          invalidations += 1
          return true
        }),
    })
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      // One isolated fault: below threshold.
      yield* Effect.sync(() => emitOne("/jitter-1"))
      yield* Effect.sleep(30)
      expect(invalidations).toBe(0)
      // Success resets the streak.
      failing = false
      yield* Effect.sync(() => emitOne("/jitter-ok"))
      const deadline = Date.now() + 2000
      for (;;) {
        if (seen.length >= 1) break
        if (Date.now() > deadline) throw new Error("jitter success never delivered")
        yield* Effect.sleep(5)
      }
      expect(invalidations).toBe(0)
      // Two more faults after the reset stay below threshold.
      failing = true
      yield* Effect.sync(() => emitOne("/jitter-2"))
      yield* Effect.sleep(30)
      yield* Effect.sync(() => emitOne("/jitter-3"))
      yield* Effect.sleep(30)
      expect(invalidations).toBe(0)
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
  })

  test("pre-negotiation Unsupported never invalidates (startup safe)", async () => {
    let invalidations = 0
    const mock = mockBase({
      supports: () => Effect.succeed(false),
      notify: () => Effect.fail({ _tag: "PrivatePeerUnsupported", capability: "event/notify" } as never),
      invalidate: () =>
        Effect.sync(() => {
          invalidations += 1
          return true
        }),
    })
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      for (let i = 0; i < NOTIFY_INVALIDATE_AFTER + 1; i += 1) {
        yield* Effect.sync(() => emitOne(`/prenet-${i}`))
        yield* Effect.sleep(30)
      }
      yield* Effect.sleep(30)
      expect(invalidations).toBe(0)
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
  })

  test("uninitialized Unavailable with not-ready supports never invalidates", async () => {
    let invalidations = 0
    const mock = mockBase({
      supports: () => Effect.succeed(false),
      notify: () => Effect.fail({ _tag: "PrivatePeerUnavailable" } as never),
      invalidate: () =>
        Effect.sync(() => {
          invalidations += 1
          return true
        }),
    })
    const full = ForwarderLayer.pipe(Layer.provide(mock))
    const prog = Effect.gen(function* () {
      yield* Layer.build(full)
      for (let i = 0; i < NOTIFY_INVALIDATE_AFTER + 1; i += 1) {
        yield* Effect.sync(() => emitOne(`/uninit-${i}`))
        yield* Effect.sleep(30)
      }
      yield* Effect.sleep(30)
      expect(invalidations).toBe(0)
    }).pipe(Effect.scoped)
    await Effect.runPromise(prog as Effect.Effect<void>)
  })
})
