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

const REQ = { requestId: "r1", opId: "prompt:msg_1", op: "session/prompt", idempotencyKey: "prompt:msg_1", context: { directory: "/tmp/ws", sessionId: "ses_1" }, payload: { messageId: "msg_1", parts: [] } }

function baseInput(over: Record<string, unknown>) {
  return {
    available: () => true,
    opId: (REQ.opId as string),
    scope: "Prompt" as const,
    request: REQ,
    dispatch: {
      factory: null,
      direct: null,
      cancel: null,
      invalidate: null,
      peek: null,
    },
    validate: () => {},
    fallback: async () => ({}),
    messageId: "msg_1",
    ...over,
  } as unknown as Parameters<typeof submitPrivateFirst>[0]
}

describe("session-submit accepted-only private-first", () => {

  test("first success uses one private zero SDK zero observe", async () => {
    let priv = 0
    let sdk = 0
    let obs = 0
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
      messageId: "msg_1",
      observeExact: async () => { obs += 1; return { kind: "unavailable" as const } },
    })
    expect(res).toEqual({})
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
    expect(obs).toBe(0)
  })

  test("first terminal throws zero observe zero SDK", async () => {
    for (const code of ["session.not_found", "scope_mismatch", "validation.failed"]) {
      let priv = 0
      let sdk = 0
      let obs = 0
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
          messageId: "msg_1",
          observeExact: async () => { obs += 1; return { kind: "unavailable" as const } },
        })
      } catch (e) { thrown = e }
      expect((thrown as { code?: string }).code).toBe(code)
      expect(priv).toBe(1)
      expect(sdk).toBe(0)
      expect(obs).toBe(0)
    }
  })

  test("ambiguous re-observes in-flight and returns accepted with one private zero SDK", async () => {
    let priv = 0
    let sdk = 0
    let obs = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: () => { priv += 1; return mockHandle(1, Promise.resolve(ambiguous(REQ as never))) },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; return {} },
      messageId: "msg_1",
      observeExact: async () => {
        obs += 1
        return { kind: "found" as const, operation: { opId: REQ.opId as string, outcome: "in-flight", code: "prompt.inflight", message: "prompt accepted" } }
      },
    })
    expect(res).toEqual({})
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
    expect(obs).toBe(1)
  })

  test("timeout re-observes succeeded and returns accepted with one private zero SDK", async () => {
    let priv = 0
    let sdk = 0
    let obs = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Command",
      request: REQ,
      dispatch: {
        factory: () => { priv += 1; return mockHandle(1, new Promise(() => {}), () => true) },
        direct: null,
        cancel: () => true,
        invalidate: null,
        peek: null,
      },
      validate: () => {},
      fallback: async () => { sdk += 1; return {} },
      messageId: "msg_1",
      observeExact: async () => {
        obs += 1
        return { kind: "found" as const, operation: { opId: REQ.opId as string, outcome: "succeeded", code: "ok", message: "ok" } }
      },
    })
    expect(res).toEqual({})
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
    expect(obs).toBe(1)
  })

  test("peerClosed re-observes failed and surfaces runtime-owned failure with zero SDK", async () => {
    let priv = 0
    let sdk = 0
    let obs = 0
    let thrown: unknown = null
    try {
      await submitPrivateFirst({
        available: () => true,
        opId: REQ.opId as string,
        scope: "Prompt",
        request: REQ,
        dispatch: {
          factory: () => { priv += 1; throw new Error("Peer closed") },
          direct: null,
          cancel: null,
          invalidate: null,
          peek: null,
        },
        validate: () => {},
        fallback: async () => { sdk += 1; return {} },
        messageId: "msg_1",
        observeExact: async () => {
          obs += 1
          return { kind: "found" as const, operation: { opId: REQ.opId as string, outcome: "failed", code: "E_RUNTIME", message: "runtime boom" } }
        },
      })
    } catch (e) { thrown = e }
    expect((thrown as { code?: string }).code).toBe("E_RUNTIME")
    expect((thrown as Error).message).toBe("runtime boom")
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
    expect(obs).toBe(1)
  })

  test("abandoned re-observation surfaces terminal with zero SDK", async () => {
    let sdk = 0
    let thrown: unknown = null
    try {
      await submitPrivateFirst(baseInput({
        scope: "Command",
        dispatch: {
          factory: () => mockHandle(1, Promise.resolve(ambiguous(REQ as never))),
          direct: null,
          cancel: null,
          invalidate: null,
          peek: null,
        },
        fallback: async () => { sdk += 1; return {} },
        observeExact: async () => ({ kind: "found" as const, operation: { opId: REQ.opId as string, outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned due to runtime restart" } }),
      }))
    } catch (e) { thrown = e }
    expect((thrown as { code?: string }).code).toBe("prompt.abandoned")
    expect(sdk).toBe(0)
  })

  test("uncertain with absent op returns unresolved with stable messageId zero SDK one private", async () => {
    let priv = 0
    let sdk = 0
    let obs = 0
    let thrown: unknown = null
    try {
      await submitPrivateFirst({
        available: () => true,
        opId: REQ.opId as string,
        scope: "Prompt",
        request: REQ,
        dispatch: {
          factory: () => { priv += 1; return mockHandle(1, Promise.resolve(ambiguous(REQ as never))) },
          direct: null,
          cancel: null,
          invalidate: null,
          peek: null,
        },
        validate: () => {},
        fallback: async () => { sdk += 1; return {} },
        messageId: "msg_1",
        observeExact: async () => { obs += 1; return { kind: "terminal" as const, error: new Error("not_found") } },
      })
    } catch (e) { thrown = e }
    expect((thrown as { code?: string }).code).toBe("prompt.unresolved")
    expect((thrown as Error).message).toContain("msg_1")
    expect((thrown as Error).message).toContain("No retry was issued")
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
    expect(obs).toBe(1)
  })

  test("uncertain with unavailable observer returns unresolved zero SDK", async () => {
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
          factory: () => { priv += 1; return mockHandle(1, Promise.reject(new Error("Peer closed"))) },
          direct: null,
          cancel: null,
          invalidate: null,
          peek: null,
        },
        validate: () => {},
        fallback: async () => { sdk += 1; return {} },
        messageId: "msg_9",
      })
    } catch (e) { thrown = e }
    expect((thrown as { code?: string }).code).toBe("command.unresolved")
    expect((thrown as Error).message).toContain("msg_9")
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
  })

  test("invalid wire re-observes once and returns accepted on match", async () => {
    let priv = 0
    let sdk = 0
    let obs = 0
    const res = await submitPrivateFirst({
      available: () => true,
      opId: REQ.opId as string,
      scope: "Prompt",
      request: REQ,
      dispatch: {
        factory: () => { priv += 1; return mockHandle(1, Promise.resolve({ bogus: true })) },
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
      messageId: "msg_1",
      observeExact: async () => {
        obs += 1
        return { kind: "found" as const, operation: { opId: REQ.opId as string, outcome: "succeeded", code: "ok", message: "ok" } }
      },
    })
    expect(res).toEqual({})
    expect(priv).toBe(1)
    expect(sdk).toBe(0)
    expect(obs).toBe(1)
  })

  test("opId mismatch in re-observation returns unresolved without fabricating accepted", async () => {
    let sdk = 0
    let thrown: unknown = null
    try {
      await submitPrivateFirst(baseInput({
        dispatch: {
          factory: () => mockHandle(1, Promise.resolve(ambiguous(REQ as never))),
          direct: null,
          cancel: null,
          invalidate: null,
          peek: null,
        },
        fallback: async () => { sdk += 1; return {} },
        observeExact: async () => ({ kind: "found" as const, operation: { opId: "prompt:msg_other", outcome: "succeeded", code: "ok", message: "ok" } }),
      }))
    } catch (e) { thrown = e }
    expect((thrown as { code?: string }).code).toBe("prompt.unresolved")
    expect(sdk).toBe(0)
  })

  test("retryable failed takes exactly one SDK no re-observe", async () => {
    const seen: unknown[] = []
    let sdk = 0
    let obs = 0
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
      messageId: "msg_1",
      observeExact: async () => { obs += 1; return { kind: "unavailable" as const } },
    })
    expect(seen).toHaveLength(1)
    expect(sdk).toBe(1)
    expect(obs).toBe(0)
  })

  test("pre-send no-private-available takes one SDK", async () => {
    let priv = 0
    let sdk = 0
    await submitPrivateFirst(baseInput({
      available: () => false,
      dispatch: {
        factory: () => { priv += 1; return mockHandle(1, Promise.resolve(succeeded(REQ as never))) },
        direct: null,
        cancel: null,
        invalidate: null,
        peek: null,
      },
      fallback: async () => { sdk += 1; return { data: null } },
    }))
    expect(priv).toBe(0)
    expect(sdk).toBe(1)
  })
})
