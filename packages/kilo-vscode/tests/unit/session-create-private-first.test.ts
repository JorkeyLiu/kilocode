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

  it("sandboxInheritanceToken bypasses private and uses exactly one SDK with token", async () => {
    const sdk = mock(async (input: Record<string, unknown>) => ({ data: makeSession("ses_sandbox"), error: undefined }))
    const client = { session: { create: sdk } } as unknown as KiloClient
    const privateMock = mock(() => { throw new Error("should not be called") })
    const conn = {
      isPrivateAvailable: () => true,
      privateCreateWithHandle: privateMock,
      privateCreate: privateMock,
    } as unknown as never
    const sess = await createSessionPrivateFirst({ client, connection: conn as never, directory: "/repo", sandboxInheritanceToken: "si_123", platform: "linux", metadata: {} })
    expect((sess as unknown as { id: string }).id).toBe("ses_sandbox")
    expect(privateMock).toHaveBeenCalledTimes(0)
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkInput = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(sdkInput.sandboxInheritanceToken).toBe("si_123")
    expect(sdkInput.opId).toBeUndefined()
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
})
