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
  seedSessionStatusMap: (reconcile?: boolean) => Promise<void>
  sendRemoteStatus: () => void
  refreshSessionDetails: () => void
  dispose: () => void
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

describe("KiloProvider custom-only profile boundary", () => {
  it("connected hydration never invokes profile network read and still runs ordinary hydration", async () => {
    let profileCalls = 0
    const client = {
      kilo: {
        profile: async () => {
          profileCalls += 1
          return { data: null }
        },
      },
    }
    const { provider, internal, sent } = setup(client)
    let seeded = 0
    let remote = 0
    internal.seedSessionStatusMap = async () => {
      seeded += 1
    }
    internal.sendRemoteStatus = () => {
      remote += 1
    }

    await internal.syncWebviewState("initializeConnection")

    // No proactive profile/account network read on startup hydration.
    expect(profileCalls).toBe(0)
    expect(types(sent)).not.toContain("profileData")
    // Ordinary hydration still runs.
    expect(types(sent)).toContain("connectionState")
    expect(types(sent)).toContain("gitStatus")
    expect(seeded).toBe(1)
    expect(remote).toBe(1)
    provider.dispose()
  })

  it("reconnect hydration never invokes profile network read", async () => {
    let profileCalls = 0
    const client = {
      kilo: {
        profile: async () => {
          profileCalls += 1
          return { data: null }
        },
      },
    }
    const { provider, internal, sent } = setup(client)
    internal.seedSessionStatusMap = async () => {}
    internal.sendRemoteStatus = () => {}

    await internal.syncWebviewState("sse-connected")

    expect(profileCalls).toBe(0)
    expect(types(sent)).not.toContain("profileData")
    provider.dispose()
  })

  it("static guards: no proactive profile reader remains; broadcast + local refresh paths intact", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    expect(src).not.toContain("syncProfileBestEffort")
    expect(src).not.toContain("fetchKiloProfilePrivateFirst")
    expect(src.match(/\.kilo\.profile\(/g) ?? []).toEqual([])
    // Scope locks: the onProfileChanged broadcast forward stays untouched,
    // and refreshProfile still answers locally without a network fetch.
    expect(src).toContain("onProfileChanged")
    expect(src).toContain('type: "profileData"')
    // Ordinary hydration stays inside the connected branch.
    const sync = src.match(/private async syncWebviewState\(reason: string\)[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(sync).toContain('type: "gitStatus"')
    expect(sync).toContain("seedSessionStatusMap")
    expect(sync).toContain("sendRemoteStatus")
    // Reconnect still resyncs via syncWebviewState + session refresh flush.
    expect(src).toContain('await this.syncWebviewState("sse-connected")')
    expect(src).toContain('flushPendingSessionRefresh("sse-connected")')
  })
})
