import { describe, expect, it } from "bun:test"
import { kiloProfileHandle } from "./serve-private-kilo-profile-connection"
import type { KiloProfileContractRequest } from "./serve-private-kilo-profile-contract"

function req(): KiloProfileContractRequest {
  return { v: 1, requestId: "r1", op: "kilo/profile", context: { directory: "/tmp" }, payload: {} }
}

function okWire(r: KiloProfileContractRequest) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: r.requestId,
      op: "kilo/profile",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null },
    },
  }
}

describe("kiloProfileHandle epoch ownership", () => {
  it("preserves settled success across post-response peer drift", async () => {
    const r = req()
    const box: { peer: unknown } = { peer: null }
    const peer = {
      isAvailable: () => true,
      hasCapability: () => true,
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: () => {},
      privateKiloProfileOutcomeWithHandle: () => ({ id: 1, promise: Promise.resolve(okWire(r)) }),
    }
    box.peer = peer
    const deps = { peer: peer as never, live: true, epoch: 1, invalidate: () => {} }
    const handle = kiloProfileHandle(deps, r)
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
      privateKiloProfileOutcomeWithHandle: () => ({ id: 2, promise: gate }),
    }
    const deps = { peer: peer as never, live: true, epoch: 1, invalidate: () => {} }
    const handle = kiloProfileHandle(deps, r)
    const waited = handle.promise
    // Drift before an unsettled (retryable upstream) response resolves.
    ;(deps as { peer: unknown }).peer = null
    resolve({
      kind: "valid" as const,
      result: {
        v: 1,
        requestId: r.requestId,
        op: "kilo/profile",
        status: "failed",
        outcome: {
          type: "failed",
          time: 1,
          failure: { code: "upstream", message: "kilo gateway upstream failed", retryable: true },
        },
        accepted: false,
        failure: { code: "upstream", message: "kilo gateway upstream failed", retryable: true },
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
    expect(() => kiloProfileHandle({ peer: peer as never, live: true, epoch: 1, invalidate: () => {} }, r)).toThrow(
      "kilo/profile capability",
    )
  })
})
