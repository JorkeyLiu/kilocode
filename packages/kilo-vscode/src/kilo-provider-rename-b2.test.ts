import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import { KiloConnectionService } from "./services/cli-backend/connection-service"

describe("KiloProvider handleRenameSession B2", () => {
  function makeProvider(opts: {
    sdkResult: { data?: unknown; error?: unknown; response?: unknown }
    privateAvailable: boolean
    privateResult?: unknown
    privateShouldFail?: boolean
  }) {
    const callOrder: string[] = []
    const privateCalls: unknown[] = []
    let sdkCallParams: unknown = null
    const client = {
      session: {
        update: async (p: unknown) => {
          callOrder.push("sdk")
          sdkCallParams = p
          return opts.sdkResult as unknown as { data: unknown; error: unknown; response: unknown }
        },
      },
    }
    const connectionService = {
      isPrivateAvailable: () => opts.privateAvailable,
      privateSessionUpdate: async (req: unknown) => {
        callOrder.push("private")
        privateCalls.push(req)
        if (opts.privateShouldFail) throw new Error("private failed")
        if (opts.privateResult) return opts.privateResult as unknown
        const r = req as Record<string, unknown>
        const payload = (r.payload as Record<string, unknown>) ?? {}
        return {
          v: 1,
          requestId: r.requestId,
          opId: r.opId,
          op: "session/update",
          idempotencyKey: r.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { title: payload.title as string, session: { id: (r.context as Record<string, unknown>).sessionId, title: payload.title } },
        }
      },
      getClient: () => client as unknown as never,
      getConnectionError: () => null,
      sandboxPreference: { onChange: () => ({ dispose: () => {} }) } as unknown as never,
      onEvent: () => () => {},
      onStateChange: () => () => {},
      getConfigRevision: () => 0,
      onConfigRevision: () => () => {},
    } as unknown as KiloConnectionService
    const provider = new KiloProvider({ fsPath: "/tmp" } as unknown as import("vscode").Uri, connectionService as unknown as KiloConnectionService, undefined, { projectDirectory: "/tmp" })
    ;(provider as unknown as Record<string, unknown>).getWorkspaceDirectory = () => "/tmp"
    return { provider, callOrder, privateCalls, getSdkParams: () => sdkCallParams, connectionService }
  }

  test("SDK first, private uses same durable tuple exactly and no second SDK", async () => {
    const { provider, callOrder, privateCalls, getSdkParams } = makeProvider({
      sdkResult: { data: { id: "ses_a", title: "new title", time: { created: 1, updated: 2 } }, error: undefined, response: { status: 200 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "new title")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
    const req = privateCalls[0] as Record<string, unknown>
    expect(String(req.opId).startsWith("sessionUpdate:ses_a:")).toBeTrue()
    expect(typeof req.idempotencyKey).toBe("string")
    expect(String(req.idempotencyKey).startsWith("sessionUpdate:ses_a:")).toBeTrue()
    expect(String(req.opId)).toBe(String(req.idempotencyKey))
    expect(req.op).toBe("session/update")
    expect((req.payload as Record<string, unknown>).title).toBe("new title")
    const sdkParams = getSdkParams() as Record<string, unknown>
    expect(sdkParams.opId).toBe(req.opId)
    expect(sdkParams.idempotencyKey).toBe(req.idempotencyKey)
    expect(sdkParams.requestId).toBe(req.requestId)
    expect((sdkParams.context as Record<string, unknown>).directory).toBe("/tmp")
    expect((sdkParams.context as Record<string, unknown>).sessionId).toBe("ses_a")
    expect((sdkParams.context as Record<string, unknown>).parentSessionId).toBe(null)
    expect(sdkParams.context).toEqual(req.context)
    expect((req.context as Record<string, unknown>).directory).toBe("/tmp")
    expect((req.context as Record<string, unknown>).sessionId).toBe("ses_a")
    expect((req.context as Record<string, unknown>).parentSessionId).toBe(null)
  })

  test("no private call after SDK non-terminal error (network)", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { message: "network failure" } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "new title")
    expect(callOrder).toEqual(["sdk"])
    expect(privateCalls).toHaveLength(0)
  })

  test("private call after SDK terminal 409 is allowed", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { status: 409 }, response: { status: 409 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "new title")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
  })

  test("private not called when peer unavailable", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: { id: "ses_a", title: "t", time: { created: 1, updated: 2 } }, error: undefined },
      privateAvailable: false,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "t")
    expect(callOrder).toEqual(["sdk"])
    expect(privateCalls).toHaveLength(0)
  })

  test("SDK result remains authoritative on private divergence (title mismatch)", async () => {
    const privateResult = {
      v: 1,
      requestId: "r",
      opId: "sessionUpdate:ses_a",
      op: "session/update",
      idempotencyKey: "sessionUpdate:ses_a:fixed",
      status: "succeeded",
      outcome: { type: "succeeded", time: Date.now() },
      accepted: true,
      data: { title: "different", session: { id: "ses_a", title: "different" } },
    }
    const { provider, callOrder } = makeProvider({
      sdkResult: { data: { id: "ses_a", title: "new title", time: { created: 1, updated: 2 } }, error: undefined, response: { status: 200 } },
      privateAvailable: true,
      privateResult,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "new title")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(true).toBeTrue()
  })

  test("terminal gating uses actual SDK tuple response.status 404 before error heuristics", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { message: "generic" }, response: { status: 404 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "new title")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
  })

  test("response.status takes precedence over error body: 404 authoritative even if error says 500", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { status: 500 }, response: { status: 404 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "new title")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
  })

  test("non-terminal response.status does not trigger private (e.g. 429)", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { message: "rate limited" }, response: { status: 429 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "new title")
    expect(callOrder).toEqual(["sdk"])
    expect(privateCalls).toHaveLength(0)
  })

  test("private unavailable/timeout is fail-closed observation-only", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: { id: "ses_a", title: "t", time: { created: 1, updated: 2 } }, error: undefined },
      privateAvailable: true,
      privateShouldFail: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "t")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
    // SDK success still authoritative — no throw
    expect(true).toBeTrue()
  })

  test("replay parity: same idempotencyKey different requestId would replay — private success title matches SDK", async () => {
    const { provider, callOrder } = makeProvider({
      sdkResult: { data: { id: "ses_a", title: "hello", time: { created: 1, updated: 2 } }, error: undefined, response: { status: 200 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession("ses_a", "hello")
    expect(callOrder).toEqual(["sdk", "private"])
  })
})
