import { describe, expect, it, mock } from "bun:test"

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

type Manager = {
  connectionService: { getClient: () => unknown }
  managedSessions: Map<string, unknown>
  panelSessions: Set<string>
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
  manager.getRoot = () => "/repo"
  manager.pushState = mock(() => undefined)
  manager.log = mock(() => undefined)

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
    manager.getRoot = () => "/repo"
    manager.pushState = mock(() => undefined)
    manager.log = mock(() => undefined)

    await manager.onCloseSession("s1")

    // Should still clean up even when stop fails
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.panelSessions.has("s1")).toBe(false)
    expect(manager.pushState).toHaveBeenCalled()
  })
})
