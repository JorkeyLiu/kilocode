import { describe, expect, it } from "bun:test"
import { SessionTiming, TIMING_KEY, isActiveStatus } from "../../src/agent-manager/session-timing"
import type { Store } from "../../src/agent-manager/host"

function fakeStore(initial?: unknown): { store: Store; data: Map<string, unknown>; count: { value: number } } {
  const data = new Map<string, unknown>()
  const count = { value: 0 }
  if (initial !== undefined) data.set(TIMING_KEY, initial)
  const store: Store = {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: (key, value) => {
      count.value += 1
      data.set(key, value)
      return Promise.resolve()
    },
  }
  return { store, data, count }
}

describe("isActiveStatus", () => {
  it("counts busy, retry, and offline as active", () => {
    expect(isActiveStatus("busy")).toBe(true)
    expect(isActiveStatus("retry")).toBe(true)
    expect(isActiveStatus("offline")).toBe(true)
  })

  it("treats idle as inactive", () => {
    expect(isActiveStatus("idle")).toBe(false)
    expect(isActiveStatus("")).toBe(false)
  })
})

describe("SessionTiming accumulation", () => {
  it("first non-idle event starts at zero and grows from the recorded start", () => {
    let now = 1_000_000
    const { store } = fakeStore()
    const timing = new SessionTiming(store, () => now)

    timing.onStatus("s1", "busy")
    expect(timing.snapshot().s1).toEqual({ elapsedMs: 0, activeStart: 1_000_000 })

    now = 1_000_050
    timing.onStatus("s1", "busy") // duplicate while active
    expect(timing.snapshot().s1).toEqual({ elapsedMs: 0, activeStart: 1_000_000 })

    now = 1_000_130
    timing.onStatus("s1", "idle")
    expect(timing.snapshot().s1).toEqual({ elapsedMs: 130 })
  })

  it("appends later non-idle runs without resetting", async () => {
    let now = 2_000_000
    const { store } = fakeStore()
    const timing = new SessionTiming(store, () => now)

    timing.onStatus("s1", "busy")
    now = 2_000_100
    timing.onStatus("s1", "idle")
    now = 2_000_500
    timing.onStatus("s1", "busy")
    now = 2_000_600
    timing.onStatus("s1", "idle")
    await timing.wait()

    expect(timing.snapshot().s1).toEqual({ elapsedMs: 200 })
  })

  it("duplicate idle events never double-count", async () => {
    let now = 3_000_000
    const { store } = fakeStore()
    const timing = new SessionTiming(store, () => now)

    timing.onStatus("s1", "busy")
    now = 3_000_200
    timing.onStatus("s1", "idle")
    now = 3_000_400
    timing.onStatus("s1", "idle")
    timing.onStatus("s1", "idle")
    await timing.wait()

    expect(timing.snapshot().s1).toEqual({ elapsedMs: 200 })
  })

  it("counts retry and offline segments like busy", async () => {
    let now = 4_000_000
    const { store } = fakeStore()
    const timing = new SessionTiming(store, () => now)

    timing.onStatus("s1", "retry")
    now = 4_000_030
    timing.onStatus("s1", "busy")
    now = 4_000_090
    timing.onStatus("s1", "offline")
    now = 4_000_150
    timing.onStatus("s1", "idle")
    await timing.wait()

    expect(timing.snapshot().s1).toEqual({ elapsedMs: 150 })
  })

  it("onStatus reports whether the transition changed timing state", async () => {
    let now = 4_500_000
    const { store } = fakeStore()
    const timing = new SessionTiming(store, () => now)

    // First non-idle event starts a segment: changed.
    expect(timing.onStatus("s1", "busy")).toBe(true)
    // Duplicate non-idle while active: idempotent, unchanged.
    now = 4_500_100
    expect(timing.onStatus("s1", "busy")).toBe(false)
    // Settling an active segment: changed.
    now = 4_500_300
    expect(timing.onStatus("s1", "idle")).toBe(true)
    // Duplicate idle and idle without a segment: unchanged.
    expect(timing.onStatus("s1", "idle")).toBe(false)
    expect(timing.onStatus("s2", "idle")).toBe(false)
    await timing.wait()
    expect(timing.snapshot().s1).toEqual({ elapsedMs: 300 })
  })
})

describe("SessionTiming persistence", () => {
  it("reloads previously persisted totals and resumes append", async () => {
    let now = 5_000_000
    const first = fakeStore()
    const a = new SessionTiming(first.store, () => now)
    a.onStatus("s1", "busy")
    now = 5_000_500
    a.onStatus("s1", "idle")
    await a.wait()

    // Simulate extension restart with a fresh instance over the same store.
    const b = new SessionTiming(first.store, () => now)
    expect(b.snapshot().s1).toEqual({ elapsedMs: 500 })

    now = 5_001_000
    b.onStatus("s1", "busy")
    now = 5_001_200
    b.onStatus("s1", "idle")
    await b.wait()

    expect(b.snapshot().s1).toEqual({ elapsedMs: 700 })
  })

  it("ignores malformed or legacy-shaped entries without throwing", () => {
    const { store } = fakeStore({
      s1: { elapsedMs: "nope" },
      s2: { elapsedMs: -5 },
      s3: { elapsedMs: 100, activeStart: "later" },
      s4: 42,
    })
    const timing = new SessionTiming(store, () => 0)
    expect(timing.snapshot()).toEqual({})
  })

  it("writes only on boundaries, not per display tick", async () => {
    let now = 6_000_000
    const { store, count } = fakeStore()
    const timing = new SessionTiming(store, () => now)

    timing.onStatus("s1", "busy")
    await timing.wait()
    const afterStart = count.value
    // Display ticks do not touch the store.
    now = 6_000_001
    timing.onStatus("s1", "busy")
    now = 6_000_002
    timing.onStatus("s1", "busy")
    await timing.wait()
    expect(count.value).toBe(afterStart)

    timing.onStatus("s1", "idle")
    await timing.wait()
    expect(count.value).toBe(afterStart + 1)
  })
})

describe("SessionTiming pruning and shutdown", () => {
  it("forget removes the session and persists the smaller map", async () => {
    let now = 7_000_000
    const { store } = fakeStore()
    const timing = new SessionTiming(store, () => now)
    timing.onStatus("s1", "busy")
    timing.onStatus("s2", "busy")
    now = 7_000_100
    timing.onStatus("s1", "idle")
    timing.onStatus("s2", "idle")
    await timing.wait()

    timing.forget("s1")
    await timing.wait()
    expect(timing.snapshot()).toEqual({ s2: { elapsedMs: 100 } })
    expect(store.get(TIMING_KEY)).toEqual({ s2: { elapsedMs: 100 } })
  })

  it("settle finalizes every active segment and awaits the durable write", async () => {
    let now = 8_000_000
    const { store, count } = fakeStore()
    const timing = new SessionTiming(store, () => now)
    timing.onStatus("s1", "busy")
    now = 8_000_400
    timing.onStatus("s2", "busy")
    now = 8_000_900

    await timing.settle()
    expect(timing.snapshot()).toEqual({ s1: { elapsedMs: 900 }, s2: { elapsedMs: 500 } })
    expect(count.value).toBeGreaterThan(0)
    expect(store.get(TIMING_KEY)).toEqual({ s1: { elapsedMs: 900 }, s2: { elapsedMs: 500 } })
  })

  it("settle is a no-op when nothing is active", async () => {
    const { store, count } = fakeStore({ s1: { elapsedMs: 120 } })
    const timing = new SessionTiming(store, () => 0)
    await timing.settle()
    expect(timing.snapshot()).toEqual({ s1: { elapsedMs: 120 } })
    expect(count.value).toBe(0)
  })

  it("does not count downtime after a normal shutdown settle", async () => {
    let now = 9_000_000
    const { store } = fakeStore()
    const a = new SessionTiming(store, () => now)
    a.onStatus("s1", "busy")
    now = 9_000_300
    await a.settle()

    // Extension restarts much later; idle session stays idle, clock stays stopped.
    now = 9_050_000
    const b = new SessionTiming(store, () => now)
    b.onStatus("s1", "idle")
    expect(b.snapshot().s1).toEqual({ elapsedMs: 300 })
  })

  it("preserves a stale active marker after a crash (documented residual risk)", () => {
    const { store } = fakeStore({ s1: { elapsedMs: 100, activeStart: 9_000_000 } })
    const timing = new SessionTiming(store, () => 9_010_000)
    // The stale marker is preserved, so the segment keeps counting until a
    // status event settles it — conservative over the alternative of dropping
    // the elapsed time.
    expect(timing.snapshot().s1).toEqual({ elapsedMs: 100, activeStart: 9_000_000 })
  })

  it("a busy event after settle re-opens the segment, so shutdown must unsubscribe first", async () => {
    // Why AgentManagerProvider detaches timing-mutating SSE listeners before
    // settling: if a status event landed during/after the settle write, the
    // clock re-arms and the next shutdown counts the idle gap as runtime.
    let now = 9_100_000
    const { store } = fakeStore()
    const timing = new SessionTiming(store, () => now)
    timing.onStatus("s1", "busy")
    now = 9_100_300
    await timing.settle()
    expect(timing.snapshot().s1).toEqual({ elapsedMs: 300 })

    now = 9_100_500
    timing.onStatus("s1", "busy")
    expect(timing.snapshot().s1).toEqual({ elapsedMs: 300, activeStart: 9_100_500 })
  })
})
