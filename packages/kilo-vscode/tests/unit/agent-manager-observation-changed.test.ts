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
  storeFailsOnAck?: boolean
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
      readLog.push(cur)
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
      // give a tick for scheduled async
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

describe("AgentManager observation/changed bounded consumer", () => {
  it("valid changed notification triggers exactly one refresh and ack", async () => {
    const { svc, store, ackLog } = fakePrivate({ enabled: true, persisted: 7 })
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
    expect(ackLog).toEqual([8])
    expect(store.get()).toBe(8)
  })

  it("valid deleted notification triggers exactly one refresh and ack", async () => {
    const { svc, store, ackLog } = fakePrivate({ enabled: true, persisted: 3 })
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
      cursor: 4,
      entries: [{ seq: 4, session_id: "ses_b", revision: 0, kind: "deleted", time: 2 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 20))
    await waitForRefresh(provider)
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([4])
    expect(store.get()).toBe(4)
  })

  it("burst multiple valid notifications coalesce to one refresh with latest cursor", async () => {
    const { svc, store, ackLog } = fakePrivate({ enabled: true, persisted: 10 })
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
    const n1 = {
      v: "1.0",
      cursor: 11,
      entries: [{ seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 }],
    }
    // Second notification includes earlier delta plus new to stay contiguous against same persisted 10
    const n2 = {
      v: "1.0",
      cursor: 12,
      entries: [
        { seq: 11, session_id: "ses_a", revision: 1, kind: "changed", time: 1 },
        { seq: 12, session_id: "ses_b", revision: 1, kind: "changed", time: 2 },
      ],
    }
    // Simulate burst: second arrives while first's refresh is in flight (or before singleflight check)
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n1)
    // invoke second immediately before first's async wait resolves
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n2)
    await new Promise((r) => setTimeout(r, 15))
    // At this point one refresh should be in flight
    expect(provider.refreshPromise).not.toBeNull()
    await waitForRefresh(provider, 1000)
    expect(refreshCount).toBe(1)
    // Latest cursor should be acked (12) not just 11
    expect(ackLog).toEqual([12])
    expect(store.get()).toBe(12)
  })

  it("same burst with three notifications still one refresh", async () => {
    const { svc, ackLog } = fakePrivate({ enabled: true, persisted: 20 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
          await new Promise((r) => setTimeout(r, 25))
        },
      },
    } as any
    const mk = (seq: number) => ({
      v: "1.0",
      cursor: seq,
      entries: [{ seq, session_id: `ses_${seq}`, revision: 1, kind: "changed", time: seq }],
    })
    // Need sequential cursors: persisted 20, so first must be 21, second 21? Actually each notification individually expects persisted 20, but second with cursor 22 would need gaps. For burst coalescing test, we simulate notifications that are each valid against persisted 20 but have different cursors - only latest will be considered after merging pending. However second with cursor 22 would be gap relative to persisted 20 if entries only contains seq 22 missing 21. So we need to make burst where each notification is individually valid but burst pending picks latest. To keep valid, make each notification have single entry with seq matching cursor, but persisted is 20, so valid cursors are 21,22 etc. If we send n1 with cursor 21, then pending=21. n2 with cursor 22 would be validated against same persisted 20 but would require entries [21,22] to be contiguous. So n2 with single entry 22 would be invalid. For burst test we can instead send same cursor duplicate or send second that is later but with pending logic we update to max - however validation for second will fail if gap. To keep burst realistic, simulate two notifications that arrive with same cursor 21 (duplicate) or with sequential entries covering both. Simpler: send two identical valid notifications with same cursor 21.
    const n1 = mk(21)
    const n2 = mk(21)
    const n3 = mk(21)
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n1)
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n2)
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, n3)
    await new Promise((r) => setTimeout(r, 15))
    await waitForRefresh(provider, 1000)
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([21])
  })

  it("invalid version does not ack and does not pollute cursor and no refresh", async () => {
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
        },
      },
    } as any
    const bad = {
      v: "9.9",
      cursor: 6,
      entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, bad)
    await new Promise((r) => setTimeout(r, 30))
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    expect(store.get()).toBe(5)
  })

  it("invalid entries/kind/revision/time/seq not ack", async () => {
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
        },
      },
    } as any
    const cases: unknown[] = [
      { v: "1.0", cursor: 6, entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "bogus", time: 1 }] },
      { v: "1.0", cursor: 6, entries: [{ seq: 6, session_id: "", revision: 0, kind: "changed", time: 1 }] },
      { v: "1.0", cursor: 6, entries: [{ seq: 6, session_id: "ses_a", revision: -1, kind: "changed", time: 1 }] },
      { v: "1.0", cursor: 6, entries: [{ seq: 0, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }] },
      { v: "1.0", cursor: 6, entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: NaN }] },
      { v: "1.0", cursor: "6" as unknown, entries: [] },
      { v: "1.0", cursor: 6, entries: "not-array" as unknown },
      null,
      { v: "1.0", cursor: 6, entries: [{ seq: 7, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }] }, // seq > cursor
    ]
    for (const bad of cases) {
      refreshCount = 0
      ackLog.length = 0
      provider.handleObservationChanged(OBSERVATION_NOTIFICATION, bad)
      await new Promise((r) => setTimeout(r, 15))
      expect(refreshCount).toBe(0)
      expect(ackLog.length).toBe(0)
      expect(store.get()).toBe(5)
    }
  })

  it("out-of-order cursor not ack and not pollute", async () => {
    const { svc, store, ackLog } = fakePrivate({ enabled: true, persisted: 10 })
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
      cursor: 9,
      entries: [{ seq: 9, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    expect(store.get()).toBe(10)
  })

  it("gap (non-contiguous seq) not ack", async () => {
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
        },
      },
    } as any
    // persisted 5, need seq 6 contiguous, but we send seq 7 (gap)
    const note = {
      v: "1.0",
      cursor: 7,
      entries: [{ seq: 7, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    expect(store.get()).toBe(5)
    // also test gap inside multiple entries: 6 then 8 missing 7
    const note2 = {
      v: "1.0",
      cursor: 8,
      entries: [
        { seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: 1 },
        { seq: 8, session_id: "ses_a", revision: 0, kind: "changed", time: 2 },
      ],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note2)
    await new Promise((r) => setTimeout(r, 20))
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
  })

  it("refresh failure does not ack", async () => {
    const { svc, store, ackLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    provider.panel = {
      visible: true,
      sessions: {
        refreshSessions: async () => {
          throw new Error("refresh fail")
        },
      },
    } as any
    const note = {
      v: "1.0",
      cursor: 6,
      entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 20))
    await waitForRefresh(provider)
    expect(ackLog.length).toBe(0)
    expect(store.get()).toBe(5)
  })

  it("ack failure keeps persisted cursor not moved", async () => {
    const { svc, store, ackLog } = fakePrivate({ enabled: true, persisted: 5, ackFails: true })
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
      cursor: 6,
      entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 20))
    await waitForRefresh(provider)
    expect(refreshCount).toBe(1)
    expect(ackLog).toEqual([6])
    expect(store.get()).toBe(5)
  })

  it("panel invisible does not directly refresh", async () => {
    const { svc, ackLog } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    let refreshCount = 0
    provider.panel = {
      visible: false,
      sessions: {
        refreshSessions: async () => {
          refreshCount++
        },
      },
    } as any
    const note = {
      v: "1.0",
      cursor: 6,
      entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }],
    }
    provider.handleObservationChanged(OBSERVATION_NOTIFICATION, note)
    await new Promise((r) => setTimeout(r, 30))
    expect(refreshCount).toBe(0)
    expect(ackLog.length).toBe(0)
    expect(provider.refreshPromise).toBeNull()
  })

  it("consumer exception does not bubble (service boundary) and wrong method ignored", async () => {
    const { svc, store } = fakePrivate({ enabled: true, persisted: 5 })
    const provider: any = makeProvider(svc)
    provider.generation = 1
    provider.hydrated = true
    provider.panel = { visible: true, sessions: { refreshSessions: async () => {} } } as any
    // wrong method should be ignored
    provider.handleObservationChanged("other/method", { v: "1.0", cursor: 6, entries: [] })
    await new Promise((r) => setTimeout(r, 15))
    expect(provider.refreshPromise).toBeNull()
    expect(store.get()).toBe(5)
    // exception inside coordinator should not throw outward
    const orig = provider.coordinator.decideFromChangedNotificationWithValidity
    provider.coordinator.decideFromChangedNotificationWithValidity = () => {
      throw new Error("boom")
    }
    let threw = false
    try {
      provider.handleObservationChanged(OBSERVATION_NOTIFICATION, {
        v: "1.0",
        cursor: 6,
        entries: [{ seq: 6, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }],
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    await new Promise((r) => setTimeout(r, 15))
    provider.coordinator.decideFromChangedNotificationWithValidity = orig
  })

  it("does not trigger second private read (notification is read-equivalent)", async () => {
    const { svc, store, ackLog, readLog } = fakePrivate({ enabled: true, persisted: 7 })
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
    expect(readLog.length).toBe(0)
    expect(ackLog).toEqual([8])
    expect(store.get()).toBe(8)
  })
})
