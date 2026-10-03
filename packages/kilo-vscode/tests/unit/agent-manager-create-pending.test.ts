import { describe, expect, it, mock } from "bun:test"

mock.module("../../src/shared/sandbox-session", () => ({
  sandboxSessionMetadata: async () => ({}),
  sandboxMetadata: (enabled: boolean, metadata?: Record<string, unknown>) => ({ ...(metadata ?? {}) }),
  sandboxDefault: async () => true,
  SANDBOX_METADATA_KEY: "kilocode.sandbox",
}))

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
  startToolRequest: (req: { requestID: string; tasks: Array<Record<string, unknown>> }) => Promise<void>
  addSession: (id: string, opts?: { recent?: boolean }) => void
  pushState: () => void
  postToWebview: (m: unknown) => void
  log: (...a: unknown[]) => void
  getRoot: () => string
  schedulePersist: () => void
  openPanel: () => void
}

function readerFor(opts: { childId?: string }) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({}),
    get: async () => ({ v: "1.0", status: "not_found" }),
    createOperation: async () => {
      if (!opts.childId) return { v: "1.0", status: "not_found" }
      return { v: "1.0", status: "found", createdSessionId: opts.childId }
    },
  }
}

function connFor() {
  return {
    getClient: () => ({}),
    sandboxPreference: undefined,
    isPrivateAvailable: () => true,
    privateCreateWithHandle: () => ({ id: 1, promise: Promise.reject(new Error("peer closed")), cancel: () => true }),
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
  ;(p as unknown as Record<string, unknown>)["toolRequests"] = new Set<string>()
  ;(p as unknown as Record<string, unknown>)["stateReady"] = undefined
  ;(p as unknown as Record<string, unknown>)["host"] = {
    workspaceStore: store(),
    capture: mock(() => undefined),
    showError: mock(() => undefined),
    openPanel: mock(() => undefined),
  }
  ;(p as unknown as Record<string, unknown>)["connectionService"] = connFor()
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
  p.openPanel = mock(() => undefined) as unknown as () => void
  p.schedulePersist = mock(() => undefined) as unknown as () => void
  p.pushState = mock(() => undefined) as unknown as () => void
  p.postToWebview = ((m: unknown) => posted.push(m)) as unknown as (m: unknown) => void
  p.log = mock(() => undefined) as unknown as (...a: unknown[]) => void
  return p
}

function types(posted: unknown[]): Array<string | undefined> {
  return posted.map((m) => (m as { type?: string }).type)
}

describe("AgentManager pending create adopts known ID without active switch or success signal", () => {
  it("existing active preserved, ID-only tab, no sessionAdded/register, error only", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_existing", managed: ["ses_existing"], reader: readerFor({ childId: "ses_create_child1" }) })
    await p.startToolRequest({ requestID: "req-create-1", tasks: [{}] })
    expect(p.managedSessions.has("ses_create_child1")).toBe(true)
    expect(p.managedSessions.get("ses_create_child1")).toEqual({ id: "ses_create_child1" })
    expect(p.recentSessions.has("ses_create_child1")).toBe(true)
    expect(p.tabOrder["local"]).toContain("ses_create_child1")
    expect(p.activeSessionId).toBe("ses_existing")
    const reg = (p as unknown as Record<string, unknown>)["_registered"] as unknown[]
    expect(reg.length).toBe(0)
    expect(types(posted)).not.toContain("agentManager.sessionAdded")
    expect(types(posted)).not.toContain("sessionCreated")
    expect(types(posted)).toContain("error")
  })

  it("no current active stays undefined while adopting known ID", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { managed: [], reader: readerFor({ childId: "ses_create_child2" }) })
    p.activeSessionId = undefined
    await p.startToolRequest({ requestID: "req-create-2", tasks: [{}] })
    expect(p.managedSessions.has("ses_create_child2")).toBe(true)
    expect(p.activeSessionId).toBeUndefined()
    expect(types(posted)).not.toContain("agentManager.sessionAdded")
    expect(types(posted)).toContain("error")
  })

  it("unknown pending adopts nothing and switches nothing", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_existing", managed: ["ses_existing"], reader: readerFor({}) })
    await p.startToolRequest({ requestID: "req-create-3", tasks: [{}] })
    expect(p.managedSessions.size).toBe(1)
    expect(p.managedSessions.has("ses_existing")).toBe(true)
    expect(p.recentSessions.size).toBe(0)
    expect(p.activeSessionId).toBe("ses_existing")
    expect(p.tabOrder["local"]).toEqual(["ses_existing"])
    expect(types(posted)).toContain("error")
    expect(types(posted)).not.toContain("agentManager.sessionAdded")
  })

  it("duplicate pending create does not duplicate tabs or switch active", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_existing", managed: ["ses_existing"], reader: readerFor({ childId: "ses_create_dup" }) })
    await p.startToolRequest({ requestID: "req-create-4a", tasks: [{}] })
    await p.startToolRequest({ requestID: "req-create-4b", tasks: [{}] })
    const order = p.tabOrder["local"] ?? []
    expect(order.filter((id) => id === "ses_create_dup").length).toBe(1)
    expect(p.activeSessionId).toBe("ses_existing")
    expect(p.managedSessions.size).toBe(2)
    expect(types(posted)).not.toContain("agentManager.sessionAdded")
  })

  it("reconnect catalog converges pending child and consumes recent without active switch", async () => {
    const posted: unknown[] = []
    const p = prov(posted, { active: "ses_existing", managed: ["ses_existing"], reader: readerFor({ childId: "ses_create_child7" }) })
    await p.startToolRequest({ requestID: "req-create-5", tasks: [{}] })
    expect(p.recentSessions.has("ses_create_child7")).toBe(true)
    p.onCatalogUpdate({ ids: ["ses_existing"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_create_child7")).toBe(true)
    expect(p.recentSessions.has("ses_create_child7")).toBe(true)
    p.onCatalogUpdate({ ids: ["ses_existing", "ses_create_child7"], append: false, hasMore: false })
    expect(p.managedSessions.has("ses_create_child7")).toBe(true)
    expect(p.recentSessions.has("ses_create_child7")).toBe(false)
    expect(p.tabOrder["local"]).toEqual(["ses_existing", "ses_create_child7"])
    expect(p.activeSessionId).toBe("ses_existing")
    expect(types(posted)).not.toContain("agentManager.sessionAdded")
  })
})
