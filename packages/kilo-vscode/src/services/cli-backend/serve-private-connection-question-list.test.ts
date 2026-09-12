import { describe, expect, test } from "bun:test"
import { questionListHandle } from "./serve-private-question-list-connection"
import { canonicalQuestionListOpId } from "./serve-private-question-list-contract"

function listReq(token = "tok1") {
  const opId = canonicalQuestionListOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "question/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function succeeded(req: ReturnType<typeof listReq>, items: unknown = []) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "question/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded" as const,
      outcome: { type: "succeeded" as const, time: 1 },
      accepted: true as const,
      data: { questions: items },
    },
  }
}

function vague(req: ReturnType<typeof listReq>) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "question/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous" as const,
      outcome: { type: "ambiguous" as const, time: 1 },
      accepted: false as const,
      transportUnknown: true as const,
    },
  }
}

function deps(peer: unknown, epoch: number | null = 7, live = true) {
  return { peer: peer as never, live, epoch, invalidate: () => {} }
}

describe("question/list connection handle", () => {
  test("unavailable peer throws without transport", () => {
    const req = listReq()
    expect(() => questionListHandle(deps(null), req as never)).toThrow("Private peer unavailable")
  })

  test("missing capability throws fail-closed", () => {
    const req = listReq()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      privateQuestionListWithHandle: () => {
        throw new Error("must not be called")
      },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() => questionListHandle(deps(peer), req as never)).toThrow(
      "Private peer missing question/list capability",
    )
  })

  test("current epoch passes success through with exact id", async () => {
    const req = listReq()
    const peer = {
      isAvailable: () => true,
      hasCapability: (c: string) => c === "question/list",
      privateQuestionListWithHandle: (r: Record<string, unknown>) => ({
        id: 11,
        promise: Promise.resolve(succeeded(req)),
        cancel: () => true,
      }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const handle = questionListHandle(deps(peer), req as never)
    expect(handle.id).toBe(11)
    const out = await handle.promise
    expect(out.kind).toBe("valid")
  })

  test("settled success survives epoch drift", async () => {
    const req = listReq()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateQuestionListWithHandle: () => ({
        id: 3,
        promise: Promise.resolve(succeeded(req)),
        cancel: () => true,
      }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const conn = { peer: peer as never, live: true, epoch: 7 as number | null, invalidate: () => {} }
    const handle = questionListHandle(conn, req as never)
    conn.epoch = 8
    const out = await handle.promise
    expect(out.kind).toBe("valid")
    if (out.kind === "valid") expect(out.result.status).toBe("succeeded")
  })

  test("unresolved drift maps to ambiguous", async () => {
    const req = listReq()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateQuestionListWithHandle: () => ({
        id: 4,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const conn = { peer: peer as never, live: true, epoch: 7 as number | null, invalidate: () => {} }
    const handle = questionListHandle(conn, req as never)
    conn.epoch = 8
    const out = await handle.promise
    expect(out.kind).toBe("valid")
    if (out.kind === "valid") expect(out.result.status).toBe("ambiguous")
  })

  test("exact cancel delegates to captured peer", () => {
    const req = listReq()
    let cancelled: number | null = null
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateQuestionListWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
      tryCancelPending: (id: number) => {
        cancelled = id
        return true
      },
      invalidateOnObserverTimeout: () => {},
    }
    const handle = questionListHandle(deps(peer), req as never)
    expect(handle.id).toBe(42)
    expect(handle.cancel("probe")).toBeTrue()
    expect(cancelled).toBe(42)
  })
})
