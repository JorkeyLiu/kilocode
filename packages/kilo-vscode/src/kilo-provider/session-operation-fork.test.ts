import { describe, expect, test } from "bun:test"
import { forkSessionPrivateFirst } from "./fork-session"
import { tryPrivateOperationExact } from "./session-operation-private"

const DIR = "/tmp/ws"
const SRC = "ses_fork_src"

function readerFor(raw: unknown, getRaw?: unknown) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({}),
    get: async () => getRaw,
    operation: async () => raw,
  }
}

function forkOpId(token = "tok1"): string {
  return `fork:${SRC}:${token}`
}

describe("fork exact operation binding", () => {
  test("exact fork op is authoritative, cross-parent fails closed, diagnostic leak fails closed", async () => {
    const opId = forkOpId()
    const found = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "fork.succeeded", message: "fork succeeded", time: 1 } }
    expect(await tryPrivateOperationExact(readerFor(found) as never, { directory: DIR, sessionId: SRC, opId })).toMatchObject({ kind: "found" })
    const crossOp = "fork:ses_other:tok1"
    const cross = { v: "1.0", status: "found", operation: { opId: crossOp, outcome: "succeeded", code: "c", message: "m", time: 1 } }
    expect(await tryPrivateOperationExact(readerFor(cross) as never, { directory: DIR, sessionId: SRC, opId: crossOp })).toMatchObject({ kind: "unavailable" })
    const leaked = { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "c", message: "m", time: 1, detail: "secret token=xyz" } }
    expect(await tryPrivateOperationExact(readerFor(leaked) as never, { directory: DIR, sessionId: SRC, opId })).toMatchObject({ kind: "unavailable" })
  })
})

describe("forkSessionPrivateFirst bounded semantics", () => {
  test("direct private succeeded returns session with zero SDK", async () => {
    let sdkCalls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (req: Record<string, unknown>) => {
        const child = { id: "ses_fork_child1", parentID: SRC, directory: DIR, title: "t" }
        return { id: 1, promise: Promise.resolve({ v: 1, requestId: req.requestId, opId: req.opId, op: "session/fork", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { session: child } }) }
      },
    }
    const client = { session: { fork: async () => { sdkCalls += 1; return { data: { id: "ses_wrong" } } } } }
    const out = await forkSessionPrivateFirst({ client: client as never, connection: connection as never, sessionId: SRC, directory: DIR, privateReader: null })
    expect(out.kind).toBe("session")
    if (out.kind !== "session") throw new Error("expected session")
    expect(out.session.id).toBe("ses_fork_child1")
    expect(sdkCalls).toBe(0)
  })

  test("uncertain private re-observes once and returns pending child with zero SDK", async () => {
    let sdkCalls = 0
    let operationCalls = 0
    let getCalls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: () => ({ id: 7, promise: Promise.reject(new Error("peer closed")) }),
    }
    const client = { session: { fork: async () => { sdkCalls += 1; return { data: { id: "ses_sdk" } } } } }
    const reader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async (input: { directory: string; sessionId: string }) => {
        getCalls += 1
        return { v: "1.0", status: "found", session: { id: input.sessionId, title: "t", parentID: SRC, directory: DIR, projectID: "p", createdAt: 1, updatedAt: 2 } }
      },
      operation: async (input: { directory: string; sessionId: string; opId: string }) => {
        operationCalls += 1
        expect(input.sessionId).toBe(SRC)
        expect(input.directory).toBe(DIR)
        return { v: "1.0", status: "found", operation: { opId: input.opId, outcome: "succeeded", code: "fork.succeeded", message: "fork succeeded", time: 1, forkedSessionId: "ses_fork_child9" } }
      },
    }
    const out = await forkSessionPrivateFirst({ client: client as never, connection: connection as never, sessionId: SRC, directory: DIR, privateReader: reader as never })
    expect(out.kind).toBe("pending")
    if (out.kind !== "pending") throw new Error("expected pending")
    expect(out.childId).toBe("ses_fork_child9")
    expect(operationCalls).toBe(1)
    expect(getCalls).toBe(1)
    expect(sdkCalls).toBe(0)
  })

  test("uncertain with no child reference returns pending without child and zero SDK", async () => {
    let sdkCalls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: () => ({ id: 8, promise: Promise.reject(new Error("transport closed")) }),
    }
    const client = { session: { fork: async () => { sdkCalls += 1; return { data: { id: "ses_sdk" } } } } }
    const reader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async () => ({ v: "1.0", status: "not_found" }),
      operation: async (input: { directory: string; sessionId: string; opId: string }) => ({ v: "1.0", status: "found", operation: { opId: input.opId, outcome: "succeeded", code: "fork.succeeded", message: "fork succeeded", time: 1 } }),
    }
    const out = await forkSessionPrivateFirst({ client: client as never, connection: connection as never, sessionId: SRC, directory: DIR, privateReader: reader as never })
    expect(out.kind).toBe("pending")
    if (out.kind !== "pending") throw new Error("expected pending")
    expect(out.childId).toBeUndefined()
    expect(sdkCalls).toBe(0)
  })

  test("uncertain with unavailable observation throws unresolved with zero SDK and no second fork", async () => {
    let sdkCalls = 0
    let operationCalls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: () => ({ id: 9, promise: Promise.reject(new Error("peer closed")) }),
    }
    const client = { session: { fork: async () => { sdkCalls += 1; return { data: { id: "ses_sdk" } } } } }
    const reader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async () => ({ v: "1.0", status: "not_found" }),
      operation: async () => {
        operationCalls += 1
        return { v: "1.0", status: "not_found" }
      },
    }
    let code = ""
    try {
      await forkSessionPrivateFirst({ client: client as never, connection: connection as never, sessionId: SRC, directory: DIR, privateReader: reader as never })
    } catch (e) {
      code = (e as { code?: string }).code ?? ""
    }
    expect(code).toBe("fork.unresolved")
    expect(operationCalls).toBe(1)
    expect(sdkCalls).toBe(0)
  })

  test("validated pre-accept retryable takes exactly one SDK, nonretryable terminal takes zero SDK", async () => {
    const failedFor = (retryable: boolean, accepted: boolean) => (req: Record<string, unknown>) => ({
      id: 3,
      promise: Promise.resolve({
        v: 1, requestId: req.requestId, opId: req.opId, op: "session/fork", idempotencyKey: req.idempotencyKey,
        status: "failed", outcome: { type: "failed", time: 1, failure: { code: "fork.busy", message: "busy", retryable } },
        accepted, failure: { code: "fork.busy", message: "busy", retryable },
      }),
    })
    let sdkCalls = 0
    const client = { session: { fork: async () => { sdkCalls += 1; return { data: { id: "ses_sdk_child", parentID: SRC, directory: DIR } } } } }
    const retryableConn = { isPrivateAvailable: () => true, privateForkWithHandle: failedFor(true, false) }
    const retryOut = await forkSessionPrivateFirst({ client: client as never, connection: retryableConn as never, sessionId: SRC, directory: DIR, privateReader: null })
    expect(retryOut.kind).toBe("session")
    expect(sdkCalls).toBe(1)
    sdkCalls = 0
    const terminalConn = { isPrivateAvailable: () => true, privateForkWithHandle: failedFor(false, false) }
    let code = ""
    try {
      await forkSessionPrivateFirst({ client: client as never, connection: terminalConn as never, sessionId: SRC, directory: DIR, privateReader: null })
    } catch (e) {
      code = (e as { code?: string }).code ?? ""
    }
    expect(code).toBe("fork.busy")
    expect(sdkCalls).toBe(0)
  })
})
