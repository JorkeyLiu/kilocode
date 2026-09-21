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

function makeFailed(req: { requestId: string; opId: string; idempotencyKey: string }) {
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

describe("createSessionPrivateFirst private-first with single SDK fallback", () => {
  it("private succeeded dominates without SDK", async () => {
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
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", platform: "linux", metadata: {} })
    expect((sess as unknown as { id: string }).id).toBe("ses_private_ok")
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
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", platform: "linux", metadata: meta as unknown as Record<string, unknown>, title: "hello", parentID: "ses_parent" })
    expect((sess as unknown as { id: string }).id).toBe("ses_private_ok")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(capturedPayload).toEqual(expect.objectContaining({ platform: "linux", metadata: meta, title: "hello", parentID: "ses_parent" }))
  })

  it.each([
    ["failed", (req: never) => makeFailed(req)],
    ["ambiguous", (req: never) => makeAmbiguous(req)],
    ["invalid-null-session", (req: never) => ({ v: 1, requestId: (req as unknown as { requestId: string }).requestId, opId: (req as unknown as { opId: string }).opId, op: "session/create", idempotencyKey: (req as unknown as { idempotencyKey: string }).idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: null } })],
    ["invalid-bad-id", (req: never) => ({ v: 1, requestId: (req as unknown as { requestId: string }).requestId, opId: (req as unknown as { opId: string }).opId, op: "session/create", idempotencyKey: (req as unknown as { idempotencyKey: string }).idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: { id: "bad", directory: "/repo", title: "x" } } })],
    ["invalid-accepted-mismatch", (req: never) => ({ v: 1, requestId: (req as unknown as { requestId: string }).requestId, opId: (req as unknown as { opId: string }).opId, op: "session/create", idempotencyKey: (req as unknown as { idempotencyKey: string }).idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: false, data: { session: makeSession() } })],
    ["invalid-failed-missing-failure", (req: never) => ({ v: 1, requestId: (req as unknown as { requestId: string }).requestId, opId: (req as unknown as { opId: string }).opId, op: "session/create", idempotencyKey: (req as unknown as { idempotencyKey: string }).idempotencyKey, status: "failed", outcome: { type: "failed", time: Date.now(), failure: { code: "validation.failed", message: "bad", retryable: false } }, accepted: false })],
    ["throw", () => { throw new Error("transport") }],
    ["capability absence", () => { throw new Error("Private peer missing session/create capability") }],
    ["closed drift", () => { throw Object.assign(new Error("Peer closed"), { code: -32603 }) }],
  ])("fallback class %s calls SDK once with same identity", async (_, maker) => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_fallback"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
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
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_fallback")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect((sdkInput.context as Record<string, unknown>).directory).toBe("/repo")
    expect((sdkInput.context as Record<string, unknown>).parentSessionId).toBeNull()
  })

  it("timeout fallback calls SDK once with same identity", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_timeout"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return { id: 3, promise: new Promise(() => {}), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 3,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_timeout")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
  })

  it("sandboxInheritanceToken private-first carries token, private success 0 SDK", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_sandbox"), error: undefined }))
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
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token, platform: "linux", metadata: {} })
    expect((sess as unknown as { id: string }).id).toBe("ses_private_ok")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect((capturedReq?.payload as Record<string, unknown>)?.sandboxInheritanceToken).toBe(token)
    // tuple coherence: same durable opId/idempotencyKey/requestId that would be used for SDK fallback
    expect(typeof capturedReq?.opId).toBe("string")
    expect(capturedReq?.opId).toBe(capturedReq?.idempotencyKey)
    expect(typeof capturedReq?.requestId).toBe("string")
    expect((capturedReq?.context as Record<string, unknown>)?.directory).toBe("/repo")
    expect((capturedReq?.context as Record<string, unknown>)?.parentSessionId).toBeNull()
    // token is carried as ephemeral request payload only (process-in reserve/commit + immediate sha256),
    // not as SDK-side persistent identity — success private path does not call SDK
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("sandboxInheritanceToken unavailable/timeout fallback exactly-one SDK same tuple+token", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_sandbox_fallback"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => false,
      privateCreateWithHandle: mock(() => { throw new Error("unavailable") }),
    } as unknown as never
    const token = "si-22222222-2222-4222-8222-222222222222"
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token })
    expect((sess as unknown as { id: string }).id).toBe("ses_sandbox_fallback")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.sandboxInheritanceToken).toBe(token)
    expect(typeof sdkInput.opId).toBe("string")
    expect(typeof sdkInput.requestId).toBe("string")
    expect(sdkInput.opId).toBe(sdkInput.idempotencyKey)
    // ephemeral token is carried as request payload, server immediately hashes to sha256 and persists only hash
    expect(sdkInput.sandboxInheritanceToken).toBe(token)
  })

  it("private unavailable fallback calls SDK once", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_unavail"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => false,
      privateCreateWithHandle: mock(() => { throw new Error("unavailable") }),
    } as unknown as never
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_unavail")
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it("sandboxInheritanceToken private validation failure fallback exactly once same tuple+token", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_val_fallback"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const token = "si-33333333-3333-4333-8333-333333333333"
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        // private returns validation.failed (e.g. token shape invalid or grant gone) -> must fallback
        return { id: 8, promise: Promise.resolve(makeFailed(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 8,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token })
    expect((sess as unknown as { id: string }).id).toBe("ses_val_fallback")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    // same tuple must be reused for fallback
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect((sdkInput.context as Record<string, unknown>).directory).toBe("/repo")
    expect((sdkInput.context as Record<string, unknown>).parentSessionId).toBeNull()
    // same ephemeral token must be carried to SDK (server hashes, never persists plaintext as identity)
    expect(sdkInput.sandboxInheritanceToken).toBe(token)
    expect((privateReq?.payload as Record<string, unknown>)?.sandboxInheritanceToken).toBe(token)
    expect(sdkInput.opId).toBe(sdkInput.idempotencyKey)
  })

  it("sandboxInheritanceToken private timeout fallback exactly once same tuple+token", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_timeout_token"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const token = "si-44444444-4444-4444-8444-444444444444"
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        // never resolves -> triggers 3s private timeout fallback
        return { id: 9, promise: new Promise(() => {}), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 9,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token })
    expect((sess as unknown as { id: string }).id).toBe("ses_timeout_token")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.idempotencyKey).toBe(privateReq?.idempotencyKey)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
    expect(sdkInput.sandboxInheritanceToken).toBe(token)
    expect((privateReq?.payload as Record<string, unknown>)?.sandboxInheritanceToken).toBe(token)
  })

  it("sandboxInheritanceToken private success zero SDK, no second SDK retry on same token", async () => {
    const sdk = mock(async () => ({ data: makeSession("ses_should_not_call"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const token = "si-55555555-5555-4555-8555-555555555555"
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return { id: 11, promise: Promise.resolve(makeSucceeded(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 11,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token })
    expect((sess as unknown as { id: string }).id).toBe("ses_private_ok")
    expect(sdk).toHaveBeenCalledTimes(0)
    // private payload carries ephemeral token (hashed server-side, not persisted as SDK identity)
    expect((privateReq?.payload as Record<string, unknown>)?.sandboxInheritanceToken).toBe(token)
    expect(privateReq?.opId).toBe(privateReq?.idempotencyKey)
    // ensure no SDK input was built with token as persistent identity
    expect(sdk.mock.calls.length).toBe(0)
  })

  it("sandboxInheritanceToken capability absence fallback exactly once same tuple+token", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_cap_fallback"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const token = "si-66666666-6666-4666-8666-666666666666"
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        throw new Error("Private peer missing session/create capability")
      },
      peekPrivatePeerNextId: () => 12,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: token })
    expect((sess as unknown as { id: string }).id).toBe("ses_cap_fallback")
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.sandboxInheritanceToken).toBe(token)
    // tuple must be same as the attempted private request (ephemeral, not persistent)
    expect(sdkInput.opId).toBe(privateReq?.opId)
    expect(sdkInput.requestId).toBe(privateReq?.requestId)
  })
})
