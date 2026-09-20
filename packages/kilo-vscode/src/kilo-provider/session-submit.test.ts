import { describe, expect, test } from "bun:test"
import { submitPrivateFirst } from "./session-submit"

function mockHandle(id: number, promise: Promise<unknown>, cancel?: () => boolean) {
  return { id, promise, cancel: cancel ?? (() => true) }
}

function succeeded(request: Record<string, unknown>) {
  return {
    requestId: request.requestId,
    opId: request.opId,
    op: request.op,
    idempotencyKey: request.idempotencyKey,
    status: "succeeded",
    accepted: true,
    outcome: { type: "succeeded", time: 1 },
    data: { accepted: true },
  }
}

function terminalFailed(request: Record<string, unknown>, code = "validation.failed") {
  return {
    requestId: request.requestId,
    opId: request.opId,
    op: request.op,
    idempotencyKey: request.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: code, retryable: false } },
    accepted: false,
    failure: { code, message: code, retryable: false },
  }
}

function retryableFailed(request: Record<string, unknown>) {
  return {
    requestId: request.requestId,
    opId: request.opId,
    op: request.op,
    idempotencyKey: request.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true } },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
  }
}

function ambiguous(request: Record<string, unknown>) {
  return {
    requestId: request.requestId,
    opId: request.opId,
    op: request.op,
    idempotencyKey: request.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

describe("session-submit shared retry", () => {
  const REQ = { requestId: "r1", opId: "prompt:msg_1", op: "session/prompt", idempotencyKey: "prompt:msg_1", context: { directory: "/tmp/ws", sessionId: "ses_1" }, payload: { messageId: "msg_1", parts: [] } }

  test("first success uses one private zero SDK", async () => {
    let priv = 0
    let sdk = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: () => { priv += 1; return mockHandle(1, Promise.resolve(succeeded(REQ as never))) },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; return {} },
    })
    expect(res).toEqual({})
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
  })

  test("first terminal throws zero retry zero SDK", async () => {
    for (const code of ["session.not_found", "scope_mismatch", "validation.failed"]) {
      let priv = 0
      let sdk = 0
      let thrown: unknown = null
      try {
        await submitPrivateFirst({
          available: () => true,
          opId: REQ.opId as string,
          scope: "Command",
          request: REQ,
          dispatch: {
            factory: () => { priv += 1; return mockHandle(1, Promise.resolve(terminalFailed(REQ as never, code))) },
            direct: null,
            cancel: null,
            invalidate: null,
            peek: null,
          },
          validate: () => {},
          fallback: async () => { sdk += 1; return {} },
        })
      } catch (e) { thrown = e }
      expect((thrown as { code?: string }).code).toBe(code)
      expect(priv).toBe(1)
      expect(sdk).toBe(0)
    }
  })

  test("first timeout then private success uses two privates zero SDK and same tuple", async () => {
    const seen: unknown[] = []
    let sdk = 0
    let attempt = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: (req: unknown) => {
          seen.push(req)
          attempt += 1
          if (attempt === 1) {
            // never resolves -> timeout
            return mockHandle(1, new Promise(() => {}), () => true)
          }
          return mockHandle(2, Promise.resolve(succeeded(req as Record<string, unknown>)))
        },
        direct: null,
        cancel: () => true,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; return {} },
    })
    expect(res).toEqual({})
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect((seen[0] as Record<string, unknown>).requestId).toBe((seen[1] as Record<string, unknown>).requestId)
    expect((seen[0] as Record<string, unknown>).opId).toBe((seen[1] as Record<string, unknown>).opId)
    expect((seen[0] as Record<string, unknown>).idempotencyKey).toBe((seen[1] as Record<string, unknown>).idempotencyKey)
  })

  test("first ambiguous then private success uses two privates zero SDK tuple same", async () => {
    const seen: unknown[] = []
    let sdk = 0
    let attempt = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Command",
      request: REQ,
      dispatch: {
        factory: (req: unknown) => {
          seen.push(req)
          attempt += 1
          if (attempt === 1) return mockHandle(1, Promise.resolve(ambiguous(req as Record<string, unknown>)))
          return mockHandle(2, Promise.resolve(succeeded(req as Record<string, unknown>)))
        },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; return {} },
    })
    expect(res).toEqual({})
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  test("first peerClosed then private success zero SDK", async () => {
    let sdk = 0
    let attempt = 0
    let factoryCalls = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: (req: unknown) => {
          factoryCalls += 1
          attempt += 1
          if (attempt === 1) throw new Error("Peer closed")
          return mockHandle(2, Promise.resolve(succeeded(req as Record<string, unknown>)))
        },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; return {} },
    })
    expect(res).toEqual({})
    expect(sdk).toBe(0)
    expect(factoryCalls).toBe(2)
  })

  test("two transport uncertainties then one SDK fallback and tuple same", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const sdkSeen: unknown[] = []
    await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: (req: unknown) => {
          seen.push(req)
          return mockHandle(1, Promise.resolve(ambiguous(req as Record<string, unknown>)))
        },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; sdkSeen.push(REQ); return { data: null } },
    })
    expect(sdk).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect(sdkSeen).toHaveLength(1)
  })

  test("retryable failed takes exactly one SDK no private retry", async () => {
    const seen: unknown[] = []
    let sdk = 0
    await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Command",
      request: REQ,
      dispatch: {
        factory: (req: unknown) => {
          seen.push(req)
          return mockHandle(1, Promise.resolve(retryableFailed(req as Record<string, unknown>)))
        },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; return { data: null } },
    })
    expect(seen).toHaveLength(1)
    expect(sdk).toBe(1)
  })

  test("second terminal after retry throws zero SDK", async () => {
    let sdk = 0
    let attempt = 0
    let thrown: unknown = null
    try {
      await submitPrivateFirst({
        available: () => true,
        opId: REQ.opId as string,
        scope: "Prompt",
        request: REQ,
        dispatch: {
          factory: (req: unknown) => {
            attempt += 1
            if (attempt === 1) return mockHandle(1, Promise.resolve(ambiguous(req as Record<string, unknown>)))
            return mockHandle(2, Promise.resolve(terminalFailed(req as Record<string, unknown>, "validation.failed")))
          },
          direct: null,
          cancel: null,
          invalidate: null,
          peek: null,
        },
        validate: () => {},
        fallback: async () => { sdk += 1; return { data: null } },
      })
    } catch (e) { thrown = e }
    expect((thrown as { code?: string }).code).toBe("validation.failed")
    expect(sdk).toBe(0)
    expect(attempt).toBe(2)
  })

  test("fallback still exactly once with never new tuple", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const fallbackReqs: unknown[] = []
    await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: (req: unknown) => {
          seen.push(req)
          return mockHandle(1, Promise.reject(new Error("Peer closed")))
        },
        direct: null,
        cancel: () => true,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; fallbackReqs.push(REQ); return { data: null } },
    })
    expect(sdk).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(REQ)
    expect(seen[1]).toBe(REQ)
    expect(fallbackReqs).toHaveLength(1)
  })

  test("invalid wire on first then success still zero SDK tuple same", async () => {
    const seen: unknown[] = []
    let sdk = 0
    let attempt = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: (req: unknown) => {
          seen.push(req)
          attempt += 1
          if (attempt === 1) return mockHandle(1, Promise.resolve({ bogus: true, requestId: (req as Record<string, unknown>).requestId, opId: (req as Record<string, unknown>).opId, op: (req as Record<string, unknown>).op, idempotencyKey: (req as Record<string, unknown>).idempotencyKey }))
          return mockHandle(2, Promise.resolve(succeeded(req as Record<string, unknown>)))
        },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      validate: (r: unknown) => {
        const typed = r as Record<string, unknown>
        if ((typed as { bogus?: boolean }).bogus) throw new Error("bad")
      },
      fallback: async () => { sdk += 1; return {} },
    })
    expect(res).toEqual({})
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })
})
