import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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

const PREV_FIXTURE = process.env.KILO_E2E_FIXTURE

function fakeStore() {
  const data = new Map<string, unknown>()
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: (k: string, v: unknown) => {
      data.set(k, v)
      return Promise.resolve()
    },
  }
}

function fakeConn() {
  const base: Record<string, unknown> = {
    onEventFiltered: () => () => {},
    onStateChange: () => () => {},
    getConnectionState: () => "disconnected",
    registerVisible: mock(() => {}),
    registerAttached: mock(() => {}),
    getClient: () => {
      throw new Error("not connected")
    },
    getClientAsync: async () => {
      throw new Error("not connected")
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop]
      return mock(() => {})
    },
  }) as any
}

function fakeHost(store: any) {
  return {
    workspaceStore: store,
    workspacePath: () => "/tmp/ws",
    createOutput: () => ({ appendLine: () => {}, dispose: () => {} }),
    capture: () => {},
    showError: () => {},
    openFile: () => {},
    extensionKeybindings: () => [],
    serverPort: () => undefined,
    copyToClipboard: () => {},
    openExternal: () => {},
    dispose: () => {},
  } as any
}

function fakeSessions() {
  return {
    getSessionDirectories: () => new Map(),
    trackSession: () => {},
    refreshSessions: async () => {},
    registerSession: () => {},
    recoverPendingPrompts: () => {},
    onFollowupAdopted: () => ({ dispose: () => {} }),
    acknowledgeDraft: () => {},
    abortSessions: async () => {},
    dispose: () => {},
  } as any
}

function fakePanel() {
  const disposeCbs: Array<() => void> = []
  const ctx: any = {
    visible: true,
    active: true,
    posted: [] as unknown[],
    postMessage: (m: unknown) => {
      ctx.posted.push(m)
    },
    waitForReady: async () => {},
    waitForActive: async () => {},
    reveal: () => {},
    sessions: fakeSessions(),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: (cb: () => void) => {
      disposeCbs.push(cb)
      return { dispose: () => {} }
    },
    dispose: () => {
      for (const cb of [...disposeCbs]) cb()
    },
    _disposeCbs: disposeCbs,
  }
  return ctx
}

function makeProvider() {
  const store = fakeStore()
  const provider = new AgentManagerProvider(fakeHost(store), fakeConn())
  return provider as any
}

function attach(provider: any) {
  const ctx = fakePanel()
  provider.deserializePanel(ctx)
  return ctx
}

beforeEach(() => {
  process.env.KILO_E2E_FIXTURE = "1"
})

afterEach(() => {
  if (PREV_FIXTURE === undefined) delete process.env.KILO_E2E_FIXTURE
  else process.env.KILO_E2E_FIXTURE = PREV_FIXTURE
})

describe("agent manager content-ready handshake", () => {
  it("webviewReady alone does not satisfy content-ready", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const pending = provider.waitForContentReadyForFixture(50)
    await expect(pending).rejects.toThrow("timeout")
  })

  it("current-generation ack resolves concurrent waiters", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const a = provider.waitForContentReadyForFixture(1000)
    const b = provider.waitForContentReadyForFixture(1000)
    expect(provider.getContentWaiterCountForFixture()).toBe(2)
    await provider.handleMessage({ type: "agentManager.contentReady" })
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)
    expect(provider.getContentWaiterCountForFixture()).toBe(0)
    // Already ready resolves immediately.
    await expect(provider.waitForContentReadyForFixture(50)).resolves.toBe(true)
    await provider.shutdown()
  })

  it("ack before webviewReady is ignored", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "agentManager.contentReady" })
    const pending = provider.waitForContentReadyForFixture(50)
    await expect(pending).rejects.toThrow("timeout")
    await provider.shutdown()
  })

  it("stale generation does not release new generation", async () => {
    const provider = makeProvider()
    const ctx1 = attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    await provider.handleMessage({ type: "agentManager.contentReady" })
    await expect(provider.waitForContentReadyForFixture(50)).resolves.toBe(true)
    // New panel generation: dispose the old panel (as a real close does),
    // then attach the new one — readiness resets.
    ctx1.dispose()
    const ctx2 = fakePanel()
    provider.deserializePanel(ctx2)
    expect(ctx1).not.toBe(ctx2)
    const pending = provider.waitForContentReadyForFixture(50)
    await expect(pending).rejects.toThrow("timeout")
    // New generation ack resolves.
    await provider.handleMessage({ type: "webviewReady" })
    await provider.handleMessage({ type: "agentManager.contentReady" })
    await expect(provider.waitForContentReadyForFixture(50)).resolves.toBe(true)
    await provider.shutdown()
  })

  it("dispose rejects pending waiters and resets readiness", async () => {
    const provider = makeProvider()
    const ctx = attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const pending = provider.waitForContentReadyForFixture(5000)
    void pending.catch(() => {})
    ctx.dispose()
    await expect(pending).rejects.toThrow("panel disposed")
    expect(provider.getContentWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("fixture reload bumps generation and rejects pending waiters", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const pending = provider.waitForContentReadyForFixture(5000)
    void pending.catch(() => {})
    // No host reload support on the fake host: reloadWebviewForFixture throws
    // after bumping, which still proves reset semantics.
    await expect(provider.reloadWebviewForFixture()).rejects.toThrow("Host does not support AM reload")
    await expect(pending).rejects.toThrow("reload")
    // Stale ack from the pre-reload document (no webviewReady since bump) is ignored.
    await provider.handleMessage({ type: "agentManager.contentReady" })
    await expect(provider.waitForContentReadyForFixture(30)).rejects.toThrow("timeout")
    await provider.shutdown()
  })

  it("fixture-disabled path ignores ack and rejects wait", async () => {
    delete process.env.KILO_E2E_FIXTURE
    const provider = makeProvider()
    attach(provider)
    const res = await provider.handleMessage({ type: "agentManager.contentReady" })
    expect(res).toBeNull()
    expect(provider.getContentWaiterCountForFixture()).toBe(0)
    expect(() => provider.waitForContentReadyForFixture(50)).toThrow("KILO_E2E_FIXTURE")
    await provider.shutdown()
  })

  it("production webviewReady still passes through", async () => {
    const provider = makeProvider()
    attach(provider)
    const res = await provider.handleMessage({ type: "webviewReady" })
    expect(res).not.toBeNull()
    expect((res as Record<string, unknown>).type).toBe("webviewReady")
    await provider.shutdown()
  })

  it("extension registers a separate fixture command without redefining ready", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/extension.ts"), "utf8")
    expect(src).toContain("kilo-code.new.e2eFixture.agentManagerContentReady")
    expect(src).toContain("kilo-code.new.e2eFixture.agentManagerReady")
    expect(src).toContain("waitForContentReadyForFixture")
    // Separate registration: the existing ready command still awaits waitForReady.
    expect(src).toContain("await agentManagerProvider.waitForReady()")
  })

  it("extension bridge stays KILO_E2E_FIXTURE-gated", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/extension.ts"), "utf8")
    const gate = src.indexOf("if (isE2EFixtureEnabled())")
    const cmd = src.indexOf("kilo-code.new.e2eFixture.agentManagerContentReady")
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(cmd).toBeGreaterThan(gate)
  })

  it("ack is posted after all content subscriptions in AgentManagerApp", () => {
    const src = readFileSync(join(import.meta.dir, "../../webview-ui/agent-manager/AgentManagerApp.tsx"), "utf8")
    const ack = src.indexOf('type: "agentManager.contentReady"')
    expect(ack).toBeGreaterThan(0)
    for (const needle of [
      'msg.type !== "sessionCreated"',
      'msg.type === "sessionsLoaded"',
      "terminalDispatch(msg)",
      'msg.type === "agentManager.state"',
      'msg.type === "agentManager.sessionAdded"',
      'msg.type === "sessionDeleted"',
    ]) {
      const idx = src.indexOf(needle)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(ack)
    }
  })

  it("runner waits content-ready after ready and before settle/seed", () => {
    const src = readFileSync(join(import.meta.dir, "../e2e/runner.ts"), "utf8")
    expect(src).toContain("kilo-code.new.e2eFixture.agentManagerContentReady")
    const open = src.indexOf('await vscode.commands.executeCommand(CMD_OPEN)')
    const content = src.indexOf("waitForContentReady(vscode, \"initial open\")")
    const seed = src.indexOf("await seedTabCloseFixtures(")
    expect(open).toBeGreaterThanOrEqual(0)
    expect(content).toBeGreaterThan(open)
    expect(seed).toBeGreaterThan(content)
    // Reload/reopen boundaries re-wait before re-seeding (run() uses the
    // `vscode` namespace directly; service loops use their `vscodeApi` param).
    for (const label of ["topic reopen", "topic reload"]) {
      expect(src).toContain(`waitForContentReady(vscode, "${label}")`)
    }
    for (const label of ["real-session reopen", "lc fixture reload"]) {
      expect(src).toContain(`waitForContentReady(vscodeApi, "${label}")`)
    }
    // No ready marker is written before the initial content-ready wait:
    // within run(), the content wait precedes the tab-close block that holds
    // the first `ready` write. (Slice from run() so helper definitions above
    // it cannot satisfy the search.)
    const runBody = src.slice(src.indexOf("export async function run()"))
    const runContent = runBody.indexOf('waitForContentReady(vscode, "initial open")')
    const runTabClose = runBody.indexOf("if (runTabClose)")
    const runReady = runBody.indexOf('writeFileSync(join(scratch, "ready")')
    expect(runContent).toBeGreaterThanOrEqual(0)
    expect(runTabClose).toBeGreaterThan(runContent)
    expect(runReady).toBeGreaterThan(runTabClose)
  })
})

describe("agent manager fixture barrier (per-seed delivery)", () => {
  it("waiter-before-send survives a synchronous ack during post", async () => {
    const provider = makeProvider()
    const ctx = attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    // Fast-ack race: the panel acks synchronously inside postMessage. The
    // waiter must already exist or the ack is missed.
    ctx.postMessage = (m: unknown) => {
      ctx.posted.push(m)
      const rec = m as Record<string, unknown>
      if (rec.type === "agentManager.fixtureBarrier") {
        void provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: rec.token })
      }
    }
    await expect(provider.waitForFixtureBarrierForFixture("tok-fast", 1000)).resolves.toBe(true)
    expect(ctx.posted).toContainEqual({ type: "agentManager.fixtureBarrier", token: "tok-fast" })
    await provider.shutdown()
  })

  it("exact current-generation token resolves; mismatch is ignored", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const pending = provider.waitForFixtureBarrierForFixture("tok-a", 60)
    void pending.catch(() => {})
    const miss = await provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: "tok-b" })
    expect(miss).toBeNull()
    expect(provider.getBarrierWaiterCountForFixture()).toBe(1)
    await expect(pending).rejects.toThrow("timeout")
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("concurrent distinct tokens resolve independently", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const a = provider.waitForFixtureBarrierForFixture("tok-1", 1000)
    const b = provider.waitForFixtureBarrierForFixture("tok-2", 1000)
    expect(provider.getBarrierWaiterCountForFixture()).toBe(2)
    await provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: "tok-1" })
    await expect(a).resolves.toBe(true)
    expect(provider.getBarrierWaiterCountForFixture()).toBe(1)
    await provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: "tok-2" })
    await expect(b).resolves.toBe(true)
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("identical token waiters coalesce on one ack", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const a = provider.waitForFixtureBarrierForFixture("tok-same", 1000)
    const b = provider.waitForFixtureBarrierForFixture("tok-same", 1000)
    expect(provider.getBarrierWaiterCountForFixture()).toBe(2)
    await provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: "tok-same" })
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("stale generation ack is ignored and never resolves the new generation", async () => {
    const provider = makeProvider()
    const ctx1 = attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const stale = provider.waitForFixtureBarrierForFixture("tok-old", 5000)
    void stale.catch(() => {})
    ctx1.dispose()
    await expect(stale).rejects.toThrow("panel disposed")
    const ctx2 = fakePanel()
    provider.deserializePanel(ctx2)
    expect(ctx1).not.toBe(ctx2)
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    // No waiter in the new generation: the stale-token ack is ignored.
    const res = await provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: "tok-old" })
    expect(res).toBeNull()
    // The same token string in the new generation resolves normally.
    await provider.handleMessage({ type: "webviewReady" })
    const fresh = provider.waitForFixtureBarrierForFixture("tok-old", 1000)
    await provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: "tok-old" })
    await expect(fresh).resolves.toBe(true)
    await provider.shutdown()
  })

  it("barrier waiter times out and cleans up", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    await expect(provider.waitForFixtureBarrierForFixture("tok-t", 30)).rejects.toThrow("timeout")
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("dispose rejects barrier waiters and resets counts", async () => {
    const provider = makeProvider()
    const ctx = attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const pending = provider.waitForFixtureBarrierForFixture("tok-d", 5000)
    void pending.catch(() => {})
    ctx.dispose()
    await expect(pending).rejects.toThrow("panel disposed")
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("fixture reload bumps generation and rejects barrier waiters", async () => {
    const provider = makeProvider()
    attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    const pending = provider.waitForFixtureBarrierForFixture("tok-r", 5000)
    void pending.catch(() => {})
    await expect(provider.reloadWebviewForFixture()).rejects.toThrow("Host does not support AM reload")
    await expect(pending).rejects.toThrow("reload")
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("empty token, missing panel, and post failure fail explicitly", async () => {
    const lone = makeProvider()
    expect(() => lone.waitForFixtureBarrierForFixture("tok-x", 50)).toThrow("no Agent Manager panel")
    await lone.shutdown()
    const provider = makeProvider()
    attach(provider)
    expect(() => provider.waitForFixtureBarrierForFixture("", 50)).toThrow("non-empty token")
    await provider.shutdown()
  })

  it("post failure rejects and removes the waiter", async () => {
    const provider = makeProvider()
    const ctx = attach(provider)
    await provider.handleMessage({ type: "webviewReady" })
    ctx.postMessage = () => {
      throw new Error("boom")
    }
    expect(() => provider.waitForFixtureBarrierForFixture("tok-p", 1000)).toThrow("post failed")
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    await provider.shutdown()
  })

  it("fixture-disabled barrier path ignores ack and rejects wait", async () => {
    delete process.env.KILO_E2E_FIXTURE
    const provider = makeProvider()
    attach(provider)
    const res = await provider.handleMessage({ type: "agentManager.fixtureBarrierAck", token: "x" })
    expect(res).toBeNull()
    expect(provider.getBarrierWaiterCountForFixture()).toBe(0)
    expect(() => provider.waitForFixtureBarrierForFixture("x", 50)).toThrow("KILO_E2E_FIXTURE")
    await provider.shutdown()
  })

  it("extension registers the gated barrier command without touching production posts", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/extension.ts"), "utf8")
    expect(src).toContain("kilo-code.new.e2eFixture.agentManagerBarrier")
    expect(src).toContain("waitForFixtureBarrierForFixture")
    const gate = src.indexOf("if (isE2EFixtureEnabled())")
    const cmd = src.indexOf("kilo-code.new.e2eFixture.agentManagerBarrier")
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(cmd).toBeGreaterThan(gate)
  })

  it("barrier ack is posted after all content subscriptions in AgentManagerApp", () => {
    const src = readFileSync(join(import.meta.dir, "../../webview-ui/agent-manager/AgentManagerApp.tsx"), "utf8")
    const barrier = src.indexOf('"agentManager.fixtureBarrier"')
    const ack = src.indexOf('"agentManager.fixtureBarrierAck"')
    expect(barrier).toBeGreaterThan(0)
    expect(ack).toBeGreaterThan(barrier)
    for (const needle of [
      'msg.type !== "sessionCreated"',
      'msg.type === "sessionsLoaded"',
      "terminalDispatch(msg)",
      'msg.type === "agentManager.state"',
      'msg.type === "agentManager.sessionAdded"',
      'msg.type === "sessionDeleted"',
    ]) {
      const idx = src.indexOf(needle)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(barrier)
    }
    // At most one rAF before the ack (queueMicrotask fallback where rAF is
    // unavailable); non-empty tokens only.
    expect(src).toContain("requestAnimationFrame")
    expect(src).toContain("queueMicrotask")
    expect(src).toContain("unsubBarrier()")
  })
})
