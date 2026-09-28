import { describe, expect, test } from "bun:test"
import { renameSessionPrivateFirst } from "./session-update"

const SID = "ses_abc12300000000000001"
const DIR = "/tmp/ws"
const TITLE = "New Title"

function canonSession(title = TITLE) {
  return {
    id: SID,
    slug: "slug-1",
    projectID: "proj-1",
    directory: DIR,
    title,
    version: "1",
    time: { created: 1, updated: 2 },
  }
}

function okUpdate(session: unknown = canonSession()) {
  return (req: unknown) => {
    const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
    return {
      id: 1,
      promise: Promise.resolve({
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: r.op,
        idempotencyKey: r.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: { session },
      }),
    }
  }
}

function failedUpdate(code: string, message: string, retryable: boolean) {
  return (req: unknown) => {
    const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
    const failure = { code, message, retryable }
    return {
      id: 2,
      promise: Promise.resolve({
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: r.op,
        idempotencyKey: r.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: Date.now(), failure },
        accepted: false,
        failure,
      }),
    }
  }
}

function connWith(handler: (req: unknown) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }) {
  return { isPrivateAvailable: () => true, privateSessionUpdateWithHandle: handler } as never
}

function ambiguousUpdate(req: unknown) {
  const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
  return {
    id: 3,
    promise: Promise.resolve({
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: Date.now() },
      accepted: false,
    }),
  }
}

function transportUnknownUpdate(req: unknown) {
  const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
  return {
    id: 4,
    promise: Promise.resolve({
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: Date.now() },
      accepted: true,
      data: { session: canonSession() },
      transportUnknown: true,
    }),
  }
}

function invalidUpdate(req: unknown) {
  const r = req as { requestId: string; opId: string; op: string; idempotencyKey: string }
  return {
    id: 5,
    promise: Promise.resolve({
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: Date.now() },
      accepted: true,
      data: { session: { id: "bad" } },
    }),
  }
}

function hangingUpdate() {
  return { id: 6, promise: new Promise(() => {}), cancel: () => true }
}

function foundSucceeded(opId: string) {
  return { v: "1.0", status: "found", operation: { opId, outcome: "succeeded", code: "sessionUpdate.succeeded", message: "ok", time: 1 } }
}

function foundFailed(opId: string) {
  return { v: "1.0", status: "found", operation: { opId, outcome: "failed", code: "E_RUNTIME", message: "boom", time: 1 } }
}

function getFound() {
  return {
    v: "1.0",
    status: "found",
    session: { id: SID, title: TITLE, parentID: null, directory: DIR, projectID: "p", createdAt: 1, updatedAt: 2 },
  }
}

function readerWith(op: (input: { opId: string }) => unknown, get: () => unknown, ops = { n: 0 }, gets = { n: 0 }) {
  return {
    ops,
    gets,
    reader: {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async () => {
        gets.n += 1
        return get()
      },
      operation: async (input: { opId: string }) => {
        ops.n += 1
        return op(input)
      },
    } as never,
  }
}

describe("session-update private-first accepted-only", () => {
  test("private success uses zero SDK", async () => {
    let sdk = 0
    const client = { session: { update: async () => ({ data: canonSession() }) } } as never
    const track = { n: 0 }
    const counting = (req: unknown) => {
      track.n += 1
      return okUpdate()(req)
    }
    const out = await renameSessionPrivateFirst({
      client,
      connection: connWith(counting),
      sessionID: SID,
      title: TITLE,
      directory: DIR,
    })
    expect(out.kind).toBe("session")
    expect(sdk).toBe(0)
    expect(track.n).toBe(1)
  })

  test("validated terminal closes with zero SDK", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    let thrown: unknown
    try {
      await renameSessionPrivateFirst({
        client,
        connection: connWith(failedUpdate("session.not_found", "missing", false)),
        sessionID: SID,
        title: TITLE,
        directory: DIR,
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    expect(sdk).toBe(0)
  })

  test("retryable performs exactly one SDK fallback", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    const out = await renameSessionPrivateFirst({
      client,
      connection: connWith(failedUpdate("InstanceUnavailableDuringConfigRebuild", "busy", true)),
      sessionID: SID,
      title: TITLE,
      directory: DIR,
    })
    expect(out.kind).toBe("session")
    expect(sdk).toBe(1)
  })

  test("unavailable performs exactly one SDK fallback", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    const connection = { isPrivateAvailable: () => false } as never
    const out = await renameSessionPrivateFirst({ client, connection, sessionID: SID, title: TITLE, directory: DIR })
    expect(out.kind).toBe("session")
    expect(sdk).toBe(1)
  })

  test("ambiguous re-observes succeeded and returns detail with zero SDK", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    const { reader, ops, gets } = readerWith((input) => foundSucceeded(input.opId), getFound)
    const out = await renameSessionPrivateFirst({
      client,
      connection: connWith(ambiguousUpdate),
      sessionID: SID,
      title: TITLE,
      directory: DIR,
      privateReader: reader,
    })
    expect(out.kind).toBe("detail")
    if (out.kind === "detail") expect(out.detail.id).toBe(SID)
    expect(sdk).toBe(0)
    expect(ops.n).toBe(1)
    expect(gets.n).toBe(1)
  })

  test("transportUnknown re-observes succeeded with unavailable get returns refreshNeeded zero SDK", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    const { reader, ops, gets } = readerWith(
      (input) => foundSucceeded(input.opId),
      () => {
        throw new Error("Peer closed")
      },
    )
    const out = await renameSessionPrivateFirst({
      client,
      connection: connWith(transportUnknownUpdate),
      sessionID: SID,
      title: TITLE,
      directory: DIR,
      privateReader: reader,
    })
    expect(out.kind).toBe("refreshNeeded")
    expect(sdk).toBe(0)
    expect(ops.n).toBe(1)
    expect(gets.n).toBe(1)
  })

  test("invalid result re-observes absent and throws unresolved zero SDK", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    const off = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}),
      get: async () => ({}),
      operation: async () => ({ v: "1.0", status: "not_found" }),
    } as never
    let thrown: unknown
    try {
      await renameSessionPrivateFirst({
        client,
        connection: connWith(invalidUpdate),
        sessionID: SID,
        title: TITLE,
        directory: DIR,
        privateReader: off,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("rename.unresolved")
    expect(String((thrown as Error).message)).toContain("No retry was issued")
    expect(sdk).toBe(0)
  })

  test("timeout re-observes unavailable and throws unresolved zero SDK", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    let thrown: unknown
    try {
      await renameSessionPrivateFirst({
        client,
        connection: connWith(hangingUpdate),
        sessionID: SID,
        title: TITLE,
        directory: DIR,
        privateReader: null,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("rename.unresolved")
    expect(sdk).toBe(0)
  })

  test("ambiguous re-observes failed and propagates runtime code zero SDK", async () => {
    let sdk = 0
    const client = {
      session: {
        update: async () => {
          sdk += 1
          return { data: canonSession() }
        },
      },
    } as never
    const { reader } = readerWith((input) => foundFailed(input.opId), getFound)
    let thrown: unknown
    try {
      await renameSessionPrivateFirst({
        client,
        connection: connWith(ambiguousUpdate),
        sessionID: SID,
        title: TITLE,
        directory: DIR,
        privateReader: reader,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe("E_RUNTIME")
    expect(sdk).toBe(0)
  })
})
