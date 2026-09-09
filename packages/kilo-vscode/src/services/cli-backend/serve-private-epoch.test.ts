import { describe, expect, test } from "bun:test"
import { wrapEpochHandle } from "./serve-private-epoch"
import { isSettledQuestionResult, makeQuestionAmbiguous } from "./serve-private-question-contract"
import { isSettledAbortResult, makeAbortAmbiguous } from "./serve-private-abort-contract"

const QRID = "que_epoch0000000000000001"

function questionReq(token = "tok-epoch") {
  const opId = `question:${QRID}:${token}`
  return {
    v: 1 as const,
    requestId: "req-epoch",
    opId,
    op: "question/reply" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp/work", requestID: QRID },
    payload: { answers: [["Yes"]] },
  }
}

function questionTerminal(req: ReturnType<typeof questionReq>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_root00000000000000001",
    requestID: QRID,
    answers: [["Yes"]],
  }
}

function questionFailure(req: ReturnType<typeof questionReq>) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "question.not_found", retryable: false, time: 1 },
    sideEffect: false,
  }
}

function abortReq() {
  const sid = "ses_abort00000000000000001"
  const opId = `abort:${sid}:tok-epoch`
  return { requestId: "req-abort", opId, idempotencyKey: opId }
}

function abortTerminal(req: ReturnType<typeof abortReq>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    affected: [],
  }
}

function abortFailure(req: ReturnType<typeof abortReq>) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "session.not_found", retryable: false, time: 1 },
    sideEffect: false,
  }
}

function gate<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakePeer() {
  const invalidated: string[] = []
  const cancelled: number[] = []
  const peer = {
    isAvailable: () => true,
    hasCapability: () => true,
    tryCancelPending: (id: number, _msg?: string) => {
      cancelled.push(id)
      return true
    },
    invalidateOnObserverTimeout: (reason: string) => {
      invalidated.push(reason)
    },
  }
  return { peer, invalidated, cancelled }
}

describe("epoch settled preservation", () => {
  test("question terminal survives post-response epoch drift", async () => {
    const req = questionReq()
    const terminal = questionTerminal(req)
    const { peer } = fakePeer()
    const conn = { peer: peer as never, live: true, epoch: 1, invalidate: (_r: string) => {} }
    const inner = gate<unknown>()
    const handle = wrapEpochHandle({
      conn,
      cap: "question/reply",
      req,
      call: () => ({ id: 11, promise: inner.promise, cancel: () => true }),
      vague: (r) => makeQuestionAmbiguous(r) as never,
      settled: (result, want) => isSettledQuestionResult(result, want),
    })
    conn.epoch = 2
    inner.resolve(terminal)
    const out = (await handle.promise) as unknown as Record<string, unknown>
    expect(out.kind).toBe("terminal")
    expect(out.requestId).toBe(req.requestId)
    expect(out.opId).toBe(req.opId)
  })

  test("question terminal-failure survives peer replacement", async () => {
    const req = questionReq("tok-fail")
    const failure = questionFailure(req)
    const { peer } = fakePeer()
    const { peer: next } = fakePeer()
    const conn = { peer: peer as never, live: true, epoch: 1, invalidate: (_r: string) => {} }
    const inner = gate<unknown>()
    const handle = wrapEpochHandle({
      conn,
      cap: "question/reject",
      req,
      call: () => ({ id: 12, promise: inner.promise, cancel: () => true }),
      vague: (r) => makeQuestionAmbiguous(r) as never,
      settled: (result, want) => isSettledQuestionResult(result, want),
    })
    conn.peer = next as never
    inner.resolve(failure)
    const out = (await handle.promise) as unknown as Record<string, unknown>
    expect(out.kind).toBe("terminal-failure")
    expect((out.failure as Record<string, unknown>).code).toBe("question.not_found")
  })

  test("question unresolved drift still maps to vague", async () => {
    const req = questionReq("tok-vague")
    const { peer } = fakePeer()
    const conn = { peer: peer as never, live: true, epoch: 1, invalidate: (_r: string) => {} }
    const inner = gate<unknown>()
    const handle = wrapEpochHandle({
      conn,
      cap: "question/reply",
      req,
      call: () => ({ id: 13, promise: inner.promise, cancel: () => true }),
      vague: (r) => makeQuestionAmbiguous(r) as never,
      settled: (result, want) => isSettledQuestionResult(result, want),
    })
    conn.epoch = 2
    inner.resolve(makeQuestionAmbiguous(req))
    const out = (await handle.promise) as unknown as Record<string, unknown>
    expect(out.kind).toBe("ambiguous")
    expect(out.transportUnknown).toBeTrue()
  })

  test("question malformed with drift does not fail open", async () => {
    const req = questionReq("tok-bad")
    const { peer } = fakePeer()
    const conn = { peer: peer as never, live: true, epoch: 1, invalidate: (_r: string) => {} }
    const inner = gate<unknown>()
    const handle = wrapEpochHandle({
      conn,
      cap: "question/reply",
      req,
      call: () => ({ id: 14, promise: inner.promise, cancel: () => true }),
      vague: (r) => makeQuestionAmbiguous(r) as never,
      settled: (result, want) => isSettledQuestionResult(result, want),
    })
    conn.epoch = 2
    inner.resolve({ ...questionTerminal(req), requestId: "req-other" })
    const out = (await handle.promise) as unknown as Record<string, unknown>
    expect(out.kind).toBe("ambiguous")
  })

  test("abort terminal and failure survive post-response drift", async () => {
    const req = abortReq()
    const { peer } = fakePeer()
    const conn = { peer: peer as never, live: true, epoch: 1, invalidate: (_r: string) => {} }
    const first = gate<unknown>()
    const second = gate<unknown>()
    const terminalHandle = wrapEpochHandle({
      conn,
      cap: "session/abort",
      req,
      call: () => ({ id: 21, promise: first.promise, cancel: () => true }),
      vague: (r) => makeAbortAmbiguous(r) as never,
      settled: (result, want) => isSettledAbortResult(result, want),
    })
    const failureHandle = wrapEpochHandle({
      conn,
      cap: "session/abort",
      req,
      call: () => ({ id: 22, promise: second.promise, cancel: () => true }),
      vague: (r) => makeAbortAmbiguous(r) as never,
      settled: (result, want) => isSettledAbortResult(result, want),
    })
    conn.epoch = 2
    first.resolve(abortTerminal(req))
    second.resolve(abortFailure(req))
    const terminalOut = (await terminalHandle.promise) as unknown as Record<string, unknown>
    const failureOut = (await failureHandle.promise) as unknown as Record<string, unknown>
    expect(terminalOut.kind).toBe("terminal")
    expect(failureOut.kind).toBe("terminal-failure")
  })

  test("abort unresolved drift still maps to vague", async () => {
    const req = abortReq()
    const { peer } = fakePeer()
    const conn = { peer: peer as never, live: true, epoch: 1, invalidate: (_r: string) => {} }
    const inner = gate<unknown>()
    const handle = wrapEpochHandle({
      conn,
      cap: "session/abort",
      req,
      call: () => ({ id: 23, promise: inner.promise, cancel: () => true }),
      vague: (r) => makeAbortAmbiguous(r) as never,
      settled: (result, want) => isSettledAbortResult(result, want),
    })
    conn.epoch = 5
    inner.resolve(makeAbortAmbiguous(req))
    const out = (await handle.promise) as unknown as Record<string, unknown>
    expect(out.kind).toBe("ambiguous")
  })

  test("exact cancel owns current pending, stale cleans only captured peer", async () => {
    const req = questionReq("tok-cancel")
    const { peer, invalidated, cancelled } = fakePeer()
    let invalidatedConn = 0
    const conn = {
      peer: peer as never,
      live: true,
      epoch: 1,
      invalidate: (_r: string) => {
        invalidatedConn += 1
      },
    }
    const inner = gate<unknown>()
    const handle = wrapEpochHandle({
      conn,
      cap: "question/reply",
      req,
      call: () => ({ id: 31, promise: inner.promise, cancel: () => true }),
      vague: (r) => makeQuestionAmbiguous(r) as never,
      settled: (result, want) => isSettledQuestionResult(result, want),
    })
    expect(handle.cancel()).toBeTrue()
    expect(cancelled).toEqual([31])
    expect(invalidatedConn).toBe(0)
    expect(invalidated.length).toBe(0)
    inner.resolve(makeQuestionAmbiguous(req))
    await handle.promise
  })

  test("stale cancel never invalidates replacement owner", async () => {
    const req = questionReq("tok-stale")
    const { peer, invalidated } = fakePeer()
    const { peer: next } = fakePeer()
    let invalidatedConn = 0
    const conn = {
      peer: peer as never,
      live: true,
      epoch: 1,
      invalidate: (_r: string) => {
        invalidatedConn += 1
      },
    }
    const inner = gate<unknown>()
    const handle = wrapEpochHandle({
      conn,
      cap: "question/reply",
      req,
      call: () => ({ id: 32, promise: inner.promise, cancel: () => true }),
      vague: (r) => makeQuestionAmbiguous(r) as never,
      settled: (result, want) => isSettledQuestionResult(result, want),
    })
    conn.peer = next as never
    conn.epoch = 2
    expect(handle.cancel()).toBeFalse()
    expect(invalidatedConn).toBe(0)
    expect(invalidated.length).toBe(1)
    inner.resolve(makeQuestionAmbiguous(req))
    await handle.promise
  })
})
