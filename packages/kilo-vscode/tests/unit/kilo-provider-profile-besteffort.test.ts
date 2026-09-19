import { describe, expect, it } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

type Internals = {
  connectionState: State
  isWebviewReady: boolean
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  currentSession: null
  cachedGitRepo: boolean
  sessionStatusMap: Map<string, unknown>
  syncWebviewState: (reason: string) => Promise<void>
  syncProfileBestEffort: () => Promise<void>
  seedSessionStatusMap: (reconcile?: boolean) => Promise<void>
  sendRemoteStatus: () => void
  refreshSessionDetails: () => void
  dispose: () => void
}

function validProfile() {
  return { profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
}

function fakeService(client: unknown) {
  return {
    connect: async () => {},
    getClient: () => client,
    getServerInfo: () => ({ port: 12345 }),
    getConnectionError: () => null,
    getConnectionState: () => "connected" as const,
    onEventFiltered: () => () => undefined,
    onStateChange: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    registerVisible: () => {},
    unregisterVisible: () => {},
    unregisterAttached: () => {},
    sandboxPreference: undefined,
  }
}

function setup(client: unknown) {
  const provider = new KiloProvider({} as never, fakeService(client) as never)
  const internal = provider as unknown as Internals
  const sent: unknown[] = []
  internal.webview = {
    postMessage: async (message: unknown) => {
      sent.push(message)
      return true
    },
  }
  internal.isWebviewReady = true
  internal.connectionState = "connected"
  internal.currentSession = null
  return { provider, internal, sent }
}

function types(sent: unknown[]) {
  return sent.map((m) => (m as { type?: string }).type)
}

describe("KiloProvider profile best-effort deserialization", () => {
  it("hanging profile does not block syncWebviewState must-arrive messages; success arrives late", async () => {
    let resolveProfile!: (v: { data?: unknown; error?: unknown }) => void
    const gate = new Promise<{ data?: unknown; error?: unknown }>((res) => {
      resolveProfile = res
    })
    const client = {
      kilo: { profile: () => gate },
    }
    // Private unavailable => straight to the hanging SDK fallback.
    const { provider, internal, sent } = setup(client)
    ;(provider as unknown as { connectionService: { isPrivateAvailable: () => boolean } }).connectionService.isPrivateAvailable =
      () => false
    let seeded = 0
    let remote = 0
    internal.seedSessionStatusMap = async () => {
      seeded += 1
    }
    internal.sendRemoteStatus = () => {
      remote += 1
    }

    const done = await Promise.race([
      internal.syncWebviewState("initializeConnection").then(() => "resolved" as const),
      new Promise((_, reject) => setTimeout(() => reject(new Error("sync blocked by hanging profile")), 500)),
    ])
    expect(done).toBe("resolved")
    // Must-arrive messages are posted before the hanging profile resolves.
    expect(types(sent)).toContain("connectionState")
    expect(types(sent)).toContain("gitStatus")
    expect(seeded).toBe(1)
    expect(remote).toBe(1)
    expect(types(sent)).not.toContain("profileData")

    resolveProfile({ data: validProfile() })
    // Poll for the late background profileData (final consistency).
    const deadline = Date.now() + 2000
    while (!types(sent).includes("profileData") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const profile = sent.find((m) => (m as { type?: string }).type === "profileData") as
      | { data?: unknown }
      | undefined
    expect(profile).toBeDefined()
    expect(profile!.data).toEqual(validProfile())
    provider.dispose()
  })

  it("profile failure still posts null without rejection", async () => {
    const client = {
      kilo: {
        profile: async () => {
          throw new Error("boom")
        },
      },
    }
    const { provider, internal, sent } = setup(client)
    ;(provider as unknown as { connectionService: { isPrivateAvailable: () => boolean } }).connectionService.isPrivateAvailable =
      () => false
    internal.seedSessionStatusMap = async () => {}
    internal.sendRemoteStatus = () => {}

    await internal.syncWebviewState("reconnect")
    const deadline = Date.now() + 2000
    while (!types(sent).includes("profileData") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const profile = sent.find((m) => (m as { type?: string }).type === "profileData") as
      | { data?: unknown }
      | undefined
    expect(profile).toBeDefined()
    expect(profile!.data).toBeNull()
    // Helper never rejects: direct await must resolve (no unhandled rejection).
    await internal.syncProfileBestEffort()
    provider.dispose()
  })

  it("stale profile result does not overwrite new connection", async () => {
    let resolveOld!: (v: { data?: unknown; error?: unknown }) => void
    const gate = new Promise<{ data?: unknown; error?: unknown }>((res) => {
      resolveOld = res
    })
    const oldProfile = { profile: { email: "old@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
    const newProfile = { profile: { email: "new@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
    const oldClient = { kilo: { profile: () => gate } }
    const newClient = { kilo: { profile: async () => ({ data: newProfile }) } }
    const { provider, internal, sent } = setup(oldClient)
    const svc = provider as unknown as {
      connectionService: { isPrivateAvailable: () => boolean; getClient: () => unknown }
      connectionGeneration: number
    }
    svc.connectionService.isPrivateAvailable = () => false
    internal.seedSessionStatusMap = async () => {}
    internal.sendRemoteStatus = () => {}

    const pending = internal.syncProfileBestEffort()
    // Simulate reconnect: new generation + new client before old request settles.
    svc.connectionGeneration += 1
    svc.connectionService.getClient = () => newClient
    resolveOld({ data: oldProfile })
    await pending
    // Stale old result is dropped, never posted.
    expect(types(sent)).not.toContain("profileData")

    // Current connection result still posts normally.
    await internal.syncProfileBestEffort()
    const profile = sent.find((m) => (m as { type?: string }).type === "profileData") as
      | { data?: unknown }
      | undefined
    expect(profile).toBeDefined()
    expect(profile!.data).toEqual(newProfile)
    provider.dispose()
  })

  it("directory change drops stale profile result", async () => {
    let resolveOld!: (v: { data?: unknown; error?: unknown }) => void
    const gate = new Promise<{ data?: unknown; error?: unknown }>((res) => {
      resolveOld = res
    })
    const oldProfile = { profile: { email: "old@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
    const newProfile = { profile: { email: "new@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
    const oldClient = { kilo: { profile: () => gate } }
    const newClient = { kilo: { profile: async () => ({ data: newProfile }) } }
    const { provider, internal, sent } = setup(oldClient)
    const svc = provider as unknown as {
      connectionService: { isPrivateAvailable: () => boolean; getClient: () => unknown }
    }
    svc.connectionService.isPrivateAvailable = () => false
    internal.seedSessionStatusMap = async () => {}
    internal.sendRemoteStatus = () => {}
    // Drive directory via the existing accessor so the guard sees the change.
    let current = "/repo"
    ;(provider as unknown as { getWorkspaceDirectory: () => string }).getWorkspaceDirectory = () => current

    const pending = internal.syncProfileBestEffort()
    current = "/other"
    svc.connectionService.getClient = () => newClient
    resolveOld({ data: oldProfile })
    await pending
    expect(types(sent)).not.toContain("profileData")

    await internal.syncProfileBestEffort()
    const profile = sent.find((m) => (m as { type?: string }).type === "profileData") as
      | { data?: unknown }
      | undefined
    expect(profile).toBeDefined()
    expect(profile!.data).toEqual(newProfile)
    provider.dispose()
  })

  it("stale failure null never overwrites fresh result", async () => {
    let resolveOld!: (v: { data?: unknown; error?: unknown }) => void
    let rejectOld!: (e: unknown) => void
    const gate = new Promise<{ data?: unknown; error?: unknown }>((res, rej) => {
      resolveOld = res
      rejectOld = rej
    })
    void resolveOld
    const newProfile = { profile: { email: "new@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
    const oldClient = { kilo: { profile: () => gate } }
    const newClient = { kilo: { profile: async () => ({ data: newProfile }) } }
    const { provider, internal, sent } = setup(oldClient)
    const svc = provider as unknown as {
      connectionService: { isPrivateAvailable: () => boolean; getClient: () => unknown }
      connectionGeneration: number
    }
    svc.connectionService.isPrivateAvailable = () => false
    internal.seedSessionStatusMap = async () => {}
    internal.sendRemoteStatus = () => {}

    const pendingOld = internal.syncProfileBestEffort()
    // Reconnect before old settles; fresh posts first.
    svc.connectionGeneration += 1
    svc.connectionService.getClient = () => newClient
    await internal.syncProfileBestEffort()
    const first = sent.filter((m) => (m as { type?: string }).type === "profileData")
    expect(first).toHaveLength(1)
    expect((first[0] as { data?: unknown }).data).toEqual(newProfile)

    // Old connection now fails (would be null) — must be dropped, not posted.
    rejectOld(new Error("boom"))
    await pendingOld
    const after = sent.filter((m) => (m as { type?: string }).type === "profileData")
    expect(after).toHaveLength(1)
    expect((after[0] as { data?: unknown }).data).toEqual(newProfile)
    provider.dispose()
  })

  it("late result after disconnect is dropped", async () => {
    let resolveProfile!: (v: { data?: unknown; error?: unknown }) => void
    const gate = new Promise<{ data?: unknown; error?: unknown }>((res) => {
      resolveProfile = res
    })
    const client = { kilo: { profile: () => gate } }
    const { provider, internal, sent } = setup(client)
    ;(provider as unknown as { connectionService: { isPrivateAvailable: () => boolean } }).connectionService.isPrivateAvailable =
      () => false
    internal.seedSessionStatusMap = async () => {}
    internal.sendRemoteStatus = () => {}

    const pending = internal.syncProfileBestEffort()
    internal.connectionState = "disconnected"
    resolveProfile({ data: validProfile() })
    await pending
    expect(types(sent)).not.toContain("profileData")
    provider.dispose()
  })

  it("sse-connected has no second unguarded profile read", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const anchor = 'await this.syncWebviewState("sse-connected")'
    const idx = src.indexOf(anchor)
    expect(idx).toBeGreaterThan(-1)
    // The connected handler around the resync must not read profile directly;
    // the single guarded path lives in syncProfileBestEffort via syncWebviewState.
    const window = src.slice(Math.max(0, idx - 1200), idx + 400)
    expect(window).not.toContain("fetchKiloProfilePrivateFirst")
    expect(window).not.toContain('type: "profileData"')
    expect(window).not.toContain(".kilo.profile(")
    // Reconnect semantics stay: resync + session refresh flush + prompt recovery.
    expect(window).toContain('flushPendingSessionRefresh("sse-connected")')
  })

  it("static guards: sync stays backgrounded, must-arrive + reconnect semantics intact", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const helper = src.match(/private async syncProfileBestEffort\(\)[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(helper).toContain("fetchKiloProfilePrivateFirst")
    expect(helper).toContain('type: "profileData"')
    expect(helper).toContain("retry(")
    // Helper never rejects: internal catch (retry fallback + try/catch).
    expect(helper).toContain("catch")

    const sync = src.match(/private async syncWebviewState\(reason: string\)[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(sync).toContain("void this.syncProfileBestEffort()")
    expect(sync).not.toContain("await retry(")
    expect(sync).not.toContain("await fetchKiloProfilePrivateFirst")
    // Must-arrive messages remain synchronous in sync (no loss on early return).
    expect(sync).toContain('type: "gitStatus"')
    expect(sync).toContain("seedSessionStatusMap")
    expect(sync).toContain("sendRemoteStatus")
    expect(sync).toContain("refreshSessionDetails")
    // No direct SDK read outside the helper fallback.
    expect(src.match(/\.kilo\.profile\(/g) ?? []).toEqual([])

    // doInitializeConnection still gates on sync + session refresh before dataReady.
    const initIdx = src.indexOf("await this.syncWebviewState(\"initializeConnection\")")
    expect(initIdx).toBeGreaterThan(-1)
    const afterInit = src.slice(initIdx, initIdx + 400)
    expect(afterInit).toContain('flushPendingSessionRefresh("initializeConnection")')
    expect(src).toContain('type: "extensionDataReady"')
    // Reconnect still resyncs via syncWebviewState + session refresh flush.
    expect(src).toContain('await this.syncWebviewState("sse-connected")')
    expect(src).toContain('flushPendingSessionRefresh("sse-connected")')
  })
})
