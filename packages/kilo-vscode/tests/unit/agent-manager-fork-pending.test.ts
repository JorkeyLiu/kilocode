import { describe, expect, it, mock } from "bun:test"


const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

function store() {
  return { get: () => undefined, update: async () => {} }
}

type Prov = {
  managedSessions: Map<string, { id: string }>
  tabOrder: Record<string, string[]>
  activeSessionId?: string
  recentSessions: Set<string>
  accumulatedCatalog: Set<string> | undefined
  catalogTombstone: Set<string>
  panelSessions: Set<string>
  onCatalogUpdate: (u: { ids: string[]; append?: boolean; hasMore?: boolean }) => void
  onSessionDeleted: (e: unknown) => void
  onForkSession: (sid: string, mid?: string) => Promise<void>
  addSession: (id: string, opts?: { recent?: boolean }) => void
  pushState: () => void
  postToWebview: (m: unknown) => void
  log: (...a: unknown[]) => void
  getRoot: () => string
  schedulePersist: () => void
}

function readerFor(opts: { childId?: string; withGet?: boolean }) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({}),
    get: async (input: { directory: string; sessionId: string }) => {
      if (!opts.withGet) return { v: "1.0", status: "not_found" }
      return {
        v: "1.0",
        status: "found",
        session: { id: input.sessionId, title: "t", parentID: "ses_src", directory: "/repo", projectID: "p", createdAt: 1, updatedAt: 2 },
      }
    },
    operation: async (input: { directory: string; sessionId: string; opId: string }) => ({
      v: "1.0",
      status: "found",
      operation: {
        opId: input.opId,
        outcome: "succeeded",
        code: "fork.succeeded",
        message: "fork succeeded",
        time: 1,
        ...(opts.childId ? { forkedSessionId: opts.childId } : {}),
      },
    }),
  }
}

function connFor(reader: unknown) {
  void reader
  return {
    getClient: () => ({}),
    isPrivateAvailable: () => true,
    privateForkWithHandle: () => ({ id: 1, promise: Promise.reject(new Error("peer closed")), cancel: () => true }),
    peekPrivatePeerNextId: () => 1,
    tryCancelPrivatePending: () => true,
    invalidatePrivatePeerOnObserverTimeout: () => {},
  }
}

function prov(posted: unknown[], opts: { active?: string; managed?: string[]; reader?: unknown }): Prov {
  const p = Object.create(AgentManagerProvider.prototype) as unknown as Record<string, unknown> as Prov & {
    host: unknown
    connectionService: unknown
    coordinator: unknown
    panel: unknown
    timing: unknown
    recentOps: unknown
  }
  p.managedSessions = new Map((opts?.managed ?? []).map((id) => [id, { id }]))
  p.tabOrder = { local: [...(opts?.managed ?? [])] }
  p.activeSessionId = opts?.active
  ;(p as unknown as Record<string, unknown>)["LOCAL"] = "local"
  ;(p as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>()
  ;(p as unknown as Record<string, unknown>)["accumulatedCatalog"] = undefined
  ;(p as unknown as Record<string, unknown>)["catalogTombstone"] = new Set<string>()
  ;(p as unknown as Record<string, unknown>)["panelSessions"] = new Set<string>()
  ;(p as unknown as Record<string, unknown>)["host"] = { workspaceStore: store() }
  ;(p as unknown as Record<string, unknown>)["connectionService"] = connFor(opts.reader)
  const r = opts.reader as { isEnabled?: () => boolean } | undefined
  ;(p as unknown as Record<string, unknown>)["coordinator"] = r
    ? { observationReader: () => r }
    : undefined
  ;(p as unknown as Record<string, unknown>)["timing"] = { forget: mock(() => undefined) }
  ;(p as unknown as Record<string, unknown>)["recentOps"] = undefined
  const track: string[] = []
  const registered: unknown[] = []
  ;(p as unknown as Record<string, unknown>)["panel"] = {
    postMessage: (m: unknown) => posted.push(m),
    sessions: {
      trackSession: (id: string) => track.push(id),
      registerSession: (s: unknown) => registered.push(s),
      refreshSessions: async () => {},
      dispose: () => {},
    },
  }
  ;(p as unknown as Record<string, unknown>)["_track"] = track
  ;(p as unknown as Record<string, unknown>)["_registered"] = registered
  p.getRoot = () => "/repo"
  p.schedulePersist = mock(() => undefined) as unknown as () => void
  p.pushState = mock(() => undefined) as unknown as () => void
  p.postToWebview = ((m: unknown) => posted.push(m)) as unknown as (m: unknown) => void
  p.log = mock(() => undefined) as unknown as (...a: unknown[]) => void
  return p
}

describe("AgentManager known-child pending adoption", () => {
  it("known-child pending adopts ID-only tab without active switch, register, or sessionForked", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_src", managed: ["ses_src"], reader: readerFor({ childId: "ses_fork_child1", withGet: true }) })
    await p.onForkSession("ses_src")
    expect(p.managedSessions.has("ses_fork_child1")).toBe(true)
    expect(p.managedSessions.get("ses_fork_child1")).toEqual({ id: "ses_fork_child1" })
    expect(p.recentSessions.has("ses_fork_child1")).toBe(true)
    expect(p.tabOrder["local"]).toContain("ses_fork_child1")
    expect(p.activeSessionId).toBe("ses_src")
    const reg = (p as unknown as Record<string, unknown>)["_registered"] as unknown[]
    expect(reg.length).toBe(0)
    const types = posted.map((m) => (m as { type?: string }).type)
    expect(types).not.toContain("agentManager.sessionForked")
    expect(types).toContain("error")
  })

  it("known-child pending with reader.get unavailable still adopts via exact op projection for later catalog hydration", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_src", managed: ["ses_src"], reader: readerFor({ childId: "ses_fork_noget", withGet: false }) })
    await p.onForkSession("ses_src")
    expect(p.managedSessions.has("ses_fork_noget")).toBe(true)
    expect(p.recentSessions.has("ses_fork_noget")).toBe(true)
    expect(p.activeSessionId).toBe("ses_src")
    const reg = (p as unknown as Record<string, unknown>)["_registered"] as unknown[]
    expect(reg.length).toBe(0)
    p.onCatalogUpdate({ ids: ["ses_src", "ses_fork_noget"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_fork_noget")).toBe(true)
    expect(p.recentSessions.has("ses_fork_noget")).toBe(false)
  })

  it("known-child pending with no prior active does not switch active to child", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { managed: ["ses_src"], reader: readerFor({ childId: "ses_fork_child2", withGet: true }) })
    p.activeSessionId = undefined
    await p.onForkSession("ses_src")
    expect(p.managedSessions.has("ses_fork_child2")).toBe(true)
    expect(p.activeSessionId).toBeUndefined()
  })

  it("unknown pending stays unresolved with no adoption", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_src", managed: ["ses_src"], reader: readerFor({ withGet: true }) })
    await p.onForkSession("ses_src")
    expect(p.managedSessions.has("ses_src")).toBe(true)
    expect(p.managedSessions.size).toBe(1)
    expect(p.recentSessions.size).toBe(0)
    expect(p.activeSessionId).toBe("ses_src")
    expect(p.tabOrder["local"]).toEqual(["ses_src"])
    const types = posted.map((m) => (m as { type?: string }).type)
    expect(types).toContain("error")
    expect(types).not.toContain("agentManager.sessionForked")
  })

  it("no duplicate tabs on repeated known-child pending", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_src", managed: ["ses_src"], reader: readerFor({ childId: "ses_fork_dup", withGet: true }) })
    await p.onForkSession("ses_src")
    await p.onForkSession("ses_src")
    const order = p.tabOrder["local"] ?? []
    expect(order.filter((id) => id === "ses_fork_dup").length).toBe(1)
    expect(p.activeSessionId).toBe("ses_src")
    expect(p.managedSessions.size).toBe(2)
  })

  it("full catalog converges legitimate child and consumes recent; later omission prunes", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_src", managed: ["ses_src"], reader: readerFor({ childId: "ses_fork_child5", withGet: true }) })
    await p.onForkSession("ses_src")
    expect(p.recentSessions.has("ses_fork_child5")).toBe(true)
    p.onCatalogUpdate({ ids: [], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_fork_child5")).toBe(true)
    p.onCatalogUpdate({ ids: ["ses_src", "ses_fork_child5"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_fork_child5")).toBe(true)
    expect(p.recentSessions.has("ses_fork_child5")).toBe(false)
    expect(p.tabOrder["local"]).toContain("ses_fork_child5")
    p.onCatalogUpdate({ ids: ["ses_src"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_fork_child5")).toBe(false)
  })

  it("actual deletion prunes adopted pending child even while recent protects", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_src", managed: ["ses_src"], reader: readerFor({ childId: "ses_fork_child6", withGet: true }) })
    await p.onForkSession("ses_src")
    expect(p.managedSessions.has("ses_fork_child6")).toBe(true)
    p.onSessionDeleted({ properties: { sessionID: "ses_fork_child6" } } as unknown)
    expect(p.managedSessions.has("ses_fork_child6")).toBe(false)
    expect(p.recentSessions.has("ses_fork_child6")).toBe(false)
    expect(p.tabOrder["local"]).not.toContain("ses_fork_child6")
    expect(p.activeSessionId).toBe("ses_src")
    p.onCatalogUpdate({ ids: ["ses_src", "ses_fork_child6"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_fork_child6")).toBe(false)
  })

  it("notification lost then reconnect full catalog makes child visible/openable", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_src", managed: ["ses_src"], reader: readerFor({ childId: "ses_fork_child7", withGet: true }) })
    await p.onForkSession("ses_src")
    p.onCatalogUpdate({ ids: ["ses_src"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_fork_child7")).toBe(true)
    expect(p.recentSessions.has("ses_fork_child7")).toBe(true)
    p.onCatalogUpdate({ ids: ["ses_src", "ses_fork_child7"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_fork_child7")).toBe(true)
    expect(p.recentSessions.has("ses_fork_child7")).toBe(false)
    expect(p.tabOrder["local"]).toEqual(["ses_src", "ses_fork_child7"])
    expect(p.activeSessionId).toBe("ses_src")
  })
})
