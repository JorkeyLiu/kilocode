import { describe, expect, it, mock } from "bun:test"
import { accumulateCatalog, reconcile } from "../../webview-ui/agent-manager/hydration"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"
import { SessionTiming } from "../../src/agent-manager/session-timing"
import type { CatalogUpdate, Store } from "../../src/agent-manager/host"

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

function fakeStore(initial?: unknown): Store {
  const data = new Map<string, unknown>()
  if (initial !== undefined) data.set("agentManager.state", initial)
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: (k, v) => {
      data.set(k, v)
      return Promise.resolve()
    },
  }
}
function timingStore(): Store {
  return { get: () => undefined, update: () => Promise.resolve() }
}

type Prov = {
  managedSessions: Map<string, { id: string }>
  tabOrder: Record<string, string[]>
  activeSessionId?: string
  recentSessions: Set<string>
  accumulatedCatalog: Set<string> | undefined
  catalogTombstone: Set<string>
  onCatalogUpdate: (u: CatalogUpdate) => void
  reconcile: (ids: string[]) => void
  onSessionDeleted: (e: unknown) => void
  addSession: (id: string, opts?: { recent?: boolean }) => void
  host: { workspaceStore: Store }
  timing: SessionTiming
  panel: { postMessage: (m: unknown) => void; sessions: { trackSession: () => void; refreshSessions: () => Promise<void>; abortSessions: () => Promise<void>; dispose: () => void } } | undefined
  visiblePresence: { clear: () => void; flush: () => void }
  statsPoller: { stop: () => void; setVisible: () => void; setEnabled: () => void }
  log: (...a: unknown[]) => void
}

function prov(store: Store = fakeStore()): Prov {
  const m = Object.create(AgentManagerProvider.prototype) as unknown as Record<string, unknown> as Prov
  m.managedSessions = new Map()
  m.tabOrder = {}
  m.activeSessionId = undefined
  ;(m as unknown as Record<string, unknown>)["LOCAL"] = "local"
  ;(m as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>()
  ;(m as unknown as Record<string, unknown>)["accumulatedCatalog"] = undefined
  ;(m as unknown as Record<string, unknown>)["accumulatedHasMore"] = undefined
  ;(m as unknown as Record<string, unknown>)["catalogTombstone"] = new Set<string>()
  m.host = { workspaceStore: store } as unknown as Prov["host"]
  m.timing = new SessionTiming(timingStore(), () => 1_000_000)
  m.panel = {
    postMessage: mock(() => undefined),
    sessions: {
      trackSession: mock(() => undefined),
      refreshSessions: mock(async () => undefined),
      abortSessions: mock(async () => undefined),
      dispose: mock(() => undefined),
    },
  } as unknown as Prov["panel"]
  m.visiblePresence = { clear: mock(() => undefined), flush: mock(() => undefined) } as unknown as Prov["visiblePresence"]
  m.statsPoller = { stop: mock(() => undefined), setVisible: mock(() => undefined), setEnabled: mock(() => undefined) } as unknown as Prov["statsPoller"]
  m.log = mock(() => undefined)
  return m
}

// Helper to simulate App's recent/origin/deleted + catalog handling (complete snapshots)
function createAppHarness() {
  let latestCatalog: Set<string> | undefined
  const recentRealIds = new Set<string>()
  const creationOrigin = new Set<string>()
  const deletedIds = new Set<string>()
  let catalogPreserve: string[] | undefined

  const apply = (localIds: string[], tabOrder: string[] | undefined, active: string | undefined, durable: { sessions: { id: string }[] } | undefined, isFresh: boolean, durableHydrated: boolean) => {
    const combinedPreserve = (() => {
      const fromCatalog = (catalogPreserve ?? []).filter((id) => !deletedIds.has(id))
      const recentFiltered = [...recentRealIds].filter((id) => !deletedIds.has(id))
      if (recentFiltered.length === 0) return fromCatalog.length > 0 ? fromCatalog : undefined
      const merged = [...fromCatalog, ...recentFiltered]
      const deduped = [...new Set(merged)].filter((id) => !deletedIds.has(id))
      return deduped.length > 0 ? deduped : undefined
    })()
    return reconcile({
      localIds,
      tabOrder,
      active,
      durable: durable as never,
      catalog: latestCatalog,
      preserveSessionIds: combinedPreserve,
      LOCAL,
      isFresh,
      durableHydrated,
    })
  }

  const onSessionsLoaded = (sessions: { id: string }[], _append?: boolean, _hasMore?: boolean, preserve?: string[]) => {
    const rawIds = new Set(sessions.map((s) => s.id))
    for (const del of [...deletedIds]) if (!rawIds.has(del)) deletedIds.delete(del)
    const filtered = sessions.filter((s) => !deletedIds.has(s.id))
    latestCatalog = accumulateCatalog(latestCatalog, filtered)
    catalogPreserve = preserve?.filter((id) => !deletedIds.has(id))
  }

  const onSessionDeleted = (sid: string) => {
    deletedIds.add(sid)
    recentRealIds.delete(sid)
    creationOrigin.delete(sid)
    if (latestCatalog) latestCatalog.delete(sid)
  }

  const onFork = (id: string) => {
    creationOrigin.add(id)
    recentRealIds.add(id)
  }

  const onSessionCreated = (params: { id: string; draftID?: string; localIds: string[] }) => {
    const { id, draftID, localIds } = params
    const pending = draftID && localIds.includes(draftID) ? draftID : undefined
    if (!pending && localIds.includes(id)) {
      if (creationOrigin.has(id)) {
        recentRealIds.add(id)
        creationOrigin.delete(id)
      }
      return { alreadyLocal: true, protected: creationOrigin.has(id) || recentRealIds.has(id) }
    }
    // new local would be added via placeLocal
    if (pending) recentRealIds.add(id)
    else if (creationOrigin.has(id)) {
      recentRealIds.add(id)
      creationOrigin.delete(id)
    }
    return { alreadyLocal: false, protected: recentRealIds.has(id) }
  }

  return { latestCatalog: () => latestCatalog, recentRealIds, creationOrigin, deletedIds, onSessionsLoaded, onSessionDeleted, onFork, onSessionCreated, apply }
}

describe("Gate C — fork/tool origin protection (App)", () => {
  it("fork-origin undrafted sessionCreated survives stale empty catalog", () => {
    const h = createAppHarness()
    const forkId = "ses_fork123"
    // Fork adds local tab before sessionCreated
    h.onFork(forkId)
    let localIds = [forkId]
    // Later undrafted sessionCreated arrives for already-local ID
    const res = h.onSessionCreated({ id: forkId, localIds })
    expect(res.alreadyLocal).toBe(true)
    expect(h.recentRealIds.has(forkId)).toBe(true)
    // Stale empty authoritative catalog
    h.onSessionsLoaded([], false, false)
    const out = h.apply(localIds, [forkId], forkId, { sessions: [{ id: forkId }] }, false, true)
    // With preserve, no prune
    expect(out.nextIds).toBeUndefined()
    expect(h.recentRealIds.has(forkId)).toBe(true) // still protected before catalog includes
    // Next catalog includes ID, protection consumed but ID kept
    h.onSessionsLoaded([{ id: forkId }], false, false)
    const out2 = h.apply(localIds, [forkId], forkId, { sessions: [{ id: forkId }] }, false, true)
    expect(out2.nextIds).toBeUndefined()
    // Simulate consumption in App applyReconciliation (recent cleared when catalog includes)
    // Our harness apply doesn't auto-consume recent; manually check that reconcile with preserve keeps ID and later without preserve still keeps because catalog has it
    // Emulate App's consumption: after apply, if catalog has id, delete recent
    if (h.latestCatalog()?.has(forkId)) h.recentRealIds.delete(forkId)
    expect(h.recentRealIds.has(forkId)).toBe(false)
    // Now empty preserve still keeps because catalog has it
    h.onSessionsLoaded([{ id: forkId }], false, false)
    const out3 = h.apply(localIds, [forkId], forkId, { sessions: [{ id: forkId }] }, false, true)
    expect(out3.nextIds).toBeUndefined()
  })

  it("strict existing undrafted sessionCreated (no origin) prunes on stale empty catalog", () => {
    const h = createAppHarness()
    const existing = "ses_existing999"
    const localIds = [existing]
    // No fork origin marker — this is a strict existing attachment replay
    const res = h.onSessionCreated({ id: existing, localIds })
    // For already-local without origin, sessionCreated handler would early return without protection
    expect(h.recentRealIds.has(existing)).toBe(false)
    h.onSessionsLoaded([], false, false)
    const out = h.apply(localIds, [existing], existing, { sessions: [{ id: existing }] }, false, true)
    // Without preserve, it prunes
    expect(out.nextIds).toEqual([])
    expect(out.needsPending).toBe(true)
  })

  it("pending draft protection remains", () => {
    const h = createAppHarness()
    const pending = "pending:abc"
    const real = "ses_real_pending"
    let localIds = [pending]
    // Simulate draft creation then sessionCreated with draftID
    const res = h.onSessionCreated({ id: real, draftID: pending, localIds })
    expect(h.recentRealIds.has(real)).toBe(true)
    localIds = [real]
    h.onSessionsLoaded([], false, false)
    const out = h.apply(localIds, [real], real, { sessions: [{ id: real }] }, false, true)
    expect(out.nextIds).toBeUndefined()
  })
})

describe("Gate C — deletion barrier (Provider, complete snapshots)", () => {
  it("deletion then stale snapshot containing ID does not re-add managed/order/active", async () => {
    const p = prov()
    p.managedSessions.set("a", { id: "a" })
    p.managedSessions.set("b", { id: "b" })
    p.tabOrder["local"] = ["a", "b"]
    p.activeSessionId = "b"
    // Complete snapshot with both
    p.onCatalogUpdate({ ids: ["a", "b"], append: false, hasMore: false })
    expect([...p.managedSessions.keys()].sort()).toEqual(["a", "b"])
    // Delete b
    p.onSessionDeleted({ properties: { sessionID: "b" } } as unknown)
    expect(p.managedSessions.has("b")).toBe(false)
    expect(p.catalogTombstone.has("b")).toBe(true)
    expect(p.tabOrder["local"]).toEqual(["a"])
    expect(p.activeSessionId).toBe("a")
    // Stale snapshot still containing b (drain race) stays filtered
    p.onCatalogUpdate({ ids: ["a", "b"], append: false, hasMore: false })
    expect(p.managedSessions.has("b")).toBe(false)
    expect(p.tabOrder["local"]).toEqual(["a"])
    expect(p.accumulatedCatalog?.has("b")).toBe(false)
    // Converged snapshot omitting b keeps it pruned
    p.onCatalogUpdate({ ids: ["a"], append: false, hasMore: false })
    expect(p.managedSessions.has("b")).toBe(false)
  })

  it("re-created ID returns via explicit addSession while tombstone filters stale snapshots", async () => {
    const p = prov()
    p.managedSessions.set("a", { id: "a" })
    p.tabOrder["local"] = ["a"]
    p.activeSessionId = "a"
    p.onSessionDeleted({ properties: { sessionID: "a" } } as unknown)
    expect(p.catalogTombstone.has("a")).toBe(true)
    expect(p.managedSessions.has("a")).toBe(false)
    // Stale snapshot containing a stays filtered (tombstone persists)
    p.onCatalogUpdate({ ids: ["a"], append: false, hasMore: false })
    expect(p.managedSessions.has("a")).toBe(false)
    expect(p.accumulatedCatalog?.has("a")).toBe(false)
    // Re-create via addSession (new session with same ID)
    p.addSession("a", { recent: true })
    expect(p.managedSessions.has("a")).toBe(true)
    expect(p.recentSessions.has("a")).toBe(true)
    // Next snapshot still filtered at catalog level, but recent keeps managed
    p.onCatalogUpdate({ ids: ["a"], append: false, hasMore: false })
    expect(p.managedSessions.has("a")).toBe(true)
  })

  it("pending/tool/fork recent protections are consumed when catalog confirms", async () => {
    const p = prov()
    p.managedSessions.set("x", { id: "x" })
    p.tabOrder["local"] = ["x"]
    p.activeSessionId = "x"
    // Simulate tool/fork creation adding recent
    p.addSession("y", { recent: true })
    expect(p.recentSessions.has("y")).toBe(true)
    expect(p.managedSessions.has("y")).toBe(true)
    // Stale empty catalog should not prune because recent preserves
    p.onCatalogUpdate({ ids: [], append: false, hasMore: false })
    expect(p.managedSessions.has("y")).toBe(true)
    // Now catalog includes y, should consume recent but keep y
    p.onCatalogUpdate({ ids: ["x", "y"], append: false, hasMore: false })
    expect(p.managedSessions.has("y")).toBe(true)
    expect(p.recentSessions.has("y")).toBe(false)
    // Subsequent empty catalog should now prune y (no longer protected)
    p.onCatalogUpdate({ ids: ["x"], append: false, hasMore: false })
    expect(p.managedSessions.has("y")).toBe(false)
  })
})

describe("Gate C — deletion barrier (App webview, complete snapshots)", () => {
  it("deletion then stale snapshot containing ID does not re-add local", () => {
    const h = createAppHarness()
    const id = "ses_del_app"
    // establish initial catalog with "other" and id
    h.onSessionsLoaded([{ id: "other" }, { id }], false, false)
    let localIds = [id, "other"]
    // Simulate deletion of id
    h.onSessionDeleted(id)
    localIds = localIds.filter((x) => x !== id)
    expect(h.deletedIds.has(id)).toBe(true)
    // Stale complete snapshot still containing deleted ID stays filtered
    h.onSessionsLoaded([{ id: "other" }, { id }], false, false)
    expect(h.latestCatalog()?.has(id)).toBe(false)
    expect(h.latestCatalog()?.has("other")).toBe(true)
    const out = h.apply(localIds, localIds, "other", { sessions: [{ id: "other" }] }, false, true)
    expect(out.nextIds).toBeUndefined() // other kept, deleted not re-added (local already without id)
    // Ensure local stays without deleted
    expect(localIds.includes(id)).toBe(false)
    // Converged snapshot omitting the ID drops its tombstone
    h.onSessionsLoaded([{ id: "other" }], false, false)
    expect(h.deletedIds.has(id)).toBe(false)
  })

  it("tombstone persists across stale snapshots and converges when omitted", () => {
    const h = createAppHarness()
    const id = "ses_recreate_app"
    h.onSessionDeleted(id)
    expect(h.deletedIds.has(id)).toBe(true)
    h.onSessionsLoaded([{ id }], false, false)
    expect(h.latestCatalog()?.has(id)).toBe(false)
    expect(h.deletedIds.has(id)).toBe(true)
    // Converged snapshot omits the ID
    h.onSessionsLoaded([], false, false)
    expect(h.deletedIds.has(id)).toBe(false)
  })

  it("fork protection consumed when catalog confirms, then prune without preserve", () => {
    const h = createAppHarness()
    const id = "ses_fork_consume"
    h.onFork(id)
    let localIds = [id]
    h.onSessionsLoaded([], false, false)
    let out = h.apply(localIds, [id], id, { sessions: [{ id }] }, false, true)
    expect(out.nextIds).toBeUndefined()
    // Simulate App's consumption after catalog includes
    h.onSessionsLoaded([{ id }], false, false)
    // App would delete recent after catalog includes
    if (h.latestCatalog()?.has(id)) h.recentRealIds.delete(id)
    expect(h.recentRealIds.has(id)).toBe(false)
    out = h.apply(localIds, [id], id, { sessions: [{ id }] }, false, true)
    expect(out.nextIds).toBeUndefined() // catalog has it, so no prune
    // Now empty catalog should prune
    h.onSessionsLoaded([], false, false)
    out = h.apply(localIds, [id], id, { sessions: [{ id }] }, false, true)
    expect(out.nextIds).toEqual([])
  })
})

describe("Gate C — tool creation origin protection (Provider production path)", () => {
  function makeToolProv(sessionId: string, failCreate = false) {
    const ordered: string[] = []
    const raw: unknown[] = []
    const panel = {
      postMessage: mock((msg: unknown) => {
        const t = (msg as { type?: string }).type
        if (t === "agentManager.state") ordered.push("state")
        else if (t === "agentManager.sessionAdded") ordered.push("added")
        else if (t === "sessionCreated") ordered.push("created")
        else if (t) ordered.push(t)
        raw.push(msg)
      }),
      sessions: {
        trackSession: mock(() => {}),
        registerSession: mock((s: { id: string }) => {
          ordered.push("created")
          raw.push({ type: "sessionCreated", session: s })
        }),
        refreshSessions: mock(async () => undefined),
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
    } as unknown as Prov["panel"]
    const store = fakeStore()
    const p = Object.create(AgentManagerProvider.prototype) as unknown as Record<string, unknown> as Prov & {
      openPanel: (b?: boolean) => void
      waitForStateReady: (c: string) => Promise<void>
      startToolRequest: (r: unknown) => Promise<void>
      toolRequests: Set<string>
      host: { workspaceStore: Store; workspacePath: () => string | undefined }
      connectionService: unknown
    }
    p.managedSessions = new Map()
    p.tabOrder = {}
    p.activeSessionId = undefined
    ;(p as unknown as Record<string, unknown>)["LOCAL"] = "local"
    ;(p as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>()
    ;(p as unknown as Record<string, unknown>)["accumulatedCatalog"] = undefined
    ;(p as unknown as Record<string, unknown>)["accumulatedHasMore"] = undefined
    ;(p as unknown as Record<string, unknown>)["catalogTombstone"] = new Set<string>()
    ;(p as unknown as Record<string, unknown>)["panelSessions"] = new Set<string>()
    p.host = {
      workspaceStore: store,
      workspacePath: () => "/tmp/root",
      capture: mock(() => {}),
      showError: mock(() => {}),
      createOutput: () => ({ appendLine: mock(() => {}), dispose: mock(() => {}) }),
      extensionKeybindings: () => [],
      openPanel: mock(() => panel),
    } as unknown as Prov["host"]
    p.timing = new SessionTiming(timingStore(), () => 1_000_000)
    p.panel = panel
    ;(p as unknown as Record<string, unknown>)["visiblePresence"] = {
      clear: mock(() => {}),
      flush: mock(() => {}),
    }
    ;(p as unknown as Record<string, unknown>)["statsPoller"] = {
      stop: mock(() => {}),
      setVisible: mock(() => {}),
      setEnabled: mock(() => {}),
    }
    ;(p as unknown as Record<string, unknown>)["log"] = mock(() => {})
    ;(p as unknown as Record<string, unknown>)["outputChannel"] = {
      appendLine: mock(() => {}),
      dispose: mock(() => {}),
    }
    ;(p as unknown as Record<string, unknown>)["gitOps"] = { dispose: mock(() => {}) }
    ;(p as unknown as Record<string, unknown>)["terminalManager"] = { dispose: mock(() => {}) }
    ;(p as unknown as Record<string, unknown>)["terminalRouter"] = { dispose: mock(async () => {}) }
    p.toolRequests = new Set<string>()
    p.connectionService = {
      sandboxPreference: { wait: async () => {}, explicit: () => false },
      getClient: () => ({
        session: {
          create: async () => {
            if (failCreate) throw new Error("create failed")
            return { data: { id: sessionId, title: sessionId, createdAt: "", updatedAt: "" } }
          },
          promptAsync: async () => ({}),
        },
        mcp: { status: async () => ({}) },
        config: { get: async () => ({ data: { sandbox: { enabled: false } } }) },
      }),
      getClientAsync: async () => ({
        session: { create: async () => ({ data: { id: sessionId } }) },
      }),
    } as unknown as Prov["connectionService"]
    p.openPanel = mock(() => {})
    p.waitForStateReady = mock(async () => {})
    return { p, ordered, raw, panel, store }
  }

  it("tool create success posts sessionAdded before sessionCreated (production closure)", async () => {
    const sid = "ses_tool_prod_1"
    const { p, ordered } = makeToolProv(sid)
    await p.startToolRequest({ requestID: "am-prod-1", tasks: [{ prompt: "hello" }] })
    expect(ordered).toEqual(["state", "added", "created"])
    expect(p.managedSessions.has(sid)).toBe(true)
    expect(p.recentSessions.has(sid)).toBe(true)
    // stale empty authoritative catalog must not prune while recent protects
    p.onCatalogUpdate({ ids: [], append: false, hasMore: false })
    expect(p.managedSessions.has(sid)).toBe(true)
    // catalog confirmation consumes recent but keeps session
    p.onCatalogUpdate({ ids: [sid], append: false, hasMore: false })
    expect(p.managedSessions.has(sid)).toBe(true)
    expect(p.recentSessions.has(sid)).toBe(false)
    // subsequent empty should now prune
    p.onCatalogUpdate({ ids: [], append: false, hasMore: false })
    expect(p.managedSessions.has(sid)).toBe(false)
  })

  it("tool create failure emits no marker", async () => {
    const { p, ordered } = makeToolProv("ses_tool_fail", true)
    await p.startToolRequest({ requestID: "am-fail-1", tasks: [{ prompt: "hello" }] })
    expect(ordered).not.toContain("added")
    expect(ordered).not.toContain("created")
    expect(p.managedSessions.size).toBe(0)
    expect(p.recentSessions.size).toBe(0)
  })

  it("tool sessionAdded origin protects App stale empty and consumes on catalog (real reconcile)", async () => {
    const sid = "ses_tool_app_1"
    const h = createAppHarness()
    // Simulate provider posting sessionAdded before sessionCreated: App receives sessionAdded first
    h.creationOrigin.add(sid)
    h.recentRealIds.add(sid)
    const localIds = [sid]
    // Undrafted sessionCreated arrives for already-local ID (creationOrigin promotes)
    const res = h.onSessionCreated({ id: sid, localIds })
    expect(res.alreadyLocal).toBe(true)
    expect(h.recentRealIds.has(sid)).toBe(true)
    // Stale empty catalog must keep tool ID via preserve
    h.onSessionsLoaded([], false, false)
    let out = h.apply(localIds, [sid], sid, { sessions: [{ id: sid }] }, false, true)
    expect(out.nextIds).toBeUndefined()
    // Catalog confirmation consumes but keeps
    h.onSessionsLoaded([{ id: sid }], false, false)
    if (h.latestCatalog()?.has(sid)) h.recentRealIds.delete(sid)
    expect(h.recentRealIds.has(sid)).toBe(false)
    out = h.apply(localIds, [sid], sid, { sessions: [{ id: sid }] }, false, true)
    expect(out.nextIds).toBeUndefined()
  })

  it("strict existing undrafted replay still prunes (no tool origin)", async () => {
    const h = createAppHarness()
    const existing = "ses_strict_replay_1"
    const localIds = [existing]
    // No tool/fork marker — strict replay
    const res = h.onSessionCreated({ id: existing, localIds })
    expect(h.recentRealIds.has(existing)).toBe(false)
    h.onSessionsLoaded([], false, false)
    const out = h.apply(localIds, [existing], existing, { sessions: [{ id: existing }] }, false, true)
    expect(out.nextIds).toEqual([])
  })
})
