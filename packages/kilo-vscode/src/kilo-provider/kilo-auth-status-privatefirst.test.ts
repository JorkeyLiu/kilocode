import { describe, expect, it } from "bun:test"
import {
  attemptKiloAuthStatusPrivate,
  buildKiloAuthStatusReq,
  fetchKiloAuthStatusPrivateFirst,
  parseKiloAuthStatusResult,
} from "./kilo-auth-status-privatefirst"
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

describe("kilo-auth-status private-first observation", () => {
  it("validated success returns the closed shape with zero SDK", async () => {
    let sdk = 0
    const out = await fetchKiloAuthStatusPrivateFirst({
      connection: {
        isPrivateAvailable: () => true,
        privateKiloAuthStatusOutcomeWithHandle: (r: KiloAuthStatusContractRequest) => ({
          id: 1,
          promise: Promise.resolve(okWire(r)),
        }),
      } as never,
      client: {
        kilo: {
          authStatus: async () => {
            sdk += 1
            return { data: validData() }
          },
        },
      } as never,
      directory: "/tmp",
    })
    expect(sdk).toBe(0)
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.via).toBe("private")
      expect(out.data).toEqual(validData())
    }
  })

  it("validated terminal (validation/internal) closes with zero SDK", async () => {
    for (const [code, message] of [
      ["validation.failed", "invalid kilo-auth-status request"],
      ["internal", "internal error"],
    ] as const) {
      let sdk = 0
      const out = await fetchKiloAuthStatusPrivateFirst({
        connection: {
          isPrivateAvailable: () => true,
          privateKiloAuthStatusOutcomeWithHandle: (r: KiloAuthStatusContractRequest) => ({
            id: 1,
            promise: Promise.resolve(failedWire(r, code, message, false)),
          }),
        } as never,
        client: {
          kilo: {
            authStatus: async () => {
              sdk += 1
              return { data: validData() }
            },
          },
        } as never,
        directory: "/tmp",
      })
      expect(out).toEqual({ kind: "terminal", code })
      expect(sdk).toBe(0)
    }
  })

  it("unavailable/invalid/ambiguous/transport/timeout take exactly one same-directory SDK fallback", async () => {
    const cases: Array<{ name: string; wire: (req: KiloAuthStatusContractRequest) => unknown }> = [
      { name: "invalid", wire: () => ({ kind: "invalid", detail: "x" }) },
      { name: "ambiguous", wire: (r) => ambiguousWire(r) },
    ]
    for (const c of cases) {
      const seen: unknown[] = []
      const out = await fetchKiloAuthStatusPrivateFirst({
        connection: {
          isPrivateAvailable: () => true,
          privateKiloAuthStatusOutcomeWithHandle: (r: KiloAuthStatusContractRequest) => ({
            id: 1,
            promise: Promise.resolve(c.wire(r)),
          }),
        } as never,
        client: {
          kilo: {
            authStatus: async (args?: unknown) => {
              seen.push(args)
              return { data: validData() }
            },
          },
        } as never,
        directory: "/tmp",
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") expect(out.via).toBe("sdk")
      expect(seen).toEqual([{ directory: "/tmp" }])
    }
    // Unavailable + transport + timeout variants.
    for (const conn of [
      null,
      { isPrivateAvailable: () => false },
      { isPrivateAvailable: () => { throw new Error("Private peer unavailable") } },
      {
        isPrivateAvailable: () => true,
        privateKiloAuthStatusOutcomeWithHandle: () => ({ id: 1, promise: new Promise(() => {}) }),
      },
    ]) {
      const seen: unknown[] = []
      const out = await fetchKiloAuthStatusPrivateFirst({
        connection: conn as never,
        client: {
          kilo: {
            authStatus: async (args?: unknown) => {
              seen.push(args)
              return { data: validData() }
            },
          },
        } as never,
        directory: "/tmp",
      })
      expect(out.kind).toBe("ok")
      expect(seen).toEqual([{ directory: "/tmp" }])
    }
  })

  it("invalid wire never silently succeeds and malformed SDK returns unavailable", async () => {
    const req = buildKiloAuthStatusReq("/tmp")
    expect(parseKiloAuthStatusResult({ kind: "invalid", detail: "x" }, req)).toEqual({
      kind: "fallback",
      reason: "invalid",
    })
    const bad = okWire(req, { authenticated: true, type: "oauth", token: "secret" })
    expect(parseKiloAuthStatusResult(bad.result, req).kind).toBe("fallback")
    const out = await fetchKiloAuthStatusPrivateFirst({
      connection: null,
      client: { kilo: { authStatus: async () => ({ data: { authenticated: "yes" } }) } } as never,
      directory: "/tmp",
    })
    expect(out.kind).toBe("unavailable")
  })

  it("3s timeout exact-cancels the pending by id", async () => {
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
    expect(attempt).toEqual({ kind: "fallback", reason: "timeout" })
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
})
