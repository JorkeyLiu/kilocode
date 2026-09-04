import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import {
  SSE_TIMELINE_CAP,
  SSE_TIMELINE_SCHEMA,
  SSE_TIMELINE_STRING_LIMIT,
  SseTimelineFixture,
  SseTimelineStore,
  resolveTimelineSessionId,
  sseTimelineKind,
  sseTimelineStatus,
  type SSEPayload,
  type SseTimelineListener,
} from "../../src/services/cli-backend/sse-timeline"
import { evidenceInventory, parseFailure, validateSseTimeline } from "../../script/e2e-evidence"

function statusEvent(sessionID: string, status: string): SSEPayload {
  return {
    id: "e-status",
    type: "session.status",
    properties: { sessionID, status: { type: status } },
  } as unknown as SSEPayload
}

function idleEvent(sessionID: string): SSEPayload {
  return { id: "e-idle", type: "session.idle", properties: { sessionID } } as unknown as SSEPayload
}

function syncEvent(sessionID: string, canary: string): SSEPayload {
  return {
    type: "sync",
    name: "message.updated.1",
    id: "m-1",
    seq: 1,
    aggregateID: "a-1",
    data: { sessionID, info: { id: "msg-1", role: "assistant", title: canary } },
  } as unknown as SSEPayload
}

describe("sseTimelineKind", () => {
  it("prefixes sync envelopes with the event name", () => {
    expect(sseTimelineKind(syncEvent("ses_1", "x"))).toBe("sync:message.updated.1")
  })

  it("uses the bare type for transient events", () => {
    expect(sseTimelineKind(statusEvent("ses_1", "busy"))).toBe("session.status")
    expect(sseTimelineKind(idleEvent("ses_1"))).toBe("session.idle")
  })
})

describe("sseTimelineStatus", () => {
  it("reads only the session.status discriminator", () => {
    expect(sseTimelineStatus(statusEvent("ses_1", "busy"))).toBe("busy")
    expect(sseTimelineStatus(statusEvent("ses_1", "idle"))).toBe("idle")
  })

  it("yields undefined for every other kind (never payload fallback)", () => {
    expect(sseTimelineStatus(idleEvent("ses_1"))).toBeUndefined()
    expect(sseTimelineStatus(syncEvent("ses_1", "x"))).toBeUndefined()
  })
})

describe("SseTimelineStore", () => {
  it("preserves raw arrival order with contiguous seq", () => {
    const store = new SseTimelineStore()
    store.start("2026-09-04T00:00:00.000Z")
    store.record(idleEvent("ses_b"), "ses_b", "/repo", undefined, "2026-09-04T00:00:01.000Z")
    store.record(statusEvent("ses_a", "busy"), "ses_a", "/repo", "tx-1", "2026-09-04T00:00:02.000Z")
    const snap = store.snapshot({ observing: true, stoppedAt: null })
    expect(snap.schema).toBe(SSE_TIMELINE_SCHEMA)
    expect(snap.count).toBe(2)
    expect(snap.dropped).toBe(0)
    expect(snap.truncated).toBe(false)
    expect(snap.entries.map((e) => e.seq)).toEqual([0, 1])
    expect(snap.entries.map((e) => e.kind)).toEqual(["session.idle", "session.status"])
    expect(snap.entries[1]!).toMatchObject({ sessionID: "ses_a", transaction: "tx-1", status: "busy" })  })

  it("never serializes payload/title data", () => {
    const store = new SseTimelineStore()
    store.start("2026-09-04T00:00:00.000Z")
    store.record(syncEvent("ses_1", "CANARY_TITLE_TEXT"), "ses_1", "/repo", undefined, "2026-09-04T00:00:01.000Z")
    const snap = store.snapshot({ observing: false, stoppedAt: "2026-09-04T00:00:02.000Z" })
    expect(snap.entries).toHaveLength(1)
    expect(snap.entries[0]!).toMatchObject({ kind: "sync:message.updated.1", sessionID: "ses_1" })
    expect(JSON.stringify(snap)).not.toContain("CANARY_TITLE_TEXT")
    expect(JSON.stringify(snap)).not.toContain("msg-1")
  })

  it("bounds strings and caps memory with explicit truncation metadata", () => {
    const store = new SseTimelineStore()
    store.start("2026-09-04T00:00:00.000Z")
    const long = `d/${"x".repeat(SSE_TIMELINE_STRING_LIMIT + 50)}`
    const first = store.record(statusEvent("ses_1", "busy"), "ses_1", long, undefined, "2026-09-04T00:00:01.000Z")
    expect(first?.directory).toHaveLength(SSE_TIMELINE_STRING_LIMIT)
    for (let i = 1; i < SSE_TIMELINE_CAP + 5; i++) {
      store.record(idleEvent("ses_1"), "ses_1", "/repo", undefined, "2026-09-04T00:00:01.000Z")
    }
    const snap = store.snapshot({ observing: false, stoppedAt: null })
    expect(snap.count).toBe(SSE_TIMELINE_CAP)
    expect(snap.dropped).toBe(5)
    expect(snap.truncated).toBe(true)
    expect(snap.entries.map((e) => e.seq)).toEqual(Array.from({ length: SSE_TIMELINE_CAP }, (_, i) => i))
    expect(validateSseTimeline(JSON.parse(JSON.stringify(snap)))).toBeNull()
  })

  it("bounds oversized kind and status to the shared string limit", () => {
    const store = new SseTimelineStore()
    store.start("2026-09-04T00:00:00.000Z")
    const longName = `message.updated.${"n".repeat(SSE_TIMELINE_STRING_LIMIT + 50)}`
    const syncLong = {
      type: "sync",
      name: longName,
      id: "m-1",
      seq: 1,
      aggregateID: "a-1",
      data: { sessionID: "ses_1" },
    } as unknown as SSEPayload
    const kindEntry = store.record(syncLong, "ses_1", "/repo", undefined, "2026-09-04T00:00:01.000Z")
    expect(kindEntry?.kind).toHaveLength(SSE_TIMELINE_STRING_LIMIT)
    expect(kindEntry?.kind.startsWith("sync:")).toBeTrue()
    const longStatus = "s".repeat(SSE_TIMELINE_STRING_LIMIT + 25)
    const statusEntry = store.record(
      statusEvent("ses_1", longStatus),
      "ses_1",
      "/repo",
      undefined,
      "2026-09-04T00:00:02.000Z",
    )
    expect(statusEntry?.status).toHaveLength(SSE_TIMELINE_STRING_LIMIT)
    const snap = store.snapshot({ observing: false, stoppedAt: null })
    expect(validateSseTimeline(JSON.parse(JSON.stringify(snap)))).toBeNull()
  })

  it("reset clears entries, drops, and start time", () => {
    const store = new SseTimelineStore()
    store.start("2026-09-04T00:00:00.000Z")
    store.record(idleEvent("ses_1"), "ses_1", "/repo", undefined, "2026-09-04T00:00:01.000Z")
    store.reset()
    const snap = store.snapshot({ observing: false, stoppedAt: null })
    expect(snap.count).toBe(0)
    expect(snap.dropped).toBe(0)
    expect(snap.startedAt).toBeNull()
  })
})

describe("SseTimelineFixture (fixture-gated lifecycle over the existing onEvent path)", () => {
  let original: string | undefined
  beforeEach(() => {
    original = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
  })
  afterEach(() => {
    if (original === undefined) delete process.env.KILO_E2E_FIXTURE
    else process.env.KILO_E2E_FIXTURE = original
  })

  /** Fake delivered-event bus: mirrors connectionService.onEvent subscribe/unsubscribe. */
  function bus() {
    const listeners = new Set<SseTimelineListener>()
    return {
      subscribe: (listener: SseTimelineListener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      emit: (event: SSEPayload, dir?: string, tx?: string) => {
        for (const listener of listeners) listener(event, dir, tx)
      },
      size: () => listeners.size,
    }
  }

  // The host wires the existing resolveEventSessionId helper; the fake echoes
  // the session scope the same way without importing the service.
  function resolve(event: SSEPayload): string | undefined {
    if (event.type === "sync") return (event.data as { sessionID?: string }).sessionID
    const props = (event as { properties?: { sessionID?: string } }).properties
    return props?.sessionID
  }

  it("throws without the fixture gate", () => {
    delete process.env.KILO_E2E_FIXTURE
    const fixture = new SseTimelineFixture()
    const feed = bus()
    expect(() => fixture.start(feed.subscribe, resolve)).toThrow(/KILO_E2E_FIXTURE/)
    expect(() => fixture.stop()).toThrow(/KILO_E2E_FIXTURE/)
    expect(() => fixture.read()).toThrow(/KILO_E2E_FIXTURE/)
    expect(() => fixture.reset()).toThrow(/KILO_E2E_FIXTURE/)
    expect(feed.size()).toBe(0)
    fixture.dispose()
  })

  it("records redacted delivered-event metadata in arrival order without altering dispatch", () => {
    const fixture = new SseTimelineFixture()
    const feed = bus()
    try {
      // A pre-existing production listener shares the bus; the fixture must not disturb it.
      const seen: string[] = []
      const unsub = feed.subscribe((event) => {
        seen.push(event.type === "sync" ? event.name : event.type)
      })
      try {
        const started = fixture.start(feed.subscribe, resolve)
        expect(started.observing).toBe(true)
        feed.emit(statusEvent("ses_A", "busy"), "/repo", "tx-stop-a")
        feed.emit(idleEvent("ses_A"), "/repo", undefined)
        expect(seen).toEqual(["session.status", "session.idle"])
        const read = fixture.read()
        expect(read.observing).toBe(true)
        expect(read.stoppedAt).toBeNull()
        expect(read.entries.map((e) => e.kind)).toEqual(["session.status", "session.idle"])
        expect(read.entries[0]!).toMatchObject({
          seq: 0,
          sessionID: "ses_A",
          directory: "/repo",
          transaction: "tx-stop-a",
          status: "busy",
        })
        const stopped = fixture.stop()
        expect(stopped.observing).toBe(false)
        expect(stopped.count).toBe(2)
        expect(typeof stopped.stoppedAt).toBe("string")
        expect(feed.size()).toBe(1)
        // Stop unsubscribed: later deliveries are not recorded but still dispatch.
        feed.emit(idleEvent("ses_A"), "/repo", undefined)
        expect(fixture.read().count).toBe(2)
        expect(seen).toHaveLength(3)
        // Reset clears the window; a fresh start begins at seq 0.
        expect(fixture.reset()).toBe(true)
        expect(fixture.read().count).toBe(0)
        fixture.start(feed.subscribe, resolve)
        feed.emit(idleEvent("ses_B"), "/repo", undefined)
        const again = fixture.stop()
        expect(again.entries.map((e) => e.seq)).toEqual([0])
        expect(again.entries[0]!.sessionID).toBe("ses_B")
      } finally {
        unsub()
      }
    } finally {
      fixture.dispose()
    }
    expect(feed.size()).toBe(0)
  })

  it("rides the real connection-service dispatch without altering it", () => {
    const service = new KiloConnectionService({} as never)
    const fixture = new SseTimelineFixture()
    try {
      const seen: string[] = []
      const unsub = service.onEvent((event) => {
        seen.push(event.type === "sync" ? event.name : event.type)
      })
      try {
        fixture.start(service.onEvent.bind(service), resolveTimelineSessionId)
        service.handleSseEvent(statusEvent("ses_A", "busy"), "/repo", "tx-1")
        service.handleSseEvent(syncEvent("ses_A", "CANARY_DISPATCH_TITLE"), "/repo", undefined)
        const snap = fixture.stop()
        expect(seen).toEqual(["session.status", "message.updated.1"])
        expect(snap.entries.map((e) => e.kind)).toEqual(["session.status", "sync:message.updated.1"])
        expect(snap.entries[0]!).toMatchObject({ sessionID: "ses_A", status: "busy", transaction: "tx-1" })
        expect(JSON.stringify(snap)).not.toContain("CANARY_DISPATCH_TITLE")
      } finally {
        unsub()
      }
    } finally {
      fixture.dispose()
      service.dispose()
    }
  })

  it("message.updated.1 timeline capture does not mutate connection-service state", () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const service = new KiloConnectionService({} as never)
    const fixture = new SseTimelineFixture()
    try {
      fixture.start(service.onEvent.bind(service), resolveTimelineSessionId)
      service.handleSseEvent(syncEvent("ses_A", "CANARY_MUTATION_TITLE"), "/repo", undefined)
      service.handleSseEvent(statusEvent("ses_A", "busy"), "/repo", "tx-1")
      const snap = fixture.stop()
      // The passive resolver still records safe redacted fields.
      expect(snap.entries.map((e) => e.kind)).toEqual(["sync:message.updated.1", "session.status"])
      expect(snap.entries[0]!).toMatchObject({ sessionID: "ses_A", directory: "/repo" })
      expect(snap.entries[1]!).toMatchObject({ sessionID: "ses_A", status: "busy" })
      expect(JSON.stringify(snap)).not.toContain("CANARY_MUTATION_TITLE")
      expect(JSON.stringify(snap)).not.toContain("msg-1")
      // No connection-service message-map write: the private lookup stays empty
      // even though the sync message.updated.1 path would write via the
      // stateful resolver.
      const maps = service as unknown as { messageSessionIdsByMessageId: Map<string, string> }
      expect(maps.messageSessionIdsByMessageId.size).toBe(0)
    } finally {
      fixture.dispose()
      service.dispose()
    }
  })

  it("resolveTimelineSessionId is pure: sync/transient resolve, unknown stays undefined", () => {
    expect(resolveTimelineSessionId(syncEvent("ses_X", "x"))).toBe("ses_X")
    expect(resolveTimelineSessionId(statusEvent("ses_Y", "busy"))).toBe("ses_Y")
    expect(resolveTimelineSessionId(idleEvent("ses_Z"))).toBe("ses_Z")
    const unknown = { id: "e-?", type: "other.event", properties: { sessionID: "ses_Q" } } as unknown as SSEPayload
    expect(resolveTimelineSessionId(unknown)).toBeUndefined()
  })
})

describe("SSE timeline evidence bridge", () => {
  it("lists both abort artifacts as optional real-session evidence", () => {
    const { required, optional } = evidenceInventory(new Set(["real-session"]))
    const optionalRels = optional.map((s) => `${s.base}:${s.rel}`)
    expect(optionalRels).toContain("scratch:sse-timeline-abort-A.json")
    expect(optionalRels).toContain("scratch:sse-timeline-abort-B.json")
    expect(required.map((s) => s.rel)).not.toContain("sse-timeline-abort-A.json")
    expect(required.map((s) => s.rel)).not.toContain("sse-timeline-abort-B.json")
  })

  it("accepts a minimal redacted artifact and rejects payload leakage", () => {
    const good = {
      schema: SSE_TIMELINE_SCHEMA,
      startedAt: "2026-09-04T00:00:00.000Z",
      stoppedAt: "2026-09-04T00:00:05.000Z",
      observing: false,
      cap: SSE_TIMELINE_CAP,
      count: 2,
      dropped: 0,
      truncated: false,
      entries: [
        { seq: 0, at: "2026-09-04T00:00:01.000Z", kind: "session.status", sessionID: "ses_A", status: "busy" },
        { seq: 1, at: "2026-09-04T00:00:04.000Z", kind: "session.idle", sessionID: "ses_A" },
      ],
    }
    expect(validateSseTimeline(JSON.parse(JSON.stringify(good)))).toBeNull()
    expect(parseFailure("sse-timeline-abort-A.json", Buffer.from(JSON.stringify(good)))).toBeNull()
    const outOfOrder = { ...good, entries: [...good.entries].reverse() }
    expect(validateSseTimeline(outOfOrder)).toMatch(/seq/)
    const leaked = {
      ...good,
      entries: [{ seq: 0, at: "2026-09-04T00:00:01.000Z", kind: "session.status", payload: { x: 1 } }],
      count: 1,
    }
    expect(validateSseTimeline(leaked)).toMatch(/forbidden/)
  })

  it("requires canonical UTC millisecond ISO timestamps (toISOString round-trip)", () => {
    const good = {
      schema: SSE_TIMELINE_SCHEMA,
      startedAt: "2026-09-04T00:00:00.000Z",
      stoppedAt: "2026-09-04T00:00:05.000Z",
      observing: false,
      cap: SSE_TIMELINE_CAP,
      count: 1,
      dropped: 0,
      truncated: false,
      entries: [{ seq: 0, at: "2026-09-04T00:00:01.000Z", kind: "session.idle", sessionID: "ses_A" }],
    }
    expect(validateSseTimeline(JSON.parse(JSON.stringify(good)))).toBeNull()
    expect(validateSseTimeline({ ...good, startedAt: new Date(1000).toISOString() })).toBeNull()
    expect(validateSseTimeline({ ...good, startedAt: "2026-09-04" })).toMatch(/canonical ISO/)
    expect(validateSseTimeline({ ...good, stoppedAt: "2026-09-04T00:00:05.000+00:00" })).toMatch(/canonical ISO/)
    expect(validateSseTimeline({ ...good, stoppedAt: "2026-09-04T00:00:05Z" })).toMatch(/canonical ISO/)
    expect(
      validateSseTimeline({
        ...good,
        entries: [{ seq: 0, at: "2026-09-04T00:00:01.00Z", kind: "session.idle", sessionID: "ses_A" }],
      }),
    ).toMatch(/canonical ISO/)
    expect(
      validateSseTimeline({
        ...good,
        entries: [{ seq: 0, at: "2026-02-30T00:00:00.000Z", kind: "session.idle", sessionID: "ses_A" }],
      }),
    ).toMatch(/canonical ISO/)
  })

  it("rejects oversized kind/status with the shared bound", () => {
    const good = {
      schema: SSE_TIMELINE_SCHEMA,
      startedAt: "2026-09-04T00:00:00.000Z",
      stoppedAt: "2026-09-04T00:00:05.000Z",
      observing: false,
      cap: SSE_TIMELINE_CAP,
      count: 1,
      dropped: 0,
      truncated: false,
      entries: [{ seq: 0, at: "2026-09-04T00:00:01.000Z", kind: "session.idle", sessionID: "ses_A" }],
    }
    const longKind = {
      ...good,
      entries: [
        { seq: 0, at: "2026-09-04T00:00:01.000Z", kind: `k/${"k".repeat(SSE_TIMELINE_STRING_LIMIT)}x`, sessionID: "ses_A" },
      ],
    }
    expect(validateSseTimeline(longKind)).toMatch(/kind exceeds bound/)
    const longStatus = {
      ...good,
      entries: [
        {
          seq: 0,
          at: "2026-09-04T00:00:01.000Z",
          kind: "session.status",
          sessionID: "ses_A",
          status: "s".repeat(SSE_TIMELINE_STRING_LIMIT + 1),
        },
      ],
    }
    expect(validateSseTimeline(longStatus)).toMatch(/status.*exceeds bound/)
  })
})
