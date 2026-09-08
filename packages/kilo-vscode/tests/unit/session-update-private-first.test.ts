import { describe, expect, it, mock } from "bun:test"
import { renameSessionPrivateFirst } from "../../src/kilo-provider/session-update"
import type { KiloClient } from "@kilocode/sdk/v2/client"

function makeSdkSession(title = "new title", id = "ses_a") {
  return {
    id,
    slug: "slug-a",
    directory: "/tmp",
    title,
    parentID: null,
    projectID: "proj",
    version: "v1",
    time: { created: 1, updated: 2 },
  } as unknown as never
}

function makeSucceeded(req: { requestId: string; opId: string; idempotencyKey: string }, title = "new title") {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/update",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: {
      title,
      session: {
        id: "ses_a",
        slug: "slug-a",
        directory: "/tmp",
        title,
        parentID: null,
        projectID: "proj",
        version: "v1",
        time: { created: 1, updated: 2 },
      },
    },
  }
}

function makeFailed(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/update",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code: "stale", message: "stale", retryable: false } },
    accepted: false,
    failure: { code: "stale", message: "stale", retryable: false },
  }
}

function makeAmbiguous(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/update",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  }
}

describe("renameSessionPrivateFirst private-first with single SDK fallback", () => {
  it("private succeeded returns without SDK mutation", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession("sdk title"), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    let capturedReq: unknown = null
    const conn = {
      isPrivateAvailable: () => true,
      privateSessionUpdateWithHandle: (req: unknown) => {
        capturedReq = req
        return { id: 1, promise: Promise.resolve(makeSucceeded(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 1,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect((sess as unknown as { title: string }).title).toBe("new title")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(capturedReq).toBeTruthy()
  })

  it.each([
    ["failed", (req: never) => makeFailed(req as unknown as never)],
    ["ambiguous", (req: never) => makeAmbiguous(req as unknown as never)],
    [
      "invalid-null-session",
      (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), data: { session: null } }),
    ],
    ["invalid-title-mismatch", (req: never) => makeSucceeded(req as unknown as never, "different")],
    [
      "invalid-accepted-mismatch",
      (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), accepted: false }),
    ],
    [
      "throw",
      () => {
        throw new Error("transport")
      },
    ],
    [
      "capability absence",
      () => {
        throw new Error("Private peer missing session/update capability")
      },
    ],
    [
      "closed drift",
      () => {
        throw Object.assign(new Error("Peer closed"), { code: -32603 })
      },
    ],
  ])("fallback class %s calls SDK once with same tuple", async (_, maker) => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateSessionUpdateWithHandle: (req: unknown) => {
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
    const sess = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect((sess as unknown as { title: string }).title).toBe("new title")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect(String(sdkInput.opId).startsWith("sessionUpdate:ses_a:")).toBeTrue()
    expect(sdkInput.opId).toBe(sdkInput.idempotencyKey)
    expect((sdkInput.context as Record<string, unknown>).directory).toBe("/tmp")
    expect((sdkInput.context as Record<string, unknown>).sessionId).toBe("ses_a")
    expect((sdkInput.context as Record<string, unknown>).parentSessionId).toBeNull()
    expect(sdkInput.context).toEqual(privateReq?.context)
    expect(sdkInput.title).toBe("new title")
  })

  it("timeout fallback calls SDK once with same tuple", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateSessionUpdateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return { id: 3, promise: new Promise(() => {}), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 3,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect((sess as unknown as { title: string }).title).toBe("new title")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
  })

  it("private unavailable falls back to exactly one SDK with durable tuple", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => false,
      privateSessionUpdateWithHandle: mock(() => {
        throw new Error("unavailable")
      }),
    } as unknown as never
    const sess = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect((sess as unknown as { title: string }).title).toBe("new title")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(String(sdkInput.opId).startsWith("sessionUpdate:ses_a:")).toBeTrue()
  })

  it.each([
    ["mismatched-id", (base: Record<string, unknown>) => ({ ...base, id: "ses_other" })],
    ["incomplete-shape", (base: Record<string, unknown>) => ({ id: base.id, title: base.title })],
    ["missing-slug", (base: Record<string, unknown>) => ({ ...base, slug: undefined })],
    ["missing-version", (base: Record<string, unknown>) => ({ ...base, version: undefined })],
  ])("hardened success %s falls back to exactly one same-tuple SDK", async (_, mutate) => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateSessionUpdateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        const ok = makeSucceeded(req as never) as unknown as Record<string, unknown>
        const data = ok.data as Record<string, unknown>
        data.session = mutate(data.session as Record<string, unknown>) as unknown as never
        return { id: 4, promise: Promise.resolve(ok), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 4,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect((sess as unknown as { title: string }).title).toBe("new title")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect(sdkInput.context).toEqual(privateReq?.context)
  })

  it("contradictory transport-unknown success falls back to exactly one same-tuple SDK", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateSessionUpdateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        const ok = makeSucceeded(req as never) as unknown as Record<string, unknown>
        ok.transportUnknown = true
        return { id: 5, promise: Promise.resolve(ok), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 5,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect((sess as unknown as { title: string }).title).toBe("new title")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect(sdkInput.context).toEqual(privateReq?.context)
  })

  it("invalid title throws before any private or SDK call", async () => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    const privateMock = mock(() => {
      throw new Error("should not be called")
    })
    const conn = {
      isPrivateAvailable: () => true,
      privateSessionUpdateWithHandle: privateMock,
      privateSessionUpdate: privateMock,
    } as unknown as never
    await expect(
      renameSessionPrivateFirst({
        client,
        connection: conn as never,
        sessionID: "ses_a",
        title: "   ",
        directory: "/tmp",
      }),
    ).rejects.toThrow()
    expect(privateMock).toHaveBeenCalledTimes(0)
    expect(sdk).toHaveBeenCalledTimes(0)
  })
})
