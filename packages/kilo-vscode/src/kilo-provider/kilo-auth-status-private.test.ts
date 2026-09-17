import { describe, expect, it } from "bun:test"
import {
  attemptKiloAuthStatusPrivate,
  buildKiloAuthStatusReq,
  fetchKiloAuthStatusPrivate,
  parseKiloAuthStatusResult,
} from "./kilo-auth-status-private"
import type { KiloAuthStatusContractRequest } from "../services/cli-backend/serve-private-kilo-auth-status-contract"

function validData() {
  return { authenticated: true, type: "oauth" as const }
}

function okWire(req: KiloAuthStatusContractRequest, data: unknown = validData()) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      op: "kilo/auth-status",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data,
    },
  }
}

function failedWire(req: KiloAuthStatusContractRequest, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      op: "kilo/auth-status",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

function ambiguousWire(req: KiloAuthStatusContractRequest) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      op: "kilo/auth-status",
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

function connFor(build: (r: KiloAuthStatusContractRequest) => unknown) {
  return {
    isPrivateAvailable: () => true,
    privateKiloAuthStatusOutcomeWithHandle: (r: KiloAuthStatusContractRequest) => ({
      id: 1,
      promise: Promise.resolve(build(r)),
      cancel: () => true,
    }),
  }
}

describe("kilo-auth-status private authority", () => {
  it("validated success returns the exact shape with zero SDK", async () => {
    const out = await fetchKiloAuthStatusPrivate({
      connection: connFor((r) => okWire(r)) as never,
      directory: "/tmp",
    })
    expect(out).toEqual({ kind: "ok", data: validData() })
  })

  it("signed-out shape stays ok without type", async () => {
    const out = await fetchKiloAuthStatusPrivate({
      connection: connFor((r) => okWire(r, { authenticated: false })) as never,
      directory: "/tmp",
    })
    expect(out).toEqual({ kind: "ok", data: { authenticated: false } })
  })

  it("validated terminal (validation/internal) remains terminal with zero SDK", async () => {
    for (const [code, message] of [
      ["validation.failed", "invalid kilo-auth-status request"],
      ["internal", "internal error"],
    ] as const) {
      const attempt = await attemptKiloAuthStatusPrivate(
        connFor((r) => failedWire(r, code, message, false)) as never,
        buildKiloAuthStatusReq("/tmp"),
      )
      expect(attempt).toEqual({ kind: "terminal", code })
      const out = await fetchKiloAuthStatusPrivate({
        connection: connFor((r) => failedWire(r, code, message, false)) as never,
        directory: "/tmp",
      })
      expect(out).toEqual({ kind: "terminal", code })
    }
  })

  it("invalid wire never silently succeeds", () => {
    const req = buildKiloAuthStatusReq("/tmp")
    expect(parseKiloAuthStatusResult({ kind: "invalid", detail: "x" }, req)).toEqual({
      kind: "unavailable",
      reason: "invalid",
    })
    const bad = okWire(req, { authenticated: true, type: "oauth", token: "secret" })
    expect(parseKiloAuthStatusResult(bad.result, req)).toEqual({ kind: "unavailable", reason: "invalid" })
    expect(parseKiloAuthStatusResult(ambiguousWire(req).result, req)).toEqual({
      kind: "unavailable",
      reason: "transportUnknown",
    })
  })

  it("unavailable/missing-capability/invalid/ambiguous/transport/closed are explicit unavailable", async () => {
    const off = await attemptKiloAuthStatusPrivate(
      { isPrivateAvailable: () => false } as never,
      buildKiloAuthStatusReq("/tmp"),
    )
    expect(off).toEqual({ kind: "unavailable", reason: "unavailable" })

    const missing = await attemptKiloAuthStatusPrivate(
      { isPrivateAvailable: () => true, getPrivatePeer: () => null, getPrivateEpoch: () => 1 } as never,
      buildKiloAuthStatusReq("/tmp"),
    )
    expect(missing).toEqual({ kind: "unavailable", reason: "missing-capability" })

    const req = buildKiloAuthStatusReq("/tmp")
    const vague = await attemptKiloAuthStatusPrivate(connFor((r) => ambiguousWire(r)) as never, req)
    expect(vague).toEqual({ kind: "unavailable", reason: "transportUnknown" })

    const invalid = await attemptKiloAuthStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateKiloAuthStatusOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      } as never,
      buildKiloAuthStatusReq("/tmp"),
    )
    expect(invalid).toEqual({ kind: "unavailable", reason: "invalid" })

    const broken = await attemptKiloAuthStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateKiloAuthStatusOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      } as never,
      buildKiloAuthStatusReq("/tmp"),
    )
    expect(broken).toEqual({ kind: "unavailable", reason: "transport" })

    const closed = await attemptKiloAuthStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateKiloAuthStatusOutcomeWithHandle: () => ({
          id: 44,
          promise: Promise.reject(new Error("Peer closed")),
          cancel: () => true,
        }),
      } as never,
      buildKiloAuthStatusReq("/tmp"),
    )
    expect(closed).toEqual({ kind: "unavailable", reason: "transport" })
  })

  it("fetch maps fast non-terminal private outcomes to unavailable with zero SDK", async () => {
    // Timeout/exact-cancel stays covered by the dedicated attempt-level tests
    // below (10ms + requestId cancel), so this matrix stays fast and never
    // waits on the 3s production default.
    const cases: Array<{ name: string; conn: unknown }> = [
      { name: "unavailable", conn: { isPrivateAvailable: () => false } },
      {
        name: "missing-capability",
        conn: { isPrivateAvailable: () => true, getPrivatePeer: () => null, getPrivateEpoch: () => 1 },
      },
      { name: "ambiguous", conn: connFor((r) => ambiguousWire(r)) },
      {
        name: "invalid",
        conn: {
          isPrivateAvailable: () => true,
          privateKiloAuthStatusOutcomeWithHandle: () => ({
            id: 9,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }),
        },
      },
      {
        name: "transport",
        conn: {
          isPrivateAvailable: () => true,
          privateKiloAuthStatusOutcomeWithHandle: () => ({
            id: 10,
            promise: Promise.reject(new Error("Private peer unavailable")),
            cancel: () => true,
          }),
        },
      },
      {
        name: "closed",
        conn: {
          isPrivateAvailable: () => true,
          privateKiloAuthStatusOutcomeWithHandle: () => ({
            id: 11,
            promise: Promise.reject(new Error("Peer closed")),
            cancel: () => true,
          }),
        },
      },
    ]
    for (const c of cases) {
      const out = await fetchKiloAuthStatusPrivate({ connection: c.conn as never, directory: "/tmp" })
      expect(out, c.name).toEqual({ kind: "unavailable" })
    }
  })

  it("timeout exact-cancels the pending by id", async () => {
    const req = buildKiloAuthStatusReq("/tmp")
    const cancelled: string[] = []
    const attempt = await attemptKiloAuthStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateKiloAuthStatusOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: (m?: string) => {
          cancelled.push(m ?? "")
          return true
        } }),
      } as never,
      req,
      10,
    )
    expect(attempt).toEqual({ kind: "unavailable", reason: "timeout" })
    expect(cancelled.length).toBe(1)
    expect(cancelled[0]).toContain("requestId=")
  })

  it("settled success survives post-response epoch drift via owner handle", async () => {
    const { kiloAuthStatusHandle } = await import(
      "../services/cli-backend/serve-private-kilo-auth-status-connection"
    )
    const req = buildKiloAuthStatusReq("/tmp")
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
      privateKiloAuthStatusOutcomeWithHandle: () => ({ id: 3, promise: Promise.resolve(okWire(req)) }),
    }
    const handle = kiloAuthStatusHandle(
      { peer: peer as never, live: true, epoch: 1, invalidate: () => {} },
      req,
    )
    const outcome = (await handle.promise) as { kind: string; result: { status: string } }
    expect(outcome.kind).toBe("valid")
    expect(outcome.result.status).toBe("succeeded")
  })

  it("shared helper has no SDK surface", async () => {
    const mod = (await import("./kilo-auth-status-private")) as Record<string, unknown>
    expect("fetchKiloAuthStatusPrivateFirst" in mod).toBeFalse()
    expect("coerceSdkData" in mod).toBeFalse()
    expect(typeof mod.fetchKiloAuthStatusPrivate).toBe("function")
  })
})
