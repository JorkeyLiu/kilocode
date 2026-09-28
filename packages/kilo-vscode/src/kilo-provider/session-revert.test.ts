import { describe, expect, test } from "bun:test"
import { revertSessionPrivateFirst, unrevertSessionPrivateFirst } from "./session-revert"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"
const SESS = { id: SID, directory: DIR, title: "t" }

function okRevert(session: unknown = SESS) {
  return (req: unknown) => {
    const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
    return {
      id: 1,
      promise: Promise.resolve({ v: 1, requestId: r.requestId, opId: r.opId, op: r.op, idempotencyKey: r.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session } }),
    }
  }
}

function failedRevert(code: string, message: string, retryable: boolean) {
  return (req: unknown) => {
    const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
    const failure = { code, message, retryable }
    return {
      id: 2,
      promise: Promise.resolve({ v: 1, requestId: r.requestId, opId: r.opId, op: r.op, idempotencyKey: r.idempotencyKey, status: "failed", outcome: { type: "failed", time: Date.now(), failure }, accepted: false, failure }),
    }
  }
}

function connWith(handler: (req: unknown) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }) {
  return { isPrivateAvailable: () => true, privateRevertWithHandle: handler, privateUnrevertWithHandle: handler } as never
}

function ambiguousRevert(req: unknown) {
  const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
  return { id: 3, promise: Promise.resolve({ v: 1, requestId: r.requestId, opId: r.opId, op: r.op, idempotencyKey: r.idempotencyKey, status: "ambiguous", outcome: { type: "ambiguous", time: Date.now() }, accepted: false }) }
}

function transportUnknownRevert(req: unknown) {
  const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
  return {
    id: 4,
    promise: Promise.resolve({ v: 1, requestId: r.requestId, opId: r.opId, op: r.op, idempotencyKey: r.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: SESS }, transportUnknown: true }),
  }
}

function invalidRevert(req: unknown) {
  const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
  return {
    id: 5,
    promise: Promise.resolve({ v: 1, requestId: r.requestId, opId: r.opId, op: r.op, idempotencyKey: r.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: { id: "bad" } } }),
  }
}

function hangingRevert() {
  return { id: 6, promise: new Promise(() => {}), cancel: () => true }
}

function timeoutRejectRevert() {
  return { id: 7, promise: Promise.reject(new Error("private parity timeout after 3000ms")), cancel: () => true }
}

function foundSucceeded(opId: string) {
  return { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "revert.succeeded", message: "revert succeeded", time: 1 } }
}

function foundFailed(opId: string) {
  return { v: "1.0", status: "found", operation: { opId, outcome: "failed", code: "E_RUNTIME", message: "runtime boom", time: 1 } }
}

function getFound() {
  return { v: "1.0", status: "found", session: { id: SID, title: "t", parentID: null, directory: DIR, projectID: "p", createdAt: 1, updatedAt: 2 } }
}

function readerWith(op: (input: { opId: string }) => unknown, get: () => unknown, ops = { n: 0 }, gets = { n: 0 }) {
  return {
    ops,
    gets,
    reader: {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async () => { gets.n += 1; return get() },
      operation: async (input: { opId: string }) => { ops.n += 1; return op(input) },
    } as never,
  }
}

describe("session-revert private-first", () => {
  test("private success uses zero SDK", async () => {
    let sdk = 0
    const client = { session: { revert: async () => { sdk += 1; return { data: SESS } } } } as never
    const out = await revertSessionPrivateFirst({ client, connection: connWith(okRevert()), sessionId: SID, directory: DIR, messageId: MID })
    expect(out.kind).toBe("session")
    if (out.kind === "session") expect((out.session as { id: string }).id).toBe(SID)
    expect(sdk).toBe(0)
  })

  test("validated terminal closes with zero SDK", async () => {
    let sdk = 0
    const client = { session: { revert: async () => { sdk += 1; return { data: SESS } } } } as never
    let thrown: unknown
    try {
      await revertSessionPrivateFirst({ client, connection: connWith(failedRevert("session.not_found", "missing", false)), sessionId: SID, directory: DIR, messageId: MID })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    expect(sdk).toBe(0)
  })

  test("retryable performs exactly one SDK fallback", async () => {
    let sdk = 0
    const client = { session: { revert: async () => { sdk += 1; return { data: SESS } } } } as never
    const out = await revertSessionPrivateFirst({ client, connection: connWith(failedRevert("InstanceUnavailableDuringConfigRebuild", "busy", true)), sessionId: SID, directory: DIR, messageId: MID })
    expect(out.kind).toBe("session")
    expect(sdk).toBe(1)
  })

  test("unavailable performs exactly one SDK fallback", async () => {
    let sdk = 0
    const client = { session: { unrevert: async () => { sdk += 1; return { data: SESS } } } } as never
    const connection = { isPrivateAvailable: () => false } as never
    const out = await unrevertSessionPrivateFirst({ client, connection, sessionId: SID, directory: DIR })
    expect(out.kind).toBe("session")
    expect(sdk).toBe(1)
  })

  test("unrevert terminal closes with zero SDK", async () => {
    let sdk = 0
    const client = { session: { unrevert: async () => { sdk += 1; return { data: SESS } } } } as never
    let thrown: unknown
    try {
      await unrevertSessionPrivateFirst({ client, connection: connWith(failedRevert("scope_mismatch", "bad dir", false)), sessionId: SID, directory: DIR })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    expect(sdk).toBe(0)
  })

  test("ambiguous re-observes succeeded and returns detail with zero SDK", async () => {
    let sdk = 0
    const client = { session: { revert: async () => { sdk += 1; return { data: SESS } } } } as never
    const { reader, ops, gets } = readerWith((input) => foundSucceeded(input.opId), getFound)
    const out = await revertSessionPrivateFirst({ client, connection: connWith(ambiguousRevert), sessionId: SID, directory: DIR, messageId: MID, privateReader: reader })
    expect(out.kind).toBe("detail")
    if (out.kind === "detail") expect(out.detail.id).toBe(SID)
    expect(sdk).toBe(0)
    expect(ops.n).toBe(1)
    expect(gets.n).toBe(1)
  })

  test("transportUnknown re-observes succeeded with unavailable get returns refreshNeeded zero SDK", async () => {
    let sdk = 0
    const client = { session: { revert: async () => { sdk += 1; return { data: SESS } } } } as never
    const { reader, ops, gets } = readerWith((input) => foundSucceeded(input.opId), () => { throw new Error("Peer closed") })
    const out = await revertSessionPrivateFirst({ client, connection: connWith(transportUnknownRevert), sessionId: SID, directory: DIR, messageId: MID, privateReader: reader })
    expect(out.kind).toBe("refreshNeeded")
    expect(sdk).toBe(0)
    expect(ops.n).toBe(1)
    expect(gets.n).toBe(1)
  })

  test("invalid result re-observes absent and throws unresolved zero SDK", async () => {
    let sdk = 0
    const client = { session: { revert: async () => { sdk += 1; return { data: SESS } } } } as never
    const off = { isEnabled: () => true, isStarted: () => true, list: async () => ({}), get: async () => ({}), operation: async () => ({ v: "1.0", status: "not_found" }) } as never
    let thrown: unknown
    try {
      await revertSessionPrivateFirst({ client, connection: connWith(invalidRevert), sessionId: SID, directory: DIR, messageId: MID, privateReader: off })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("revert.unresolved")
    expect(String((thrown as Error).message)).toContain("No retry was issued")
    expect(sdk).toBe(0)
  })

  test("timeout re-observes unavailable and throws unresolved zero SDK", async () => {
    let sdk = 0
    const client = { session: { revert: async () => { sdk += 1; return { data: SESS } } } } as never
    let thrown: unknown
    try {
      await revertSessionPrivateFirst({ client, connection: connWith(hangingRevert), sessionId: SID, directory: DIR, messageId: MID, privateReader: null })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("revert.unresolved")
    expect(sdk).toBe(0)
  })

  test("unrevert ambiguous re-observes failed and propagates runtime code zero SDK", async () => {
    let sdk = 0
    const client = { session: { unrevert: async () => { sdk += 1; return { data: SESS } } } } as never
    const { reader } = readerWith((input) => foundFailed(input.opId), getFound)
    let thrown: unknown
    try {
      await unrevertSessionPrivateFirst({ client, connection: connWith(ambiguousRevert), sessionId: SID, directory: DIR, privateReader: reader })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("E_RUNTIME")
    expect(sdk).toBe(0)
  })

  test("unrevert invalid re-observes absent throws unresolved zero SDK", async () => {
    let sdk = 0
    const client = { session: { unrevert: async () => { sdk += 1; return { data: SESS } } } } as never
    const off = { isEnabled: () => true, isStarted: () => true, list: async () => ({}), get: async () => ({}), operation: async () => ({ v: "1.0", status: "not_found" }) } as never
    let thrown: unknown
    try {
      await unrevertSessionPrivateFirst({ client, connection: connWith(invalidRevert), sessionId: SID, directory: DIR, privateReader: off })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("unrevert.unresolved")
    expect(sdk).toBe(0)
  })

  test("unrevert timeout error re-observes unavailable throws unresolved zero SDK", async () => {
    let sdk = 0
    const client = { session: { unrevert: async () => { sdk += 1; return { data: SESS } } } } as never
    let thrown: unknown
    try {
      await unrevertSessionPrivateFirst({ client, connection: connWith(timeoutRejectRevert), sessionId: SID, directory: DIR, privateReader: null })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("unrevert.unresolved")
    expect(sdk).toBe(0)
  })
})
