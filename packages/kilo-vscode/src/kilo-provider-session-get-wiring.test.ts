import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"

function makeSessionData(id: string, dir = "/tmp") {
  return {
    id,
    directory: dir,
    title: "hello",
    projectID: "proj_test",
    time: { created: 1, updated: 2 },
  }
}

function makeHarness(sessionId = "ses_abc") {
  const sdkGets: unknown[] = []
  const sdkMessages: unknown[] = []
  const sdkStatus: unknown[] = []
  const privOutcomes: unknown[] = []
  const dir = "/tmp"
  const data = makeSessionData(sessionId, dir)
  const client = {
    session: {
      get: async (p: unknown) => {
        sdkGets.push(p)
        return { data, error: undefined, response: { status: 200 } }
      },
      messages: async (p: unknown) => {
        sdkMessages.push(p)
        return { data: [], response: { headers: { get: () => null } } }
      },
      status: async (p: unknown) => {
        sdkStatus.push(p)
        return { data: {}, error: undefined, response: { status: 200 } }
      },
    },
  }
  const connectionService = {
    isPrivateAvailable: () => true,
    getPrivateEpoch: () => 77,
    getClient: () => client,
    getClientAsync: async () => client,
    getConnectionError: () => null,
    connect: async () => {},
    privateGetOutcomeWithHandle: (req: Record<string, unknown>) => {
      privOutcomes.push(req)
      const ctx = req.context as Record<string, unknown>
      const payload = {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/get",
        idempotencyKey: req.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { session: { id: ctx.sessionId, directory: ctx.directory, title: "hello" } },
      }
      return { id: privOutcomes.length, promise: Promise.resolve({ kind: "valid", result: payload }) }
    },
    privateGetWithHandle: () => {
      throw new Error("must use outcome path")
    },
    privateGet: async () => {
      throw new Error("must use outcome path")
    },
    sandboxPreference: { onChange: () => ({ dispose: () => {} }) },
    onEvent: () => () => {},
    onEventFiltered: () => () => {},
    onStateChange: () => () => {},
    getConfigRevision: () => 0,
    onConfigRevision: () => () => {},
    registerDirectoryProvider: () => () => {},
    registerVisible: () => {},
    registerAttached: () => {},
    unregisterVisible: () => {},
    unregisterAttached: () => {},
    recordMessageSessionId: () => {},
  } as unknown as KiloConnectionService
  const provider = new KiloProvider(
    { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    connectionService,
    undefined,
    { projectDirectory: "/tmp", disableViewedRegistration: true } as unknown as Parameters<typeof KiloProvider>[3],
  )
  const anyProvider = provider as unknown as Record<string, unknown>
  // client is a getter over connectionService.getClient(); no direct assignment.
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => dir, configurable: true })
  // Bypass real connection bootstrap for wiring evidence; SDK path stays real.
  Object.defineProperty(provider, "initializeConnection", { value: async () => {}, configurable: true })
  return { provider: anyProvider, client, dir, data, sdkGets, sdkMessages, sdkStatus, privOutcomes }
}

async function tick(ms = 60) {
  await new Promise((r) => setTimeout(r, ms))
}

describe("KiloProvider B6 live session.get wiring (LOCK-006)", () => {
  test("getSessionInfo falls back to SDK exactly once with no second private request", async () => {
    const h = makeHarness("ses_abc")
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const p = h.provider as unknown as {
        getSessionInfo: (s: string) => Promise<unknown>
      }
      const out = await p.getSessionInfo("ses_abc")
      expect((out as Record<string, unknown>).id).toBe("ses_abc")
      expect(h.sdkGets).toHaveLength(1)
      await tick()
      expect(h.privOutcomes).toHaveLength(0)
      expect(warns.filter((w) => String(w[0]).includes("parity divergence"))).toHaveLength(0)
    } finally {
      console.warn = orig
    }
  })

  test("refreshSessionDetails falls back to SDK exactly once with no second private request", async () => {
    const h = makeHarness("ses_bbb")
    // Satisfy the revision guard: current context matches the refreshed session.
    h.provider["contextSessionID"] = "ses_bbb"
    h.provider["revisions"] = new Map()
    h.provider["refreshes"] = new Map()
    h.provider["trackedSessionIds"] = new Set<string>(["ses_bbb"])
    const data = makeSessionData("ses_bbb", "/tmp")
    ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
      h.sdkGets.push(p)
      return { data, error: undefined, response: { status: 200 } }
    }
    ;(h.provider as unknown as { refreshSessionDetails: (s: string, d: string) => void }).refreshSessionDetails("ses_bbb", "/tmp")
    await tick(80)
    expect(h.sdkGets).toHaveLength(1)
    expect(h.privOutcomes).toHaveLength(0)
  })

  test("doLoadMessages focus strict metadata read falls back to SDK exactly once with no second private request", async () => {
    const h = makeHarness("ses_ccc")
    h.provider["trackedSessionIds"] = new Set<string>()
    h.provider["lastReconciledAt"] = new Map([["ses_ccc", Date.now()]])
    const data = makeSessionData("ses_ccc", "/tmp")
    ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
      h.sdkGets.push(p)
      return { data, error: undefined, response: { status: 200 } }
    }
    await (
      h.provider as unknown as {
        doLoadMessages: (s: string, o: unknown, strict: boolean) => Promise<boolean>
      }
    ).doLoadMessages("ses_ccc", { mode: "focus" }, true)
    expect(h.sdkGets).toHaveLength(1)
    await tick()
    expect(h.privOutcomes).toHaveLength(0)
  })

  test("doLoadMessages replace strict metadata read falls back to SDK exactly once with no second private request", async () => {
    const h = makeHarness("ses_ddd")
    h.provider["trackedSessionIds"] = new Set<string>()
    const data = makeSessionData("ses_ddd", "/tmp")
    ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
      h.sdkGets.push(p)
      return { data, error: undefined, response: { status: 200 } }
    }
    await (
      h.provider as unknown as {
        doLoadMessages: (s: string, o: unknown, strict: boolean) => Promise<boolean>
      }
    ).doLoadMessages("ses_ddd", { mode: "replace" }, true)
    expect(h.sdkGets).toHaveLength(1)
    await tick()
    expect(h.privOutcomes).toHaveLength(0)
  })

  test("handleSyncSession metadata read falls back to SDK exactly once with no second private request", async () => {
    const h = makeHarness("ses_eee")
    const data = makeSessionData("ses_eee", "/tmp")
    ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
      h.sdkGets.push(p)
      return { data, error: undefined, response: { status: 200 } }
    }
    await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_eee")
    expect(h.sdkGets).toHaveLength(1)
    await tick()
    expect(h.privOutcomes).toHaveLength(0)
  })
})
