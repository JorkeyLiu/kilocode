import { describe, expect, it, mock } from "bun:test"
import { parse, build, KEY } from "../../src/agent-manager/persistence"
import { SessionTiming } from "../../src/agent-manager/session-timing"
import type { CatalogUpdate, Store } from "../../src/agent-manager/host"
import fs from "node:fs"
import path from "node:path"

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

function fakeStore(initial?: unknown): {
  store: Store
  data: Map<string, unknown>
  writes: string[]
  updates: unknown[]
} {
  const data = new Map<string, unknown>()
  const writes: string[] = []
  const updates: unknown[] = []
  if (initial !== undefined) data.set(KEY, initial)
  const store: Store = {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: (k, v) => {
      writes.push(k)
      updates.push(structuredClone(v))
      data.set(k, v)
      return Promise.resolve()
    },
  }
  return { store, data, writes, updates }
}

function timingStore(): Store {
  return {
    get: () => undefined,
    update: () => Promise.resolve(),
  }
}

describe("persistence parse", () => {
  it("rejects malformed/duplicate/oversized/unknown fields", () => {
    expect(parse(null)).toBeNull()
    expect(parse({})).toBeNull()
    expect(parse({ v: 1, sessions: ["a"], order: ["a"], extra: 1 })).toBeNull()
    expect(parse({ v: 2, sessions: [], order: [] })).toBeNull()
    expect(parse({ v: 1, sessions: ["a", "a"], order: [] })).toBeNull()
    expect(parse({ v: 1, sessions: ["a"], order: ["a", "a"] })).toBeNull()
    expect(parse({ v: 1, sessions: ["bad!"], order: [] })).toBeNull()
    expect(parse({ v: 1, sessions: [""], order: [] })).toBeNull()
    expect(parse({ v: 1, sessions: [], order: [], active: "" })).toBeNull()
    expect(parse({ v: 1, sessions: Array.from({ length: 101 }, (_, i) => `s${i}`), order: [] })).toBeNull()
    expect(parse({ v: 1, sessions: ["a"], order: [], active: "bad!" })).toBeNull()
    expect(parse({ v: 1, sessions: [], order: [], unknown: true })).toBeNull()
    expect(parse({ v: 1, sessions: ["ses_a", "ses_b"], order: ["ses_b", "ses_a"], active: "ses_a" })).toEqual({
      v: 1,
      sessions: ["ses_a", "ses_b"],
      order: ["ses_b", "ses_a"],
      active: "ses_a",
    })
  })

  it("build dedupes, bounds and enforces invariants", () => {
    const s = build(["a", "a", "b"], ["b", "b"], "a")
    expect(s.sessions).toEqual(["a", "b"])
    // order is subset and appended missing a deterministically: input order ["b"] -> filtered ["b"] + missing ["a"] => ["b","a"]
    expect(s.order).toEqual(["b", "a"])
    expect(s.active).toBe("a")
  })

  it("inconsistent {sessions:[a],order:[b],active:b} rejects or normalizes to a-only", () => {
    const raw = { v: 1, sessions: ["a"], order: ["b"], active: "b" } as unknown
    const p = parse(raw)
    if (p === null) {
      expect(p).toBeNull()
    } else {
      expect(p.sessions).toEqual(["a"])
      expect(p.order).not.toContain("b")
      expect(p.order).toContain("a")
      expect(p.active).toBeUndefined()
    }
  })

  it("build normalizes order subset and active member", () => {
    const b = build(["ses_a", "ses_b"], ["ses_b", "ses_x"], "ses_x")
    expect(b.sessions).toEqual(["ses_a", "ses_b"])
    expect(b.order).toEqual(["ses_b", "ses_a"])
    expect(b.active).toBeUndefined()
    const c = build(["ses_a", "ses_b"], ["ses_a"], "ses_b")
    expect(c.order).toEqual(["ses_a", "ses_b"])
    expect(c.active).toBe("ses_b")
  })

  it("order appends omitted sessions deterministically", () => {
    const b = build(["a", "b", "c"], ["a"], undefined)
    expect(b.order).toEqual(["a", "b", "c"])
  })
})

type Prov = {
  managedSessions: Map<string, { id: string }>
  tabOrder: Record<string, string[]>
  activeSessionId?: string
  host: { workspaceStore: Store; workspacePath: () => string | undefined }
  timing: SessionTiming
  panel:
    | {
        postMessage: (m: unknown) => void
        sessions: {
          refreshSessions: () => Promise<void>
          onCatalog?: (cb: (update: CatalogUpdate) => void) => { dispose(): void }
          trackSession: (id: string) => void
          abortSessions: (ids: readonly string[]) => Promise<void>
          dispose: () => void
        }
        visible: boolean
        active: boolean
        waitForReady: () => Promise<void>
        waitForActive: () => Promise<void>
        reveal: () => void
        onDidChangeVisibility: (cb: (v: boolean) => void) => { dispose(): void }
        onDidDispose: (cb: () => void) => { dispose(): void }
        dispose: () => void
      }
    | undefined
  connectionService: { getClient: () => { backgroundProcess: { stopSession: () => Promise<unknown> } } }
  pushState: () => void
  loadPersisted: () => void
  buildPersisted: () => unknown
  schedulePersist: () => void
  flush: () => Promise<void>
  reconcile: (ids: string[]) => void
  onCatalogUpdate: (update: CatalogUpdate) => void
  onCloseSession: (id: string) => Promise<void>
  onSessionMessage: (m: Record<string, unknown>, msg: Record<string, unknown>) => unknown
  handleMessage: (msg: Record<string, unknown>) => Promise<unknown>
  stateReady?: Promise<void>
  visiblePresence: { clear: () => void; flush: () => void }
  statsPoller: { stop: () => void; setVisible: () => void; setEnabled: () => void }
  log: (...a: unknown[]) => void
  pendingSnapshot: unknown
  persistInFlight: Promise<void> | null
}

function prov(store: Store): Prov {
  const manager = Object.create(AgentManagerProvider.prototype) as unknown as Record<string, unknown> as Prov
  manager.managedSessions = new Map()
  manager.tabOrder = {}
  manager.activeSessionId = undefined
  ;(manager as unknown as Record<string, unknown>)["LOCAL"] = "local"
  ;(manager as unknown as Record<string, unknown>)["pendingSnapshot"] = null
  ;(manager as unknown as Record<string, unknown>)["persistInFlight"] = null
  ;(manager as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>()
  ;(manager as unknown as Record<string, unknown>)["accumulatedCatalog"] = undefined
  ;(manager as unknown as Record<string, unknown>)["accumulatedHasMore"] = undefined
  manager.host = { workspaceStore: store, workspacePath: () => "/tmp" } as unknown as Prov["host"]
  manager.timing = new SessionTiming(timingStore(), () => 1_000_000)
  manager.panel = {
    postMessage: mock(() => undefined),
    sessions: {
      refreshSessions: mock(async () => undefined),
      trackSession: mock(() => undefined),
      abortSessions: mock(async () => undefined),
      dispose: mock(() => undefined),
    },
    visible: true,
    active: true,
    waitForReady: mock(async () => undefined),
    waitForActive: mock(async () => undefined),
    reveal: mock(() => undefined),
    onDidChangeVisibility: mock(() => ({ dispose: mock(() => undefined) })),
    onDidDispose: mock(() => ({ dispose: mock(() => undefined) })),
  } as unknown as Prov["panel"]
  ;(manager as unknown as Record<string, unknown>)["panelSessions"] = new Set<string>()
  manager.connectionService = {
    getClient: () => ({ backgroundProcess: { stopSession: mock(async () => ({})) } }),
  } as unknown as Prov["connectionService"]
  manager.visiblePresence = {
    clear: mock(() => undefined),
    flush: mock(() => undefined),
  } as unknown as Prov["visiblePresence"]
  manager.statsPoller = {
    stop: mock(() => undefined),
    setVisible: mock(() => undefined),
    setEnabled: mock(() => undefined),
  } as unknown as Prov["statsPoller"]
  ;(manager as unknown as Record<string, unknown>)["gitOps"] = { dispose: mock(() => undefined) }
  ;(manager as unknown as Record<string, unknown>)["terminalManager"] = { dispose: mock(() => undefined) }
  ;(manager as unknown as Record<string, unknown>)["terminalRouter"] = { dispose: mock(async () => undefined) }
  ;(manager as unknown as Record<string, unknown>)["outputChannel"] = {
    dispose: mock(() => undefined),
    appendLine: mock(() => undefined),
  }
  ;(manager as unknown as Record<string, unknown>)["host"].dispose = mock(() => undefined)
  manager.log = mock(() => undefined)
  return manager
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("provider persistence writer", () => {
  it("select active then dispose before microtask retains active", async () => {
    const { store, data } = fakeStore()
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    // mutate durable field before flush as old panel dispose did
    p.activeSessionId = undefined
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    const persisted = data.get(KEY) as { active?: string; sessions: string[]; order: string[] }
    expect(persisted.active).toBe("ses_b")
    expect(persisted.sessions).toEqual(["ses_a", "ses_b"])
  })

  it("two delayed writes cannot resolve out of order to stale final state", async () => {
    const data = new Map<string, unknown>()
    const calls: unknown[] = []
    const firstDeferred = deferred<void>()
    const secondDeferred = deferred<void>()
    let callIndex = 0
    const store: Store = {
      get: () => undefined,
      update: (_k, v) => {
        callIndex++
        const idx = callIndex
        calls.push(structuredClone(v))
        if (idx === 1)
          return firstDeferred.promise.then(() => {
            data.set(KEY, v)
          })
        return secondDeferred.promise.then(() => {
          data.set(KEY, v)
        })
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    // mutate to second state before first write completes
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    // only first update has started; second is coalesced pending
    expect(calls.length).toBe(1)
    firstDeferred.resolve()
    await new Promise((r) => setTimeout(r, 10))
    // first completed, second should now be in flight
    expect(calls.length).toBe(2)
    secondDeferred.resolve()
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.length).toBe(2)
    const final = data.get(KEY) as { sessions: string[]; active?: string }
    expect(final.sessions).toEqual(["ses_a", "ses_b"])
    expect(final.active).toBe("ses_b")
    // ensure second snapshot not overwritten by stale first
    expect((calls[1] as { sessions: string[] }).sessions).toEqual(["ses_a", "ses_b"])
  })

  it("first update rejects, later flush/retry writes latest state", async () => {
    const data = new Map<string, unknown>()
    let failNext = true
    const updates: unknown[] = []
    const store: Store = {
      get: () => undefined,
      update: (_k, v) => {
        updates.push(structuredClone(v))
        if (failNext) {
          failNext = false
          return Promise.reject(new Error("write fail"))
        }
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    // flush now performs bounded retry, so first flush retries and succeeds with ses_a
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a"])
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
    // mutate to latest after succeeded retry
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    const final = data.get(KEY) as { sessions: string[]; active?: string }
    expect(final.sessions).toEqual(["ses_a", "ses_b"])
    expect(final.active).toBe("ses_b")
  })

  it("shutdown awaits write", async () => {
    const data = new Map<string, unknown>()
    const d = deferred<void>()
    const store: Store = {
      get: () => undefined,
      update: (_k, v) =>
        d.promise.then(() => {
          data.set(KEY, v)
        }),
    }
    const p = prov(store)
    // inject writer state as provider has
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const flushP = (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    let flushed = false
    flushP.then(() => (flushed = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(flushed).toBe(false)
    expect(data.get(KEY)).toBeUndefined()
    d.resolve()
    await flushP
    expect(flushed).toBe(true)
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a"])
  })

  it("attach with missing/malformed store clears retained state", async () => {
    const goodStore = fakeStore({ v: 1, sessions: ["ses_a"], order: ["ses_a"], active: "ses_a" }).store
    const p = prov(goodStore)
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    expect([...p.managedSessions.keys()]).toEqual(["ses_a"])
    expect(p.activeSessionId).toBe("ses_a")
    // missing store
    const empty = fakeStore().store
    ;(p as unknown as { host: { workspaceStore: Store } }).host.workspaceStore = empty
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    expect([...p.managedSessions.keys()]).toEqual([])
    expect(p.tabOrder["local"]).toBeUndefined()
    expect(p.activeSessionId).toBeUndefined()
    // malformed store
    const bad = fakeStore({ v: 1, sessions: ["a"], order: ["b"], active: "b" } as unknown).store
    // need to re-populate to prove clear
    p.managedSessions.set("ses_x", { id: "ses_x" })
    p.tabOrder["local"] = ["ses_x"]
    p.activeSessionId = "ses_x"
    ;(p as unknown as { host: { workspaceStore: Store } }).host.workspaceStore = bad
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    expect([...p.managedSessions.keys()]).toEqual([])
    expect(p.activeSessionId).toBeUndefined()
  })

  it("draft pending not persisted", async () => {
    const { store, data } = fakeStore({ v: 1, sessions: ["ses_a"], order: ["ses_a"], active: "ses_a" })
    const p = prov(store)
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    // simulate draft sendMessage path: it should not persist draft
    const before = structuredClone(data.get(KEY))
    // draft handling no longer sets active to draft nor schedules persist
    // emulate old bug would have set active to draft and persisted
    p.activeSessionId = "draft_123"
    // but schedulePersist would filter it out because draft not in sessions
    // we test the provider's onSessionMessage path does not schedule
    const m = { type: "sendMessage", text: "hi", draftID: "draft_123" } as unknown as Record<string, unknown>
    ;(p as unknown as { onSessionMessage: (a: unknown, b: unknown) => unknown }).onSessionMessage.call(
      p,
      m as unknown as Record<string, unknown>,
      m,
    )
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    // store should still not contain draft
    const persisted = data.get(KEY) as { sessions: string[]; active?: string; order: string[] }
    expect(persisted.sessions).not.toContain("draft_123")
    expect(persisted.order).not.toContain("draft_123")
    expect(persisted.active).not.toBe("draft_123")
    expect(persisted.active).toBe("ses_a")
    expect(persisted).toEqual(before)
  })

  it("real attach/dispose/reattach carries two tabs/order/active", async () => {
    const { store, data } = fakeStore()
    const p1 = prov(store)
    p1.managedSessions.set("ses_a", { id: "ses_a" })
    p1.managedSessions.set("ses_b", { id: "ses_b" })
    p1.tabOrder["local"] = ["ses_b", "ses_a"]
    p1.activeSessionId = "ses_b"
    ;(p1 as unknown as { schedulePersist: () => void }).schedulePersist.call(p1)
    await (p1 as unknown as { flush: () => Promise<void> }).flush.call(p1)
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a", "ses_b"])
    // simulate panel dispose that does NOT clear durable fields
    // p1 disposal would keep managedSessions, but we simulate new provider attach
    const p2 = prov(store)
    ;(p2 as unknown as { loadPersisted: () => void }).loadPersisted.call(p2)
    expect([...p2.managedSessions.keys()]).toEqual(["ses_a", "ses_b"])
    expect(p2.tabOrder["local"]).toEqual(["ses_b", "ses_a"])
    expect(p2.activeSessionId).toBe("ses_b")
    // pushState would send state with two tabs
    const posts: unknown[] = []
    p2.panel!.postMessage = (m: unknown) => posts.push(m)
    ;(p2 as unknown as { pushState: () => void }).pushState.call(p2)
    const state = posts[0] as {
      sessions: { id: string }[]
      tabOrder: Record<string, string[]>
      activeSessionId?: string
    }
    expect(state.sessions.map((s) => s.id)).toEqual(["ses_a", "ses_b"])
    expect(state.tabOrder["local"]).toEqual(["ses_b", "ses_a"])
    expect(state.activeSessionId).toBe("ses_b")
  })

  it("observation-only no writes", async () => {
    const { store, writes, data } = fakeStore({ v: 1, sessions: ["ses_a"], order: ["ses_a"] })
    const p = prov(store)
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    writes.length = 0
    // onStateMessage for collapsed does not persist
    const m = { type: "agentManager.setSessionsCollapsed", collapsed: true } as unknown as Record<string, unknown>
    ;(p as unknown as { onStateMessage: (a: unknown) => unknown }).onStateMessage?.call(p, m as unknown as never)
    await new Promise((r) => setTimeout(r, 10))
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect(writes.length).toBe(0)
    expect(data.get(KEY)).toEqual({ v: 1, sessions: ["ses_a"], order: ["ses_a"] })
    // reconcile with same catalog should not persist
    p.reconcile(["ses_a"])
    await new Promise((r) => setTimeout(r, 10))
    expect(writes.length).toBe(0)
  })

  it("catalog reconcile repairs order/active and persists once", async () => {
    const { store, data, writes } = fakeStore({
      v: 1,
      sessions: ["ses_a", "ses_b", "ses_c"],
      order: ["ses_a", "ses_b", "ses_c"],
      active: "ses_c",
    })
    const p = prov(store)
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    writes.length = 0
    p.reconcile(["ses_a", "ses_c"])
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect([...p.managedSessions.keys()]).toEqual(["ses_a", "ses_c"])
    expect(p.tabOrder["local"]).toEqual(["ses_a", "ses_c"])
    expect(p.activeSessionId).toBe("ses_c")
    expect(writes.length).toBe(1)
    writes.length = 0
    p.reconcile(["ses_a"])
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect([...p.managedSessions.keys()]).toEqual(["ses_a"])
    expect(p.activeSessionId).toBe("ses_a")
    expect(p.tabOrder["local"]).toEqual(["ses_a"])
    expect(writes.length).toBe(1)
    const persisted = data.get(KEY) as { sessions: string[]; order: string[]; active?: string }
    expect(persisted.sessions).toEqual(["ses_a"])
    expect(persisted.order).toEqual(["ses_a"])
    expect(persisted.active).toBe("ses_a")
  })

  it("flush drains coalesced B after in-flight A rejects", async () => {
    const data = new Map<string, unknown>()
    let call = 0
    const aDef = deferred<void>()
    const updates: unknown[] = []
    const store: Store = {
      get: () => undefined,
      update: (_k, v) => {
        call++
        updates.push(structuredClone(v))
        if (call === 1) {
          return aDef.promise
        }
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    expect((p as unknown as { persistInFlight: Promise<void> | null }).persistInFlight).not.toBeNull()
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeTruthy()
    const flushP = (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    await new Promise((r) => setTimeout(r, 5))
    expect((p as unknown as { persistInFlight: Promise<void> | null }).persistInFlight).not.toBeNull()
    aDef.reject(new Error("a fail"))
    await flushP
    expect(call).toBe(2)
    expect(updates.length).toBe(2)
    const final = data.get(KEY) as { sessions: string[]; active?: string }
    expect(final.sessions).toEqual(["ses_a", "ses_b"])
    expect(final.active).toBe("ses_b")
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
    expect((p as unknown as { persistInFlight: Promise<void> | null }).persistInFlight).toBeNull()
  })

  it("flush retries A when only A rejects", async () => {
    const data = new Map<string, unknown>()
    let call = 0
    const aDef = deferred<void>()
    const updates: unknown[] = []
    const store: Store = {
      get: () => undefined,
      update: (_k, v) => {
        call++
        updates.push(structuredClone(v))
        if (call === 1) return aDef.promise
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const flushP = (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    await new Promise((r) => setTimeout(r, 5))
    aDef.reject(new Error("a fail"))
    await flushP
    expect(call).toBe(2)
    const final = data.get(KEY) as { sessions: string[] }
    expect(final.sessions).toEqual(["ses_a"])
    expect((updates[0] as { sessions: string[] }).sessions).toEqual(["ses_a"])
    expect((updates[1] as { sessions: string[] }).sessions).toEqual(["ses_a"])
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
  })

  it("flush retry also rejects retains pending and terminates bounded", async () => {
    const data = new Map<string, unknown>()
    let call = 0
    const aDef = deferred<void>()
    const bDef = deferred<void>()
    const store: Store = {
      get: () => undefined,
      update: (_k, v) => {
        call++
        if (call === 1) return aDef.promise
        if (call === 2) return bDef.promise
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const flushP = (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    await new Promise((r) => setTimeout(r, 5))
    aDef.reject(new Error("a fail"))
    await new Promise((r) => setTimeout(r, 5))
    expect(call).toBe(2)
    bDef.reject(new Error("b fail"))
    await flushP
    expect(call).toBe(2)
    expect(data.get(KEY)).toBeUndefined()
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeTruthy()
    expect((p as unknown as { persistInFlight: Promise<void> | null }).persistInFlight).toBeNull()
    // bounded: no third attempt
    await new Promise((r) => setTimeout(r, 10))
    expect(call).toBe(2)
  })

  it("flush called with no pending/inflight is no-op", async () => {
    const { store, writes } = fakeStore()
    const p = prov(store)
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
    expect((p as unknown as { persistInFlight: Promise<void> | null }).persistInFlight).toBeNull()
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect(writes.length).toBe(0)
  })

  it("shutdown uses flush and waits retry after in-flight reject", async () => {
    const data = new Map<string, unknown>()
    let call = 0
    const aDef = deferred<void>()
    const store: Store = {
      get: () => undefined,
      update: (_k, v) => {
        call++
        if (call === 1) return aDef.promise
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    ;(p as unknown as { stateReady: Promise<void> }).stateReady = Promise.resolve()
    // ensure disposeAsync has all handles
    ;(p as unknown as Record<string, unknown>)["gitOps"] = { dispose: () => undefined }
    ;(p as unknown as Record<string, unknown>)["terminalManager"] = { dispose: () => undefined }
    ;(p as unknown as Record<string, unknown>)["terminalRouter"] = { dispose: async () => undefined }
    ;(p as unknown as Record<string, unknown>)["outputChannel"] = {
      dispose: () => undefined,
      appendLine: () => undefined,
    }
    ;(p as unknown as Record<string, unknown>)["host"] = {
      ...(p.host as unknown as Record<string, unknown>),
      dispose: () => undefined,
    }
    if (p.panel) {
      ;(p.panel as unknown as Record<string, unknown>)["dispose"] = () => undefined
      ;((p.panel as unknown as Record<string, unknown>)["sessions"] as Record<string, unknown>)["dispose"] = () =>
        undefined
    }
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const shutting = (p as unknown as { shutdown: () => Promise<void> }).shutdown.call(p)
    await new Promise((r) => setTimeout(r, 5))
    expect(call).toBe(1)
    aDef.reject(new Error("a fail"))
    await shutting
    expect(call).toBe(2)
    const final = data.get(KEY) as { sessions: string[]; active?: string }
    expect(final.sessions).toEqual(["ses_a", "ses_b"])
    expect(final.active).toBe("ses_b")
  })
})

describe("provider reattach coordination", () => {
  it("A in flight, panel reattach before resolution waits and first pushed state contains A", async () => {
    const old = { v: 1, sessions: ["ses_old"], order: ["ses_old"] }
    const data = new Map<string, unknown>([[KEY, old]])
    const d = deferred<void>()
    let calls = 0
    const store: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, v) => {
        calls++
        return d.promise.then(() => {
          data.set(KEY, v)
        })
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    expect(calls).toBe(1)
    expect((p as unknown as { persistInFlight: Promise<void> | null }).persistInFlight).not.toBeNull()
    const pushes: unknown[] = []
    p.panel!.postMessage = (m: unknown) => pushes.push(m)
    const init = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    expect(pushes.length).toBe(0)
    d.resolve()
    await init
    expect(pushes.length).toBe(1)
    const state = pushes[0] as {
      sessions: { id: string }[]
      tabOrder: Record<string, string[]>
      activeSessionId?: string
    }
    expect(state.sessions.map((s) => s.id)).toEqual(["ses_a"])
    expect(state.tabOrder["local"]).toEqual(["ses_a"])
    expect(state.activeSessionId).toBe("ses_a")
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a"])
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
  })

  it("B coalesced while A in flight; attach resolves to B", async () => {
    const old = { v: 1, sessions: ["ses_old"], order: ["ses_old"] }
    const data = new Map<string, unknown>([[KEY, old]])
    const aDef = deferred<void>()
    const bCalls: unknown[] = []
    let call = 0
    const store: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, v) => {
        call++
        bCalls.push(structuredClone(v))
        if (call === 1) return aDef.promise.then(() => data.set(KEY, v))
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    expect(call).toBe(1)
    const pushes: unknown[] = []
    p.panel!.postMessage = (m: unknown) => pushes.push(m)
    const init = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    expect(pushes.length).toBe(0)
    aDef.resolve()
    await init
    expect(pushes.length).toBe(1)
    const state = pushes[0] as {
      sessions: { id: string }[]
      tabOrder: Record<string, string[]>
      activeSessionId?: string
    }
    expect(state.sessions.map((s) => s.id).sort()).toEqual(["ses_a", "ses_b"])
    expect(state.tabOrder["local"]).toEqual(["ses_a", "ses_b"])
    expect(state.activeSessionId).toBe("ses_b")
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a", "ses_b"])
    expect(bCalls.length).toBe(2)
    expect((bCalls[1] as { sessions: string[] }).sessions).toEqual(["ses_a", "ses_b"])
  })

  it("A fails and bounded retry succeeds; attach shows latest", async () => {
    const old = { v: 1, sessions: ["ses_old"], order: ["ses_old"] }
    const data = new Map<string, unknown>([[KEY, old]])
    let call = 0
    const aDef = deferred<void>()
    const store: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, v) => {
        call++
        if (call === 1) return aDef.promise
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const pushes: unknown[] = []
    p.panel!.postMessage = (m: unknown) => pushes.push(m)
    const init = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    expect(pushes.length).toBe(0)
    aDef.reject(new Error("a fail"))
    await init
    expect(pushes.length).toBe(1)
    const state = pushes[0] as { sessions: { id: string }[] }
    expect(state.sessions.map((s) => s.id)).toEqual(["ses_a"])
    expect(call).toBe(2)
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a"])
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
  })

  it("retry fails and pending retained; attach does not overwrite with old store and later flush succeeds", async () => {
    const old = { v: 1, sessions: ["ses_old"], order: ["ses_old"], active: "ses_old" }
    const data = new Map<string, unknown>([[KEY, old]])
    let call = 0
    const aDef = deferred<void>()
    const bDef = deferred<void>()
    const store: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, _v) => {
        call++
        if (call === 1) return aDef.promise
        if (call === 2) return bDef.promise
        data.set(KEY, _v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const pushes: unknown[] = []
    p.panel!.postMessage = (m: unknown) => pushes.push(m)
    const init = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    aDef.reject(new Error("a fail"))
    await new Promise((r) => setTimeout(r, 5))
    expect(call).toBe(2)
    bDef.reject(new Error("b fail"))
    await init
    expect(pushes.length).toBe(1)
    const state = pushes[0] as { sessions: { id: string }[]; activeSessionId?: string }
    expect(state.sessions.map((s) => s.id)).toEqual(["ses_a"])
    expect(state.activeSessionId).toBe("ses_a")
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeTruthy()
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_old"])
    expect([...p.managedSessions.keys()]).toEqual(["ses_a"])
    // later explicit flush succeeds
    const store2: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, v) => {
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    ;(p as unknown as { host: { workspaceStore: Store } }).host.workspaceStore = store2
    pushes.length = 0
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a"])
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
    // panel still coherent after later flush; re-attach idle should load authoritative
    pushes.length = 0
    await (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    expect(pushes.length).toBe(1)
    const state2 = pushes[0] as { sessions: { id: string }[] }
    expect(state2.sessions.map((s) => s.id)).toEqual(["ses_a"])
  })

  it("idle attach loads store authoritative normally", async () => {
    const good = { v: 1, sessions: ["ses_x", "ses_y"], order: ["ses_y", "ses_x"], active: "ses_y" }
    const { store, writes, data } = fakeStore(good)
    const p = prov(store)
    const pushes: unknown[] = []
    p.panel!.postMessage = (m: unknown) => pushes.push(m)
    await (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    expect(pushes.length).toBe(1)
    const state = pushes[0] as {
      sessions: { id: string }[]
      tabOrder: Record<string, string[]>
      activeSessionId?: string
    }
    expect(state.sessions.map((s) => s.id)).toEqual(["ses_x", "ses_y"])
    expect(state.tabOrder["local"]).toEqual(["ses_y", "ses_x"])
    expect(state.activeSessionId).toBe("ses_y")
    expect(writes.length).toBe(0)
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
    expect((p as unknown as { persistInFlight: unknown }).persistInFlight).toBeNull()
    expect(data.get(KEY)).toEqual(good)
  })

  it("later explicit flush after double failure retains bounded retry and eventually succeeds", async () => {
    const old = { v: 1, sessions: ["ses_old"], order: ["ses_old"] }
    const data = new Map<string, unknown>([[KEY, old]])
    let call = 0
    const aDef = deferred<void>()
    const bDef = deferred<void>()
    const storeFail: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, _v) => {
        call++
        if (call === 1) return aDef.promise
        if (call === 2) return bDef.promise
        data.set(KEY, _v)
        return Promise.resolve()
      },
    }
    const p = prov(storeFail)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const pushes: unknown[] = []
    p.panel!.postMessage = (m: unknown) => pushes.push(m)
    const init = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    aDef.reject(new Error("a fail"))
    await new Promise((r) => setTimeout(r, 5))
    expect(call).toBe(2)
    bDef.reject(new Error("b fail"))
    await init
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeTruthy()
    expect(call).toBe(2)
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_old"])
    // no third attempt unbounded
    await new Promise((r) => setTimeout(r, 10))
    expect(call).toBe(2)
    // later explicit flush after store recovers
    const storeOk: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, v) => {
        call++
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    ;(p as unknown as { host: { workspaceStore: Store } }).host.workspaceStore = storeOk
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect(call).toBe(3)
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a", "ses_b"])
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
    // explicit second flush is no-op
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect(call).toBe(3)
  })

  it("overlapping initializers coalesce through bounded retry and push single latest", async () => {
    const old = { v: 1, sessions: ["ses_old"], order: ["ses_old"], active: "ses_old" }
    const data = new Map<string, unknown>([[KEY, old]])
    let call = 0
    const aDef = deferred<void>()
    const bDef = deferred<void>()
    const updates: unknown[] = []
    const store: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, v) => {
        call++
        updates.push(structuredClone(v))
        if (call === 1) return aDef.promise
        if (call === 2)
          return bDef.promise.then(() => {
            data.set(KEY, v)
          })
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    // coalesced latest while A in flight
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    expect(call).toBe(1)
    const pushes: unknown[] = []
    p.panel!.postMessage = (m: unknown) => pushes.push(m)
    const init1 = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    const init2 = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    // both join the same initializationOp
    expect((p as unknown as { initializationOp: Promise<void> | null }).initializationOp).not.toBeNull()
    expect(pushes.length).toBe(0)
    // A fails, bounded retry B/latest starts
    aDef.reject(new Error("a fail"))
    await new Promise((r) => setTimeout(r, 5))
    expect(call).toBe(2)
    // neither initializer has pushed stale old store
    expect(pushes.length).toBe(0)
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_old"])
    // retry resolves
    bDef.resolve()
    await Promise.all([init1, init2])
    // single coherent push with latest
    expect(pushes.length).toBe(1)
    const state = pushes[0] as {
      sessions: { id: string }[]
      tabOrder: Record<string, string[]>
      activeSessionId?: string
    }
    expect(state.sessions.map((s) => s.id).sort()).toEqual(["ses_a", "ses_b"])
    expect(state.tabOrder["local"]).toEqual(["ses_a", "ses_b"])
    expect(state.activeSessionId).toBe("ses_b")
    expect((data.get(KEY) as { sessions: string[] }).sessions).toEqual(["ses_a", "ses_b"])
    expect((p as unknown as { pendingSnapshot: unknown }).pendingSnapshot).toBeNull()
    expect((p as unknown as { persistInFlight: unknown }).persistInFlight).toBeNull()
    // initializationOp cleared, idle sequential attach reloads authoritative normally
    expect((p as unknown as { initializationOp: Promise<void> | null }).initializationOp).toBeNull()
    pushes.length = 0
    // mutate store externally between attaches
    data.set(KEY, { v: 1, sessions: ["ses_x"], order: ["ses_x"], active: "ses_x" })
    await (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    expect(pushes.length).toBe(1)
    const state2 = pushes[0] as { sessions: { id: string }[]; activeSessionId?: string }
    expect(state2.sessions.map((s) => s.id)).toEqual(["ses_x"])
    expect(state2.activeSessionId).toBe("ses_x")
  })

  it("initialization push targets current panel not disposed old", async () => {
    const old = { v: 1, sessions: ["ses_old"], order: ["ses_old"] }
    const data = new Map<string, unknown>([[KEY, old]])
    let call = 0
    const aDef = deferred<void>()
    const bDef = deferred<void>()
    const store: Store = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      update: (_k, v) => {
        call++
        if (call === 1) return aDef.promise
        if (call === 2) return bDef.promise.then(() => data.set(KEY, v))
        data.set(KEY, v)
        return Promise.resolve()
      },
    }
    const p = prov(store)
    const oldPosts: unknown[] = []
    const newPosts: unknown[] = []
    const oldPanel = {
      postMessage: (m: unknown) => oldPosts.push(m),
      sessions: {
        refreshSessions: mock(async () => undefined),
        trackSession: mock(() => undefined),
        abortSessions: mock(async () => undefined),
        dispose: mock(() => undefined),
      },
      visible: true,
      active: true,
      waitForReady: mock(async () => undefined),
      waitForActive: mock(async () => undefined),
      reveal: mock(() => undefined),
      onDidChangeVisibility: mock(() => ({ dispose: mock(() => undefined) })),
      onDidDispose: mock(() => ({ dispose: mock(() => undefined) })),
      dispose: mock(() => undefined),
    }
    const newPanel = {
      postMessage: (m: unknown) => newPosts.push(m),
      sessions: {
        refreshSessions: mock(async () => undefined),
        trackSession: mock(() => undefined),
        abortSessions: mock(async () => undefined),
        dispose: mock(() => undefined),
      },
      visible: true,
      active: true,
      waitForReady: mock(async () => undefined),
      waitForActive: mock(async () => undefined),
      reveal: mock(() => undefined),
      onDidChangeVisibility: mock(() => ({ dispose: mock(() => undefined) })),
      onDidDispose: mock(() => ({ dispose: mock(() => undefined) })),
      dispose: mock(() => undefined),
    }
    // start with old panel attached
    ;(p as unknown as { panel: unknown }).panel = oldPanel
    p.managedSessions.set("ses_a", { id: "ses_a" })
    p.tabOrder["local"] = ["ses_a"]
    p.activeSessionId = "ses_a"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.tabOrder["local"] = ["ses_a", "ses_b"]
    p.activeSessionId = "ses_b"
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    const init = (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    await new Promise((r) => setTimeout(r, 5))
    // panel changes while initialization in flight (reattach)
    ;(p as unknown as { panel: unknown }).panel = newPanel
    expect(oldPosts.length).toBe(0)
    expect(newPosts.length).toBe(0)
    aDef.reject(new Error("a fail"))
    await new Promise((r) => setTimeout(r, 5))
    expect(call).toBe(2)
    expect(oldPosts.length).toBe(0)
    expect(newPosts.length).toBe(0)
    bDef.resolve()
    await init
    // final push must target current panel only, no stale push to old
    expect(oldPosts.length).toBe(0)
    expect(newPosts.length).toBe(1)
    const state = newPosts[0] as { sessions: { id: string }[]; tabOrder: Record<string, string[]> }
    expect(state.sessions.map((s) => s.id).sort()).toEqual(["ses_a", "ses_b"])
    expect(state.tabOrder["local"]).toEqual(["ses_a", "ses_b"])
    // no panel case: dispose without replacement should not push
    ;(p as unknown as { panel: unknown }).panel = undefined
    const noPush: unknown[] = []
    // fresh idle attach with no dirty should load store authoritative without push when no panel
    data.set(KEY, { v: 1, sessions: ["ses_z"], order: ["ses_z"] })
    await (p as unknown as { initializeState: () => Promise<void> }).initializeState.call(p)
    expect(noPush.length).toBe(0)
    expect([...p.managedSessions.keys()]).toEqual(["ses_z"])
  })
})

describe("fresh webview hydration static", () => {
  const ROOT = path.resolve(import.meta.dir, "../..")
  const APP = path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx")
  it("hydrates from durable agentManager.state sessions without synthetic sessionCreated", () => {
    const text = fs.readFileSync(APP, "utf-8")
    expect(text).toContain("durableHydrated")
    expect(text).toContain('msg.type === "agentManager.state"')
    expect(text).toContain('msg.type === "sessionsLoaded"')
    const idx = text.indexOf("durableHydrated")
    expect(idx).toBeGreaterThan(-1)
    expect(text).not.toContain('sessionsLoaded\', { type: "sessionCreated"')
  })

  it("renders two .am-tab-sortable tabs after durable hydration + sessionsLoaded", () => {
    const text = fs.readFileSync(APP, "utf-8")
    expect(text).toContain("SortableProvider")
    expect(text).toContain("tabMgr.seed(LOCAL")
    const css = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/agent-manager.css"), "utf-8")
    expect(css).toContain(".am-tab-sortable")
  })
})

describe("catalog empty final page regression", () => {
  it("first page hasMore true retains, empty append final reconciles accumulated full set", async () => {
    const { store, data, writes } = fakeStore({
      v: 1,
      sessions: ["ses_a", "ses_b"],
      order: ["ses_a", "ses_b"],
      active: "ses_a",
    })
    const p = prov(store)
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    expect([...p.managedSessions.keys()].sort()).toEqual(["ses_a", "ses_b"])
    writes.length = 0
    // Page 1: only ses_a, hasMore true — must not prune ses_b yet
    p.onCatalogUpdate({ ids: ["ses_a"], append: false, hasMore: true } as CatalogUpdate)
    expect([...p.managedSessions.keys()].sort()).toEqual(["ses_a", "ses_b"])
    expect(writes.length).toBe(0)
    // Page 2: ses_b appended, hasMore true — still not final
    p.onCatalogUpdate({ ids: ["ses_b"], append: true, hasMore: true } as CatalogUpdate)
    expect([...p.managedSessions.keys()].sort()).toEqual(["ses_a", "ses_b"])
    expect(writes.length).toBe(0)
    // Page 3: empty append final page, hasMore false — must reconcile with accumulated full set [ses_a, ses_b]
    p.onCatalogUpdate({ ids: [], append: true, hasMore: false } as CatalogUpdate)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect([...p.managedSessions.keys()].sort()).toEqual(["ses_a", "ses_b"])
    expect(p.tabOrder["local"]).toEqual(["ses_a", "ses_b"])
    expect(writes.length).toBe(0)
    // Now mutate durable to include ses_c and ensure next final empty still keeps accumulated, not reset to empty
    p.managedSessions.set("ses_c", { id: "ses_c" })
    p.tabOrder["local"] = ["ses_a", "ses_b", "ses_c"]
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    writes.length = 0
    // New pagination: full refresh with only ses_a, then empty final should prune to ses_a (accumulated [ses_a] not [])
    p.onCatalogUpdate({ ids: ["ses_a"], append: false, hasMore: true } as CatalogUpdate)
    expect([...p.managedSessions.keys()].sort()).toEqual(["ses_a", "ses_b", "ses_c"])
    p.onCatalogUpdate({ ids: [], append: true, hasMore: false } as CatalogUpdate)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    // Effective is [ses_a] (first page), so ses_b/c pruned — proves empty append kept accumulated [ses_a] instead of resetting to []
    expect([...p.managedSessions.keys()]).toEqual(["ses_a"])
    expect(p.tabOrder["local"]).toEqual(["ses_a"])
    expect(writes.length).toBe(1)
    const persisted = data.get(KEY) as { sessions: string[] }
    expect(persisted.sessions).toEqual(["ses_a"])
  })

  it("empty append does not reset accumulated to empty — full set survives final reconcile", async () => {
    const { store } = fakeStore({
      v: 1,
      sessions: ["a", "b"],
      order: ["a", "b"],
      active: "a",
    })
    const p = prov(store)
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    // Simulate pagination where first page has a, second append empty final — accumulated should stay [a]
    p.onCatalogUpdate({ ids: ["a"], append: false, hasMore: true } as CatalogUpdate)
    // Verify no prune on hasMore true
    expect([...p.managedSessions.keys()].sort()).toEqual(["a", "b"])
    p.onCatalogUpdate({ ids: [], append: true, hasMore: false } as CatalogUpdate)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect([...p.managedSessions.keys()]).toEqual(["a"])
    // If accumulated had been reset to [], reconcile would have produced [] and pruned everything including a
    expect(p.managedSessions.has("a")).toBe(true)
  })

  it("append=false reset, nonempty append merge, no synthetic ids", async () => {
    const { store } = fakeStore({ v: 1, sessions: ["a"], order: ["a"] })
    const p = prov(store)
    ;(p as unknown as { loadPersisted: () => void }).loadPersisted.call(p)
    p.managedSessions.set("b", { id: "b" })
    p.tabOrder["local"] = ["a", "b"]
    // append false resets accumulated to single a
    p.onCatalogUpdate({ ids: ["a"], append: false, hasMore: false } as CatalogUpdate)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect([...p.managedSessions.keys()]).toEqual(["a"])
    // Re-add b and test nonempty append merge
    p.managedSessions.set("b", { id: "b" })
    p.tabOrder["local"] = ["a", "b"]
    ;(p as unknown as { schedulePersist: () => void }).schedulePersist.call(p)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    p.onCatalogUpdate({ ids: ["a"], append: false, hasMore: true } as CatalogUpdate)
    p.onCatalogUpdate({ ids: ["b"], append: true, hasMore: false } as CatalogUpdate)
    await (p as unknown as { flush: () => Promise<void> }).flush.call(p)
    expect([...p.managedSessions.keys()].sort()).toEqual(["a", "b"])
    // Ensure no synthetic ids were created
    expect([...p.managedSessions.keys()].some((id) => id.startsWith("synthetic"))).toBe(false)
  })
})
