import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalSessionListOpId,
  compareSessionListParity,
  encodeSessionListCursor,
  normalizePrivateSessionListWire,
  validateSessionListContractRequest as validateSessionListRequest,
  validateSessionListResult,
} from "./serve-private-session-list-contract"
const OPAQUE = (updated = 7, id = "ses_abc"): string => encodeSessionListCursor(updated, id)
import {
  buildSessionListIdentity,
  observeSessionListParityDetached,
  sdkSessionListHasTerminal,
  type SessionListParityConnection,
} from "../../kilo-provider/session-list-parity"
import { requestSessionListOutcome, SESSION_LIST_TRANSPORT_FAILURE_MESSAGE } from "./serve-private-session-list"

function createLinkedChannel(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalSessionListOpId("tok1")
  return {
    v: 2 as const,
    requestId: "r1",
    opId,
    op: "experimental/session/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { filter: {} },
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, sessions: unknown[] = [], nextCursor?: string) {
  return {
    v: 2,
    requestId: req.requestId,
    opId: req.opId,
    op: "experimental/session/list",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: nextCursor !== undefined ? { sessions, nextCursor } : { sessions },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 2,
    requestId: req.requestId,
    opId: req.opId,
    op: "experimental/session/list",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

function sessionItem(id: string) {
  return { id, directory: "/tmp", title: "t", updated: 7 }
}

function sdkSuccess(items: unknown[], cursor: string | null) {
  return {
    data: items,
    error: undefined,
    response: { status: 200, headers: { get: (k: string) => (k === "x-next-cursor" ? cursor : null) } },
  }
}

describe("session-list private peer", () => {
  test("canonicalSessionListOpId binds a single colon-free token with idempotency equality", () => {
    expect(canonicalSessionListOpId("t1")).toBe("experimental-session-list:t1")
    expect(() => canonicalSessionListOpId("")).toThrow()
    expect(() => canonicalSessionListOpId("a:b")).toThrow()
    const ident = buildSessionListIdentity()
    expect(ident.opId.startsWith("experimental-session-list:")).toBeTrue()
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateSessionListRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateSessionListRequest(req)).not.toThrow()
    expect(() =>
      validateSessionListRequest(makeReq({ payload: { filter: { limit: 10, cursor: OPAQUE(3, "ses_xyz") } } })),
    ).not.toThrow()
    expect(() => validateSessionListRequest(makeReq({ context: { directory: "/tmp", workspace: "w" } }))).not.toThrow()
    expect(() => validateSessionListRequest({ ...req, v: 1 })).toThrow()
    expect(() => validateSessionListRequest({ ...req, opId: "experimental-session-list:a:b" })).toThrow()
    expect(() => validateSessionListRequest({ ...req, idempotencyKey: "experimental-session-list:other" })).toThrow()
    expect(() => validateSessionListRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateSessionListRequest(makeReq({ payload: {} }))).toThrow()
    expect(() => validateSessionListRequest(makeReq({ payload: { filter: { limit: 0 } } }))).toThrow()
    expect(() => validateSessionListRequest(makeReq({ payload: { filter: { cursor: "x" } } }))).toThrow()
    expect(() => validateSessionListRequest(makeReq({ payload: { filter: { cursor: 3 } } }))).toThrow()
    expect(() => validateSessionListRequest(makeReq({ payload: { filter: { limit: 2, bogus: 1 } } }))).toThrow()
    expect(() => validateSessionListRequest({ ...req, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateSessionListRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateSessionListRequest({ ...req, op: "session/get" })).toThrow()
  })

  test("validateSessionListResult enforces per-status shape with strict nextCursor", () => {
    const req = makeReq()
    expect(() => validateSessionListResult(makeSuccess(req, [sessionItem("ses_a")]), req)).not.toThrow()
    expect(() =>
      validateSessionListResult(makeSuccess(req, [sessionItem("ses_a")], OPAQUE(42, "ses_a")), req),
    ).not.toThrow()
    expect(() => validateSessionListResult(makeSuccess(req, [], OPAQUE(0, "ses_a")), req)).not.toThrow()
    expect(() => validateSessionListResult(makeSuccess(req, [], null as unknown as string), req)).toThrow()
    expect(() => validateSessionListResult(makeSuccess(req, [], 42 as unknown as string), req)).toThrow()
    expect(() => validateSessionListResult(makeSuccess(req, [], "42"), req)).toThrow()
    expect(() => validateSessionListResult(makeSuccess(req, [], "x"), req)).toThrow()
    expect(() => validateSessionListResult(makeSuccess(req, [], -1 as unknown as string), req)).toThrow()
    expect(() => validateSessionListResult({ ...makeSuccess(req, []), requestId: "r2" }, req)).toThrow()
    expect(() => validateSessionListResult({ ...makeSuccess(req, []), data: { sessions: {} } }, req)).toThrow()
    expect(() =>
      validateSessionListResult({ ...makeSuccess(req, []), data: { sessions: [], extra: 1 } }, req),
    ).toThrow()
    expect(() =>
      validateSessionListResult({ ...makeSuccess(req, [{ id: "x", directory: "/tmp", title: "t", updated: 1 }]) }, req),
    ).toThrow()
    const failed = makeFailed(req, "validation.failed")
    expect(() => validateSessionListResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 2,
      requestId: req.requestId,
      opId: req.opId,
      op: "experimental/session/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateSessionListResult(ambiguous, req)).not.toThrow()
  })

  test("compareSessionListParity matches projection plus cursor and stays order-free", () => {
    const req = makeReq()
    const priv = makeSuccess(req, [sessionItem("ses_abc")]) as unknown as Parameters<typeof compareSessionListParity>[0]
    expect(
      compareSessionListParity(priv, sdkSuccess([{ id: "ses_abc", directory: "/tmp", title: "t" }], null)).divergence,
    ).toBeNull()
    const cursorPriv = makeSuccess(req, [sessionItem("ses_abc")], OPAQUE(7, "ses_abc")) as unknown as Parameters<
      typeof compareSessionListParity
    >[0]
    expect(
      compareSessionListParity(
        cursorPriv,
        sdkSuccess([{ id: "ses_abc", directory: "/tmp", title: "t" }], OPAQUE(7, "ses_abc")),
      ).divergence,
    ).toBeNull()
    const presence = compareSessionListParity(
      cursorPriv,
      sdkSuccess([{ id: "ses_abc", directory: "/tmp", title: "t" }], null),
    )
    expect(presence.divergence).toBe("session-list-cursor-mismatch")
    expect(JSON.stringify(presence.details).includes(OPAQUE(7, "ses_abc"))).toBeFalse()
    const value = compareSessionListParity(
      cursorPriv,
      sdkSuccess([{ id: "ses_abc", directory: "/tmp", title: "t" }], OPAQUE(8, "ses_abc")),
    )
    expect(value.divergence).toBe("session-list-cursor-mismatch")
    // Order-insensitive, updated never compared.
    const priv2 = makeSuccess(req, [sessionItem("ses_a"), sessionItem("ses_b")]) as unknown as Parameters<
      typeof compareSessionListParity
    >[0]
    expect(
      compareSessionListParity(
        priv2,
        sdkSuccess(
          [
            { id: "ses_b", directory: "/tmp", title: "t" },
            { id: "ses_a", directory: "/tmp", title: "t" },
          ],
          null,
        ),
      ).divergence,
    ).toBeNull()
    const missing = compareSessionListParity(priv, sdkSuccess([], null))
    expect(missing.divergence?.startsWith("session-list-membership-unknown")).toBeTrue()
    const sdk404 = { error: { status: 404 }, response: { status: 404 } } as unknown as Parameters<
      typeof compareSessionListParity
    >[1]
    const privFailed = makeFailed(req, "internal") as unknown as Parameters<typeof compareSessionListParity>[0]
    expect(compareSessionListParity(privFailed, sdk404).divergence).toBeNull()
  })

  test("peer capability gating requires experimental/session/list", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["session/get"]
    const req = makeReq()
    expect(() => peer.privateSessionListOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing experimental/session/list capability",
    )
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer unavailable/disposed fails closed without mutation", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    const req = makeReq()
    expect(() => peer.privateSessionListOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privateSessionListOutcomeWithHandle(req as never)).toThrow()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and excludes invalid wire", async () => {
    const req = makeReq({ payload: { filter: { limit: 2 } } })
    const success = makeSuccess(req, [sessionItem("ses_a")], OPAQUE(9, "ses_a"))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("experimental/session/list")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["experimental/session/list"]
    const outcome = await peer.privateSessionListOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateSessionListResult(outcome.result as unknown, req as never)).not.toThrow()
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()

    const bad = { ...success, data: { sessions: [], nextCursor: 9 } }
    expect(normalizePrivateSessionListWire(bad, req as never).kind).toBe("invalid")
  })

  test("peer outcome handle excludes invalid wire before any comparator", async () => {
    const req = makeReq()
    const bad = { ...makeSuccess(req, []), data: { sessions: [], nextCursor: 9 } }
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["experimental/session/list"]
    const outcome = await peer.privateSessionListOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome for numeric nextCursor")
    expect(outcome.detail.length).toBeGreaterThan(0)
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer exact cancel owns the allocated id", async () => {
    const req = makeReq()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["experimental/session/list"]
    const handle = peer.privateSessionListOutcomeWithHandle(req as never)
    expect(typeof handle.id).toBe("number")
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel()).toBeTrue()
    release!({ kind: "valid", result: makeSuccess(req, []) })
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("sdkSessionListHasTerminal gates success arrays and terminal failures only", () => {
    expect(sdkSessionListHasTerminal({ data: [] } as never)).toBeTrue()
    expect(sdkSessionListHasTerminal(sdkSuccess([], null) as never)).toBeTrue()
    expect(sdkSessionListHasTerminal({ error: { status: 500 }, response: { status: 500 } } as never)).toBeTrue()
    expect(sdkSessionListHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkSessionListHasTerminal({ error: { code: "ECONNRESET" } } as never)).toBeFalse()
    expect(sdkSessionListHasTerminal({ data: undefined } as never)).toBeFalse()
    expect(sdkSessionListHasTerminal({} as never)).toBeFalse()
  })

  test("sdkSessionListHasTerminal recognizes generated InvalidRequestError without response status", () => {
    // Repository evidence: generated SDK `InvalidRequestError` (`_tag:
    // "InvalidRequestError" in packages/sdk/js/src/v2/gen/types.gen.ts`) maps
    // to HTTP 400 in the generated operation signatures and openapi.json, and
    // 400 is a member of the observer TERMINAL_HTTP set. Classification is
    // gating-only for the detached observer; it never asserts parity success.
    expect(
      sdkSessionListHasTerminal({ error: { _tag: "InvalidRequestError", message: "bad cursor" } } as never),
    ).toBeTrue()
    expect(
      sdkSessionListHasTerminal({
        error: { _tag: "InvalidRequestError", message: "bad" },
        response: { status: 400 },
      } as never),
    ).toBeTrue()
    const thrown = Object.assign(new Error("bad request"), { _tag: "InvalidRequestError" })
    expect(sdkSessionListHasTerminal(thrown as never)).toBeTrue()
    const wrapped = Object.assign(new Error("wrapper"), { error: { _tag: "InvalidRequestError", message: "bad" } })
    expect(sdkSessionListHasTerminal(wrapped as never)).toBeTrue()
    // Near-miss tags and transport errors stay non-terminal.
    expect(sdkSessionListHasTerminal({ error: { _tag: "SomethingElse", message: "bad cursor" } } as never)).toBeFalse()
    expect(
      sdkSessionListHasTerminal({ error: { _tag: "invalidrequesterror", message: "lowercase" } } as never),
    ).toBeFalse()
    expect(sdkSessionListHasTerminal({ error: { code: "ECONNRESET" } } as never)).toBeFalse()
  })

  test("session-list transport failures are redacted to a fixed safe message", async () => {
    const req = makeReq()
    const rawErr = new Error("secret transport boom /tmp/ses_abc cursor=42")
    ;(rawErr as unknown as Record<string, unknown>).code = -32603
    const raw = {
      requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }),
    }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "-32603", msg: "secret transport boom /tmp/ses_abc cursor=42" }),
    }
    const handle = requestSessionListOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid failure outcome")
    expect(outcome.result.status).toBe("failed")
    const failed = outcome.result as unknown as {
      failure: { code: string; message: string; retryable: boolean }
      outcome: { failure: { code: string; message: string; retryable: boolean } }
    }
    expect(failed.failure.code).toBe("-32603")
    expect(failed.failure.message).toBe(SESSION_LIST_TRANSPORT_FAILURE_MESSAGE)
    expect(failed.outcome.failure.message).toBe(SESSION_LIST_TRANSPORT_FAILURE_MESSAGE)
    const leaked = JSON.stringify(outcome.result)
    expect(leaked.includes("secret transport boom")).toBeFalse()
    expect(leaked.includes("ses_abc")).toBeFalse()
    expect(leaked.includes("cursor=42")).toBeFalse()
  })

  test("observer is detached, warn-only, and never mutates SDK state", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess([{ id: "ses_abc", directory: "/tmp", title: "t" }], null)
      const before = JSON.stringify(sdk)
      const conn: SessionListParityConnection = {
        isPrivateAvailable: () => true,
        privateSessionListOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 2,
              requestId: req.requestId,
              opId: req.opId,
              op: "experimental/session/list",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { sessions: [{ id: "ses_abc", directory: "/tmp", title: "t", updated: 7 }] },
            },
          }),
        }),
        getPrivateEpoch: () => 1,
      }
      const ret = observeSessionListParityDetached(conn, sdk as never, "/tmp", undefined, { limit: 10 })
      expect(ret).toBeUndefined()
      expect(JSON.stringify(sdk)).toBe(before)
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(warns.filter((w) => String(w[0]).includes("divergence"))).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer never launches private work for non-terminal SDK input", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const calls: string[] = []
      const conn: SessionListParityConnection = {
        isPrivateAvailable: () => true,
        privateSessionListOutcomeWithHandle: (req) => {
          calls.push(req.opId)
          return { id: 1, promise: Promise.resolve({ kind: "valid", result: {} }) }
        },
        getPrivateEpoch: () => 1,
      }
      observeSessionListParityDetached(conn, { error: { message: "boom" } } as never, "/tmp", undefined, { limit: 2 })
      await new Promise((r) => setTimeout(r, 30))
      expect(calls).toHaveLength(0)
      expect(warns).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer defers without work while the peer negotiates", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const calls: string[] = []
      let deferred: (() => void) | null = null
      const conn: SessionListParityConnection = {
        isPrivateAvailable: () => false,
        privateSessionListOutcomeWithHandle: (req) => {
          calls.push(req.opId)
          return { id: 1, promise: Promise.resolve({ kind: "valid", result: {} }) }
        },
        getPrivateEpoch: () => 3,
        addDeferredSessionListObserver: (_d, _w, _f, listener) => {
          deferred = listener
          return () => {
            deferred = null
          }
        },
      }
      observeSessionListParityDetached(conn, sdkSuccess([], null) as never, "/tmp", undefined, { limit: 2 })
      await new Promise((r) => setTimeout(r, 20))
      expect(calls).toHaveLength(0)
      expect(deferred).not.toBeNull()
    } finally {
      console.warn = origWarn
    }
  })
})
