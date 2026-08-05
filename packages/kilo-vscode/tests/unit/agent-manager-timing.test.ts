import { describe, expect, it, mock } from "bun:test"
import { SessionTiming, TIMING_KEY } from "../../src/agent-manager/session-timing"
import type { Store } from "../../src/agent-manager/host"

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

function fakeStore(initial?: unknown): { store: Store; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  if (initial !== undefined) data.set(TIMING_KEY, initial)
  const store: Store = {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: (key, value) => {
      data.set(key, value)
      return Promise.resolve()
    },
  }
  return { store, data }
}

type Timing = {
  onStatus: (sid: string, status: string) => boolean
  forget: (sid: string) => void
  settle: () => Promise<void>
  snapshot: () => Record<string, unknown>
}

function timingStub(): Timing {
  return {
    onStatus: mock(() => true),
    forget: mock(() => undefined),
    settle: mock(async () => undefined),
    snapshot: () => ({ s1: { elapsedMs: 120 } }),
  }
}

type Manager = {
  timing: Timing
  panel: { postMessage: (msg: unknown) => void } | undefined
  managedSessions: Map<string, { id: string }>
  panelSessions: Set<string>
  pushState: () => void
  log: (...args: unknown[]) => void
  onSessionStatus: (event: unknown) => void
  onSessionDeleted: (event: unknown) => void
  onCloseSession: (sessionId: string) => Promise<void>
  onSessionMessage: (m: Record<string, unknown>, msg: Record<string, unknown>) => unknown
  disposeAsync: () => Promise<void>
  run: { state: () => Record<string, unknown> }
  statsPoller: { setEnabled: (enabled: boolean) => void }
}

type DisposeManager = {
  stateReady?: Promise<void>
  timing: Timing
  unsubTool?: () => void
  unsubStatus?: () => void
  unsubDeleted?: () => void
  unsubFont?: () => void
  visiblePresence: { clear: () => void }
  statsPoller: { stop: () => void }
  gitOps: { dispose: () => void }
  run: { dispose: () => void }
  terminalManager: { dispose: () => void }
  terminalRouter: { dispose: () => Promise<void> }
  panel: unknown
  outputChannel: { dispose: () => void }
  host: { dispose: () => void }
  disposeAsync: () => Promise<void>
}

function createManager() {
  const manager = Object.create(AgentManagerProvider.prototype) as Manager
  manager.timing = timingStub()
  manager.panel = undefined
  manager.managedSessions = new Map([["s1", { id: "s1" }]])
  manager.panelSessions = new Set(["s1"])
  manager.pushState = mock(() => undefined)
  manager.log = mock(() => undefined)
  manager.run = { state: () => ({}) }
  manager.statsPoller = { setEnabled: mock(() => undefined) }
  return manager
}

function createDisposeManager(): DisposeManager {
  const manager = Object.create(AgentManagerProvider.prototype) as DisposeManager
  manager.timing = timingStub()
  manager.visiblePresence = { clear: mock(() => undefined) }
  manager.statsPoller = { stop: mock(() => undefined) }
  manager.gitOps = { dispose: mock(() => undefined) }
  manager.run = { dispose: mock(() => undefined) }
  manager.terminalManager = { dispose: mock(() => undefined) }
  manager.terminalRouter = { dispose: mock(async () => undefined) }
  manager.outputChannel = { dispose: mock(() => undefined) }
  manager.host = { dispose: mock(() => undefined) }
  return manager
}

describe("AgentManagerProvider timing wiring", () => {
  it("applies session.status events and pushes fresh state", () => {
    const manager = createManager()
    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "busy" } } })
    expect(manager.timing.onStatus).toHaveBeenCalledWith("s1", "busy")
    expect(manager.pushState).toHaveBeenCalled()
  })

  it("still records status events when the panel is closed", () => {
    const manager = createManager()
    manager.panel = undefined
    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "idle" } } })
    expect(manager.timing.onStatus).toHaveBeenCalledWith("s1", "idle")
    // postMessage on a closed panel is a no-op, never a throw.
  })

  it("ignores malformed status events", () => {
    const manager = createManager()
    manager.onSessionStatus({ properties: {} })
    manager.onSessionStatus({})
    expect(manager.timing.onStatus).not.toHaveBeenCalled()
  })

  it("does not push state when onStatus reports no timing change", () => {
    const manager = createManager()
    manager.timing.onStatus = mock(() => false)
    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "busy" } } })
    expect(manager.timing.onStatus).toHaveBeenCalledWith("s1", "busy")
    expect(manager.pushState).not.toHaveBeenCalled()
  })

  it("duplicate active/idle events push no state; true transitions still push", () => {
    const manager = Object.create(AgentManagerProvider.prototype) as Manager
    manager.timing = new SessionTiming(fakeStore().store, () => 1_000_000)
    manager.managedSessions = new Map([["s1", { id: "s1" }]])
    manager.panelSessions = new Set(["s1"])
    manager.pushState = mock(() => undefined)
    manager.log = mock(() => undefined)
    manager.run = { state: () => ({}) }
    manager.statsPoller = { setEnabled: mock(() => undefined) }

    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "busy" } } })
    expect(manager.pushState).toHaveBeenCalledTimes(1)
    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "busy" } } })
    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "busy" } } })
    expect(manager.pushState).toHaveBeenCalledTimes(1)
    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "idle" } } })
    expect(manager.pushState).toHaveBeenCalledTimes(2)
    manager.onSessionStatus({ properties: { sessionID: "s1", status: { type: "idle" } } })
    expect(manager.pushState).toHaveBeenCalledTimes(2)
  })

  it("prunes the correct timing entry on a transient session.deleted event", async () => {
    const store = fakeStore()
    const manager = Object.create(AgentManagerProvider.prototype) as Manager
    manager.timing = new SessionTiming(store.store, () => 1_000_000)
    manager.timing.onStatus("s1", "busy")
    manager.timing.onStatus("s2", "busy")
    manager.managedSessions = new Map([
      ["s1", { id: "s1" }],
      ["s2", { id: "s2" }],
    ])
    manager.panelSessions = new Set(["s1", "s2"])
    manager.pushState = mock(() => undefined)
    manager.log = mock(() => undefined)
    manager.run = { state: () => ({}) }
    manager.statsPoller = { setEnabled: mock(() => undefined) }

    // The backend emits transient {type:'session.deleted',
    // properties:{sessionID}} without any managed-session participation; the
    // named handler must still prune exactly that entry.
    manager.onSessionDeleted({ type: "session.deleted", properties: { sessionID: "s1" } })
    await manager.timing.wait()
    expect(manager.timing.snapshot()).toEqual({ s2: { elapsedMs: 0, activeStart: 1_000_000 } })
  })

  it("prunes timing when a session is forgotten", () => {
    const manager = createManager()
    manager.onSessionMessage({ type: "agentManager.forgetSession", sessionId: "s1" }, {})
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.timing.forget).toHaveBeenCalledWith("s1")
  })

  it("prunes timing when a session is closed", async () => {
    const manager = createManager()
    manager.onCloseSession = async (sessionId: string) => {
      manager.managedSessions.delete(sessionId)
      manager.timing.forget(sessionId)
      manager.pushState()
    }
    await manager.onCloseSession("s1")
    expect(manager.managedSessions.has("s1")).toBe(false)
    expect(manager.timing.forget).toHaveBeenCalledWith("s1")
  })

  it("settles timing during the real extension-shutdown dispose path", async () => {
    const manager = createDisposeManager()
    await manager.disposeAsync()
    expect(manager.timing.settle).toHaveBeenCalled()
  })

  it("unsubscribes timing-mutating listeners before settling on shutdown", async () => {
    // LOCK-002: a session.status/session.deleted event arriving while settle
    // awaits its durable write could re-open a segment and persist downtime as
    // runtime. The status and deleted listeners must be detached first.
    const manager = createDisposeManager()
    const order: string[] = []
    manager.unsubStatus = () => order.push("unsubStatus")
    manager.unsubDeleted = () => order.push("unsubDeleted")
    manager.timing.settle = mock(async () => order.push("settle"))
    await manager.disposeAsync()
    expect(order).toEqual(["unsubStatus", "unsubDeleted", "settle"])
  })

  it("pushState carries the current timing snapshot to the panel", () => {
    // The webview bootstraps timing from agentManager.state, so the real
    // pushState must include the full snapshot map.
    const captured: unknown[] = []
    const manager = Object.create(AgentManagerProvider.prototype) as Manager
    manager.timing = new SessionTiming(fakeStore().store, () => 1_000_000)
    manager.timing.onStatus("s1", "busy")
    manager.panel = { postMessage: (msg) => captured.push(msg) }
    manager.managedSessions = new Map([["s1", { id: "s1" }]])
    manager.panelSessions = new Set(["s1"])
    manager.pushState = () => {
      const proto = AgentManagerProvider.prototype as unknown as { pushState: (this: Manager) => void }
      proto.pushState.call(manager)
    }
    manager.log = mock(() => undefined)
    manager.run = { state: () => ({}) }
    manager.statsPoller = { setEnabled: mock(() => undefined) }
    manager.pushState()
    const msg = captured[0] as { type: string; timing?: Record<string, { elapsedMs: number; activeStart?: number }> }
    expect(msg.type).toBe("agentManager.state")
    expect(msg.timing).toEqual({ s1: { elapsedMs: 0, activeStart: 1_000_000 } })
  })
})
