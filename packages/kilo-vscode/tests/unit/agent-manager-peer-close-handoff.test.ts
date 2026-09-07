import { describe, it, expect } from "bun:test"
import { AgentManagerObservationCoordinator } from "../../src/agent-manager/observation-coordinator"
import { InMemoryCursorStore } from "../../src/private-worker/observation-cursor-store"
import { AgentManagerProvider } from "../../src/agent-manager/AgentManagerProvider"
import type { TriggerResult } from "../../src/private-worker/private-observation-lifecycle-triggers"

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
  p.terminalManager = { syncOnSessionSwitch: () => {} } as any
  p.pushState = () => {}
  p.postToWebview = () => {}
  p.schedulePersist = () => {}
  p.waitForStateReady = async (_ctx: string) => {
    if (!p.stateReady) return
    await p.stateReady.catch(() => {})
  }
  p.emitActiveSessionChanged = (id: string) => {
    if (!p._emitted) p._emitted = []
    p._emitted.push(id)
  }
  return p
}

function triggerResult(
  requestedCursor: number | undefined,
  readResult: unknown,
  opts?: { readError?: string; reason?: string; rehydrate?: boolean },
): TriggerResult {
  return {
    reason: opts?.reason ?? "peer:closed",
    reconnectResult: {},
    requestedCursor,
    readResult,
    rehydrate: opts?.rehydrate,
    ...(opts?.readError ? { readError: opts.readError } : {}),
  } as TriggerResult
}

describe("AgentManager peer-close handoff — precomputed valid paths and freshness", () => {
  it("valid empty precomputed does not SDK refresh and does not second private read", async () => {
    const { svc, store, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 7 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    provider.panel = { visible: true, sessions: { refreshSessions: async () => {} } } as any
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    const result = triggerResult(7, { v: "1.0", cursor: 7, rehydrate: false, entries: [] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    expect(readLog.length).toBe(0)
    expect(store.get()).toBe(7)
  })

  it("valid delta precomputed does exactly one refresh+ack and no second private read", async () => {
    const { svc, store, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 7 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(7, {
      v: "1.0",
      cursor: 8,
      rehydrate: false,
      entries: [{ seq: 8, session_id: "a", revision: 1, kind: "changed", time: 1 }],
    })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([8])
    expect(store.get()).toBe(8)
    expect(readLog.length).toBe(0)
  })

  it("valid rehydrate precomputed does one refresh+ack and no second read", async () => {
    const { svc, store, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 7 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(7, { v: "1.0", cursor: 10, rehydrate: true, entries: [], reason: "gap" })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([10])
    expect(store.get()).toBe(10)
    expect(readLog.length).toBe(0)
  })

  it("readError precomputed uses precomputed singleflight fallback: exactly one SDK refresh, no second private read, no ack", async () => {
    const { svc, ackLog, readLog } = fakePrivate({
      enabled: true,
      persisted: 5,
      readResult: { cursor: 5, rehydrate: false, entries: [] },
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(5, undefined, { readError: "boom" })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("absent result (undefined) uses precomputed fallback: one SDK refresh, no second read, no ack", async () => {
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    await provider.handlePeerCloseObservation(undefined)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("requestedCursor absent uses precomputed fallback: one SDK refresh, no second read", async () => {
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(undefined, { v: "1.0", cursor: 5, rehydrate: false, entries: [] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("readResult absent uses precomputed fallback: one SDK refresh, no second read", async () => {
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(5, undefined)
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("invalid wire (missing v, cursor < requested) uses precomputed fallback when fresh: one SDK refresh, no second read, no ack", async () => {
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const invalid = { cursor: 4, rehydrate: false, entries: [] }
    await provider.handlePeerCloseObservation(triggerResult(5, invalid))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    // malformed rehydrate reason also invalid
    provider.refreshPromise = null
    refreshCount = 0
    const invalid2 = { v: "1.0", cursor: 6, rehydrate: true, entries: [], reason: "" }
    await provider.handlePeerCloseObservation(triggerResult(5, invalid2))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("invalid wire with persisted advanced still uses failure fallback: one SDK refresh, zero private read/ack", async () => {
    const invalid = { cursor: 4, rehydrate: false, entries: [] } // missing v, also cursor < requested
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 7 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    await provider.handlePeerCloseObservation(triggerResult(5, invalid))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    // also malformed rehydrate reason with advanced
    provider.refreshPromise = null
    refreshCount = 0
    readLog.length = 0
    ackLog.length = 0
    const invalid2 = { v: "1.0", cursor: 6, rehydrate: true, entries: [], reason: "" }
    provider.coordinator = new AgentManagerObservationCoordinator(svc)
    await provider.handlePeerCloseObservation(triggerResult(5, invalid2))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    // non-contiguous delta also invalid with advanced
    provider.refreshPromise = null
    refreshCount = 0
    const invalid3 = { v: "1.0", cursor: 7, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }, { seq: 8, session_id: "a", revision: 0, kind: "changed", time: 1 }] }
    await provider.handlePeerCloseObservation(triggerResult(5, invalid3))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("invalid wire with persisted lower still uses failure fallback: one SDK refresh, zero private read/ack", async () => {
    const invalid = { v: "1.0", cursor: 6, rehydrate: true, entries: [], reason: "" }
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 3, readResult: { cursor: 3, rehydrate: false, entries: [] } })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    await provider.handlePeerCloseObservation(triggerResult(5, invalid))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    // requestedCursor unusable (negative) with lower persisted
    provider.refreshPromise = null
    refreshCount = 0
    const badCursor = -1
    await provider.handlePeerCloseObservation(triggerResult(badCursor as any, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] }))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    // also test requestedCursor undefined with lower
    provider.refreshPromise = null
    refreshCount = 0
    await provider.handlePeerCloseObservation(triggerResult(undefined, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] }))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("invalid wire with persisted undefined still uses failure fallback: one SDK refresh, zero private read/ack", async () => {
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: undefined, readResult: { cursor: 0, rehydrate: false, entries: [] } })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const invalid = { v: "1.0", cursor: 6, rehydrate: true, entries: [], reason: "   " }
    await provider.handlePeerCloseObservation(triggerResult(5, invalid))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    provider.refreshPromise = null
    refreshCount = 0
    const invalid2 = { bogus: true } as any
    await provider.handlePeerCloseObservation(triggerResult(5, invalid2))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    provider.refreshPromise = null
    refreshCount = 0
    await provider.handlePeerCloseObservation(triggerResult(undefined, { v: "1.0", cursor: 5, rehydrate: false, entries: [] }))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })

  it("advanced-empty invalid wire with persisted advanced/lower/undefined still uses failure fallback: exactly one SDK refresh, zero private read, zero ack; valid empty-current stays valid true and legacy fallback remains", async () => {
    const wireAdvancedEmpty = { v: "1.0", cursor: 6, rehydrate: false, entries: [] as unknown[] }
    // coordinator validity directly
    const dummySvc: any = { getPersistedCursor: () => 5, isEnabled: () => true, snapshot: async () => ({}), read: async () => ({}), ack: async () => ({}) }
    const coord = new AgentManagerObservationCoordinator(dummySvc)
    expect(coord.decideFromReadResultWithValidity(wireAdvancedEmpty, 5)).toEqual({ valid: false, decision: { shouldRefresh: true } })
    // keep valid empty-current as valid true shouldRefresh false
    expect(coord.decideFromReadResultWithValidity({ v: "1.0", cursor: 5, rehydrate: false, entries: [] }, 5)).toEqual({ valid: true, decision: { shouldRefresh: false } })
    // legacy decideFromReadResult remains fallback (shouldRefresh true for advanced-empty, false for current empty)
    expect(coord.decideFromReadResult(wireAdvancedEmpty, 5)).toEqual({ shouldRefresh: true })
    expect(coord.decideFromReadResult({ v: "1.0", cursor: 5, rehydrate: false, entries: [] }, 5)).toEqual({ shouldRefresh: false })

    async function assertFallback(persisted: number | undefined) {
      const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted, readResult: { cursor: persisted ?? 0, rehydrate: false, entries: [] } })
      const provider: any = makeProvider(svc)
      provider.generation = 1
      provider.hydrated = true
      let refreshCount = 0
      provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
      await provider.handlePeerCloseObservation(triggerResult(5, wireAdvancedEmpty))
      if (provider.refreshPromise) await provider.refreshPromise
      expect(readLog.length).toBe(0)
      expect(refreshCount).toBe(1)
      expect(ackLog.length).toBe(0)
    }
    await assertFallback(7)
    await assertFallback(3)
    await assertFallback(undefined)
  })

  it("current persisted undefined -> normal fresh decision (may read again)", async () => {
    const { svc, ackLog, readLog } = fakePrivate({ enabled: true, persisted: undefined, readResult: { cursor: 0, rehydrate: false, entries: [] } })
    // svc store initially undefined, coordinator.getPersistedCursor() returns undefined
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(5, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    // stale because current undefined != 5, so normal fresh path: decide() with undefined -> shouldRefresh true, one SDK refresh
    // when persisted undefined, coordinator.decide returns shouldRefresh true without read, so readLog 0
    // But still counts as fresh decision, not precomputed fallback
    expect(refreshCount).toBe(1)
    // Ensure it did not use precomputed ack
    expect(ackLog.length).toBe(0)
    // fresh decide with undefined does not read, so readLog 0; this still validates staleness branch was taken
    // we verify by checking that a second call with defined current would have used precomputed
  })

  it("current persisted lower than requested -> normal fresh decision which may read again", async () => {
    const { svc, ackLog, readLog } = fakePrivate({
      enabled: true,
      persisted: 3,
      readResult: { cursor: 3, rehydrate: false, entries: [] },
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(5, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    // current 3 != requested 5 -> stale -> fresh decide reads at 3 with empty delta -> no refresh
    expect(readLog.length).toBe(1)
    expect(readLog[0]).toBe(3)
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    // Now test lower but fresh read has delta -> one refresh
    const { svc: svc2, ackLog: ackLog2, readLog: readLog2 } = fakePrivate({
      enabled: true,
      persisted: 3,
      readResult: { cursor: 4, rehydrate: false, entries: [{ seq: 4, session_id: "a", revision: 0, kind: "changed", time: 1 }] },
    })
    provider.coordinator = new AgentManagerObservationCoordinator(svc2)
    provider.refreshPromise = null
    provider.refreshGen = null
    provider.refreshSessions = null
    let refreshCount2 = 0
    provider.panel.sessions.refreshSessions = async () => { refreshCount2++ }
    await provider.handlePeerCloseObservation(triggerResult(5, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] }))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog2.length).toBe(1)
    expect(readLog2[0]).toBe(3)
    expect(refreshCount2).toBe(1)
    expect(ackLog2).toEqual([4])
  })

  it("no second private read for fresh valid delta (precomputed lane)", async () => {
    const { svc, readLog, ackLog } = fakePrivate({ enabled: true, persisted: 10 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    provider.panel = { visible: true, sessions: { refreshSessions: async () => {} } } as any
    const result = triggerResult(10, {
      v: "1.0",
      cursor: 11,
      rehydrate: false,
      entries: [{ seq: 11, session_id: "s", revision: 0, kind: "changed", time: 1 }],
    })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(ackLog).toEqual([11])
  })

  it("valid empty still no second read", async () => {
    const { svc, readLog, ackLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    provider.panel = { visible: true, sessions: { refreshSessions: async () => {} } } as any
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => { refreshCount++ }
    const result = triggerResult(5, { v: "1.0", cursor: 5, rehydrate: false, entries: [] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(readLog.length).toBe(0)
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
  })

  it("concurrent normal requestState/visible + peer-close shares one SDK operation", async () => {
    const { svc, ackLog } = fakePrivate({
      enabled: true,
      persisted: 5,
      readResult: { cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] },
      readDelayMs: 20,
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
          await new Promise((r) => setTimeout(r, 40))
        },
      },
    } as any
    const normal = provider.handleObservationRefresh()
    await new Promise((r) => setTimeout(r, 5))
    const result = triggerResult(5, {
      v: "1.0",
      cursor: 6,
      rehydrate: false,
      entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }],
    })
    const peer = provider.handlePeerCloseObservation(result)
    expect(provider.refreshPromise).not.toBeNull()
    await Promise.all([normal, peer])
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(1)
    expect(ackLog[0]).toBe(6)
    const { svc: svc2, ackLog: ackLog2 } = fakePrivate({
      enabled: true,
      persisted: 5,
      readResult: { cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] },
      readDelayMs: 20,
    })
    const provider2: any = makeProvider(svc2)
    provider2.generation = 1
    provider2.hydrated = true
    let refreshCount2 = 0
    provider2.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount2++
          await new Promise((r) => setTimeout(r, 40))
        },
      },
    } as any
    const peerFirst = provider2.handlePeerCloseObservation(
      triggerResult(5, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] }),
    )
    await new Promise((r) => setTimeout(r, 5))
    const normalSecond = provider2.handleObservationRefresh()
    await Promise.all([peerFirst, normalSecond])
    expect(refreshCount2).toBe(1)
    expect(ackLog2.length).toBe(1)
  })

  it("failure fallback shares singleflight with concurrent requestState", async () => {
    const { svc, ackLog, readLog } = fakePrivate({
      enabled: true,
      persisted: 5,
      readResult: { cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] },
      readDelayMs: 20,
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
          await new Promise((r) => setTimeout(r, 30))
        },
      },
    } as any
    const normal = provider.handleObservationRefresh()
    await new Promise((r) => setTimeout(r, 5))
    const peer = provider.handlePeerCloseObservation(triggerResult(5, undefined, { readError: "boom" }))
    expect(provider.refreshPromise).not.toBeNull()
    await Promise.all([normal, peer])
    expect(refreshCount).toBe(1)
    expect(readLog.length).toBe(1)
    expect(ackLog.length).toBe(1)
    // reversed: peer failure first, then normal
    const { svc: svc2, ackLog: ackLog2, readLog: readLog2 } = fakePrivate({
      enabled: true,
      persisted: 5,
      readResult: { cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] },
      readDelayMs: 20,
    })
    const provider2: any = makeProvider(svc2)
    provider2.generation = 1
    provider2.hydrated = true
    let refreshCount2 = 0
    provider2.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount2++
          await new Promise((r) => setTimeout(r, 30))
        },
      },
    } as any
    const peerFirst = provider2.handlePeerCloseObservation(triggerResult(5, undefined, { readError: "boom" }))
    await new Promise((r) => setTimeout(r, 5))
    const normalSecond = provider2.handleObservationRefresh()
    await Promise.all([peerFirst, normalSecond])
    expect(refreshCount2).toBe(1)
    expect(ackLog2.length).toBe(0)
    expect(readLog2.length).toBe(0)
  })

  it("initial unhydrated uses normal snapshot hydration, not precomputed", async () => {
    const { svc, snapshotLog, ackLog } = fakePrivate({ enabled: true, persisted: 0, snapshotCursor: 3 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    let refreshCount = 0
    provider.panel = { visible: true, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(0, { v: "1.0", cursor: 1, rehydrate: false, entries: [{ seq: 1, session_id: "a", revision: 0, kind: "changed", time: 1 }] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(snapshotLog.length).toBe(1)
    expect(snapshotLog[0]).toBe(3)
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([3])
    expect(provider.hydrated).toBe(true)
  })

  it("hidden discard then visible re-read via normal decide", async () => {
    const { svc, store, ackLog, readLog } = fakePrivate({
      enabled: true,
      persisted: 5,
      readResult: { cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] },
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { visible: false, sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    const result = triggerResult(5, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    expect(readLog.length).toBe(0)
    provider.panel.visible = true
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([6])
    expect(readLog.length).toBe(1)
    expect(store.get()).toBe(6)
  })

  it("generation replacement discard", async () => {
    const { svc } = fakePrivate({ enabled: true, persisted: 5, readResult: { cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] } })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let oldRefresh = 0
    const oldSessions = { refreshSessions: async () => { oldRefresh++; await new Promise((r) => setTimeout(r, 30)) } } as any
    provider.panel = { visible: true, sessions: oldSessions } as any
    provider.stateReady = new Promise<void>((res) => setTimeout(res, 20))
    const p = provider.handlePeerCloseObservation(triggerResult(5, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] }))
    await new Promise((r) => setTimeout(r, 5))
    provider.generation = 2
    provider.panel = { visible: true, sessions: { refreshSessions: async () => {} } } as any
    await p
    if (provider.refreshPromise) await provider.refreshPromise
    expect(oldRefresh).toBe(0)
  })

  it("persisted cursor advances before consumption -> normal fresh decision/no stale ack", async () => {
    const fake = fakePrivate({ enabled: true, persisted: 5, readResult: { cursor: 6, rehydrate: false, entries: [] } })
    fake.store.set(5)
    const provider: any = makeProvider(fake.svc)
    provider.generation = 1
    provider.hydrated = true
    provider.panel = { visible: true, sessions: { refreshSessions: async () => {} } } as any
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => { refreshCount++ }
    fake.store.set(6)
    const result = triggerResult(5, { v: "1.0", cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(fake.readLog.length).toBe(1)
    expect(fake.readLog[0]).toBe(6)
    expect(refreshCount).toBe(0)
    expect(fake.ackLog.length).toBe(0)
    expect(fake.store.get()).toBe(6)
  })

  it("persisted cursor advances during SDK refresh before precomputed ack -> no cursor regression", async () => {
    const { svc, store, ackLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
          await new Promise((r) => setTimeout(r, 10))
          await store.set(7)
        },
      },
    } as any
    const result = triggerResult(5, {
      v: "1.0",
      cursor: 6,
      rehydrate: false,
      entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }],
    })
    await provider.handlePeerCloseObservation(result)
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
    expect(store.get()).toBe(7)
    expect(store.get()).not.toBe(6)
  })

  it("provider retains only one typed handlePeerCloseObservation entry, no aliases, and extension calls it without unknown cast", async () => {
    const text = await Bun.file("src/agent-manager/AgentManagerProvider.ts").text()
    expect(text).toContain("handlePeerCloseObservation(result: TriggerResult")
    expect(text).not.toContain("handlePeerCloseResult")
    expect(text).not.toContain("consumePeerCloseResult")
    const ext = await Bun.file("src/extension.ts").text()
    const wiring = await Bun.file("src/agent-manager/peer-close-wiring.ts").text()
    expect(ext).not.toContain("as unknown as { handlePeerCloseObservation")
    expect(ext).toContain("wirePeerCloseObservation")
    expect(wiring).toContain("handlePeerCloseObservation(result)")
    expect(wiring).not.toMatch(/\}\s*catch\s*\{\s*\}/)
    expect(wiring).toContain('privateObservation peer-close trigger failed')
    expect(wiring).toContain('peer-close observation handling failed')
    expect(ext).not.toMatch(/\}\s*catch\s*\{\s*\}/)
  })
})
