import { describe, expect, it, mock } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { deleteSessionPrivateFirst, buildDeleteIdentity } from "../../src/kilo-provider/session-delete"
import { validateDeleteResult } from "../../src/services/cli-backend/serve-private-peer"

function makeSucceeded(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/delete",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: {},
  }
}

function makeFailed(req: { requestId: string; opId: string; idempotencyKey: string }, code = "session.not_found", message = "session not found", retryable = false) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/delete",
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
    op: "session/delete",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  }
}

describe("ServePrivatePeer validateDeleteResult failed envelope coherence", () => {
  it("failed with accepted true is invalid and triggers unknown path (no SDK fallback)", async () => {
    const makeReq = (r: { requestId: string; opId: string; idempotencyKey: string }) => ({ v: 1 as const, requestId: r.requestId, opId: r.opId, op: "session/delete" as const, idempotencyKey: r.idempotencyKey, context: { directory: "/repo", sessionId: "ses_bad", parentSessionId: null as string | null }, payload: {} as Record<string, never> })
    const base = { requestId: "req1", opId: "delete:ses_bad:tok1", idempotencyKey: "delete:ses_bad:tok1" }
    const req = makeReq(base)
    const malformedAcceptedTrue = {
      v: 1,
      requestId: base.requestId,
      opId: base.opId,
      op: "session/delete",
      idempotencyKey: base.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "x", retryable: false } },
      accepted: true,
      failure: { code: "internal", message: "x", retryable: false },
    }
    expect(() => validateDeleteResult(malformedAcceptedTrue as unknown, req as never)).toThrow()
    // ensure provider treats malformed failed with accepted:true as unknown, not retryable fallback
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => true,
      privateDeleteWithHandle: (r: unknown) => {
        const rr = r as { requestId: string; opId: string; idempotencyKey: string }
        const malformed = {
          v: 1,
          requestId: rr.requestId,
          opId: rr.opId,
          op: "session/delete",
          idempotencyKey: rr.idempotencyKey,
          status: "failed",
          outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "x", retryable: true } },
          accepted: true,
          failure: { code: "internal", message: "x", retryable: true },
        }
        return { id: 9, promise: Promise.resolve(malformed), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 9,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    let caught: unknown
    try { await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_bad", directory: "/repo" }) } catch (e) { caught = e }
    expect((caught as { terminal?: boolean; code?: string }).terminal).toBeTrue()
    expect((caught as { code?: string }).code).toBe("unknown")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("failed with mismatched failure code is invalid (unknown, no fallback)", async () => {
    const base = { requestId: "req2", opId: "delete:ses_bad2:tok2", idempotencyKey: "delete:ses_bad2:tok2" }
    const req = { v: 1 as const, requestId: base.requestId, opId: base.opId, op: "session/delete" as const, idempotencyKey: base.idempotencyKey, context: { directory: "/repo", sessionId: "ses_bad2", parentSessionId: null as string | null }, payload: {} as Record<string, never> }
    const mismatched = {
      v: 1,
      requestId: base.requestId,
      opId: base.opId,
      op: "session/delete",
      idempotencyKey: base.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "x", retryable: false } },
      accepted: false,
      failure: { code: "different", message: "x", retryable: false },
    }
    expect(() => validateDeleteResult(mismatched as unknown, req as never)).toThrow()
  })

  it("failed missing accepted is invalid", () => {
    const base = { requestId: "req3", opId: "delete:ses_bad3:tok3", idempotencyKey: "delete:ses_bad3:tok3" }
    const req = { v: 1 as const, requestId: base.requestId, opId: base.opId, op: "session/delete" as const, idempotencyKey: base.idempotencyKey, context: { directory: "/repo", sessionId: "ses_bad3", parentSessionId: null as string | null }, payload: {} as Record<string, never> }
    const missing = {
      v: 1,
      requestId: base.requestId,
      opId: base.opId,
      op: "session/delete",
      idempotencyKey: base.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "x", retryable: true } },
      failure: { code: "internal", message: "x", retryable: true },
    }
    expect(() => validateDeleteResult(missing as unknown, req as never)).toThrow()
  })
})

describe("deleteSessionPrivateFirst private-first with single SDK fallback", () => {
  it("private succeeded returns without SDK mutation", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let capturedReq: unknown = null
    const conn = {
      isPrivateAvailable: () => true,
      privateDeleteWithHandle: (req: unknown) => {
        capturedReq = req
        return { id: 1, promise: Promise.resolve(makeSucceeded(req as never)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 1,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(capturedReq).toBeTruthy()
    const req = capturedReq as Record<string, unknown>
    expect(String(req.opId).startsWith("delete:ses_src:")).toBeTrue()
    expect(req.opId).toBe(req.idempotencyKey)
  })

  it("private terminal failed does not call SDK", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => true,
      privateDeleteWithHandle: (req: unknown) => {
        return { id: 2, promise: Promise.resolve(makeFailed(req as never, "session.not_found", "session not found", false)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 2,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    await expect(deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })).rejects.toBeTruthy()
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it.each([
    ["retryable-failed", (req: never) => makeFailed(req, "internal", "internal", true)],
    ["capability absence", () => { throw new Error("Private peer missing session/delete capability") }],
  ])("fallback class %s calls durable SDK once with same tuple", async (_, maker) => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateDeleteWithHandle: (req: unknown) => {
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
    await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect(sdk).toHaveBeenCalledTimes(1)
    const sdkArg = (sdk.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(sdkArg.sessionID).toBe("ses_src")
    expect((sdkArg.query_directory ?? sdkArg.directory) as unknown).toBe("/repo")
    expect((sdkArg.body_directory ?? sdkArg.directory) as unknown).toBe("/repo")
    expect(sdkArg.opId).toBe(privateReq!.opId)
    expect(sdkArg.idempotencyKey).toBe(privateReq!.idempotencyKey)
    expect(sdkArg.requestId).toBe(privateReq!.requestId)
    expect((sdkArg.context as Record<string, unknown>).directory).toBe("/repo")
    expect((sdkArg.context as Record<string, unknown>).sessionId).toBe("ses_src")
  })

  it.each([
    ["ambiguous", (req: never) => makeAmbiguous(req)],
    ["invalid-accepted-mismatch", (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), accepted: false })],
    ["invalid-transport-unknown", (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), transportUnknown: true })],
    ["invalid-data-non-empty", (req: never) => ({ ...(makeSucceeded(req as unknown as never) as object), data: { unexpected: true } })],
    ["failed-accepted-true", (req: never) => ({ ...makeFailed(req as unknown as never, "internal", "x", false), accepted: true })],
    ["failed-missing-failure", (req: never) => { const r = makeFailed(req as unknown as never, "internal", "x", true); delete (r as Record<string, unknown>).failure; return r }],
    ["failed-transport-unknown", (req: never) => ({ ...makeFailed(req as unknown as never, "internal", "x", false), transportUnknown: true })],
    ["throw", () => { throw new Error("transport") }],
    ["closed drift", () => { throw Object.assign(new Error("Peer closed"), { code: -32603 }) }],
  ])("unknown class %s does not call SDK and throws terminal unknown", async (_, maker) => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateDeleteWithHandle: (req: unknown) => {
        calls += 1
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
    let caught: unknown
    try {
      await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeTruthy()
    const e = caught as { terminal?: boolean; code?: string }
    expect(e.terminal).toBeTrue()
    expect(e.code).toBe("unknown")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(calls).toBe(2)
  })

  it("private unavailable calls SDK once", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => false,
    } as unknown as never
    await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it("private malformed failed with accepted:true does not fallback to SDK (unknown)", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateDeleteWithHandle: (req: unknown) => {
        calls += 1
        const malformed = { ...makeFailed(req as never, "internal", "x", true), accepted: true }
        return { id: 2, promise: Promise.resolve(malformed), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 2,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    let caught: unknown
    try { await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" }) } catch (e) { caught = e }
    expect((caught as { terminal?: boolean; code?: string }).terminal).toBeTrue()
    expect((caught as { code?: string }).code).toBe("unknown")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(calls).toBe(2)
  })
})
