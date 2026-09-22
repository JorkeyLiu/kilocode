import { describe, it, expect } from "bun:test"
import { AgentManagerObservationCoordinator } from "../../src/agent-manager/observation-coordinator"
import { InMemoryCursorStore } from "../../src/private-worker/observation-cursor-store"
import { AgentManagerProvider } from "../../src/agent-manager/AgentManagerProvider"
import { OBSERVATION_NOTIFICATION } from "../../src/private-worker/observation"

function fakePrivate(opts: {
  enabled: boolean
  persisted?: number
  ackFails?: boolean
  ackLog?: number[]
  readLog?: number[]
  readImpl?: (cur: number) => Promise<unknown>
}) {
  const store = new InMemoryCursorStore()
  if (opts.persisted !== undefined) store.set(opts.persisted)
  const ackLog: number[] = opts.ackLog ?? []
  const readLog: number[] = opts.readLog ?? []
  const svc: any = {
    isEnabled: () => opts.enabled,
    isStarted: () => true,
    getPersistedCursor: () => store.get(),
    setPersistedCursor: (c: number) => store.set(c),
    snapshot: async () => ({ v: "1.0", cursor: 5, snapshot: {} }),
    read: async (cur: number) => {
      if (opts.readImpl) return opts.readImpl(cur)
      readLog.push(cur)
      return { v: "1.0", cursor: cur, rehydrate: false, entries: [] }
    },
    ack: async (c: number) => {
      ackLog.push(c)
      if (opts.ackFails) throw new Error("ack fail")
      await store.set(c)
      return { v: "1.0", cursor: c }
    },
  }
  // wrap read to capture log when readImpl provided
  const origRead = svc.read
  svc.read = async (cur: number) => {
    if (opts.readImpl) {
      readLog.push(cur)
      return opts.readImpl(cur)
    }
    return origRead(cur)
  }
  return { svc, store, ackLog, readLog }
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
  p.pendingChangedAckCursor = undefined
  p.pendingChangedBaseline = undefined
  p.pendingChangedTrailing = false
  p.coordinator = new AgentManagerObservationCoordinator(svc)
  p.stateReady = Promise.resolve()
  p.log = () => {}
  p.statsPoller = { setVisible: () => {}, stop: () => {}, setEnabled: () => {} } as any
  p.visiblePresence = { clear: () => {}, flush: () => {} } as any
  p.catalogUnsub = undefined
  p.accumulatedCatalog = undefined
  p.catalogTombstone = new Set()
  p.terminalManager = { syncOnSessionSwitch: () => {} } as any
  p.pushState = () => {}
  p.postToWebview = () => {}
  p.schedulePersist = () => {}
  p.waitForStateReady = async (_ctx: string) => {
    if (!p.stateReady) return
    await p.stateReady.catch(() => {})
  }
  p.trackOwned = <T>(op: Promise<T>): Promise<T> => {
    if (!p.ownedOps) p.ownedOps = new Set()
    const set = p.ownedOps as Set<Promise<unknown>>
    const key = op as unknown as Promise<unknown>
    set.add(key)
    const done = () => set.delete(key)
    void Promise.resolve(op).then(done, done)
    return op
  }
  p.ownedOps = new Set()
  p.ownedGen = 0
  return p
}

async function waitForRefresh(p: any, timeout = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (!p.refreshPromise) {
      await new Promise((r) => setTimeout(r, 10))
      if (!p.refreshPromise) return
    } else {
      try {
        await p.refreshPromise
      } catch {}
      return
    }
  }
}

describe("AgentManager observation burst cursor-integrity", () => {
  it("(a) valid single generation notification results in one read then refresh then ack", async () => {
    const readLog: number[] = []
    const ackLog: number[] = []
    const { svc, store } = fakePrivate({
      enabled: true,
      persisted: 10,
      readLog,
      ackLog,
      readImpl: async (cur: number) => ({
        v: "1.0",
        cursor: 11,
        rehydrate: false,
        entries: [{ seq: 11, session_id: "ses_a", revision: 1, kind: "generation", time: 1 }],
      }),
    })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    let order: string[] = []
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          order.push("refresh")
          refreshCount++
        },
      },
    } as any
    // wrap read to capture order
    const origRead = svc.read
    svc.read = async (cur: number) => {
      order.push("read")
      return origRead(cur)
    }
    const origAck = svc.ack
    svc.ack = async (c: number) => {
      order.push("ack")
      return origAck(c)
    }

    const note = {
      v: "1.0",
      cursor: 11,
      entries: [{ seq: 11, session_id: "ses_a", revision: 1, kind: "generation", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 20))
    await waitForRefresh(provider)
    expect(refreshCount).toBe(1)
    expect(readLog).toEqual([10])
    expect(ackLog).toEqual([11])
    expect(store.get()).toBe(11)
    // order must be read -> refresh -> ack
    expect(order).toEqual(["read", "refresh", "ack"])
  })

  it("(a) valid single changed notification results in one read then refresh then ack", async () => {
    const readLog: number[] = []
    const ackLog: number[] = []
    const { svc, store } = fakePrivate({
      enabled: true,
      persisted: 7,
      readLog,
      ackLog,
      readImpl: async (cur: number) => ({
        v: "1.0",
        cursor: 8,
        rehydrate: false,
        entries: [{ seq: 8, session_id: "ses_a", revision: 1, kind: "changed", time: 1 }],
      }),
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
        },
      },
    } as any
    const note = {
      v: "1.0",
      cursor: 8,
      entries: [{ seq: 8, session_id: "ses_a", revision: 1, kind: "changed", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 20))
    await waitForRefresh(provider)
    expect(refreshCount).toBe(1)
    expect(readLog).toEqual([7])
    expect(ackLog).toEqual([8])
    expect(store.get()).toBe(8)
  })

  it("(b) burst with seq 11 then 13 from baseline 10 causes one read whose gap/rehydrate decision prevents direct ack 13", async () => {
    const readLog: number[] = []
    const ackLog: number[] = []
    const { svc, store } = fakePrivate({
      enabled: true,
      persisted: 10,
      readLog,
      ackLog,
      // Simulate gap: read from baseline 10 returns entries with missing seq 12 -> invalid -> fallback no ack, but shouldRefresh true
      readImpl: async (cur: number) => ({
        v: "1.0",
        cursor: 13,
        rehydrate: false,
        entries: [
          { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
          // missing 12
          { seq: 13, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
        ],
      }),
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
        },
      },
    } as any
    const n1 = {
      v: "1.0",
      cursor: 11,
      entries: [{ seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 }],
    }
    // Second notification has gap: seq 13 from baseline 10 missing 12 -> valid notification shape would be invalid, but we still send it as burst signal
    // For this test, make second notification itself valid contiguous from baseline 10 via coalesced entries to ensure handleObservationChanged accepts it and coalesces max to 13
    const n2 = {
      v: "1.0",
      cursor: 13,
      entries: [
        { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
        { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
        { seq: 13, session_id: "ses_c", revision: 1, kind: "changed", time: 3 },
      ],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n1)
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n2)
    await new Promise((r) => setTimeout(r, 20))
    await waitForRefresh(provider)
    // Burst must coalesce to one refresh+one read from original baseline 10
    expect(refreshCount).toBe(1)
    expect(readLog).toEqual([10])
    // Gap in read result must take existing rehydrate fallback: valid false => shouldRefresh true with no ack, so no direct ack of notification max 13
    expect(ackLog).toEqual([])
    expect(store.get()).toBe(10)
    // Now verify rehydrate variant also prevents direct ack: rehydrate true should ack via read cursor, not via pending max alone
    // Reset for rehydrate case
    const readLog2: number[] = []
    const ackLog2: number[] = []
    let refreshCount2 = 0
    const { svc: svc2, store: store2 } = fakePrivate({
      enabled: true,
      persisted: 10,
      readLog: readLog2,
      ackLog: ackLog2,
      readImpl: async (cur: number) => ({
        v: "1.0",
        cursor: 13,
        rehydrate: true,
        reason: "gap",
        entries: [],
      }),
    })
    const provider2: any = makeProvider(svc2)
    provider2.generation = 1
    provider2.hydrated = true
    provider2.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount2++
        },
      },
    } as any
    provider2.handleObservationChanged(OBSERVATION_NOTIFICATION, n1)
    provider2.handleObservationChanged(OBSERVATION_NOTIFICATION, n2)
    await new Promise((r) => setTimeout(r, 20))
    await waitForRefresh(provider2)
    expect(refreshCount2).toBe(1)
    expect(readLog2).toEqual([10])
    // rehydrate valid => shouldRefresh true with ack via read cursor (13) - still via read, not direct pending max without validation
    // but this demonstrates read-backed ack; the previous invalid case already proved gap prevents direct ack
    expect(ackLog2).toEqual([13])
    expect(store2.get()).toBe(13)
  })

  it("(c) contiguous multi-event burst acks read cursor only", async () => {
    const readLog: number[] = []
    const ackLog: number[] = []
    const { svc, store } = fakePrivate({
      enabled: true,
      persisted: 10,
      readLog,
      ackLog,
      readImpl: async (cur: number) => ({
        v: "1.0",
        cursor: 12,
        rehydrate: false,
        entries: [
          { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
          { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
        ],
      }),
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
          await new Promise((r) => setTimeout(r, 20))
        },
      },
    } as any
    const n1 = {
      v: "1.0",
      cursor: 11,
      entries: [{ seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 }],
    }
    const n2 = {
      v: "1.0",
      cursor: 12,
      entries: [
        { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
        { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
      ],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n1)
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n2)
    await new Promise((r) => setTimeout(r, 15))
    expect(provider.refreshPromise).not.toBeNull()
    await waitForRefresh(provider, 1000)
    expect(refreshCount).toBe(1)
    expect(readLog).toEqual([10])
    expect(ackLog).toEqual([12])
    expect(store.get()).toBe(12)
  })

  it("(d) invalid notification remains no read/no ack", async () => {
    const readLog: number[] = []
    const ackLog: number[] = []
    const { svc, store } = fakePrivate({ enabled: true, persisted: 5, readLog, ackLog })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
        },
      },
    } as any
    const badCases: unknown[] = [
      { v: "9.9", cursor: 6, entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }] },
      { v: "1.0", cursor: 6, entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "bogus", time: 1 }] },
      { v: "1.0", cursor: "6" as unknown, entries: [] },
      null,
      { v: "1.0", cursor: 6, entries: [{ seq: 7, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }] },
    ]
    for (const bad of badCases) {
      readLog.length = 0
      ackLog.length = 0
      refreshCount = 0
      provider.handleObservationChanged(OBSERVATION_NOTIFICATION, bad)
      await new Promise((r) => setTimeout(r, 15))
      expect(refreshCount).toBe(0)
      expect(readLog.length).toBe(0)
      expect(ackLog.length).toBe(0)
      expect(store.get()).toBe(5)
      expect(provider.refreshPromise).toBeNull()
    }
  })

  it("(e) late valid notification during read/refresh flight schedules exactly one trailing cycle from then-current cursor", async () => {
    const readLog: number[] = []
    const ackLog: number[] = []
    const store = new InMemoryCursorStore()
    store.set(10)
    // Deferreds for first flight
    let resolveFirstRead: (v: unknown) => void = () => {}
    let resolveFirstRefresh: () => void = () => {}
    const firstReadPromise = new Promise<unknown>((r) => (resolveFirstRead = r))
    const firstRefreshPromise = new Promise<void>((r) => (resolveFirstRefresh = r))
    const svc: any = {
      isEnabled: () => true,
      isStarted: () => true,
      getPersistedCursor: () => store.get(),
      snapshot: async () => ({ v: "1.0", cursor: 5, snapshot: {} }),
      read: async (cur: number) => {
        readLog.push(cur)
        if (cur === 10) {
          // first cycle: wait for deferred, then return cursor 12 contiguous
          await firstReadPromise
          return {
            v: "1.0",
            cursor: 12,
            rehydrate: false,
            entries: [
              { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
              { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
            ],
          }
        }
        if (cur === 12) {
          return {
            v: "1.0",
            cursor: 13,
            rehydrate: false,
            entries: [{ seq: 13, session_id: "ses_c", revision: 1, kind: "changed", time: 3 }],
          }
        }
        return { v: "1.0", cursor: cur, rehydrate: false, entries: [] }
      },
      ack: async (c: number) => {
        ackLog.push(c)
        await store.set(c)
        return { v: "1.0", cursor: c }
      },
    }
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
          if (refreshCount === 1) await firstRefreshPromise
        },
      },
    } as any

    const n1 = {
      v: "1.0",
      cursor: 12,
      entries: [
        { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
        { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
      ],
    }
    const n2 = {
      v: "1.0",
      cursor: 13,
      entries: [
        { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
        { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
        { seq: 13, session_id: "ses_c", revision: 1, kind: "changed", time: 3 },
      ],
    }
    // First notification starts flight
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n1)
    await new Promise((r) => setTimeout(r, 20))
    // First read should have started from baseline 10 and be pending
    expect(readLog).toEqual([10])
    expect(refreshCount).toBe(0)
    expect(provider.refreshPromise).not.toBeNull()

    // Second valid notification arrives while first read/refresh is in flight
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n2)
    // Invalid notification during flight must not create extra trailing
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, { v: "9.9", cursor: 14, entries: [] } as unknown)
    await new Promise((r) => setTimeout(r, 10))
    // Still only one read started, trailing not yet started
    expect(readLog).toEqual([10])
    expect(refreshCount).toBe(0)

    // Release first read, then first refresh
    resolveFirstRead(undefined)
    // Give read a tick to proceed to refresh
    await new Promise((r) => setTimeout(r, 10))
    resolveFirstRefresh()
    // Wait for first flight to settle and trailing to start+finish
    const start = Date.now()
    while (Date.now() - start < 1000) {
      if (refreshCount === 2 && readLog.length === 2 && ackLog.length === 2) break
      await new Promise((r) => setTimeout(r, 10))
      // also wait for any trailing refreshPromise to settle
      if (provider.refreshPromise) {
        try {
          await Promise.race([provider.refreshPromise, new Promise((r) => setTimeout(r, 20))])
        } catch {}
      }
    }
    // Poll trailing completion
    for (let i = 0; i < 20; i++) {
      if (provider.refreshPromise) {
        try {
          await provider.refreshPromise
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 10))
      if (readLog.length === 2 && ackLog.length === 2 && refreshCount === 2) break
    }

    expect(refreshCount).toBe(2)
    expect(readLog).toEqual([10, 12])
    expect(ackLog).toEqual([12, 13])
    expect(store.get()).toBe(13)
    // No third read, no direct notification-max ack without read
    expect(readLog.length).toBe(2)
  })

  it("(e) coalesces arbitrarily many late notifications to one trailing cycle", async () => {
    const readLog: number[] = []
    const ackLog: number[] = []
    const store = new InMemoryCursorStore()
    store.set(10)
    let resolveFirstRead: (v: unknown) => void = () => {}
    let resolveFirstRefresh: () => void = () => {}
    const firstReadPromise = new Promise<unknown>((r) => (resolveFirstRead = r))
    const firstRefreshPromise = new Promise<void>((r) => (resolveFirstRefresh = r))
    const svc: any = {
      isEnabled: () => true,
      isStarted: () => true,
      getPersistedCursor: () => store.get(),
      snapshot: async () => ({ v: "1.0", cursor: 5, snapshot: {} }),
      read: async (cur: number) => {
        readLog.push(cur)
        if (cur === 10) {
          await firstReadPromise
          return {
            v: "1.0",
            cursor: 12,
            rehydrate: false,
            entries: [
              { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
              { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
            ],
          }
        }
        if (cur === 12) {
          return {
            v: "1.0",
            cursor: 13,
            rehydrate: false,
            entries: [{ seq: 13, session_id: "ses_c", revision: 1, kind: "changed", time: 3 }],
          }
        }
        return { v: "1.0", cursor: cur, rehydrate: false, entries: [] }
      },
      ack: async (c: number) => {
        ackLog.push(c)
        await store.set(c)
        return { v: "1.0", cursor: c }
      },
    }
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
          if (refreshCount === 1) await firstRefreshPromise
        },
      },
    } as any
    const n1 = {
      v: "1.0",
      cursor: 12,
      entries: [
        { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
        { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
      ],
    }
    const mkLate = (seq: number) => ({
      v: "1.0",
      cursor: 13,
      entries: [
        { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
        { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
        { seq: 13, session_id: "ses_c", revision: 1, kind: "changed", time: 3 },
      ],
    })
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n1)
    await new Promise((r) => setTimeout(r, 20))
    expect(readLog).toEqual([10])
    // Three late notifications while first flight in progress
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, mkLate(13))
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, mkLate(13))
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, mkLate(13))
    await new Promise((r) => setTimeout(r, 10))
    expect(readLog).toEqual([10])
    resolveFirstRead(undefined)
    await new Promise((r) => setTimeout(r, 10))
    resolveFirstRefresh()
    for (let i = 0; i < 30; i++) {
      if (provider.refreshPromise) {
        try {
          await provider.refreshPromise
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 10))
      if (readLog.length === 2 && refreshCount === 2) break
    }
    expect(refreshCount).toBe(2)
    expect(readLog).toEqual([10, 12])
    expect(ackLog).toEqual([12, 13])
    expect(store.get()).toBe(13)
  })
})
