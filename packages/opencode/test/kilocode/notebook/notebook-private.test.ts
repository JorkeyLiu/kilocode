import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  canonicalNotebookListOpId,
  canonicalNotebookOpId,
  OP_LIST,
  OP_REJECT,
  OP_REPLY,
  parseNotebookListOpId,
  parseNotebookOpId,
  rejectNotebookPrivate,
  replyNotebookPrivate,
  validateNotebookListRequest,
  validateNotebookRejectRequest,
  validateNotebookReplyRequest,
} from "../../../src/kilocode/notebook/notebook-private"
import { InvalidReplyError, NotFoundError, type Interface } from "../../../src/kilocode/notebook/service"

const RID = "nbr_abc123def456"
const DIR = "/tmp/notebook-private-test"

function replyReq(opId: string, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: OP_REPLY,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: {
      result: { operation: "read", path: "b.ipynb", requestPath: "b.ipynb", revision: "r1", cells: [] },
    },
    ...over,
  }
}

function rejectReq(opId: string) {
  return {
    v: 1 as const,
    requestId: "req-2",
    opId,
    op: OP_REJECT,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: { error: { code: "timeout", message: "timed out" } },
  }
}

function listReq(opId: string) {
  return {
    v: 1 as const,
    requestId: "req-3",
    opId,
    op: OP_LIST,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: {},
  }
}

function stub(over: Partial<Interface>): Interface {
  return {
    request: () => Effect.die(new Error("unused")),
    list: () => Effect.succeed([]),
    cancelSession: () => Effect.void,
    reply: () => Effect.void as never,
    reject: () => Effect.void as never,
    ...over,
  } as Interface
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A, never>)

describe("notebook private opIds", () => {
  test("canonical builder and parser round-trip reply and list ids", () => {
    const opId = canonicalNotebookOpId(RID, "tok-good")
    expect(opId).toBe(`notebook:${RID}:tok-good`)
    expect(parseNotebookOpId(opId)).toEqual({ requestID: RID, token: "tok-good" })
    const listId = canonicalNotebookListOpId("tok-list")
    expect(listId).toBe("notebook-list:tok-list")
    expect(parseNotebookListOpId(listId)).toEqual({ token: "tok-list" })
  })

  test("builders and parsers reject null bytes, path material, and wrong kinds", () => {
    expect(() => canonicalNotebookOpId(RID, "tok\0bad")).toThrow()
    expect(() => canonicalNotebookOpId("que_123", "tok")).toThrow()
    expect(() => canonicalNotebookOpId("nbr_a/b", "tok")).toThrow()
    expect(() => canonicalNotebookOpId(RID, "a/b")).toThrow()
    expect(() => parseNotebookOpId(`question:${RID}:tok`)).toThrow()
    expect(() => parseNotebookOpId(`notebook:${RID}`)).toThrow()
    expect(() => parseNotebookOpId(`notebook:bad:tok`)).toThrow()
    expect(() => parseNotebookOpId(`notebook:${RID}:tok\0`)).toThrow()
    expect(() => parseNotebookListOpId("notebook:tok")).toThrow()
    expect(() => parseNotebookListOpId("notebook-list:")).toThrow()
    expect(() => canonicalNotebookListOpId("tok:colon")).toThrow()
  })
})

describe("notebook private validators", () => {
  test("reply, reject, and list accept strict envelopes", () => {
    const opId = canonicalNotebookOpId(RID, "tok")
    expect(() => validateNotebookReplyRequest(replyReq(opId))).not.toThrow()
    expect(() => validateNotebookRejectRequest(rejectReq(opId))).not.toThrow()
    expect(() => validateNotebookListRequest(listReq(canonicalNotebookListOpId("tok")))).not.toThrow()
  })

  test("validators reject binding mismatch, op crossover, and payload shapes", () => {
    const opId = canonicalNotebookOpId(RID, "tok")
    // idempotencyKey must equal opId
    expect(() => validateNotebookReplyRequest({ ...replyReq(opId), idempotencyKey: "other" })).toThrow()
    // opId requestID vs context.requestID drift is a settlement scope_mismatch,
    // not an envelope rejection: the envelope still parses here.
    const crossed = canonicalNotebookOpId("nbr_other00000001", "tok")
    expect(() =>
      validateNotebookReplyRequest({ ...replyReq(crossed), context: { directory: DIR, requestID: RID } }),
    ).not.toThrow()
    // op crossover
    expect(() => validateNotebookReplyRequest({ ...replyReq(opId), op: OP_REJECT })).toThrow()
    expect(() => validateNotebookRejectRequest({ ...rejectReq(opId), op: OP_REPLY })).toThrow()
    expect(() => validateNotebookListRequest({ ...listReq(canonicalNotebookListOpId("t")), op: OP_REPLY })).toThrow()
    // payload must carry only result / error / empty
    expect(() =>
      validateNotebookReplyRequest({ ...replyReq(opId), payload: { error: { code: "timeout", message: "m" } } }),
    ).toThrow()
    expect(() =>
      validateNotebookRejectRequest({ ...rejectReq(opId), payload: { result: { operation: "read" } } }),
    ).toThrow()
    expect(() =>
      validateNotebookListRequest({ ...listReq(canonicalNotebookListOpId("t")), payload: { filter: 1 } }),
    ).toThrow()
    // result/error must match the notebook protocol shape
    expect(() =>
      validateNotebookReplyRequest({ ...replyReq(opId), payload: { result: { operation: "nope" } } }),
    ).toThrow()
    expect(() =>
      validateNotebookRejectRequest({ ...rejectReq(opId), payload: { error: { code: "timeout" } } }),
    ).toThrow()
    // non-notebook request IDs and relative directories fail closed
    expect(() =>
      validateNotebookReplyRequest({ ...replyReq(opId), context: { directory: DIR, requestID: "que_1" } }),
    ).toThrow()
    expect(() =>
      validateNotebookListRequest({ ...listReq(canonicalNotebookListOpId("t")), context: { directory: "rel" } }),
    ).toThrow()
  })
})

describe("notebook private settlement", () => {
  test("reply success returns minimal terminal binding without echoing the result", async () => {
    const opId = canonicalNotebookOpId(RID, "tok-ok")
    const entry = { id: RID, sessionID: "ses_root1", path: "b.ipynb", operation: "read" }
    let called = 0
    const svc = stub({
      list: () => Effect.succeed([entry] as never),
      reply: () => Effect.succeed(undefined).pipe(Effect.tap(() => Effect.sync(() => called++))) as never,
    })
    const out = await run(
      replyNotebookPrivate(replyReq(opId)).pipe(
        Effect.provideService((await import("../../../src/kilocode/notebook/service")).Notebook.Service, svc),
      ) as never,
    )
    expect(called).toBe(1)
    const rec = out as Record<string, unknown>
    expect(rec.kind).toBe("terminal")
    expect(Object.keys(rec).sort()).toEqual(
      ["accepted", "idempotencyKey", "opId", "requestID", "requestId", "sessionID", "terminal", "v", "kind"].sort(),
    )
    expect(rec.requestID).toBe(RID)
    expect(rec.sessionID).toBe("ses_root1")
    expect(JSON.stringify(rec)).not.toContain("cells")
  })

  test("reply mismatch settles notebook.invalid_reply with pending intact", async () => {
    const opId = canonicalNotebookOpId(RID, "tok-bad")
    const entry = { id: RID, sessionID: "ses_root1", path: "b.ipynb", operation: "read" }
    const svc = stub({
      list: () => Effect.succeed([entry] as never),
      reply: () => Effect.fail(new InvalidReplyError({ requestID: RID as never })) as never,
    })
    const { Notebook } = await import("../../../src/kilocode/notebook/service")
    const out = (await run(
      replyNotebookPrivate(replyReq(opId)).pipe(Effect.provideService(Notebook.Service, svc)) as never,
    )) as { kind: string; failure: { code: string; retryable: boolean } }
    expect(out.kind).toBe("terminal-failure")
    expect(out.failure.code).toBe("notebook.invalid_reply")
    expect(out.failure.retryable).toBe(false)
  })

  test("reply and reject for unknown pending settle notebook.not_found", async () => {
    const { Notebook } = await import("../../../src/kilocode/notebook/service")
    const gone = stub({ list: () => Effect.succeed([]) })
    const opId = canonicalNotebookOpId(RID, "tok-gone")
    const replyOut = (await run(
      replyNotebookPrivate(replyReq(opId)).pipe(Effect.provideService(Notebook.Service, gone)) as never,
    )) as { failure: { code: string } }
    expect(replyOut.failure.code).toBe("notebook.not_found")
    const rejectOut = (await run(
      rejectNotebookPrivate(rejectReq(canonicalNotebookOpId(RID, "tok-gone2"))).pipe(
        Effect.provideService(Notebook.Service, gone),
      ) as never,
    )) as { failure: { code: string } }
    expect(rejectOut.failure.code).toBe("notebook.not_found")
  })

  test("reply race between list and settle maps NotFound to not_found", async () => {
    const { Notebook } = await import("../../../src/kilocode/notebook/service")
    const entry = { id: RID, sessionID: "ses_root1", path: "b.ipynb", operation: "read" }
    const svc = stub({
      list: () => Effect.succeed([entry] as never),
      reply: () => Effect.fail(new NotFoundError({ requestID: RID as never })) as never,
    })
    const out = (await run(
      replyNotebookPrivate(replyReq(canonicalNotebookOpId(RID, "tok-race"))).pipe(
        Effect.provideService(Notebook.Service, svc),
      ) as never,
    )) as { failure: { code: string } }
    expect(out.failure.code).toBe("notebook.not_found")
  })

  test("opId binding drift and op crossover settle scope_mismatch without touching the service", async () => {
    const { Notebook } = await import("../../../src/kilocode/notebook/service")
    let calls = 0
    const svc = stub({
      list: () => Effect.succeed([]).pipe(Effect.tap(() => Effect.sync(() => calls++))) as never,
    })
    const drift = canonicalNotebookOpId("nbr_other00000001", "tok")
    const driftOut = (await run(
      replyNotebookPrivate({
        ...replyReq(drift),
        context: { directory: DIR, requestID: RID },
      }).pipe(Effect.provideService(Notebook.Service, svc)) as never,
    )) as { failure: { code: string } }
    expect(driftOut.failure.code).toBe("scope_mismatch")
    const crossOut = (await run(
      replyNotebookPrivate({ ...rejectReq(canonicalNotebookOpId(RID, "tok-x")), op: "notebook/reject" } as never).pipe(
        Effect.provideService(Notebook.Service, svc),
      ) as never,
    )) as { failure: { code: string } }
    expect(crossOut.failure.code).toBe("scope_mismatch")
    expect(calls).toBe(0)
  })
})
