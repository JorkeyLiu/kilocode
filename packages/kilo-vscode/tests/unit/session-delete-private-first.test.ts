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

function connWith(maker: (req: never) => unknown, onCall?: () => void) {
  return {
    isPrivateAvailable: () => true,
    privateDeleteWithHandle: (req: unknown) => {
      onCall?.()
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
}

function tombstoneReader(status: "found" | "not_found" | "scope_mismatch", calls?: { n: number }) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({}) as unknown,
    get: async () => ({}) as unknown,
    deleteOperation: async () => {
      if (calls) calls.n += 1
      return { v: "1.0", status }
    },
  } as unknown as never
}

describe("ServePrivatePeer validateDeleteResult failed envelope coherence", () => {
  it("failed with accepted true is invalid and triggers unresolved path (no SDK, single mutation + single observation)", async () => {
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
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let privateCalls = 0
    const conn = connWith((rr: unknown) => {
      const r = rr as { requestId: string; opId: string; idempotencyKey: string }
      return {
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: "session/delete",
        idempotencyKey: r.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "x", retryable: true } },
        accepted: true,
        failure: { code: "internal", message: "x", retryable: true },
      }
    }, () => { privateCalls += 1 })
    let caught: unknown
    try { await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_bad", directory: "/repo", privateReader: null }) } catch (e) { caught = e }
    expect((caught as { terminal?: boolean; code?: string }).terminal).toBeTrue()
    expect((caught as { code?: string }).code).toBe("delete.unresolved")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privateCalls).toBe(1)
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

describe("deleteSessionPrivateFirst accepted-only with exact tombstone re-observe", () => {
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
    await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: null })
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(capturedReq).toBeTruthy()
    const req = capturedReq as Record<string, unknown>
    expect(String(req.opId).startsWith("delete:ses_src:")).toBeTrue()
    expect(req.opId).toBe(req.idempotencyKey)
  })

  it("private terminal failed does not call SDK", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    const conn = connWith((req: unknown) => makeFailed(req as never, "session.not_found", "session not found", false))
    await expect(deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: null })).rejects.toBeTruthy()
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("validated pre-accept retryable calls durable SDK once with same tuple", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let privateReq: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateDeleteWithHandle: (req: unknown) => {
        privateReq = req as Record<string, unknown>
        return { id: 2, promise: Promise.resolve(makeFailed(req as never, "internal", "internal", true)), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 2,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: null })
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
    ["capability absence after send", () => { throw new Error("Private peer missing session/delete capability") }],
    ["closed drift", () => { throw Object.assign(new Error("Peer closed"), { code: -32603 }) }],
  ])("unknown class %s single mutation + single observation, zero SDK, throws delete.unresolved", async (_, maker) => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let privateCalls = 0
    const obsCalls = { n: 0 }
    const conn = connWith(maker as (r: never) => unknown, () => { privateCalls += 1 })
    const reader = tombstoneReader("not_found", obsCalls)
    let caught: unknown
    try {
      await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: reader as never })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeTruthy()
    const e = caught as { terminal?: boolean; code?: string; message?: string }
    expect(e.terminal).toBeTrue()
    expect(e.code).toBe("delete.unresolved")
    expect(String(e.message)).toContain("opId=delete:ses_src:")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privateCalls).toBe(1)
    expect(obsCalls.n).toBe(1)
  })

  it("unknown with tombstone found returns for caller prune with zero SDK", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let privateCalls = 0
    const obsCalls = { n: 0 }
    const conn = connWith((req: never) => makeAmbiguous(req), () => { privateCalls += 1 })
    const reader = tombstoneReader("found", obsCalls)
    await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: reader as never })
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privateCalls).toBe(1)
    expect(obsCalls.n).toBe(1)
  })

  it.each([["not_found"], ["scope_mismatch"]] as Array<["not_found" | "scope_mismatch"]>)("unknown with tombstone %s throws unresolved with no prune", async (status) => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    const conn = connWith((req: never) => makeAmbiguous(req))
    const reader = tombstoneReader(status)
    let caught: unknown
    try {
      await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: reader as never })
    } catch (e) {
      caught = e
    }
    expect((caught as { code?: string }).code).toBe("delete.unresolved")
    expect((caught as { terminal?: boolean }).terminal).toBeTrue()
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("unknown with unavailable reader throws unresolved with stable identity, zero SDK", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let privateCalls = 0
    const conn = connWith((req: never) => makeAmbiguous(req), () => { privateCalls += 1 })
    let caught: unknown
    try {
      await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: null })
    } catch (e) {
      caught = e
    }
    expect((caught as { code?: string }).code).toBe("delete.unresolved")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privateCalls).toBe(1)
  })

  it("private unavailable pre-send calls SDK once", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => false,
    } as unknown as never
    await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: null })
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it("private malformed failed with accepted:true resolves via observation, no SDK second mutation", async () => {
    const sdk = mock(async () => ({ data: true, error: undefined }))
    const client = { session: { delete: sdk } } as unknown as KiloClient
    let privateCalls = 0
    const obsCalls = { n: 0 }
    const conn = connWith((req: unknown) => {
      const malformed = { ...makeFailed(req as never, "internal", "x", true), accepted: true }
      return malformed
    }, () => { privateCalls += 1 })
    const reader = tombstoneReader("not_found", obsCalls)
    let caught: unknown
    try { await deleteSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo", privateReader: reader as never }) } catch (e) { caught = e }
    expect((caught as { terminal?: boolean; code?: string }).terminal).toBeTrue()
    expect((caught as { code?: string }).code).toBe("delete.unresolved")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privateCalls).toBe(1)
    expect(obsCalls.n).toBe(1)
  })

  it("buildDeleteIdentity is strict delete:<sessionId>:<uuid>", async () => {
    const { opId, idempotencyKey } = buildDeleteIdentity("ses_src")
    expect(opId.startsWith("delete:ses_src:")).toBeTrue()
    expect(opId).toBe(idempotencyKey)
    const token = opId.slice("delete:ses_src:".length)
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)).toBeTrue()
  })
})
