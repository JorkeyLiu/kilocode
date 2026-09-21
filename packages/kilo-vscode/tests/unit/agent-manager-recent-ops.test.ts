import { describe, expect, it, mock } from "bun:test"

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

type Prov = {
  recentOps: Map<string, { opId: string; outcome: string; code: string; message: string; time: number }>
  managedSessions: Map<string, { id: string }>
  tabOrder: Record<string, string[]>
  activeSessionId?: string
  recentSessions: Set<string>
  timing: { forget: (id: string) => void }
  getRoot: () => string | undefined
  coordinator: unknown
  pushState: () => void
  schedulePersist: () => void
  log: (...a: unknown[]) => void
  connectionService: { getClient: () => unknown }
  onSessionMessage: (m: Record<string, unknown>, msg: Record<string, unknown>) => unknown
  onCloseSession: (id: string) => Promise<void>
  onSessionDeleted: (e: unknown) => void
  fetchRecentOps: (ids: string[]) => Promise<void>
  pruneRecentOps: (ids: Set<string>) => boolean
  reconcile: (ids: string[]) => void
  panel?: unknown
  panelSessions: Set<string>
}

function makeProvider(over?: Partial<Prov>): Prov {
  const p = Object.create(AgentManagerProvider.prototype) as Prov
  p.recentOps = new Map()
  p.managedSessions = new Map([["ses_a", { id: "ses_a" }]])
  p.tabOrder = { local: ["ses_a"] }
  p.activeSessionId = "ses_a"
  p.recentSessions = new Set<string>()
  p.timing = { forget: mock(() => undefined) }
  p.getRoot = () => "/repo"
  p.coordinator = null
  p.pushState = mock(() => undefined)
  p.schedulePersist = mock(() => undefined)
  p.log = mock(() => undefined)
  p.connectionService = { getClient: () => ({ backgroundProcess: { stopSession: mock(async () => ({ data: {} })) } }) }
  p.panelSessions = new Set<string>(["ses_a"])
  Object.assign(p, over)
  if (!p.panel) p.panel = undefined
  return p
}

describe("AgentManagerProvider recentOps cleanup", () => {
  it("forgetSession deletes recentOps entry", () => {
    const p = makeProvider()
    p.recentOps.set("ses_a", { opId: "op1", outcome: "failed", code: "E1", message: "m", time: 1 })
    p.onSessionMessage({ type: "agentManager.forgetSession", sessionId: "ses_a" }, {})
    expect(p.recentOps.has("ses_a")).toBe(false)
    expect(p.managedSessions.has("ses_a")).toBe(false)
  })

  it("onCloseSession deletes recentOps when session no longer displayed", async () => {
    const p = makeProvider()
    p.recentOps.set("ses_a", { opId: "op1", outcome: "in-flight", code: "C", message: "m", time: 2 })
    await p.onCloseSession("ses_a")
    expect(p.recentOps.has("ses_a")).toBe(false)
    expect(p.managedSessions.has("ses_a")).toBe(false)
  })

  it("fetchRecentOps not_found deletes entry", async () => {
    const p = makeProvider()
    p.recentOps.set("ses_a", { opId: "op1", outcome: "failed", code: "E", message: "m", time: 1 })
    p.coordinator = {
      observationReader: () => ({
        isEnabled: () => true,
        isStarted: () => true,
        operations: async () => ({ v: "1.0", status: "not_found" }),
      }),
    } as unknown as Prov["coordinator"]
    await p.fetchRecentOps(["ses_a"])
    expect(p.recentOps.has("ses_a")).toBe(false)
  })

  it("fetchRecentOps scope_mismatch deletes entry", async () => {
    const p = makeProvider()
    p.recentOps.set("ses_b", { opId: "op2", outcome: "failed", code: "E", message: "m", time: 1 })
    p.managedSessions.set("ses_b", { id: "ses_b" })
    p.coordinator = {
      observationReader: () => ({
        isEnabled: () => true,
        isStarted: () => true,
        operations: async () => ({ v: "1.0", status: "scope_mismatch" }),
      }),
    } as unknown as Prov["coordinator"]
    await p.fetchRecentOps(["ses_b"])
    expect(p.recentOps.has("ses_b")).toBe(false)
  })

  it("fetchRecentOps found empty deletes and found with detail/stack is ignored", async () => {
    const p = makeProvider()
    p.recentOps.set("ses_a", { opId: "op1", outcome: "failed", code: "E", message: "m", time: 1 })
    // empty deletes
    p.coordinator = {
      observationReader: () => ({
        isEnabled: () => true,
        isStarted: () => true,
        operations: async () => ({ v: "1.0", status: "found", operations: [] }),
      }),
    } as unknown as Prov["coordinator"]
    await p.fetchRecentOps(["ses_a"])
    expect(p.recentOps.has("ses_a")).toBe(false)

    // detail/stack payload must not be stored
    p.coordinator = {
      observationReader: () => ({
        isEnabled: () => true,
        isStarted: () => true,
        operations: async () => ({
          v: "1.0",
          status: "found",
          operations: [{ opId: "op1", outcome: "failed", code: "E", message: "m", time: 1, detail: "secret", stack: "trace" }],
        }),
      }),
    } as unknown as Prov["coordinator"]
    await p.fetchRecentOps(["ses_a"])
    expect(p.recentOps.has("ses_a")).toBe(false)
  })

  it("fetchRecentOps found valid stores single entry per session", async () => {
    const p = makeProvider()
    p.coordinator = {
      observationReader: () => ({
        isEnabled: () => true,
        isStarted: () => true,
        operations: async () => ({
          v: "1.0",
          status: "found",
          operations: [{ opId: "opX", outcome: "failed", code: "E2", message: "boom", time: 123 }],
        }),
      }),
    } as unknown as Prov["coordinator"]
    await p.fetchRecentOps(["ses_a"])
    expect(p.recentOps.get("ses_a")).toEqual({ opId: "opX", outcome: "failed", code: "E2", message: "boom", time: 123 })
    // second fetch with different opId should replace, keeping single entry
    p.coordinator = {
      observationReader: () => ({
        isEnabled: () => true,
        isStarted: () => true,
        operations: async () => ({
          v: "1.0",
          status: "found",
          operations: [{ opId: "opY", outcome: "in-flight", code: "C", message: "run", time: 456 }],
        }),
      }),
    } as unknown as Prov["coordinator"]
    await p.fetchRecentOps(["ses_a"])
    expect(p.recentOps.size).toBe(1)
    expect(p.recentOps.get("ses_a")?.opId).toBe("opY")
  })

  it("onSessionDeleted and reconcile prune recentOps", () => {
    const p = makeProvider()
    p.recentOps.set("ses_a", { opId: "op1", outcome: "failed", code: "E", message: "m", time: 1 })
    p.recentOps.set("ses_z", { opId: "opZ", outcome: "failed", code: "E", message: "m", time: 1 })
    p.managedSessions.set("ses_z", { id: "ses_z" })
    // deleted event should purge
    p.onSessionDeleted({ type: "session.deleted", properties: { sessionID: "ses_a" } })
    expect(p.recentOps.has("ses_a")).toBe(false)
    expect(p.recentOps.has("ses_z")).toBe(true)
    // reconcile with catalog missing ses_z should prune
    ;(p as unknown as Record<string, unknown>)["accumulatedCatalog"] = undefined
    ;(p as unknown as Record<string, unknown>)["catalogTombstone"] = new Set<string>()
    p.reconcile([])
    expect(p.recentOps.has("ses_z")).toBe(false)
  })

  it("refreshRecentOpsForCurrent is removed", () => {
    const p = makeProvider() as unknown as Record<string, unknown>
    expect(p["refreshRecentOpsForCurrent"]).toBeUndefined()
  })
})
