import { describe, expect, it, mock } from "bun:test"
import type { Session } from "@kilocode/sdk/v2/client"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { forkSessionPrivateFirst, handleForkSession, type ForkContext } from "../../src/kilo-provider/fork-session"

function makePrivateSession(id = "ses_forked", parent = "ses_src", directory = "/repo") {
  return { id, parentID: parent, directory, title: "forked" } as unknown as Record<string, unknown>
}

function makeSucceeded(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/fork",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { session: makePrivateSession() },
  }
}

function makeFailed(req: { requestId: string; opId: string; idempotencyKey: string }, code = "session.not_found", message = "source session not found", retryable = false) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/fork",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable } },
    accepted: false,
    failure: { code, message, retryable },
  }
}

function makeAmbiguous(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/fork",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  }
}

function makeSdkSession(id = "ses_sdk_fork") {
  return { id, parentID: "ses_src", directory: "/repo", title: "forked" } as unknown as Session
}

function forkCtx(overrides: Partial<ForkContext> = {}): ForkContext {
  const client = {
    session: {
      fork: mock(async () => ({ data: makeSdkSession() })),
      status: mock(async () => ({ data: {} })),
    },
  }
  return {
    connection: {
      getClient: () => client,
      isPrivateAvailable: () => false,
      privateFork: mock(async () => {
        throw new Error("should not be called")
      }),
    } as never,
    post: () => undefined,
    register: () => undefined,
    forked: () => undefined,
    status: () => "idle",
    directory: () => "/repo",
    ...overrides,
  } as unknown as ForkContext
}

describe("forkSessionPrivateFirst private-first with single SDK fallback", () => {
  it("private succeeded returns without SDK mutation", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    let capturedReq: unknown = null
    const conn = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (req: unknown) => {
        capturedReq = req
        return { id: 1, promise: Promise.resolve(makeSucceeded(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 1,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_forked")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(capturedReq).toBeTruthy()
    const req = capturedReq as Record<string, unknown>
    expect(String(req.opId).startsWith("fork:ses_src:")).toBeTrue()
    expect(req.opId).toBe(req.idempotencyKey)
  })

  it.each([
    ["ambiguous", (req: never) => makeAmbiguous(req)],
    ["invalid-null-session", (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), data: { session: null } })],
    ["invalid-parent-mismatch", (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), data: { session: makePrivateSession("ses_forked", "ses_other") } })],
    ["invalid-accepted-mismatch", (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), accepted: false })],
    ["invalid-transport-unknown", (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), transportUnknown: true })],
    ["throw", () => { throw new Error("transport") }],
    ["capability absence", () => { throw new Error("Private peer missing session/fork capability") }],
    ["closed drift", () => { throw Object.assign(new Error("Peer closed"), { code: -32603 }) }],
  ])("fallback class %s calls SDK once with same tuple", async (_, maker) => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        try {
          const res = (maker as (r: never) => unknown)(req as never)
          return { id: 2, promise: Promise.resolve(res), cancel: () => true }
        } catch (e) {
          return { id: 2, promise: Promise.reject(e), cancel: () => true }
        }
      },
      peekPrivatePeerNextId: () => 2,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", messageId: "msg_abc123" })
    expect((sess as unknown as { id: string }).id).toBe("ses_sdk_fork")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect(String(sdkInput.opId).startsWith("fork:ses_src:")).toBeTrue()
    expect(sdkInput.opId).toBe(sdkInput.idempotencyKey)
    expect((sdkInput.context as Record<string, unknown>).directory).toBe("/repo")
    expect((sdkInput.context as Record<string, unknown>).sessionId).toBe("ses_src")
    expect((sdkInput.context as Record<string, unknown>).parentSessionId).toBeNull()
    expect(sdkInput.context).toEqual((privateReq as Record<string, unknown>).context)
  })

  it("timeout fallback calls SDK once with same tuple", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return { id: 3, promise: new Promise(() => {}), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 3,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_sdk_fork")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
  })

  it("private unavailable falls back to exactly one SDK with durable tuple", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => false,
      privateForkWithHandle: mock(() => { throw new Error("unavailable") }),
    } as unknown as never
    const sess = await forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_sdk_fork")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(String(sdkInput.opId).startsWith("fork:ses_src:")).toBeTrue()
  })

  it("validated retryable true failure falls back once with same tuple", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return {
          id: 7,
          promise: Promise.resolve(makeFailed(req as never, "internal", "transient fork failure", true)),
          cancel: () => true,
        }
      },
      peekPrivatePeerNextId: () => 7,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_sdk_fork")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect(sdkInput.context).toEqual((privateReq as Record<string, unknown>).context)
  })

  it.each([
    ["session.not_found", "source session not found"],
    ["conflict", "idempotencyKey conflict: different operation facts with same key"],
  ])("terminal %s closes with zero SDK mutation", async (code, message) => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (req: unknown) => ({
        id: 4,
        promise: Promise.resolve(makeFailed(req as never, code, message)),
        cancel: () => true,
      }),
      peekPrivatePeerNextId: () => 4,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    await expect(forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })).rejects.toThrow(message)
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("handleForkSession closes source not_found without register and zero SDK", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk, status: mock(async () => ({ data: {} })) } }
    const post = mock(() => undefined)
    const register = mock(() => undefined)
    const forked = mock(() => undefined)
    const c = forkCtx({
      post,
      register,
      forked,
      connection: {
        getClient: () => client,
        isPrivateAvailable: () => true,
        privateForkWithHandle: (req: unknown) => ({
          id: 5,
          promise: Promise.resolve(makeFailed(req as never, "session.not_found", "source session not found")),
          cancel: () => true,
        }),
        peekPrivatePeerNextId: () => 5,
        tryCancelPrivatePending: () => true,
        invalidatePrivatePeerOnObserverTimeout: () => {},
      } as never,
    })
    await handleForkSession(c, "ses_src")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(register).not.toHaveBeenCalled()
    expect(forked).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalled()
    const msg = (post.mock.calls[0]![0] as { message: string }).message
    expect(msg).toContain("Failed to fork session")
  })

  it("handleForkSession private success registers before reporting source with zero SDK", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk, status: mock(async () => ({ data: {} })) } }
    const order: string[] = []
    const c = forkCtx({
      register: mock(() => order.push("registered")),
      forked: mock((_s: Session, sourceID: string) => order.push(`forked:${sourceID}`)),
      connection: {
        getClient: () => client,
        isPrivateAvailable: () => true,
        privateForkWithHandle: (req: unknown) => ({
          id: 6,
          promise: Promise.resolve(makeSucceeded(req as never)),
          cancel: () => true,
        }),
        peekPrivatePeerNextId: () => 6,
        tryCancelPrivatePending: () => true,
        invalidatePrivatePeerOnObserverTimeout: () => {},
      } as never,
    })
    await handleForkSession(c, "ses_src")
    expect(order).toEqual(["registered", "forked:ses_src"])
    expect(sdk).toHaveBeenCalledTimes(0)
  })
})
