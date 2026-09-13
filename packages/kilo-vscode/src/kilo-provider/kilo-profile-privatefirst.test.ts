import { describe, expect, it } from "bun:test"
import {
  attemptKiloProfilePrivate,
  buildKiloProfileReq,
  fetchKiloProfilePrivateFirst,
  parseKiloProfileResult,
} from "./kilo-profile-privatefirst"
import type { KiloProfileContractRequest } from "../services/cli-backend/serve-private-kilo-profile-contract"

function validData() {
  return { profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
}

function okWire(req: KiloProfileContractRequest, data: unknown = validData()) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      op: "kilo/profile",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data,
    },
  }
}

function failedWire(req: KiloProfileContractRequest, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      op: "kilo/profile",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    },
  }
}

function ambiguousWire(req: KiloProfileContractRequest) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      op: "kilo/profile",
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

describe("kilo-profile private-first observation", () => {
  it("validated success returns SDK-equivalent data with zero SDK", async () => {
    let sdk = 0
    const out = await fetchKiloProfilePrivateFirst({
      connection: {
        isPrivateAvailable: () => true,
        privateKiloProfileOutcomeWithHandle: (r: KiloProfileContractRequest) => ({
          id: 1,
          promise: Promise.resolve(okWire(r)),
        }),
      } as never,
      client: {
        kilo: {
          profile: async () => {
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

  it("validated terminal (unauthorized/validation/internal) closes with zero SDK", async () => {
    for (const [code, message] of [
      ["unauthorized", "not authenticated with Kilo Gateway"],
      ["validation.failed", "invalid kilo-profile request"],
      ["internal", "internal error"],
    ] as const) {
      let sdk = 0
      const out = await fetchKiloProfilePrivateFirst({
        connection: {
          isPrivateAvailable: () => true,
          privateKiloProfileOutcomeWithHandle: (r: KiloProfileContractRequest) => ({
            id: 1,
            promise: Promise.resolve(failedWire(r, code, message, false)),
          }),
        } as never,
        client: {
          kilo: {
            profile: async () => {
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

  it("unavailable/invalid/ambiguous/retryable upstream/transport/timeout take exactly one same-directory SDK fallback", async () => {
    const cases: Array<{ name: string; wire: (req: KiloProfileContractRequest) => unknown; reason: string }> = [
      { name: "invalid", wire: () => ({ kind: "invalid", detail: "x" }), reason: "invalid" },
      { name: "ambiguous", wire: (r) => ambiguousWire(r), reason: "ambiguous" },
      {
        name: "upstream",
        wire: (r) => failedWire(r, "upstream", "kilo gateway upstream failed", true),
        reason: "upstream",
      },
    ]
    for (const c of cases) {
      const seen: unknown[] = []
      const out = await fetchKiloProfilePrivateFirst({
        connection: {
          isPrivateAvailable: () => true,
          privateKiloProfileOutcomeWithHandle: (r: KiloProfileContractRequest) => ({
            id: 1,
            promise: Promise.resolve(c.wire(r)),
          }),
        } as never,
        client: {
          kilo: {
            profile: async (args?: unknown) => {
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
        privateKiloProfileOutcomeWithHandle: () => ({ id: 1, promise: new Promise(() => {}) }),
      },
    ]) {
      const seen: unknown[] = []
      const req = buildKiloProfileReq("/tmp")
      void req
      const out = await fetchKiloProfilePrivateFirst({
        connection: conn as never,
        client: {
          kilo: {
            profile: async (args?: unknown) => {
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
    const req = buildKiloProfileReq("/tmp")
    expect(parseKiloProfileResult({ kind: "invalid", detail: "x" }, req)).toEqual({
      kind: "fallback",
      reason: "invalid",
    })
    const bad = okWire(req, { profile: {}, balance: null, kiloPass: null, currentOrgId: null })
    expect(parseKiloProfileResult(bad.result, req).kind).toBe("fallback")
    const out = await fetchKiloProfilePrivateFirst({
      connection: null,
      client: { kilo: { profile: async () => ({ data: { profile: {} } }) } } as never,
      directory: "/tmp",
    })
    expect(out.kind).toBe("unavailable")
  })

  it("3s timeout exact-cancels the pending by id", async () => {
    const req = buildKiloProfileReq("/tmp")
    const cancelled: string[] = []
    const attempt = await attemptKiloProfilePrivate(
      {
        isPrivateAvailable: () => true,
        privateKiloProfileOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: (m?: string) => {
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
    const { kiloProfileHandle } = await import(
      "../services/cli-backend/serve-private-kilo-profile-connection"
    )
    const req = buildKiloProfileReq("/tmp")
    let epoch = 1
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
      privateKiloProfileOutcomeWithHandle: () => ({ id: 3, promise: Promise.resolve(okWire(req)) }),
    }
    const handle = kiloProfileHandle(
      { peer: peer as never, live: true, epoch, invalidate: () => {} },
      req,
    )
    epoch += 1
    // Drift after the settled response must preserve the success (owner
    // wrapper checks drift only for unresolved outcomes via the live deps
    // object; here the captured epoch object is intentionally stable).
    const outcome = (await handle.promise) as { kind: string; result: { status: string } }
    expect(outcome.kind).toBe("valid")
    expect(outcome.result.status).toBe("succeeded")
  })
})
