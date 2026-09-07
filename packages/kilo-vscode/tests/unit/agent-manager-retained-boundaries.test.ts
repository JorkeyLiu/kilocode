import { describe, it, expect } from "bun:test"
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
  p.terminalManager = { syncOnSessionSwitch: () => {} } as any
  p.pushState = () => {}
  p.postToWebview = () => {}
  p.schedulePersist = () => {}
  p.waitForStateReady = async (_ctx: string) => {
    if (!p.stateReady) return
    await p.stateReady.catch(() => {})
  }
  p.emitActiveSessionChanged = (id: string) => {
    // record for test if needed
    if (!p._emitted) p._emitted = []
    p._emitted.push(id)
  }
  // Provide real handleObservationRefresh and triggerObservationRefresh from prototype
  // They are already on prototype, so instance will use them via prototype chain unless overridden.
  // Ensure we don't override them.
  return p
}

describe("AgentManager retained-webview lifecycle boundaries (visibility + session switch)", () => {
  it("hidden visibility does not refresh; visible with empty delta does not SDK fetch", async () => {
    const { svc, ackLog } = fakePrivate({ enabled: true, persisted: 7, readResult: { cursor: 7, rehydrate: false, entries: [] } })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    // simulate production attachPanel callback: hidden -> no refresh
    const onVisible = (visible: boolean) => {
      if (visible) provider.triggerObservationRefresh()
    }
    onVisible(false)
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    // visible with empty delta -> decide says no refresh, no ack
    onVisible(true)
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
  })

  it("visible with new contiguous delta triggers exactly one refresh+ack", async () => {
    const { svc, store, ackLog } = fakePrivate({
      enabled: true,
      persisted: 7,
      readResult: { cursor: 8, rehydrate: false, entries: [{ seq: 8, session_id: "a", revision: 1, kind: "changed", time: 1 }] },
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([8])
    expect(store.get()).toBe(8)
  })

  it("rapid visible + requestState share one singleflight", async () => {
    const { svc, ackLog } = fakePrivate({ enabled: true, persisted: 5, readResult: { cursor: 6, rehydrate: false, entries: [{ seq: 6, session_id: "a", revision: 0, kind: "changed", time: 1 }] } })
    // add delay to read/persist to widen race
    const origRead = svc.read
    svc.read = async (c: number) => {
      await new Promise((r) => setTimeout(r, 30))
      return origRead(c)
    }
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      sessions: {
        refreshSessions: async () => {
          refreshCount++
          await new Promise((r) => setTimeout(r, 40))
        },
      },
    } as any
    provider.pushState = () => {}
    provider.postToWebview = () => {}
    // simulate visible callback and requestState's trigger concurrently — both go through waitForStateReady then singleflight
    provider.triggerObservationRefresh()
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 15))
    const shared = provider.refreshPromise
    expect(shared).toBeDefined()
    expect(shared).not.toBeNull()
    // second call before settle must have reused same promise
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 5))
    expect(provider.refreshPromise).toBe(shared)
    if (shared) await shared
    await new Promise((r) => setTimeout(r, 10))
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([6])
  })

  it("active session switch with delta triggers one refresh+ack and empty delta skips", async () => {
    // delta case
    const { svc, ackLog, store } = fakePrivate({
      enabled: true,
      persisted: 10,
      readResult: { cursor: 11, rehydrate: false, entries: [{ seq: 11, session_id: "s", revision: 0, kind: "changed", time: 1 }] },
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    provider.stateReady = Promise.resolve()
    // stub schedulePersist already, add real tabOrder etc
    provider.activeSessionId = "old"
    provider.managedSessions = new Map([["old", { id: "old" }], ["new", { id: "new" }]])
    provider.tabOrder = { local: ["old", "new"] }
    // call loadMessages via prototype handler: we tested prev logic via direct call to trigger
    // simulate loadMessages handler path: update, emit, persist, then trigger if changed
    const prev = provider.activeSessionId
    provider.activeSessionId = "new"
    provider.emitActiveSessionChanged("new")
    provider.schedulePersist()
    if (prev !== "new") provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([11])
    expect(store.get()).toBe(11)

    // empty delta case should skip
    const { svc: svc2, ackLog: ackLog2 } = fakePrivate({ enabled: true, persisted: 11, readResult: { cursor: 11, rehydrate: false, entries: [] } })
    provider.coordinator = new AgentManagerObservationCoordinator(svc2)
    // reset for second switch
    provider.activeSessionId = "new"
    let refreshCount2 = 0
    provider.panel = { sessions: { refreshSessions: async () => { refreshCount2++ } } } as any
    provider.refreshPromise = null
    const prev2 = provider.activeSessionId
    provider.activeSessionId = "old"
    provider.emitActiveSessionChanged("old")
    if (prev2 !== "old") provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount2).toBe(0)
    expect(ackLog2.length).toBe(0)
    // same id should not trigger even with delta available (guard)
    const { svc: svc3, ackLog: ackLog3 } = fakePrivate({ enabled: true, persisted: 11, readResult: { cursor: 12, rehydrate: false, entries: [{ seq: 12, session_id: "x", revision: 0, kind: "changed", time: 1 }] } })
    provider.coordinator = new AgentManagerObservationCoordinator(svc3)
    provider.activeSessionId = "old"
    let refreshCount3 = 0
    provider.panel = { sessions: { refreshSessions: async () => { refreshCount3++ } } } as any
    provider.refreshPromise = null
    const prev3 = provider.activeSessionId
    provider.activeSessionId = "old" // same
    // emission still happens in real code but trigger guarded
    provider.emitActiveSessionChanged("old")
    if (prev3 !== "old") provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount3).toBe(0)
    expect(ackLog3.length).toBe(0)
  })

  it("panel replacement generation remains safe (old visible does not ack new)", async () => {
    const { svc } = fakePrivate({ enabled: true, snapshotCursor: 7, snapshotDelayMs: 40 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = false
    let oldRefresh = 0
    let newRefresh = 0
    const oldSessions = {
      refreshSessions: async () => {
        oldRefresh++
        await new Promise((r) => setTimeout(r, 60))
      },
    } as any
    const newSessions = {
      refreshSessions: async () => {
        newRefresh++
      },
    } as any
    provider.panel = { sessions: oldSessions } as any
    const oldPromise = provider.handleObservationRefresh()
    await new Promise((r) => setTimeout(r, 10))
    provider.generation = 2
    provider.hydrated = false
    provider.panel = { sessions: newSessions } as any
    const newPromise = provider.handleObservationRefresh()
    expect(newPromise).not.toBe(oldPromise)
    await oldPromise
    expect(provider.hydrated).toBe(false)
    expect(oldRefresh).toBe(0)
    expect(newRefresh).toBe(0)
    await newPromise
    expect(provider.hydrated).toBe(true)
    expect(newRefresh).toBe(1)
    expect(oldRefresh).toBe(0)
  })

  it("peer closed/read fails fallback performs exactly one SDK refresh and no ack", async () => {
    const { svc, ackLog } = fakePrivate({ enabled: true, persisted: 5, readFails: true })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = { sessions: { refreshSessions: async () => { refreshCount++ } } } as any
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount).toBe(1)
    expect(ackLog.length).toBe(0)
  })
})
