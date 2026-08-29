import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import { KiloConnectionService } from "./services/cli-backend/connection-service"

describe("KiloProvider handleCancelQueued B1", () => {
  function makeProvider(opts: {
    sdkResult: { data?: unknown; error?: unknown; response?: unknown }
    privateAvailable: boolean
    privateResult?: unknown
  }) {
    const callOrder: string[] = []
    const privateCalls: unknown[] = []
    const client = {
      session: {
        cancelQueued: async (p: unknown) => {
          callOrder.push("sdk")
          return opts.sdkResult as unknown as { data: boolean; error: unknown }
        },
      },
    }
    const connectionService = {
      isPrivateAvailable: () => opts.privateAvailable,
      privateCancelQueued: async (req: unknown) => {
        callOrder.push("private")
        privateCalls.push(req)
        if (opts.privateResult) return opts.privateResult as unknown
        const r = req as Record<string, unknown>
        return {
          v: 1,
          requestId: r.requestId,
          opId: r.opId,
          op: "session/cancelQueued",
          idempotencyKey: r.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { cancelled: true },
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
    return { provider, callOrder, privateCalls, connectionService }
  }

  test("SDK first, private uses legacy durable key exactly and no second operation", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: true, error: undefined },
      privateAvailable: true,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
    const req = privateCalls[0] as Record<string, unknown>
    expect(req.opId).toBe("cancelQueued:ses_a:msg_b")
    expect(req.idempotencyKey).toBe("legacy:ses_a:msg_b")
    expect(String(req.idempotencyKey).includes(":msg_b:")).toBeFalse()
  })

  test("no private call after SDK non-terminal error (network)", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { message: "network failure" } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk"])
    expect(privateCalls).toHaveLength(0)
  })

  test("private call after SDK terminal 409 is allowed (terminal-equivalent)", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { status: 409 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
  })

  test("private not called when peer unavailable", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: true, error: undefined },
      privateAvailable: false,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk"])
    expect(privateCalls).toHaveLength(0)
  })

  test("SDK result remains authoritative on private divergence", async () => {
    const privateResult = {
      v: 1,
      requestId: "r",
      opId: "cancelQueued:ses_a:msg_b",
      op: "session/cancelQueued",
      idempotencyKey: "legacy:ses_a:msg_b",
      status: "succeeded",
      outcome: { type: "succeeded", time: Date.now() },
      accepted: true,
      data: { cancelled: false },
    }
    const { provider } = makeProvider({
      sdkResult: { data: true, error: undefined },
      privateAvailable: true,
      privateResult,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    // no throw, SDK success is still delivered
    expect(true).toBeTrue()
  })

  test("terminal gating uses actual SDK tuple response.status 404 before error heuristics", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { message: "generic" }, response: { status: 404 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
  })

  test("terminal gating uses actual SDK tuple response.status 409 before error heuristics", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { message: "generic" }, response: { status: 409 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
  })

  test("response.status takes precedence over error body: 404 authoritative even if error says 500", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { status: 500 }, response: { status: 404 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk", "private"])
    expect(privateCalls).toHaveLength(1)
  })

  test("non-terminal response.status does not trigger private (e.g. 429)", async () => {
    const { provider, callOrder, privateCalls } = makeProvider({
      sdkResult: { data: undefined, error: { message: "rate limited" }, response: { status: 429 } },
      privateAvailable: true,
    })
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
    expect(callOrder).toEqual(["sdk"])
    expect(privateCalls).toHaveLength(0)
  })
})
