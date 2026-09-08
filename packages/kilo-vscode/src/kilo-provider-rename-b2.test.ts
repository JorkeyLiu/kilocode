import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import { KiloConnectionService } from "./services/cli-backend/connection-service"

describe("KiloProvider handleRenameSession private-first", () => {
  function fullSession(id: string, title: string) {
    return { id, slug: "slug-a", directory: "/tmp", title, parentID: null, projectID: "proj", version: "v1", time: { created: 1, updated: 2 } }
  }
  function makeProvider(opts: {
    sdkResult: { data?: unknown; error?: unknown }
    privateAvailable: boolean
    privateResult?: unknown
    privateShouldFail?: boolean
    neverResolve?: boolean
  }) {
    const callOrder: string[] = []
    const privateCalls: unknown[] = []
    let sdkCallParams: unknown = null
    const sdkCalls: unknown[] = []
    const client = {
      session: {
        update: async (p: unknown) => {
          callOrder.push("sdk")
          sdkCallParams = p
          sdkCalls.push(p)
          return opts.sdkResult as unknown as { data: unknown; error: unknown }
        },
      },
    }
    const connectionService = {
      isPrivateAvailable: () => opts.privateAvailable,
      privateSessionUpdateWithHandle: (req: unknown) => {
        callOrder.push("private")
        privateCalls.push(req)
        if (opts.neverResolve) return { id: 9, promise: new Promise(() => {}), cancel: () => true }
        if (opts.privateShouldFail)
          return { id: 9, promise: Promise.reject(new Error("private failed")), cancel: () => true }
        if (opts.privateResult) return { id: 9, promise: Promise.resolve(opts.privateResult), cancel: () => true }
        const r = req as Record<string, unknown>
        const payload = (r.payload as Record<string, unknown>) ?? {}
        return {
          id: 9,
          promise: Promise.resolve({
            v: 1,
            requestId: r.requestId,
            opId: r.opId,
            op: "session/update",
            idempotencyKey: r.idempotencyKey,
            status: "succeeded",
            outcome: { type: "succeeded", time: Date.now() },
            accepted: true,
            data: {
              title: payload.title as string,
              session: fullSession((r.context as Record<string, unknown>).sessionId as string, payload.title as string),
            },
          }),
          cancel: () => true,
        }
      },
      peekPrivatePeerNextId: () => 9,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
      getClient: () => client as unknown as never,
      getConnectionError: () => null,
      sandboxPreference: { onChange: () => ({ dispose: () => {} }) } as unknown as never,
      onEvent: () => () => {},
      onStateChange: () => () => {},
      getConfigRevision: () => 0,
      onConfigRevision: () => () => {},
    } as unknown as KiloConnectionService
    const provider = new KiloProvider(
      { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      connectionService as unknown as KiloConnectionService,
      undefined,
      { projectDirectory: "/tmp" },
    )
    ;(provider as unknown as Record<string, unknown>).getWorkspaceDirectory = () => "/tmp"
    const posted: unknown[] = []
    ;(provider as unknown as Record<string, unknown>).postMessage = (m: unknown) => {
      posted.push(m)
    }
    return { provider, callOrder, privateCalls, sdkCalls, getSdkParams: () => sdkCallParams, posted }
  }

  test("private success returns with zero SDK mutation calls", async () => {
    const { provider, callOrder, privateCalls, sdkCalls, posted } = makeProvider({
      sdkResult: { data: fullSession("ses_a", "new title") },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession(
      "ses_a",
      "new title",
    )
    expect(callOrder).toEqual(["private"])
    expect(privateCalls).toHaveLength(1)
    expect(sdkCalls).toHaveLength(0)
    const req = privateCalls[0] as Record<string, unknown>
    expect(String(req.opId).startsWith("sessionUpdate:ses_a:")).toBeTrue()
    expect(String(req.opId)).toBe(String(req.idempotencyKey))
    expect(req.op).toBe("session/update")
    expect((req.payload as Record<string, unknown>).title).toBe("new title")
    expect((req.context as Record<string, unknown>).parentSessionId).toBe(null)
    expect(posted.some((m) => (m as { type?: string }).type === "sessionUpdated")).toBeTrue()
  })

  test("private failure falls back to exactly one SDK with same tuple", async () => {
    const { provider, callOrder, privateCalls, getSdkParams } = makeProvider({
      sdkResult: { data: fullSession("ses_a", "new title") },
      privateAvailable: true,
      privateShouldFail: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession(
      "ses_a",
      "new title",
    )
    expect(callOrder).toEqual(["private", "sdk"])
    expect(privateCalls).toHaveLength(1)
    const req = privateCalls[0] as Record<string, unknown>
    const sdkParams = getSdkParams() as Record<string, unknown>
    expect(sdkParams.opId).toBe(req.opId)
    expect(sdkParams.idempotencyKey).toBe(req.idempotencyKey)
    expect(sdkParams.requestId).toBe(req.requestId)
    expect(sdkParams.context).toEqual(req.context)
  })

  test("private invalid result falls back to exactly one SDK with same tuple", async () => {
    const { provider, callOrder, privateCalls, getSdkParams } = makeProvider({
      sdkResult: { data: fullSession("ses_a", "new title") },
      privateAvailable: true,
      privateResult: {
        v: 1,
        requestId: "r",
        opId: "sessionUpdate:ses_a",
        op: "session/update",
        idempotencyKey: "sessionUpdate:ses_a:fixed",
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: { title: "different", session: { id: "ses_a", title: "different" } },
      },
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession(
      "ses_a",
      "new title",
    )
    expect(callOrder).toEqual(["private", "sdk"])
    expect(privateCalls).toHaveLength(1)
    const req = privateCalls[0] as Record<string, unknown>
    const sdkParams = getSdkParams() as Record<string, unknown>
    expect(sdkParams.opId).toBe(req.opId)
    expect(sdkParams.idempotencyKey).toBe(req.idempotencyKey)
    expect(sdkParams.requestId).toBe(req.requestId)
  })

  test("private unavailable falls back to exactly one SDK", async () => {
    const { provider, callOrder, privateCalls, sdkCalls } = makeProvider({
      sdkResult: { data: fullSession("ses_a", "t") },
      privateAvailable: false,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession(
      "ses_a",
      "t",
    )
    expect(callOrder).toEqual(["sdk"])
    expect(privateCalls).toHaveLength(0)
    expect(sdkCalls).toHaveLength(1)
  })

  test("invalid title performs zero private and zero SDK calls and posts error", async () => {
    const { provider, callOrder, privateCalls, sdkCalls, posted } = makeProvider({
      sdkResult: { data: fullSession("ses_a", "t") },
      privateAvailable: true,
    })
    await (provider as unknown as { handleRenameSession: (a: string, b: string) => Promise<void> }).handleRenameSession(
      "ses_a",
      "   ",
    )
    expect(callOrder).toEqual([])
    expect(privateCalls).toHaveLength(0)
    expect(sdkCalls).toHaveLength(0)
    expect(posted.some((m) => (m as { type?: string }).type === "error")).toBeTrue()
  })
})
