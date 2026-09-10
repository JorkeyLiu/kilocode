import { describe, expect, test, spyOn, afterEach, mock } from "bun:test"
import * as vscode from "vscode"
import { KiloProvider } from "./KiloProvider"
import { KiloConnectionService } from "./services/cli-backend/connection-service"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
afterEach(() => {
  mock.restore()
})

type Req = Record<string, unknown>

function succeeded(req: Req, cancelled = true) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/cancelQueued",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { cancelled },
  }
}

function failed(req: Req, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/cancelQueued",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

function ambiguous(req: Req) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/cancelQueued",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
}

describe("KiloProvider handleCancelQueued private-first authoritative", () => {
  function makeProvider(opts: {
    sdkResult?: { data?: unknown; error?: unknown }
    privateAvailable: boolean
    privateImpl?: (req: Req) => unknown
    syncThrow?: unknown
    plainOnly?: boolean
    cancelSpy?: (msg?: string) => boolean
  }) {
    const callOrder: string[] = []
    const privateCalls: Req[] = []
    const sdkCalls: Req[] = []
    const client = {
      session: {
        cancelQueued: async (p: Req) => {
          callOrder.push("sdk")
          sdkCalls.push(p)
          return (opts.sdkResult ?? { data: true, error: undefined }) as unknown as {
            data: boolean
            error: unknown
          }
        },
      },
    }
    const resolvePrivate = (req: Req): Promise<unknown> => {
      callOrder.push("private")
      privateCalls.push(req)
      if (opts.syncThrow !== undefined) throw opts.syncThrow
      return Promise.resolve(opts.privateImpl ? opts.privateImpl(req) : succeeded(req))
    }
    const withHandle = opts.plainOnly
      ? {}
      : {
          privateCancelQueuedWithHandle: (req: Req) => {
            const promise = resolvePrivate(req)
            return { id: 7, promise, cancel: opts.cancelSpy ?? (() => true) }
          },
        }
    const connectionService = {
      isPrivateAvailable: () => opts.privateAvailable,
      ...withHandle,
      privateCancelQueued: async (req: Req) => resolvePrivate(req),
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
    const errors = spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
    return { provider, callOrder, privateCalls, sdkCalls, errors }
  }

  async function cancel(provider: KiloProvider) {
    await (provider as unknown as { handleCancelQueued: (a: string, b: string) => Promise<void> }).handleCancelQueued("ses_a", "msg_b")
  }

  test("private succeeded is authoritative with zero SDK and no error", async () => {
    const { provider, callOrder, privateCalls, sdkCalls, errors } = makeProvider({ privateAvailable: true })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(privateCalls).toHaveLength(1)
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(0)
  })

  test("private attempt uses canonical opId/idempotencyKey tuple exactly once", async () => {
    const { provider, privateCalls } = makeProvider({ privateAvailable: true })
    await cancel(provider)
    expect(privateCalls).toHaveLength(1)
    const req = privateCalls[0] as Req
    expect(req.opId).toBe("cancelQueued:ses_a:msg_b")
    expect(req.idempotencyKey).toBe("legacy:ses_a:msg_b")
    expect(String(req.idempotencyKey).includes(":msg_b:")).toBeFalse()
    expect(req.op).toBe("session/cancelQueued")
    expect((req.context as Req).sessionId).toBe("ses_a")
    expect((req.context as Req).directory).toBe("/tmp")
    expect((req.payload as Req).messageId).toBe("msg_b")
  })

  test("validated terminal failed (retryable false) closes with zero SDK and explicit error", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: (req) => failed(req, "stale", "stale sessionRevision", false),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("stale sessionRevision")
  })

  test("validated failed retryable true takes exactly one SDK fallback with same identity", async () => {
    const { provider, callOrder, privateCalls, sdkCalls, errors } = makeProvider({
      sdkResult: { data: true, error: undefined },
      privateAvailable: true,
      privateImpl: (req) => failed(req, "InstanceUnavailableDuringConfigRebuild", "rebuilding", true),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private", "sdk"])
    expect(privateCalls).toHaveLength(1)
    expect(sdkCalls).toHaveLength(1)
    expect(sdkCalls[0]).toEqual({ sessionID: "ses_a", messageID: "msg_b", directory: "/tmp" })
    expect(errors).toHaveBeenCalledTimes(0)
  })

  test("retryable fallback surfaces the SDK error when the SDK fails", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      sdkResult: { data: undefined, error: { message: "sdk boom" } },
      privateAvailable: true,
      privateImpl: (req) => failed(req, "InstanceUnavailableDuringConfigRebuild", "rebuilding", true),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private", "sdk"])
    expect(sdkCalls).toHaveLength(1)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  test("ambiguous never runs a second heterogeneous cancel and fails explicitly", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: (req) => ambiguous(req),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("result unknown")
  })

  test("transportUnknown is unresolved with zero SDK", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: (req) => ({ ...succeeded(req), transportUnknown: true }),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  test("invalid private shape is unresolved with zero SDK", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: (req) => ({ ...succeeded(req), accepted: false }),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("invalid private response")
  })

  test("malformed succeeded with unknown root field is invalid with zero SDK", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: (req) => ({ ...succeeded(req), extra: 1 }),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("invalid private response")
  })

  test("malformed failed with accepted true never takes retryable fallback", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: (req) => ({
        ...failed(req, "InstanceUnavailableDuringConfigRebuild", "rebuilding", true),
        accepted: true,
      }),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("invalid private response")
  })

  test("malformed ambiguous with data stays unresolved with zero SDK", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: (req) => ({ ...ambiguous(req), data: { cancelled: true } }),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("result unknown")
  })

  test("private unavailable fails explicitly with zero SDK", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({ privateAvailable: false })
    await cancel(provider)
    expect(callOrder).toEqual([])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("private transport unavailable")
  })

  test("sync private throw is unresolved with zero SDK", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      syncThrow: new Error("Private peer unavailable"),
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(1)
  })

  test("plain privateCancelQueued path stays private-first with zero SDK", async () => {
    const { provider, callOrder, sdkCalls, errors } = makeProvider({ privateAvailable: true, plainOnly: true })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(errors).toHaveBeenCalledTimes(0)
  })

  test("private timeout exact-cancels the handle and fails without SDK", async () => {
    const seen: string[] = []
    const { provider, callOrder, sdkCalls, errors } = makeProvider({
      privateAvailable: true,
      privateImpl: () => new Promise(() => {}),
      cancelSpy: (msg?: string) => {
        seen.push(msg ?? "")
        return true
      },
    })
    await cancel(provider)
    expect(callOrder).toEqual(["private"])
    expect(sdkCalls).toHaveLength(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("cancelQueued:ses_a:msg_b")
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("private timeout")
  }, 8000)
})
