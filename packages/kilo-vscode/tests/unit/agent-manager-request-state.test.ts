import { describe, it, expect, mock } from "bun:test"
import { AgentManagerObservationCoordinator } from "../../src/agent-manager/observation-coordinator"
import { InMemoryCursorStore } from "../../src/private-worker/observation-cursor-store"
import { AgentManagerProvider } from "../../src/agent-manager/AgentManagerProvider"

function fakePrivate(opts: {
  enabled: boolean
  persisted?: number
  snapshotCursor?: number
  snapshotFails?: boolean
  snapshotInvalid?: unknown
  snapshotDelayMs?: number
  readResult?: { cursor: number; rehydrate: boolean; entries: unknown[]; reason?: string } | null
  readFails?: boolean
  readDelayMs?: number
  readInvalid?: unknown
  ackFails?: boolean
  ackLog?: number[]
  snapshotLog?: number[]
  readLog?: number[]
  storeFailsOnAck?: boolean
}) {
  const store = new InMemoryCursorStore()
  if (opts.persisted !== undefined) store.set(opts.persisted)
  const ackLog: number[] = opts.ackLog ?? []
  const snapshotLog: number[] = opts.snapshotLog ?? []
  const readLog: number[] = opts.readLog ?? []
  const svc: any = {
    isEnabled: () => opts.enabled,
    isStarted: () => true,
    getPersistedCursor: () => store.get(),
    setPersistedCursor: (c: number) => store.set(c),
    snapshot: async () => {
      if (opts.snapshotDelayMs) await new Promise((r) => setTimeout(r, opts.snapshotDelayMs))
      if (opts.snapshotFails) throw new Error("snapshot fail")
      if (opts.snapshotInvalid !== undefined) return opts.snapshotInvalid
      const c = opts.snapshotCursor ?? 5
      snapshotLog.push(c)
      return { v: "1.0", cursor: c, snapshot: {} }
    },
    read: async (cur: number) => {
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
      readLog.push(cur)
      if (opts.readFails) throw new Error("read fail")
      if (opts.readInvalid !== undefined) return opts.readInvalid
      if (opts.readResult !== undefined) {
        if (opts.readResult === null) return { bogus: true }
        const rr: any = { ...opts.readResult }
        if (rr.rehydrate === true && rr.reason === undefined) rr.reason = "gap"
        return { v: "1.0", ...rr }
      }
      return { v: "1.0", cursor: cur, rehydrate: false, entries: [] }
    },
    ack: async (c: number) => {
      ackLog.push(c)
      if (opts.ackFails) throw new Error("ack fail")
      if (opts.storeFailsOnAck) throw new Error("store persist fail")
      await store.set(c)
      return { v: "1.0", cursor: c }
    },
  }
  return { svc, store, ackLog, snapshotLog, readLog }
}

function makeProvider(svc: any) {
  const p: any = Object.create(AgentManagerProvider.prototype)
  p.host = { workspaceStore: { get: () => undefined, update: () => Promise.resolve() } }
  p.panel = undefined
  p.hydrated = false
  p.generation = 0
  p.refreshPromise = null
  p.refreshGen = null
  p.refreshSessions = null
  p.coordinator = new AgentManagerObservationCoordinator(svc)
  p.stateReady = Promise.resolve()
  p.log = () => {}
  p.statsPoller = { setVisible: () => {}, stop: () => {}, setEnabled: () => {} } as any
  p.visiblePresence = { clear: () => {}, flush: () => {} } as any
  p.catalogUnsub = undefined
  p.accumulatedCatalog = undefined
  p.accumulatedHasMore = undefined
  p.catalogTombstone = new Set()
  return p
}

describe("AgentManagerObservationCoordinator", () => {
  it("initial hydration captures snapshot cursor before refresh and acks after success", async () => {
    const { svc, ackLog } = fakePrivate({ enabled: true, snapshotCursor: 10 })
    const coord = new AgentManagerObservationCoordinator(svc)
    const cap = await coord.captureSnapshotCursor()
    expect(cap).toBe(10)
    const ok = await coord.ack(cap!)
    expect(ok).toBe(true)
    expect(ackLog).toEqual([10])
    expect(svc.getPersistedCursor()).toBe(10)
  })

  it("current empty delta skips refresh", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 7, readResult: { cursor: 7, rehydrate: false, entries: [] } })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(false)
    expect(dec.ackCursor).toBeUndefined()
  })

  it("non-empty entries triggers one refresh+ack", async () => {
    const { svc } = fakePrivate({
      enabled: true,
      persisted: 7,
      readResult: { cursor: 8, rehydrate: false, entries: [{ seq: 8, session_id: "a", revision: 1, kind: "changed", time: 1 }] },
    })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBe(8)
    const ok = await coord.ack(dec.ackCursor!)
    expect(ok).toBe(true)
    expect(svc.getPersistedCursor()).toBe(8)
  })

  it("rehydrate triggers one refresh+ack", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 3, readResult: { cursor: 9, rehydrate: true, entries: [] } })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBe(9)
  })

  it("mutation during refresh remains visible after ack (captured cursor before, new seq unacked)", async () => {
    const { svc, store } = fakePrivate({ enabled: true, snapshotCursor: 5, persisted: undefined })
    const coord = new AgentManagerObservationCoordinator(svc)
    const cap = await coord.captureSnapshotCursor()
    expect(cap).toBe(5)
    const ok = await coord.ack(cap!)
    expect(ok).toBe(true)
    expect(store.get()).toBe(5)
    svc.read = async (cur: number) => ({ v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "s", revision: 0, kind: "changed", time: 1 }] })
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBe(6)
  })

  it("ack rejection returns false", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 1, snapshotCursor: 1, ackFails: true })
    const coord = new AgentManagerObservationCoordinator(svc)
    const ok = await coord.ack(1)
    expect(ok).toBe(false)
  })

  it("private failure fallback decides refresh without ack", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 1, readFails: true })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBeUndefined()
  })

  it("private disabled fallback decides refresh without ack", async () => {
    const { svc } = fakePrivate({ enabled: false })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBeUndefined()
    const cap = await coord.captureSnapshotCursor()
    expect(cap).toBeUndefined()
  })

  it("ambiguous read result falls back to refresh without ack", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 2, readResult: null as any })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBeUndefined()
  })

  it("invalid version fallback", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 1, readInvalid: { v: "0.9", cursor: 1, rehydrate: false, entries: [] } })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBeUndefined()
    const cap = await (async () => {
      const bad: any = { isEnabled: () => true, snapshot: async () => ({ v: "0.9", cursor: 5 }), getPersistedCursor: () => undefined, read: async () => ({}), ack: async () => ({}) }
      const c = new AgentManagerObservationCoordinator(bad)
      return c.captureSnapshotCursor()
    })()
    expect(cap).toBeUndefined()
  })

  it("invalid cursor fallback (negative, unsafe, regression)", async () => {
    const badCursors = [
      { v: "1.0", cursor: -1, rehydrate: false, entries: [] },
      { v: "1.0", cursor: Number.MAX_SAFE_INTEGER + 1, rehydrate: false, entries: [] },
      { v: "1.0", cursor: 0, rehydrate: false, entries: [] }, // when persisted 1, cursor 0 < requested 1 -> invalid
    ]
    for (const inv of badCursors) {
      const { svc } = fakePrivate({ enabled: true, persisted: 1, readInvalid: inv as any })
      const coord = new AgentManagerObservationCoordinator(svc)
      const dec = await coord.decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
    const snapBad = await (async () => {
      const bad: any = { isEnabled: () => true, snapshot: async () => ({ v: "1.0", cursor: -1 }), getPersistedCursor: () => undefined, read: async () => ({}), ack: async () => ({}) }
      const c = new AgentManagerObservationCoordinator(bad)
      return c.captureSnapshotCursor()
    })()
    expect(snapBad).toBeUndefined()
  })

  it("invalid entry shapes fallback", async () => {
    const invalidEntries: unknown[][] = [
      [{ seq: 0, session_id: "a", revision: 0, kind: "changed", time: 1 }], // seq 0 not positive
      [{ seq: 2, session_id: "", revision: 0, kind: "changed", time: 1 }], // empty session_id
      [{ seq: 2, session_id: "a", revision: -1, kind: "changed", time: 1 }], // negative revision
      [{ seq: 2, session_id: "a", revision: 0, kind: "unknown", time: 1 }], // bad kind
      [{ seq: 2, session_id: "a", revision: 0, kind: "changed", time: NaN }], // non-finite time
      [
        { seq: 3, session_id: "a", revision: 0, kind: "changed", time: 1 },
        { seq: 2, session_id: "b", revision: 0, kind: "changed", time: 1 },
      ], // not ascending
      [{ seq: 10, session_id: "a", revision: 0, kind: "changed", time: 1 }], // seq > cursor (cursor 5)
    ]
    for (const entries of invalidEntries) {
      const cursor = entries.some((e: any) => e.seq === 10) ? 5 : 5
      const { svc } = fakePrivate({ enabled: true, persisted: 1, readInvalid: { v: "1.0", cursor, rehydrate: false, entries } as any })
      const coord = new AgentManagerObservationCoordinator(svc)
      const dec = await coord.decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
  })

  it("cursor >= persists and seq <= cursor enforced", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 4, rehydrate: false, entries: [] } as any })
    const coord = new AgentManagerObservationCoordinator(svc)
    const dec = await coord.decide()
    expect(dec.shouldRefresh).toBe(true)
    expect(dec.ackCursor).toBeUndefined()
  })

  it("equal and older-than-request seq rejected (seq must be > persisted cursor)", async () => {
    for (const bad of [
      { cursor: 6, entries: [{ seq: 5, session_id: "a", revision: 0, kind: "changed", time: 1 }] }, // equal to persisted 5
      { cursor: 6, entries: [{ seq: 4, session_id: "a", revision: 0, kind: "changed", time: 1 }] }, // older
      { cursor: 7, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }, { seq: 5, session_id: "b", revision: 0, kind: "changed", time: 1 }] }, // second older
    ]) {
      const { svc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", ...bad, rehydrate: false } as any })
      const coord = new AgentManagerObservationCoordinator(svc)
      const dec = await coord.decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
    // valid: seq 6 > persisted 5 should succeed
    const { svc: okSvc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] } as any })
    const ok = await new AgentManagerObservationCoordinator(okSvc).decide()
    expect(ok.shouldRefresh).toBe(true)
    expect(ok.ackCursor).toBe(6)
  })

  it("malformed rehydrate entries/reason rejected", async () => {
    const cases: unknown[] = [
      { v: "1.0", cursor: 9, rehydrate: true, entries: [{ seq: 9, session_id: "a", revision: 0, kind: "changed", time: 1 }], reason: "gap" }, // non-empty entries
      { v: "1.0", cursor: 9, rehydrate: true, entries: [], reason: "" }, // empty reason
      { v: "1.0", cursor: 9, rehydrate: true, entries: [], reason: "   " }, // whitespace only
      { v: "1.0", cursor: 9, rehydrate: true, entries: [] }, // missing reason
      { v: "1.0", cursor: 9, rehydrate: true, entries: [], reason: 123 }, // non-string reason
      { v: "1.0", cursor: 9, rehydrate: true, entries: [], reason: "x".repeat(257) }, // over bounded length
    ]
    for (const inv of cases) {
      const { svc } = fakePrivate({ enabled: true, persisted: 1, readInvalid: inv as any })
      const coord = new AgentManagerObservationCoordinator(svc)
      const dec = await coord.decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
    // valid rehydrate with bounded reason should ack
    const { svc: valid } = fakePrivate({ enabled: true, persisted: 1, readInvalid: { v: "1.0", cursor: 9, rehydrate: true, entries: [], reason: "evicted" } as any })
    const decValid = await new AgentManagerObservationCoordinator(valid).decide()
    expect(decValid.shouldRefresh).toBe(true)
    expect(decValid.ackCursor).toBe(9)
    // rehydrate:false must not require reason — even with missing/invalid reason, valid delta should ack
    const { svc: noReasonDelta } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] } as any })
    const decNoReason = await new AgentManagerObservationCoordinator(noReasonDelta).decide()
    expect(decNoReason.shouldRefresh).toBe(true)
    expect(decNoReason.ackCursor).toBe(6)
  })

  it("rehydrate:false rejects gaps — missing middle, missing tail, first seq gap, advanced empty cursor", async () => {
    // missing middle: persisted 5, cursor 8, entries [6,8] gaps 7
    {
      const { svc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 8, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }, { seq: 8, session_id: "b", revision: 0, kind: "changed", time: 1 }] } as any })
      const dec = await new AgentManagerObservationCoordinator(svc).decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
    // missing tail: persisted 5, cursor 8, entries [6,7] last 7 != 8
    {
      const { svc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 8, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }, { seq: 7, session_id: "b", revision: 0, kind: "changed", time: 1 }] } as any })
      const dec = await new AgentManagerObservationCoordinator(svc).decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
    // first seq gap: persisted 5, cursor 7, entries [7] should be 6
    {
      const { svc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 7, rehydrate: false, entries: [{ seq: 7, session_id: "a", revision: 0, kind: "changed", time: 1 }] } as any })
      const dec = await new AgentManagerObservationCoordinator(svc).decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
    // empty entries with advanced cursor: persisted 5, cursor 6, entries []
    {
      const { svc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 6, rehydrate: false, entries: [] } as any })
      const dec = await new AgentManagerObservationCoordinator(svc).decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBeUndefined()
    }
  })

  it("rehydrate:false accepts valid contiguous multi-entry and returns ack cursor", async () => {
    // 3 entries: persisted 5, cursor 8, entries [6,7,8]
    {
      const { svc } = fakePrivate({ enabled: true, persisted: 5, readInvalid: { v: "1.0", cursor: 8, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }, { seq: 7, session_id: "b", revision: 0, kind: "changed", time: 2 }, { seq: 8, session_id: "c", revision: 0, kind: "deleted", time: 3 }] } as any })
      const dec = await new AgentManagerObservationCoordinator(svc).decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBe(8)
    }
    // 2 entries: persisted 10, cursor 12, entries [11,12]
    {
      const { svc } = fakePrivate({ enabled: true, persisted: 10, readInvalid: { v: "1.0", cursor: 12, rehydrate: false, entries: [{ seq: 11, session_id: "x", revision: 1, kind: "changed", time: 1 }, { seq: 12, session_id: "y", revision: 2, kind: "changed", time: 2 }] } as any })
      const dec = await new AgentManagerObservationCoordinator(svc).decide()
      expect(dec.shouldRefresh).toBe(true)
      expect(dec.ackCursor).toBe(12)
    }
  })

  it("rehydrate:false valid empty current cursor skips refresh", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 7, readInvalid: { v: "1.0", cursor: 7, rehydrate: false, entries: [] } as any })
    const dec = await new AgentManagerObservationCoordinator(svc).decide()
    expect(dec.shouldRefresh).toBe(false)
    expect(dec.ackCursor).toBeUndefined()
  })
})

describe("AgentManagerProvider requestState hydration reset and singleflight", () => {
  it("new panel resets hydration so first requestState always refreshes even when cursor current", async () => {
    const { svc } = fakePrivate({ enabled: true, snapshotCursor: 3, persisted: 3, readResult: { cursor: 3, rehydrate: false, entries: [] } })
    const provider: any = makeProvider(svc)
    let refreshCount = 0
    const fakeSessions = { refreshSessions: async () => { refreshCount++ } } as any
    provider.panel = { sessions: fakeSessions, visible: true, postMessage: () => {}, waitForReady: async () => {} } as any
    provider.hydrated = false
    provider.generation = 1
    await provider.handleObservationRefresh()
    expect(refreshCount).toBe(1)
    expect(provider.hydrated).toBe(true)
    refreshCount = 0
    await provider.handleObservationRefresh()
    expect(refreshCount).toBe(0)
    provider.hydrated = false
    provider.generation = 2
    provider.panel = { sessions: fakeSessions, visible: true, postMessage: () => {}, waitForReady: async () => {} } as any
    await provider.handleObservationRefresh()
    expect(refreshCount).toBe(1)
  })

  it("attachPanel increments generation and resets hydration", async () => {
    const { svc } = fakePrivate({ enabled: true, snapshotCursor: 9, persisted: 9, readResult: { cursor: 9, rehydrate: false, entries: [] } })
    const p: any = Object.create(AgentManagerProvider.prototype)
    p.host = { workspaceStore: { get: () => undefined, update: () => Promise.resolve() }, createOutput: () => ({ appendLine: () => {}, dispose: () => {} }), workspacePath: () => "/tmp" } as any
    p.connectionService = { onEventFiltered: () => () => {}, registerVisible: () => {}, registerAttached: () => {} } as any
    p.statsPoller = { setVisible: () => {}, stop: () => {}, setEnabled: () => {} } as any
    p.visiblePresence = { clear: () => {}, flush: () => {} } as any
    p.catalogUnsub = undefined
    p.accumulatedCatalog = undefined
    p.accumulatedHasMore = undefined
    p.catalogTombstone = new Set()
    p.panel = undefined
    p.hydrated = true
    p.generation = 5
    p.refreshPromise = null
    p.refreshGen = null
    p.refreshSessions = null
    p.coordinator = new AgentManagerObservationCoordinator(svc)
    p.log = () => {}
    p.outputChannel = { appendLine: () => {}, dispose: () => {} } as any
    p.initializeState = async () => {}
    p.stateReady = undefined
    p.sendRepoInfo = async () => {}
    p.sendKeybindings = () => {}
    p.emitVisibilityChanged = () => {}
    const sessions: any = { onCatalog: undefined, refreshSessions: async () => {}, dispose: () => {}, abortSessions: async () => {} }
    const ctx1: any = { visible: true, active: true, postMessage: () => {}, waitForReady: async () => {}, waitForActive: async () => {}, reveal: () => {}, sessions, onDidChangeVisibility: () => ({ dispose: () => {} }), onDidDispose: (cb: any) => ({ dispose: () => {} }), dispose: () => {} }
    const genBefore = p.generation
    p.attachPanel(ctx1)
    expect(p.generation).toBe(genBefore + 1)
    expect(p.hydrated).toBe(false)
    await p.handleObservationRefresh()
    expect(p.hydrated).toBe(true)
    const genAfterFirst = p.generation
    const ctx2: any = { ...ctx1, sessions: { ...sessions }, dispose: () => {} }
    p.attachPanel(ctx2)
    expect(p.generation).toBe(genAfterFirst + 1)
    expect(p.hydrated).toBe(false)
  })

  it("two concurrent requestState share one initial refresh (singleflight)", async () => {
    const { svc } = fakePrivate({ enabled: true, snapshotCursor: 1, snapshotDelayMs: 30 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    let refreshCount = 0
    let resolveRefresh: (() => void) | null = null
    const fakeSessions = {
      refreshSessions: () =>
        new Promise<void>((r) => {
          refreshCount++
          resolveRefresh = r
          setTimeout(r, 40)
        }),
    } as any
    provider.panel = { sessions: fakeSessions } as any
    provider.hydrated = false
    const p1 = provider.handleObservationRefresh()
    const p2 = provider.handleObservationRefresh()
    expect(p1).toBe(p2)
    await Promise.all([p1, p2])
    expect(refreshCount).toBe(1)
    expect(provider.hydrated).toBe(true)
    // later independent request with empty delta should not refresh
    provider.panel = { sessions: { refreshSessions: async () => { refreshCount++ } } as any } as any
    // set persisted to 1 and read empty
    svc.getPersistedCursor = () => 1
    svc.read = async () => ({ v: "1.0", cursor: 1, rehydrate: false, entries: [] })
    const before = refreshCount
    await provider.handleObservationRefresh()
    expect(refreshCount).toBe(before)
  })

  it("later requestState with empty delta does no refresh; non-empty does one", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 5, readResult: { cursor: 5, rehydrate: false, entries: [] } })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let rc = 0
    provider.panel = { sessions: { refreshSessions: async () => { rc++ } } as any } as any
    await provider.handleObservationRefresh()
    expect(rc).toBe(0)
    // now non-empty
    svc.read = async () => ({ v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "s", revision: 0, kind: "changed", time: 1 }] })
    await provider.handleObservationRefresh()
    expect(rc).toBe(1)
  })

  it("panel replacement during old hydration cannot mark new panel hydrated/share old promise", async () => {
    const { svc } = fakePrivate({ enabled: true, snapshotCursor: 7, snapshotDelayMs: 60 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    let oldRefreshCalls = 0
    let newRefreshCalls = 0
    const oldSessions = {
      refreshSessions: async () => {
        oldRefreshCalls++
        await new Promise((r) => setTimeout(r, 80))
      },
    } as any
    const newSessions = {
      refreshSessions: async () => {
        newRefreshCalls++
      },
    } as any
    provider.panel = { sessions: oldSessions } as any
    const oldPromise = provider.handleObservationRefresh()
    // swap before snapshot completes to prefer avoiding stale work
    await new Promise((r) => setTimeout(r, 15))
    provider.generation = 2
    provider.hydrated = false
    provider.panel = { sessions: newSessions } as any
    const newPromise = provider.handleObservationRefresh()
    expect(newPromise).not.toBe(oldPromise)
    await oldPromise
    // old promise must not have hydrated new generation and should have avoided stale refresh
    expect(provider.hydrated).toBe(false)
    expect(oldRefreshCalls).toBe(0)
    expect(newRefreshCalls).toBe(0)
    await newPromise
    expect(provider.hydrated).toBe(true)
    expect(newRefreshCalls).toBe(1)
    expect(oldRefreshCalls).toBe(0)
  })

  it("ack rejection keeps hydration false and retry refreshes (initial hydration)", async () => {
    const { svc, store } = fakePrivate({ enabled: true, snapshotCursor: 11, ackFails: true })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    let rc = 0
    provider.panel = { sessions: { refreshSessions: async () => { rc++ } } as any } as any
    await provider.handleObservationRefresh()
    expect(rc).toBe(1)
    expect(provider.hydrated).toBe(false)
    expect(store.get()).toBeUndefined()
    // fix ack and retry should succeed
    svc.ack = async (c: number) => {
      await store.set(c)
      return { v: "1.0", cursor: c }
    }
    await provider.handleObservationRefresh()
    expect(rc).toBe(2)
    expect(provider.hydrated).toBe(true)
    expect(store.get()).toBe(11)
  })

  it("post-hydration ack rejection leaves hydrated true and persisted unchanged, next refresh may retry", async () => {
    const { svc, store } = fakePrivate({ enabled: true, persisted: 1, readResult: { cursor: 2, rehydrate: false, entries: [{ seq: 2, session_id: "a", revision: 0, kind: "changed", time: 1 }] } })
    svc.ack = async () => { throw new Error("ack fail") }
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let rc = 0
    provider.panel = { sessions: { refreshSessions: async () => { rc++ } } as any } as any
    await provider.handleObservationRefresh()
    expect(rc).toBe(1)
    expect(provider.hydrated).toBe(true)
    expect(store.get()).toBe(1)
    // next request with same decision should retry refresh (since ack failed, still entries)
    await provider.handleObservationRefresh()
    expect(rc).toBe(2)
  })

  it("SDK refresh failure no ack and retry; invalid version fallback does not ack", async () => {
    const { svc, ackLog } = fakePrivate({ enabled: true, snapshotCursor: 3 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    provider.panel = { sessions: { refreshSessions: async () => { throw new Error("sdk fail") } } as any } as any
    await provider.handleObservationRefresh()
    expect(ackLog.length).toBe(0)
    expect(provider.hydrated).toBe(false)
    // retry with success should hydrate
    provider.panel = { sessions: { refreshSessions: async () => {} } as any } as any
    await provider.handleObservationRefresh()
    expect(provider.hydrated).toBe(true)
    expect(ackLog.length).toBe(1)

    // invalid read fallback: should still do one refresh with no ack
    const badSvc: any = {
      isEnabled: () => true,
      getPersistedCursor: () => 1,
      snapshot: async () => ({ v: "1.0", cursor: 1 }),
      read: async () => ({ v: "bad", cursor: 999, rehydrate: false, entries: [] }),
      ack: async (c: number) => { ackLog.push(c); return { v: "1.0", cursor: c } },
    }
    const badProvider: any = makeProvider(badSvc)
    badProvider.generation = 1
    badProvider.hydrated = true
    let badRc = 0
    badProvider.panel = { sessions: { refreshSessions: async () => { badRc++ } } as any } as any
    const ackBefore = ackLog.length
    await badProvider.handleObservationRefresh()
    expect(badRc).toBe(1)
    expect(ackLog.length).toBe(ackBefore)
  })

  it("change during refresh remains visible (captured cursor before, new seq unacked)", async () => {
    const { svc, store } = fakePrivate({ enabled: true, snapshotCursor: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    provider.panel = { sessions: { refreshSessions: async () => { /* during refresh, new mutation seq 6 committed */ } } as any } as any
    await provider.handleObservationRefresh()
    expect(store.get()).toBe(5)
    // next cycle should see seq 6
    svc.getPersistedCursor = () => store.get()
    svc.read = async (cur: number) => ({ v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "s", revision: 0, kind: "changed", time: 2 }] })
    provider.panel = { sessions: { refreshSessions: async () => {} } as any } as any
    await provider.handleObservationRefresh()
    expect(store.get()).toBe(6)
  })

  it("reconnect-induced failures degrade to one SDK refresh with no false hydration", async () => {
    // snapshot/read throw due to reconnect (host closed)
    const { svc } = fakePrivate({ enabled: true, snapshotFails: true, readFails: true })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    let rc = 0
    provider.panel = { sessions: { refreshSessions: async () => { rc++ } } as any } as any
    await provider.handleObservationRefresh() // initial with snapshot fail -> still one refresh, hydrate true (fallback)
    expect(rc).toBe(1)
    expect(provider.hydrated).toBe(true)
    provider.hydrated = true
    rc = 0
    await provider.handleObservationRefresh() // post hydration read fails -> one refresh, no ack
    expect(rc).toBe(1)
  })

  it("initial hydration snapshot invalid version/cursor still does one SDK refresh with no ack", async () => {
    const badSvc: any = {
      isEnabled: () => true,
      getPersistedCursor: () => undefined,
      snapshot: async () => ({ v: "0.9", cursor: -1 }),
      read: async () => ({ v: "1.0", cursor: 0, rehydrate: false, entries: [] }),
      ack: async () => { throw new Error("should not ack") },
    }
    const provider: any = makeProvider(badSvc)
    provider.generation = 1
    provider.hydrated = false
    let rc = 0
    provider.panel = { sessions: { refreshSessions: async () => { rc++ } } as any } as any
    await provider.handleObservationRefresh()
    expect(rc).toBe(1)
    expect(provider.hydrated).toBe(true)
  })
})

describe("AgentManagerProvider requestState message routing (production-shaped)", () => {
  it("concurrent agentManager.requestState messages coalesce to one initial SDK refresh via onMessage", async () => {
    const { svc } = fakePrivate({ enabled: true, snapshotCursor: 4, snapshotDelayMs: 20 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    let rc = 0
    const fakeSessions: any = {
      refreshSessions: async () => {
        rc++
        await new Promise((r) => setTimeout(r, 40))
      },
    }
    provider.panel = { sessions: fakeSessions, visible: true, postMessage: () => {} } as any
    provider.pushState = () => {}
    provider.postToWebview = () => {}
    provider.stateReady = Promise.resolve()
    // two concurrent production-shaped messages through handleMessage (which routes via onMessage/onStateMessage)
    const m1 = provider.handleMessage({ type: "agentManager.requestState" })
    const m2 = provider.handleMessage({ type: "agentManager.requestState" })
    await Promise.all([m1, m2])
    // allow onRequestState's async handleObservationRefresh to start and coalesce
    await new Promise((r) => setTimeout(r, 10))
    // wait for singleflight promise to settle
    if (provider.refreshPromise) await provider.refreshPromise
    // ensure settled
    await new Promise((r) => setTimeout(r, 50))
    expect(rc).toBe(1)
    expect(provider.hydrated).toBe(true)
    // a third independent message after hydration with empty delta should not refresh
    // persisted is now 4, read empty
    svc.getPersistedCursor = () => 4
    svc.read = async () => ({ v: "1.0", cursor: 4, rehydrate: false, entries: [] })
    rc = 0
    await provider.handleMessage({ type: "agentManager.requestState" })
    await new Promise((r) => setTimeout(r, 10))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(rc).toBe(0)
  })

  it("failed ack via message routing causes later requestState retry", async () => {
    const { svc, store } = fakePrivate({ enabled: true, snapshotCursor: 11, ackFails: true })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    let rc = 0
    provider.panel = { sessions: { refreshSessions: async () => { rc++ } } as any } as any
    provider.pushState = () => {}
    provider.postToWebview = () => {}
    provider.stateReady = Promise.resolve()
    await provider.handleMessage({ type: "agentManager.requestState" })
    await new Promise((r) => setTimeout(r, 10))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(rc).toBe(1)
    expect(provider.hydrated).toBe(false)
    expect(store.get()).toBeUndefined()
    // fix ack and retry via another requestState message should refresh again and hydrate
    svc.ack = async (c: number) => {
      await store.set(c)
      return { v: "1.0", cursor: c }
    }
    rc = 0
    await provider.handleMessage({ type: "agentManager.requestState" })
    await new Promise((r) => setTimeout(r, 10))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(rc).toBe(1)
    expect(provider.hydrated).toBe(true)
    expect(store.get()).toBe(11)
  })
})
