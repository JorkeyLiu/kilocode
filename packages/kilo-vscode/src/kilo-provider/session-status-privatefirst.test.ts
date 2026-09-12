import { describe, expect, it, mock } from "bun:test"
import {
  attemptSessionStatusPrivate,
  buildSessionStatusReq,
  coerceSdkStatuses,
  fetchSessionStatusesPrivateFirst,
  parseSessionStatusResult,
} from "./session-status-privatefirst"
import type { ServePrivateStatusRequest } from "../services/cli-backend/serve-private-peer"

function req(dir = "/repo"): ServePrivateStatusRequest {
  return buildSessionStatusReq(dir)
}

function okStatuses(statuses: Record<string, unknown>, r: ServePrivateStatusRequest) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/status",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { statuses },
  }
}

function failedRes(r: ServePrivateStatusRequest, code = "internal", message = "x", retryable = false) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/status",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

function ambiguousRes(r: ServePrivateStatusRequest) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/status",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  }
}

function outcomeConn(result: unknown) {
  return {
    isPrivateAvailable: () => true,
    privateStatusOutcomeWithHandle: (r: ServePrivateStatusRequest) => ({
      id: 1,
      promise: Promise.resolve(
        typeof result === "function"
          ? { kind: "valid", result: (result as (q: ServePrivateStatusRequest) => unknown)(r) }
          : { kind: "valid", result },
      ),
      cancel: () => true,
    }),
  }
}

function okConn(statuses: Record<string, unknown>) {
  return {
    isPrivateAvailable: () => true,
    privateStatusOutcomeWithHandle: (r: ServePrivateStatusRequest) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: okStatuses(statuses, r) }),
      cancel: () => true,
    }),
  }
}

function failedConn(code: string, message = "m", retryable = false) {
  return {
    isPrivateAvailable: () => true,
    privateStatusOutcomeWithHandle: (r: ServePrivateStatusRequest) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: failedRes(r, code, message, retryable) }),
      cancel: () => true,
    }),
  }
}

describe("session-status private-first helper", () => {
  it("parses all four states as ok", () => {
    const r = req()
    const statuses = {
      s_idle: { type: "idle" },
      s_busy: { type: "busy" },
      s_retry: { type: "retry", attempt: 1, message: "m", next: 5 },
      s_off: { type: "offline", requestID: "que_1", message: "m" },
    }
    const out = parseSessionStatusResult(okStatuses(statuses, r), r)
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(Object.keys(out.statuses)).toEqual(["s_idle", "s_busy", "s_retry", "s_off"])
  })

  it("strict parse rejects invalid entries as fallback", () => {
    const r = req()
    expect(parseSessionStatusResult(okStatuses({ s: { type: "flying" } }, r), r).kind).toBe("fallback")
    expect(parseSessionStatusResult(okStatuses({ s: { type: "retry", attempt: 1, message: "m" } }, r), r).kind).toBe("fallback")
    expect(parseSessionStatusResult(okStatuses({ s: { type: "offline", requestID: "ses_x", message: "m" } }, r), r).kind).toBe("fallback")
    expect(parseSessionStatusResult(okStatuses({ s: { type: "idle", attempt: 1 } }, r), r).kind).toBe("fallback")
    expect(parseSessionStatusResult({ ...okStatuses({}, r), transportUnknown: true }, r).kind).toBe("fallback")
    expect(parseSessionStatusResult(null, r).kind).toBe("fallback")
  })

  it("terminal closes with zero SDK", async () => {
    const sdk = mock(async () => ({ data: {} }))
    const client = { session: { status: sdk } } as never
    for (const code of ["internal", "validation.failed", "scope_mismatch"]) {
      sdk.mockClear()
      const out = await fetchSessionStatusesPrivateFirst({
        connection: failedConn(code, "m", false) as never,
        client,
        directory: "/repo",
      })
      expect(out.kind).toBe("terminal")
      expect(sdk).toHaveBeenCalledTimes(0)
    }
  })

  it.each([
    ["retryable", (r: ServePrivateStatusRequest) => failedRes(r, "InstanceUnavailableDuringConfigRebuild", "fence", true)],
    ["ambiguous", (r: ServePrivateStatusRequest) => ambiguousRes(r)],
    ["invalid", (r: ServePrivateStatusRequest) => ({ ...okStatuses({}, r), extra: 1 })],
    ["transportUnknown", (r: ServePrivateStatusRequest) => ({ ...okStatuses({}, r), transportUnknown: true })],
  ])("fallback class %s issues exactly one same-dir SDK read", async (_, maker) => {
    const sdk = mock(async (params: { directory: string }) => {
      expect(params.directory).toBe("/repo")
      return { data: { ses_a: { type: "busy" } } }
    })
    const client = { session: { status: sdk } } as never
    const out = await fetchSessionStatusesPrivateFirst({
      connection: outcomeConn(maker as (r: ServePrivateStatusRequest) => unknown) as never,
      client,
      directory: "/repo",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("sdk")
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it("unavailable and closed fall back once", async () => {
    const sdk = mock(async () => ({ data: { ses_a: { type: "busy" } } }))
    const client = { session: { status: sdk } } as never
    const unavailable = await fetchSessionStatusesPrivateFirst({ connection: { isPrivateAvailable: () => false } as never, client, directory: "/repo" })
    expect(unavailable.kind).toBe("ok")
    expect(sdk).toHaveBeenCalledTimes(1)
    sdk.mockClear()
    const closed = {
      isPrivateAvailable: () => true,
      privateStatusOutcomeWithHandle: () => {
        throw new Error("Peer closed")
      },
    } as never
    const out = await fetchSessionStatusesPrivateFirst({ connection: closed, client, directory: "/repo" })
    expect(out.kind).toBe("ok")
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it("timeout exact-cancels and falls back once", async () => {
    let cancelled = false
    const conn = {
      isPrivateAvailable: () => true,
      privateStatusOutcomeWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled = true
          return true
        },
      }),
    } as never
    const sdk = mock(async () => ({ data: { ses_a: { type: "busy" } } }))
    const out = await fetchSessionStatusesPrivateFirst({
      connection: conn,
      client: { session: { status: sdk } } as never,
      directory: "/repo",
      timeoutMs: 30,
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("sdk")
    expect(cancelled).toBeTrue()
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it("legacy handle path also works with zero-SDK success", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateStatusWithHandle: (r: ServePrivateStatusRequest) => ({ id: 2, promise: Promise.resolve(okStatuses({ ses_a: { type: "busy" } }, r)), cancel: () => true }),
    } as never
    const sdk = mock(async () => ({ data: {} }))
    const out = await fetchSessionStatusesPrivateFirst({ connection: conn, client: { session: { status: sdk } } as never, directory: "/repo" })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("private")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("SDK error and malformed return unavailable", async () => {
    const conn = { isPrivateAvailable: () => false } as never
    const errClient = { session: { status: mock(async () => { throw new Error("boom") }) } } as never
    expect((await fetchSessionStatusesPrivateFirst({ connection: conn, client: errClient, directory: "/repo" })).kind).toBe("unavailable")
    const nullClient = { session: { status: mock(async () => ({ data: null })) } } as never
    expect((await fetchSessionStatusesPrivateFirst({ connection: conn, client: nullClient, directory: "/repo" })).kind).toBe("unavailable")
    const badClient = { session: { status: mock(async () => ({ data: { ses_a: { type: "bogus" } } })) } } as never
    expect((await fetchSessionStatusesPrivateFirst({ connection: conn, client: badClient, directory: "/repo" })).kind).toBe("unavailable")
  })

  it("attempt helper maps invalid outcome kind to fallback", async () => {
    const r = req()
    const conn = {
      isPrivateAvailable: () => true,
      privateStatusOutcomeWithHandle: () => ({ id: 3, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }),
    } as never
    expect((await attemptSessionStatusPrivate(conn, r)).kind).toBe("fallback")
  })

  it("coerceSdkStatuses accepts four states and rejects malformed", () => {
    expect(coerceSdkStatuses({ s1: { type: "busy" }, s2: { type: "retry", attempt: 1, message: "m", next: 2 } })).not.toBeNull()
    expect(coerceSdkStatuses({ s: { type: "bogus" } })).toBeNull()
    expect(coerceSdkStatuses(null)).toBeNull()
    expect(coerceSdkStatuses({ s: { type: "retry", attempt: 1, message: "m" } })).toBeNull()
  })
})
