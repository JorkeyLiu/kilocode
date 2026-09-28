import { describe, expect, it, mock } from "bun:test"
import { createSessionPrivateFirst } from "../../src/kilo-provider/session-create"
import type { KiloClient } from "@kilocode/sdk/v2/client"

function makeSession(id = "ses_private_ok") {
  return { id, directory: "/repo", title: "hello", time: { created: Date.now(), updated: Date.now() }, projectID: "proj" } as unknown as never
}

function makeSucceeded(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/create",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { session: makeSession() },
  }
}

function makeTerminalFailed(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/create",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code: "validation.failed", message: "bad", retryable: false } },
    accepted: false,
    failure: { code: "validation.failed", message: "bad", retryable: false },
  }
}

function makeRetryable(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/create",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "fence", retryable: true } },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "fence", retryable: true },
  }
}

function makeAmbiguous(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/create",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  }
}

function connWith(resolver: (req: never) => unknown) {
  return {
    isPrivateAvailable: () => true,
    privateCreateWithHandle: (req: unknown) => {
      try {
        const res = resolver(req as never)
        return { id: 2, promise: Promise.resolve(res), cancel: () => true }
      } catch (e) {
        return { id: 2, promise: Promise.reject(e), cancel: () => true }
      }
    },
    peekPrivatePeerNextId: () => 2,
    tryCancelPrivatePending: () => true,
    invalidatePrivatePeerOnObserverTimeout: () => {},
  } as unknown as never
}

function detailReader(childId: string, directory = "/repo") {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({}) as unknown,
    get: async (input: { directory: string; sessionId: string }) => ({
      v: "1.0",
      status: "found",
      session: {
        id: childId,
        title: "created",
        parentID: null,
        directory,
        projectID: "proj",
        createdAt: 10,
        updatedAt: 20,
      },
    }),
    createOperation: async (input: { directory: string; opId: string }) => ({
      v: "1.0",
      status: "found",
      createdSessionId: childId,
    }),
  } as unknown as never
}

describe("createSessionPrivateFirst accepted-only with exact re-observe", () => {
  it("private succeeded returns session without SDK", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let capturedReq: unknown = null
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        capturedReq = req
        return { id: 1, promise: Promise.resolve(makeSucceeded(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 1,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", platform: "linux", metadata: {} })
    expect(out.kind).toBe("session")
    if (out.kind !== "session") throw new Error("expected session")
    expect((out.session as unknown as { id: string }).id).toBe("ses_private_ok")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(capturedReq).toBeTruthy()
  })

  it("private succeeded preserves platform and metadata", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let capturedPayload: Record<string, unknown> | null = null
    const meta = { kilocode: { sandbox: { enabled: true } } }
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        capturedPayload = (req as Record<string, unknown>).payload as Record<string, unknown>
        const ok = makeSucceeded(req as never)
        ;(ok.data.session as Record<string, unknown>).platform = "linux"
        ;(ok.data.session as Record<string, unknown>).metadata = meta
        return { id: 10, promise: Promise.resolve(ok), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 10,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", platform: "linux", metadata: meta as unknown as Record<string, unknown>, title: "hello", parentID: "ses_parent" })
    expect(out.kind).toBe("session")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(capturedPayload).toEqual(expect.objectContaining({ platform: "linux", metadata: meta, title: "hello", parentID: "ses_parent" }))
  })

  it("validated terminal failed throws with zero SDK", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = connWith((req: never) => makeTerminalFailed(req))
    let thrown: unknown = null
    try {
      await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: null })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeTruthy()
    expect((thrown as { terminal?: boolean }).terminal).toBe(true)
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("validated pre-accept retryable fence takes exactly one SDK with same tuple", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_fallback"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return { id: 2, promise: Promise.resolve(makeRetryable(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 2,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: null })
    expect(out.kind).toBe("session")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect((sdkInput.context as Record<string, unknown>).directory).toBe("/repo")
    expect((sdkInput.context as Record<string, unknown>).parentSessionId).toBeNull()
  })

  it("private unavailable pre-send takes exactly one SDK", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_unavail"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = { isPrivateAvailable: () => false } as unknown as never
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: null })
    expect(out.kind).toBe("session")
    if (out.kind !== "session") throw new Error("expected session")
    expect((out.session as unknown as { id: string }).id).toBe("ses_unavail")
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["ambiguous", (req: never) => makeAmbiguous(req)],
    ["invalid-null-session", (req: never) => ({ v: 1, requestId: (req as unknown as { requestId: string }).requestId, opId: (req as unknown as { opId: string }).opId, op: "session/create", idempotencyKey: (req as unknown as { idempotencyKey: string }).idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: null } })],
    ["invalid-bad-id", (req: never) => ({ v: 1, requestId: (req as unknown as { requestId: string }).requestId, opId: (req as unknown as { opId: string }).opId, op: "session/create", idempotencyKey: (req as unknown as { idempotencyKey: string }).idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: { id: "bad", directory: "/repo", title: "x" } } })],
    ["invalid-accepted-mismatch", (req: never) => ({ v: 1, requestId: (req as unknown as { requestId: string }).requestId, opId: (req as unknown as { opId: string }).opId, op: "session/create", idempotencyKey: (req as unknown as { idempotencyKey: string }).idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: false, data: { session: makeSession() } })],
    ["throw", () => { throw new Error("transport") }],
    ["capability absence", () => { throw new Error("Private peer missing session/create capability") }],
    ["closed drift", () => { throw Object.assign(new Error("Peer closed"), { code: -32603 }) }],
  ])("uncertain %s re-observes once with zero SDK and throws unresolved when reader unavailable", async (_, maker) => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = connWith(maker as (r: never) => unknown)
    let thrown: unknown = null
    try {
      await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: null })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeTruthy()
    expect((thrown as { code?: string }).code).toBe("create.unresolved")
    expect((thrown as { terminal?: boolean }).terminal).toBe(true)
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("uncertain timeout re-observes once with zero SDK", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: () => ({ id: 3, promise: new Promise(() => {}), cancel: () => true }),
      peekPrivatePeerNextId: () => 3,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    let thrown: unknown = null
    try {
      await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: null })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("create.unresolved")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("uncertain with found exact + authoritative get returns detail with zero SDK", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = connWith((req: never) => makeAmbiguous(req))
    const reader = detailReader("ses_created_1")
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: reader as never })
    expect(out.kind).toBe("detail")
    if (out.kind !== "detail") throw new Error("expected detail")
    expect(out.detail.id).toBe("ses_created_1")
    expect(out.detail.directory).toBe("/repo")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("uncertain with found exact but get missing returns pending with known child and zero SDK", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = connWith(() => { throw new Error("Peer closed") })
    const reader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}) as unknown,
      get: async () => ({ v: "1.0", status: "not_found" }),
      createOperation: async () => ({ v: "1.0", status: "found", createdSessionId: "ses_created_2" }),
    } as unknown as never
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: reader as never })
    expect(out.kind).toBe("pending")
    if (out.kind !== "pending") throw new Error("expected pending")
    expect(out.childId).toBe("ses_created_2")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("uncertain with exact not_found throws unresolved with zero SDK and no fabricated ID", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = connWith((req: never) => makeAmbiguous(req))
    const reader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}) as unknown,
      get: async () => ({ v: "1.0", status: "not_found" }),
      createOperation: async () => ({ v: "1.0", status: "not_found" }),
    } as unknown as never
    let thrown: unknown = null
    try {
      await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", privateReader: reader as never })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("create.unresolved")
    expect(String((thrown as Error).message)).not.toContain("ses_")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("sandboxInheritanceToken private success carries token with zero SDK", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_should_not_call"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let capturedReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        capturedReq = req as Record<string, unknown>
        return { id: 7, promise: Promise.resolve(makeSucceeded(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 7,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const token = "si-11111111-1111-4111-8111-111111111111"
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token, platform: "linux", metadata: {} })
    expect(out.kind).toBe("session")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect((capturedReq?.payload as Record<string, unknown>)?.sandboxInheritanceToken).toBe(token)
    expect(capturedReq?.opId).toBe(capturedReq?.idempotencyKey)
  })

  it("sandboxInheritanceToken uncertain never calls SDK and never leaks token in error", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_sdk"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const token = "si-22222222-2222-4222-8222-222222222222"
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => true }),
      peekPrivatePeerNextId: () => 9,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    let thrown: unknown = null
    try {
      await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token, privateReader: null })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("create.unresolved")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(String((thrown as Error).message)).not.toContain(token)
    expect(String((thrown as Error).message)).not.toContain("si-")
  })

  it("sandboxInheritanceToken retryable fence fallback exactly once same tuple+token", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_val_fallback"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const token = "si-33333333-3333-4333-8333-333333333333"
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return { id: 8, promise: Promise.resolve(makeRetryable(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 8,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const out = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token, privateReader: null })
    expect(out.kind).toBe("session")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.sandboxInheritanceToken).toBe(token)
  })
})
