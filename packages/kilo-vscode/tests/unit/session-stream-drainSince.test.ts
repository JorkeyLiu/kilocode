import { describe, it, expect, spyOn, afterEach } from "bun:test"
import {
  SessionStreamScheduler,
  updateSnapshotKey,
  snapshotPartKey,
  type PartBatch,
  type PartUpdate,
} from "../../src/kilo-provider/session-stream-scheduler"

type Sent = PartUpdate | PartBatch

function update(text: string, delta?: string, sid = "s1", partID = "p1", time?: { start: number }) {
  const msg = {
    type: "partUpdated",
    sessionID: sid,
    messageID: "m1",
    part: { id: partID, type: "text", messageID: "m1", text, ...(time ? { time } : {}) },
  } as PartUpdate
  if (delta === undefined) return msg
  return { ...msg, delta: { type: "text-delta", textDelta: delta } } as PartUpdate
}

function items(sent: Sent[]): PartUpdate[] {
  return sent.flatMap((msg) => (msg.type === "partsUpdated" ? msg.updates : [msg as PartUpdate]))
}

function ids(sent: Sent[]): string[] {
  return items(sent).map((u) => (u.part as { id: string }).id)
}

let now = 1000
let spy: ReturnType<typeof spyOn> | undefined
function mockNow(start: number) {
  now = start
  spy ??= spyOn(Date, "now").mockImplementation(() => now)
}

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

describe("SessionStreamScheduler / drainSince", () => {
  it("drops pre-boundary entries and emits only post-boundary", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    mockNow(1000)
    queue.push(update("old", "old"))
    now = 2000
    queue.push(update("new", "new", "s1", "p2"))
    queue.drainSince("s1", 1500)
    const flat = items(sent)
    expect(flat).toHaveLength(1)
    expect((flat[0]!.part as { id: string }).id).toBe("p2")
    queue.dispose()
  })

  it("uses last receipt stamp for a part extended after the boundary", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    mockNow(1000)
    queue.push(update("hello", "hello"))
    now = 2000
    queue.push(update("hello world", " world"))
    queue.drainSince("s1", 1500)
    const flat = items(sent)
    expect(flat).toHaveLength(1)
    expect((flat[0]!.part as { text: string }).text).toBe("hello world")
    queue.dispose()
  })

  it("drops everything when all entries predate the boundary", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    mockNow(1000)
    queue.push(update("a", "a"))
    queue.drainSince("s1", 1500)
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("is a no-op for an empty session", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    queue.drainSince("missing", 1500)
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("predicate drops snapshot-present deltas while keeping full updates and new tails", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    mockNow(2000)
    // Existing-part delta (ambiguous) — predicate drops without text inspection.
    queue.push(update(" world", " world", "s1", "p1"))
    // New-tail delta absent from snapshot — kept.
    queue.push(update("tail", "tail", "s1", "p2"))
    // Authoritative full update for an existing part — kept.
    queue.push(update("hello world", undefined, "s1", "p3"))
    const snapshot = new Set([snapshotPartKey("m1", "p1"), snapshotPartKey("m1", "p3")])
    queue.drainSince("s1", 1500, (u) => {
      if (!u.delta) return true
      const key = updateSnapshotKey(u)
      if (!key) return false
      return !snapshot.has(key)
    })
    expect(ids(sent).sort()).toEqual(["p2", "p3"])
    const p3 = items(sent).find((u) => (u.part as { id: string }).id === "p3")!
    expect(p3.delta).toBeUndefined()
    expect((p3.part as { text: string }).text).toBe("hello world")
    queue.dispose()
  })

  it("predicate drops an existing-part delta even with a post-boundary stamp", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    mockNow(2000)
    queue.push(update(" world", " world", "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    queue.drainSince("s1", 1500, (u) => {
      if (!u.delta) return true
      const key = updateSnapshotKey(u)
      if (!key) return false
      return !snapshot.has(key)
    })
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("missing stamp is conservative only when it satisfies the predicate", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    mockNow(2000)
    // Push then delete the stamp to simulate a missing receipt stamp.
    queue.push(update(" world", " world", "s1", "p1"))
    const internal = queue as unknown as { stamps: Map<string, Map<string, number>> }
    internal.stamps.get("s1")?.clear()
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    queue.drainSince("s1", 1500, (u) => {
      if (!u.delta) return true
      const key = updateSnapshotKey(u)
      if (!key) return false
      return !snapshot.has(key)
    })
    // Missing stamp but snapshot-present delta → still dropped.
    expect(sent).toHaveLength(0)

    const sent2: Sent[] = []
    const queue2 = new SessionStreamScheduler((msg) => sent2.push(msg))
    queue2.push(update(" world", " world", "s1", "p9"))
    const internal2 = queue2 as unknown as { stamps: Map<string, Map<string, number>> }
    internal2.stamps.get("s1")?.clear()
    queue2.drainSince("s1", 1500, (u) => {
      if (!u.delta) return true
      const key = updateSnapshotKey(u)
      if (!key) return false
      return !snapshot.has(key)
    })
    // Missing stamp and absent from snapshot → emitted.
    expect(ids(sent2)).toEqual(["p9"])
    queue.dispose()
    queue2.dispose()
  })

  it("cleans up queue, stamps, and timers regardless of keep/drop", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    mockNow(2000)
    queue.push(update(" world", " world", "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    queue.drainSince("s1", 1500, (u) => {
      if (!u.delta) return true
      const key = updateSnapshotKey(u)
      if (!key) return false
      return !snapshot.has(key)
    })
    expect(sent).toHaveLength(0)
    // Second drain is a no-op; nothing retained.
    queue.drainSince("s1", 1500)
    expect(sent).toHaveLength(0)
    const internal = queue as unknown as {
      queues: Map<string, Map<string, PartUpdate>>
      stamps: Map<string, Map<string, number>>
    }
    expect(internal.queues.has("s1")).toBe(false)
    expect(internal.stamps.has("s1")).toBe(false)
    queue.dispose()
  })
})
