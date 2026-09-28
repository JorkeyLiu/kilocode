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

function foundSucceeded(opId: string) {
  return {
    v: "1.0",
    status: "found",
    operation: { opId, outcome: "succeeded", code: "sessionUpdate.succeeded", message: "ok", time: 1 },
  }
}

function getFound(title = "new title") {
  return {
    v: "1.0",
    status: "found",
    session: { id: "ses_a", title, parentID: null, directory: "/tmp", projectID: "proj", createdAt: 1, updatedAt: 2 },
  }
}

function readerWith(op: (input: { opId: string }) => unknown, get: () => unknown, ops = { n: 0 }, gets = { n: 0 }) {
  return {
    ops,
    gets,
    reader: {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async () => {
        gets.n += 1
        return get()
      },
      operation: async (input: { opId: string }) => {
        ops.n += 1
        return op(input)
      },
    } as never,
  }
}

describe("renameSessionPrivateFirst private-first accepted-only with exact reobserve", () => {
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
    const out = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect(out.kind).toBe("session")
    if (out.kind === "session") expect((out.session as unknown as { title: string }).title).toBe("new title")
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
  ])("uncertain class %s reobserves exact op with zero SDK", async (label, maker) => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    let observedOpId: string | null = null
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
    if (label === "failed") {
      let thrown: unknown = null
      try {
        await renameSessionPrivateFirst({
          client,
          connection: conn as never,
          sessionID: "ses_a",
          title: "new title",
          directory: "/tmp",
          privateReader: null,
        })
      } catch (e) {
        thrown = e
      }
      expect((thrown as { code?: string }).code).toBe("stale")
      expect(sdk).toHaveBeenCalledTimes(0)
      expect(privateReq).toBeTruthy()
      return
    }
    if (label === "ambiguous") {
      const { reader, ops, gets } = readerWith((input) => foundSucceeded(input.opId), () => getFound())
      const out = await renameSessionPrivateFirst({
        client,
        connection: conn as never,
        sessionID: "ses_a",
        title: "new title",
        directory: "/tmp",
        privateReader: reader,
      })
      expect(out.kind).toBe("detail")
      if (out.kind === "detail") {
        expect(out.detail.id).toBe("ses_a")
        expect(out.detail.title).toBe("new title")
      }
      expect(sdk).toHaveBeenCalledTimes(0)
      expect(ops.n).toBe(1)
      expect(gets.n).toBe(1)
      expect(privateReq).toBeTruthy()
      return
    }
    const { reader, ops } = readerWith(
      (input) => {
        observedOpId = input.opId
        return { v: "1.0", status: "not_found" }
      },
      () => getFound(),
    )
    let thrown: unknown = null
    try {
      await renameSessionPrivateFirst({
        client,
        connection: conn as never,
        sessionID: "ses_a",
        title: "new title",
        directory: "/tmp",
        privateReader: reader,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("rename.unresolved")
    expect(String((thrown as Error).message)).toContain("No retry was issued")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(ops.n).toBe(1)
    expect(observedOpId).toBe(privateReq?.opId)
  })

  it("timeout reobserves unavailable and throws unresolved with zero SDK", async () => {
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
    let thrown: unknown = null
    try {
      await renameSessionPrivateFirst({
        client,
        connection: conn as never,
        sessionID: "ses_a",
        title: "new title",
        directory: "/tmp",
        privateReader: null,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("rename.unresolved")
    expect(String((thrown as Error).message)).toContain("No retry was issued")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privateReq).toBeTruthy()
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
    const out = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
    })
    expect(out.kind).toBe("session")
    if (out.kind === "session") expect((out.session as unknown as { title: string }).title).toBe("new title")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(String(sdkInput.opId).startsWith("sessionUpdate:ses_a:")).toBeTrue()
    expect(sdkInput.opId).toBe(sdkInput.idempotencyKey)
    expect((sdkInput.context as Record<string, unknown>).directory).toBe("/tmp")
    expect((sdkInput.context as Record<string, unknown>).sessionId).toBe("ses_a")
    expect((sdkInput.context as Record<string, unknown>).parentSessionId).toBeNull()
    expect(sdkInput.title).toBe("new title")
  })

  it.each([
    ["mismatched-id", (base: Record<string, unknown>) => ({ ...base, id: "ses_other" })],
    ["incomplete-shape", (base: Record<string, unknown>) => ({ id: base.id, title: base.title })],
    ["missing-slug", (base: Record<string, unknown>) => ({ ...base, slug: undefined })],
    ["missing-version", (base: Record<string, unknown>) => ({ ...base, version: undefined })],
  ])("hardened success %s reobserves absent and throws unresolved with zero SDK", async (_, mutate) => {
    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { update: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    let observedOpId: string | null = null
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
    const { reader, ops } = readerWith(
      (input) => {
        observedOpId = input.opId
        return { v: "1.0", status: "not_found" }
      },
      () => getFound(),
    )
    let thrown: unknown = null
    try {
      await renameSessionPrivateFirst({
        client,
        connection: conn as never,
        sessionID: "ses_a",
        title: "new title",
        directory: "/tmp",
        privateReader: reader,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("rename.unresolved")
    expect(String((thrown as Error).message)).toContain("No retry was issued")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(ops.n).toBe(1)
    expect(observedOpId).toBe(privateReq?.opId)
  })

  it("contradictory transport-unknown success reobserves succeeded with unavailable get and returns refreshNeeded with zero SDK", async () => {
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
    const { reader, ops, gets } = readerWith(
      (input) => foundSucceeded(input.opId),
      () => {
        throw new Error("Peer closed")
      },
    )
    const out = await renameSessionPrivateFirst({
      client,
      connection: conn as never,
      sessionID: "ses_a",
      title: "new title",
      directory: "/tmp",
      privateReader: reader,
    })
    expect(out.kind).toBe("refreshNeeded")
    if (out.kind === "refreshNeeded") expect(out.opId).toBe(privateReq?.opId)
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(ops.n).toBe(1)
    expect(gets.n).toBe(1)
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
