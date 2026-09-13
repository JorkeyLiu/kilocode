import { describe, expect, it } from "bun:test"
import { kiloAuthStatusHandle } from "./serve-private-kilo-auth-status-connection"
import type { KiloAuthStatusContractRequest } from "./serve-private-kilo-auth-status-contract"

function req(): KiloAuthStatusContractRequest {
  return { v: 1, requestId: "r1", op: "kilo/auth-status", context: { directory: "/tmp" }, payload: {} }
}

function okWire(r: KiloAuthStatusContractRequest) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "kilo/auth-status",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { authenticated: true, type: "oauth" },
    },
  }
}

describe("kiloAuthStatusHandle epoch ownership", () => {
  it("preserves settled success across post-response peer drift", async () => {
    const r = req()
    const box: { peer: unknown } = { peer: null }
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
      privateKiloAuthStatusOutcomeWithHandle: () => ({ id: 1, promise: Promise.resolve(okWire(r)) }),
    }
    box.peer = peer
    const deps = { peer: peer as never, live: true, epoch: 1, invalidate: () => {} }
    const handle = kiloAuthStatusHandle(deps, r)
    const out = (await handle.promise) as { kind: string; result: { status: string } }
    expect(out.kind).toBe("valid")
    expect(out.result.status).toBe("succeeded")
  })

  it("maps unresolved drift to ambiguous transportUnknown", async () => {
    const r = req()
    let resolve!: (v: unknown) => void
    const gate = new Promise((res) => (resolve = res))
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
      privateKiloAuthStatusOutcomeWithHandle: () => ({ id: 2, promise: gate }),
    }
    const deps = { peer: peer as never, live: true, epoch: 1, invalidate: () => {} }
    const handle = kiloAuthStatusHandle(deps, r)
    const waited = handle.promise
    // Drift before an unsettled (ambiguous) response resolves.
    ;(deps as { peer: unknown }).peer = null
    resolve({
      kind: "valid" as const,
      result: {
        v: 1,
        requestId: r.requestId,
        op: "kilo/auth-status",
        status: "ambiguous",
        outcome: { type: "ambiguous", time: 1 },
        accepted: false,
        transportUnknown: true,
      },
    })
    const out = (await waited) as { kind: string; result: { status: string; transportUnknown?: boolean } }
    expect(out.kind).toBe("valid")
    expect(out.result.status).toBe("ambiguous")
    expect(out.result.transportUnknown).toBe(true)
  })

  it("missing capability fails closed before any transport work", () => {
    const r = req()
    const peer = {
      isAvailable: () => true,
      hasCapability: () => false,
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
    }
    expect(() => kiloAuthStatusHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => {} }, r)).toThrow(
      "kilo/auth-status capability",
    )
  })
})
