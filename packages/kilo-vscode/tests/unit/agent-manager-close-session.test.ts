import { describe, expect, it, mock } from "bun:test"

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

type Manager = {
  connectionService: { getClient: () => unknown }
  managedSessions: Map<string, unknown>
  panelSessions: Set<string>
  timing: { forget: (sessionId: string) => void }
  getRoot: () => string
  pushState: () => void
  log: (...args: unknown[]) => void
  onCloseSession: (sessionId: string) => Promise<void>
}

function createManager() {
  const stopped: unknown[] = []
  const events: string[] = []
  const client = {
    backgroundProcess: {
      stopSession: mock(async (params: unknown) => {
        stopped.push(params)
        events.push("processes")
        return { data: {} }
      }),
    },
  }
  const manager = Object.create(AgentManagerProvider.prototype) as Manager
  manager.connectionService = { getClient: () => client }
  manager.managedSessions = new Map([["s1", { id: "s1" }]])
  manager.panelSessions = new Set(["s1"])
  manager.timing = { forget: mock(() => undefined) }
  manager.getRoot = () => "/repo"
  manager.pushState = mock(() => undefined)
  manager.log = mock(() => undefined)
  ;(manager as unknown as Record<string, unknown>)["LOCAL"] = "local"
  ;(manager as unknown as Record<string, unknown>)["tabOrder"] = { ["local"]: ["s1"] }
  ;(manager as unknown as Record<string, unknown>)["activeSessionId"] = "s1"
  ;(manager as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>()
  ;(manager as unknown as Record<string, unknown>)["accumulatedCatalog"] = undefined
  ;(manager as unknown as Record<string, unknown>)["accumulatedHasMore"] = undefined
  ;(manager as unknown as Record<string, unknown>)["schedulePersist"] = mock(() => undefined)
  ;(manager as unknown as Record<string, unknown>)["host"] = { workspaceStore: { get: () => undefined, update: () => Promise.resolve() } } as unknown as Record<string, unknown>

  return { manager, stopped, events }
}

describe("AgentManagerProvider closeSession", () => {
  it("stops background processes and removes from managed state", async () => {
    const { manager, stopped, events } = createManager()

    await manager.onCloseSession("s1")

    expect(stopped).toEqual([{ sessionID: "s1", directory: "/repo" }])
    expect(events).toEqual(["processes"])
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.panelSessions.has("s1")).toBe(false)
    expect(manager.pushState).toHaveBeenCalled()
    expect(manager.timing.forget).not.toHaveBeenCalled()
  })

  it("commits durable eviction and state push before a delayed stop resolves", async () => {
    let release!: () => void
    const gate = new Promise<{ data: object }>((resolve) => {
      release = () => resolve({ data: {} })
    })
    const client = { backgroundProcess: { stopSession: mock(() => gate) } }
    const manager = Object.create(AgentManagerProvider.prototype) as Manager
    manager.connectionService = { getClient: () => client }
    manager.managedSessions = new Map([["s1", { id: "s1" }]])
    manager.panelSessions = new Set(["s1"])
    manager.timing = { forget: mock(() => undefined) }
    manager.getRoot = () => "/repo"
    manager.pushState = mock(() => undefined)
    manager.log = mock(() => undefined)
    ;(manager as unknown as Record<string, unknown>)["LOCAL"] = "local"
    ;(manager as unknown as Record<string, unknown>)["tabOrder"] = { ["local"]: ["s1"] }
    ;(manager as unknown as Record<string, unknown>)["activeSessionId"] = "s1"
    ;(manager as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>(["s1"])
    ;(manager as unknown as Record<string, unknown>)["schedulePersist"] = mock(() => undefined)
    ;(manager as unknown as Record<string, unknown>)["host"] = { workspaceStore: { get: () => undefined, update: () => Promise.resolve() } } as unknown as Record<string, unknown>

    const closing = manager.onCloseSession("s1")
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.panelSessions.has("s1")).toBe(false)
    expect((manager as unknown as Record<string, unknown>)["tabOrder"]).toEqual({ ["local"]: [] })
    expect(manager.pushState).toHaveBeenCalledTimes(1)
    expect((manager as unknown as Record<string, unknown>)["schedulePersist"]).toHaveBeenCalledTimes(1)
    release()
    await closing
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.pushState).toHaveBeenCalledTimes(1)
    expect(manager.timing.forget).not.toHaveBeenCalled()
  })

  it("handles stopSessionProcesses failure gracefully", async () => {
    const events: string[] = []
    const client = {
      backgroundProcess: {
        stopSession: mock(async () => {
          events.push("processes")
          throw new Error("backend not ready")
        }),
      },
    }
    const manager = Object.create(AgentManagerProvider.prototype) as Manager
    manager.connectionService = { getClient: () => client }
    manager.managedSessions = new Map([["s1", { id: "s1" }]])
    manager.panelSessions = new Set(["s1"])
    manager.timing = { forget: mock(() => undefined) }
    manager.getRoot = () => "/repo"
    manager.pushState = mock(() => undefined)
    manager.log = mock(() => undefined)
    ;(manager as unknown as Record<string, unknown>)["LOCAL"] = "local"
    ;(manager as unknown as Record<string, unknown>)["tabOrder"] = { ["local"]: ["s1"] }
    ;(manager as unknown as Record<string, unknown>)["activeSessionId"] = "s1"
    ;(manager as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>()
    ;(manager as unknown as Record<string, unknown>)["accumulatedCatalog"] = undefined
    ;(manager as unknown as Record<string, unknown>)["accumulatedHasMore"] = undefined
    ;(manager as unknown as Record<string, unknown>)["schedulePersist"] = mock(() => undefined)
    ;(manager as unknown as Record<string, unknown>)["host"] = { workspaceStore: { get: () => undefined, update: () => Promise.resolve() } } as unknown as Record<string, unknown>

    await manager.onCloseSession("s1")

    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.panelSessions.has("s1")).toBe(false)
    expect(manager.pushState).toHaveBeenCalled()
    expect(manager.timing.forget).not.toHaveBeenCalled()
  })

  it("keeps committed state when the delayed stop rejects", async () => {
    let rejectStop!: (err: Error) => void
    const gate = new Promise<{ data: object }>((_, reject) => {
      rejectStop = reject
    })
    const client = { backgroundProcess: { stopSession: mock(() => gate) } }
    const manager = Object.create(AgentManagerProvider.prototype) as Manager
    manager.connectionService = { getClient: () => client }
    manager.managedSessions = new Map([["s1", { id: "s1" }]])
    manager.panelSessions = new Set(["s1"])
    manager.timing = { forget: mock(() => undefined) }
    manager.getRoot = () => "/repo"
    manager.pushState = mock(() => undefined)
    manager.log = mock(() => undefined)
    ;(manager as unknown as Record<string, unknown>)["LOCAL"] = "local"
    ;(manager as unknown as Record<string, unknown>)["tabOrder"] = { ["local"]: ["s1"] }
    ;(manager as unknown as Record<string, unknown>)["activeSessionId"] = "s1"
    ;(manager as unknown as Record<string, unknown>)["recentSessions"] = new Set<string>(["s1"])
    ;(manager as unknown as Record<string, unknown>)["schedulePersist"] = mock(() => undefined)
    ;(manager as unknown as Record<string, unknown>)["host"] = { workspaceStore: { get: () => undefined, update: () => Promise.resolve() } } as unknown as Record<string, unknown>

    const closing = manager.onCloseSession("s1")
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.pushState).toHaveBeenCalledTimes(1)
    rejectStop(new Error("stop failed"))
    await closing
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.pushState).toHaveBeenCalledTimes(1)
    expect(manager.timing.forget).not.toHaveBeenCalled()
  })
})
