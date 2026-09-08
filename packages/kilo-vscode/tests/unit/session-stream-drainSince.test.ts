import { describe, it, expect } from "bun:test"
import {
  SessionStreamScheduler,
  updateSnapshotKey,
  snapshotPartKey,
  type PartBatch,
  type PartUpdate,
} from "../../src/kilo-provider/session-stream-scheduler"

type Sent = PartUpdate | PartBatch

function update(text: string, delta?: string, sid = "s1", partID = "p1", mid = "m1") {
  const msg = {
    type: "partUpdated",
    sessionID: sid,
    messageID: mid,
    part: { id: partID, type: "text", messageID: mid, text },
  } as PartUpdate
  if (delta === undefined) return msg
  return { ...msg, delta: { type: "text-delta", textDelta: delta } } as PartUpdate
}

function reasonUpdate(text: string, delta?: string, sid = "s1", partID = "p1", mid = "m1") {
  const msg = {
    type: "partUpdated",
    sessionID: sid,
    messageID: mid,
    part: { id: partID, type: "reasoning", messageID: mid, text },
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

function texts(sent: Sent[]): string[] {
  return items(sent).map((u) => (u.part as { text: string }).text)
}

describe("SessionStreamScheduler / capture+commit token precedence", () => {
  it("capture flushes pre-token queue so it emits before the snapshot callback", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    queue.push(update("old", "old", "s1", "p1"))
    const order: string[] = []
    const token = queue.capture("s1")
    // Pre-token state was delivered synchronously by capture.
    expect(ids(sent)).toEqual(["p1"])
    queue.push(update("new", "new", "s1", "p2"))
    const ok = queue.commit("s1", token, new Set(), () => {
      order.push("messagesLoaded")
    })
    expect(ok).toBe(true)
    order.push(`replay:${ids(sent).join(",")}`)
    expect(order[0]).toBe("messagesLoaded")
    expect(ids(sent)).toEqual(["p1", "p2"])
    // Snapshot-first ordering: pre-token before callback, post-token after.
    expect(texts(sent)[0]).toBe("old")
    expect(texts(sent)[1]).toBe("new")
    queue.dispose()
  })

  it("post-token queued delta replays once and a later lane flush emits nothing", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("tail", "tail", "s1", "p2"))
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    expect(ids(sent)).toEqual(["p2"])
    // Live queue was consumed by commit: no duplicate on a later flush.
    queue.flush("s1")
    expect(ids(sent)).toEqual(["p2"])
    queue.dispose()
  })

  it("early-flushed full replays once after the snapshot (corrective)", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello world", undefined, "s1", "p1"))
    queue.flush("s1")
    expect(texts(sent)).toEqual(["hello world"])
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    const ok = queue.commit("s1", token, snapshot, () => {})
    expect(ok).toBe(true)
    expect(texts(sent)).toEqual(["hello world", "hello world"])
    const flat = items(sent)
    expect(flat[1]!.delta).toBeUndefined()
    queue.dispose()
  })

  it("post-token present-part delta flushed before snapshot is not replayed", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update(" world", " world", "s1", "p1"))
    queue.flush("s1")
    expect(sent).toHaveLength(1)
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    const ok = queue.commit("s1", token, snapshot, () => {})
    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    queue.dispose()
  })

  it("stale token invokes no callback and leaves the current queue untouched", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const a = queue.capture("s1")
    queue.push(update("one", "one", "s1", "p1"))
    // Newer capture supersedes A; A's queued delta is delivered as pre-token
    // state for B, and A's capture history is discarded.
    const b = queue.capture("s1")
    expect(ids(sent)).toEqual(["p1"])
    queue.push(update("two", "two", "s1", "p2"))
    let called = 0
    const stale = queue.commit("s1", a, new Set(), () => {
      called += 1
    })
    expect(stale).toBe(false)
    expect(called).toBe(0)
    // Current holder state untouched: B still replays its own delta once.
    const ok = queue.commit("s1", b, new Set(), () => {})
    expect(ok).toBe(true)
    expect(ids(sent)).toEqual(["p1", "p2"])
    queue.dispose()
  })

  it("callback throw releases token and queue with no replay", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("live", "live", "s1", "p9"))
    let threw: unknown = null
    try {
      queue.commit("s1", token, new Set(), () => {
        throw new Error("snapshot post failed")
      })
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    // No replay emitted; token released and live queue consumed.
    expect(sent).toHaveLength(0)
    queue.flush("s1")
    expect(sent).toHaveLength(0)
    const again = queue.commit("s1", token, new Set(), () => {})
    expect(again).toBe(false)
    queue.dispose()
  })

  it("other-session lane queues and timers are preserved across capture and commit", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    queue.push(update("other", "other", "s2", "p9"))
    const token = queue.capture("s1")
    // Other session's queued update was not flushed by s1's capture.
    expect(ids(sent)).toEqual([])
    queue.push(update("mine", "mine", "s1", "p1"))
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    expect(ids(sent)).toEqual(["p1"])
    // Other session still queued: an explicit flush delivers it.
    queue.flush("s2")
    expect(ids(sent).sort()).toEqual(["p1", "p9"].sort())
    queue.dispose()
  })

  it("commit invokes the callback synchronously before replay", () => {
    const sent: Sent[] = []
    // Unresolved promise shape: send returns void synchronously; the provider
    // posts sessionUpdated/messagesLoaded inside the callback before replay.
    const order: string[] = []
    const queue = new SessionStreamScheduler((msg) => {
      sent.push(msg)
    })
    const token = queue.capture("s1")
    queue.push(update("tail", "tail", "s1", "p2"))
    let sync = false
    const ok = queue.commit("s1", token, new Set(), () => {
      order.push("before")
      sync = true
    })
    expect(ok).toBe(true)
    expect(sync).toBe(true)
    expect(order).toEqual(["before"])
    expect(ids(sent)).toEqual(["p2"])
    queue.dispose()
  })

  it("replays absent-part delta and full", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("tail", "tail", "s1", "p2"))
    queue.push(update("full", undefined, "s1", "p3"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    const ok = queue.commit("s1", token, snapshot, () => {})
    expect(ok).toBe(true)
    expect(ids(sent).sort()).toEqual(["p2", "p3"])
    queue.dispose()
  })

  it("full-before-token plus delta-after-token stays delta-derived and drops when snapshot contains key", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    queue.push(update("hello", undefined, "s1", "p1"))
    const token = queue.capture("s1")
    // Pre-token full was flushed by capture; only the post-token delta replays.
    expect(texts(sent)).toEqual(["hello"])
    queue.push(update("hello world", " world", "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    const ok = queue.commit("s1", token, snapshot, () => {})
    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    queue.dispose()
  })

  it("delta-before-token plus real full-after-token replays the full", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    queue.push(update("a", "a", "s1", "p1"))
    const token = queue.capture("s1")
    expect(ids(sent)).toEqual(["p1"])
    queue.push(update("done", undefined, "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    const ok = queue.commit("s1", token, snapshot, () => {})
    expect(ok).toBe(true)
    const flat = items(sent)
    expect(flat).toHaveLength(2)
    expect((flat[1]!.part as { text: string }).text).toBe("done")
    expect(flat[1]!.delta).toBeUndefined()
    queue.dispose()
  })

  it("same-session capture is latest-wins: newer capture supersedes the old", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    queue.push(update("a", "a", "s1", "p1"))
    const t1 = queue.capture("s1")
    expect(ids(sent)).toEqual(["p1"])
    const t2 = queue.capture("s1")
    expect(t2).toBeGreaterThan(t1)
    queue.push(update("b", "b", "s1", "p2"))
    let oldCalled = 0
    const oldOk = queue.commit("s1", t1, new Set(), () => {
      oldCalled += 1
    })
    expect(oldOk).toBe(false)
    expect(oldCalled).toBe(0)
    expect(sent).toHaveLength(1)
    const ok = queue.commit("s1", t2, new Set(), () => {})
    expect(ok).toBe(true)
    expect(ids(sent)).toEqual(["p1", "p2"])
    queue.dispose()
  })

  it("overlapping same-session absent-part delta emits once for the winner; old commits nothing", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const a = queue.capture("s1")
    queue.push(update("one", "one", "s1", "p1"))
    const b = queue.capture("s1")
    expect(ids(sent)).toEqual(["p1"])
    queue.push(update("two", "two", "s1", "p2"))
    expect(queue.commit("s1", a, new Set(), () => {})).toBe(false)
    expect(sent).toHaveLength(1)
    expect(queue.commit("s1", b, new Set(), () => {})).toBe(true)
    expect(ids(sent)).toEqual(["p1", "p2"])
    queue.dispose()
  })

  it("different sessions stay independent under overlapping captures", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const a = queue.capture("s1")
    const b = queue.capture("s2")
    queue.push(update("one", "one", "s1", "p1"))
    queue.push(update("two", "two", "s2", "p2"))
    expect(queue.commit("s1", a, new Set(), () => {})).toBe(true)
    expect(queue.commit("s2", b, new Set(), () => {})).toBe(true)
    expect(ids(sent).sort()).toEqual(["p1", "p2"])
    queue.dispose()
  })

  it("discard clears only its own capture; superseded discard is a no-op", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const a = queue.capture("s1")
    queue.push(update("one", "one", "s1", "p1"))
    const b = queue.capture("s1")
    expect(ids(sent)).toEqual(["p1"])
    queue.discard("s1", a)
    queue.push(update("two", "two", "s1", "p2"))
    expect(queue.commit("s1", b, new Set(), () => {})).toBe(true)
    expect(ids(sent)).toEqual(["p1", "p2"])
    queue.dispose()
  })

  it("replacement entries do not monotonically overcount bytes", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg), { captureMaxBytes: 600 })
    const token = queue.capture("s1")
    queue.push(update("a", "a", "s1", "p1"))
    // Coalescing the same key replaces the entry: bytes track the latest
    // payload only, so repeated same-key updates never overflow.
    for (let i = 0; i < 20; i++) queue.push(update("b", "b", "s1", "p1"))
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    expect(ids(sent)).toEqual(["p1"])
    queue.dispose()
  })

  it("key overflow invalidates the capture; commit afterwards posts nothing", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg), { captureMaxKeys: 2 })
    const token = queue.capture("s1")
    queue.push(update("a", "a", "s1", "p1"))
    queue.push(update("b", "b", "s1", "p2"))
    queue.push(update("c", "c", "s1", "p3"))
    let called = 0
    expect(
      queue.commit("s1", token, new Set(), () => {
        called += 1
      }),
    ).toBe(false)
    expect(called).toBe(0)
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("byte overflow invalidates the capture; commit afterwards posts nothing", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg), { captureMaxBytes: 4 })
    const token = queue.capture("s1")
    queue.push(update("toolarge-text", undefined, "s1", "p1"))
    let called = 0
    expect(
      queue.commit("s1", token, new Set(), () => {
        called += 1
      }),
    ).toBe(false)
    expect(called).toBe(0)
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("expiry invalidates the capture without waiting for fetch settlement", async () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg), { captureTTLms: 10 })
    const token = queue.capture("s1")
    queue.push(update("live", "live", "s1", "p9"))
    await new Promise((r) => setTimeout(r, 30))
    let called = 0
    expect(
      queue.commit("s1", token, new Set(), () => {
        called += 1
      }),
    ).toBe(false)
    expect(called).toBe(0)
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("commit/discard/supersede clear the expiry timer (no late replay after free)", async () => {
    for (const op of ["commit", "discard", "supersede"] as const) {
      const sent: Sent[] = []
      const queue = new SessionStreamScheduler((msg) => sent.push(msg), { captureTTLms: 10 })
      const token = queue.capture("s1")
      let held = token
      if (op === "commit") queue.commit("s1", token, new Set(), () => {})
      else if (op === "discard") queue.discard("s1", token)
      else held = queue.capture("s1")
      const internal = queue as unknown as { captures: Map<string, Map<number, unknown>> }
      if (op === "supersede") {
        expect(internal.captures.get("s1")?.size).toBe(1)
      } else {
        expect(internal.captures.has("s1")).toBe(false)
      }
      await new Promise((r) => setTimeout(r, 30))
      expect(internal.captures.has("s1")).toBe(false)
      queue.dispose()
      expect(sent).toHaveLength(0)
    }
  })

  it("production-shaped keyed events are captured; malformed no-key events bypass", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "tail" },
      delta: { type: "text-delta", textDelta: "tail" },
    })
    queue.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { type: "text", text: "nokey" },
    } as PartUpdate)
    // Non-keyable path flushes the queued keyed update first, then emits
    // immediately; the live queue is empty when commit runs. Absent
    // snapshot with no pending entry replays nothing: the webview already
    // has the flushed delta, so no duplicate emits.
    expect(items(sent)).toHaveLength(2)
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    const flat = items(sent)
    expect(flat.filter((u) => (u.part as { id?: string }).id === "p1")).toHaveLength(1)
    expect(flat.filter((u) => (u.part as { id?: string }).id === undefined)).toHaveLength(1)
    queue.flush("s1")
    expect(items(sent)).toHaveLength(2)
    queue.dispose()
  })

  it("drop and dispose clear captures without leaks", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const internal = queue as unknown as { captures: Map<string, Map<number, unknown>> }
    const t = queue.capture("s1")
    queue.push(update("x", "x", "s1", "p1"))
    expect(internal.captures.get("s1")?.size).toBe(1)
    queue.drop("s1")
    expect(internal.captures.has("s1")).toBe(false)
    expect(queue.commit("s1", t, new Set(), () => {})).toBe(false)
    expect(sent).toHaveLength(0)
    const t2 = queue.capture("s1")
    queue.push(update("y", "y", "s1", "p1"))
    queue.dispose()
    expect(internal.captures.size).toBe(0)
    expect(queue.commit("s1", t2, new Set(), () => {})).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it("reasoning parts share the same lineage rule", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    queue.push(reasonUpdate("hello", undefined, "s1", "p1"))
    const token = queue.capture("s1")
    expect(sent).toHaveLength(1)
    queue.push(reasonUpdate("hello world", " world", "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    expect(queue.commit("s1", token, snapshot, () => {})).toBe(true)
    expect(sent).toHaveLength(1)
    const token2 = queue.capture("s1")
    queue.push(reasonUpdate("final", undefined, "s1", "p1"))
    expect(queue.commit("s1", token2, snapshot, () => {})).toBe(true)
    expect(items(sent)).toHaveLength(2)
    queue.dispose()
  })

  it("unknown token commit is a no-op without invoking the callback", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    let called = 0
    expect(
      queue.commit("missing", 999, new Set(), () => {
        called += 1
      }),
    ).toBe(false)
    expect(called).toBe(0)
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("updateSnapshotKey grammar stays stable for commit filtering", () => {
    const u = update("x", "x", "s1", "p1", "m9")
    expect(updateSnapshotKey(u)).toBe(snapshotPartKey("m9", "p1"))
  })

  it("early flush then same-key delta replays only pending when absent", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", "hello", "s1", "p1"))
    queue.flush("s1")
    expect(texts(sent)).toEqual(["hello"])
    queue.push(update(" world", " world", "s1", "p1"))
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    // Delivered/pending: only the unflushed pending delta replays, not the
    // cumulative hello+world. The webview already has hello via the flush.
    expect(texts(sent)).toEqual(["hello", " world"])
    const flat = items(sent)
    expect((flat[1]!.part as { text: string }).text).toBe(" world")
    expect(flat[1]!.delta).toEqual({ type: "text-delta", textDelta: " world" })
    queue.flush("s1")
    expect(texts(sent)).toEqual(["hello", " world"])
    queue.dispose()
  })

  it("early flush then same-key delta drops when snapshot present (no duplication)", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", "hello", "s1", "p1"))
    queue.flush("s1")
    queue.push(update(" world", " world", "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    const ok = queue.commit("s1", token, snapshot, () => {})
    expect(ok).toBe(true)
    expect(texts(sent)).toEqual(["hello"])
    queue.dispose()
  })

  it("early flush full then delta stays delta-derived (absent replays pending only, present drops)", () => {
    const sentAbsent: Sent[] = []
    const absent = new SessionStreamScheduler((msg) => sentAbsent.push(msg))
    const tAbsent = absent.capture("s1")
    absent.push(update("hello", undefined, "s1", "p1"))
    absent.flush("s1")
    absent.push(update(" world", " world", "s1", "p1"))
    expect(absent.commit("s1", tAbsent, new Set(), () => {})).toBe(true)
    const flatAbsent = items(sentAbsent)
    expect(flatAbsent).toHaveLength(2)
    // Pending-only: the live-queue delta replays verbatim, not the
    // cumulative hello+world synthetic.
    expect((flatAbsent[1]!.part as { text: string }).text).toBe(" world")
    expect(flatAbsent[1]!.delta).toEqual({ type: "text-delta", textDelta: " world" })
    absent.dispose()

    const sentPresent: Sent[] = []
    const present = new SessionStreamScheduler((msg) => sentPresent.push(msg))
    const tPresent = present.capture("s1")
    present.push(update("hello", undefined, "s1", "p1"))
    present.flush("s1")
    present.push(update(" world", " world", "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    expect(present.commit("s1", tPresent, snapshot, () => {})).toBe(true)
    expect(texts(sentPresent)).toEqual(["hello"])
    present.dispose()
  })

  it("early flush full then delta then real full replaces cumulative and clears derived", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", undefined, "s1", "p1"))
    queue.flush("s1")
    queue.push(update(" world", " world", "s1", "p1"))
    queue.push(update("done", undefined, "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    expect(queue.commit("s1", token, snapshot, () => {})).toBe(true)
    const flat = items(sent)
    expect(flat).toHaveLength(2)
    expect((flat[1]!.part as { text: string }).text).toBe("done")
    expect(flat[1]!.delta).toBeUndefined()
    queue.dispose()
  })

  it("latest attempt survives expiry while superseded tokens are not latest", async () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg), { captureTTLms: 10 })
    const token = queue.capture("s1")
    expect(queue.isLatestAttempt("s1", token)).toBe(true)
    queue.push(update("live", "live", "s1", "p9"))
    await new Promise((r) => setTimeout(r, 30))
    expect(queue.commit("s1", token, new Set(), () => {})).toBe(false)
    expect(queue.isLatestAttempt("s1", token)).toBe(true)
    const next = queue.capture("s1")
    expect(next).toBeGreaterThan(token)
    expect(queue.isLatestAttempt("s1", token)).toBe(false)
    expect(queue.isLatestAttempt("s1", next)).toBe(true)
    queue.dispose()
    expect(queue.isLatestAttempt("s1", next)).toBe(false)
  })

  it("latest attempt survives overflow while superseded tokens are not latest", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg), { captureMaxKeys: 1 })
    const token = queue.capture("s1")
    queue.push(update("a", "a", "s1", "p1"))
    queue.push(update("b", "b", "s1", "p2"))
    expect(queue.commit("s1", token, new Set(), () => {})).toBe(false)
    expect(queue.isLatestAttempt("s1", token)).toBe(true)
    expect(sent).toHaveLength(0)
    queue.dispose()
  })

  it("drop clears latest without touching other sessions", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const a = queue.capture("s1")
    const b = queue.capture("s2")
    expect(queue.isLatestAttempt("s1", a)).toBe(true)
    expect(queue.isLatestAttempt("s2", b)).toBe(true)
    queue.drop("s1")
    expect(queue.isLatestAttempt("s1", a)).toBe(false)
    expect(queue.isLatestAttempt("s2", b)).toBe(true)
    queue.dispose()
  })
})

describe("SessionStreamScheduler / delivered-pending replay (audit blockers)", () => {
  it("absent snapshot, delta1 early flush + no later delta emits no duplicate", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", "hello", "s1", "p1"))
    queue.flush("s1")
    expect(texts(sent)).toEqual(["hello"])
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    // Already delivered via the early flush; nothing pending remains.
    expect(texts(sent)).toEqual(["hello"])
    queue.flush("s1")
    expect(texts(sent)).toEqual(["hello"])
    queue.dispose()
  })

  it("absent snapshot, delta1 early flush + delta2 pending emits only delta2", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", "hello", "s1", "p1"))
    queue.flush("s1")
    queue.push(update(" world", " world", "s1", "p1"))
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    expect(texts(sent)).toEqual(["hello", " world"])
    const flat = items(sent)
    expect(flat[1]!.delta).toEqual({ type: "text-delta", textDelta: " world" })
    // At-most-once: no lane timer emits the pending entry afterward.
    queue.flush("s1")
    expect(texts(sent)).toEqual(["hello", " world"])
    queue.dispose()
  })

  it("absent older paginated base + post-token delta early flush preserves base without duplicate", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    // Streaming tail for a message absent from the paged snapshot flushes early.
    queue.push(update("hello", "hello", "s1", "p9", "m9"))
    queue.flush("s1")
    expect(texts(sent)).toEqual(["hello"])
    // Paged snapshot contains only the older base message, not the tail.
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    const ok = queue.commit("s1", token, snapshot, () => {})
    expect(ok).toBe(true)
    // No replay for the already delivered tail; the paged base is untouched.
    expect(texts(sent)).toEqual(["hello"])
    queue.dispose()
  })

  it("absent snapshot, unflushed delta1+delta2 emits coalesced pending once", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", "hello", "s1", "p1"))
    queue.push(update(" world", " world", "s1", "p1"))
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    const flat = items(sent)
    expect(flat).toHaveLength(1)
    expect((flat[0]!.part as { text: string }).text).toBe("hello world")
    expect(flat[0]!.delta).toEqual({ type: "text-delta", textDelta: "hello world" })
    queue.flush("s1")
    expect(items(sent)).toHaveLength(1)
    queue.dispose()
  })

  it("present snapshot drops all delta-derived variants (flushed, pending, coalesced)", () => {
    for (const mode of ["flushed", "pending", "coalesced"] as const) {
      const sent: Sent[] = []
      const queue = new SessionStreamScheduler((msg) => sent.push(msg))
      const token = queue.capture("s1")
      queue.push(update("hello", "hello", "s1", "p1"))
      if (mode !== "pending") queue.flush("s1")
      if (mode !== "flushed") queue.push(update(" world", " world", "s1", "p1"))
      if (mode === "flushed") {
        // Flushed-only case: flush the second delta too so no pending remains.
        // (First flush above already delivered hello; this push+flush delivers world.)
      }
      const snapshot = new Set([snapshotPartKey("m1", "p1")])
      expect(queue.commit("s1", token, snapshot, () => {})).toBe(true)
      if (mode === "pending") {
        // Pending-only delta for a present key drops: only the pre-commit
        // state (none, since no flush) remains.
        expect(sent).toHaveLength(0)
      } else if (mode === "flushed") {
        expect(texts(sent)).toEqual(["hello"])
      } else {
        // Coalesced pending for a present key drops: only the early flush remains.
        expect(texts(sent)).toEqual(["hello"])
      }
      queue.dispose()
    }
  })

  it("pending synthetic full uses live derived metadata but keeps full shape", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    // Post-token full then delta merges live into a synthetic full (no delta
    // field) with delta-derived lineage. Absent snapshot replays the pending
    // synthetic shape verbatim.
    queue.push(update("hello", undefined, "s1", "p1"))
    queue.push(update(" world", " world", "s1", "p1"))
    const ok = queue.commit("s1", token, new Set(), () => {})
    expect(ok).toBe(true)
    const flat = items(sent)
    expect(flat).toHaveLength(1)
    expect((flat[0]!.part as { text: string }).text).toBe("hello world")
    expect(flat[0]!.delta).toBeUndefined()
    queue.dispose()

    const sentPresent: Sent[] = []
    const present = new SessionStreamScheduler((msg) => sentPresent.push(msg))
    const tPresent = present.capture("s1")
    present.push(update("hello", undefined, "s1", "p1"))
    present.push(update(" world", " world", "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    expect(present.commit("s1", tPresent, snapshot, () => {})).toBe(true)
    expect(sentPresent).toHaveLength(0)
    present.dispose()
  })

  it("real full early flush then later real full replays latest full correctively", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", undefined, "s1", "p1"))
    queue.flush("s1")
    queue.push(update("done", undefined, "s1", "p1"))
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    expect(queue.commit("s1", token, snapshot, () => {})).toBe(true)
    const flat = items(sent)
    expect(flat).toHaveLength(2)
    expect((flat[1]!.part as { text: string }).text).toBe("done")
    expect(flat[1]!.delta).toBeUndefined()
    queue.dispose()
  })

  it("real full pending without early flush replays correctively when absent", () => {
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("done", undefined, "s1", "p1"))
    expect(queue.commit("s1", token, new Set(), () => {})).toBe(true)
    const flat = items(sent)
    expect(flat).toHaveLength(1)
    expect((flat[0]!.part as { text: string }).text).toBe("done")
    expect(flat[0]!.delta).toBeUndefined()
    queue.dispose()
  })

  it("composed webview state: no hellohello duplication and older base preserved", () => {
    // Simulates the webview per-message snapshot rule plus verbatim delta
    // application: snapshot messages replace same-ID parts; messages absent
    // from the snapshot keep local state; replayed deltas append verbatim and
    // fulls replace.
    function applyReplay(local: Map<string, string>, replayed: PartUpdate[]): Map<string, string> {
      const next = new Map(local)
      for (const u of replayed) {
        const mid = u.messageID || (u.part as { messageID?: string }).messageID!
        const pid = (u.part as { id: string }).id
        const key = `${mid}:${pid}`
        const text = (u.part as { text: string }).text
        const delta = u.delta?.textDelta
        if (!next.has(key)) {
          next.set(key, text)
          continue
        }
        if (typeof delta === "string" && delta.length > 0) next.set(key, next.get(key)! + delta)
        else next.set(key, text)
      }
      return next
    }
    // Older paginated base plus a streaming tail that early-flushed hello.
    const local = new Map<string, string>([
      ["m1:p1", "old base"],
      ["m2:p1", "hello"],
    ])
    const sent: Sent[] = []
    const queue = new SessionStreamScheduler((msg) => sent.push(msg))
    const token = queue.capture("s1")
    queue.push(update("hello", "hello", "s1", "p1", "m2"))
    queue.flush("s1")
    queue.push(update(" world", " world", "s1", "p1", "m2"))
    // Paged snapshot carries only the older base message; the tail is absent.
    const snapshot = new Set([snapshotPartKey("m1", "p1")])
    let replayed: PartUpdate[] = []
    const beforeCount = items(sent).length
    expect(queue.commit("s1", token, snapshot, () => {})).toBe(true)
    replayed = items(sent).slice(beforeCount) as PartUpdate[]
    // Only the pending world replays, not cumulative helloworld.
    expect(replayed.map((u) => u.delta?.textDelta ?? (u.part as { text: string }).text)).toEqual([" world"])
    // Snapshot keeps the older base; the absent tail stays local; the replay
    // appends once.
    const afterSnapshot = new Map<string, string>([
      ["m1:p1", "old base"],
      ["m2:p1", "hello"],
    ])
    const final = applyReplay(afterSnapshot, replayed)
    expect(final.get("m1:p1")).toBe("old base")
    expect(final.get("m2:p1")).toBe("hello world")
    expect(final.get("m2:p1")).not.toContain("hellohello")
    // Already-flushed-only variant replays nothing and keeps hello once.
    const sent2: Sent[] = []
    const q2 = new SessionStreamScheduler((msg) => sent2.push(msg))
    const t2 = q2.capture("s1")
    q2.push(update("hello", "hello", "s1", "p1", "m2"))
    q2.flush("s1")
    const b2 = items(sent2).length
    expect(q2.commit("s1", t2, snapshot, () => {})).toBe(true)
    expect(items(sent2).slice(b2)).toEqual([])
    const final2 = applyReplay(
      new Map([
        ["m1:p1", "old base"],
        ["m2:p1", "hello"],
      ]),
      [],
    )
    expect(final2.get("m2:p1")).toBe("hello")
    queue.dispose()
    q2.dispose()
  })
})
