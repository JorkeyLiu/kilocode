import { describe, it, expect, mock } from "bun:test"

mock.module("../../src/agent-manager/terminal-host", () => ({
  createTerminalHost: () => ({
    createTerminal: () => ({ show: () => {}, dispose: () => {}, exitStatus: undefined }),
    activeTerminal: () => undefined,
    repoPath: () => "/tmp",
    showWarning: () => {},
    setContext: () => {},
    onTerminalClosed: () => ({ dispose: () => {} }),
    onActiveTerminalChanged: () => ({ dispose: () => {} }),
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => {},
  }),
}))
mock.module("../../src/agent-manager/terminal-font", () => ({
  readTerminalFont: () => undefined,
  watchTerminalFont: () => () => {},
}))

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")

type ConnState = "connecting" | "connected" | "disconnected" | "error"

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeFakeConn(initial: ConnState) {
  let state: ConnState = initial
  let listener: ((s: ConnState) => void) | undefined
  let unsubCalled = 0
  const svc: any = {
    getConnectionState: () => state,
    onStateChange: (cb: (s: ConnState) => void) => {
      listener = cb
      return () => {
        unsubCalled++
        if (listener === cb) listener = undefined
      }
    },
    onEventFiltered: () => () => {},
    onEvent: () => () => {},
    registerVisible: () => {},
    registerAttached: () => {},
    getClient: () => {
      throw new Error("not connected")
    },
    getClientAsync: async () => {
      throw new Error("not connected")
    },
    getServerConfig: () => undefined,
    getServerInfo: () => undefined,
  }
  return {
    svc,
    getListener: () => listener,
    fire: (s: ConnState) => {
      state = s
      listener?.(s)
    },
    setState: (s: ConnState) => {
      state = s
    },
    getUnsubCalled: () => unsubCalled,
  }
}

function makeHost() {
  return {
    workspaceStore: { get: () => undefined, update: async () => {} },
    workspacePath: () => "/tmp",
    createOutput: () => ({ appendLine: () => {}, dispose: () => {} }),
    capture: () => {},
    showError: () => {},
    copyToClipboard: () => {},
    extensionKeybindings: () => [],
    openPanel: () => ({ dispose: () => {} }),
    dispose: () => {},
    serverPort: () => undefined,
    openExternal: () => {},
    openFile: () => {},
  } as any
}

function makePanel(visible: boolean, refresh: () => Promise<void>) {
  return {
    visible,
    sessions: { refreshSessions: refresh, dispose: () => {}, abortSessions: async () => {} } as any,
    postMessage: () => {},
    waitForReady: async () => {},
    waitForActive: async () => {},
    reveal: () => {},
    active: true,
    dispose: () => {},
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
  } as any
}

describe("AgentManagerProvider SSE reconnect convergence — seenConnected baseline", () => {
  it("first disconnected->connecting->connected never triggers even if hydration completes mid-connect", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    let refreshCount = 0
    const panel = makePanel(true, async () => {
      refreshCount++
    })
    provider.panel = panel
    provider.generation = 1
    provider.hydrated = false
    const d = deferred<void>()
    provider.stateReady = d.promise
    expect(provider.seenConnected).toBe(false)
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    provider.hydrated = true
    d.resolve()
    await d.promise
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    expect(provider.seenConnected).toBe(true)
    expect(provider.prevConnectionState).toBe("connected")
    await provider.shutdown()
  })

  it("constructed connected then error->connecting->connected triggers", async () => {
    const conn = makeFakeConn("connected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    expect(provider.seenConnected).toBe(true)
    expect(provider.prevConnectionState).toBe("connected")
    let refreshCount = 0
    const panel = makePanel(true, async () => {
      refreshCount++
    })
    provider.panel = panel
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("error")
    expect(provider.prevConnectionState).toBe("error")
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    expect(provider.seenConnected).toBe(true)
    await provider.shutdown()
  })

  it("first connected baseline then later connecting->connected triggers exactly one", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    let refreshCount = 0
    provider.panel = makePanel(true, async () => {
      refreshCount++
    })
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    expect(provider.seenConnected).toBe(true)
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    await provider.shutdown()
  })

  it("repeated connected no trigger", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    let refreshCount = 0
    provider.panel = makePanel(true, async () => {
      refreshCount++
    })
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    expect(refreshCount).toBe(0)
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    expect(refreshCount).toBe(0)
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    expect(refreshCount).toBe(1)
    await provider.shutdown()
  })

  it("hidden at event no trigger", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    provider.panel = makePanel(true, async () => {})
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    provider.panel.visible = false
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    await provider.shutdown()
  })

  it("visible at event then hidden before stateReady no trigger", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    provider.panel = makePanel(true, async () => {})
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    const d = deferred<void>()
    provider.stateReady = d.promise
    provider.panel.visible = true
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    const gen = provider.generation
    const sess = provider.panel.sessions
    conn.fire("connecting")
    expect(provider.prevConnectionState).toBe("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 5))
    provider.panel.visible = false
    d.resolve()
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    expect(provider.generation).toBe(gen)
    expect(provider.panel.sessions).toBe(sess)
    await provider.shutdown()
  })

  it("unhydrated reconnect no trigger (subsequent requestState hydrates)", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    provider.panel = makePanel(true, async () => {})
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    provider.hydrated = false
    provider.generation = 2
    provider.panel = makePanel(true, async () => {})
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    provider.hydrated = false
    let hydrateCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      hydrateCount++
    }
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 10))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(hydrateCount).toBe(1)
    expect(provider.hydrated).toBe(true)
    await provider.shutdown()
  })

  it("concurrent reconnect+requestState/visible shares singleflight", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    provider.panel = makePanel(true, async () => {})
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
      await new Promise((r) => setTimeout(r, 40))
    }
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    provider.triggerObservationRefresh()
    provider.triggerVisibleObservationRefresh()
    await new Promise((r) => setTimeout(r, 10))
    const shared = provider.refreshPromise
    expect(shared).not.toBeNull()
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 5))
    expect(provider.refreshPromise).toBe(shared)
    if (shared) await shared
    await new Promise((r) => setTimeout(r, 10))
    expect(refreshCount).toBe(1)
    await provider.shutdown()
  })

  it("dispose unsubscribes and later events do nothing", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    let refreshCount = 0
    provider.panel = makePanel(true, async () => {
      refreshCount++
    })
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    expect(refreshCount).toBe(0)
    expect(conn.getUnsubCalled()).toBe(0)
    await provider.shutdown()
    expect(conn.getUnsubCalled()).toBe(1)
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    expect(provider.refreshPromise).toBeNull()
    expect(refreshCount).toBe(0)
    conn.fire("error")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    expect(refreshCount).toBe(0)
  })

  it("backend error->connected sequence triggers when hydrated+visible", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    provider.panel = makePanel(true, async () => {})
    provider.generation = 1
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    conn.fire("error")
    expect(provider.prevConnectionState).toBe("error")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    refreshCount = 0
    conn.fire("error")
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    await provider.shutdown()
  })

  it("attachPanel visibility true via PanelContext callback triggers visible helper with generation recheck", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    host.workspaceStore = { get: () => undefined, update: async () => {} }
    const provider: any = new AgentManagerProvider(host, conn.svc)
    // capture visibility callback registered by attachPanel
    let visibilityCb: ((v: boolean) => void) | undefined
    let disposeCb: (() => void) | undefined
    const deferredState = deferred<void>()
    // initial panel via attachPanel with visible false
    const initialSessions = { refreshSessions: async () => {}, dispose: () => {}, abortSessions: async () => {} } as any
    const panel1: any = {
      visible: false,
      active: false,
      reveal: () => {},
      sessions: initialSessions,
      postMessage: () => {},
      waitForReady: async () => {},
      waitForActive: async () => {},
      dispose: () => {
        disposeCb?.()
      },
      onDidChangeVisibility: (cb: (v: boolean) => void) => {
        visibilityCb = cb
        return { dispose: () => {} }
      },
      onDidDispose: (cb: () => void) => {
        disposeCb = cb
        return { dispose: () => {} }
      },
    }
    // Use private attachPanel to exercise real registration
    provider.attachPanel(panel1)
    expect(typeof visibilityCb).toBe("function")
    // Wait for attachPanel's initializeState to complete (sets stateReady). Overwrite stateReady with deferred for test control
    await provider.stateReady
    provider.stateReady = deferredState.promise
    provider.hydrated = true
    // generation captured at call time should be current generation
    const genAtAttach = provider.generation
    const sessAtAttach = provider.panel.sessions
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    // trigger visible true via actual callback, not direct helper
    panel1.visible = true
    visibilityCb!(true)
    // helper scheduled waiting for stateReady; change generation before stateReady resolves -> should abort
    await new Promise((r) => setTimeout(r, 5))
    provider.generation = genAtAttach + 1
    provider.panel = makePanel(true, async () => {
      refreshCount++
    })
    deferredState.resolve()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(0)
    expect(provider.generation).toBe(genAtAttach + 1)
    // reset generation and test visible true succeeds when not changed
    provider.generation = genAtAttach
    provider.panel = makePanel(true, async () => {})
    provider.panel.sessions = sessAtAttach
    provider.hydrated = true
    provider.stateReady = Promise.resolve()
    // need fresh sessions mock
    let refreshCount2 = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount2++
    }
    // new panel attach to re-register cb? reuse provider but trigger again via same cb with correct generation
    // Since we mutated provider.panel directly, we need to simulate visibility again via cb
    const d2 = deferred<void>()
    provider.stateReady = d2.promise
    // ensure sessAtAttach is same identity as current panel sessions
    provider.panel.sessions = sessAtAttach
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount2++
    }
    panel1.visible = true
    visibilityCb!(true)
    d2.resolve()
    await new Promise((r) => setTimeout(r, 20))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount2).toBe(1)
    await provider.shutdown()
  })

  it("in-flight initial sessions.refreshSessions deferred — reconnect during hydration does not duplicate and subsequent state correct", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    let refreshCount = 0
    const deferredRefresh = deferred<void>()
    const panel = makePanel(true, async () => {
      refreshCount++
      return deferredRefresh.promise
    })
    provider.panel = panel
    provider.generation = 1
    provider.hydrated = false
    provider.stateReady = Promise.resolve()
    // establish seenConnected baseline first (first connected is baseline)
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    expect(provider.seenConnected).toBe(true)
    expect(refreshCount).toBe(0)
    // start actual initial hydration via handleObservationRefresh (hydrated false path)
    const hydrationPromise = provider.handleObservationRefresh()
    // refresh should have been invoked exactly once and now pending on deferredRefresh
    await new Promise((r) => setTimeout(r, 10))
    expect(refreshCount).toBe(1)
    expect(provider.refreshPromise).toBe(hydrationPromise)
    // emit reconnect during that in-flight hydration — should not duplicate due to hydrated false guard and singleflight
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    // still only one in-flight refresh, no new promise
    expect(provider.refreshPromise).toBe(hydrationPromise)
    expect(refreshCount).toBe(1)
    expect(provider.hydrated).toBe(false)
    // complete the initial refresh
    deferredRefresh.resolve()
    await hydrationPromise
    // after completion hydration should be true and promise cleared
    expect(provider.hydrated).toBe(true)
    expect(provider.refreshPromise).toBeNull()
    expect(refreshCount).toBe(1)
    // subsequent reconnect when hydrated+visible should now trigger correctly via same private decision
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(2)
    await provider.shutdown()
  })

  it("reconnect fired during shutdown wait does not schedule refresh and unsubscribe occurs before wait resolves", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    provider.panel = makePanel(true, async () => {})
    provider.generation = 1
    provider.hydrated = true
    // establish baseline so next connected is reconnect
    provider.stateReady = Promise.resolve()
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 10))
    expect(provider.seenConnected).toBe(true)
    // prepare deferred stateReady to widen shutdown wait window
    const deferredState = deferred<void>()
    provider.stateReady = deferredState.promise
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    expect(conn.getUnsubCalled()).toBe(0)
    // start shutdown — should unsubscribe synchronously before awaiting stateReady
    const shutdownPromise = provider.shutdown()
    // synchronously after calling shutdown, unsubscribe must have occurred before first await
    expect(conn.getUnsubCalled()).toBe(1)
    expect(provider.unsubConnectionState).toBeUndefined()
    // fire reconnect while shutdown is waiting for stateReady (listener already removed)
    conn.fire("connecting")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    // no refresh should have been scheduled during shutdown wait
    expect(refreshCount).toBe(0)
    expect(provider.refreshPromise).toBeNull()
    // resolve stateReady to let shutdown complete
    deferredState.resolve()
    await shutdownPromise
    // after shutdown, still no refresh and unsubscribe remains done
    expect(conn.getUnsubCalled()).toBe(1)
    expect(refreshCount).toBe(0)
    // further events after shutdown also do nothing (listener gone)
    conn.fire("error")
    conn.fire("connected")
    await new Promise((r) => setTimeout(r, 15))
    expect(refreshCount).toBe(0)
    expect(conn.getUnsubCalled()).toBe(1)
  })

  it("stateReady rejection during requestState does not prevent observation refresh and is asserted", async () => {
    const conn = makeFakeConn("disconnected")
    const host = makeHost()
    const provider: any = new AgentManagerProvider(host, conn.svc)
    provider.panel = makePanel(true, async () => {})
    provider.generation = 1
    provider.hydrated = false
    let refreshCount = 0
    provider.panel.sessions.refreshSessions = async () => {
      refreshCount++
    }
    const initErr = new Error("init fail")
    provider.stateReady = Promise.reject(initErr)
    // prevent unhandled rejection due to direct assignment; attach handler but keep rejection semantics for provider
    provider.stateReady.catch(() => {})
    // triggerObservationRefresh should still proceed after stateReady rejection (log and continue)
    provider.triggerObservationRefresh()
    await new Promise((r) => setTimeout(r, 15))
    if (provider.refreshPromise) await provider.refreshPromise
    expect(refreshCount).toBe(1)
    // explicitly assert that stateReady was rejected
    await expect(provider.stateReady).rejects.toThrow("init fail")
    // shutdown should not throw despite rejected stateReady (it logs)
    await provider.shutdown()
    expect(refreshCount).toBe(1)
  })
})
