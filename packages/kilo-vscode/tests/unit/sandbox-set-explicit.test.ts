import { describe, expect, spyOn, test } from "bun:test"
import * as vscode from "vscode"

const { KiloProvider } = await import("../../src/KiloProvider")

function mkSession() {
  return {
    id: "ses_s1",
    slug: "session",
    version: "1",
    projectID: "project",
    directory: "/repo",
    title: "Session",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

function createClient(opts?: { setImpl?: (p: Record<string, unknown>) => Promise<{ data: unknown }>; statusImpl?: () => Promise<{ data: unknown }> }) {
  const setCalls: Array<Record<string, unknown>> = []
  const statusCalls: Array<Record<string, unknown>> = []
  return {
    setCalls,
    statusCalls,
    sandbox: {
      set: async (p: Record<string, unknown>) => {
        setCalls.push(p)
        if (opts?.setImpl) return opts.setImpl(p)
        return { data: { directory: "/repo", enabled: p.enabled, available: true, version: 2 } }
      },
      status: async (p: Record<string, unknown>) => {
        statusCalls.push(p)
        if (opts?.statusImpl) return opts.statusImpl()
        return { data: { directory: "/repo", enabled: false, available: true, version: 2 } }
      },
    },
  }
}

function createConnection(client?: { sandbox: unknown }) {
  return {
    sandboxPreference: {
      explicit: () => undefined,
      resolve: (fallback: boolean) => fallback,
      wait: () => Promise.resolve(),
      set: async () => undefined,
      onChange: () => () => undefined,
    },
    isPrivateAvailable: () => false,
    privateSandboxSetOutcomeWithHandle: () => {
      throw new Error("Private peer unavailable")
    },
    connect: async () => {},
    getClient: () => client ?? null,
    onEventFiltered: () => () => undefined,
    onStateChange: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    getConfigRevision: () => 0,
    advanceConfigRevision: () => {},
    onConfigRevision: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    getServerInfo: () => ({ port: 1 }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
    resolveEventSessionId: () => undefined,
    recordMessageSessionId: () => undefined,
    pruneSession: () => undefined,
    registerVisible: () => undefined,
    unregisterVisible: () => undefined,
    registerAttached: () => undefined,
    unregisterAttached: () => undefined,
  }
}

function makeProvider(client: ReturnType<typeof createClient>) {
  const connection = createConnection(client as never)
  const provider = new KiloProvider({} as never, connection as never)
  const internal = provider as unknown as {
    connectionState: string
    webview: { postMessage: (m: unknown) => Promise<unknown> } | null
    currentSession: unknown
    sessionDirectories: Map<string, string>
    trackedSessionIds: Set<string>
    getWorkspaceDirectory: (sid?: string) => string
    getRootDirectory: () => string
    handleToggleSandbox: (input: { sessionID: string; requestID: string; enabled: boolean }) => Promise<void>
  }
  internal.connectionState = "connected"
  const sent: Array<Record<string, unknown>> = []
  internal.webview = { postMessage: async (m: unknown) => { sent.push(m as Record<string, unknown>) } }
  internal.currentSession = mkSession()
  internal.sessionDirectories = new Map([["ses_s1", "/repo"]])
  internal.trackedSessionIds = new Set(["ses_s1"])
  return { internal, sent, client }
}

describe("sandbox explicit target", () => {
  test("message carries explicit enabled target", () => {
    const msg = { type: "toggleSandbox", sessionID: "ses_s1", requestID: "r1", enabled: false }
    expect(msg.enabled).toBe(false)
    const on = { type: "toggleSandbox", sessionID: "ses_s1", requestID: "r2", enabled: true }
    expect(on.enabled).toBe(true)
  })

  test("provider invokes set helper with same target and converges status", async () => {
    const notice = spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
    const client = createClient()
    const { internal, sent } = makeProvider(client)
    await internal.handleToggleSandbox({ sessionID: "ses_s1", requestID: "r1", enabled: false })
    expect(client.setCalls).toEqual([{ sessionID: "ses_s1", directory: "/repo", enabled: false }])
    expect(sent).toContainEqual(expect.objectContaining({ type: "sandboxStatus", sessionID: "ses_s1", enabled: false, requestID: "r1" }))
    expect(notice).toHaveBeenCalledWith("Sandbox disabled")
    notice.mockRestore()
  })

  test("provider preserves error plus status convergence on set failure", async () => {
    const client = createClient({ setImpl: async () => { throw new Error("boom") } })
    const { internal, sent } = makeProvider(client)
    await internal.handleToggleSandbox({ sessionID: "ses_s1", requestID: "r2", enabled: true }).catch(() => undefined)
    expect(client.setCalls).toEqual([{ sessionID: "ses_s1", directory: "/repo", enabled: true }])
    expect(sent).toContainEqual(expect.objectContaining({ type: "sandboxStatusError", sessionID: "ses_s1", requestID: "r2" }))
    expect(sent).toContainEqual(expect.objectContaining({ type: "sandboxStatus", sessionID: "ses_s1" }))
  })

  test("private success uses zero SDK", async () => {
    const client = createClient()
    const connection = createConnection()
    const privateConn = {
      ...connection,
      isPrivateAvailable: () => true,
      privateSandboxSetOutcomeWithHandle: (req: { requestId: string; opId: string; op: string; idempotencyKey: string }) => ({
        id: 1,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: req.requestId,
            opId: req.opId,
            op: req.op,
            idempotencyKey: req.idempotencyKey,
            status: "succeeded",
            outcome: { type: "succeeded", time: 1 },
            accepted: true,
            data: { status: { directory: "/repo", enabled: true, available: true, version: 3 } },
          },
        }),
        cancel: () => true,
      }),
    }
    const withClient = { ...privateConn, getClient: () => client }
    const provider = new KiloProvider({} as never, withClient as never)
    const internal = provider as unknown as {
      connectionState: string
      webview: { postMessage: (m: unknown) => Promise<unknown> } | null
      currentSession: unknown
      sessionDirectories: Map<string, string>
      trackedSessionIds: Set<string>
      handleToggleSandbox: (input: { sessionID: string; requestID: string; enabled: boolean }) => Promise<void>
    }
    internal.connectionState = "connected"
    const sent: Array<Record<string, unknown>> = []
    internal.webview = { postMessage: async (m: unknown) => { sent.push(m as Record<string, unknown>) } }
    internal.currentSession = mkSession()
    internal.sessionDirectories = new Map([["ses_s1", "/repo"]])
    internal.trackedSessionIds = new Set(["ses_s1"])
    const notice = spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
    await internal.handleToggleSandbox({ sessionID: "ses_s1", requestID: "r3", enabled: true })
    expect(client.setCalls).toHaveLength(0)
    expect(sent).toContainEqual(expect.objectContaining({ type: "sandboxStatus", enabled: true }))
    notice.mockRestore()
  })
})
