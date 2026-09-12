import { describe, expect, test } from "bun:test"
import { suggestionAcceptHandle, suggestionDismissHandle } from "./serve-private-suggestion-connection"
import { canonicalSuggestionOpId } from "./serve-private-suggestion-contract"

const DIR = "/tmp"
const RID = "sug_conn0000000000000001"

function acceptReq() {
  const opId = canonicalSuggestionOpId(RID, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "suggestion/accept" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: { index: 0 },
  }
}

function dismissReq() {
  const opId = canonicalSuggestionOpId(RID, "tok2")
  return {
    v: 1 as const,
    requestId: "r2",
    opId,
    op: "suggestion/dismiss" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: {},
  }
}

function terminalAccept(req: ReturnType<typeof acceptReq>) {
  return {
    kind: "terminal" as const,
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true as const,
    terminal: true as const,
    sessionID: "ses_conn0000000000000001",
    requestID: RID,
    index: 0,
    action: { label: "Run", prompt: "Run tests" },
  }
}

function notFound(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    kind: "terminal-failure" as const,
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false as const,
    terminal: true as const,
    failure: { code: "suggestion.not_found" as const, retryable: false as const, time: 1 },
    sideEffect: false as const,
  }
}

function vagueAccept(req: ReturnType<typeof acceptReq>) {
  return {
    kind: "ambiguous" as const,
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false as const,
    terminal: false as const,
    transportUnknown: true as const,
  }
}

function deps(peer: unknown, epoch: number | null = 7, live = true) {
  return { peer: peer as never, live, epoch, invalidate: () => {} }
}

describe("suggestion connection handles", () => {
  test("unavailable peer throws without transport", () => {
    expect(() => suggestionAcceptHandle(deps(null), acceptReq() as never)).toThrow("Private peer unavailable")
    expect(() => suggestionDismissHandle(deps(null), dismissReq() as never)).toThrow("Private peer unavailable")
  })

  test("missing capability throws fail-closed", () => {
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      privateSuggestionAcceptWithHandle: () => {
        throw new Error("must not be called")
      },
      privateSuggestionDismissWithHandle: () => {
        throw new Error("must not be called")
      },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() => suggestionAcceptHandle(deps(peer), acceptReq() as never)).toThrow(
      "Private peer missing suggestion/accept capability",
    )
    expect(() => suggestionDismissHandle(deps(peer), dismissReq() as never)).toThrow(
      "Private peer missing suggestion/dismiss capability",
    )
  })

  test("current epoch passes terminal through with exact id", async () => {
    const req = acceptReq()
    const terminal = terminalAccept(req)
    let seen = 0
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSuggestionAcceptWithHandle: (r: unknown) => {
        seen += 1
        expect(r).toBe(req)
        return { id: 11, promise: Promise.resolve(terminal), cancel: () => true }
      },
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const handle = suggestionAcceptHandle(deps(peer, 7), req as never)
    expect(handle.id).toBe(11)
    expect(await handle.promise).toEqual(terminal)
    expect(seen).toBe(1)
  })

  test("settled terminal survives post-response epoch drift", async () => {
    const req = dismissReq()
    const failure = notFound(req)
    let epoch = 7
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSuggestionDismissWithHandle: () => ({
        id: 5,
        promise: Promise.resolve(failure),
        cancel: () => true,
      }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const conn = { peer: peer as never, live: true, epoch, invalidate: () => {} }
    const handle = suggestionDismissHandle(conn as never, req as never)
    epoch = 8
    ;(conn as { epoch: number }).epoch = epoch
    expect(await handle.promise).toEqual(failure)
  })

  test("unresolved drift maps to vague ambiguous", async () => {
    const req = acceptReq()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateSuggestionAcceptWithHandle: () => ({
        id: 4,
        promise: Promise.resolve(vagueAccept(req)),
        cancel: () => true,
      }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    const conn = { peer: peer as never, live: true, epoch: 7 as number | null, invalidate: () => {} }
    const handle = suggestionAcceptHandle(conn as never, req as never)
    conn.epoch = 8
    const out = (await handle.promise) as unknown as { kind: string }
    expect(out.kind).toBe("ambiguous")
  })
})
